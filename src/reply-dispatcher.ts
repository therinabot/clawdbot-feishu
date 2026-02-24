import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { buildMentionedCardContent, type MentionTarget } from "./mention.js";
import { normalizeFeishuMarkdownLinks } from "./text/markdown-links.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function stripReasoningPrefix(raw: string): string {
  const text = raw.trim();
  if (!/^Reasoning:/i.test(text)) return text;

  // Common shape: "Reasoning: ...\n\n<actual reply>"
  const blocks = text.split(/\n\n+/);
  if (blocks.length > 1 && /^Reasoning:/i.test(blocks[0]?.trim() ?? "")) {
    const candidate = blocks.slice(1).join("\n\n").trim();
    if (candidate) return candidate;
  }

  // Single-line heading then reply body on next line(s)
  const lines = text.split("\n");
  if (lines.length > 1 && /^Reasoning:/i.test(lines[0]?.trim() ?? "")) {
    const candidate = lines.slice(1).join("\n").trim();
    if (candidate) return candidate;
  }

  // Inline leak shape: "Reasoning: ... Noted, ..."
  const inlineStart = text.search(
    /(\[\[\s*reply_to[^\]]*\]\]|(?:Noted|Oke|Okay|Siap|Baik|Sip|Sure|Got it|Endpoint|Intinya|Berarti)\b[,:\-]?)/i,
  );
  if (inlineStart > 0) {
    return text.slice(inlineStart).trim();
  }

  return text;
}

function isTransientReasoningLeak(text: string): boolean {
  const t = text.trim();
  if (!/^Reasoning:/i.test(t)) return false;

  // If we can already recover non-reasoning content, keep it.
  const stripped = stripReasoningPrefix(t);
  if (stripped && stripped !== t && !/^Reasoning:/i.test(stripped)) {
    return false;
  }

  return /^Reasoning:\s*(?:_?\*{0,3})?\s*(?:Choosing|Deciding|Crafting|Planning|Thinking|Analyzing|Checking|Preparing|Outputting|Composing|Formulating)\b/i.test(
    t,
  );
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  forceReply?: boolean;
  forceReplyFallbackText?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", account.accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu", account.accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
  });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = account.config?.streaming === true && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId));
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(normalizeFeishuMarkdownLinks(text));
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const rawText = payload.text ?? "";
        if (isTransientReasoningLeak(rawText)) {
          return;
        }

        let text = stripReasoningPrefix(rawText);

        // negative no-reply check removed (requested)

        if (!text.trim()) {
          if (params.forceReply) {
            text = (params.forceReplyFallbackText ?? "Noted. Request lu kebaca, gua follow up sekarang.").trim();
          } else {
            return;
          }
        }

        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        if ((info?.kind === "block" || info?.kind === "final") && streamingEnabled && useCard) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        if (streaming?.isActive()) {
          if (info?.kind === "final") {
            streamText = text;
            await closeStreaming();
          }
          return;
        }

        let first = true;
        if (useCard) {
          for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
          }
        } else {
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          for (const chunk of core.channel.text.chunkTextWithMode(
            converted,
            textChunkLimit,
            chunkMode,
          )) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            const partialText = normalizeFeishuMarkdownLinks(payload.text ?? "");
            if (!partialText || partialText === lastPartial) {
              return;
            }
            lastPartial = partialText;
            streamText = partialText;
            partialUpdateQueue = partialUpdateQueue.then(async () => {
              if (streamingStartPromise) {
                await streamingStartPromise;
              }
              if (streaming?.isActive()) {
                await streaming.update(streamText);
              }
            });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
