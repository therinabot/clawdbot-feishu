import {
  RISK_MEMORY_CATEGORY_WEIGHTS,
  RISK_MEMORY_KEYWORDS,
  type RiskMemoryKeywordCategory,
} from "./memory-keywords.js";

export type NoReplySignalConfig = {
  minRelevanceScore: number;
  minMatchedCategories: number;
  requireOwnerMention: boolean;
};

export type CategoryMatchMap = Record<RiskMemoryKeywordCategory, string[]>;

export type NoReplySignalResult = {
  shouldCapture: boolean;
  relevanceScore: number;
  threshold: number;
  matchedCategories: RiskMemoryKeywordCategory[];
  matchedTerms: CategoryMatchMap;
  categoryScores: Record<RiskMemoryKeywordCategory, number>;
  signalScore: number;
  signals: {
    ownerMention: boolean;
    domain: boolean;
    action: boolean;
    time: boolean;
    numericUpdate: boolean;
    operationalUpdate: boolean;
  };
  failedChecks: string[];
};

const SIGNAL_WEIGHTS = {
  ownerMention: 3,
  domain: 3,
  action: 2,
  time: 2,
  numericUpdate: 1,
} as const;

const CATEGORY_SCORE_MATCH_CAP = 3;
const MIN_TOKEN_COUNT = 6;

/**
 * Evaluate NO_REPLY text and decide whether it's still a high-signal operational update.
 * Deterministic + explainable scoring only (no LLM calls).
 */
export function evaluateNoReplySignal(params: {
  content: string;
  mentionedUserCount?: number;
  config: NoReplySignalConfig;
}): NoReplySignalResult {
  const { content, mentionedUserCount = 0, config } = params;
  const normalized = normalizeForMatch(content);
  const matchedTerms = matchRiskKeywordsByCategory(normalized);

  const categoryScores = {} as Record<RiskMemoryKeywordCategory, number>;
  let categoryTotal = 0;

  (Object.keys(matchedTerms) as RiskMemoryKeywordCategory[]).forEach((category) => {
    const hits = matchedTerms[category].length;
    const weight = RISK_MEMORY_CATEGORY_WEIGHTS[category] ?? 0;
    const contribution = Math.min(hits, CATEGORY_SCORE_MATCH_CAP) * weight;
    categoryScores[category] = contribution;
    categoryTotal += contribution;
  });

  const hasDomainSignal =
    matchedTerms.featureProjects.length > 0 ||
    matchedTerms.tradingRiskDomain.length > 0 ||
    matchedTerms.incidents.length > 0;

  const hasActionSignal = matchedTerms.actionVerbs.length > 0;
  const hasTimeSignal = matchedTerms.timeMarkers.length > 0 || hasAbsoluteTimeMarker(content);
  const hasOwnerMention = mentionedUserCount > 0 || hasOwnerReference(content);
  const hasNumericUpdate = hasOperationalNumber(content);

  // Conservative operational gate: owner + domain + (action OR time).
  const operationalUpdate = hasOwnerMention && hasDomainSignal && (hasActionSignal || hasTimeSignal);

  let signalScore = 0;
  if (hasOwnerMention) signalScore += SIGNAL_WEIGHTS.ownerMention;
  if (hasDomainSignal) signalScore += SIGNAL_WEIGHTS.domain;
  if (hasActionSignal) signalScore += SIGNAL_WEIGHTS.action;
  if (hasTimeSignal) signalScore += SIGNAL_WEIGHTS.time;
  if (hasNumericUpdate) signalScore += SIGNAL_WEIGHTS.numericUpdate;

  const relevanceScore = categoryTotal + signalScore;
  const matchedCategories = (Object.keys(matchedTerms) as RiskMemoryKeywordCategory[]).filter(
    (category) => matchedTerms[category].length > 0,
  );

  const tokenCount = normalized ? normalized.split(" ").filter(Boolean).length : 0;

  const failedChecks: string[] = [];
  if (config.requireOwnerMention && !hasOwnerMention) {
    failedChecks.push("missing-owner-mention");
  }
  if (!hasDomainSignal) {
    failedChecks.push("missing-domain-signal");
  }
  if (!hasActionSignal && !hasTimeSignal) {
    failedChecks.push("missing-action-or-time-signal");
  }
  if (tokenCount < MIN_TOKEN_COUNT) {
    failedChecks.push("message-too-short");
  }
  if (matchedCategories.length < config.minMatchedCategories) {
    failedChecks.push("matched-categories-below-minimum");
  }
  if (relevanceScore < config.minRelevanceScore) {
    failedChecks.push("relevance-below-threshold");
  }

  const shouldCapture =
    failedChecks.length === 0 &&
    operationalUpdate &&
    (!config.requireOwnerMention || hasOwnerMention) &&
    matchedCategories.length >= config.minMatchedCategories &&
    relevanceScore >= config.minRelevanceScore;

  return {
    shouldCapture,
    relevanceScore,
    threshold: config.minRelevanceScore,
    matchedCategories,
    matchedTerms,
    categoryScores,
    signalScore,
    signals: {
      ownerMention: hasOwnerMention,
      domain: hasDomainSignal,
      action: hasActionSignal,
      time: hasTimeSignal,
      numericUpdate: hasNumericUpdate,
      operationalUpdate,
    },
    failedChecks,
  };
}

