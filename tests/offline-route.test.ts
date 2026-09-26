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

  const { calls, os } = recorder({ inputValue: "Hello there, friend" });
  await execute(d.action!, d.args, os, ctx(phrase));
  // Into the focused input, and read back: never typed into nothing.
  assert.deepEqual(calls.map((c) => c.method), ["focusInput", "typeText", "inputValue"]);
  assert.deepEqual(calls[1]?.args, ["Hello there, friend"]);
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

test("without Jev, a keyword guess is not acted on", () => {
  // From a real outage: "go to battery" came out as sleep, and "show hidden
  // files in Finder" opened Mission Control, each at a confidence that acted.
  for (const said of ["Go to battery.", "go to bluetooth", "Show hidden files in Finder.", "No hidden files in Finder.", "Open set things."]) {
    const d = offlineRoute(ctx(said));
    assert.ok(d.confidence < 0.55, `${said} → ${d.action} at ${d.confidence}`);
  }
});

test("without Jev, what the words say plainly still works", () => {
  for (const [said, action, args] of [
    ["Open settings of the Mac.", "open_settings", { pane: "System Settings" }],
    ["open the battery settings", "open_settings", { pane: "Battery" }],
    ["turn on bluetooth please", "bluetooth_on", {}],
    ["can you take a screenshot now", "screenshot_screen", {}],
    ["set the volume to thirty percent", "set_volume", { level: 30 }],
    ["scroll down three pages", "scroll_down", { amount: 3 }],
    ["switch to slack", "open_app", { app: "Slack" }],
    ["search for cats", "web_search", { query: "cats" }],
  ] as const) {
    const d = offlineRoute(ctx(said));
    assert.equal(d.action, action, said);
    assert.deepEqual(d.args, args, said);
    assert.ok(d.confidence >= 0.55, `${said} at ${d.confidence}`);
  }
});

