import type { AdaptationContext, PersonalityProfile, PersonalitySignal } from "./types.js";

export function buildAdaptationContext(params: {
  profile: PersonalityProfile;
  signal: PersonalitySignal;
}): AdaptationContext {
  const { profile, signal } = params;

  const namingHints = [
    "Gunakan rule sapaan tim: Mas hanya untuk Mas Joko, Kang untuk Kang De/Kang Zala, lainnya Bang, Saddam boleh Dam/Saddam.",
  ];

  return {
    userId: profile.userId,
    style: {
      tone: profile.preferences.tone,
      responseLength: profile.preferences.responseLength,
      directness: profile.preferences.directness,
      reactionPreference: profile.preferences.reactionPreference,
    },
    stressLevel: signal.stressLevel,
    namingHints,
    systemHint: buildSystemHint(profile, signal),
  };
}

export function buildSystemHint(profile: PersonalityProfile, signal: PersonalitySignal): string {
  const hints: string[] = [];

  hints.push(`Tone=${profile.preferences.tone}`);
  hints.push(`Length=${profile.preferences.responseLength}`);
  hints.push(`Directness=${profile.preferences.directness}`);
  hints.push(`ReactionPreference=${profile.preferences.reactionPreference}`);

  if (signal.stressLevel >= 2) {
    hints.push("User terlihat stres: validasi singkat lalu kasih langkah next action.");
  }
  if (profile.traits.communicationStyle === "diplomatic") {
    hints.push("Pilih bahasa halus, hindari wording terlalu tajam.");
  }
  if (profile.traits.communicationStyle === "direct" || profile.traits.communicationStyle === "explicit") {
    hints.push("Jawab to-the-point, jangan muter.");
  }

  hints.push("Personality hanya untuk style, tidak boleh override safety/guardrails.");

  return hints.join(" ");
}

export function applyStylePresetSafely(text: string, ctx?: AdaptationContext): string {
  if (!ctx) return text;
  if (!text.trim()) return text;
  if (/```[\s\S]*?```/.test(text)) {
    return text;
  }

  let out = text.trim();

  if (ctx.style.directness === "high") {
    out = out.replace(/^(noted|oke|okay|siap|sip)[,\s]+/i, "");
  }

  const limit = ctx.style.responseLength === "short" ? 360 : ctx.style.responseLength === "medium" ? 900 : 1800;
  if (out.length > limit) {
    const clipped = out.slice(0, limit);
    const boundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("\n"), clipped.lastIndexOf("!"), clipped.lastIndexOf("?"));
    out = (boundary > Math.floor(limit * 0.6) ? clipped.slice(0, boundary + 1) : clipped).trim();
  }

  return out;
}
