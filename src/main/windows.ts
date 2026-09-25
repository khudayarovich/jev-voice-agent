import { BrowserWindow, nativeTheme, screen, shell } from "electron";
import { IPC } from "../shared/ipc.ts";
import { preloadFile, rendererFile } from "./paths.ts";

/**
 * Window construction.
 *
 * The HUD recipe here is not arbitrary — each flag fixes a specific, observed
 * failure, and dropping any one of them produces a different bug. See the notes
 * inline before changing anything.
 */

let settingsWin: BrowserWindow | null = null;
let hudWin: BrowserWindow | null = null;
let captureWin: BrowserWindow | null = null;

export function openSettings(tab?: string): BrowserWindow {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send(IPC.showTab, tab);
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 780,
    height: 680,
    minWidth: 640,
    minHeight: 520,
    title: "Jev Voice Agent",
    titleBarStyle: "hiddenInset",
    // Match the page, or a light-mode user sees a dark flash while it loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1f" : "#f5f5f7",
    show: false,
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.once("ready-to-show", () => settingsWin?.show());
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  // Links (the About page's GitHub link, say) open in the user's browser. The
  // settings window itself never navigates anywhere or opens another window:
  // it is a privileged page with a bridge to the main process.
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  settingsWin.webContents.on("will-navigate", (e) => e.preventDefault());
  void settingsWin.loadFile(rendererFile("settings"), tab ? { hash: tab } : {});
  return settingsWin;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
}

/**
 * The transcript overlay.
 *
 * - `type: "panel"` makes this an NSNonactivatingPanel. Without it the overlay
 *   vanishes the moment the user is in a fullscreen app.
 * - `focusable: false` keeps it from stealing key focus — otherwise dictated
 *   text lands in the HUD instead of the user's document.
 * - Always-on-top level must be `screen-saver`: Electron places every level from
 *   `floating` through `status` *below the Dock* on macOS.
 * - `skipTransformProcessType` avoids the dock/window flicker that
 *   setVisibleOnAllWorkspaces otherwise causes under LSUIElement.
 * - Size is FIXED. Resizing a transparent window on macOS flickers badly, so
 *   long transcripts scroll and clip inside a constant box.
 */
export function createHud(): BrowserWindow {
  if (hudWin && !hudWin.isDestroyed()) return hudWin;

  // Room around the 540-px pill for its shadow and its spring, which would
  // otherwise be clipped by the window edge. The window is click-through, so
  // the margin blocks nothing.
  const width = 620;
  const height = 112;
  const { workArea } = screen.getPrimaryDisplay();
  hudWin = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + 2),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    type: "panel",
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The HUD owns the long-lived AudioContext used for earcons; throttling it
      // would add tens of milliseconds of jitter to every cue.
      backgroundThrottling: false,
    },
  });

  hudWin.setAlwaysOnTop(true, "screen-saver");
  hudWin.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  // Click-through, but still receives hover so interactive bits can opt back in.
  hudWin.setIgnoreMouseEvents(true, { forward: true });

  hudWin.on("closed", () => {
    hudWin = null;
  });
  void hudWin.loadFile(rendererFile("hud"));
  return hudWin;
}

export function getHud(): BrowserWindow | null {
  return hudWin && !hudWin.isDestroyed() ? hudWin : null;
}

let hudHideTimer: ReturnType<typeof setTimeout> | null = null;

export function showHud(): void {
  if (hudHideTimer) clearTimeout(hudHideTimer);
  hudHideTimer = null;
  const w = getHud();
  if (!w) return;
  // showInactive, never show(): show() would focus the panel and break dictation.
  if (!w.isVisible()) w.showInactive();
}

/**
 * Hide the overlay — after its exit animation. Hiding the window at once cut
 * the pill off mid-frame, so it never got to animate out at all.
 */
export function hideHud(): void {
  const w = getHud();
  if (!w?.isVisible() || hudHideTimer) return;
  hudHideTimer = setTimeout(() => {
    hudHideTimer = null;
    getHud()?.hide();
  }, 320);
}

/**
 * Hidden window that owns microphone capture.
 *
 * Capturing here rather than in a spawned helper means the TCC prompt is
 * attributed to the main, signed app bundle — helper binaries spawned by
 * Electron do not reliably get their own prompts.
 */
export function createCapture(): BrowserWindow {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureWin = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    webPreferences: {
      preload: preloadFile(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Without this the always-on listener dies whenever the window is hidden.
      backgroundThrottling: false,
    },
  });
  captureWin.on("closed", () => {
    captureWin = null;
  });
  void captureWin.loadFile(rendererFile("capture"));
  return captureWin;
}

export function getCapture(): BrowserWindow | null {
  return captureWin && !captureWin.isDestroyed() ? captureWin : null;
}
