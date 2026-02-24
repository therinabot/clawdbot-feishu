import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { FeishuConfig } from "./types.js";
import type { ScoringDecision } from "./scoring.js";
import { evaluateNoReplySignal, type NoReplySignalResult } from "./memory-signal.js";

const DEFAULT_WORKSPACE_ROOT = "/home/shusain/.openclaw/workspace";
const DAILY_LOG_SECTION = "## Feishu Auto Memory Capture (v0)";

type MemoryCaptureAction = "saved" | "skipped" | "error";

type MemoryCaptureEvent = {
  ts: string;
  channel: "feishu";
  accountId: string;
  chatId: string;
  messageId: string;
  decision: ScoringDecision;
  confidence: number;
  score?: number;
  action: MemoryCaptureAction;
  reason: string;
  summary?: string;
  summaryNormalized?: string;
  noReplySignal?: NoReplySignalResult;
};

type MemoryCaptureResolvedConfig = {
  enabled: boolean;
  minConfidence: number;
  dedupeWindowMinutes: number;
  hourlyLimit: number;
  noReplyException: {
    enabled: boolean;
    minRelevanceScore: number;
    minMatchedCategories: number;
    requireOwnerMention: boolean;
  };
};

export async function maybeCaptureMemoryFromScoring(params: {
  cfg: ClawdbotConfig;
  feishuCfg?: FeishuConfig;
  accountId: string;
  chatId: string;
  messageId: string;
  senderOpenId: string;
  senderName?: string;
  content: string;
  decision: ScoringDecision;
  confidence: number;
  score?: number | null;
  mentionedUserCount?: number;
  log?: (msg: string) => void;
}): Promise<void> {
  const {
    cfg,
    feishuCfg,
    accountId,
    chatId,
    messageId,
    senderOpenId,
    senderName,
    content,
    decision,
    confidence,
    score,
    mentionedUserCount,
    log,
  } = params;

  const resolvedCfg = resolveMemoryCaptureConfig(feishuCfg);
  if (!resolvedCfg.enabled) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cfg);
  const eventsPath = path.join(workspaceRoot, "memory", "state", "memory-capture-events.jsonl");
  const now = Date.now();

  let captureReason = "saved";
  let noReplySignal: NoReplySignalResult | undefined;

  const eventBase = {
    channel: "feishu" as const,
    accountId,
    chatId,
    messageId,
    decision,
    confidence,
    score: typeof score === "number" ? score : undefined,
  };

  try {
    if (decision === "NO_REPLY") {
      if (!resolvedCfg.noReplyException.enabled) {
        await appendCaptureEvent(eventsPath, {
          ...eventBase,
          action: "skipped",
          reason: "decision-no-reply",
        });
        return;
      }

      noReplySignal = evaluateNoReplySignal({
        content,
        mentionedUserCount,
        config: {
          minRelevanceScore: resolvedCfg.noReplyException.minRelevanceScore,
          minMatchedCategories: resolvedCfg.noReplyException.minMatchedCategories,
          requireOwnerMention: resolvedCfg.noReplyException.requireOwnerMention,
        },
      });

      if (!noReplySignal.shouldCapture) {
        await appendCaptureEvent(eventsPath, {
          ...eventBase,
          action: "skipped",
          reason: buildNoReplySkipReason(noReplySignal),
          noReplySignal,
        });
        return;
      }

      captureReason = "no-reply-high-signal";
    }

    if (decision !== "REPLY" && decision !== "REACT" && decision !== "NO_REPLY") {
      await appendCaptureEvent(eventsPath, {
        ...eventBase,
        action: "skipped",
        reason: "decision-unsupported",
      });
      return;
    }

    // Keep existing confidence rule for REPLY/REACT. NO_REPLY high-signal uses dedicated signal score.
    if (
      decision !== "NO_REPLY" &&
      (!Number.isFinite(confidence) || confidence < resolvedCfg.minConfidence)
    ) {
      await appendCaptureEvent(eventsPath, {
        ...eventBase,
        action: "skipped",
        reason: "confidence-below-threshold",
      });
      return;
    }

    const summary = buildOneLineSummary(content);
    const summaryNormalized = normalizeSummary(summary);

    if (!summary || !summaryNormalized) {
      await appendCaptureEvent(eventsPath, {
        ...eventBase,
        action: "skipped",
        reason: "summary-empty",
        noReplySignal,
      });
      return;
    }

    const maxWindowMs = Math.max(60, resolvedCfg.dedupeWindowMinutes) * 60 * 1000;
    const recentEvents = await readRecentEvents(eventsPath, now - maxWindowMs);

    const savedInLastHour = recentEvents.filter(
      (entry) =>
        entry.action === "saved" &&
        Number.isFinite(entry.tsMs) &&
        entry.tsMs >= now - 60 * 60 * 1000,
    ).length;

    if (savedInLastHour >= resolvedCfg.hourlyLimit) {
      await appendCaptureEvent(eventsPath, {
        ...eventBase,
        action: "skipped",
        reason: "rate-limit-hourly",
        summary,
        summaryNormalized,
        noReplySignal,
      });
      return;
    }

    const duplicate = recentEvents.find(
      (entry) =>
        entry.action === "saved" &&
        entry.chatId === chatId &&
        entry.accountId === accountId &&
        Number.isFinite(entry.tsMs) &&
        entry.tsMs >= now - resolvedCfg.dedupeWindowMinutes * 60 * 1000 &&
        isSimilarSummary(summaryNormalized, entry.summaryNormalized ?? ""),
    );

    if (duplicate) {
      await appendCaptureEvent(eventsPath, {
        ...eventBase,
        action: "skipped",
        reason: "dedupe-recent",
        summary,
        summaryNormalized,
        noReplySignal,
      });
      return;
    }

    const dailyPath = path.join(
      workspaceRoot,
      "memory",
      "daily-logs",
      `${new Date(now).toISOString().slice(0, 10)}.md`,
    );

    await appendDailyLogEntry({
      filePath: dailyPath,
      chatId,
      decision,
      senderOpenId,
      senderName,
      summary,
      timestampIso: new Date(now).toISOString(),
    });

    await appendCaptureEvent(eventsPath, {
      ...eventBase,
      action: "saved",
      reason: captureReason,
      summary,
      summaryNormalized,
      noReplySignal,
    });
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    log?.(`feishu[${accountId}]: memory capture failed: ${message}`);

    await appendCaptureEvent(eventsPath, {
      ...eventBase,
      action: "error",
      reason: `exception:${truncateInline(message, 160)}`,
      noReplySignal,
    }).catch(() => {
      // Do nothing. Memory capture must stay non-blocking.
    });
  }
}

