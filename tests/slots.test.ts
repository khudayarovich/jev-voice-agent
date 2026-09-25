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

test("an app never opened is still offered, and described", async () => {
  // From real use: "open selfie camera" opened FaceTime, because the list sent
  // was the 80 most recently used apps and Photo Booth had never been opened.
  const many = Array.from({ length: 150 }, (_, i) => `App ${i}`);
  const c = ctx("open selfie camera", { installedApps: [...many, "FaceTime", "Photo Booth"] });
  const plan = await planSlots(c);
  const q = plan.questions.get(APP_QUESTION);
  assert.ok(q?.candidates.includes("Photo Booth"), "Photo Booth must be a choice");
  assert.match(q?.notes?.["Photo Booth"] ?? "", /camera/i);
  assert.ok(q && q.candidates.length <= 240, "fits in a Choice");
});

test("browsers are told apart by which is default, open, or just used", async () => {
  const c = ctx("open my browser", {
    runningApps: ["Finder", "Google Chrome"],
    installedApps: ["Safari", "Google Chrome"],
    defaultBrowser: "Safari",
    lastBrowser: "Google Chrome",
  });
  const q = (await planSlots(c)).questions.get(APP_QUESTION);
  assert.match(q?.notes?.Safari ?? "", /default browser/);
  assert.match(q?.notes?.["Google Chrome"] ?? "", /just used/);
});

test("'all the browsers' is offered only when asked for, and when there are several", async () => {
  const two = { runningApps: ["Finder", "Safari", "Google Chrome"], installedApps: ["Safari", "Google Chrome"] };
  const all = (await planSlots(ctx("close all browsers", two))).questions.get(APP_QUESTION);
  assert.equal(all?.candidates[0], "Every open web browser");
  assert.match(all?.notes?.["Every open web browser"] ?? "", /Safari and Google Chrome/);

  const one = (await planSlots(ctx("close the browser", two))).questions.get(APP_QUESTION);
  assert.ok(!one?.candidates.includes("Every open web browser"));
});

test("quitting every browser is allowed although the group is not an app", async () => {
  const c = ctx("quit all browsers", { runningApps: ["Safari", "Google Chrome"] });
  const plan = await planSlots(c);
  const read = readSlots("quit_app", { [APP_QUESTION]: { choice: "Every open web browser", confidence: 0.9 } }, plan, c);
  assert.deepEqual(read.args, { app: "Every open web browser" });
  assert.equal(read.notRunning, undefined);
});

test("an unsure app answer reports its confidence and the runner-up", async () => {
  const c = ctx("open the camera");
  const plan = await planSlots(c);
  const read = readSlots(
    "open_app",
    { [APP_QUESTION]: { choice: "Photoshop", confidence: 0.3, probabilities: { Photoshop: 0.3, Safari: 0.25, none: 0.4 } } },
    plan,
    c,
  );
  assert.equal(read.confidence, 0.3);
  assert.equal(read.alternative, "Safari", "never 'none'");
});

test("an app said outright is certain", async () => {
  const read = readSlots("open_app", {}, await planSlots(ctx("open Claude")), ctx("open Claude"));
  assert.equal(read.confidence, 1);
});

test("'the browser' follows the rule, whatever the model leaned towards", async () => {
  // Measured: with only Chrome open, the model split 51/49 between Chrome and
  // the default Safari. The one open is the one meant.
  const c = ctx("open the browser", {
    runningApps: ["Finder", "Google Chrome"],
    installedApps: ["Safari", "Google Chrome"],
    defaultBrowser: "Safari",
  });
  const plan = await planSlots(c);
  const read = readSlots("open_app", { [APP_QUESTION]: { choice: "Safari", confidence: 0.51 } }, plan, c);
  assert.deepEqual(read.args, { app: "Google Chrome" });
  assert.equal(read.confidence, 1, "a rule, so nothing to ask");
});

test("a browser named outright is left alone", async () => {
  const c = ctx("open the chrome browser", {
    runningApps: ["Finder", "Safari"],
    installedApps: ["Safari", "Google Chrome"],
    defaultBrowser: "Safari",
  });
  const plan = await planSlots(c);
  const read = readSlots("open_app", { [APP_QUESTION]: { choice: "Google Chrome", confidence: 0.9 } }, plan, c);
  assert.deepEqual(read.args, { app: "Google Chrome" });
});

test("an app counts as named only when the words name all of it", async () => {
  // From real use: "open Yandex Music" opened Apple's Music, at 0.99 — the
  // name "Music" was in the words, and taken for the whole of them.
  const { namesExactly } = await import("../src/main/actions/parse.ts");
  assert.equal(namesExactly("open yandex music", "Music"), false);
  assert.equal(namesExactly("open music", "Music"), true);
  assert.equal(namesExactly("open the music app please", "Music"), true);
  assert.equal(namesExactly("open vs code", "VSCode"), true);
  const plan = await planSlots(ctx("open yandex music", { installedApps: ["Music", "Safari"] }));
  assert.ok(!plan.resolved.has(APP_QUESTION), "asked, not assumed");
});
