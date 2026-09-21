/** IPC channel names, shared so main and preload cannot drift apart. */
export const IPC = {
  // renderer -> main (invoke)
  getSettings: "settings:get",
  setSettings: "settings:set",
  getApiKeyInfo: "apikey:info",
  setApiKey: "apikey:set",
  probeApiKey: "apikey:probe",
  listPermissions: "perm:list",
  requestPermission: "perm:request",
  openPermissionSettings: "perm:open",
  selfTestPermission: "perm:test",
  getAgentState: "agent:state",
  setListening: "agent:setListening",
  getLog: "log:get",
  getDiagnostics: "diag:get",
  getEarcons: "earcon:load",
  listActions: "actions:list",

  // capture renderer -> main (one-way, high frequency)
  audioFrames: "audio:frames",
  audioStatus: "audio:status",

  // main -> capture renderer
  captureStart: "capture:start",
  captureStop: "capture:stop",

  // main -> renderer (send)
  agentStateChanged: "agent:stateChanged",
  hudUpdate: "hud:update",
  logAppended: "log:appended",
  playEarcon: "earcon:play",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
