import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyStylePresetSafely } from "../src/personality-adapter.ts";
import { chunkFeishuReplyText } from "../src/text/chunking.ts";
import { normalizeFeishuMarkdownLinks } from "../src/text/markdown-links.ts";

function legacyApplyStylePresetSafely(text: string, ctx?: { style?: { responseLength?: string; directness?: string } }): string {
  if (!ctx) return text;
  if (!text.trim()) return text;
  if (/```[\s\S]*?```/.test(text)) {
    return text;
  }

  let out = text.trim();

  if (ctx.style?.directness === "high") {
    out = out.replace(/^(noted|oke|okay|siap|sip)[,\s]+/i, "");
  }

  const limit =
    ctx.style?.responseLength === "short"
      ? 1200
      : ctx.style?.responseLength === "medium"
        ? 2400
        : 4000;

  if (out.length > limit) {
    const clipped = out.slice(0, limit);
    const boundary = Math.max(
      clipped.lastIndexOf("\n"),
      clipped.lastIndexOf("."),
      clipped.lastIndexOf("!"),
      clipped.lastIndexOf("?"),
    );
    out = (boundary > Math.floor(limit * 0.7) ? clipped.slice(0, boundary + 1) : clipped).trim();
  }

  return out;
}

function hasOddInlineBackticks(text: string): boolean {
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");
  let count = 0;
  for (let i = 0; i < withoutFences.length; i++) {
    if (withoutFences[i] !== "`") continue;
    const escaped = i > 0 && withoutFences[i - 1] === "\\";
    if (escaped) continue;

    let runLength = 1;
    while (i + runLength < withoutFences.length && withoutFences[i + runLength] === "`") {
      runLength += 1;
    }
    if (runLength === 1) count += 1;
    i += runLength - 1;
  }
  return count % 2 === 1;
}

function buildLatestUpdateSummarySample(): string {
  const title = "Latest Update Summary\n\n";
  const intro = "status handoff risk matrix sync checklist ";
  const desiredOpenTickIndex = 3995;

  const fixedPrefix = `${title}${intro}`;
  const fillerLen = Math.max(0, desiredOpenTickIndex - fixedPrefix.length);
  const filler = "x".repeat(fillerLen);

  return `${fixedPrefix}${filler}\`MEMORY.md\` before sync with risk squad and keep this tail marker visible FINAL_TAIL_MARKER`;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const distDir = path.join(repoRoot, "node_modules", "openclaw", "dist");
const irFile = fs
  .readdirSync(distDir)
  .filter((name) => /^ir-.*\.js$/.test(name))
  .sort()[0];

if (!irFile) {
  throw new Error("Unable to locate openclaw IR chunking module (ir-*.js)");
}

const irModule = await import(pathToFileURL(path.join(distDir, irFile)).href);
const chunkMarkdownText = irModule.l as (text: string, limit: number) => string[];
const chunkMarkdownTextWithMode = irModule.u as (
  text: string,
  limit: number,
  mode: "length" | "newline",
) => string[];

const sample = buildLatestUpdateSummarySample();
const ctx = { style: { responseLength: "long", directness: "balanced" } };

const legacy = legacyApplyStylePresetSafely(sample, ctx);
assert(legacy.length < sample.length, "Legacy style adapter should truncate this sample");
assert(!legacy.includes("FINAL_TAIL_MARKER"), "Legacy style adapter should drop tail marker");
assert(hasOddInlineBackticks(legacy), "Legacy style adapter should leave dangling inline backtick");

const fixed = applyStylePresetSafely(sample, ctx as any);
assert.equal(fixed, sample.trim(), "Fixed style adapter must preserve full markdown reply text");
assert(fixed.includes("`MEMORY.md`"), "Fixed style adapter must preserve inline code span");
assert(fixed.includes("FINAL_TAIL_MARKER"), "Fixed style adapter must preserve tail marker");
assert(!hasOddInlineBackticks(fixed), "Fixed style adapter should not leave odd inline backticks");

const normalized = normalizeFeishuMarkdownLinks(fixed);
const chunks = chunkFeishuReplyText({
  text: normalized,
  limit: 4000,
  chunkMode: "length",
  textRuntime: {
    chunkMarkdownText,
    chunkMarkdownTextWithMode,
  },
});

assert(chunks.length >= 2, "Expected chunking to split preserved long message");
assert(chunks.some((chunk) => chunk.includes("FINAL_TAIL_MARKER")), "Chunked output must retain tail marker");
assert(
  chunks.every((chunk, idx) => idx === chunks.length - 1 || !hasOddInlineBackticks(chunk)),
  "Intermediate chunks should not contain odd inline backticks",
);

console.log("[ok] long reply truncation regression checks passed");
console.log(`sample=${sample.length}, legacy=${legacy.length}, fixed=${fixed.length}, chunks=${chunks.length}`);
