import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_QUESTION, appUniverse, planSlots, readSlots } from "../src/main/actions/slots.ts";
import type { ActionContext } from "../src/main/actions/types.ts";

/**
 * Which slot questions ride along with the routing request.
 *
 * The regression this guards: "open Claude" named exactly one app, so no app
 * question was asked — and then, with nothing asked, the slot counted as
 * missing and a SECOND round trip went out to ask about the one candidate.
 * Real use measured 1.85 s for that command, most of it the second request.
 */

function ctx(transcript: string, extra: Partial<ActionContext> = {}): ActionContext {
  return {
    transcript,
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: ["Finder", "Safari", "Telegram"],
    installedApps: ["Claude", "ChatGPT", "ChatGPT Classic", "OpenCode", "Safari", "Telegram", "Photoshop"],
    automations: ["Morning Routine", "Backup"],
    ...extra,
  };
}

test("an app said verbatim, and alone, is simply the answer", async () => {
  const plan = await planSlots(ctx("open Claude"));
  assert.equal(plan.resolved.get(APP_QUESTION), "Claude");
  assert.ok(!plan.questions.has(APP_QUESTION), "nothing left to ask");
  const read = readSlots("open_app", {}, plan, ctx("open Claude"));
  assert.deepEqual(read.args, { app: "Claude" });
  assert.deepEqual(read.unasked, [], "so no second round trip");
});

test("several plausible apps become one question in the same request", async () => {
  const plan = await planSlots(ctx("open chatgpt"));
  const q = plan.questions.get(APP_QUESTION);
  assert.ok(q, "asked");
  assert.ok(q.candidates.includes("ChatGPT") && q.candidates.includes("ChatGPT Classic"));
});

test("the one app question serves every app-naming command", async () => {
  // Jev may pick hide_app where the local ranker guessed open_app: the answer
  // is still there, because it is shared.
  const plan = await planSlots(ctx("safari go away"));
  const answers = { [APP_QUESTION]: { choice: "Safari" } };
  for (const action of ["open_app", "quit_app", "hide_app", "close_app_window"] as const) {
    const read = readSlots(action, answers, plan, ctx("safari go away"));
    assert.deepEqual(read.args, { app: "Safari" }, action);
    assert.deepEqual(read.unasked, [], action);
  }
});

test("a described app gets the whole list to choose from", async () => {
  const plan = await planSlots(ctx("open the browser"));
  const q = plan.questions.get(APP_QUESTION);
  assert.ok(q, "asked even though nothing was named");
  assert.ok(q.candidates.length >= 5, "offered a real list, not nothing");
  assert.equal(q.candidates[0], "Finder", "running apps first");
});

test("'none of these' is an answer, not a reason to ask again", async () => {
  const plan = await planSlots(ctx("open the browser"));
  const read = readSlots("open_app", { [APP_QUESTION]: { choice: "none" } }, plan, ctx("open the browser"));
  assert.deepEqual(read.unresolved, ["app"]);
  assert.deepEqual(read.unasked, []);
});

test("quitting an app that is not running is refused, not launched first", async () => {
  // `tell application "Photoshop" to quit` launches Photoshop in order to quit it.
  const c = ctx("quit photoshop");
  const plan = await planSlots(c);
  const read = readSlots("quit_app", { [APP_QUESTION]: { choice: "Photoshop" } }, plan, c);
  assert.equal(read.notRunning, "Photoshop");
  assert.deepEqual(read.args, {});
});

test("an unnamed Shortcut is asked about, never assumed", async () => {
  const c = ctx("run my shortcut", { automations: ["Backup"] });
  const plan = await planSlots(c);
  assert.ok(
    ![...plan.resolved.values()].includes("Backup"),
    "the only Shortcut must not run just because it is the only one",
  );
});

test("a side the user said is resolved without asking", async () => {
  const plan = await planSlots(ctx("snap this window to the right"));
  assert.equal(plan.resolved.get("slot_tile_window_side"), "right");
});

test("the app universe puts running apps first and has no duplicates", () => {
  const u = appUniverse(ctx(""));
  assert.deepEqual(u.slice(0, 3), ["Finder", "Safari", "Telegram"]);
  assert.equal(new Set(u).size, u.length);
});
