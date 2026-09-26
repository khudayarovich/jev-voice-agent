import { parameterValue } from "../learning/lesson.ts";
import { runLearned } from "../learning/run.ts";
import type { ClickResult, NowPlaying, PlatformAdapter } from "../platform/types.ts";
import { expandApps, isBrowser, listNames, pickBrowser, withoutBrowser } from "./apps.ts";
import { chooseTab, clickTarget, looksDestructive, nearTarget, resultNumber } from "./browsing.ts";
import { KNOWN_SITE_NAMES, afterPhrase, extractUrl, parseCount, parsePercent, planSearch, shortlistBy } from "./parse.ts";
import { FOLDERS, newFolderName, renameRequest, shortlistFolders } from "./files.ts";
import { messageRequest } from "./messages.ts";
import { typeOrFail } from "./typing.ts";
import { SETTINGS_HOME, SETTINGS_PANES, paneByLabel, shortlistPanes } from "./settings-panes.ts";
import {
  type ActionContext,
  type Slot,
  type Slots,
  action,
  enumSlot,
  numberSlot,
  textSlot,
} from "./types.ts";

/**
 * Every command the agent can run.
 *
 * The keys of this object are the only things Jev is ever allowed to return.
 * They generate the `Choice` criteria sent to the model AND type the executor,
 * so the set of things that can happen is exactly the set of things written
 * here — reviewed, deterministic, and impossible to extend at runtime by
 * anything the model says.
 *
 * `describe` is written for the model, not for a human reading docs. Jev is
 * documented as reading instructions literally, so each description states
 * precisely what the action does and, where two actions are close, what
 * distinguishes them.
 */

const appSlot = (describe: string) =>
  enumSlot(
    describe,
    (ctx) => ctx.installedApps,
    // Narrow before asking: a padded state measurably degrades the model, and
    // there is no reason to make it read 200 app names to pick one.
    (ctx, all) => shortlistBy(ctx.transcript, all, 6),
    { group: "app" },
  );

const runningAppSlot = (describe: string) =>
  enumSlot(
    describe,
    (ctx) => (ctx.runningApps.length ? ctx.runningApps : ctx.installedApps),
    (ctx, all) => shortlistBy(ctx.transcript, all, 6),
    { group: "app", requiresRunning: true },
  );

/** The apps an app slot's answer stands for: one, or every open browser. */
function appsFor(app: string, ctx: ActionContext): string[] {
  const apps = expandApps(app, ctx.runningApps);
  if (apps.length === 0) throw new Error("No browser is open");
  return apps;
}

/**
 * Show a page the way a person would: in the browser in use, and in the tab in
 * front when that tab holds nothing worth keeping — else in a new tab beside
 * it (see browsing.ts). Returns the browser used. The front app is looked up
 * afresh: in "open Chrome and search for cats" it changed a moment ago, after
 * the context was gathered.
 */
async function showPage(url: string, os: PlatformAdapter, ctx: ActionContext): Promise<string | undefined> {
  const front = await os.frontApp().catch(() => "");
  const browser = pickBrowser({ ...ctx, focusedApp: front || ctx.focusedApp }) ?? ctx.defaultBrowser;
  const tab = browser ? await os.browserTab(browser).catch(() => null) : null;
  await os.browse(url, browser, chooseTab(tab?.url ?? null, ctx.lastPage));
  return browser;
}

/**
 * One step of a learned command that is a built-in command: its arguments,
 * said as words, typed the way that command's slots take them.
 */
/**
 * What a media key did, when that can be seen. Music and Spotify say what
 * they are playing; a video in a browser does not, so the key press is
 * reported as one — not as done. Observed in real use: "play" and "next" were
 * reported done with nothing playing at all.
 */
async function mediaOutcome(os: PlatformAdapter, before: NowPlaying | null, key: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 350));
  const now = await os.nowPlaying().catch(() => null);
  const changed = now && (!before || before.state !== now.state || before.track !== now.track);
  if (!now || !changed) return `Pressed ${key}`;
  if (now.state === "playing") return `Playing${now.track ? ` “${now.track}”` : ""} in ${now.app}`;
  return `${now.state === "paused" ? "Paused" : "Stopped"} ${now.app}`;
}

/**
 * What just happened, as an answer. A failure for want of a permission names
 * the permission first, since that is what was asked; any other failure is
 * repeated as it was reported; a success is recalled as one.
 */
export function explainLast(ctx: ActionContext): string {
  const last = ctx.history?.at(-1);
  if (!last) return "Nothing has happened yet";
  const permission = last.detail.match(/\b([A-Z][\w ]*?) permission\b/)?.[1];
  if (last.outcome !== "ok" && permission) {
    return `${permission} — I need it to do that. Opening Settings → Permissions so you can grant it.`;
  }
  if (last.outcome === "ok") return `I just did: ${last.detail}`;
  return `That didn't work: ${last.detail}`;
}

const squashName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "18th date of calendar" → the Calendar app, and "18th date". */
function appNamedIn(target: string, apps: string[]): { app: string; rest: string } | null {
  const m = target.match(/^(.+?)\s+(?:in|on|of|inside|from|at)\s+(?:the\s+)?(.+?)(?:\s+app|\s+window)?$/i);
  if (!m) return null;
  const app = apps.find((a) => squashName(a) === squashName(m[2]!));
  return app && m[1]!.trim() ? { app, rest: m[1]!.trim() } : null;
}

/**
 * The one item on screen the words pick out, by the words on it — "18" among
 * the days of a month — or null when none or several do. Cheap, and before
 * any model: from real use, "click on 18" in Calendar waited seven seconds.
 */
