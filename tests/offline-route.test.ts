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

/**
 * Records what the OS was asked to do instead of doing it. `answers` stands in
 * for what the OS would say back: the front tab of a browser, say.
 */
function recorder(answers: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "platform") return "darwin";
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        if (prop in answers) return Promise.resolve(answers[prop]);
        if (prop === "getVolume") return Promise.resolve(50);
        if (prop === "screenshot") return Promise.resolve("/tmp/shot.png");
        if (prop === "click") return Promise.resolve({ label: "YouTube", url: "https://www.youtube.com/" });
        return Promise.resolve();
      };
    },
  };
  return { calls, os: new Proxy({}, handler) as unknown as PlatformAdapter };
}

const CHROME_OPEN = { focusedApp: "Google Chrome", runningApps: ["Finder", "Safari", "Google Chrome"], defaultBrowser: "Safari" };

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
  // In the browser already open, rather than launching the default one.
  assert.deepEqual(calls.at(-1), {
    method: "browse",
    args: ["https://www.google.com/search?q=typescript%20generics", "Safari", "new-tab"],
  });
});

test("a search opens in the browser the user is looking at", async () => {
  // Observed in real use: "open my browser" opened Chrome, and the search
  // after it opened in Safari, the default — a second browser.
  const phrase = "search for youtube";
  const c = ctx(phrase, CHROME_OPEN);
  const d = offlineRoute(c);
  assert.equal(d.action, "web_search");
  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, c);
  assert.deepEqual(calls.at(-1), { method: "browse", args: ["https://www.google.com/search?q=youtube", "Google Chrome", "new-tab"] });
});

test("a search goes into the empty tab the browser just opened", async () => {
  const c = ctx("search for youtube", CHROME_OPEN);
  const { calls, os } = recorder({ browserTab: { url: "chrome://new-tab-page/", title: "New Tab" } });
  await execute("web_search", { query: "youtube" }, os, c);
  assert.deepEqual(calls.at(-1), { method: "browse", args: ["https://www.google.com/search?q=youtube", "Google Chrome", "current"] });
});

test("opening a site from a page of results goes there in the same tab", async () => {
  // From real use: "open YouTube" on the results of "search for YouTube" opened
  // a whole new window.
  const c = ctx("open youtube", CHROME_OPEN);
  const { calls, os } = recorder({ browserTab: { url: "https://www.google.com/search?q=YouTube&sca_esv=1", title: "YouTube - Google Search" } });
  const r = await execute("open_url", { url: "youtube.com" }, os, c);
  assert.deepEqual(calls.at(-1), { method: "browse", args: ["youtube.com", "Google Chrome", "current"] });
  assert.equal(r.page, "youtube.com");
});

test("a page the user is reading is kept, and the new one gets a tab beside it", async () => {
  const c = ctx("open github", CHROME_OPEN);
  const { calls, os } = recorder({ browserTab: { url: "https://news.example.com/story/42", title: "A story" } });
  await execute("open_url", { url: "github.com" }, os, c);
  assert.deepEqual(calls.at(-1)?.args.at(-1), "new-tab");
});

test("the page this conversation opened may be replaced by the next", async () => {
  const c = ctx("open github", { ...CHROME_OPEN, lastPage: "youtube.com" });
  const { calls, os } = recorder({ browserTab: { url: "https://www.youtube.com/", title: "YouTube" } });
  await execute("open_url", { url: "github.com" }, os, c);
  assert.deepEqual(calls.at(-1)?.args.at(-1), "current");
});

test("clicks a result by its position, or a link by its words", async () => {
  for (const [phrase, target] of [
    ["click the first result", { nth: 1 }],
    ["open the second result", { nth: 2 }],
    ["click youtube", { text: "youtube" }],
    ["click on the sign in button", { text: "sign in" }],
  ] as const) {
    const d = offlineRoute(ctx(phrase));
    assert.equal(d.action, "click_on", phrase);
    const { calls, os } = recorder();
    await execute(d.action!, d.args, os, ctx(phrase));
    assert.deepEqual(calls.at(-1), { method: "click", args: [target] }, phrase);
  }
});

