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

/** What a browser's front tab is showing. */
export interface BrowserTab {
  url: string;
  title: string;
}

/** What to click: words on the thing, or the nth search result. */
export type ClickTarget = { text: string } | { nth: number };

/** What was clicked. */
export interface ClickResult {
  label: string;
  /** Where it leads, for a link. */
  url?: string;
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
  /** Apps with a window showing on this desktop; a running app may have none. */
  windowedApps(): Promise<string[]>;
  /** Just the frontmost app's name — cheaper than `focus()`. */
  frontApp(): Promise<string>;
  /**
   * Resolve true once the frontmost app passes `test`, false on timeout. Used
   * between chained commands, so "open Safari and open a new tab" sends its
   * Cmd-T to Safari rather than to whatever was in front a moment ago.
   */
  waitForFrontmost(test: (app: string) => boolean, timeoutMs: number): Promise<boolean>;
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
  setWifi(on: boolean): Promise<void>;
  /** Flips the switch in Settings, and fails unless it really changed. */
  setBluetooth(on: boolean): Promise<void>;
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
  /**
   * Show a page in a browser, in its front window: in the tab in front, or a
   * new one beside it. Launches the browser, or opens a window, if need be.
   * No browser named: the system default decides.
   */
  browse(url: string, browser: string | undefined, where: "current" | "new-tab"): Promise<void>;
  /** A browser's front tab, or null: not running, no window, or it cannot say. */
  browserTab(browser: string): Promise<BrowserTab | null>;
  /** The app that opens links by default, e.g. "Safari". */
  defaultBrowser(): Promise<string>;
  screenshot(mode: "screen" | "selection" | "window"): Promise<string>;
  revealInFiles(path: string): Promise<void>;

  // --- on screen ---------------------------------------------------------
  /** Press a link or button in the window in front, found by its words or position. */
  click(target: ClickTarget): Promise<ClickResult>;
  /** Choose a menu item of the app in front: ["File", "New Folder"], or three deep. */
  chooseMenuItem(path: string[]): Promise<void>;

  // --- camera & settings -------------------------------------------------
  /** Take a picture with the built-in camera, the way the user would. */
  takePhoto(): Promise<void>;
  /** Open one page of the system settings, by its identifier. */
  openSettingsPane(id: string): Promise<void>;
}

/** Thrown by the Windows scaffold for anything not yet ported. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented on this platform yet.`);
    this.name = "NotImplementedError";
  }
}
