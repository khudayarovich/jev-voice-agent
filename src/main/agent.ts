import { globalShortcut } from "electron";
import { randomUUID } from "node:crypto";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings, CommandLogEntry } from "../shared/types.ts";
import { AudioPipeline, type CommandAudio, type TriggerKind } from "./audio/pipeline.ts";
import { Vad } from "./audio/vad.ts";
import { WakeWord } from "./audio/wake.ts";
import { WhisperEngine } from "./audio/whisper.ts";
import { coordinator } from "./coordinator.ts";
import { isSelfAudioActive, play } from "./earcons.ts";
import { log as fileLog } from "./log.ts";
import { getSettings } from "./settings-store.ts";
import { createCapture, getCapture, hideHud, showHud } from "./windows.ts";

/**
 * Owns the listening lifecycle: the speech engine, the pipeline, the hotkey, and
 * the mapping from pipeline events onto coordinator state.
 */

let speech: WhisperEngine | null = null;
let pipeline: AudioPipeline | null = null;
let registeredHotkey = "";
let starting: Promise<void> | null = null;

export function getPipeline(): AudioPipeline | null {
  return pipeline;
}

export async function startListening(): Promise<void> {
  if (pipeline?.listening) return;
  if (starting) return starting;
  starting = doStart().finally(() => {
    starting = null;
  });
  return starting;
}

async function doStart(): Promise<void> {
  const settings = getSettings();
  fileLog("agent", "starting", { wakeWords: settings.wakeWords, hotkey: settings.hotkey });
  coordinator.setState("thinking", "Starting speech engine…");

  try {
    if (!speech) speech = new WhisperEngine();
    // This also forces the one-time Metal shader compile, which takes ~17 s on a
    // cold machine. Far better to pay it here than on the first spoken command.
    await speech.start();
  } catch (err) {
    coordinator.setState("error", err instanceof Error ? err.message : String(err));
    coordinator.setListening(false);
    return;
  }

  const vad = new Vad({ minSilence: 0.7, minSpeech: 0.25, maxSpeech: 12 });
  pipeline = new AudioPipeline(
    {
      speech,
      vad,
      makeWake: (phrases, threshold) => new WakeWord({ phrases, threshold }),
      isSelfAudioActive,
    },
    settings,
  );
  wirePipeline(pipeline);
  pipeline.arm();

  createCapture();
  // The capture window may still be loading; retry until it takes the message.
  await sendCaptureStart(settings.inputDeviceId);

  registerHotkey(settings.hotkey);
  fileLog("agent", "armed", {
    wakeAvailable: pipeline.wakeAvailable,
    unsupportedPhrases: pipeline.unsupportedWakePhrases,
  });
  coordinator.setListening(true);
  coordinator.setState("idle");
}

export function stopListening(): void {
  pipeline?.disarm();
  pipeline = null;
  getCapture()?.webContents.send(IPC.captureStop);
  unregisterHotkey();
  hideHud();
  coordinator.setListening(false);
}

export function shutdown(): void {
  stopListening();
  speech?.stop();
  speech = null;
}

export function applySettings(next: AppSettings): void {
  pipeline?.updateSettings(next);
  if (next.hotkey !== registeredHotkey && pipeline?.listening) registerHotkey(next.hotkey);
}

async function sendCaptureStart(deviceId: string): Promise<void> {
  const win = createCapture();
  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
  }
  win.webContents.send(IPC.captureStart, deviceId);
}

// ---------------------------------------------------------------------------
// Pipeline → coordinator
// ---------------------------------------------------------------------------

function wirePipeline(p: AudioPipeline): void {
  p.on("level", (level) => coordinator.setLevel(level));

  // Frame accounting, sampled. Silence in this line means capture is dead, which
  // is otherwise indistinguishable from "nobody spoke".
  let frames = 0;
  let peak = 0;
  p.on("level", (level) => {
    frames++;
    peak = Math.max(peak, level);
    if (frames % 100 === 0) {
      fileLog("capture", "frames", { frames, peakLevel: Number(peak.toFixed(3)) });
      peak = 0;
    }
  });

  p.on("trigger", (kind: TriggerKind) => {
    fileLog("pipeline", "trigger", { kind });
    play("wake");
    showHud();
    coordinator.setTranscript("", false);
    coordinator.setState("listening", kind === "wake" ? "Listening…" : "Listening (hotkey)…");
  });

  p.on("endpoint", () => {
    fileLog("pipeline", "endpoint");
    play("endpoint");
    coordinator.setState("thinking", "Transcribing…");
  });

  p.on("cancelled", (reason) => {
    fileLog("pipeline", "cancelled", { reason });
    // A false wake is common and must be quiet: no error tone, no scary state.
    coordinator.setState("idle");
    coordinator.setTranscript("", false);
    hideHud();
    if (reason !== "no speech") play("cancel");
  });

  p.on("error", (err) => {
    fileLog("pipeline", "error", { message: err.message });
    play("error");
    coordinator.setState("error", err.message);
    log({ transcript: "", action: null, outcome: "failed", detail: err.message });
    setTimeout(() => coordinator.setState("idle"), 2500);
  });

  p.on("command", (cmd: CommandAudio) => void handleCommand(cmd));
}

/**
 * Phase 2 stops here: show what was heard and log it.
 * Phase 4 replaces this with the Jev router and the executor.
 */
async function handleCommand(cmd: CommandAudio): Promise<void> {
  fileLog("pipeline", "command", {
    transcript: cmd.transcript,
    raw: cmd.raw,
    trigger: cmd.trigger,
    transcribeMs: cmd.transcribeMs,
    durationSec: Number(cmd.durationSec.toFixed(2)),
  });
  coordinator.setTranscript(cmd.transcript, false);
  coordinator.setState("executing", "Heard");
  play("success");

  log({
    transcript: cmd.transcript,
    action: null,
    outcome: "ok",
    detail: `${cmd.trigger} trigger · ${cmd.durationSec.toFixed(1)}s audio`,
    timings: { transcribe: cmd.transcribeMs, total: cmd.transcribeMs },
  });

  setTimeout(() => {
    coordinator.setState("idle");
    coordinator.setTranscript("", false);
    hideHud();
  }, 1800);
}

function log(partial: Partial<CommandLogEntry> & { transcript: string }): void {
  coordinator.append({
    id: randomUUID(),
    at: Date.now(),
    action: null,
    confidence: null,
    offline: false,
    outcome: "ok",
    detail: "",
    timings: {},
    ...partial,
  });
}

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

/**
 * Toggle-mode only, deliberately.
 *
 * Electron's `globalShortcut` fires on press and has no key-up, so true
 * hold-to-talk is impossible here — it needs a CGEventTap in a native helper
 * (and the Input Monitoring grant that comes with it). Toggle works today,
 * needs no extra permission, and is the fallback that keeps working when the
 * room is too noisy for the wake word.
 */
function registerHotkey(accelerator: string): void {
  unregisterHotkey();
  if (!accelerator) return;
  try {
    const ok = globalShortcut.register(accelerator, () => {
      const p = pipeline;
      if (!p?.listening) return;
      if (coordinator.getState() === "listening") p.stopCapture();
      else p.begin("hotkey");
    });
    registeredHotkey = ok ? accelerator : "";
    if (!ok) console.error("[hotkey] another app already owns", accelerator);
  } catch (err) {
    console.error("[hotkey] invalid accelerator", accelerator, err);
    registeredHotkey = "";
  }
}

function unregisterHotkey(): void {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = "";
}
