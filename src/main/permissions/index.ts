import { shell, systemPreferences } from "electron";
import type { PermissionId, PermissionInfo, PermissionState } from "../../shared/types.ts";
import { AE_ERRORS, runAppleScript } from "../platform/macos/osascript.ts";

/**
 * macOS TCC handling.
 *
 * Two principles from the design, both load-bearing:
 *
 *  1. **Ask lazily, in capability order.** Microphone is cheap and expected;
 *     Accessibility is the alarming one and should be earned at the moment the
 *     user first asks for something that types or moves a window. Nothing here
 *     prompts on app launch.
 *
 *  2. **Never trust the cached grant.** `AXIsProcessTrusted()` returning true
 *     while AX calls fail is a real, documented state (it happens routinely
 *     after a re-signing, and after macOS upgrades). So the Settings pane runs a
 *     self-test that actually exercises the capability.
 */

export { resetGrantsIfUpdated } from "./update.ts";

const IS_MAC = process.platform === "darwin";

/**
 * System Settings deep links.
 *
 * These use the modern `com.apple.settings.PrivacySecurity.extension` form. The
 * legacy `com.apple.preference.security?Privacy_X` spelling still works on 26
 * but is the first to degrade.
 *
 * They MUST be opened through LaunchServices (`shell.openExternal`, which is
 * what `openSettings` below does). On macOS 26, handing the same URL to a
 * generic browse API silently drops the anchor and dumps the user on General.
 */
const SETTINGS_URL: Record<PermissionId, string> = {
  microphone:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone",
  accessibility:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
  automation:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
  inputMonitoring:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ListenEvent",
  screenRecording:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
};

interface Descriptor {
  label: string;
  why: string;
  ifMissing: string;
  required: boolean;
  canPrompt: boolean;
}

const DESCRIPTORS: Record<PermissionId, Descriptor> = {
  microphone: {
    label: "Microphone",
    why: "Hears the wake word and your spoken commands. Audio never leaves this Mac.",
    ifMissing: "Nothing works — the agent cannot hear you at all.",
    required: true,
    canPrompt: true,
  },
  accessibility: {
    label: "Accessibility",
    why: "Types dictated text, presses keys, and reads the focused window title for context.",
    ifMissing: "Dictation, keyboard shortcuts, and window management stop working.",
    required: true,
    canPrompt: true,
  },
  automation: {
    label: "Automation",
    why: "Sends Apple Events so it can control apps like Safari, Music, and Finder.",
    ifMissing: "App-specific commands fail. macOS asks separately for each app.",
    required: true,
    // Granted per target app by the system at first use; there is no blanket prompt.
    canPrompt: false,
  },
  inputMonitoring: {
    label: "Input Monitoring",
    why: "Needed only for hold-to-talk, which watches for key press and release.",
    ifMissing: "Hold-to-talk is unavailable. The toggle hotkey and wake word still work.",
    required: false,
    canPrompt: false,
  },
  screenRecording: {
    label: "Screen Recording",
    why: "Optional. Only needed if you enable screenshot commands.",
    ifMissing: "Screenshot commands are unavailable. Everything else is unaffected — window titles are read through Accessibility instead.",
    required: false,
    canPrompt: false,
  },
};

/** Remembered results of probes that would otherwise prompt. */
const probeCache = new Map<PermissionId, PermissionState>();

function mediaStatusToState(s: string): PermissionState {
  switch (s) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "not-determined":
      return "not-determined";
    default:
      return "not-determined";
  }
}

/** Non-prompting status read. Safe to call on every Settings open. */
export function peek(id: PermissionId): PermissionState {
  if (!IS_MAC) return "unsupported";
  switch (id) {
    case "microphone":
      return mediaStatusToState(systemPreferences.getMediaAccessStatus("microphone"));
    case "screenRecording":
      return mediaStatusToState(systemPreferences.getMediaAccessStatus("screen"));
    case "accessibility":
      // `false` = check without showing the system prompt.
      return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "not-determined";
    case "automation":
    case "inputMonitoring":
      // Electron exposes no query for these. Automation can only be discovered by
      // sending an event (which prompts), so we report what a probe last found.
      return probeCache.get(id) ?? "not-determined";
    default:
      return "not-determined";
  }
}

export function list(): PermissionInfo[] {
  return (Object.keys(DESCRIPTORS) as PermissionId[]).map((id) => ({
    id,
    ...DESCRIPTORS[id],
    state: peek(id),
  }));
}

