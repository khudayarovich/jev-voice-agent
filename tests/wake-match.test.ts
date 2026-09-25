import assert from "node:assert/strict";
import { test } from "node:test";
import { matchWake, wakeVerdict } from "../src/main/audio/wake-match.ts";

const WAKE = ["hey jeff", "hey jev"];
const m = (t: string) => matchWake(t, WAKE);

test("matches the wake phrase and returns the command after it", () => {
  assert.deepEqual(
    { ...m("Hey Jeff, open Safari") },
    { matched: true, rest: "open Safari", phrase: "hey jeff" },
  );
});

test("keeps the command's original casing and inner punctuation", () => {
  assert.equal(m("Hey Jeff, type Hello, World!").rest, "type Hello, World!");
  assert.equal(m("hey jeff open GitHub Desktop").rest, "open GitHub Desktop");
});

test("matches the ways the name actually comes back from the recogniser", () => {
  // Every one of these was observed in a real run.
  for (const t of [
    "Hey Jef, open Safari",
    "Hey Jev, open Safari",
    "Jeff, open Safari",
    "hey jeff. open safari",
  ]) {
    const r = m(t);
    assert.equal(r.matched, true, t);
    assert.match(r.rest.toLowerCase(), /open safari/, t);
  }
});

test("tolerates leading filler the recogniser invents", () => {
  for (const t of ["Um, hey Jeff, open Safari", "Oh hey Jeff open safari", "So, Jeff, open Safari"]) {
    assert.equal(m(t).matched, true, t);
  }
});

test("a bare wake phrase matches with nothing after it", () => {
  const r = m("Hey Jeff");
  assert.equal(r.matched, true);
  assert.equal(r.rest, "");
});

test("does not fire on speech that merely mentions the name", () => {
  // The phrase has to OPEN the utterance, or every conversation about Jeff
  // becomes a command.
  for (const t of [
    "I was talking to Jeff about the release",
    "tell jeff hello",
    "what did jeff say",
    "open safari",
  ]) {
    assert.equal(m(t).matched, false, t);
  }
});

test("does not fire on an unrelated utterance", () => {
  for (const t of ["the weather is nice today", "", "   ", "mmm hmm"]) {
    assert.equal(m(t).matched, false, t);
  }
});

test("accepts a mangled name only when a command clearly follows", () => {
  // "hey jess" alone is probably someone greeting a person.
  assert.equal(m("hey jess").matched, false);
  // ...but with a command after it, the shape is unmistakable.
  assert.equal(m("hey jess open safari").matched, true);
});

test("works with a custom wake phrase", () => {
  assert.deepEqual(
    { ...matchWake("computer, lock the screen", ["computer"]) },
    { matched: true, rest: "lock the screen", phrase: "computer" },
  );
});

test("handles a longer wake phrase", () => {
  const r = matchWake("Hey Jeffrey, take a screenshot", ["hey jeffrey"]);
  assert.equal(r.matched, true);
  assert.equal(r.rest, "take a screenshot");
});

// --- deciding early, from a partial transcript -------------------------------

test("a partial that opens with the wake phrase is for us", () => {
  assert.equal(wakeVerdict("Hey Jeff, open", WAKE), "yes");
  assert.equal(wakeVerdict("hey jeff", WAKE), "yes");
});

test("three real words without it is someone else's conversation", () => {
  assert.equal(wakeVerdict("so I was telling him", WAKE), "no");
  assert.equal(wakeVerdict("What time is the meeting", WAKE), "no");
});

test("too little to tell is not a rejection", () => {
  // Rejecting here would drop "so yeah, hey Jeff, open Safari" before the wake
  // phrase had even been said.
  for (const t of ["Hey", "So, um", "So yeah, hey", "hey jess", ""]) {
    assert.equal(wakeVerdict(t, WAKE), "unsure", JSON.stringify(t));
  }
});
