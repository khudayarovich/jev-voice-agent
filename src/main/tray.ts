import { Menu, Tray, app, nativeImage } from "electron";
import type { AgentState } from "../shared/types";
import { resource } from "./paths";

/**
 * The menu-bar indicator.
 *
 * The tray carries STATE ONLY, never the transcript. Streaming text into
 * `setTitle` reflows the whole menu bar on every update and gets truncated
 * unpredictably when other items compete for space — the transcript belongs in
 * the HUD panel instead.
 */

let tray: Tray | null = null;
let current: AgentState = "idle";

interface TrayCallbacks {
  onToggleListening: () => void;
  onOpenSettings: () => void;
  onQuit: () => void;
  isListening: () => boolean;
}

let cbs: TrayCallbacks | null = null;

const LABEL: Record<AgentState, string> = {
  disabled: "Listening off",
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  executing: "Running…",
  confirming: "Confirm?",
  error: "Error",
};

function iconFor(state: AgentState) {
  // Filename must end in `Template` (with a matching @2x) for macOS to tint it
  // automatically for light/dark menu bars and the clicked state.
  const img = nativeImage.createFromPath(resource("icons", `${state}Template.png`));
  img.setTemplateImage(true);
  return img;
}

function buildMenu(): Menu {
  const listening = cbs?.isListening() ?? false;
  return Menu.buildFromTemplate([
    { label: `Jev — ${LABEL[current]}`, enabled: false },
    { type: "separator" },
    {
      label: listening ? "Pause listening" : "Resume listening",
      accelerator: "",
      click: () => cbs?.onToggleListening(),
    },
    { type: "separator" },
    { label: "Settings…", accelerator: "Command+,", click: () => cbs?.onOpenSettings() },
    { type: "separator" },
    { label: "Quit Jev Voice Agent", accelerator: "Command+Q", click: () => cbs?.onQuit() },
  ]);
}

export function createTray(callbacks: TrayCallbacks): Tray {
  cbs = callbacks;
  tray = new Tray(iconFor("idle"));
  tray.setToolTip("Jev Voice Agent");
  tray.setContextMenu(buildMenu());
  return tray;
}

export function setTrayState(state: AgentState): void {
  if (!tray || tray.isDestroyed()) return;
  if (state === current) return;
  current = state;
  tray.setImage(iconFor(state));
  tray.setToolTip(`Jev Voice Agent — ${LABEL[state]}`);
  // Rebuild so the pause/resume item and the status line stay accurate.
  tray.setContextMenu(buildMenu());
}

export function refreshTrayMenu(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/** Keep the app alive with no windows open — it lives in the menu bar. */
export function hideDock(): void {
  // LSUIElement in Info.plist is the one that really matters (it prevents the
  // icon from ever appearing); this is belt-and-braces for the dev build, where
  // we run under Electron's own Info.plist.
  if (process.platform === "darwin") app.dock?.hide();
}
