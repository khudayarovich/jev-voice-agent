import assert from "node:assert/strict";
import { test } from "node:test";
import { splitCommands } from "../src/main/actions/split.ts";

test("splits a chained request into separate commands", () => {
  assert.deepEqual(splitCommands("open Firefox and open YouTube"), [
    "open Firefox",
    "open YouTube",
  ]);
  assert.deepEqual(splitCommands("mute the volume then lock the screen"), [
    "mute the volume",
    "lock the screen",
  ]);
  assert.deepEqual(splitCommands("turn on dark mode, and take a screenshot"), [
    "turn on dark mode",
    "take a screenshot",
  ]);
});

test("does NOT split a command whose payload contains the conjunction", () => {
  // The whole reason splitting is risky: "and" is an ordinary English word.
  for (const t of [
    "type hello and goodbye",
    "search for cats and dogs",
    "type dear sarah and thank you for your time",
  ]) {
    assert.deepEqual(splitCommands(t), [t], t);
  }
});

test("leaves a single command untouched", () => {
  assert.deepEqual(splitCommands("open safari"), ["open safari"]);
  assert.deepEqual(splitCommands("set volume to thirty percent"), [
    "set volume to thirty percent",
  ]);
});

test("does not split ordinary speech that merely contains 'and'", () => {
  const t = "well I was thinking about it and it seemed fine";
  assert.deepEqual(splitCommands(t), [t]);
});

test("handles empty and whitespace input", () => {
  assert.deepEqual(splitCommands(""), []);
  assert.deepEqual(splitCommands("   "), []);
});

test("keeps three chained commands", () => {
  assert.deepEqual(splitCommands("mute then take a screenshot then lock the screen"), [
    "mute",
    "take a screenshot",
    "lock the screen",
  ]);
});
