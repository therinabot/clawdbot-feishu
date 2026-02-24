/**
 * Scoring System for Feishu Group Chats
 *
 * Purpose: Decide whether to REPLY, REACT, or NO_REPLY to a group message
 * based on content analysis, context, and timing.
 *
 * Logic adapted from AGENTS.md - "Smart Response Logic (Group Chat)"
 */

import type { AdaptationContext, FeishuMessageContext } from './types.js';
import { FeishuEmoji, type FeishuEmojiType } from './reactions.js';

export type ScoringDecision = 'REPLY' | 'REACT' | 'NO_REPLY';

export interface ScoringResult {
  decision: ScoringDecision;
  score: number;
  confidence: number;
  reaction?: string;
  reasons: string[];
}

interface ScoringParams {
  ctx: FeishuMessageContext;
  recentMessages?: Array<{ sender: string; timestamp: number }>;
  timezone?: string; // e.g., "Asia/Jakarta"
  adaptationContext?: AdaptationContext;
}

/**
 * Default scoring thresholds (can be overridden by config)
 */
export const DEFAULT_SCORING_CONFIG = {
  replyThreshold: 5,      // Score >= 5 → REPLY
  reactThreshold: 3,      // Score 3-4 → REACT
  lateNightStart: 23,      // 23:00 (disabled per request)
  lateNightEnd: 8,        // 08:00 (disabled per request)
  lateNightDisabled: true,  // Disable late night threshold
  recentMessageWindowMs: 10000, // 10 seconds - "flow natural" check
  cooldownMs: 120000,     // 2 minutes - prevent spam
};

/**
 * Evaluate message score and return decision
 */
export function evaluateMessageScore(params: ScoringParams): ScoringResult {
  const { ctx, recentMessages = [], timezone = 'Asia/Jakarta', adaptationContext } = params;
  const config = DEFAULT_SCORING_CONFIG;

  let score = 0;
  const reasons: string[] = [];

  // --- POSITIVE SCORE (ADD points) ---

  // +3: Direct question or question mark at end
  if (hasQuestionMark(ctx.content)) {
    score += 3;
    reasons.push('Question detected (+3)');
  }

  // +5: Direct mention to bot
  if (ctx.mentionedBot) {
    score += 5;
    reasons.push('Bot mentioned (+5)');
  }

  // +2: Tech/work-related keywords
  const techKeywords = detectTechKeywords(ctx.content);
  if (techKeywords.length > 0) {
    score += 2;
    reasons.push(`Tech keywords: ${techKeywords.join(', ')} (+2)`);
  }

  // +2: Request for help/information
  if (hasHelpRequest(ctx.content)) {
    score += 2;
    reasons.push('Help request detected (+2)');
  }

  // +1: Long message (>50 chars) and relevant to work
  if (ctx.content.length > 50 && !isBanter(ctx.content)) {
    score += 1;
    reasons.push('Substantial message (+1)');
  }

  // +1: Humor/sarcasm that can be engaged with
  if (hasHumor(ctx.content)) {
    score += 1;
    reasons.push('Humor detected (+1)');
  }

  // +2: Critical work issue (urgent blocker, production down, etc.)
  if (isCriticalIssue(ctx.content)) {
    score += 2;
    reasons.push('Critical work issue (+2)');
  }

  // --- NEGATIVE SCORE DISABLED (requested) ---
  // Intentionally disabled subtract-point checks.

  // --- PERSONALITY ADJUSTMENT (bounded, safety-neutral) ---
  // Bounded to max +/-1 so personality cannot dominate core scoring logic.
  const personalityDelta = computePersonalityDelta(adaptationContext, ctx.content);
  if (personalityDelta !== 0) {
    score += personalityDelta;
    reasons.push(`Personality adjustment (${personalityDelta > 0 ? "+" : ""}${personalityDelta})`);
  }

  // --- DECISION LOGIC ---

  const decision: ScoringDecision = deriveDecision(score, config);
  const reaction = decision === 'REACT' ? selectReaction(ctx.content) : undefined;

  // Confidence based on score distance from threshold
  let confidence = 0.7; // Default 70%
  if (score >= config.replyThreshold + 2) confidence = 0.9;
  else if (score <= config.reactThreshold - 2) confidence = 0.9;

  return {
    decision,
    score,
    confidence,
    reaction,
    reasons,
  };
}

// --- HELPER FUNCTIONS ---

function deriveDecision(score: number, config: typeof DEFAULT_SCORING_CONFIG): ScoringDecision {
  if (score >= config.replyThreshold) {
    return 'REPLY';
  } else if (score >= config.reactThreshold) {
    return 'REACT';
  } else {
    return 'NO_REPLY';
  }
}

function hasQuestionMark(text: string): boolean {
  return text.trim().endsWith('?');
}

