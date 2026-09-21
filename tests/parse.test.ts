import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterPhrase,
  extractUrl,
  fuzzyScore,
  parseCount,
  parsePercent,
  parseSpokenNumber,
  shortlistBy,
} from "../src/main/actions/parse.ts";

test("parses spoken numbers the way people say them", () => {
  assert.equal(parseSpokenNumber("thirty"), 30);
  assert.equal(parseSpokenNumber("twenty five"), 25);
  assert.equal(parseSpokenNumber("twenty-five"), 25);
  assert.equal(parseSpokenNumber("a hundred"), 100);
  assert.equal(parseSpokenNumber("one hundred"), 100);
  assert.equal(parseSpokenNumber("seventy two"), 72);
  assert.equal(parseSpokenNumber("fourty"), 40, "a very common transcription of 'forty'");
});

test("prefers digits, which is how speech-to-text usually normalises them", () => {
  assert.equal(parseSpokenNumber("set volume to 35"), 35);
  assert.equal(parseSpokenNumber("volume to 30%."), 30);
});

test("returns null when there is no number at all", () => {
  assert.equal(parseSpokenNumber("open safari"), null);
  assert.equal(parseSpokenNumber(""), null);
});

test("stops at the end of the number instead of absorbing later words", () => {
  assert.equal(parseSpokenNumber("thirty percent please"), 30);
});

test("percentages handle the words used for the extremes", () => {
  assert.equal(parsePercent("set volume to thirty percent"), 30);
  assert.equal(parsePercent("volume to 30%."), 30);
  assert.equal(parsePercent("mute the volume"), 0);
  assert.equal(parsePercent("volume all the way up"), 100);
  assert.equal(parsePercent("set volume to half"), 50);
  assert.equal(parsePercent("turn it up"), null);
});

test("percentages are clamped to a sane range", () => {
  assert.equal(parsePercent("set volume to 500"), 100);
});

test("counts understand repetition words", () => {
  assert.equal(parseCount("scroll down"), 1);
  assert.equal(parseCount("scroll down three times"), 3);
  assert.equal(parseCount("scroll down twice"), 2);
  assert.equal(parseCount("scroll down a lot"), 5);
  assert.equal(parseCount("scroll down a bit"), 1);
});

test("lifts the text after a lead-in phrase verbatim", () => {
  assert.equal(afterPhrase("search for typescript generics", ["search for"]), "typescript generics");
  assert.equal(afterPhrase("type hello world", ["type"]), "hello world");
  // Casing and inner punctuation of the payload are preserved exactly.
  assert.equal(afterPhrase("type Hello, World!", ["type"]), "Hello, World");
});

test("returns null when the lead-in has nothing after it", () => {
  assert.equal(afterPhrase("search for", ["search for"]), null);
  assert.equal(afterPhrase("open safari", ["search for"]), null);
});

test("prefers the longest lead-in so the payload is not polluted", () => {
  assert.equal(afterPhrase("search for cats", ["search", "search for"]), "cats");
});

test("extracts urls, including spoken ones", () => {
  assert.equal(extractUrl("go to https://example.com/x"), "https://example.com/x");
  assert.equal(extractUrl("open github dot com"), "github.com");
  assert.equal(extractUrl("open safari"), null, "a plain sentence is not a url");
});

test("fuzzy scoring ranks a direct mention highest", () => {
  assert.ok(fuzzyScore("open safari", "Safari") > fuzzyScore("open safari", "Mail"));
  assert.equal(fuzzyScore("open mail", "Mail"), 1 + 4 / 100);
  assert.equal(fuzzyScore("open safari", "Mail"), 0);
});

test("fuzzy scoring copes with multi-word and squashed app names", () => {
  assert.ok(fuzzyScore("open visual studio code", "Visual Studio Code") > 0.9);
  assert.ok(fuzzyScore("open iterm", "iTerm") > 0.9);
});

test("shortlisting keeps the plausible candidates and drops the rest", () => {
  const apps = ["Safari", "Mail", "Messages", "Music", "Maps", "Terminal"];
  const out = shortlistBy("open safari", apps, 5);
  assert.deepEqual(out, ["Safari"]);
});

test("shortlisting returns nothing when the transcript names nothing", () => {
  const apps = ["Safari", "Mail", "Terminal"];
  assert.deepEqual(shortlistBy("what is the weather", apps, 5), []);
});

test("shortlisting respects its limit so the model's state stays small", () => {
  const apps = Array.from({ length: 50 }, (_, i) => `App ${i}`);
  assert.ok(shortlistBy("open app 1", apps, 4).length <= 4);
});
