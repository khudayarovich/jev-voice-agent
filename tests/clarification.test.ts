import assert from "node:assert/strict";
import { test } from "node:test";
import { readClarification } from "../src/main/actions/execute.ts";

/**
 * The answer to "which one — Xcode or Cursor?". It has to complete the
 * original command: "quit my editor", then "Cursor", must quit Cursor rather
 * than be routed on its own and open it.
 */

const OPTIONS = ["Xcode", "Cursor"];
const OTHERS = ["Xcode", "Cursor", "PhpStorm", "Safari", "Google Chrome"];

test("an option named is the answer", () => {
  assert.deepEqual(readClarification("Cursor", OPTIONS, OTHERS, false), { kind: "pick", value: "Cursor" });
  assert.deepEqual(readClarification("the cursor one, please", OPTIONS, OTHERS, false), { kind: "pick", value: "Cursor" });
});

test("another app, said outright, is an answer too", () => {
  assert.deepEqual(readClarification("PhpStorm", OPTIONS, OTHERS, false), { kind: "pick", value: "PhpStorm" });
});

test("by position", () => {
  assert.deepEqual(readClarification("the first one", OPTIONS, OTHERS, false), { kind: "pick", value: "Xcode" });
  assert.deepEqual(readClarification("the second one", OPTIONS, OTHERS, false), { kind: "pick", value: "Cursor" });
  assert.deepEqual(readClarification("the other one", OPTIONS, OTHERS, false), { kind: "pick", value: "Cursor" });
});

test("yes takes the first guess; no calls it off", () => {
  assert.deepEqual(readClarification("yes", OPTIONS, OTHERS, false), { kind: "pick", value: "Xcode" });
  assert.deepEqual(readClarification("never mind", OPTIONS, OTHERS, false), { kind: "cancel" });
});

test("a different command is not an answer", () => {
  assert.deepEqual(readClarification("open Safari", OPTIONS, OTHERS, true), { kind: "new" });
  assert.deepEqual(readClarification("what time is it", OPTIONS, OTHERS, false), { kind: "new" });
});
