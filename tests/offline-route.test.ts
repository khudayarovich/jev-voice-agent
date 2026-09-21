import assert from "node:assert/strict";
import { test } from "node:test";
import { execute } from "../src/main/actions/execute.ts";
import { offlineRoute } from "../src/main/actions/resolve.ts";
import type { ActionContext } from "../src/main/actions/types.ts";
import type { PlatformAdapter } from "../src/main/platform/types.ts";

/**
 * Transcript in, executed action out — with no Electron, no network, and no
 * microphone. This covers the whole decision path that the acoustic tests
 * cannot isolate.
 */

const INSTALLED = ["Safari", "Mail", "Terminal", "Music", "Visual Studio Code", "Slack"];

function ctx(transcript: string, extra: Partial<ActionContext> = {}): ActionContext {
  return {
    transcript,
    focusedApp: "Finder",
    windowTitle: "",
    runningApps: ["Finder", "Safari"],
    installedApps: INSTALLED,
    automations: ["Morning Routine"],
    ...extra,
  };
}

/** Records what the OS was asked to do instead of doing it. */
function recorder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "platform") return "darwin";
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        if (prop === "getVolume") return Promise.resolve(50);
        if (prop === "screenshot") return Promise.resolve("/tmp/shot.png");
        return Promise.resolve();
      };
    },
  };
  return { calls, os: new Proxy({}, handler) as unknown as PlatformAdapter };
}

test("routes and executes a volume command, parsing the number in code", async () => {
  const d = offlineRoute(ctx("set volume to twenty percent"));
  assert.equal(d.action, "set_volume");
  assert.equal(d.args.level, 20, "the number must be parsed locally, not by the model");

  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, ctx("set volume to twenty percent"));
  assert.deepEqual(calls, [{ method: "setVolume", args: [20] }]);
});

test("routes and executes an app command, choosing from installed apps only", async () => {
  const d = offlineRoute(ctx("open safari"));
  assert.equal(d.action, "open_app");
  assert.equal(d.args.app, "Safari", "must be the real installed name, not the spoken one");

  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, ctx("open safari"));
  assert.deepEqual(calls, [{ method: "openApp", args: ["Safari"] }]);
});

test("cannot invent an app that is not installed", () => {
  const d = offlineRoute(ctx("open photoshop"));
  // It may still guess the intent, but the slot must be unresolved rather than
  // fabricated — the model only ever selects from the enumerated list.
  assert.notEqual(d.args.app, "Photoshop");
  assert.ok(d.reason?.includes("app"), `expected an unresolved slot, got ${JSON.stringify(d)}`);
});

test("marks destructive actions as high risk so the agent asks first", () => {
  const d = offlineRoute(ctx("empty the trash"));
  assert.equal(d.action, "empty_trash");
  assert.ok(d.risk >= 2.5, "emptying the Trash must trigger a confirmation");
});

test("lifts free text verbatim rather than generating it", async () => {
  const phrase = "search for typescript generics";
  const d = offlineRoute(ctx(phrase));
  assert.equal(d.action, "web_search");
  assert.equal(d.args.query, "typescript generics");

  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, ctx(phrase));
  assert.deepEqual(calls, [{ method: "webSearch", args: ["typescript generics"] }]);
});

test("dictation types exactly what was said", async () => {
  const phrase = "type Hello there, friend";
  const d = offlineRoute(ctx(phrase));
  assert.equal(d.action, "type_text");
  assert.equal(d.args.text, "Hello there, friend");

  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, ctx(phrase));
  assert.deepEqual(calls, [{ method: "typeText", args: ["Hello there, friend"] }]);
});

test("falls back to a slot default rather than failing", async () => {
  const d = offlineRoute(ctx("turn it up"));
  assert.equal(d.action, "volume_up");
  assert.equal(typeof d.args.steps, "number");
  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, ctx("turn it up"));
  assert.equal(calls.at(-1)?.method, "setVolume");
});

test("reports no action when nothing matches, instead of guessing", () => {
  const d = offlineRoute(ctx("mmm hmm okay then"));
  assert.equal(d.action, null);
  assert.equal(d.confidence, 0);
});

test("offline decisions are flagged as offline and cost nothing", () => {
  const d = offlineRoute(ctx("open safari"));
  assert.equal(d.offline, true);
  assert.equal(d.inputTokens, 0);
});

test("offline confidence stays below a confident threshold", () => {
  // The local matcher is blunt, and must not claim certainty the model would.
  const d = offlineRoute(ctx("open safari"));
  assert.ok(d.confidence < 0.8, `offline confidence was ${d.confidence}`);
});
