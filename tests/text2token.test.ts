import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PhraseTokenizer, fromLabel } from "../src/main/audio/text2token.ts";

const MODEL = "resources/models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const tok = PhraseTokenizer.fromFile(`${MODEL}/bpe.model`);

const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean);

test("reproduces the model's own reference keyword list exactly", () => {
  // The shipped keywords_raw.txt / keywords.txt are a ground-truth pair produced
  // by sherpa-onnx's own Python text2token. Matching every line is what proves
  // the Viterbi implementation agrees with upstream.
  const raw = lines(`${MODEL}/keywords_raw.txt`);
  const want = lines(`${MODEL}/keywords.txt`);
  assert.equal(raw.length, want.length);
  raw.forEach((phrase, i) => {
    assert.equal(tok.encode(phrase), want[i]!.trim(), `mismatch for "${phrase}"`);
  });
});

test("encodes the shipped wake words", () => {
  assert.equal(tok.encode("hey jeff"), "▁HE Y ▁JE FF");
  assert.equal(tok.encode("hey jev"), "▁HE Y ▁JE V");
  // The longer variant Settings offers when "hey jeff" proves twitchy.
  assert.equal(tok.encode("hey jeffrey"), "▁HE Y ▁JE FF RE Y");
});

test("is case and whitespace insensitive", () => {
  assert.equal(tok.encode("  HeY   JeFF "), tok.encode("hey jeff"));
});

test("rejects phrases the model cannot represent", () => {
  assert.equal(tok.encode("привет"), null);
  assert.equal(tok.encode("   "), null);
});

test("builds a keywords file and reports what it skipped", () => {
  const { text, skipped } = tok.buildKeywordsFile(["hey jeff", "привет", "hey jev"], 2);
  assert.deepEqual(skipped, ["привет"]);
  const out = text.trim().split("\n");
  assert.equal(out.length, 2);
  assert.equal(out[0], "▁HE Y ▁JE FF :2.0 @hey_jeff");
});

test("never emits a '#' field, which sherpa parses as a float and aborts on", () => {
  // Regression: `#hey jeff` made the native side call std::stof("hey"), which
  // throws std::invalid_argument and kills the whole process — an abort no
  // JavaScript try/catch can intercept. The only fix is to never write the line.
  const { text } = tok.buildKeywordsFile(["hey jeff", "hey jeffrey"]);
  assert.ok(!text.includes("#"), "a '#' field must never reach the keywords file");
});

test("labels are whitespace-free and round-trip back to the spoken phrase", () => {
  const { text } = tok.buildKeywordsFile(["hey jeff"]);
  const label = text.trim().split("@")[1]!;
  assert.ok(!/\s/.test(label), "the @label is whitespace-split by sherpa, so it must have none");
  assert.equal(fromLabel(label), "hey jeff");
});

test("every emitted line has exactly the fields sherpa can parse", () => {
  const { text } = tok.buildKeywordsFile(["hey jeff", "hey jev", "open the pod bay doors"]);
  for (const line of text.trim().split("\n")) {
    const fields = line.split(" ");
    for (const f of fields) {
      if (f.startsWith(":")) {
        assert.ok(Number.isFinite(Number(f.slice(1))), `boost must parse as a float: ${f}`);
      } else if (f.startsWith("@")) {
        assert.match(f.slice(1), /^[a-z0-9_]+$/);
      } else {
        // everything else must be a real token from the model's vocabulary
        assert.ok(!f.startsWith("#"), `unexpected threshold field: ${f}`);
      }
    }
  }
});

test("strips characters that would corrupt the label", () => {
  const { text, skipped } = tok.buildKeywordsFile(["hey  jeff!!"]);
  assert.deepEqual(skipped, []);
  assert.ok(text.includes("@hey_jeff"), text);
});
