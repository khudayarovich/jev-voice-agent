import { app, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings, PermissionId } from "../shared/types.ts";
import { ACTIONS, ACTION_KEYS } from "./actions/registry.ts";
import { catalogue, downloadModel, isInstalled } from "./audio/download.ts";
import { modelById } from "./audio/models.ts";
import { applySettings, getPipeline, shutdown, startListening, stopListening } from "./agent.ts";
import { platform } from "./platform/index.ts";
import { coordinator } from "./coordinator.ts";
import { getLogPath, initLog, log } from "./log.ts";
import * as jev from "./jev/client.ts";
import * as permissions from "./permissions/index.ts";
import { summarize } from "./learning/lesson.ts";
import { forget, learnedCommands, recordLesson } from "./learning/store.ts";
import { probeTeacher } from "./learning/teacher.ts";
import {
  apiKeySummary,
  getOpenRouterKey,
  getSettings,
  openRouterKeySummary,
  setApiKey,
  setOpenRouterKey,
  updateSettings,
} from "./settings-store.ts";
import { createTray, destroyTray, hideDock, refreshTrayMenu, setTrayState } from "./tray.ts";
import { resource } from "./paths.ts";
import { selfTest } from "./self-test.ts";
import { broadcast, createHud, getHud, getSettingsWindow, openSettings } from "./windows.ts";

// `--self-test` checks the native pieces and exits; see self-test.ts.
if (process.argv.includes("--self-test")) {
  void app.whenReady().then(async () => {
    const ok = await selfTest().catch((err: unknown) => {
      console.error("self-test crashed:", err);
      return false;
    });
    app.exit(ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) {
  // A menu-bar agent must never run twice: two trays, two hotkey
  // registrations, two microphone consumers.
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
  // A signal quits the app properly, so shutdown() stops the speech server on
  // the way out. Listening for a signal replaces Node's default of exiting on
  // the spot, so the handler has to do the quitting itself.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log("app", "signal", { sig });
      app.quit();
    });
  }
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
    onAbout: () => openSettings("about"),
    onQuit: () => {
      app.quit();
    },
  });

  createHud();
  registerIpc();

  // An installed copy starts with no speech model. Fetch it now, in the
  // background, so it is ready by the time the user has pasted a key and
  // granted permissions; starting to listen joins this same download.
  const wanted = modelById(getSettings().sttModel);
  if (app.isPackaged && !isInstalled(wanted)) {
    log("app", "model-download", { model: wanted.id });
    void downloadModel(wanted.id, (p) => broadcast(IPC.sttDownloadProgress, p));
  }

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

  // An update leaves every grant stale (see permissions/update.ts): clear them
  // and ask again before deciding whether the app is set up.
  await permissions.resetGrantsIfUpdated().catch((err) => log("permissions", "reset-error", { message: String(err) }));

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
    jev.warm();
  });

  ipcMain.handle(IPC.probeApiKey, () => jev.probe());

  ipcMain.handle(IPC.getOpenRouterKeyInfo, () => openRouterKeySummary());
  ipcMain.handle(IPC.setOpenRouterKey, (_e, key: string) => setOpenRouterKey(String(key ?? "")));
  ipcMain.handle(IPC.probeOpenRouterKey, () => probeTeacher(getOpenRouterKey()));

  ipcMain.handle(IPC.forgetLearned, async (_e, id: string) => {
    const gone = forget(String(id));
    if (!gone) return;
    log("learn", "forgotten", { id: gone.id, title: gone.title });
    const failed = await recordLesson("forgotten", gone, getSettings().knowledgeBaseUrl);
    if (failed) log("learn", "knowledge-base-failed", { message: failed });
  });

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

  ipcMain.handle(IPC.listSttModels, () =>
    catalogue().map(({ id, label, size, latencyMs, note, installed }) => ({
      id, label, size, latencyMs, note, installed,
    })),
  );

  ipcMain.handle(IPC.downloadSttModel, async (event, id: string) => {
    await downloadModel(id, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC.sttDownloadProgress, progress);
    });
  });

  ipcMain.handle(IPC.listActions, async () => {
    const base = ACTION_KEYS.filter((key) => key !== "run_learned").map((key) => ({
      key,
      describe: ACTIONS[key].describe,
      examples: ACTIONS[key].examples,
      destructive: ACTIONS[key].destructive === true,
      slots: Object.keys(ACTIONS[key].slots),
    }));
    // Commands the agent learned, and the user's own Shortcuts, are
    // voice-callable too: show them here rather than leaving the list looking
    // shorter than it is.
    const learned = learnedCommands().map((c) => ({
      key: c.title,
      describe: c.describe,
      examples: c.examples,
      destructive: c.confirm,
      slots: c.parameter ? [c.parameter.name] : [],
      learned: { id: c.id, steps: summarize(c), learnedAt: c.learnedAt, uses: c.uses },
    }));
    const automations = await platform().listAutomations().catch(() => [] as string[]);
    return [
      ...learned,
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
    version: app.getVersion(),
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
