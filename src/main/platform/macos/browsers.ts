import type { TabChoice } from "../../actions/browsing.ts";
import { asStr } from "./osascript.ts";

/**
 * Talking to browsers about their tabs, in AppleScript.
 *
 * Safari and the Chromium family (Chrome, Edge, Brave, Vivaldi) can say what
 * their front tab shows and load a page into it, or into a new tab of the same
 * window. `open -a <browser> <url>` cannot: Safari answers it with a new window,
 * which is how one search used to end up in a window of its own. Browsers
 * without a dictionary for this (Firefox, Arc) still get `open -a`, which puts
 * the page in a new tab.
 *
 * The first time, macOS asks the user to let JVA control that browser. Until
 * they do, or if they say no, every call here fails and the caller falls back.
 *
 * Only builds script text: pure, and tested as such.
 */

export type ScriptFamily = "chromium" | "safari";

const CHROMIUM = new Set([
  "Google Chrome", "Google Chrome Beta", "Google Chrome Dev", "Google Chrome Canary", "Chromium",
  "Microsoft Edge", "Microsoft Edge Beta", "Microsoft Edge Dev", "Microsoft Edge Canary",
  "Brave Browser", "Brave Browser Beta", "Brave Browser Nightly", "Vivaldi",
]);

export function scriptFamily(browser: string): ScriptFamily | null {
  if (browser === "Safari" || browser === "Safari Technology Preview") return "safari";
  return CHROMIUM.has(browser) ? "chromium" : null;
}

/** Prints the front tab's address, a line break, and its title — or nothing. */
export function frontTabScript(browser: string, family: ScriptFamily): string {
  if (family === "chromium") {
    return `
tell application ${asStr(browser)}
  if (count of windows) is 0 then return ""
  set t to active tab of front window
  return (URL of t) & linefeed & (title of t)
end tell`;
  }
  // Safari's Settings window is a window without tabs: skip past it. Its start
  // page has no address at all.
  return `
tell application ${asStr(browser)}
  repeat with w in windows
    try
      set t to current tab of w
      set u to URL of t
      if u is missing value then set u to ""
      return u & linefeed & (name of t)
    end try
  end repeat
  return ""
end tell`;
}

/** Loads `url` into the front tab, or a new tab of the front window; a window if none. */
export function browseScript(browser: string, family: ScriptFamily, url: string, where: TabChoice): string {
  const u = asStr(url);
  if (family === "chromium") {
    const load =
      where === "current"
        ? `set URL of active tab of w to ${u}`
        : `tell w to make new tab at end of tabs with properties {URL:${u}}
    set active tab index of w to (count of tabs of w)`;
    return `
tell application ${asStr(browser)}
  if (count of windows) is 0 then
    make new window
    set URL of active tab of front window to ${u}
  else
    set w to front window
    ${load}
  end if
  activate
end tell`;
  }
  const load =
    where === "current"
      ? `set URL of current tab of target to ${u}`
      : `tell target to set current tab to (make new tab at end of tabs with properties {URL:${u}})`;
  return `
tell application ${asStr(browser)}
  set target to missing value
  repeat with w in windows
    try
      set t to current tab of w
      set target to contents of w
      exit repeat
    end try
  end repeat
  if target is missing value then
    make new document with properties {URL:${u}}
  else
    ${load}
    set index of target to 1
  end if
  activate
end tell`;
}

/** "https://…\nTitle" → its parts; nothing printed means no window. */
export function parseFrontTab(out: string): { url: string; title: string } | null {
  if (!out.trim()) return null;
  const [url = "", ...rest] = out.split("\n");
  return { url: url.trim(), title: rest.join("\n").trim() };
}
