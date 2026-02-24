import type { FeishuConfigSchema, FeishuGroupSchema, FeishuAccountConfigSchema, z } from "./config-schema.js";
import type { MentionTarget } from "./mention.js";

export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;
export type FeishuGroupConfig = z.infer<typeof FeishuGroupSchema>;
export type FeishuAccountConfig = z.infer<typeof FeishuAccountConfigSchema>;

export type FeishuDomain = "feishu" | "lark" | (string & {});
export type FeishuConnectionMode = "websocket" | "webhook";

export type ResolvedFeishuAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
  /** Merged config (top-level defaults + account-specific overrides) */
  config: FeishuConfig;
};

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export type FeishuMessageContext = {
  chatId: string;
  messageId: string;
  senderId: string;
  senderOpenId: string;
  senderName?: string;
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  rootId?: string;
  parentId?: string;
  content: string;
  contentType: string;
  /** Mention forward targets (excluding the bot itself) */
  mentionTargets?: MentionTarget[];
  /** Extracted message body (after removing @ placeholders) */
  mentionMessageBody?: string;
};

export type FeishuSendResult = {
  messageId: string;
  chatId: string;
};

export type FeishuProbeResult = {
  ok: boolean;
  error?: string;
  appId?: string;
  botName?: string;
  botOpenId?: string;
};

export type FeishuMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export type FeishuToolsConfig = {
  doc?: boolean;
  wiki?: boolean;
  drive?: boolean;
  perm?: boolean;
  scopes?: boolean;
  task?: boolean;
};

export type DynamicAgentCreationConfig = {
  enabled?: boolean;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  maxAgents?: number;
};

export type CommunicationStyle = "direct" | "explicit" | "nuanced" | "diplomatic";
export type HumorTolerance = "low" | "medium" | "high";
export type StressThreshold = "sensitive" | "normal" | "resilient";
export type FeedbackStyle = "direct" | "diplomatic";
export type WorkRhythm = "flexible" | "structured";

export type PersonalityProfile = {
  userId: string;
  userName?: string;
  lastUpdated: string;
  traits: {
    communicationStyle: CommunicationStyle;
    humorTolerance: HumorTolerance;
    stressThreshold: StressThreshold;
    feedbackStyle: FeedbackStyle;
    workRhythm: WorkRhythm;
  };
  preferences: {
    tone: "casual" | "neutral" | "supportive";
    responseLength: "short" | "medium" | "long";
    directness: "high" | "balanced" | "soft";
    reactionPreference: "low" | "normal" | "high";
  };
  interactions: {
    totalMessages: number;
    messagesWithHumor: number;
    stressIndicators: number;
    lastInteraction: string | null;
  };
};

export type PersonalitySignal = {
  userId: string;
  userName?: string;
  hasHumor: boolean;
  stressLevel: number;
  explicitness: number;
  nuance: number;
  diplomacy: number;
};

export type AdaptationContext = {
  userId: string;
  style: {
    tone: PersonalityProfile["preferences"]["tone"];
    responseLength: PersonalityProfile["preferences"]["responseLength"];
    directness: PersonalityProfile["preferences"]["directness"];
    reactionPreference: PersonalityProfile["preferences"]["reactionPreference"];
  };
  stressLevel: number;
  namingHints: string[];
  systemHint: string;
};

export type PersonalityFeedbackOutcome = "REPLY" | "REACT" | "NO_REPLY";

export type PersonalityFeedbackUpdate = {
  userId: string;
  messageId: string;
  outcome: PersonalityFeedbackOutcome;
  scoreDelta: number;
  note?: string;
};

export type PersonalityEvent = {
  timestamp: string;
  userId: string;
  messageId: string;
  outcome: PersonalityFeedbackOutcome;
  scoreDelta: number;
  note?: string;
};