test("a site named as the search opens the site itself", async () => {
  const phrase = "search for youtube.com";
  const d = offlineRoute(ctx(phrase));
  const { calls, os } = recorder();
  const r = await execute(d.action!, d.args, os, ctx(phrase));
  assert.equal(calls.at(-1)?.args[0], "https://youtube.com");
  assert.equal(r.detail, "Opened youtube.com");
});

test("a search on one site goes to that site's search", async () => {
  const phrase = "search youtube for lofi music";
  const d = offlineRoute(ctx(phrase));
  assert.equal(d.action, "web_search");
  const { calls, os } = recorder();
  const r = await execute(d.action!, d.args, os, ctx(phrase));
  assert.equal(calls.at(-1)?.args[0], "https://www.youtube.com/results?search_query=lofi%20music");
  assert.equal(r.detail, 'Searched YouTube for "lofi music"');
});

test("a browser named in the request is the one used, and is not searched for", async () => {
  const phrase = "search for cats in chrome";
  const c = ctx(phrase, { installedApps: [...INSTALLED, "Google Chrome"] });
  const d = offlineRoute(c);
  assert.equal(d.args.query, "cats");
  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, c);
  assert.deepEqual(calls.at(-1), { method: "browse", args: ["https://www.google.com/search?q=cats", "Google Chrome", "new-tab"] });
});

test("a settings page opens directly", async () => {
  const d = offlineRoute(ctx("open bluetooth settings"));
  assert.equal(d.action, "open_settings");
  assert.equal(d.args.pane, "Bluetooth");
  const { calls, os } = recorder();
  await execute(d.action!, d.args, os, ctx("open bluetooth settings"));
  assert.deepEqual(calls, [{ method: "openSettingsPane", args: ["com.apple.BluetoothSettings"] }]);
});

test("taking a selfie uses the camera, not a screenshot", () => {
  assert.equal(offlineRoute(ctx("take a selfie")).action, "take_photo");
  assert.equal(offlineRoute(ctx("take a screenshot")).action, "screenshot_screen");
});

test("quitting every browser quits each open one", async () => {
  const c = ctx("quit all browsers", { runningApps: ["Finder", "Safari", "Google Chrome"] });
  const { calls, os } = recorder();
  const r = await execute("quit_app", { app: "Every open web browser" }, os, c);
  assert.deepEqual(calls, [
    { method: "quitApp", args: ["Safari"] },
    { method: "quitApp", args: ["Google Chrome"] },
  ]);
  assert.equal(r.detail, "Quit Safari and Google Chrome");
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

test("turning Bluetooth off switches it, not merely opens its page", async () => {
  // From real use: "Turn off Bluetooth" opened the Bluetooth settings page,
  // reported done, and Bluetooth stayed on.
  for (const [phrase, action, call] of [
    ["turn off bluetooth", "bluetooth_off", { method: "setBluetooth", args: [false] }],
    ["disable bluetooth", "bluetooth_off", { method: "setBluetooth", args: [false] }],
    ["turn on bluetooth", "bluetooth_on", { method: "setBluetooth", args: [true] }],
    ["turn on wifi", "wifi_on", { method: "setWifi", args: [true] }],
  ] as const) {
    const d = offlineRoute(ctx(phrase));
    assert.equal(d.action, action, phrase);
    const { calls, os } = recorder();
    await execute(d.action!, d.args, os, ctx(phrase));
    assert.deepEqual(calls, [call], phrase);
  }
});

test("turning Wi-Fi off asks first: it takes the agent offline too", () => {
  const d = offlineRoute(ctx("turn off wifi"));
  assert.equal(d.action, "wifi_off");
  assert.ok(d.risk >= 2.5);
});
