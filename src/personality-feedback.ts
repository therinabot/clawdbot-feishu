import type { PersonalityFeedbackUpdate, PersonalityProfile } from "./types.js";

export function applyFeedback(profile: PersonalityProfile, update: PersonalityFeedbackUpdate): PersonalityProfile {
  const next = { ...profile };

  if (update.outcome === "REACT") {
    next.preferences.reactionPreference = "high";
  }

  if (update.outcome === "NO_REPLY" && next.preferences.responseLength === "medium") {
    next.preferences.responseLength = "short";
  }

  if (update.scoreDelta > 0 && next.preferences.directness === "soft") {
    next.preferences.directness = "balanced";
  }

  if (update.scoreDelta < 0 && next.preferences.directness === "high") {
    next.preferences.directness = "balanced";
  }

  return next;
}
