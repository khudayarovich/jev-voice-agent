import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, clipboard } from "electron";
import type {
  AppInfo,
  BrowserTab,
  ClickResult,
  ClickTarget,
  FocusContext,
  KeyCombo,
  PlatformAdapter,
} from "../types.ts";
import { browseScript, frontTabScript, parseFrontTab, scriptFamily } from "./browsers.ts";
import { defaultBrowserId, parseMdls, parseMdlsDate } from "./launchservices.ts";
import { parseDisplayName, parseForegroundApps } from "./lsappinfo.ts";
import { asStr, osa, runAppleScript } from "./osascript.ts";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Installed apps change rarely; re-read at most this often, in the background. */
const APP_CACHE_MS = 60_000;
/** The user's Shortcuts change even more rarely. */
const AUTOMATION_CACHE_MS = 5 * 60_000;
/** Where LaunchServices records which app opens which kind of link. */
const LAUNCH_SERVICES_PREFS = "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist";

/**
 * The helper that finds and presses things on screen (native/jev-ax). Built by
 * `npm run setup` for development, and shipped inside the app.
 */
export function screenHelper(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "jev-ax")
    : path.join(app.getAppPath(), "vendor", "jev-ax", "jev-ax");
}

const withScheme = (url: string) => (/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);

/**
 * macOS implementation.
 *
 * Actions prefer the cheapest layer that can do the job, because each step up
 * costs a permission, latency, and brittleness:
 *
 *   L0  `open` / `pmset` / `screencapture`      no permission
 *   L1  `shortcuts run`                          no permission
 *   L2  AppleScript to an app                    Automation, per target app
 *   L3  System Events UI scripting               Automation + Accessibility
 *
 * Every osascript call carries a double timeout — see osascript.ts for why.
 */

/**
 * Turn an opaque tool failure into something that names the actual problem.
 *
 * `screencapture` fails with "could not create image from display" when Screen
 * Recording is not granted, and AppleScript returns -1743 when Automation is
 * not. Both are permission problems wearing an unhelpful disguise, and showing
 * the raw text to a user tells them nothing about what to do.
 */
function translatePermissionError(err: unknown, kind: "screenRecording" | "accessibility"): Error {
  const text = err instanceof Error ? err.message : String(err);
  if (kind === "screenRecording" && /could not create image|not authori[sz]ed/i.test(text)) {
    return new Error(
      "Screen Recording permission is needed for screenshots. Grant it in Settings → Permissions.",
    );
  }
  if (kind === "accessibility" && /not allowed to send keystrokes|assistive access|1002|-1719|-25211/.test(text)) {
    return new Error(
      "Accessibility permission is needed to press keys and buttons. Grant it in Settings → Permissions.",
    );
  }
  return err instanceof Error ? err : new Error(text);
}

/** macOS virtual key codes for keys that have no character. */
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, escape: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f11: 103, f12: 111,
  brightnessDown: 145, brightnessUp: 144,
  missionControl: 160,
};

const MODIFIER_NAMES: Record<string, string> = {
  command: "command down",
  control: "control down",
  option: "option down",
  shift: "shift down",
  fn: "function down",
};

export class MacPlatform implements PlatformAdapter {
  readonly platform = "darwin" as const;

  private appCache: { at: number; apps: AppInfo[] } | null = null;
  private appRefresh: Promise<AppInfo[]> | null = null;
  private automationCache: { at: number; list: string[] } | null = null;
  private automationRefresh: Promise<string[]> | null = null;
  private browserCache: { at: number; name: string } | null = null;

  // --- discovery ---------------------------------------------------------

  /**
   * Installed apps, read straight off disk.
   *
   * This is the candidate list the router picks from, so it must be the real
   * set: the model can only ever return a name that appeared here.
   *
   * Stale-while-revalidate: once there is any list at all, a command never
   * waits for a fresh one. Re-reading the Applications folders and asking
   * Spotlight for launch dates costs ~100 ms, and it used to land on the
   * critical path of whichever command happened to arrive after the cache aged.
   */
  async listApps(): Promise<AppInfo[]> {
    if (this.appCache) {
      if (Date.now() - this.appCache.at > APP_CACHE_MS) void this.refreshApps().catch(() => undefined);
      return this.appCache.apps;
    }
    return this.refreshApps();
  }

