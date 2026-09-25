import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actsEarly,
  completedClauses,
  instantRoute,
  isIncomplete,
  stripLeadingConjunction,
} from "../src/main/actions/realtime.ts";
import { ACTIONS, ACTION_KEYS } from "../src/main/actions/registry.ts";
import type { RouteDecision } from "../src/main/actions/resolve.ts";
import { clauseTail } from "../src/main/actions/split.ts";
import type { ActionContext } from "../src/main/actions/types.ts";

function ctx(extra: Partial<ActionContext> = {}): ActionContext {
  return {
    transcript: "",
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: ["Finder", "Safari", "Telegram"],
    installedApps: ["Safari", "Notes", "ChatGPT", "ChatGPT Classic", "PhpStorm", "App Store", "Maps", "Telegram"],
    automations: [],
    ...extra,
  };
}

function decision(over: Partial<RouteDecision> = {}): RouteDecision {
  return {
    action: "open_app", args: { app: "Safari" }, confidence: 0.98, addressed: 0.9, risk: 0,
    offline: false, ms: 300, inputTokens: 2000, ...over,
  };
}

// --- is the user done? -----------------------------------------------------

test("a pause after a finished command is the end of it", () => {
  for (const t of ["open Safari", "mute", "copy that", "close this", "play", "take a screenshot", "Open Safari."]) {
    assert.equal(isIncomplete(t), false, t);
  }
});

test("a pause mid-sentence is not", () => {
  for (const t of [
    "set the volume to", "open my", "search for", "open", "type", "open the...",
    "open notes,", "open safari and", "switch to", "um", "",
  ]) {
    assert.equal(isIncomplete(t), true, JSON.stringify(t));
  }
});

// --- chains, mid-sentence ----------------------------------------------------

test("a clause followed by more speech is finished", () => {
  assert.deepEqual(completedClauses("open Notes and create a"), ["open Notes"]);
  assert.deepEqual(completedClauses("Open Notes, and create a new note"), ["Open Notes"]);
  assert.deepEqual(completedClauses("mute then take a"), ["mute"]);
  assert.deepEqual(completedClauses("open safari and then go to github and"), ["open safari"]);
});

test("the clause still being said never counts", () => {
  assert.deepEqual(completedClauses("open safari"), []);
  assert.deepEqual(completedClauses("open safari and"), [], "a trailing 'and' is not more speech");
});

test("dictation and searches keep their 'and'", () => {
  assert.deepEqual(completedClauses("type hello and goodbye"), []);
  assert.deepEqual(completedClauses("search for cats and dogs"), []);
});

test("ordinary speech containing 'and' is not a chain", () => {
  assert.deepEqual(completedClauses("well I was thinking about it and it seemed fine"), []);
});

test("an unfinished first clause stops early running", () => {
  assert.deepEqual(completedClauses("set the volume to and then open safari"), []);
});

test("the rest after clauses that already ran is judged as a whole", () => {
  assert.equal(clauseTail("open Notes and type hello and goodbye", 1), "type hello and goodbye");
  assert.equal(clauseTail("open safari, and then go to github", 1), "go to github");
  assert.equal(clauseTail("mute then take a screenshot then lock the screen", 2), "lock the screen");
  assert.equal(clauseTail("open safari", 1), "");
  assert.equal(clauseTail("open safari", 0), "open safari");
});

test("a follow-on said after a pause loses its conjunction", () => {
  assert.equal(stripLeadingConjunction("and then go to GitHub"), "go to GitHub");
  assert.equal(stripLeadingConjunction("And open Safari"), "open Safari");
  assert.equal(stripLeadingConjunction("then mute"), "mute");
  assert.equal(stripLeadingConjunction("android studio"), "android studio", "whole words only");
});

// --- acting before the silence runs out --------------------------------------

test("a confident, complete command acts at the pause", () => {
  assert.equal(actsEarly(decision(), "open safari", 0.55), true);
});

test("anything short of that waits for the silence", () => {
  assert.equal(actsEarly(decision({ confidence: 0.4 }), "open safari", 0.55), false, "unsure");
  assert.equal(actsEarly(decision({ addressed: 0.2 }), "open safari", 0.55), false, "not for us");
  assert.equal(actsEarly(decision({ action: null }), "open safari", 0.55), false, "no command");
  assert.equal(actsEarly(decision({ args: {} }), "open safari", 0.55), false, "slot unresolved");
  assert.equal(actsEarly(decision(), "open safari and", 0.55), false, "sounds unfinished");
});

test("dictation never acts at a pause: the user may be mid-sentence", () => {
  const d = decision({ action: "type_text", args: { text: "dear Sarah" } });
  assert.equal(actsEarly(d, "type dear Sarah", 0.55), false);
  const s = decision({ action: "web_search", args: { query: "pasta" } });
  assert.equal(actsEarly(s, "search for pasta", 0.55), false);
});

// --- the instant path ---------------------------------------------------------

test("'open <an installed app>' needs no model", () => {
  for (const [said, app] of [
    ["Open Safari.", "Safari"],
    ["launch the notes app", "Notes"],
    ["open chat GPT", "ChatGPT"],
    ["open PHP storm", "PhpStorm"],
    ["open app store", "App Store"],
    ["switch to telegram please", "Telegram"],
  ] as const) {
    const d = instantRoute(said, ctx());
    assert.equal(d?.action, "open_app", said);
    assert.equal(d?.args.app, app, said);
    assert.equal(d?.instant, true);
  }
});