function matchRiskKeywordsByCategory(normalizedText: string): CategoryMatchMap {
  const out = {
    deliveryLifecycle: [],
    engineeringWorkflow: [],
    incidents: [],
    infraPlatform: [],
    tradingRiskDomain: [],
    integrations: [],
    featureProjects: [],
    timeMarkers: [],
    actionVerbs: [],
  } as CategoryMatchMap;

  (Object.entries(RISK_MEMORY_KEYWORDS) as Array<[RiskMemoryKeywordCategory, readonly string[]]>).forEach(
    ([category, terms]) => {
      const canonicalByNormalized = new Map<string, string>();
      for (const rawTerm of terms) {
        const normalizedTerm = normalizeForMatch(rawTerm);
        if (!normalizedTerm) continue;
        if (!canonicalByNormalized.has(normalizedTerm)) {
          canonicalByNormalized.set(normalizedTerm, rawTerm);
        }
      }

      for (const [normalizedTerm, canonicalTerm] of canonicalByNormalized.entries()) {
        if (containsTerm(normalizedText, normalizedTerm)) {
          out[category].push(canonicalTerm);
        }
      }
    },
  );

  return out;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[/-]/g, " ")
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(normalizedText: string, normalizedTerm: string): boolean {
  if (!normalizedText || !normalizedTerm) return false;
  const escaped = escapeRegExp(normalizedTerm).replace(/\s+/g, "\\s+");
  const rx = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "u");
  return rx.test(normalizedText);
}

function hasAbsoluteTimeMarker(text: string): boolean {
  return [
    /\b\d{1,2}[:.]\d{2}\b/u, // 09:30 / 9.30
    /\b\d{4}-\d{2}-\d{2}\b/u, // 2026-02-24
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/u, // 24/02 or 24/02/2026
  ].some((rx) => rx.test(text));
}

function hasOwnerReference(text: string): boolean {
  const patterns = [
    /<at\b[^>]*>.*?<\/at>/iu,
    /(?:^|\s)@[a-z0-9_.-]{2,}/iu,
    /\b(?:bang|kang|mas)\s+[\p{L}\p{N}_.-]{2,}/iu,
  ];
  return patterns.some((rx) => rx.test(text));
}

function hasOperationalNumber(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b\d+(?:[.,]\d+)?\s?(%|bps|ms|s|m|h|d|lot|lots|pips?|point|points)\b/u.test(normalized);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