  private refreshApps(): Promise<AppInfo[]> {
    this.appRefresh ??= this.readApps().finally(() => {
      this.appRefresh = null;
    });
    return this.appRefresh;
  }

  private async readApps(): Promise<AppInfo[]> {
    const roots = [
      "/Applications",
      "/Applications/Utilities",
      "/System/Applications",
      "/System/Applications/Utilities",
      path.join(app.getPath("home"), "Applications"),
    ];
    const seen = new Map<string, AppInfo>();
    for (const root of roots) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue; // root may not exist on this machine
      }
      for (const entry of entries) {
        if (!entry.endsWith(".app")) continue;
        const name = entry.slice(0, -4);
        if (!seen.has(name.toLowerCase())) {
          seen.set(name.toLowerCase(), { name, path: path.join(root, entry) });
        }
      }
    }
    const apps = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    await this.attachMetadata(apps);
    this.appCache = { at: Date.now(), apps };
    return apps;
  }

  /**
   * Annotate apps with their bundle id and when they were last launched, via
   * Spotlight.
   *
   * Last-launched is the ranking signal that makes the speech vocabulary
   * prompt useful. whisper's prompt is bounded at a couple of hundred tokens,
   * so on a Mac with a hundred apps the list has to be cut somewhere — and
   * cutting it alphabetically drops Safari, Slack, Terminal and Xcode while
   * keeping every utility beginning with "A". Recency is a far better
   * predictor of what the user is about to say. The bundle id is how the
   * default browser, which LaunchServices records by id, gets its name. One
   * `mdls` call covers every app in about 70 ms.
   */
  private async attachMetadata(apps: AppInfo[]): Promise<void> {
    const paths = apps.map((a) => a.path).filter((p): p is string => Boolean(p));
    if (paths.length === 0) return;
    try {
      const { stdout } = await exec(
        "/usr/bin/mdls",
        ["-name", "kMDItemFSName", "-name", "kMDItemCFBundleIdentifier", "-name", "kMDItemLastUsedDate", ...paths],
        { timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
      );
      const byName = new Map<string, Record<string, string>>();
      for (const record of parseMdls(stdout)) {
        const file = record.kMDItemFSName;
        if (file?.endsWith(".app")) byName.set(file.slice(0, -4), record);
      }
      for (const app of apps) {
        const record = byName.get(app.name);
        if (!record) continue;
        if (record.kMDItemCFBundleIdentifier) app.id = record.kMDItemCFBundleIdentifier;
        const lastUsed = parseMdlsDate(record.kMDItemLastUsedDate);
        if (lastUsed !== undefined) app.lastUsed = lastUsed;
      }
    } catch {
      // Spotlight may be disabled or indexing; ranking simply falls back to
      // alphabetical, which still works.
    }
  }

  /**
   * Regular apps that are running, from LaunchServices: ~50 ms and no
   * permission, against 270-400 ms through System Events, which also needs an
   * Automation grant. System Events stays as the fallback.
   */
  async runningApps(): Promise<string[]> {
    try {
      const { stdout } = await exec("/usr/bin/lsappinfo", ["list"], {
        timeout: 2000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const apps = parseForegroundApps(stdout);
      if (apps.length) return apps;
    } catch {
      // Fall through to System Events.
    }
    const out = await osa(
      `tell application "System Events" to get name of every application process whose background only is false`,
      { timeoutMs: 4000 },
    ).catch(() => "");
    return out ? out.split(", ").map((s) => s.trim()).filter(Boolean) : [];
  }

  async windowedApps(): Promise<string[]> {
    const { stdout } = await exec(screenHelper(), ["windows"], { timeout: 2000 });
    return (JSON.parse(stdout) as { apps?: string[] }).apps ?? [];
  }

  /** The frontmost app's name, from LaunchServices. ~10 ms. */
  async frontApp(): Promise<string> {
    const { stdout: asn } = await exec("/usr/bin/lsappinfo", ["front"], { timeout: 1500 });
    const id = asn.trim();
    if (!id) return "";
    const { stdout } = await exec("/usr/bin/lsappinfo", ["info", "-only", "name", id], { timeout: 1500 });
    return parseDisplayName(stdout);
  }

  async waitForFrontmost(test: (app: string) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (test(await this.frontApp().catch(() => ""))) return true;
      if (Date.now() >= deadline) return false;
      await sleep(40);
    }
  }

  async focus(): Promise<FocusContext> {
    // The app name comes from LaunchServices; only the window title needs
    // Accessibility, so it is fetched alongside and allowed to fail on its own.
    const title = osa(
      `tell application "System Events" to tell (first application process whose frontmost is true) to get name of front window`,
      { timeoutMs: 1500 },
    ).catch(() => "");
    const app = await this.frontApp().catch(() => "");
    if (app) return { app, windowTitle: (await title).trim() };

    // LaunchServices failed: fall back to one System Events round trip.
    const script = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  try
    set winTitle to name of front window of frontApp
  on error
    set winTitle to ""
  end try
end tell
return appName & "\\n" & winTitle`;
    const out = await osa(script, { timeoutMs: 4000 }).catch(() => "");
    const [appName = "", windowTitle = ""] = out.split("\n");
    return { app: appName.trim(), windowTitle: windowTitle.trim() };
  }

  /**
   * Shortcuts the user has authored.
   *
   * These become additional voice commands automatically, which is how the
   * agent stays open-ended without a generative model: write a Shortcut, say
   * its name. Cached, and refreshed in the background, like the app list.
   */
  async listAutomations(): Promise<string[]> {
    if (this.automationCache) {
      if (Date.now() - this.automationCache.at > AUTOMATION_CACHE_MS) {
        void this.refreshAutomations();
      }
      return this.automationCache.list;
    }
    return this.refreshAutomations();
  }

  private refreshAutomations(): Promise<string[]> {
    this.automationRefresh ??= (async () => {
      try {
        const { stdout } = await exec("/usr/bin/shortcuts", ["list"], { timeout: 4000 });
        const list = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        this.automationCache = { at: Date.now(), list };
        return list;
      } catch {
        return this.automationCache?.list ?? [];
      } finally {
        this.automationRefresh = null;
      }
    })();
    return this.automationRefresh;
  }

  // --- applications ------------------------------------------------------

  async openApp(name: string): Promise<void> {
    await exec("/usr/bin/open", ["-a", name], { timeout: 8000 });
  }

  async quitApp(name: string): Promise<void> {
    await osa(`tell application ${asStr(name)} to quit`, { timeoutMs: 6000 });
  }

  async hideApp(name: string): Promise<void> {
    await osa(
      `tell application "System Events" to set visible of process ${asStr(name)} to false`,
    );
  }

  async hideOthers(): Promise<void> {
    await this.keystroke({ key: "h", modifiers: ["command", "option"] });
  }

  async runAutomation(name: string): Promise<string> {
    // `--output-path -` writes the shortcut's result to stdout.
    const { stdout } = await exec("/usr/bin/shortcuts", ["run", name, "--output-path", "-"], {
      timeout: 30_000,
    });
    return stdout.trim();
  }

  // --- windows -----------------------------------------------------------

  closeWindow = () => this.keystroke({ key: "w", modifiers: ["command"] });

  /**
   * Close a named app's window rather than whatever happens to be in front.
   *
   * "close the browser" used to send Cmd-W to the frontmost app, which closed
   * a window of something else entirely if the browser was not focused.
   */
  async closeAppWindow(name: string): Promise<void> {
    await this.openApp(name);
    // Wait until it is actually frontmost, or the keystroke lands on the
    // previous app. A fixed sleep was both too long when the app was already
    // running and too short when it was not.
    const front = await this.waitForFrontmost((a) => a === name, 1500);
    if (!front) throw new Error(`${name} did not come to the front, so nothing was closed`);
    await this.keystroke({ key: "w", modifiers: ["command"] });
  }
  minimizeWindow = () => this.keystroke({ key: "m", modifiers: ["command"] });
  fullscreenWindow = () => this.keystroke({ key: "f", modifiers: ["command", "control"] });

  async zoomWindow(): Promise<void> {
    await osa(`tell application "System Events" to tell (first process whose frontmost is true) to tell front window to set value of attribute "AXFullScreen" to false`).catch(
      () => undefined,
    );
    await this.runMenuItem("Window", "Zoom");
  }

  async tileWindow(side: "left" | "right"): Promise<void> {
    // Tahoe's own window tiling lives under Window > Move & Resize.
    await this.runMenuItem("Window", side === "left" ? "Left" : "Right", "Move & Resize");
  }

  async centerWindow(): Promise<void> {
    await this.runMenuItem("Window", "Center", "Move & Resize");
  }

  cycleWindow = () => this.keystroke({ key: "`", modifiers: ["command"] });

  async missionControl(): Promise<void> {
    await this.keyCode(KEY_CODES.missionControl!);
  }

  async showDesktop(): Promise<void> {
    await this.keystroke({ key: "f11", modifiers: ["fn"] });
  }

  async switchSpace(direction: "left" | "right"): Promise<void> {
    await this.keystroke({ key: direction, modifiers: ["control"] });
  }

  /** Click a menu item, optionally nested one submenu deep. */
  private async runMenuItem(menu: string, item: string, submenu?: string): Promise<void> {
    const target = submenu
      ? `menu item ${asStr(item)} of menu ${asStr(submenu)} of menu item ${asStr(submenu)} of menu ${asStr(menu)} of menu bar item ${asStr(menu)} of menu bar 1`
      : `menu item ${asStr(item)} of menu ${asStr(menu)} of menu bar item ${asStr(menu)} of menu bar 1`;
    await osa(
      `tell application "System Events" to tell (first process whose frontmost is true) to click ${target}`,
      { timeoutMs: 5000 },
    );
  }

  // --- system ------------------------------------------------------------

  async getVolume(): Promise<number> {
    const out = await osa(`return output volume of (get volume settings)`);
    return Number(out) || 0;
  }

  async setVolume(percent: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    // A scripting addition on our own process, so no Automation prompt.
    await osa(`set volume output volume ${clamped}`);
  }

  async setMuted(muted: boolean): Promise<void> {
    await osa(`set volume output muted ${muted ? "true" : "false"}`);
  }

  async adjustBrightness(direction: "up" | "down", steps: number): Promise<void> {
    const code = direction === "up" ? KEY_CODES.brightnessUp! : KEY_CODES.brightnessDown!;
    await this.repeatKeyCode(code, Math.max(1, Math.min(16, steps)));
  }

  async sleepDisplay(): Promise<void> {
    await exec("/usr/bin/pmset", ["displaysleepnow"], { timeout: 4000 });
  }

  async sleepSystem(): Promise<void> {
    await osa(`tell application "System Events" to sleep`);
  }

  async lockScreen(): Promise<void> {
    await this.keystroke({ key: "q", modifiers: ["command", "control"] });
  }

  async setDarkMode(on: boolean): Promise<void> {
    await osa(
      `tell application "System Events" to tell appearance preferences to set dark mode to ${on ? "true" : "false"}`,
    );
  }

  async setDoNotDisturb(on: boolean): Promise<void> {
    // There is no scripting interface for Focus; the Shortcuts action is the
    // only supported route.
    await exec("/usr/bin/shortcuts", ["run", on ? "Turn On Do Not Disturb" : "Turn Off Do Not Disturb"], {
      timeout: 10_000,
    });
  }

  async emptyTrash(): Promise<void> {
    // Finder hangs here on macOS 26 when the Trash is already empty, which is
    // exactly why every osascript call has a hard outer kill.
    const r = await runAppleScript(`tell application "Finder" to empty trash`, { timeoutMs: 8000 });
    if (!r.ok && !r.timedOut) throw new Error(r.stderr || "Could not empty the Trash");
  }

  // --- media -------------------------------------------------------------

  mediaPlayPause = () => this.keyCode(16, true);
  mediaNext = () => this.keyCode(17, true);
  mediaPrevious = () => this.keyCode(18, true);

  // --- input -------------------------------------------------------------

  async keystroke(combo: KeyCombo): Promise<void> {
    const mods = (combo.modifiers ?? []).map((m) => MODIFIER_NAMES[m]).filter(Boolean);
    const using = mods.length ? ` using {${mods.join(", ")}}` : "";
    const code = KEY_CODES[combo.key.toLowerCase()];
    const action =
      code !== undefined ? `key code ${code}${using}` : `keystroke ${asStr(combo.key)}${using}`;
    try {
      await osa(`tell application "System Events" to ${action}`, { timeoutMs: 5000 });
    } catch (err) {
      throw translatePermissionError(err, "accessibility");
    }
  }

  /** Raw key code, optionally as a media key. */
  private async keyCode(code: number, media = false): Promise<void> {
    if (media) {
      // Media keys are NX system-defined events; AppleScript cannot post them,
      // so drive the frontmost media app instead.
      const script = `
tell application "System Events"
  if (exists process "Music") then
    tell application "Music" to ${code === 16 ? "playpause" : code === 17 ? "next track" : "previous track"}
  else if (exists process "Spotify") then
    tell application "Spotify" to ${code === 16 ? "playpause" : code === 17 ? "next track" : "previous track"}
  end if
end tell`;
      await osa(script, { timeoutMs: 6000 });
      return;
    }
    await osa(`tell application "System Events" to key code ${code}`, { timeoutMs: 5000 });
  }

  /**
   * The same key several times, in one osascript run. Each run costs 100-200 ms
   * to spawn, so "scroll down five times" used to take most of a second.
   */
  private async repeatKeyCode(code: number, times: number): Promise<void> {
    if (times <= 1) return this.keyCode(code);
    try {
      await osa(
        `tell application "System Events"\nrepeat ${times} times\nkey code ${code}\ndelay 0.02\nend repeat\nend tell`,
        { timeoutMs: 5000 },
      );
    } catch (err) {
      throw translatePermissionError(err, "accessibility");
    }
  }

  async typeText(text: string): Promise<void> {
    if (!text) return;
    // `keystroke` is layout-dependent and painfully slow for a sentence, so
    // dictated text goes through the pasteboard and a Cmd-V.
    //
    // Electron 44's clipboard API is promise-based (modelled on the W3C one),
    // so every call here is awaited.
    const previous = await clipboard.readText().catch(() => "");
    await clipboard.writeText(text);
    await this.keystroke({ key: "v", modifiers: ["command"] });

    // Put the user's clipboard back — but only once the paste has landed, and
    // only if nothing else has claimed the clipboard since. Restoring too eagerly
    // is the single most common dictation bug: the paste races the restore and
    // the user gets their *old* clipboard pasted into the document instead.
    setTimeout(() => {
      void (async () => {
        try {
          if ((await clipboard.readText()) === text) await clipboard.writeText(previous);
        } catch {
          // Leaving our text on the clipboard is a far better failure than
          // clobbering something the user copied in the meantime.
        }
      })();
    }, 700);
  }

  async scroll(direction: "up" | "down", amount: number): Promise<void> {
    const code = direction === "up" ? KEY_CODES.pageup! : KEY_CODES.pagedown!;
    await this.repeatKeyCode(code, Math.max(1, Math.min(20, amount)));
  }

  // --- web & files -------------------------------------------------------

  async browse(url: string, browser: string | undefined, where: "current" | "new-tab"): Promise<void> {
    const safe = withScheme(url);
    const family = browser ? scriptFamily(browser) : null;
    if (browser && family && (await this.runningApps()).includes(browser)) {
      try {
        await osa(browseScript(browser, family, safe, where), { timeoutMs: 5000 });
        return;
      } catch {
        // Not allowed to control it (yet), or it said no: `open` still works.
      }
    }
    // `open -a` opens the link in that browser, launching it if need be;
    // plain `open` hands it to whichever browser LaunchServices picks.
    await exec("/usr/bin/open", browser ? ["-a", browser, safe] : [safe], { timeout: 6000 });
  }

  async browserTab(browser: string): Promise<BrowserTab | null> {
    const family = scriptFamily(browser);
    // Asking a browser that is not running would launch it, just to ask.
    if (!family || !(await this.runningApps()).includes(browser)) return null;
    const out = await osa(frontTabScript(browser, family), { timeoutMs: 3000 }).catch(() => "");
    return parseFrontTab(out);
  }

  /**
   * The browser links open in, by name. LaunchServices keeps the choice by
   * bundle id in a preferences file; no entry means the user never changed
   * it, and Safari is the default.
   */
  async defaultBrowser(): Promise<string> {
    if (this.browserCache && Date.now() - this.browserCache.at < APP_CACHE_MS) return this.browserCache.name;
    let name = "Safari";
    try {
      const { stdout } = await exec(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", path.join(app.getPath("home"), LAUNCH_SERVICES_PREFS)],
        { timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
      );
      const id = defaultBrowserId(JSON.parse(stdout))?.toLowerCase();
      // Recorded in lower case ("com.google.chrome"); the bundle's own id is not.
      const found = id ? (await this.listApps()).find((a) => a.id?.toLowerCase() === id) : undefined;
      if (found) name = found.name;
    } catch {
      // No preferences file yet: nobody changed the default.
    }
    this.browserCache = { at: Date.now(), name };
    return name;
  }

  async screenshot(mode: "screen" | "selection" | "window"): Promise<string> {
    const file = path.join(
      app.getPath("desktop"),
      `Screenshot ${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    );
    const args = mode === "selection" ? ["-i"] : mode === "window" ? ["-iW"] : ["-x"];
    try {
      await exec("/usr/sbin/screencapture", [...args, file], { timeout: 60_000 });
    } catch (err) {
      throw translatePermissionError(err, "screenRecording");
    }
    return file;
  }

  async revealInFiles(target: string): Promise<void> {
    await exec("/usr/bin/open", ["-R", target], { timeout: 5000 });
  }

  // --- on screen ---------------------------------------------------------

  async click(target: ClickTarget): Promise<ClickResult> {
    const helper = screenHelper();
    const args = "nth" in target ? ["click", "--nth", String(target.nth)] : ["click", "--text", target.text];
    let stdout: string;
    try {
      ({ stdout } = await exec(helper, args, { timeout: 8000 }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(app.isPackaged ? "The clicking helper is missing. Reinstall JVA." : "Build the clicking helper first: npm run setup");
      }
      throw err;
    }
    const r = JSON.parse(stdout) as { ok: boolean; label?: string; url?: string; error?: string; message?: string };
    if (!r.ok) {
      if (r.error === "no-permission") {
        throw new Error("Accessibility permission is needed to click things on screen. Grant it in Settings → Permissions.");
      }
      throw new Error(r.message ?? "Could not click that");
    }
    return { label: r.label ?? "", ...(r.url ? { url: r.url } : {}) };
  }

  // --- camera & settings -------------------------------------------------

  /**
   * Photo Booth is the Mac's camera app, and its Take Photo command runs the
   * same three-second countdown as its shutter button — time to smile. The
   * command stays disabled until the camera has started, so keep trying for a
   * few seconds rather than failing on a cold start. It is found by name in
   * whichever menu holds it.
   */
  async takePhoto(): Promise<void> {
    await this.openApp("Photo Booth");
    if (!(await this.waitForFrontmost((a) => a === "Photo Booth", 4000))) {
      throw new Error("Photo Booth did not open");
    }
    const script = `
tell application "System Events"
  tell process "Photo Booth"
    repeat 60 times
      repeat with m in menu bar items of menu bar 1
        try
          set item_ to menu item "Take Photo" of menu 1 of m
          if enabled of item_ then
            click item_
            return "taken"
          end if
        end try
      end repeat
      delay 0.1
    end repeat
  end tell
end tell
return "unavailable"`;
    let out: string;
    try {
      out = await osa(script, { timeoutMs: 10_000 });
    } catch (err) {
      throw translatePermissionError(err, "accessibility");
    }
    if (out !== "taken") throw new Error("Photo Booth is open, but its camera did not start");
  }

  async openSettingsPane(id: string): Promise<void> {
    await exec("/usr/bin/open", [`x-apple.systempreferences:${id}`], { timeout: 6000 });
  }
}
