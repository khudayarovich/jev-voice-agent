import { Menu, Tray, app, nativeImage } from "electron";
import type { AgentState } from "../shared/types.ts";
import { resource } from "./paths.ts";

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
  onAbout: () => void;
  onQuit: () => void;
  isListening: () => boolean;
}

let cbs: TrayCallbacks | null = null;

const LABEL: Record<AgentState, string> = {
  disabled: "Listening off",
  idle: "Ready",
  conversing: "Listening for more",
  listening: "Listening…",
  thinking: "Thinking…",
  executing: "Running…",
  confirming: "Confirm?",
  error: "Error",
};

const images = new Map<string, Electron.NativeImage>();

function image(name: string): Electron.NativeImage {
  let img = images.get(name);
  if (!img) {
    // Filename must end in `Template` (with a matching @2x) for macOS to tint it
    // automatically for light/dark menu bars and the clicked state.
    img = nativeImage.createFromPath(resource("icons", `${name}Template.png`));
    img.setTemplateImage(true);
    images.set(name, img);
  }
  return img;
}

function iconFor(state: AgentState) {
  return image(state);
}

/**
 * The active states move: an equalizer that dances while it hears you, dots
 * that take turns while it thinks, a wave that breathes while the conversation
 * is open. Motion answers "is it listening?" faster than any glyph. At rest the
 * icon is still.
 */
const ANIMATIONS: Partial<Record<AgentState, { frames: number[]; ms: number }>> = {
  listening: { frames: [0, 1, 2, 3, 4, 5], ms: 110 },
  thinking: { frames: [0, 1, 2], ms: 200 },
  conversing: { frames: [0, 1, 2, 1], ms: 450 },
};

let animation: ReturnType<typeof setInterval> | null = null;

function animate(state: AgentState): void {
  if (animation) clearInterval(animation);
  animation = null;
  const spec = ANIMATIONS[state];
  if (!spec || !tray) return;
  let i = 0;
  animation = setInterval(() => {
    if (!tray || tray.isDestroyed()) return;
    i = (i + 1) % spec.frames.length;
    tray.setImage(image(`${state}-${spec.frames[i]}`));
  }, spec.ms);
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
    { label: "About JVA", click: () => cbs?.onAbout() },
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
  animate(state);
  tray.setToolTip(`Jev Voice Agent — ${LABEL[state]}`);
  // Rebuild so the pause/resume item and the status line stay accurate.
  tray.setContextMenu(buildMenu());
}

export function refreshTrayMenu(): void {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

export function destroyTray(): void {
  if (animation) clearInterval(animation);
  animation = null;
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
