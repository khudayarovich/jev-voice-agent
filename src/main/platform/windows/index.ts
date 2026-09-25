import type { AppInfo, FocusContext, KeyCombo, PlatformAdapter } from "../types.ts";
import { NotImplementedError } from "../types.ts";

/**
 * Windows scaffold.
 *
 * Deliberately unimplemented rather than half-written: everything here was
 * designed against macOS and cannot be verified on Windows from this machine,
 * and a plausible-looking implementation nobody has run is worse than an honest
 * error. The interface is the contract; filling this in is a self-contained job.
 *
 * The intended mapping, for whoever picks it up:
 *
 *   listApps        Start Menu shortcuts, or `Get-StartApps` via PowerShell
 *   openApp         `Start-Process`, or `explorer.exe shell:AppsFolder\\<AUMID>`
 *   focus           GetForegroundWindow + GetWindowText
 *   keystroke       SendInput  (note: UIPI blocks unelevated input to elevated
 *                   windows silently — some windows are simply unreachable)
 *   window mgmt     SetWindowPos / ShowWindow
 *   setVolume       IAudioEndpointVolume via a small helper
 *   listAutomations PowerShell scripts, the analogue of Shortcuts
 *
 * The realistic route is a small C#/FlaUI helper over stdio JSON-RPC, mirroring
 * the Swift helper planned for macOS, so one protocol serves both platforms.
 */
export class WindowsPlatform implements PlatformAdapter {
  readonly platform = "win32" as const;

  private nope(what: string): never {
    throw new NotImplementedError(what);
  }

  listApps(): Promise<AppInfo[]> {
    return Promise.resolve([]);
  }
  runningApps(): Promise<string[]> {
    return Promise.resolve([]);
  }
  focus(): Promise<FocusContext> {
    return Promise.resolve({ app: "" });
  }
  frontApp(): Promise<string> {
    return Promise.resolve("");
  }
  waitForFrontmost(): Promise<boolean> {
    return Promise.resolve(false);
  }
  listAutomations(): Promise<string[]> {
    return Promise.resolve([]);
  }

  openApp(): Promise<void> { this.nope("Opening apps"); }
  quitApp(): Promise<void> { this.nope("Quitting apps"); }
  hideApp(): Promise<void> { this.nope("Hiding apps"); }
  hideOthers(): Promise<void> { this.nope("Hiding other apps"); }
  runAutomation(): Promise<string> { this.nope("Running automations"); }

  closeWindow(): Promise<void> { this.nope("Window control"); }
  closeAppWindow(): Promise<void> { this.nope("Window control"); }
  minimizeWindow(): Promise<void> { this.nope("Window control"); }
  zoomWindow(): Promise<void> { this.nope("Window control"); }
  fullscreenWindow(): Promise<void> { this.nope("Window control"); }
  tileWindow(): Promise<void> { this.nope("Window tiling"); }
  centerWindow(): Promise<void> { this.nope("Window tiling"); }
  cycleWindow(): Promise<void> { this.nope("Window switching"); }
  missionControl(): Promise<void> { this.nope("Mission Control"); }
  showDesktop(): Promise<void> { this.nope("Show desktop"); }
  switchSpace(): Promise<void> { this.nope("Switching spaces"); }

  getVolume(): Promise<number> { this.nope("Volume"); }
  setVolume(): Promise<void> { this.nope("Volume"); }
  setMuted(): Promise<void> { this.nope("Volume"); }
  adjustBrightness(): Promise<void> { this.nope("Brightness"); }
  sleepDisplay(): Promise<void> { this.nope("Display sleep"); }
  sleepSystem(): Promise<void> { this.nope("System sleep"); }
  lockScreen(): Promise<void> { this.nope("Locking the screen"); }
  setDarkMode(): Promise<void> { this.nope("Dark mode"); }
  setDoNotDisturb(): Promise<void> { this.nope("Do Not Disturb"); }
  emptyTrash(): Promise<void> { this.nope("Emptying the Recycle Bin"); }

  mediaPlayPause(): Promise<void> { this.nope("Media keys"); }
  mediaNext(): Promise<void> { this.nope("Media keys"); }
  mediaPrevious(): Promise<void> { this.nope("Media keys"); }

  keystroke(_combo: KeyCombo): Promise<void> { this.nope("Synthetic keystrokes"); }
  typeText(): Promise<void> { this.nope("Typing text"); }
  scroll(): Promise<void> { this.nope("Scrolling"); }

  openUrl(): Promise<void> { this.nope("Opening URLs"); }
  webSearch(): Promise<void> { this.nope("Web search"); }
  screenshot(): Promise<string> { this.nope("Screenshots"); }
  revealInFiles(): Promise<void> { this.nope("Revealing files"); }
}
