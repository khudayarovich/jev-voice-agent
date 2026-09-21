import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";
import type {
  AgentState,
  ApiKeyStatus,
  AppSettings,
  CommandLogEntry,
  HudModel,
  PermissionId,
  PermissionInfo,
  PermissionState,
} from "../shared/types";

/**
 * The only bridge between renderers and the main process.
 *
 * Note what is absent: there is no way to read the API key. Renderers can set it
 * and ask whether one is present, but the value itself never crosses this
 * boundary — it stays in the main process, encrypted at rest via safeStorage.
 */
const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.getSettings),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.setSettings, patch),
  },
  apiKey: {
    info: (): Promise<{ present: boolean; tail: string; encrypted: boolean }> =>
      ipcRenderer.invoke(IPC.getApiKeyInfo),
    set: (key: string): Promise<void> => ipcRenderer.invoke(IPC.setApiKey, key),
    probe: (): Promise<ApiKeyStatus> => ipcRenderer.invoke(IPC.probeApiKey),
  },
  permissions: {
    list: (): Promise<PermissionInfo[]> => ipcRenderer.invoke(IPC.listPermissions),
    request: (id: PermissionId): Promise<PermissionState> =>
      ipcRenderer.invoke(IPC.requestPermission, id),
    open: (id: PermissionId): Promise<void> =>
      ipcRenderer.invoke(IPC.openPermissionSettings, id),
    test: (id: PermissionId): Promise<{ state: PermissionState; detail: string }> =>
      ipcRenderer.invoke(IPC.selfTestPermission, id),
  },
  agent: {
    state: (): Promise<{ state: AgentState; listening: boolean }> =>
      ipcRenderer.invoke(IPC.getAgentState),
    setListening: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.setListening, on),
    log: (): Promise<CommandLogEntry[]> => ipcRenderer.invoke(IPC.getLog),
    diagnostics: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.getDiagnostics),
  },
  audio: {
    cues: (): Promise<Record<string, Uint8Array>> => ipcRenderer.invoke(IPC.getEarcons),
  },
  on: {
    state: (fn: (s: AgentState) => void) => {
      const h = (_e: unknown, s: AgentState) => fn(s);
      ipcRenderer.on(IPC.agentStateChanged, h);
      return () => ipcRenderer.removeListener(IPC.agentStateChanged, h);
    },
    hud: (fn: (m: HudModel) => void) => {
      const h = (_e: unknown, m: HudModel) => fn(m);
      ipcRenderer.on(IPC.hudUpdate, h);
      return () => ipcRenderer.removeListener(IPC.hudUpdate, h);
    },
    log: (fn: (e: CommandLogEntry) => void) => {
      const h = (_e: unknown, entry: CommandLogEntry) => fn(entry);
      ipcRenderer.on(IPC.logAppended, h);
      return () => ipcRenderer.removeListener(IPC.logAppended, h);
    },
    earcon: (fn: (name: string, volume: number) => void) => {
      const h = (_e: unknown, name: string, volume: number) => fn(name, volume);
      ipcRenderer.on(IPC.playEarcon, h);
      return () => ipcRenderer.removeListener(IPC.playEarcon, h);
    },
  },
};

contextBridge.exposeInMainWorld("jev", api);

export type JevApi = typeof api;
