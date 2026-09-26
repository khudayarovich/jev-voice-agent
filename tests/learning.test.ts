import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "../src/main/actions/execute.ts";
import { instantRoute } from "../src/main/actions/realtime.ts";
import type { ActionContext } from "../src/main/actions/types.ts";
import { lessonChecks } from "../src/main/learning/catalog.ts";
import {
  type LearnedCommand,
  checkLesson,
  normalizeCombo,
  parameterValue,
  summarize,
  withValue,
} from "../src/main/learning/lesson.ts";
import { lessonMessages } from "../src/main/learning/prompt.ts";
import { runLearned, toKeyCombo } from "../src/main/learning/run.ts";
import type { PlatformAdapter } from "../src/main/platform/types.ts";

/**
 * Learning a command from a language model. What it may return is the whole
 * question: a composition of the agent's own steps, checked against this Mac,
 * and never a script.
 */

function ctx(transcript: string, extra: Partial<ActionContext> = {}): ActionContext {
  return {
    transcript,
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: ["Finder", "Safari"],
    installedApps: ["Safari", "Notes", "Slack", "Terminal", "Google Chrome"],
    automations: ["Morning Routine"],
    ...extra,
  };
}

/** A step as the model sends it: every field present, the unused ones null. */
function step(fields: Record<string, unknown>) {
  return { do: null, action: null, args: null, app: null, combo: null, path: null, url: null, text: null, target: null, ms: null, ...fields };
}

function answer(command: Record<string, unknown>) {
  return {
    possible: true,
    reason: "",
    command: { id: "x", title: "X", describe: "Does x.", examples: [], parameter: null, steps: [], ...command },
  };
}

const about = { request: "open a new finder window", model: "openai/gpt-6-luna", now: new Date("2026-09-25T12:00:00Z") };

async function checks(c = ctx("")) {
  return lessonChecks(c, []);
}

test("accepts a command made of the agent's own steps", async () => {
  const r = checkLesson(
    answer({
      id: "New Finder Window",
      title: "New Finder window",
      describe: "Open a new Finder window.",
      examples: ["new finder window", "open another finder window"],
      steps: [step({ do: "keys", app: "Finder", combo: "Command+N" })],
    }),
    await checks(),
    about,
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.command.id, "new_finder_window");
  assert.deepEqual(r.command.steps, [{ do: "keys", combo: "cmd+n", app: "Finder" }]);
  assert.equal(r.command.confirm, false);
  assert.equal(r.command.examples[0], "open a new finder window", "the request itself is always an example");
  assert.equal(r.command.learnedAt, "2026-09-25T12:00:00.000Z");
});

test("a built-in command as a step: checked against its own arguments", async () => {
  const c = await checks();
  const good = checkLesson(
    answer({
      steps: [
        step({ do: "action", action: "open_app", args: [{ name: "app", value: "slack" }] }),
        step({ do: "action", action: "set_volume", args: [{ name: "level", value: "20" }] }),
        step({ do: "action", action: "open_settings", args: [{ name: "pane", value: "Bluetooth" }] }),
      ],
    }),
    c,
    about,
  );
  assert.ok(good.ok, JSON.stringify(good));

  for (const [bad, why] of [
    [step({ do: "action", action: "open_app", args: [{ name: "app", value: "Photoshop" }] }), /not an app/],
    [step({ do: "action", action: "set_volume", args: [{ name: "level", value: "loud" }] }), /number/],
    [step({ do: "action", action: "delete_everything", args: [] }), /not a command/],
    [step({ do: "action", action: "run_learned", args: [{ name: "command", value: "x" }] }), /cannot run another/],
    [step({ do: "action", action: "open_app", args: [] }), /needs its app/],
  ] as const) {
    const r = checkLesson(answer({ steps: [bad] }), c, about);
    assert.ok(!r.ok, JSON.stringify(bad));
    assert.match(r.reason, why);
  }
});

test("refuses what it will not learn", async () => {
  const c = await checks();
  const refusals: [unknown, RegExp][] = [
    [{ possible: false, reason: "That needs a shell command.", command: null }, /shell command/],
    [answer({ steps: [] }), /no steps/],
    [answer({ steps: [step({ do: "shell", text: "rm -rf ~" })] }), /not a step/],
    [answer({ steps: [step({ do: "keys", combo: "cmd+q" })] }), /not a shortcut to learn/],
    [answer({ steps: [step({ do: "keys", combo: "⌘⇧Q" })] }), /not a shortcut to learn/],
    [answer({ steps: [step({ do: "keys", combo: "cmd+banana" })] }), /not a key combination/],
    [answer({ steps: [step({ do: "keys", app: "Photoshop", combo: "cmd+n" })] }), /not an app on this Mac/],
    [answer({ steps: [step({ do: "open_url", url: "javascript:alert(1)" })] }), /http or https/],
    [answer({ steps: [step({ do: "open_url", url: "file:///etc/passwd" })] }), /http or https/],
    [answer({ steps: [step({ do: "wait", ms: 60000 })] }), /between 0 and 3 seconds/],
    [answer({ steps: [step({ do: "menu", path: ["File"] })] }), /a menu and an item/],
    [answer({ steps: Array.from({ length: 13 }, () => step({ do: "wait", ms: 100 })) }), /too many steps/],
    [answer({ steps: [step({ do: "type", text: "{value}" })] }), /never asks for/],
  ];
  for (const [a, why] of refusals) {
    const r = checkLesson(a, c, about);
    assert.ok(!r.ok, JSON.stringify(a));
    assert.match(r.reason, why);
  }
});

