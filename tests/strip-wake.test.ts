import assert from "node:assert/strict";
import { test } from "node:test";
import { stripWakePhrase } from "../src/main/audio/pipeline.ts";

const WAKE = ["hey jeff", "hey jev"];

test("removes the wake phrase the recogniser heard in the pre-roll", () => {
  assert.equal(stripWakePhrase("Hey Jeff, open Safari", WAKE), "open Safari");
  assert.equal(stripWakePhrase("hey jev open safari", WAKE), "open safari");
});

test("handles the ways the phrase actually comes back clipped", () => {
  // These are the real failure shapes: the phrase sits at the very edge of the
  // captured audio, so it arrives partial or misheard.
  assert.equal(stripWakePhrase("Jeff, open Safari", WAKE), "open Safari");
  assert.equal(stripWakePhrase("A Jeff open safari", WAKE), "open safari");
  assert.equal(stripWakePhrase("Hey Jef, open Safari", WAKE), "open Safari");
});

test("preserves the casing and punctuation of the command itself", () => {
  assert.equal(stripWakePhrase("Hey Jeff, open GitHub Desktop", WAKE), "open GitHub Desktop");
});

test("returns empty when nothing but the wake phrase was heard", () => {
  assert.equal(stripWakePhrase("Hey Jeff", WAKE), "");
  assert.equal(stripWakePhrase("hey jeff.", WAKE), "");
});

test("leaves a transcript that never contained the wake phrase alone", () => {
  assert.equal(stripWakePhrase("open safari", WAKE), "open safari");
  // A command that merely mentions a similar word must survive intact.
  assert.equal(stripWakePhrase("email jeffrey about the release", WAKE), "email jeffrey about the release");
});

test("does not strip a bare name that is part of the command", () => {
  // "jeff" only counts as a wake phrase at the very front.
  assert.equal(stripWakePhrase("tell jeff hello", WAKE), "tell jeff hello");
});

test("prefers the longest match so the full phrase is removed", () => {
  // Naive shortest-first matching would strip only "jeff" and leave a stray "hey".
  assert.equal(stripWakePhrase("hey jeff volume to thirty", WAKE), "volume to thirty");
});

test("copes with custom and single-word wake phrases", () => {
  assert.equal(stripWakePhrase("computer lock the screen", ["computer"]), "lock the screen");
  assert.equal(stripWakePhrase("hey jeffrey open mail", ["hey jeffrey"]), "open mail");
});

test("handles empty input safely", () => {
  assert.equal(stripWakePhrase("", WAKE), "");
  assert.equal(stripWakePhrase("   ", WAKE), "");
  assert.equal(stripWakePhrase("open safari", []), "open safari");
});