/**
 * Show the real system prompt where one exists.
 *
 * Microphone and Accessibility are the only two that can produce an in-app
 * dialog. Everything else resolves to "open Settings and toggle it yourself",
 * which is a macOS limitation, not an oversight.
 */
export async function request(id: PermissionId): Promise<PermissionState> {
  if (!IS_MAC) return "unsupported";

  if (id === "microphone") {
    const before = peek("microphone");
    if (before === "granted") return "granted";
    if (before === "denied" || before === "restricted") {
      // macOS will not re-prompt after a denial; Settings is the only route.
      await openSettings(id);
      return before;
    }
    const ok = await systemPreferences.askForMediaAccess("microphone");
    return ok ? "granted" : "denied";
  }

  if (id === "accessibility") {
    // `true` shows the "would like to control this computer" dialog — but only
    // once per signing identity. Afterwards it silently returns the cached value,
    // so we fall through to opening Settings when it is still not trusted.
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    if (trusted) return "granted";
    await openSettings(id);
    return "not-determined";
  }

  await openSettings(id);
  return peek(id);
}

export async function openSettings(id: PermissionId): Promise<void> {
  // Must go through LaunchServices so the ?anchor survives on macOS 26.
  await shell.openExternal(SETTINGS_URL[id]);
}

/**
 * Actually exercise the capability rather than trusting TCC's answer.
 *
 * Returns "broken" for the grant-says-yes-but-the-API-fails state, which is what
 * an ad-hoc rebuild or a macOS upgrade typically leaves behind.
 */
export async function selfTest(id: PermissionId): Promise<{
  state: PermissionState;
  detail: string;
}> {
  if (!IS_MAC) return { state: "unsupported", detail: "macOS only." };

  switch (id) {
    case "microphone": {
      const s = peek("microphone");
      return {
        state: s,
        detail:
          s === "granted"
            ? "Granted. Capture is verified when listening starts."
            : "Not granted yet.",
      };
    }

    case "accessibility": {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) return { state: "not-determined", detail: "Not granted yet." };
      // Prove it: ask System Events whether assistive access is actually live.
      const r = await runAppleScript(
        `tell application "System Events" to return UI elements enabled`,
        { timeoutMs: 5000 },
      );
      if (r.ok && r.stdout.toLowerCase() === "true") {
        return { state: "granted", detail: "Verified — assistive access is live." };
      }
      if (r.errorCode === AE_ERRORS.NOT_AUTHORIZED) {
        return {
          state: "granted",
          detail:
            "Accessibility is granted, but Automation for System Events is not — grant that to verify fully.",
        };
      }
      if (r.timedOut) {
        return { state: "broken", detail: "System Events did not respond within 5s." };
      }
      return {
        state: "broken",
        detail:
          "TCC reports granted but the API failed. Toggle this app off and back on in System Settings, then relaunch.",
      };
    }

    case "automation": {
      // This is the probe that can prompt, so it only runs on explicit request.
      const r = await runAppleScript(
        `tell application "System Events" to return name of current user`,
        { timeoutMs: 8000 },
      );
      let state: PermissionState;
      let detail: string;
      if (r.ok) {
        state = "granted";
        detail = "System Events responded. Other apps prompt separately on first use.";
      } else if (r.errorCode === AE_ERRORS.NOT_AUTHORIZED) {
        state = "denied";
        detail = "Denied for System Events. Enable it under Automation in System Settings.";
      } else if (r.timedOut || r.errorCode === AE_ERRORS.TIMEOUT) {
        state = "broken";
        detail = "Apple Event timed out — a known macOS 26 failure mode.";
      } else {
        state = "not-determined";
        detail = r.stderr || "Could not determine.";
      }
      probeCache.set("automation", state);
      return { state, detail };
    }

    case "inputMonitoring":
      return {
        state: peek(id),
        detail: "Only needed for hold-to-talk (a later phase). macOS exposes no query for this.",
      };

    case "screenRecording": {
      const s = peek(id);
      return {
        state: s,
        detail:
          s === "granted"
            ? "Granted."
            : "Not granted — not required. Window titles come from Accessibility instead.",
      };
    }

    default:
      return { state: "not-determined", detail: "" };
  }
}

/** True when every *required* grant is usable. */
export function requiredSatisfied(): boolean {
  return (Object.keys(DESCRIPTORS) as PermissionId[])
    .filter((id) => DESCRIPTORS[id].required)
    .every((id) => {
      const s = peek(id);
      // Automation reports not-determined until probed; don't block startup on it.
      return id === "automation" ? s !== "denied" : s === "granted";
    });
}
