import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfirmation } from "../src/main/actions/execute.ts";
import { ACTIONS, ACTION_KEYS, UNKNOWN_TASK, choiceCriteria } from "../src/main/actions/registry.ts";
import { rankActions } from "../src/main/actions/rank.ts";

// --- registry integrity ----------------------------------------------------

test("every action has a description and at least one example", () => {
  for (const key of ACTION_KEYS) {
    const a = ACTIONS[key];
    assert.ok(a.describe.length > 20, `${key} needs a real description for the model`);
    assert.ok(a.examples.length > 0, `${key} has no example phrasings`);
    assert.ok(typeof a.run === "function", `${key} has no handler`);
  }
});

test("the registry fits inside a Jev Choice question", () => {
  // Documented hard limit: a Choice takes at most 255 options.
  assert.ok(ACTION_KEYS.length <= 255, `${ACTION_KEYS.length} actions exceeds the Choice limit`);
});

test("criteria keys are the registry's commands, the learned ones, and 'none of these'", () => {
  // This is the contract that makes the model's answer safe to dispatch on:
  // it can only ever return one of these keys.
  const builtIn = ACTION_KEYS.filter((k) => k !== "run_learned");
  assert.deepEqual(Object.keys(choiceCriteria()).sort(), [...builtIn, UNKNOWN_TASK].sort());
  const withLearned = choiceCriteria([{ id: "new_folder", describe: "Make a new folder in Finder." }]);
  assert.equal(withLearned["learned:new_folder"], "Make a new folder in Finder.");
  assert.ok(!("run_learned" in withLearned), "learned commands are offered one by one, not as a group");
});

test("descriptions are distinct, so the model has something to separate them by", () => {
  const seen = new Map<string, string>();
  for (const key of ACTION_KEYS) {
    const d = ACTIONS[key].describe;
    assert.ok(!seen.has(d), `${key} and ${seen.get(d)} share a description`);
    seen.set(d, key);
  }
});

test("destructive actions are the ones that actually destroy something", () => {
  const destructive = ACTION_KEYS.filter((k) => ACTIONS[k].destructive);
  for (const k of ["empty_trash", "quit_app", "sleep_system"] as const) {
    assert.ok(destructive.includes(k), `${k} must require confirmation`);
  }
  // And harmless ones must NOT be, or every command turns into an interrogation.
  for (const k of ["open_app", "set_volume", "copy"] as const) {
    assert.ok(!destructive.includes(k), `${k} should not require confirmation`);
  }
});

// --- local ranking ---------------------------------------------------------

test("ranks the obvious command first", () => {
  assert.equal(rankActions("open safari")[0], "open_app");
  assert.equal(rankActions("set volume to thirty percent")[0], "set_volume");
  assert.equal(rankActions("empty the trash")[0], "empty_trash");
  assert.equal(rankActions("take a screenshot")[0], "screenshot_screen");
});

test("ranking returns nothing when no command words appear at all", () => {
  assert.deepEqual(rankActions("hmm interesting thanks anyway"), []);
});

test("ranking is permissive by design, and is not the gate on non-commands", () => {
  // It only decides which actions get speculative slot questions, so a false
  // positive costs one extra parallel question and nothing else. What actually
  // rejects "not a command" is Jev's `addressed` noul, checked in the agent.
  const ranked = rankActions("what do you think about the weather today");
  assert.ok(ranked.length <= 2, `should not fan out widely, got ${ranked.join()}`);
});

test("ranking is bounded, so speculative questions stay cheap", () => {
  assert.ok(rankActions("open safari", 3).length <= 3);
});

// --- confirmations ---------------------------------------------------------

test("reads a spoken yes", () => {
  for (const s of ["yes", "Yeah", "yep", "sure", "ok", "go ahead", "do it", "Confirm."]) {
    assert.equal(readConfirmation(s), "yes", s);
  }
});

test("reads a spoken no", () => {
  for (const s of ["no", "nope", "cancel", "never mind", "stop", "don't"]) {
    assert.equal(readConfirmation(s), "no", s);
  }
});

test("anything ambiguous is NOT treated as consent", () => {
  // The caller treats "unclear" as a refusal, which is the safe default for a
  // destructive action.
  for (const s of ["open safari", "", "   ", "hmm", "what"]) {
    assert.notEqual(readConfirmation(s), "yes", s);
  }
});