test("an exact registry phrasing needs no model either", () => {
  assert.equal(instantRoute("mute", ctx())?.action, "mute");
  assert.equal(instantRoute("Next track.", ctx())?.action, "media_next");
  assert.equal(instantRoute("take a screenshot", ctx())?.action, "screenshot_screen");
  const up = instantRoute("volume up", ctx());
  assert.equal(up?.action, "volume_up");
  assert.equal(typeof up?.args.steps, "number", "number slots are still parsed locally");
  assert.deepEqual(instantRoute("open youtube", ctx())?.args, { url: "youtube.com" });
});

test("a site named alone opens at once, unless an app has that exact name", () => {
  // Observed in real use: "Open Yandex Music" opened Apple's Music app.
  assert.deepEqual(instantRoute("Open Yandex Music.", ctx())?.args, { url: "music.yandex.com" });
  assert.deepEqual(instantRoute("go to the github website", ctx())?.args, { url: "github.com" });
  assert.deepEqual(instantRoute("visit soundcloud", ctx())?.args, { url: "soundcloud.com" });
  assert.equal(instantRoute("open telegram", ctx())?.action, "open_app", "an installed app wins");
  assert.equal(instantRoute("open maps", ctx())?.action, "open_app", "so does the Maps app");
  assert.equal(instantRoute("open apple music", ctx()), null, "Apple Music is the Music app, not a site");
  assert.equal(instantRoute("open the yandex music app", ctx()), null, "asked for as an app: Jev decides");
});

test("a settings page named by itself opens at once, said to Settings or said as settings", () => {
  const inSettings = ctx({ focusedApp: "System Settings" });
  assert.deepEqual(instantRoute("Go to battery.", inSettings)?.args, { pane: "Battery" });
  assert.deepEqual(instantRoute("go to wi-fi", inSettings)?.args, { pane: "Wi-Fi" });
  assert.deepEqual(instantRoute("open the battery settings", ctx())?.args, { pane: "Battery" });
  assert.deepEqual(instantRoute("open privacy and security settings", ctx())?.args, { pane: "Privacy & Security" });
  assert.deepEqual(instantRoute("open mission control settings", ctx())?.args, { pane: "Desktop & Dock" });
  // Elsewhere these name other things too: the model reads them.
  for (const said of ["go to battery", "go to desktop", "open spotlight", "open notifications"]) {
    assert.equal(instantRoute(said, ctx()), null, said);
  }
  // An exact phrasing of another command still means that command.
  assert.equal(instantRoute("show desktop", inSettings)?.action, "show_desktop");
});

test("a question about what just went wrong is answered from memory, with no model", () => {
  const failed = ctx({ history: [{ said: "close notepad", outcome: "failed", detail: "Accessibility permission is needed to press keys and buttons.", at: Date.now() }] });
  for (const said of ["Which permission do you need?", "what permission you need", "why didn't that work", "What happened?"]) {
    assert.equal(instantRoute(said, failed)?.action, "explain_last", said);
  }
  // With nothing gone wrong there is nothing to explain: the model reads it.
  assert.equal(instantRoute("what permission you need", ctx()), null);
});

test("anything inexact, unknown or destructive still goes to Jev", () => {
  for (const said of [
    "open the browser", // a description, not a name
    "open photoshop", // not installed
    "open codex", // not an app here
    "empty the trash", // destructive
    "quit safari", // destructive
    "please could you mute the sound for me", // not exact
    "open safari and mute", // a chain
  ]) {
    assert.equal(instantRoute(said, ctx()), null, said);
  }
});

test("no example phrasing is claimed by two actions", () => {
  // If one were, the instant path would have to guess between them.
  const seen = new Map<string, string>();
  for (const key of ACTION_KEYS) {
    for (const ex of ACTIONS[key].examples) {
      const k = ex.toLowerCase();
      assert.ok(!seen.has(k) || seen.get(k) === key, `"${ex}" is an example of both ${seen.get(k)} and ${key}`);
      seen.set(k, key);
    }
  }
});

test("without the wake word, speech must be clearly meant for the agent", async () => {
  const { actsEarly, ADDRESSED_MIN, FOLLOWUP_ADDRESSED_MIN } = await import("../src/main/actions/realtime.ts");
  // From real use: a video playing nearby, heard in an open conversation,
  // scored 0.48 and opened System Settings.
  const d = {
    action: "open_settings" as const, args: { pane: "System Settings" }, confidence: 0.74,
    addressed: 0.48, risk: 0, offline: false, ms: 0, inputTokens: 0,
  };
  assert.equal(actsEarly(d, "open settings", 0.55, ADDRESSED_MIN), true, "with the wake word: fine");
  assert.equal(actsEarly(d, "open settings", 0.55, FOLLOWUP_ADDRESSED_MIN), false, "without it: not enough");
});

test("a choice the words settle needs no network either", async () => {
  // From real use: on a slow network, "open settings" failed with "Jev did not
  // answer" — though the words alone say which settings.
  const { instantRoute } = await import("../src/main/actions/realtime.ts");
  const c = (t: string) => ({
    transcript: t, focusedApp: "Finder", windowTitle: "", runningApps: ["Finder"],
    installedApps: ["Safari"], automations: ["Morning Routine", "Backup"],
  });
  assert.deepEqual(instantRoute("open settings", c("open settings"))?.args, { pane: "System Settings" });
  assert.deepEqual(instantRoute("open bluetooth settings", c("open bluetooth settings"))?.args, { pane: "Bluetooth" });
  assert.deepEqual(instantRoute("snap this left", c("snap this left"))?.args, { side: "left" });
  assert.equal(instantRoute("run my shortcut", c("run my shortcut")), null, "two Shortcuts: still a question");
});
