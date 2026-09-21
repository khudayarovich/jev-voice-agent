import { BrowserWindow, app, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings, PermissionId } from "../shared/types.ts";
import { ACTIONS, ACTION_KEYS } from "./actions/registry.ts";
import { applySettings, getPipeline, shutdown, startListening, stopListening } from "./agent.ts";
import { platform } from "./platform/index.ts";
import { coordinator } from "./coordinator.ts";
import { getLogPath, initLog, log } from "./log.ts";
import * as jev from "./jev/client.ts";
import * as permissions from "./permissions/index.ts";
import {
  apiKeySummary,
  getSettings,
  setApiKey,
  updateSettings,
} from "./settings-store.ts";
import { createTray, destroyTray, hideDock, refreshTrayMenu, setTrayState } from "./tray.ts";
import { resource } from "./paths.ts";
import { createHud, getHud, getSettingsWindow, openSettings } from "./windows.ts";

// A menu-bar agent must never run twice: two trays, two hotkey registrations,
// two microphone consumers.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
  void main();
}

/**
 * A throw in the audio path arrives ~15 times a second, and Electron's default
 * handler puts up a modal dialog for each one. Catch it, stop the loop so it
 * cannot repeat, and show the reason in the UI instead.
 */
function installCrashGuard(): void {
  process.on("uncaughtException", (err) => {
    log("app", "uncaughtException", { message: err.message, stack: err.stack });
    try {
      stopListening();
    } catch {
      // Nothing useful left to do.
    }
    coordinator.setState("error", err.message);
  });
  process.on("unhandledRejection", (reason) => {
    log("app", "unhandledRejection", { reason: String(reason) });
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  initLog();
  installCrashGuard();
  hideDock();

  createTray({
    isListening: () => coordinator.isListening(),
    onToggleListening: () => {
      if (coordinator.isListening()) stopListening();
      else void startListening();
    },
    onOpenSettings: () => openSettings(),
    onQuit: () => {
      app.quit();
    },
  });

  createHud();
  registerIpc();

  // Fan coordinator changes out to the tray and every open renderer.
  coordinator.on("state", (state) => {
    setTrayState(state);
    broadcast(IPC.agentStateChanged, state);
  });
  coordinator.on("hud", (model) => {
    getHud()?.webContents.send(IPC.hudUpdate, model);
  });
  coordinator.on("listening", () => refreshTrayMenu());
  coordinator.on("log", (entry) => broadcast(IPC.logAppended, entry));

  setTrayState("disabled");

  // Open Settings on first run so the user lands on the permissions and API-key
  // pane rather than wondering what the new menu-bar icon is.
  const configured = apiKeySummary().present && permissions.requiredSatisfied();
  if (!configured) {
    openSettings();
    return;
  }

  // Already set up: start listening without being asked. Needing to open a
  // settings window before the agent will listen is not what anyone wants from
  // something that lives in the menu bar.
  if (getSettings().listenOnStart) {
    log("app", "auto-start", {});
    void startListening();
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => getSettings());

  ipcMain.handle(IPC.setSettings, (_e, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch);
    // Base URL or model changes must rebuild the Jev client.
    jev.invalidate();
    applySettings(next);
    if (typeof patch.launchAtLogin === "boolean") {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    return next;
  });

  ipcMain.handle(IPC.getApiKeyInfo, () => apiKeySummary());

  ipcMain.handle(IPC.setApiKey, (_e, key: string) => {
    setApiKey(String(key ?? ""));
    jev.invalidate();
  });

  ipcMain.handle(IPC.probeApiKey, () => jev.probe());

  ipcMain.handle(IPC.listPermissions, () => permissions.list());
  ipcMain.handle(IPC.requestPermission, (_e, id: PermissionId) => permissions.request(id));
  ipcMain.handle(IPC.openPermissionSettings, (_e, id: PermissionId) =>
    permissions.openSettings(id),
  );
  ipcMain.handle(IPC.selfTestPermission, (_e, id: PermissionId) => permissions.selfTest(id));

  ipcMain.handle(IPC.getAgentState, () => ({
    state: coordinator.getState(),
    listening: coordinator.isListening(),
  }));

  ipcMain.handle(IPC.setListening, async (_e, on: boolean) => {
    if (on) await startListening();
    else stopListening();
  });

  // One-way, high frequency: ~15 blocks a second for as long as the app listens.
  ipcMain.on(IPC.audioFrames, (_e, pcm: Int16Array, level: number) => {
    getPipeline()?.acceptFrames(pcm, level);
  });

  ipcMain.on(IPC.audioStatus, (_e, status: { running: boolean; error?: string; sampleRate?: number }) => {
    log("capture", "status", { ...status });
    if (status.error) {
      coordinator.setState("error", `Microphone unavailable: ${status.error}`);
      coordinator.setListening(false);
    }
  });

  ipcMain.handle(IPC.getLog, () => coordinator.getLog());

  ipcMain.handle(IPC.listActions, async () => {
    const base = ACTION_KEYS.map((key) => ({
      key,
      describe: ACTIONS[key].describe,
      examples: ACTIONS[key].examples,
      destructive: ACTIONS[key].destructive === true,
      slots: Object.keys(ACTIONS[key].slots),
    }));
    // The user's own Shortcuts are voice-callable too, so show them here rather
    // than leaving the command list looking shorter than it is.
    const automations = await platform().listAutomations().catch(() => [] as string[]);
    return [
      ...base,
      ...automations.map((name) => ({
        key: `shortcut:${name}`,
        describe: `Run your "${name}" shortcut.`,
        examples: [`run ${name.toLowerCase()}`],
        destructive: false,
        slots: [],
        dynamic: true,
      })),
    ];
  });

  // The HUD cannot fetch() its own WAV files: a file:// page has a null origin,
  // so Chromium rejects the request as a cross-origin fetch. Handing the bytes
  // over IPC sidesteps that and works identically once packaged inside app.asar.
  ipcMain.handle(IPC.getEarcons, async () => {
    const names = ["wake", "endpoint", "success", "error", "confirm", "cancel"];
    const out: Record<string, Uint8Array> = {};
    await Promise.all(
      names.map(async (n) => {
        try {
          out[n] = new Uint8Array(await readFile(resource("earcons", `${n}.wav`)));
        } catch {
          // A missing cue degrades to silence, never to a crash.
        }
      }),
    );
    return out;
  });

  ipcMain.handle(IPC.getDiagnostics, () => ({
    platform: process.platform,
    osRelease: process.getSystemVersion?.() ?? "",
    electron: process.versions.electron,
    node: process.versions.node,
    packaged: app.isPackaged,
    // In development this is Electron's own bundle id, which is exactly why TCC
    // grants survive rebuilds during development.
    bundleId: app.isPackaged ? "ai.jev.voiceagent" : "com.github.Electron",
    userData: app.getPath("userData"),
    logPath: getLogPath(),
  }));
}

// The app lives in the menu bar, so closing the Settings window must NOT quit it.
// Merely subscribing to this event suppresses Electron's default quit-on-last-window;
// the empty body is the whole point.
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  shutdown();
  destroyTray();
});

app.on("activate", () => {
  if (!getSettingsWindow()) openSettings();
});
