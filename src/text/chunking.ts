import type { PluginRuntime } from "openclaw/plugin-sdk";

type ChunkMode = "length" | "newline";
type TextRuntime = Pick<
  PluginRuntime["channel"]["text"],
  "chunkMarkdownText" | "chunkMarkdownTextWithMode"
>;

const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;

function packNewlineChunks(chunks: string[], limit: number): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const packed: string[] = [];
  let current = "";

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) {
      continue;
    }

    if (!current) {
      current = trimmed;
      continue;
    }

    const candidate = `${current}\n\n${trimmed}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    packed.push(current);
    current = trimmed;
  }

  if (current) {
    packed.push(current);
  }

  return packed;
}

function forEachNonFenceSegment(text: string, cb: (segment: string, offset: number) => void): void {
  let last = 0;
  for (const match of text.matchAll(FENCED_CODE_BLOCK_RE)) {
    const idx = match.index ?? 0;
    cb(text.slice(last, idx), last);
    last = idx + match[0].length;
  }
  cb(text.slice(last), last);
}

function scanInlineBackticks(text: string): { count: number; lastIndex: number } {
  let count = 0;
  let lastIndex = -1;

  forEachNonFenceSegment(text, (segment, offset) => {
    for (let i = 0; i < segment.length; i++) {
      if (segment[i] !== "`") {
        continue;
      }

      const absolute = offset + i;
      const escaped = absolute > 0 && text[absolute - 1] === "\\";
      if (escaped) {
        continue;
      }

      let runLength = 1;
      while (i + runLength < segment.length && segment[i + runLength] === "`") {
        runLength += 1;
      }

      if (runLength === 1) {
        count += 1;
        lastIndex = absolute;
      }

      i += runLength - 1;
    }
  });

  return { count, lastIndex };
}

function rebalanceInlineCodeChunks(
  chunks: string[],
  limit: number,
  textRuntime: TextRuntime,
): string[] {
  const rebalanced = [...chunks];
  let index = 0;
  let safety = 0;
  const maxIterations = Math.max(64, rebalanced.length * 12);

  while (index < rebalanced.length - 1 && safety < maxIterations) {
    safety += 1;
    const chunk = rebalanced[index] ?? "";
    const { count, lastIndex } = scanInlineBackticks(chunk);

    if (count % 2 === 0 || lastIndex < 0) {
      index += 1;
      continue;
    }

    const carry = chunk.slice(lastIndex);
    const head = chunk.slice(0, lastIndex).trimEnd();

    if (!carry) {
      index += 1;
      continue;
    }

    rebalanced[index] = head;
    rebalanced[index + 1] = `${carry}${rebalanced[index + 1] ?? ""}`;

    if (!rebalanced[index]?.trim()) {
      rebalanced.splice(index, 1);
      if (index > 0) {
        index -= 1;
      }
      continue;
    }

    if ((rebalanced[index + 1]?.length ?? 0) > limit) {
      const expanded = textRuntime
        .chunkMarkdownText(rebalanced[index + 1], limit)
        .filter((entry) => entry?.trim().length > 0);
      if (expanded.length > 1) {
        rebalanced.splice(index + 1, 1, ...expanded);
      }
    }
  }

  return rebalanced.filter((entry) => entry?.trim().length > 0);
}

export function chunkFeishuReplyText(params: {
  text: string;
  limit: number;
  chunkMode: ChunkMode;
  textRuntime: TextRuntime;
}): string[] {
  const { text, limit, chunkMode, textRuntime } = params;
  if (!text?.trim()) {
    return [];
  }

  const safeLimit = Math.max(1, Math.floor(limit));
  const base = textRuntime
    .chunkMarkdownTextWithMode(text, safeLimit, chunkMode)
    .filter((chunk) => chunk?.trim().length > 0);

  const packed = chunkMode === "newline" ? packNewlineChunks(base, safeLimit) : base;
  return rebalanceInlineCodeChunks(packed, safeLimit, textRuntime);
}
