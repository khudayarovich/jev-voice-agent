import { BrowserWindow, app, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { IPC } from "../shared/ipc";
import type { AppSettings, PermissionId } from "../shared/types";
import { coordinator } from "./coordinator";
import * as jev from "./jev/client";
import * as permissions from "./permissions";
import {
  apiKeySummary,
  getSettings,
  setApiKey,
  updateSettings,
} from "./settings-store";
import { createTray, destroyTray, hideDock, refreshTrayMenu, setTrayState } from "./tray";
import { resource } from "./paths";
import { createHud, getHud, getSettingsWindow, openSettings } from "./windows";

// A menu-bar agent must never run twice: two trays, two hotkey registrations,
// two microphone consumers.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();
  hideDock();

  createTray({
    isListening: () => coordinator.isListening(),
    onToggleListening: () => coordinator.setListening(!coordinator.isListening()),
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

  // Open Settings on first run so the user lands on the permissions and API-key
  // pane rather than wondering what the new menu-bar icon is.
  if (!apiKeySummary().present || !permissions.requiredSatisfied()) {
    openSettings();
  }

  setTrayState("disabled");
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

  ipcMain.handle(IPC.setListening, (_e, on: boolean) => {
    coordinator.setListening(Boolean(on));
  });

  ipcMain.handle(IPC.getLog, () => coordinator.getLog());

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
  }));
}

// The app lives in the menu bar, so closing the Settings window must NOT quit it.
// Merely subscribing to this event suppresses Electron's default quit-on-last-window;
// the empty body is the whole point.
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  destroyTray();
});

app.on("activate", () => {
  if (!getSettingsWindow()) openSettings();
});