function resolveMemoryCaptureConfig(feishuCfg?: FeishuConfig): MemoryCaptureResolvedConfig {
  const raw = feishuCfg?.memoryCapture;
  return {
    enabled: raw?.enabled ?? false,
    minConfidence: raw?.minConfidence ?? 0.8,
    dedupeWindowMinutes: raw?.dedupeWindowMinutes ?? 60,
    hourlyLimit: raw?.hourlyLimit ?? 10,
    noReplyException: {
      enabled: raw?.noReplyException?.enabled ?? true,
      minRelevanceScore: raw?.noReplyException?.minRelevanceScore ?? 22,
      minMatchedCategories: raw?.noReplyException?.minMatchedCategories ?? 2,
      requireOwnerMention: raw?.noReplyException?.requireOwnerMention ?? true,
    },
  };
}

function buildNoReplySkipReason(signal: NoReplySignalResult): string {
  const categories = signal.matchedCategories.join(",") || "none";
  const failed = signal.failedChecks.join(",") || "unknown";
  return `decision-no-reply-low-signal(score=${signal.relevanceScore}/${signal.threshold};categories=${categories};failed=${failed})`;
}

function resolveWorkspaceRoot(cfg: ClawdbotConfig): string {
  const candidates = [
    cfg.agents?.defaults?.workspace,
    cfg.agents?.list?.find((agent) => agent.default)?.workspace,
    cfg.agents?.list?.find((agent) => agent.id === "main")?.workspace,
  ];

  for (const candidate of candidates) {
    const resolved = resolveUserPath(candidate);
    if (resolved) return resolved;
  }

  return DEFAULT_WORKSPACE_ROOT;
}

function resolveUserPath(rawPath?: string): string | null {
  if (!rawPath || typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
}

function buildOneLineSummary(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  const withoutMentions = compact.replace(/<at\b[^>]*>.*?<\/at>/gi, "").trim();
  const maskedLinks = withoutMentions.replace(/https?:\/\/\S+/gi, "[link]");
  const base = maskedLinks || compact;

  const firstSentence = base.split(/[.!?。！？]+\s+/u)[0]?.trim() ?? base;
  const chosen = firstSentence.length >= 24 ? firstSentence : base;

  return truncateInline(chosen, 180);
}

function normalizeSummary(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSimilarSummary(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;

  if (left.length >= 24 && right.length >= 24 && (left.includes(right) || right.includes(left))) {
    return true;
  }

  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = right.split(" ").filter(Boolean);
  if (leftTokens.length < 4 || rightTokens.length < 4) return false;

  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const minTokenLength = Math.min(leftTokens.length, rightTokens.length);

  return overlap / minTokenLength >= 0.8;
}

async function appendDailyLogEntry(params: {
  filePath: string;
  chatId: string;
  decision: ScoringDecision;
  senderOpenId: string;
  senderName?: string;
  summary: string;
  timestampIso: string;
}): Promise<void> {
  const { filePath, chatId, decision, senderOpenId, senderName, summary, timestampIso } = params;

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  let existing = "";
  try {
    existing = await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const hasSection = existing.includes(DAILY_LOG_SECTION);
  let chunk = "";

  if (existing && !existing.endsWith("\n")) {
    chunk += "\n";
  }

  if (!hasSection) {
    chunk += `${DAILY_LOG_SECTION}\n`;
  }

  const senderLabel = senderName ? `${senderName} (${senderOpenId})` : senderOpenId;
  chunk += `- ${timestampIso} | chat=\`${chatId}\` | decision=${decision} | ${senderLabel}: ${summary}\n`;

  await fs.promises.appendFile(filePath, chunk, "utf8");
}

async function appendCaptureEvent(
  eventsPath: string,
  payload: Omit<MemoryCaptureEvent, "ts">,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });

  const event: MemoryCaptureEvent = {
    ts: new Date().toISOString(),
    ...payload,
  };

  await fs.promises.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function readRecentEvents(
  eventsPath: string,
  sinceMs: number,
): Promise<Array<MemoryCaptureEvent & { tsMs: number }>> {
  let raw = "";

  try {
    raw = await fs.promises.readFile(eventsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  if (!raw.trim()) return [];

  const lines = raw.split("\n");
  const out: Array<MemoryCaptureEvent & { tsMs: number }> = [];

  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx]?.trim();
    if (!line) continue;

    let parsed: MemoryCaptureEvent | null = null;
    try {
      parsed = JSON.parse(line) as MemoryCaptureEvent;
    } catch {
      continue;
    }

    const tsMs = Date.parse(parsed.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < sinceMs) break;

    out.push({
      ...parsed,
      tsMs,
    });
  }

  return out;
}

function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}
