import assert from "node:assert/strict";
import { test } from "node:test";
import { isDismissal } from "../src/main/actions/execute.ts";

test("recognises the natural ways people close a conversation", () => {
  for (const s of [
    "that's it",
    "that's it thank you",
    "that's all thanks",
    "thank you",
    "thanks",
    "ok thanks",
    "that's everything",
    "I'm done",
    "we're done",
    "nothing else",
    "goodbye",
    "bye",
    "alright that's it thanks",
  ]) {
    assert.equal(isDismissal(s), true, s);
  }
});

test("tolerates punctuation and casing from the recogniser", () => {
  assert.equal(isDismissal("That's it, thank you."), true);
  assert.equal(isDismissal("THANKS!"), true);
});

test("ignores the assistant's own name in the dismissal", () => {
  assert.equal(isDismissal("thanks jeff"), true);
  assert.equal(isDismissal("that's it jeff thank you"), true);
});

test("does NOT hang up on a polite command", () => {
  // The whole point of requiring the entire utterance to be a dismissal: a
  // command that merely contains "thanks" must still run.
  for (const s of [
    "thanks now open safari",
    "open safari thanks",
    "that's it for the volume now mute it",
    "say thank you",
    "type thank you for your time",
  ]) {
    assert.equal(isDismissal(s), false, s);
  }
});

test("is not fooled by an empty or noise transcript", () => {
  assert.equal(isDismissal(""), false);
  assert.equal(isDismissal("   "), false);
  assert.equal(isDismissal("um uh"), false);
});

test("an ordinary command is never a dismissal", () => {
  for (const s of ["open safari", "set volume to thirty", "take a screenshot"]) {
    assert.equal(isDismissal(s), false, s);
  }
});
