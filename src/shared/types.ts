/**
 * Contracts shared between the Electron main process and its renderers.
 *
 * Nothing in here may import `electron` or Node builtins: the renderer bundles
 * this file too.
 */

/** Coordinator state. Drives the tray icon and the HUD. */
export type AgentState =
  | "disabled" // listening turned off by the user
  | "idle" // armed, waiting for the wake word or hotkey
  | "conversing" // a conversation is open: speak again, no wake word needed
  | "listening" // capturing a command utterance
  | "thinking" // transcribing and/or asking Jev
  | "executing" // running the chosen action
  | "confirming" // waiting for a spoken yes/no on a destructive action
  | "error";

/** What the HUD renders. */
export interface HudModel {
  state: AgentState;
  /** Live (volatile) or finalized transcript text. */
  transcript: string;
  /** True while `transcript` is still a partial hypothesis. */
  partial: boolean;
  /** Short status line, e.g. "Opening Safari" or "Say yes to confirm". */
  detail: string;
  /** Mic level 0..1, for the meter. */
  level: number;
  /** A small badge beside a result, e.g. "0.4 s" — how quickly it happened. */
  meta?: string;
  /** Set once a command has been dealt with, so the overlay can show how it went. */
  result?: HudResult;
}

export type HudResult = "ok" | "failed" | "rejected" | "cancelled";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The macOS TCC grants this app can need.
 *
 * `screenRecording` is deliberately optional: window titles are read through the
 * Accessibility API instead, which avoids the scariest prompt in the list.
 */
export type PermissionId =
  | "microphone"
  | "accessibility"
  | "automation"
  | "inputMonitoring"
  | "screenRecording";

export type PermissionState =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | /** granted per TCC, but the capability self-test failed anyway */ "broken"
  | "unsupported";

export interface PermissionInfo {
  id: PermissionId;
  label: string;
  /** Why this app wants it, in plain language. */
  why: string;
  /** What stops working without it. */
  ifMissing: string;
  state: PermissionState;
  /** False for optional grants like Screen Recording. */
  required: boolean;
  /** True when the app can show a real system prompt; false means Settings-only. */
  canPrompt: boolean;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Wake phrases matched by the keyword spotter. */
  wakeWords: string[];
  /** Keyword-spotter score threshold, 0..1. Higher = fewer false triggers. */
  wakeThreshold: number;
  wakeWordEnabled: boolean;
  /** Electron accelerator, e.g. "Control+Space". Empty disables the hotkey. */
  hotkey: string;
  /** Play short tones for state changes. */
  earcons: boolean;
  earconVolume: number;
  /** Jev model route. */
  model: string;
  /** Override the API root (for a gateway). Empty = official endpoint. */
  baseUrl: string;
  /** Below this Jev confidence, ask instead of acting. */
  confidenceThreshold: number;
  /** Always require spoken confirmation for actions flagged destructive. */
  confirmDestructive: boolean;
  /** Fall back to the local deterministic matcher when Jev is unreachable. */
  offlineFallback: boolean;
  /**
   * After a command, keep listening for more without needing the wake word
   * again, until the user dismisses it or it times out.
   */
  followUp: boolean;
  /** Begin listening as soon as the app launches, if it is set up to. */
  listenOnStart: boolean;
  /** How long a conversation stays open after the last exchange, in seconds. */
  followUpSeconds: number;
  launchAtLogin: boolean;
  /** Preferred audio input device id, or "" for the system default. */
  inputDeviceId: string;
  /** Which local speech-to-text model to run. See STT_MODELS. */
  sttModel: string;
  /**
   * Act while the user is still speaking: transcribe as they talk, run a
   * finished command at the first pause, and run the finished half of "open
   * Notes and …" before the second half is said.
   */
  realtime: boolean;
  /**
   * Run exact, unambiguous commands ("open Safari", "mute", "next track")
   * without asking Jev. Saves the network round trip on the commonest commands.
   */
  instantCommands: boolean;
  /**
   * When Jev has no command for a request, ask a language model on OpenRouter
   * to design one from the agent's own building blocks, and remember it once
   * the user agrees. Needs an OpenRouter key.
   */
  learning: boolean;
  /** The OpenRouter model that designs new commands. */
  learnModel: string;
  /**
   * Ask before a new command is tried. Off, a command that does nothing
   * destructive is tried at once and kept if it works; one that would quit,
   * delete or send still asks.
   */
  learnAsk: boolean;
  /** Where to send each learned command as JSON, for a shared knowledge base. Empty: nowhere. */
  knowledgeBaseUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  // "Jev" and "Jeff" are near-homophones; register both so either works.
  wakeWords: ["hey jeff", "hey jev"],
  wakeThreshold: 0.5,
  wakeWordEnabled: true,
  // Not Ctrl+Space or Ctrl+Option+Space: macOS uses those to switch keyboard layouts.
  hotkey: "Control+Shift+Space",
  earcons: true,
  earconVolume: 0.5,
  model: "jev-latest",
  baseUrl: "",
  confidenceThreshold: 0.55,
  confirmDestructive: true,
  offlineFallback: true,
  followUp: true,
  followUpSeconds: 15,
  listenOnStart: true,
  launchAtLogin: false,
  inputDeviceId: "",
  sttModel: "small.en",
  realtime: true,
  instantCommands: true,
  learning: true,
  learnModel: "openai/gpt-6-luna",
  learnAsk: false,
  knowledgeBaseUrl: "",
};

/** Result of probing the configured Jev credentials. */
export interface ApiKeyStatus {
  configured: boolean;
  ok: boolean;
  message: string;
  /** Model routes the account can reach, when the probe succeeded. */
  models?: string[];
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Per-stage timings for one command, in milliseconds. */
export interface StageTimings {
  capture?: number;
  transcribe?: number;
  route?: number;
  execute?: number;
  total?: number;
  /**
   * From the moment the user stopped speaking to the action being done — the
   * number that decides whether it feels instant. Negative when the action ran
   * before they finished the sentence.
   */
  afterSpeech?: number;
}

export interface CommandLogEntry {
  id: string;
  at: number;
  transcript: string;
  action: string | null;
  confidence: number | null;
  /** True when the local matcher answered because Jev was unavailable. */
  offline: boolean;
  /** Answered on this Mac by an exact match, without asking Jev. */
  instant?: boolean;
  /** Acted on at a pause, or mid-sentence, rather than after the silence. */
  early?: boolean;
  outcome: "ok" | "rejected" | "failed" | "cancelled";
  detail: string;
  timings: StageTimings;
  inputTokens?: number;
}

/** One entry of the action registry, for the Commands pane. */
export interface ActionSummary {
  key: string;
  describe: string;
  examples: string[];
  destructive: boolean;
  slots: string[];
  /** True for actions discovered from the user's own Shortcuts. */
  dynamic?: boolean;
  /** For a learned command: its id, what it does step by step, and when it was learned. */
  learned?: { id: string; steps: string; learnedAt: string; uses: number };
}

/** One entry of the speech-to-text model catalogue, for the Settings picker. */
export interface SttModelInfo {
  id: string;
  label: string;
  size: string;
  latencyMs: number;
  note: string;
  installed: boolean;
}

export interface ModelDownloadProgress {
  id: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string;
}