function detectTechKeywords(text: string): string[] {
  const keywords = [
    'bug', 'deploy', 'pr', 'jira', 'gitlab', 'db', 'database',
    'api', 'error', 'issue', 'commit', 'merge', 'branch',
    'feature', 'hotfix', 'release', 'ci', 'cd', 'pipeline',
    'sql', 'query', 'redis', 'cache', 'service', 'server'
  ];
  const lower = text.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

function hasHelpRequest(text: string): boolean {
  const patterns = [
    /\b(gimana|bisa|cara|help|tolong|dibantu)\b/i,
    /\b(ada yang|ada yg|ada apa)\b/i
  ];
  return patterns.some(p => p.test(text));
}

function isBanter(text: string): boolean {
  const banterWords = ['halo', 'ok', 'sip', 'mantap', 'oke', 'siap', 'makasih', 'thanks', 'nice'];
  const lower = text.toLowerCase().trim();
  return banterWords.some(w => lower === w || lower.startsWith(`${w} `) || lower.endsWith(` ${w}`));
}

function hasHumor(text: string): boolean {
  const humorIndicators = ['wkwk', 'lmao', 'lol', '🤣', '😂', '😹', 'kocak', 'wkwkwk'];
  const lower = text.toLowerCase();
  return humorIndicators.some(h => lower.includes(h));
}

function isCriticalIssue(text: string): boolean {
  const criticalPatterns = [
    /\b(production down|prod down|service down|api down)\b/i,
    /\b(urgent|critical|blocker|stuck)\b/i,
    /\b(cant deploy|gak deploy|gak bisa)\b/i
  ];
  return criticalPatterns.some(p => p.test(text));
}

function isReactionOnly(text: string, contentType: string): boolean {
  // Sticker is reaction-only
  if (contentType === 'sticker') return true;

  // Very short, mostly emoji
  const emojiOnly = /^[\p{Emoji}]+$/u;
  if (emojiOnly.test(text.trim())) return true;

  return false;
}

function isFlowRapid(recentMessages: Array<{ sender: string; timestamp: number }>): boolean {
  if (recentMessages.length < 3) return false;

  const now = Date.now();
  const recent = recentMessages.filter(m => now - m.timestamp < DEFAULT_SCORING_CONFIG.recentMessageWindowMs);

  // If 3+ messages from different users in 10s
  const uniqueSenders = new Set(recent.map(m => m.sender));
  return uniqueSenders.size >= 3 && recent.length >= 3;
}

function isPersonalTopic(text: string): boolean {
  const personalPatterns = [
    /\b(makan dimana|mau makan|buka puasa|bukber)\b/i,
    /\b(pulang dulu|jalan jalan|jalan-jalan|ngopi|kopi)\b/i,
    /\b(weekend|libur|cuti)\b/i
  ];
  return personalPatterns.some(p => p.test(text));
}

function isLateNight(timezone: string): boolean {
  try {
    const now = new Date();
    const options = { timeZone: timezone, hour: 'numeric', hour12: false } as const;
    const hour = parseInt(now.toLocaleString('en-US', options) as string);

    return hour >= DEFAULT_SCORING_CONFIG.lateNightStart || hour < DEFAULT_SCORING_CONFIG.lateNightEnd;
  } catch {
    return false;
  }
}

function computePersonalityDelta(adaptationContext: AdaptationContext | undefined, text: string): number {
  if (!adaptationContext) return 0;

  const style = adaptationContext.style;
  let delta = 0;

  if (style.reactionPreference === "high" && isBanter(text)) {
    delta += 1;
  }

  if (adaptationContext.stressLevel >= 2 && hasHelpRequest(text)) {
    delta += 1;
  }

  if (style.reactionPreference === "low" && !hasQuestionMark(text)) {
    delta -= 1;
  }

  if (style.directness === "soft" && isCriticalIssue(text)) {
    delta += 1;
  }

  return Math.max(-1, Math.min(1, delta));
}

function selectReaction(text: string): FeishuEmojiType {
  // Choose context-aware Feishu emoji for REACT decisions.
  // Keep work/tech contexts professional (avoid random SMILE).

  const techHits = detectTechKeywords(text);
  const hasTechContext = techHits.length > 0 || hasHelpRequest(text);

  if (isCriticalIssue(text)) {
    // Critical issue → FIRE 🔥
    return FeishuEmoji.FIRE;
  }

  if (hasQuestionMark(text) && hasTechContext) {
    // Technical question → THINKING 🤔
    return FeishuEmoji.THINKING;
  }

  if (hasTechContext) {
    // Work/technical update → CHECK ✅
    return FeishuEmoji.CHECK;
  }

  if (hasHumor(text)) {
    // Humor → LAUGHING 😂
    return FeishuEmoji.LAUGHING;
  }

  if (isBanter(text)) {
    // Banter → THUMBSUP 👍
    return FeishuEmoji.THUMBSUP;
  }

  if (hasQuestionMark(text)) {
    // General question → THINKING 🤔
    return FeishuEmoji.THINKING;
  }

  // Safe fallback (deterministic, no random mismatch)
  return FeishuEmoji.THUMBSUP;
}
