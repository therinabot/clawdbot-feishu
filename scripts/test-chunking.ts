import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chunkFeishuReplyText } from "../src/text/chunking.ts";

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
const chunkTextWithMode = irModule.f as (text: string, limit: number, mode: "length" | "newline") => string[];
const chunkMarkdownText = irModule.l as (text: string, limit: number) => string[];
const chunkMarkdownTextWithMode = irModule.u as (
  text: string,
  limit: number,
  mode: "length" | "newline",
) => string[];

function hasOddInlineBackticks(text: string): boolean {
  const withoutFences = text.replace(/```[\s\S]*?```/g, "");
  let count = 0;
  for (let i = 0; i < withoutFences.length; i++) {
    if (withoutFences[i] !== "`") {
      continue;
    }
    const escaped = i > 0 && withoutFences[i - 1] === "\\";
    if (escaped) {
      continue;
    }

    let runLength = 1;
    while (i + runLength < withoutFences.length && withoutFences[i + runLength] === "`") {
      runLength += 1;
    }

    if (runLength === 1) {
      count += 1;
    }
    i += runLength - 1;
  }
  return count % 2 === 1;
}

// Case 1: legacy chunking can split an inline code span and leave odd backticks.
const inlineSpanText =
  "prefix ".repeat(10) +
  "`THIS_IS_A_VERY_LONG_INLINE_CODE_SPAN_WITH_NO_SPACES_AND_TICKS` suffix suffix suffix";
const inlineLimit = 60;

const legacyInlineChunks = chunkTextWithMode(inlineSpanText, inlineLimit, "length");
assert(
  legacyInlineChunks.some((chunk) => hasOddInlineBackticks(chunk)),
  "Expected legacy chunkTextWithMode to produce an inline-code-unbalanced chunk",
);

const fixedInlineChunks = chunkFeishuReplyText({
  text: inlineSpanText,
  limit: inlineLimit,
  chunkMode: "length",
  textRuntime: {
    chunkMarkdownText,
    chunkMarkdownTextWithMode,
  },
});
assert(
  fixedInlineChunks.every((chunk, idx) => idx === fixedInlineChunks.length - 1 || !hasOddInlineBackticks(chunk)),
  "Expected feishu chunker to avoid odd inline backticks on intermediate chunks",
);

// Case 2: newline mode should avoid over-fragmenting small paragraphs.
const newlineText = ["Paragraph A", "Paragraph B", "Paragraph C", "Paragraph D"].join("\n\n");
const legacyNewlineChunks = chunkTextWithMode(newlineText, 120, "newline");
const fixedNewlineChunks = chunkFeishuReplyText({
  text: newlineText,
  limit: 120,
  chunkMode: "newline",
  textRuntime: {
    chunkMarkdownText,
    chunkMarkdownTextWithMode,
  },
});
assert.equal(legacyNewlineChunks.length, 4, "Expected legacy newline chunking to split per paragraph");
assert.equal(
  fixedNewlineChunks.length,
  1,
  "Expected feishu chunker to pack short newline chunks into one message",
);

console.log("[ok] chunking regression checks passed");
console.log(`legacy inline chunks=${legacyInlineChunks.length}, fixed inline chunks=${fixedInlineChunks.length}`);
console.log(
  `legacy newline chunks=${legacyNewlineChunks.length}, fixed newline chunks=${fixedNewlineChunks.length}`,
);
