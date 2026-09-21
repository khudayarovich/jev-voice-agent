/**
 * The OS abstraction every action runs through.
 *
 * Two implementations: macOS (complete) and Windows (scaffolded). Keeping the
 * registry on this side of the boundary is what makes the Windows port a matter
 * of filling in one folder rather than rewriting the agent.
 */

export interface AppInfo {
  name: string;
  /** Bundle id on macOS; executable name on Windows. */
  id?: string;
  path?: string;
  /** Epoch ms of last launch, when the OS knows. Used to rank likely referents. */
  lastUsed?: number;
}

export interface FocusContext {
  app: string;
  bundleId?: string;
  windowTitle?: string;
}

/** A modifier + key combination, expressed the way a user would say it. */
export interface KeyCombo {
  key: string;
  modifiers?: ("command" | "control" | "option" | "shift" | "fn")[];
}

export interface PlatformAdapter {
  readonly platform: "darwin" | "win32";

  // --- discovery ---------------------------------------------------------
  listApps(): Promise<AppInfo[]>;
  runningApps(): Promise<string[]>;
  focus(): Promise<FocusContext>;
  /** User-authored automations that become voice-callable for free. */
  listAutomations(): Promise<string[]>;

  // --- applications ------------------------------------------------------
  openApp(name: string): Promise<void>;
  quitApp(name: string): Promise<void>;
  hideApp(name: string): Promise<void>;
  hideOthers(): Promise<void>;
  runAutomation(name: string): Promise<string>;

  // --- windows -----------------------------------------------------------
  closeWindow(): Promise<void>;
  /** Bring an app forward, then close its front window. */
  closeAppWindow(name: string): Promise<void>;
  minimizeWindow(): Promise<void>;
  zoomWindow(): Promise<void>;
  fullscreenWindow(): Promise<void>;
  tileWindow(side: "left" | "right"): Promise<void>;
  centerWindow(): Promise<void>;
  cycleWindow(): Promise<void>;
  missionControl(): Promise<void>;
  showDesktop(): Promise<void>;
  switchSpace(direction: "left" | "right"): Promise<void>;

  // --- system ------------------------------------------------------------
  getVolume(): Promise<number>;
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  adjustBrightness(direction: "up" | "down", steps: number): Promise<void>;
  sleepDisplay(): Promise<void>;
  sleepSystem(): Promise<void>;
  lockScreen(): Promise<void>;
  setDarkMode(on: boolean): Promise<void>;
  setDoNotDisturb(on: boolean): Promise<void>;
  emptyTrash(): Promise<void>;

  // --- media -------------------------------------------------------------
  mediaPlayPause(): Promise<void>;
  mediaNext(): Promise<void>;
  mediaPrevious(): Promise<void>;

  // --- input -------------------------------------------------------------
  keystroke(combo: KeyCombo): Promise<void>;
  typeText(text: string): Promise<void>;
  scroll(direction: "up" | "down", amount: number): Promise<void>;

  // --- web & files -------------------------------------------------------
  openUrl(url: string): Promise<void>;
  webSearch(query: string): Promise<void>;
  screenshot(mode: "screen" | "selection" | "window"): Promise<string>;
  revealInFiles(path: string): Promise<void>;
}

/** Thrown by the Windows scaffold for anything not yet ported. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented on this platform yet.`);
    this.name = "NotImplementedError";
  }
}
