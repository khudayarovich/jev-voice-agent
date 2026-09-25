import {
  type ActionContext,
  type Slots,
  action,
  enumSlot,
  numberSlot,
  textSlot,
} from "./types.ts";
import { afterPhrase, extractUrl, parseCount, parsePercent, shortlistBy } from "./parse.ts";

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

export const ACTIONS = {
  // --- applications ------------------------------------------------------
  open_app: action({
    describe:
      "Launch an application installed on this Mac, or bring it to the front if it is already running. For a website, use the open-website command instead.",
    examples: ["open safari", "launch terminal", "switch to slack", "open finder"],
    slots: { app: appSlot("Which application to open") },
    async run({ app }, os) {
      await os.openApp(app);
      return { detail: `Opened ${app}` };
    },
  }),

  quit_app: action({
    describe:
      "Quit an application entirely, closing ALL of its windows and stopping it. Use when the user says quit or exit, or asks to close an app completely, fully, or entirely.",
    examples: ["quit safari", "exit terminal", "close spotify completely", "close the browser fully"],
    destructive: true,
    slots: { app: runningAppSlot("Which application to quit") },
    async run({ app }, os) {
      await os.quitApp(app);
      return { detail: `Quit ${app}` };
    },
  }),

  hide_app: action({
    describe: "Hide an application's windows without quitting it.",
    examples: ["hide safari", "hide this app"],
    slots: { app: runningAppSlot("Which application to hide") },
    async run({ app }, os) {
      await os.hideApp(app);
      return { detail: `Hid ${app}` };
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
    async run({ app }, os) {
      await os.closeAppWindow(app);
      return { detail: `Closed ${app} window` };
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
    describe: "Play or pause whatever music or video is currently playing.",
    examples: ["play", "pause", "pause the music", "resume"],
    slots: {},
    async run(_a, os) {
      await os.mediaPlayPause();
      return { detail: "Play/pause" };
    },
  }),

  media_next: action({
    describe: "Skip to the next track.",
    examples: ["next track", "skip this song", "next song"],
    slots: {},
    async run(_a, os) {
      await os.mediaNext();
      return { detail: "Next track" };
    },
  }),

  media_previous: action({
    describe: "Go back to the previous track.",
    examples: ["previous track", "go back a song"],
    slots: {},
    async run(_a, os) {
      await os.mediaPrevious();
      return { detail: "Previous track" };
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
      "Open the find bar to search WITHIN the current document or page for text the user is looking at. Not for searching the internet.",
    examples: ["find", "find in this page", "open the find bar"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "f", modifiers: ["command"] });
      return { detail: "Find" };
    },
  }),

  // --- dictation ---------------------------------------------------------
  type_text: action({
    describe:
      "Type literal text into whatever is focused. Use when the user explicitly asked to type, write, or dictate something specific.",
    examples: ["type hello world", "write dear sarah", "dictate this is a test"],
    slots: {
      text: textSlot("The exact words to type", (t) =>
        afterPhrase(t, ["type out", "type", "write out", "write", "dictate", "insert"]),
      ),
    },
    async run({ text }, os) {
      await os.typeText(text);
      return { detail: `Typed "${text.slice(0, 48)}${text.length > 48 ? "…" : ""}"` };
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
    describe: "Press the Delete key to remove the character or selection.",
    examples: ["delete that", "backspace", "press delete"],
    slots: {},
    async run(_a, os) {
      await os.keystroke({ key: "delete" });
      return { detail: "Delete" };
    },
  }),

  // --- navigation --------------------------------------------------------
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
      "Create a new window, document or item in the application in front — its Command-N: a new note in Notes, a new message in Mail, a new document in an editor.",
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
      "Open a website in the browser. Use for a spelled-out address AND for a well-known site named directly, such as YouTube, GitHub, Gmail or Reddit — those are websites, not installed applications.",
    examples: ["go to github dot com", "open example.com", "open youtube", "visit reddit"],
    slots: { url: textSlot("The web address", extractUrl) },
    async run({ url }, os) {
      await os.openUrl(url);
      return { detail: `Opened ${url}` };
    },
  }),

  web_search: action({
    describe:
      "Search the internet for information. Use whenever the user wants to look something up online, including phrasings like 'search for', rather than searching inside the current document.",
    examples: ["search for typescript generics", "google the weather", "look up pasta recipes"],
    slots: {
      query: textSlot("What to search for", (t) =>
        afterPhrase(t, ["search the web for", "search for", "search", "google for", "google", "look up"]),
      ),
    },
    async run({ query }, os) {
      await os.webSearch(query);
      return { detail: `Searched for "${query}"` };
    },
  }),

  // --- capture -----------------------------------------------------------
  screenshot_screen: action({
    describe: "Take a screenshot of the entire screen and save it to the Desktop.",
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

/** The `criteria` map handed to Jev's Choice question. */
export function choiceCriteria(): Record<ActionKey, string> {
  const out = {} as Record<ActionKey, string>;
  for (const key of ACTION_KEYS) out[key] = ACTIONS[key].describe;
  return out;
}

export function isDestructive(key: ActionKey): boolean {
  return ACTIONS[key].destructive === true;
}

export function slotsOf(key: ActionKey): Slots {
  return ACTIONS[key].slots as Slots;
}

export type { ActionContext };
