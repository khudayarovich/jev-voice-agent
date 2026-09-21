import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVocabularyPrompt } from "../src/main/audio/vocabulary.ts";

test("includes the installed app names, which is the whole point", () => {
  const p = buildVocabularyPrompt(["Safari", "Visual Studio Code", "Slack"]);
  assert.match(p, /Safari/);
  assert.match(p, /Visual Studio Code/);
  assert.match(p, /Slack/);
});

test("puts running apps first, as the likeliest to be named", () => {
  const p = buildVocabularyPrompt(["Aardvark", "Safari", "Zebra"], ["Zebra"]);
  assert.ok(p.indexOf("Zebra") < p.indexOf("Aardvark"), p);
});

test("includes command phrasings so the model expects an instruction", () => {
  const p = buildVocabularyPrompt([]);
  assert.match(p, /open safari|take a screenshot|volume/i);
});

test("stays within whisper's prompt budget even with a huge app list", () => {
  const many = Array.from({ length: 500 }, (_, i) => `Application Number ${i}`);
  const p = buildVocabularyPrompt(many);
  assert.ok(p.length <= 900, `prompt was ${p.length} chars`);
});

test("copes with no apps at all", () => {
  const p = buildVocabularyPrompt([]);
  assert.ok(p.length > 0);
  assert.doesNotThrow(() => buildVocabularyPrompt([], []));
});

test("skips bundle identifiers that are not spoken names", () => {
  const p = buildVocabularyPrompt(["com.apple.Safari", "Safari"]);
  assert.ok(!p.includes("com.apple.Safari"), p);
});

test("ranks by recency, not alphabetically", () => {
  // Alphabetical ordering is actively harmful here: it keeps every utility
  // beginning with "A" and drops Safari, Slack and Terminal off the end.
  const p = buildVocabularyPrompt([
    { name: "Aardvark Utility", lastUsed: 1 },
    { name: "Safari", lastUsed: 9_000_000 },
    { name: "Terminal", lastUsed: 8_000_000 },
  ]);
  assert.ok(p.indexOf("Safari") < p.indexOf("Aardvark"), p);
  assert.ok(p.indexOf("Safari") < p.indexOf("Terminal"), p);
});

test("running apps still outrank a more recently used one", () => {
  const p = buildVocabularyPrompt(
    [{ name: "Photos", lastUsed: 9_000_000 }, { name: "Slack", lastUsed: 1 }],
    ["Slack"],
  );
  assert.ok(p.indexOf("Slack") < p.indexOf("Photos"), p);
});

test("accepts plain strings as well as annotated apps", () => {
  assert.match(buildVocabularyPrompt(["Safari", "Mail"]), /Safari/);
});