async function onlyOnScreen(os: PlatformAdapter, target: string): Promise<{ i: number; role: string; label: string } | null> {
  const shot = await os.screenElements().catch(() => null);
  const wanted = target.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!wanted) return null;
  const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const hits = (shot?.elements ?? []).filter((e) => e.role !== "StaticText" && e.role !== "ScrollArea" && e.role !== "Heading" && words(e.label).includes(` ${wanted} `));
  const labels = new Set(hits.map((h) => h.label));
  return hits.length > 0 && labels.size === 1 ? hits[0]! : null;
}

/** The front window's own search: a field, or the button that opens one. */
async function searchBoxOnScreen(os: PlatformAdapter): Promise<{ i: number; label: string; kind: "field" | "button" } | null> {
  const shot = await os.screenElements().catch(() => null);
  const elements: { i: number; role: string; label: string }[] = shot?.elements ?? [];
  const field = elements.find((e) => e.role === "SearchField")
    ?? elements.find((e) => (e.role === "TextField" || e.role === "TextArea") && /search|find|filter/i.test(e.label));
  if (field) return { i: field.i, label: field.label, kind: "field" };
  const button = elements.find((e) => e.role === "Button" && /^search$/i.test(e.label.trim()));
  return button ? { i: button.i, label: button.label, kind: "button" } : null;
}

/** The apps the user can see, the one in front first — and never this one. */
function appsOnScreen(ctx: ActionContext): string[] {
  const shown = ctx.windowedApps?.length ? ctx.windowedApps : ctx.runningApps;
  const ours = new Set(["Jev Voice Agent", "JVA", "Electron"]);
  const apps = shown.filter((a) => !ours.has(a));
  return ctx.focusedApp && apps.includes(ctx.focusedApp)
    ? [ctx.focusedApp, ...apps.filter((a) => a !== ctx.focusedApp)]
    : apps;
}

async function runStep(key: string, args: Record<string, string>, os: PlatformAdapter, ctx: ActionContext): Promise<void> {
  const def = (ACTIONS as Record<string, (typeof ACTIONS)[ActionKey]>)[key];
  if (!def || key === "run_learned") throw new Error(`There is no ${key} command`);
  const apps = new Map([...ctx.runningApps, ...ctx.installedApps].map((a) => [a.toLowerCase(), a]));
  const typed: Record<string, string | number> = {};
  for (const [name, slot] of Object.entries(def.slots as Record<string, Slot>)) {
    const value = args[name] ?? "";
    if (slot.kind === "number") typed[name] = Number(value);
    else if (slot.kind === "enum" && slot.group === "app") typed[name] = apps.get(value.toLowerCase()) ?? value;
    else typed[name] = value;
  }
  const run = def.run as (a: Record<string, string | number>, os: PlatformAdapter, ctx: ActionContext) => Promise<unknown>;
  await run(typed, os, ctx);
}