test("anything destructive makes the command ask every time", async () => {
  const c = await checks();
  for (const s of [
    step({ do: "menu", app: "Finder", path: ["Finder", "Empty Trash…"] }),
    step({ do: "click", target: "Delete account" }),
    step({ do: "action", action: "quit_app", args: [{ name: "app", value: "Safari" }] }),
  ]) {
    const r = checkLesson(answer({ steps: [s] }), c, about);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.command.confirm, true, JSON.stringify(s));
  }
});

test("a command that takes a value hears it, and fills it in", async () => {
  const r = checkLesson(
    answer({
      id: "search_amazon",
      title: "Search Amazon",
      describe: "Search Amazon for a product.",
      examples: ["search amazon for headphones"],
      parameter: { name: "product", describe: "What to search for", leads: ["search amazon for", "find on amazon"] },
      steps: [step({ do: "open_url", url: "https://www.amazon.com/s?k={value}" })],
    }),
    await checks(),
    { ...about, request: "search amazon for headphones" },
  );
  assert.ok(r.ok, JSON.stringify(r));
  const value = parameterValue(r.command, "search amazon for noise cancelling headphones");
  assert.equal(value, "noise cancelling headphones");
  assert.deepEqual(withValue(r.command.steps[0]!, value), {
    do: "open_url",
    url: "https://www.amazon.com/s?k=noise%20cancelling%20headphones",
  });
});

test("a new id never collides with a command that exists", async () => {
  const c = await lessonChecks(ctx(""), ["search_amazon"]);
  const r = checkLesson(answer({ id: "search_amazon", steps: [step({ do: "wait", ms: 10 })] }), c, about);
  assert.ok(r.ok);
  assert.equal(r.command.id, "search_amazon_2");
  const builtIn = checkLesson(answer({ id: "open_app", steps: [step({ do: "wait", ms: 10 })] }), c, about);
  assert.ok(builtIn.ok);
  assert.notEqual(builtIn.command.id, "open_app");
});

test("says what a command does, short enough for the overlay", () => {
  const cmd = { steps: [{ do: "action", action: "open_app", args: { app: "Slack" } }, { do: "keys", combo: "cmd+k" }, { do: "type", text: "general" }] } as LearnedCommand;
  assert.equal(summarize(cmd), 'Open app Slack, then press ⌘K, then type "general"');
});

test("reads shortcuts however they are written", () => {
  assert.equal(normalizeCombo("Command+Shift+N"), "shift+cmd+n");
  assert.equal(normalizeCombo("cmd-shift-n"), "shift+cmd+n");
  assert.equal(normalizeCombo("cmd+-"), "cmd+-");
  assert.equal(normalizeCombo("cmd++"), "cmd+=");
  assert.deepEqual(toKeyCombo("shift+cmd+n"), { key: "n", modifiers: ["shift", "command"] });
  assert.deepEqual(toKeyCombo("cmd+-"), { key: "-", modifiers: ["command"] });
});

test("the teacher is told the rules, the commands, and nothing from the screen", () => {
  const [system, user] = lessonMessages({
    request: "open a new finder window",
    catalog: "- open_app(app: an app from the list): Launch an application.",
    apps: ["Finder", "Safari"],
    shortcuts: [],
    focusedApp: "Finder",
  });
  assert.match(system!.content, /cannot write code/i);
  assert.match(system!.content, /open_app\(app: an app from the list\)/);
  assert.match(system!.content, /Apps on this Mac: Finder, Safari/);
  assert.doesNotMatch(system!.content, /window title/i);
  assert.equal(user!.content, 'The user said: "open a new finder window"');
});

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

function recorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const os = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "platform") return "darwin";
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        if (prop === "waitForFrontmost") return Promise.resolve(true);
        return Promise.resolve();
      };
    },
  }) as unknown as PlatformAdapter;
  return { calls, os };
}

const NEW_FOLDER: LearnedCommand = {
  id: "new_folder",
  title: "New folder",
  describe: "Make a new folder in the Finder window in front.",
  examples: ["make a new folder", "create a folder"],
  parameter: null,
  steps: [{ do: "menu", app: "Finder", path: ["File", "New Folder"] }],
  confirm: false,
  learnedFrom: "make a new folder",
  learnedAt: "2026-09-25T12:00:00.000Z",
  model: "openai/gpt-6-luna",
  uses: 3,
};