test("without Jev, an app is only one named by all the words", () => {
  // "Open Yandex Music" contains "Music", and opened it.
  const d = offlineRoute(ctx("open yandex music", { installedApps: ["Music", "Safari"] }));
  assert.notEqual(d.args.app, "Music");
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

// --- what is on the screen, and what is playing ------------------------------

test("a media key is pressed as the keyboard's would be, and reported as pressed when nothing says more", async () => {
  // From real use: "next song" ran an AppleScript that did not compile, and
  // "play" drove Music while the music was a video in Safari — reported done.
  const { calls, os } = recorder({ nowPlaying: null });
  const r = await execute("media_next", {}, os, ctx("next song"));
  assert.deepEqual(calls.filter((c) => c.method === "mediaNext").length, 1);
  assert.equal(r.detail, "Pressed next");
});

test("what a media key changed is what is reported", async () => {
  const states = [
    { app: "Music", state: "playing", track: "Blue in Green" },
    { app: "Music", state: "playing", track: "So What" },
  ];
  const os = new Proxy({}, {
    get: (_t, prop: string) => (prop === "platform" ? "darwin" : () => Promise.resolve(prop === "nowPlaying" ? states.shift() : undefined)),
  }) as unknown as PlatformAdapter;
  const r = await execute("media_next", {}, os, ctx("next song"));
  assert.equal(r.detail, "Playing “So What” in Music");

  const { os: paused } = recorder({ nowPlaying: { app: "Spotify", state: "paused", track: "Blue in Green" } });
  // The same state before and after: the key went elsewhere, and that is said.
  assert.equal((await execute("media_play_pause", {}, paused, ctx("play"))).detail, "Pressed play/pause");
});

test("asking what is playing changes nothing, and says what it found", async () => {
  const { calls, os } = recorder({ nowPlaying: { app: "Music", state: "playing", track: "Blue in Green" } });
  const r = await execute("now_playing", {}, os, ctx("what's playing"));
  assert.equal(r.detail, "Playing “Blue in Green” in Music");
  assert.deepEqual(calls.map((c) => c.method), ["nowPlaying"]);
  const { os: quiet } = recorder({ nowPlaying: null });
  assert.equal((await execute("now_playing", {}, quiet, ctx("what's playing"))).detail, "Nothing is playing in Music or Spotify");
});

test("asking which apps are open lists what is on screen, the front one first", async () => {
  const { calls, os } = recorder();
  const here = ctx("what apps are open", {
    focusedApp: "Music",
    windowedApps: ["Finder", "Safari", "Jev Voice Agent", "Music"],
  });
  const r = await execute("list_open_apps", {}, os, here);
  assert.equal(r.detail, "Open: Music, Finder, Safari");
  assert.deepEqual(calls, [], "a question changes nothing");
  // Without the desktop's list, the running apps stand in.
  const r2 = await execute("list_open_apps", {}, os, ctx("what apps are open"));
  assert.equal(r2.detail, "Open: Finder, Safari");
});

test("the questions about the screen need no model", () => {
  for (const [said, action] of [["what's playing", "now_playing"], ["what apps are open", "list_open_apps"], ["next song", "media_next"]] as const) {
    const d = offlineRoute(ctx(said));
    assert.equal(d.action, action, said);
    assert.ok(d.confidence >= 0.55, `${said} at ${d.confidence}`);
  }
});

test("asked which permission it needs, the agent names it", async () => {
  const { calls, os } = recorder();
  const failed = ctx("which permission do you need", {
    history: [{ said: "close notepad", outcome: "failed", detail: "Accessibility permission is needed to press keys and buttons. Grant it in Settings → Permissions.", at: Date.now() }],
  });
  const r = await execute("explain_last", {}, os, failed);
  assert.match(r.detail ?? "", /^Accessibility — I need it/);
  assert.deepEqual(calls, []);
  const done = ctx("what did you just do", { history: [{ said: "open safari", outcome: "ok", detail: "Opened Safari", at: Date.now() }] });
  assert.equal((await execute("explain_last", {}, os, done)).detail, "I just did: Opened Safari");
  assert.equal((await execute("explain_last", {}, os, ctx("what happened"))).detail, "Nothing has happened yet");
});

test("a message to an app is typed into its focused input and checked before Return", async () => {
  const { calls, os } = recorder({ waitForFrontmost: true, inputValue: "hello from jva" });
  const r = await execute("send_to_app", {}, os, ctx("send a prompt to codex saying hello from JVA", { installedApps: ["Codex", "Safari"] }));
  assert.deepEqual(calls.map((c) => c.method), ["openApp", "waitForFrontmost", "focusInput", "typeText", "inputValue", "keystroke"]);
  assert.equal(r.detail, "Sent to Codex: “hello from JVA”");
  // The text never arrived: said so, and Return never pressed.
  const { calls: c2, os: os2 } = recorder({ waitForFrontmost: true, inputValue: "" });
  await assert.rejects(execute("send_to_app", {}, os2, ctx("tell codex to run the build", { installedApps: ["Codex"] })), /Couldn't get the text into Codex/);
  assert.ok(!c2.some((c) => c.method === "keystroke"));
});

test("dictation lands in the input or says so; it never reports words that went nowhere", async () => {
  // From real use: "write hello to the input and click enter" pasted into
  // nothing and was reported as typed.
  const { calls, os } = recorder({ inputValue: "hello" });
  const r = await execute("type_text", { text: "hello" }, os, ctx("type hello", { focusedApp: "OpenCode" }));
  assert.equal(r.detail, 'Typed "hello"');
  assert.deepEqual(calls.map((c) => c.method).slice(0, 3), ["focusInput", "typeText", "inputValue"]);
  const { os: nowhere } = recorder({ inputValue: "" });
  await assert.rejects(execute("type_text", { text: "hello" }, nowhere, ctx("type hello", { focusedApp: "OpenCode" })), /Couldn't get the text into OpenCode/);
  const { os: blind } = recorder({ inputValue: null });
  assert.match((await execute("type_text", { text: "hello" }, blind, ctx("type hello"))).detail ?? "", /couldn't confirm/);
});

test("'search for <an app>' opens the app; a front app's own search box is used; the web only when asked", async () => {
  // From real use: "search for FaceTime" opened the browser on a Google page.
  const { calls, os } = recorder();
  const r = await execute("web_search", { query: "FaceTime" }, os, ctx("search for facetime", { installedApps: ["FaceTime", "Safari"] }));
  assert.equal(r.detail, "Opened FaceTime");
  assert.deepEqual(calls.map((c) => c.method), ["openApp"]);

  const { calls: c2, os: os2 } = recorder({
    screenElements: { app: "Finder", elements: [{ i: 3, role: "Button", label: "Back", x: 0, y: 0, w: 1, h: 1 }, { i: 7, role: "SearchField", label: "Search", x: 0, y: 0, w: 1, h: 1 }] },
    inputValue: "invoices",
  });
  const r2 = await execute("web_search", { query: "invoices" }, os2, ctx("search for invoices", { focusedApp: "Finder" }));
  assert.equal(r2.detail, "Searched Finder for “invoices”");
  assert.deepEqual(c2.filter((c) => c.method === "actOnElement")[0]?.args, [7, "focus", "Search"]);
  assert.ok(c2.some((c) => c.method === "keystroke"));

  // Finder's search is a button until pressed; "in this folder" means here, not the app of that name.
  const { calls: c4, os: os4 } = recorder({
    screenElements: { app: "Finder", elements: [{ i: 11, role: "Button", label: "Search", x: 0, y: 0, w: 1, h: 1 }] },
    inputValue: "facetime",
  });
  const r4 = await execute("web_search", { query: "FaceTime in the applications folder" }, os4, ctx("search for facetime in the applications folder", { focusedApp: "Finder", installedApps: ["FaceTime"] }));
  assert.equal(r4.detail, "Searched Finder for “FaceTime”");
  assert.deepEqual(c4.filter((c) => c.method === "actOnElement")[0]?.args, [11, "press", "Search"]);

  const { calls: c3, os: os3 } = recorder({ browserTab: null });
  await execute("web_search", { query: "invoices" }, os3, ctx("search the web for invoices", { focusedApp: "Finder" }));
  assert.ok(!c3.some((c) => c.method === "screenElements"), "asked for the web: no search box looked for");
});
