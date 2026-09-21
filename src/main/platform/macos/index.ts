import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, clipboard } from "electron";
import type { AppInfo, FocusContext, KeyCombo, PlatformAdapter } from "../types.ts";
import { asStr, osa, runAppleScript } from "./osascript.ts";

const exec = promisify(execFile);

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
  if (kind === "accessibility" && /not allowed to send keystrokes|1002/.test(text)) {
    return new Error(
      "Accessibility permission is needed to press keys. Grant it in Settings → Permissions.",
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

  // --- discovery ---------------------------------------------------------

  /**
   * Installed apps, read straight off disk.
   *
   * This is the candidate list the router picks from, so it must be the real
   * set: the model can only ever return a name that appeared here.
   */
  async listApps(): Promise<AppInfo[]> {
    if (this.appCache && Date.now() - this.appCache.at < 60_000) return this.appCache.apps;

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
    await this.attachLastUsed(apps);
    this.appCache = { at: Date.now(), apps };
    return apps;
  }

  /**
   * Annotate apps with when they were last launched, via Spotlight.
   *
   * This is the ranking signal that makes the speech vocabulary prompt useful.
   * whisper's prompt is bounded at a couple of hundred tokens, so on a Mac with
   * a hundred apps the list has to be cut somewhere — and cutting it
   * alphabetically drops Safari, Slack, Terminal and Xcode while keeping every
   * utility beginning with "A". Recency is a far better predictor of what the
   * user is about to say. One `mdls` call covers every app in about 70 ms.
   */
  private async attachLastUsed(apps: AppInfo[]): Promise<void> {
    const paths = apps.map((a) => a.path).filter((p): p is string => Boolean(p));
    if (paths.length === 0) return;
    try {
      const { stdout } = await exec(
        "/usr/bin/mdls",
        ["-name", "kMDItemLastUsedDate", "-name", "kMDItemFSName", ...paths],
        { timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
      );
      const byName = new Map<string, number>();
      let currentName = "";
      for (const line of stdout.split("\n")) {
        const nameMatch = line.match(/kMDItemFSName\s*=\s*"(.+)\.app"/);
        if (nameMatch?.[1]) {
          currentName = nameMatch[1];
          continue;
        }
        const dateMatch = line.match(/kMDItemLastUsedDate\s*=\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        if (dateMatch?.[1] && currentName) {
          const ms = Date.parse(`${dateMatch[1].replace(" ", "T")}Z`);
          if (Number.isFinite(ms)) byName.set(currentName, ms);
        }
      }
      for (const app of apps) {
        const ms = byName.get(app.name);
        if (ms !== undefined) app.lastUsed = ms;
      }
    } catch {
      // Spotlight may be disabled or indexing; ranking simply falls back to
      // alphabetical, which still works.
    }
  }

  async runningApps(): Promise<string[]> {
    const out = await osa(
      `tell application "System Events" to get name of every application process whose background only is false`,
      { timeoutMs: 4000 },
    ).catch(() => "");
    return out ? out.split(", ").map((s) => s.trim()).filter(Boolean) : [];
  }

  async focus(): Promise<FocusContext> {
    // One round trip for both values: each osascript spawn costs ~100 ms.
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
   * its name.
   */
  async listAutomations(): Promise<string[]> {
    try {
      const { stdout } = await exec("/usr/bin/shortcuts", ["list"], { timeout: 4000 });
      return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
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
    // Give the window server a moment to actually make it frontmost, or the
    // keystroke lands on the previous app.
    await new Promise((r) => setTimeout(r, 250));
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
    for (let i = 0; i < Math.max(1, Math.min(16, steps)); i++) await this.keyCode(code);
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
    for (let i = 0; i < Math.max(1, Math.min(20, amount)); i++) await this.keyCode(code);
  }

  // --- web & files -------------------------------------------------------

  async openUrl(url: string): Promise<void> {
    const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await exec("/usr/bin/open", [safe], { timeout: 6000 });
  }

  async webSearch(query: string): Promise<void> {
    await this.openUrl(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
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
}
