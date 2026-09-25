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

test("a command, then a search whose words keep their 'and'", () => {
  // Said in one breath with a recogniser too slow to stream, this used to stay
  // one command, and half of it was lost.
  assert.deepEqual(splitCommands("open chrome and search for youtube"), ["open chrome", "search for youtube"]);
  assert.deepEqual(splitCommands("open chrome and search for cats and dogs"), ["open chrome", "search for cats and dogs"]);
  assert.deepEqual(splitCommands("open notes and type hello and goodbye"), ["open notes", "type hello and goodbye"]);
});

test("a search, then a click on what it found", () => {
  assert.deepEqual(splitCommands("search for cats and dogs and click the first result"), [
    "search for cats and dogs",
    "click the first result",
  ]);
  assert.deepEqual(splitCommands("search for youtube and open the second result"), ["search for youtube", "open the second result"]);
});

test("what to click keeps its 'and'", () => {
  assert.deepEqual(splitCommands("click terms and conditions"), ["click terms and conditions"]);
  assert.deepEqual(splitCommands("type hello and click send"), ["type hello and click send"], "dictation stays literal");
});