test("runs each step through the agent's own machinery", async () => {
  const { calls, os } = recorder();
  const ran: string[] = [];
  await runLearned(
    {
      ...NEW_FOLDER,
      parameter: { name: "name", describe: "", leads: ["called"] },
      steps: [
        { do: "action", action: "open_app", args: { app: "Finder" } },
        { do: "keys", app: "Finder", combo: "shift+cmd+n" },
        { do: "type", text: "{value}" },
        { do: "open_url", url: "https://example.com/?q={value}" },
      ],
    },
    "Invoices 2026",
    { os, runAction: async (a, args) => void ran.push(`${a}:${args.app}`), openUrl: async (u) => void ran.push(u) },
  );
  assert.deepEqual(ran, ["open_app:Finder", "https://example.com/?q=Invoices%202026"]);
  assert.deepEqual(
    calls.filter((c) => c.method !== "waitForFrontmost" && c.method !== "frontApp").map((c) => c.method),
    ["openApp", "keystroke", "typeText"],
  );
  assert.deepEqual(calls.find((c) => c.method === "typeText")?.args, ["Invoices 2026"]);
});

test("a learned command runs as a command, and is instant when said as taught", async () => {
  const c = ctx("make a new folder", { learned: [NEW_FOLDER] });
  const d = instantRoute("make a new folder", c);
  assert.equal(d?.action, "run_learned");
  assert.deepEqual(d?.args, { command: "new_folder" });

  const { calls, os } = recorder();
  const r = await execute("run_learned", { command: "new_folder" }, os, c);
  assert.equal(r.detail, "New folder");
  assert.deepEqual(calls.at(-1), { method: "chooseMenuItem", args: [["File", "New Folder"]] });
});

test("a learned command that has since been forgotten does not run", async () => {
  const { os } = recorder();
  await assert.rejects(execute("run_learned", { command: "new_folder" }, os, ctx("make a new folder")), /don't know/);
});

test("never learns its way into a shell", async () => {
  // Each step allowed on its own; together, a shell command run.
  const c = await checks(ctx("", { installedApps: ["Terminal", "Script Editor", "Safari"] }));
  for (const steps of [
    [step({ do: "action", action: "open_app", args: [{ name: "app", value: "Terminal" }] }), step({ do: "type", text: "rm -rf ~" })],
    [step({ do: "keys", app: "Script Editor", combo: "cmd+r" })],
    [step({ do: "menu", app: "Terminal", path: ["Shell", "New Window"] })],
  ]) {
    const r = checkLesson(answer({ steps }), c, about);
    assert.ok(!r.ok, JSON.stringify(steps));
    assert.match(r.reason, /not something I learn/);
  }
});

test("a learned command will not type while a shell is in front", async () => {
  const calls: string[] = [];
  const os = new Proxy({}, {
    get(_t, prop: string) {
      return (...args: unknown[]) => {
        calls.push(prop);
        if (prop === "frontApp") return Promise.resolve("Terminal");
        return Promise.resolve(args.length ? undefined : undefined);
      };
    },
  }) as unknown as PlatformAdapter;
  await assert.rejects(
    runLearned({ ...NEW_FOLDER, steps: [{ do: "type", text: "rm -rf ~" }, { do: "keys", combo: "return" }] }, null, {
      os, runAction: async () => {}, openUrl: async () => {},
    }),
    /won't type into Terminal/,
  );
  assert.ok(!calls.includes("typeText"), "nothing was typed");
});

test("an element step points into the screen as listed, and is never kept", async () => {
  const { checkLesson, usesScreen } = await import("../src/main/learning/lesson.ts");
  const checks = {
    apps: ["Finder"], takenIds: new Set<string>(), isDestructive: () => false, checkAction: () => null,
    screen: [{ role: "Row", label: "FASHUZ Connected" }, { role: "Button", label: "Details…" }, { role: "Button", label: "Delete network" }],
  };
  const step = { do: "element", index: 1, how: "press", action: null, args: null, app: null, combo: null, path: null, url: null, text: null, target: null, ms: null };
  const answer = { possible: true, reason: "", command: { id: "wifi_details", title: "Details of the connected Wi‑Fi", describe: "Opens the details of the connected network.", examples: [], parameter: null, steps: [step] } };
  const r = checkLesson(answer, checks, { request: "open details of the connected wifi", model: "m" });
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.command.steps[0], { do: "element", index: 1, how: "press", label: "Details…" });
    assert.equal(usesScreen(r.command), true);
    assert.equal(r.command.confirm, false);
  }
  // A step at nothing, and a step at something destructive.
  const gone = checkLesson({ ...answer, command: { ...answer.command, steps: [{ ...step, index: 9 }] } }, checks, { request: "x", model: "m" });
  assert.equal(gone.ok, false);
  const risky = checkLesson({ ...answer, command: { ...answer.command, steps: [{ ...step, index: 2 }] } }, checks, { request: "x", model: "m" });
  assert.ok(risky.ok && risky.command.confirm);
});
