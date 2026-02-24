import type { PersonalitySignal } from "./types.js";

const HUMOR_TOKENS = ["wkwk", "wkwkwk", "lol", "lmao", "😂", "🤣", "kocak"];
const DIPLOMATIC_TOKENS = ["mungkin", "kayaknya", "boleh", "please", "tolong", "saran"];
const NUANCE_TOKENS = ["menurut", "kayaknya", "sepertinya", "gua pikir", "aku pikir", "hmm"];
const STRESS_TOKENS = ["wtf", "deadline", "urgent", "stuck", "panic", "gak bisa", "error", "blocker"];

export function inferPersonalitySignal(params: {
  userId: string;
  userName?: string;
  content: string;
}): PersonalitySignal {
  const { userId, userName, content } = params;
  const text = content.toLowerCase();

  const humorHits = countHits(text, HUMOR_TOKENS);
  const diplomacyHits = countHits(text, DIPLOMATIC_TOKENS);
  const nuanceHits = countHits(text, NUANCE_TOKENS);
  const stressHits = countHits(text, STRESS_TOKENS);

  const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
  const punctuationDensity = ((text.match(/[!?.,:;]/g) ?? []).length / words);
  const explicitness = clamp01((text.length <= 80 ? 0.4 : 0.15) + (text.includes("?") ? 0.2 : 0) + (punctuationDensity < 0.08 ? 0.2 : 0));
  const nuance = clamp01((nuanceHits * 0.35) + (text.includes("...") ? 0.2 : 0));
  const diplomacy = clamp01((diplomacyHits * 0.4) + (text.includes("🙏") ? 0.2 : 0));

  return {
    userId,
    userName,
    hasHumor: humorHits > 0,
    stressLevel: Math.min(3, stressHits),
    explicitness,
    nuance,
    diplomacy,
  };
}

function countHits(text: string, tokens: string[]): number {
  return tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