export const ACTIONS = {
  // --- applications ------------------------------------------------------
  open_app: action({
    describe:
      "Launch an application installed on this Mac, or bring it to the front if it is already running. For a website, use the open-website command instead.",
    examples: ["open safari", "launch terminal", "switch to slack", "open finder"],
    slots: { app: appSlot("Which application to open") },
    async run({ app }, os, ctx) {
      const apps = appsFor(app, ctx);
      for (const a of apps) await os.openApp(a);
      return { detail: `Opened ${listNames(apps)}`, app: apps.at(-1)! };
    },
  }),

  quit_app: action({
    describe:
      "Quit an application entirely, closing ALL of its windows and stopping it. Use when the user says quit or exit, or asks to close an app completely, fully, or entirely.",
    examples: ["quit safari", "exit terminal", "close spotify completely", "close the browser fully"],
    destructive: true,
    slots: { app: runningAppSlot("Which application to quit") },
    async run({ app }, os, ctx) {
      const apps = appsFor(app, ctx);
      for (const a of apps) await os.quitApp(a);
      return { detail: `Quit ${listNames(apps)}` };
    },
  }),

  hide_app: action({
    describe: "Hide an application's windows without quitting it.",
    examples: ["hide safari", "hide this app"],
    slots: { app: runningAppSlot("Which application to hide") },
    async run({ app }, os, ctx) {
      const apps = appsFor(app, ctx);
      for (const a of apps) await os.hideApp(a);
      return { detail: `Hid ${listNames(apps)}` };
    },
  }),

  hide_others: action({
    describe: "Hide every application except the one currently in front.",
    examples: ["hide everything else", "hide other apps", "focus mode"],
    slots: {},
    async run(_a, os) {
      await os.hideOthers();
      return { detail: "Hid other apps" };
    },
  }),

  run_automation: action({
    describe:
      "Run one of the user's own saved Shortcuts automations by name. Only for automations that already exist.",
    examples: ["run my morning routine", "run the shortcut called backup"],
    slots: {
      name: enumSlot(
        "Which saved automation to run",
        (ctx) => ctx.automations,
        (ctx, all) => shortlistBy(ctx.transcript, all, 6),
      ),
    },
    async run({ name }, os) {
      const out = await os.runAutomation(name);
      return { detail: out ? `${name}: ${out.slice(0, 120)}` : `Ran ${name}` };
    },
  }),

  // --- windows -----------------------------------------------------------
  close_app_window: action({
    describe:
      "Close the front window of a SPECIFIC application the user named, leaving that application running.",
    examples: ["close the browser", "close the safari window", "close chrome's window"],
    slots: { app: runningAppSlot("Which application's window to close") },
    async run({ app }, os, ctx) {
      const apps = appsFor(app, ctx);
      for (const a of apps) await os.closeAppWindow(a);
      return { detail: `Closed ${listNames(apps)} window${apps.length > 1 ? "s" : ""}` };
    },
  }),

  close_window: action({
    describe:
      "Close the window currently in front, leaving its application running. Use only when the user did NOT name an application.",
    examples: ["close this window", "close the window"],
    slots: {},
    async run(_a, os) {
      await os.closeWindow();
      return { detail: "Closed window" };
    },
  }),

  minimize_window: action({
    describe: "Minimise the front window to the Dock.",
    examples: ["minimize this", "minimise the window"],
    slots: {},
    async run(_a, os) {
      await os.minimizeWindow();
      return { detail: "Minimised" };
    },
  }),

  zoom_window: action({
    describe: "Resize the front window to fit its content, the green-button zoom.",
    examples: ["zoom this window", "maximize the window"],
    slots: {},
    async run(_a, os) {
      await os.zoomWindow();
      return { detail: "Zoomed" };
    },
  }),

  fullscreen_window: action({
    describe: "Put the front window into or out of full screen.",
    examples: ["full screen", "make this fullscreen", "exit full screen"],
    slots: {},
    async run(_a, os) {
      await os.fullscreenWindow();
      return { detail: "Toggled full screen" };
    },
  }),

  tile_window: action({
    describe: "Tile the front window to fill the left or right half of the screen.",
    examples: ["snap this left", "tile window right", "put this on the left half"],
    slots: {
      side: enumSlot("Which half of the screen", () => ["left", "right"], (ctx, all) =>
        /\bright\b/i.test(ctx.transcript) ? ["right"] : /\bleft\b/i.test(ctx.transcript) ? ["left"] : all,
      ),
    },
    async run({ side }, os) {
      await os.tileWindow(side === "right" ? "right" : "left");
      return { detail: `Tiled ${side}` };
    },
  }),

  center_window: action({
    describe: "Move the front window to the centre of the screen.",
    examples: ["center this window", "centre the window"],
    slots: {},
    async run(_a, os) {
      await os.centerWindow();
      return { detail: "Centred" };
    },
  }),

  cycle_window: action({
    describe: "Switch to the next window of the current application.",
    examples: ["next window", "cycle windows", "other window"],
    slots: {},
    async run(_a, os) {
      await os.cycleWindow();
      return { detail: "Next window" };
    },
  }),

  mission_control: action({
    describe: "Show Mission Control, the overview of all open windows and spaces.",
    examples: ["mission control", "show all windows", "show me everything"],
    slots: {},
    async run(_a, os) {
      await os.missionControl();
      return { detail: "Mission Control" };
    },
  }),

  show_desktop: action({
    describe: "Move all windows aside to reveal the desktop.",
    examples: ["show desktop", "show the desktop"],
    slots: {},
    async run(_a, os) {
      await os.showDesktop();
      return { detail: "Desktop" };
    },
  }),

  switch_space: action({
    describe: "Move to the next or previous desktop space.",
    examples: ["next desktop", "previous space", "switch space left"],
    slots: {
      direction: enumSlot("Which direction to move", () => ["left", "right"], (ctx, all) =>
        /\b(left|previous|back)\b/i.test(ctx.transcript)
          ? ["left"]
          : /\b(right|next)\b/i.test(ctx.transcript)
            ? ["right"]
            : all,
      ),
    },
    async run({ direction }, os) {
      await os.switchSpace(direction === "left" ? "left" : "right");
      return { detail: `Space ${direction}` };
    },
  }),

  // --- system ------------------------------------------------------------
  set_volume: action({
    describe:
      "Set the system output volume to a specific level the user named, such as a percentage.",
    examples: ["set volume to thirty percent", "volume 50", "set the volume to half"],
    slots: { level: numberSlot("Volume percentage from 0 to 100", parsePercent, 50) },
    async run({ level }, os) {
      await os.setVolume(level);
      return { detail: `Volume ${level}%` };
    },
  }),

  volume_up: action({
    describe: "Raise the volume by a step. Use when no specific level was named.",
    examples: ["turn it up", "volume up", "louder"],
    slots: { steps: numberSlot("How many steps", (t) => parseCount(t, 2), 2) },
    async run({ steps }, os) {
      const current = await os.getVolume();
      const next = Math.min(100, current + steps * 8);
      await os.setVolume(next);
      return { detail: `Volume ${next}%` };
    },
  }),

  volume_down: action({
    describe: "Lower the volume by a step. Use when no specific level was named.",
    examples: ["turn it down", "volume down", "quieter"],
    slots: { steps: numberSlot("How many steps", (t) => parseCount(t, 2), 2) },
    async run({ steps }, os) {
      const current = await os.getVolume();
      const next = Math.max(0, current - steps * 8);
      await os.setVolume(next);
      return { detail: `Volume ${next}%` };
    },
  }),

  mute: action({
    describe: "Mute the system audio output completely.",
    examples: ["mute", "silence", "be quiet"],
    slots: {},
    async run(_a, os) {
      await os.setMuted(true);
      return { detail: "Muted" };
    },
  }),

  unmute: action({
    describe: "Unmute the system audio output.",
    examples: ["unmute", "sound on"],
    slots: {},
    async run(_a, os) {
      await os.setMuted(false);
      return { detail: "Unmuted" };
    },
  }),

  brightness_up: action({
    describe: "Increase the display brightness.",
    examples: ["brighter", "brightness up", "increase brightness"],
    slots: { steps: numberSlot("How many steps", (t) => parseCount(t, 2), 2) },
    async run({ steps }, os) {
      await os.adjustBrightness("up", steps);
      return { detail: "Brighter" };
    },
  }),

  brightness_down: action({
    describe: "Decrease the display brightness.",
    examples: ["dimmer", "brightness down", "darker screen"],
    slots: { steps: numberSlot("How many steps", (t) => parseCount(t, 2), 2) },
    async run({ steps }, os) {
      await os.adjustBrightness("down", steps);
      return { detail: "Dimmer" };
    },
  }),

  sleep_display: action({
    describe: "Turn the display off, leaving the computer awake.",
    examples: ["turn off the screen", "sleep the display", "screen off"],
    slots: {},
    async run(_a, os) {
      await os.sleepDisplay();
      return { detail: "Display off" };
    },
  }),

  sleep_system: action({
    describe: "Put the whole computer to sleep.",
    examples: ["go to sleep", "sleep the computer", "sleep now"],
    destructive: true,
    slots: {},
    async run(_a, os) {
      await os.sleepSystem();
      return { detail: "Sleeping" };
    },
  }),

  lock_screen: action({
    describe: "Lock the screen, requiring the password to return.",
    examples: ["lock the screen", "lock my mac", "lock it"],
    slots: {},
    async run(_a, os) {
      await os.lockScreen();
      return { detail: "Locked" };
    },
  }),

  bluetooth_on: action({
    describe: "Turn Bluetooth on, so Bluetooth headphones, keyboards and mice can connect.",
    examples: ["turn on bluetooth", "enable bluetooth", "bluetooth on", "switch bluetooth on"],
    slots: {},
    async run(_a, os) {
      await os.setBluetooth(true);
      return { detail: "Bluetooth on", app: "System Settings" };
    },
  }),

  bluetooth_off: action({
    describe: "Turn Bluetooth off, disconnecting Bluetooth devices such as headphones, keyboards and mice.",
    examples: ["turn off bluetooth", "disable bluetooth", "bluetooth off", "switch bluetooth off"],
    slots: {},
    async run(_a, os) {
      await os.setBluetooth(false);
      return { detail: "Bluetooth off", app: "System Settings" };
    },
  }),

  wifi_on: action({
    describe: "Turn Wi-Fi on, reconnecting this Mac to the internet over Wi-Fi.",
    examples: ["turn on wifi", "enable wifi", "wifi on", "turn wifi back on"],
    slots: {},
    async run(_a, os) {
      await os.setWifi(true);
      return { detail: "Wi-Fi on" };
    },
  }),

  wifi_off: action({
    describe: "Turn Wi-Fi off, disconnecting this Mac from the internet over Wi-Fi.",
    examples: ["turn off wifi", "disable wifi", "wifi off"],
    // Takes the agent offline too: only commands it can decide on this Mac,
    // like "turn on Wi-Fi", keep working until it is back.
    destructive: true,
    slots: {},
    async run(_a, os) {
      await os.setWifi(false);
      return { detail: "Wi-Fi off" };
    },
  }),

  dark_mode_on: action({
    describe: "Switch the system appearance to dark.",
    examples: ["dark mode", "turn on dark mode", "go dark"],
    slots: {},
    async run(_a, os) {
      await os.setDarkMode(true);
      return { detail: "Dark mode" };
    },
  }),

  dark_mode_off: action({
    describe: "Switch the system appearance to light.",
    examples: ["light mode", "turn off dark mode"],
    slots: {},
    async run(_a, os) {
      await os.setDarkMode(false);
      return { detail: "Light mode" };
    },
  }),

  do_not_disturb_on: action({
    describe: "Turn on Do Not Disturb so notifications are silenced.",
    examples: ["do not disturb", "silence notifications", "focus on"],
    slots: {},
    async run(_a, os) {
      await os.setDoNotDisturb(true);
      return { detail: "Do Not Disturb on" };
    },
  }),

  do_not_disturb_off: action({
    describe: "Turn off Do Not Disturb so notifications come through again.",
    examples: ["turn off do not disturb", "notifications on"],
    slots: {},
    async run(_a, os) {
      await os.setDoNotDisturb(false);
      return { detail: "Do Not Disturb off" };
    },
  }),

  empty_trash: action({
    describe: "Permanently delete everything currently in the Trash. This cannot be undone.",
    examples: ["empty the trash", "empty trash"],
    destructive: true,
    slots: {},
    async run(_a, os) {
      await os.emptyTrash();
      return { detail: "Trash emptied" };
    },
  }),

  // --- media -------------------------------------------------------------
  media_play_pause: action({
    describe:
      "Play or pause the music or video that is already playing or paused, like the play/pause key. Not for choosing something new to watch: that is a click or a search.",
    examples: ["play", "pause", "pause the music", "resume"],
    slots: {},
    async run(_a, os, ctx) {
      // A video on YouTube in front: its own key, or the media key goes to
      // whatever played last — observed in real use, it stopped Music.
      if (isBrowser(ctx.focusedApp)) {
        const tab = await os.browserTab(ctx.focusedApp).catch(() => null);
        if (tab && /youtube\.com\/watch|youtube\.com\/shorts/i.test(tab.url)) {
          await os.keystroke({ key: "k" });
          return { detail: "Play/pause on YouTube" };
        }
      }
      const before = await os.nowPlaying().catch(() => null);
      await os.mediaPlayPause();
      return { detail: await mediaOutcome(os, before, "play/pause") };
    },
  }),

  media_next: action({
    describe: "Skip to the next track.",
    examples: ["next track", "skip this song", "next song"],
    slots: {},
    async run(_a, os) {
      const before = await os.nowPlaying().catch(() => null);
      await os.mediaNext();
      return { detail: await mediaOutcome(os, before, "next") };
    },
  }),

  media_previous: action({
    describe: "Go back to the previous track.",
    examples: ["previous track", "go back a song"],
    slots: {},
    async run(_a, os) {
      const before = await os.nowPlaying().catch(() => null);
      await os.mediaPrevious();
      return { detail: await mediaOutcome(os, before, "previous") };
    },
  }),

  now_playing: action({
    describe:
      "Say what music is playing right now — the song and the player. A question about the music, which changes nothing.",
    examples: ["what's playing", "what song is this", "which song is playing", "what is playing right now"],
    slots: {},
    async run(_a, os) {
      const now = await os.nowPlaying();
      if (!now) return { detail: "Nothing is playing in Music or Spotify" };
      if (now.state === "playing") return { detail: `Playing${now.track ? ` “${now.track}”` : ""} in ${now.app}` };
      return { detail: `${now.app} is ${now.state}${now.track ? ` on “${now.track}”` : ""}` };
    },
  }),

  explain_last: action({
    describe:
      "Answer a question about what just happened between the user and the agent: why the last command failed, which permission or setting it needs, or what it just did. A question to the agent about itself, not a task for the computer.",
    examples: [
      "which permission do you need",
      "what permission do you need",
      "why didn't that work",
      "what went wrong",
      "what happened",
      "what did you just do",
      "what do you need",
      "did you do it",
      "have you done it",
      "did that work",
    ],
    slots: {},
    async run(_a, _os, ctx) {
      return { detail: explainLast(ctx) };
    },
  }),

  list_open_apps: action({
    describe:
      "Say which apps are open — the ones with a window on screen, the one in front first. A question about the apps, which changes nothing.",
    examples: ["what apps are open", "which apps are running", "what's open right now", "show me the open apps"],
    slots: {},
    async run(_a, _os, ctx) {
      const apps = appsOnScreen(ctx);
      if (apps.length === 0) return { detail: "No app has a window open" };
      const shown = apps.slice(0, 8);
      const more = apps.length - shown.length;
      return { detail: `Open: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` };
    },
  }),

  // --- editing -----------------------------------------------------------
  copy: action({
    describe:
      "Copy the currently selected text or item to the clipboard. Use for any request to copy something.",
    examples: ["copy that", "copy this", "copy the selection"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "c", modifiers: ["command"] });
      return { detail: "Copied" };
    },
  }),

  paste: action({
    describe: "Paste the clipboard contents.",
    examples: ["paste", "paste it"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "v", modifiers: ["command"] });
      return { detail: "Pasted" };
    },
  }),

  cut: action({
    describe: "Cut the current selection to the clipboard.",
    examples: ["cut that", "cut this"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "x", modifiers: ["command"] });
      return { detail: "Cut" };
    },
  }),

  undo: action({
    describe: "Undo the last change in the current application.",
    examples: ["undo", "undo that", "take that back"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "z", modifiers: ["command"] });
      return { detail: "Undo" };
    },
  }),

  redo: action({
    describe: "Redo the change that was just undone.",
    examples: ["redo", "redo that"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "z", modifiers: ["command", "shift"] });
      return { detail: "Redo" };
    },
  }),

  select_all: action({
    describe: "Select everything in the current document or field.",
    examples: ["select all", "select everything"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "a", modifiers: ["command"] });
      return { detail: "Selected all" };
    },
  }),

  save: action({
    describe: "Save the current document.",
    examples: ["save", "save this", "save the file"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "s", modifiers: ["command"] });
      return { detail: "Saved" };
    },
  }),

  find: action({
    describe:
      "Open the Cmd-F find bar to jump to text within the document or page already in front. Only when the user says find bar, find in this page, or command F — 'search for …' is the search command.",
    examples: ["open the find bar", "find in this page", "press command f"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "f", modifiers: ["command"] });
      return { detail: "Find" };
    },
  }),

  // --- dictation ---------------------------------------------------------
  type_text: action({
    describe:
      "Type literal text into the focused text field, and nothing more — no Return, no sending. Use when the user asked to type, write or dictate specific words. If they also say to press enter, send or submit it, that is send_to_app.",
    examples: ["type hello world", "write dear sarah", "dictate this is a test"],
    slots: {
      text: textSlot("The exact words to type", (t) =>
        afterPhrase(t, ["type out", "type", "write out", "write", "dictate", "insert"])?.replace(
          /\s+(?:to|in|into|on)\s+(?:the\s+|its\s+)?(?:input|input field|chat|text field|prompt|box|field)(?:\s+field)?$/i,
          "",
        ) ?? null,
      ),
    },
    async run({ text }, os, ctx) {
      const landed = await typeOrFail(os, text, ctx.focusedApp || "the front window");
      const shown = `"${text.slice(0, 48)}${text.length > 48 ? "…" : ""}"`;
      return { detail: landed === "yes" ? `Typed ${shown}` : `Typed ${shown} — couldn't confirm it landed` };
    },
  }),

  press_enter: action({
    describe: "Press the Return key.",
    examples: ["press enter", "hit return", "submit"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "return" });
      return { detail: "Return" };
    },
  }),

  press_escape: action({
    describe: "Press the Escape key, usually to dismiss something.",
    examples: ["press escape", "escape", "cancel that dialog"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "escape" });
      return { detail: "Escape" };
    },
  }),

  press_delete: action({
    describe: "Press the Delete (backspace) key to remove the character before the cursor or the selection — once, or the number of times said.",
    examples: ["delete that", "backspace", "press delete", "backspace ten times"],
    slots: { times: numberSlot("How many times", (t) => parseCount(t, 1), 1) },
    async run({ times }, os) {
      const n = Math.max(1, Math.min(50, times));
      for (let i = 0; i < n; i++) await os.keystroke({ key: "delete" });
      return { detail: n === 1 ? "Delete" : `Delete ×${n}` };
    },
  }),

  clear_field: action({
    describe: "Clear the text field that has the focus: select everything in it and delete it. 'Clear the input', 'erase what I typed', 'delete everything in the field'.",
    examples: ["clear the input", "clear the field", "erase what i typed", "delete everything in the input"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "a", modifiers: ["command"] });
      await new Promise((r) => setTimeout(r, 80));
      await os.keystroke({ key: "delete" });
      return { detail: "Cleared the field" };
    },
  }),

  // --- navigation --------------------------------------------------------
  scroll_to_bottom: action({
    describe: "Scroll all the way to the bottom of the page or window.",
    examples: ["scroll to the bottom", "go to the bottom of the page", "scroll all the way down", "jump to the end"],
    slots: {},
    async run(_a, os) {
      await os.scrollToEnd("bottom");
      return { detail: "At the bottom" };
    },
  }),

  scroll_to_top: action({
    describe: "Scroll all the way to the top of the page or window.",
    examples: ["scroll to the top", "go to the top of the page", "scroll all the way up", "back to the top"],
    slots: {},
    async run(_a, os) {
      await os.scrollToEnd("top");
      return { detail: "At the top" };
    },
  }),

  scroll_down: action({
    describe: "Scroll the current window down.",
    examples: ["scroll down", "page down", "go down"],
    slots: { amount: numberSlot("How many pages", (t) => parseCount(t, 1), 1) },
    async run({ amount }, os) {
      await os.scroll("down", amount);
      return { detail: "Scrolled down" };
    },
  }),

  scroll_up: action({
    describe: "Scroll the current window up.",
    examples: ["scroll up", "page up", "go back up"],
    slots: { amount: numberSlot("How many pages", (t) => parseCount(t, 1), 1) },
    async run({ amount }, os) {
      await os.scroll("up", amount);
      return { detail: "Scrolled up" };
    },
  }),

  go_back: action({
    describe: "Go back to the previous page or view.",
    examples: ["go back", "back"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "[", modifiers: ["command"] });
      return { detail: "Back" };
    },
  }),

  go_forward: action({
    describe: "Go forward to the next page or view.",
    examples: ["go forward", "forward"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "]", modifiers: ["command"] });
      return { detail: "Forward" };
    },
  }),

  reload_page: action({
    describe: "Reload or refresh the current page.",
    examples: ["reload", "refresh the page", "reload this"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "r", modifiers: ["command"] });
      return { detail: "Reloaded" };
    },
  }),

  new_tab: action({
    describe: "Open a new tab in the current application.",
    examples: ["new tab", "open a new tab"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "t", modifiers: ["command"] });
      return { detail: "New tab" };
    },
  }),

  reopen_tab: action({
    describe: "Reopen the tab that was most recently closed.",
    examples: ["reopen that tab", "undo close tab", "bring back that tab"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "t", modifiers: ["command", "shift"] });
      return { detail: "Reopened tab" };
    },
  }),

  new_window: action({
    describe:
      "Press Command-N in the application in front: a new window in most apps, a new note in Notes, a new message in Mail, a new document in an editor. Not for a new folder, a new tab or a private window, which are done differently.",
    examples: ["new window", "open a new window", "create a new note", "new document"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "n", modifiers: ["command"] });
      return { detail: "New window" };
    },
  }),

  // --- web ---------------------------------------------------------------
  open_url: action({
    describe:
      `Open a website in the browser. Use for a spelled-out address AND for a well-known site named directly — ${KNOWN_SITE_NAMES.join(", ")} — which are websites, not installed applications, even when an app's name is part of theirs. Also when the user names the browser to use, as in 'open YouTube in Chrome'.`,
    examples: ["go to github dot com", "open example.com", "open youtube", "visit reddit", "open youtube in chrome"],
    slots: { url: textSlot("The web address", extractUrl) },
    async run({ url }, os, ctx) {
      const browser = await showPage(url, os, ctx);
      return { detail: `Opened ${url}`, app: browser, page: url };
    },
  }),

  web_search: action({
    describe:
      "Search for something: on the web, on a site such as YouTube or Amazon, in the app in front using its own search box (Finder, Settings, a chat), or an app by name — 'search for FaceTime' opens FaceTime. Use for any 'search for …', 'look up …', 'google …', 'play … on YouTube'. Not the Cmd-F find bar.",
    examples: [
      "search for typescript generics",
      "search for facetime",
      "search for invoices in this folder",
      "google the weather",
      "look up pasta recipes",
      "search youtube for cats",
      "play lofi music on youtube",
    ],
    slots: {
      query: textSlot("What to search for", (t) =>
        afterPhrase(withoutBrowser(t), [
          "search the web for", "search for", "search", "google for", "google", "look up",
          "find", "play", "watch", "listen to",
        ]),
      ),
    },
    async run({ query: asked }, os, ctx) {
      let query = asked;
      const said = ctx.transcript;
      const wantsWeb = /\b(?:web|online|internet|google|bing|duckduckgo|youtube|wikipedia|amazon|reddit|github|browser|\.com|\.org)\b/i.test(said);
      // "In this folder", "in the window": where the user is looking.
      const HERE = /\s*\b(?:in|inside|within)\s+(?:the\s+|this\s+)?(?:folder|finder|window|list|app|settings|applications folder|here)\b.*$/i;
      const here = HERE.test(said);
      query = query.replace(HERE, "").trim() || query;
      if (!wantsWeb) {
        // "Search for FaceTime": the app, not a Google page about it.
        const app = here ? undefined : [...ctx.runningApps, ...ctx.installedApps].find((a) => squashName(a) === squashName(query));
        if (app) {
          await os.openApp(app);
          return { detail: `Opened ${app}`, app };
        }
        // An app with a search of its own in front — Finder, Settings, a
        // chat, an editor: search there, as the user can see it. Finder's is
        // a button until pressed.
        if (ctx.focusedApp && !isBrowser(ctx.focusedApp)) {
          const box = await searchBoxOnScreen(os);
          if (box) {
            await os.actOnElement(box.i, box.kind === "button" ? "press" : "focus", box.label);
            await new Promise((r) => setTimeout(r, box.kind === "button" ? 500 : 150));
            await typeOrFail(os, query, ctx.focusedApp);
            await os.keystroke({ key: "return" });
            return { detail: `Searched ${ctx.focusedApp} for “${query}”`, app: ctx.focusedApp };
          }
        }
      }
      const plan = planSearch(withoutBrowser(ctx.transcript) || query, query, ctx.windowTitle, ctx.lastPage ?? "");
      const browser = await showPage(plan.url, os, ctx);
      const detail =
        plan.kind === "site"
          ? `Opened ${plan.label}`
          : plan.label === "the web"
            ? `Searched for "${plan.query}"`
            : `Searched ${plan.label} for "${plan.query}"`;
      return { detail, app: browser, page: plan.url };
    },
  }),

  click_on: action({
    describe:
      "Click a link, button, list item or search result that is showing on screen, by the words on it or by its position: 'click YouTube', 'click the first result', 'click on Wi-Fi', 'press the Continue button', and 'play the first video' or 'play some video' on a page of videos. Acts on the window in front.",
    examples: [
      "click youtube",
      "click the first result",
      "click sign in",
      "press the continue button",
      "open the second result",
      "play the first video",
    ],
    slots: { target: textSlot("The words on the thing to click, or which result", clickTarget) },
    confirmIf: ({ target }) => looksDestructive(target),
    async run({ target: asked }, os, ctx) {
      // "Click again", "click it", "the same one": the thing clicked last.
      // Observed in real use: "again" was looked for on the screen.
      let target = asked;
      if (/^(?:again|it|that|this|the same(?: one| thing| button)?|same(?: one| button)?|once more|one more time|it again|that again)$/i.test(asked.trim())) {
        if (!ctx.lastClicked) throw new Error("Say what to click — nothing was clicked just now");
        target = ctx.lastClicked;
      }
      // "18th of Calendar", "Details in System Settings": that app's window,
      // brought forward first. Observed in real use: Calendar had opened on
      // another desktop, and the click landed in Finder.
      const named = appNamedIn(target, ctx.runningApps);
      if (named) {
        target = named.rest;
        if (ctx.focusedApp !== named.app) {
          await os.openApp(named.app);
          if (!(await os.waitForFrontmost((a) => a === named.app, 4000))) throw new Error(`${named.app} did not come to the front`);
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      const nth = resultNumber(target);
      let r: ClickResult;
      try {
        r = await os.click(nth ? { nth } : { text: target });
      } catch (err) {
        if (nth || !/Couldn't find/.test(String(err))) throw err;
        // "Details of FASHUZ": no control says all that; the row says the
        // rest. Observed in real use, in the Wi‑Fi pane.
        const beside = nearTarget(target);
        if (beside) {
          r = await os.click({ text: beside.text, near: beside.near });
        } else {
          // Not among the buttons and links: perhaps a cell, a row, a day of
          // a calendar. The screen list, when the words pick out one item.
          const one = await onlyOnScreen(os, target);
          if (!one) throw err;
          const done = await os.actOnElement(one.i, one.role === "Row" || one.role === "Cell" ? "select" : "press", one.label);
          r = { label: done.label };
        }
      }
      // Not remembered as a page: a result's link is often a redirect, and
      // where it lands is the user's own reading, to be kept.
      return { detail: `Clicked ${r.label || target}`, clicked: r.label || target };
    },
  }),

  // --- capture -----------------------------------------------------------
  screenshot_screen: action({
    describe: "Take a screenshot of the entire screen and save it to the Desktop. A picture of the screen, not a photo from the camera.",
    examples: ["take a screenshot", "screenshot the screen", "capture the screen"],
    slots: {},
    async run(_a, os) {
      const file = await os.screenshot("screen");
      return { detail: `Saved ${file.split("/").pop()}` };
    },
  }),

  screenshot_selection: action({
    describe: "Take a screenshot of a region the user drags, and save it to the Desktop.",
    examples: ["screenshot a selection", "capture part of the screen", "snip"],
    slots: {},
    async run(_a, os) {
      const file = await os.screenshot("selection");
      return { detail: `Saved ${file.split("/").pop()}` };
    },
  }),

  screenshot_window: action({
    describe: "Take a screenshot of a single window the user clicks, and save it to the Desktop.",
    examples: ["screenshot this window", "capture a window"],
    slots: {},
    async run(_a, os) {
      const file = await os.screenshot("window");
      return { detail: `Saved ${file.split("/").pop()}` };
    },
  }),

  take_photo: action({
    describe:
      "Take a photo or a selfie with the Mac's camera right now, using Photo Booth: only when the user asks for a picture to be taken. To just open the camera, use the open-app command. A picture from the camera, not a screenshot of the screen.",
    examples: ["take a photo", "take a selfie", "take a picture of me", "snap a photo"],
    slots: {},
    async run(_a, os) {
      await os.takePhoto();
      return { detail: "Taking a photo in Photo Booth", app: "Photo Booth" };
    },
  }),

  // --- settings ----------------------------------------------------------
  open_settings: action({
    describe:
      "Open System Settings, or one page of it such as Wi-Fi, Bluetooth, Displays, Sound, Battery, Notifications, Privacy & Security, Wallpaper, Software Update or Keyboard. Also for changing a setting that has no command of its own — the wallpaper, checking for updates, the keyboard — by opening the page where that is done. Turning Wi-Fi or Bluetooth on or off are commands of their own.",
    examples: ["open bluetooth settings", "open wifi settings", "show display settings", "open sound preferences", "open settings"],
    slots: {
      pane: enumSlot(
        "Which page of System Settings",
        () => [SETTINGS_HOME, ...SETTINGS_PANES.map((p) => p.label)],
        (ctx) => {
          const named = shortlistPanes(ctx.transcript);
          return named.length > 0 ? named : [SETTINGS_HOME];
        },
      ),
    },
    async run({ pane }, os) {
      if (pane === SETTINGS_HOME) {
        await os.openApp("System Settings");
        return { detail: "Opened System Settings", app: "System Settings" };
      }
      const page = paneByLabel(pane);
      if (!page) throw new Error(`There is no settings page called ${pane}`);
      await os.openSettingsPane(page.id);
      return { detail: `Opened ${page.label} settings`, app: "System Settings" };
    },
  }),

  // --- talking to apps ---------------------------------------------------
  send_to_app: action({
    describe:
      "Type a message, prompt or question into an app's input and press Return to send it — an AI assistant such as Codex or ChatGPT, a chat app, a terminal: 'send a prompt to Codex saying …', 'ask ChatGPT …', 'tell Codex to …', 'write hello in the input and press enter'. The app named, or else the one in front, as after 'open Codex'. Whenever the words say to send, submit, or press enter after typing.",
    examples: ["send a prompt to codex saying fix the tests", "ask chatgpt what is the capital of peru", "tell codex to run the build", "send a message to telegram saying hello", "write hello to the input and press enter"],
    slots: {},
    async run(_a, os, ctx) {
      const { app, text } = messageRequest(ctx.transcript, [...ctx.runningApps, ...ctx.installedApps]);
      if (!text) throw new Error("Say what to send: “send a prompt to Codex saying …”");
      const target = app ?? ctx.focusedApp;
      if (!target) throw new Error("Say which app to send it to");
      await os.openApp(target);
      if (!(await os.waitForFrontmost((a) => a === target, 4000))) throw new Error(`${target} did not come to the front`);
      // A moment for the window to settle; then the focus goes into its text
      // input, and the text is checked for before Return is pressed —
      // observed in real use, a prompt "sent" to OpenCode never appeared.
      await new Promise((r) => setTimeout(r, 400));
      const landed = await typeOrFail(os, text, target);
      await new Promise((r) => setTimeout(r, 150));
      await os.keystroke({ key: "return" });
      const shown = `“${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`;
      return { detail: landed === "yes" ? `Sent to ${target}: ${shown}` : `Typed ${shown} into ${target} and pressed Return — couldn't confirm it landed`, app: target };
    },
  }),

  // --- files -------------------------------------------------------------
  open_folder: action({
    describe:
      "Open one of the user's folders in Finder: Desktop, Downloads, Documents, Pictures, Music, Movies, Applications or the home folder. Not for opening an app.",
    examples: ["open the downloads folder", "open documents folder", "show my desktop folder", "go to the downloads folder", "open the applications folder"],
    slots: {
      folder: enumSlot("Which folder", () => Object.keys(FOLDERS), (ctx) => shortlistFolders(ctx.transcript)),
    },
    async run({ folder }, os) {
      const where = FOLDERS[folder];
      if (!where) throw new Error(`There is no folder called ${folder}`);
      await os.openFolder(where);
      return { detail: `Opened ${folder}`, app: "Finder" };
    },
  }),

  new_folder: action({
    describe:
      "Make a new folder where Finder is looking — its front window, or the desktop — named as the user said, or untitled.",
    examples: ["create a new folder", "make a new folder called reports", "new folder on the desktop", "create a folder named photos"],
    slots: {},
    async run(_a, os, ctx) {
      const name = await os.newFolder(newFolderName(ctx.transcript));
      return { detail: `Made a folder “${name}”`, app: "Finder" };
    },
  }),

  rename_item: action({
    describe:
      "Rename a file or folder in Finder to a new name: the one the user names, or else the selected one. Use for 'rename', 'name it', 'call it'.",
    examples: ["rename the folder to reports", "rename it to hello world", "rename untitled folder to photos", "name the new folder as notes", "call this folder archive"],
    slots: {},
    async run(_a, os, ctx) {
      const { item, to } = renameRequest(ctx.transcript);
      if (!to) throw new Error("Say the new name too: “rename it to …”");
      const was = await os.renameItem(item, to);
      return { detail: `Renamed “${was}” to “${to}”`, app: "Finder" };
    },
  }),

  // --- learned -----------------------------------------------------------
  run_learned: action({
    describe:
      "Run one of the commands the agent has learned. Never offered to Jev as such: each learned command is offered on its own.",
    examples: ["run a learned command"],
    slots: { command: textSlot("Which learned command", () => null) },
    async run({ command }, os, ctx) {
      const learned = ctx.learned?.find((c) => c.id === command);
      if (!learned) throw new Error("I don't know that command any more");
      const value = parameterValue(learned, ctx.transcript);
      if (learned.parameter && !value) throw new Error(`Say the ${learned.parameter.name.replace(/_/g, " ")} too`);
      const did = await runLearned(learned, value, {
        os,
        runAction: (key, args) => runStep(key, args, os, ctx),
        openUrl: async (url) => {
          await showPage(url, os, ctx);
        },
      });
      return { detail: learned.title, ...(did.clicked ? { clicked: did.clicked } : {}) };
    },
  }),

  // --- agent meta --------------------------------------------------------
  cancel: action({
    describe:
      "The user is retracting what they just said and wants nothing to happen. Use ONLY when they are calling off a request, never when they are asking for an action to be performed.",
    examples: ["never mind", "forget it", "ignore that", "cancel that"],
    slots: {},
    async run() {
      return { detail: "Cancelled" };
    },
  }),

  stop_listening: action({
    describe: "Stop listening entirely until the user turns the agent back on.",
    examples: ["stop listening", "go to sleep jeff", "pause listening"],
    slots: {},
    async run() {
      return { detail: "Listening off" };
    },
  }),
} as const;

export type ActionKey = keyof typeof ACTIONS;
export const ACTION_KEYS = Object.keys(ACTIONS) as ActionKey[];

/**
 * What Jev picks when no command fits: the cue to learn one. Without it the
 * Choice had to pick *something*, and an unknown request came back as the
 * nearest command at low confidence — indistinguishable from a muddled one.
 */
export const UNKNOWN_TASK = "unknown_task";

/** Each learned command's key in the Choice. */
export const LEARNED_PREFIX = "learned:";

/**
 * The `criteria` map handed to Jev's Choice question: the built-in commands,
 * each learned one by its own description, and "none of these".
 */
export function choiceCriteria(learned: { id: string; describe: string }[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ACTION_KEYS) if (key !== "run_learned") out[key] = ACTIONS[key].describe;
  for (const c of learned) out[`${LEARNED_PREFIX}${c.id}`] = c.describe;
  out[UNKNOWN_TASK] =
    "The user asked the computer to do something that none of the other commands does: a task the assistant has no command for yet.";
  return out;
}

export function isDestructive(key: ActionKey): boolean {
  return ACTIONS[key].destructive === true;
}

export function slotsOf(key: ActionKey): Slots {
  return ACTIONS[key].slots as Slots;
}

export type { ActionContext };
