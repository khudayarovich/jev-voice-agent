import assert from "node:assert/strict";
import { test } from "node:test";
import { hudBody } from "../src/shared/hud.ts";
import type { HudModel } from "../src/shared/types.ts";

function model(over: Partial<HudModel>): HudModel {
  return { state: "idle", transcript: "", partial: false, detail: "", level: 0, ...over };
}

test("the user's words show while they are being said and read", () => {
  assert.equal(hudBody(model({ state: "listening", transcript: "open saf", partial: true, detail: "Listening…" })), "open saf");
  assert.equal(hudBody(model({ state: "thinking", transcript: "open safari", detail: "Working out what you meant…" })), "open safari");
  assert.equal(hudBody(model({ state: "executing", transcript: "open safari", detail: "Open app" })), "open safari");
});

test("with nothing said yet, the status shows", () => {
  assert.equal(hudBody(model({ state: "listening", detail: "Listening…" })), "Listening…");
  assert.equal(hudBody(model({ state: "conversing", detail: "Go ahead…" })), "Go ahead…");
});

test("a question is shown over the words that prompted it", () => {
  // From real use: "Quit Safari? Say yes to confirm" and "Learn X? Say yes to
  // keep it" were never seen — the user's own words stayed on screen — and
  // both timed out unanswered.
  const m = model({ state: "confirming", transcript: "Close browser fully.", detail: "Quit Safari? Say yes to confirm." });
  assert.equal(hudBody(m), "Quit Safari? Say yes to confirm.");
});

test("how the command went is shown, not the command", () => {
  assert.equal(hudBody(model({ state: "executing", transcript: "open safari", detail: "Opened Safari", result: "ok" })), "Opened Safari");
  assert.equal(hudBody(model({ state: "error", transcript: "click hello", detail: "Couldn't find “Hello” in Safari.", result: "failed" })), "Couldn't find “Hello” in Safari.");
  assert.equal(hudBody(model({ state: "idle", transcript: "play a radio", detail: "Not sure enough", result: "rejected" })), "Not sure enough");
});

test("with nothing to say, the words stay", () => {
  assert.equal(hudBody(model({ state: "confirming", transcript: "quit safari", detail: "" })), "quit safari");
});
