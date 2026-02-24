import fs from "node:fs";
import path from "node:path";
import type {
  PersonalityEvent,
  PersonalityFeedbackUpdate,
  PersonalityProfile,
  PersonalitySignal,
} from "./types.js";

const WORKSPACE_ROOT = "/home/shusain/.openclaw/workspace";
const PROFILES_DIR = path.join(WORKSPACE_ROOT, "memory", "personalities", "profiles");
const EVENTS_PATH = path.join(WORKSPACE_ROOT, "memory", "personalities", "events.jsonl");

function nowIso(): string {
  return new Date().toISOString();
}

function profilePath(userId: string): string {
  return path.join(PROFILES_DIR, `${userId}.json`);
}

export function createDefaultPersonalityProfile(userId: string, userName?: string): PersonalityProfile {
  return {
    userId,
    userName,
    lastUpdated: nowIso(),
    traits: {
      communicationStyle: "direct",
      humorTolerance: "medium",
      stressThreshold: "normal",
      feedbackStyle: "direct",
      workRhythm: "flexible",
    },
    preferences: {
      tone: "casual",
      responseLength: "medium",
      directness: "high",
      reactionPreference: "normal",
    },
    interactions: {
      totalMessages: 0,
      messagesWithHumor: 0,
      stressIndicators: 0,
      lastInteraction: null,
    },
  };
}

export async function loadOrCreatePersonalityProfile(userId: string, userName?: string): Promise<PersonalityProfile> {
  await fs.promises.mkdir(PROFILES_DIR, { recursive: true });
  const p = profilePath(userId);

  try {
    const raw = await fs.promises.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as PersonalityProfile;
    if (!parsed.userId) {
      throw new Error("invalid profile: missing userId");
    }
    if (userName && !parsed.userName) {
      parsed.userName = userName;
    }
    return parsed;
  } catch {
    const profile = createDefaultPersonalityProfile(userId, userName);
    await savePersonalityProfile(profile);
    return profile;
  }
}

export async function savePersonalityProfile(profile: PersonalityProfile): Promise<void> {
  await fs.promises.mkdir(PROFILES_DIR, { recursive: true });
  profile.lastUpdated = nowIso();
  await fs.promises.writeFile(profilePath(profile.userId), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

export function applySignalToProfile(profile: PersonalityProfile, signal: PersonalitySignal): PersonalityProfile {
  const next = { ...profile };

  next.userName = next.userName ?? signal.userName;
  next.interactions = {
    ...next.interactions,
    totalMessages: (next.interactions.totalMessages ?? 0) + 1,
    messagesWithHumor: (next.interactions.messagesWithHumor ?? 0) + (signal.hasHumor ? 1 : 0),
    stressIndicators: (next.interactions.stressIndicators ?? 0) + signal.stressLevel,
    lastInteraction: nowIso(),
  };

  if (signal.explicitness >= 0.7) {
    next.traits.communicationStyle = "explicit";
    next.preferences.directness = "high";
  } else if (signal.nuance >= 0.65) {
    next.traits.communicationStyle = "nuanced";
    next.preferences.directness = "balanced";
  } else if (signal.diplomacy >= 0.65) {
    next.traits.communicationStyle = "diplomatic";
    next.preferences.directness = "soft";
  } else {
    next.traits.communicationStyle = "direct";
  }

  if (signal.hasHumor) {
    next.traits.humorTolerance = "high";
    next.preferences.tone = "casual";
  }

  if (signal.stressLevel >= 2) {
    next.traits.stressThreshold = "sensitive";
    next.preferences.tone = "supportive";
    next.preferences.responseLength = "short";
  } else if (signal.stressLevel === 0 && next.traits.stressThreshold !== "sensitive") {
    next.traits.stressThreshold = "normal";
  }

  return next;
}

export async function appendPersonalityEvent(event: PersonalityEvent): Promise<void> {
  await fs.promises.mkdir(path.dirname(EVENTS_PATH), { recursive: true });
  await fs.promises.appendFile(EVENTS_PATH, `${JSON.stringify(event)}\n`, "utf8");
}

export function buildFeedbackEvent(update: PersonalityFeedbackUpdate): PersonalityEvent {
  return {
    timestamp: nowIso(),
    userId: update.userId,
    messageId: update.messageId,
    outcome: update.outcome,
    scoreDelta: update.scoreDelta,
    note: update.note,
  };
}
