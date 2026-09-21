import { globalShortcut } from "electron";
import { randomUUID } from "node:crypto";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings, CommandLogEntry } from "../shared/types.ts";
import { execute, isDismissal, missingSlots, readConfirmation } from "./actions/execute.ts";
import { ACTIONS, type ActionKey } from "./actions/registry.ts";
import type { ActionContext } from "./actions/types.ts";
import { AudioPipeline, type CommandAudio, type TriggerKind } from "./audio/pipeline.ts";
import { type RouteDecision, route } from "./jev/router.ts";
import { platform } from "./platform/index.ts";
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
      trace: (event, data) => fileLog("pipeline", event, data ?? {}),
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
    coordinator.setState(
      "listening",
      kind === "wake" ? "Listening…" : kind === "hotkey" ? "Listening (hotkey)…" : "Go ahead…",
    );
  });

  p.on("endpoint", () => {
    fileLog("pipeline", "endpoint");
    play("endpoint");
    coordinator.setState("thinking", "Transcribing…");
  });

  p.on("cancelled", (reason) => {
    fileLog("pipeline", "cancelled", { reason });
    // Speech that was not addressed to us is the normal case, not an error:
    // while armed, the agent transcribes anything it hears and simply discards
    // what does not open with the wake phrase. It must do that silently.
    const routine = reason === "no speech" || reason === "not addressed" || reason === "too short";
    if (coordinator.getState() !== "conversing" || !routine) {
      coordinator.setState(p.inFollowUp ? "conversing" : "idle");
      coordinator.setTranscript("", false);
      if (!p.inFollowUp) hideHud();
    }
    if (!routine) play("cancel");
  });

  // The wake phrase with no command after it: acknowledge and wait.
  p.on("prompt", () => {
    fileLog("pipeline", "prompt", {});
    play("wake");
    openConversation();
    coordinator.setTranscript("", false);
    coordinator.setState("conversing", "Go ahead\u2026");
    showHud();
  });

  p.on("error", (err) => {
    fileLog("pipeline", "error", { message: err.message });
    play("error");
    coordinator.setState("error", err.message);
    log({ transcript: "", action: null, outcome: "failed", detail: err.message });
    setTimeout(() => coordinator.setState("idle"), 2500);
  });

  p.on("followUpEnded", (reason: string) => {
    fileLog("agent", "conversation-ended", { reason });
    if (coordinator.getState() === "conversing") {
      coordinator.setState("idle");
      coordinator.setTranscript("", false);
      hideHud();
    }
  });

  p.on("command", (cmd: CommandAudio) => void handleCommand(cmd));
}

/** A destructive action waiting for the user to say yes. */
interface Pending {
  action: ActionKey;
  args: Record<string, string | number>;
  ctx: ActionContext;
  askedAt: number;
}
let pending: Pending | null = null;

/** Confirmations go stale — never run something the user agreed to a minute ago. */
const CONFIRM_WINDOW_MS = 15_000;

/**
 * Context handed to the router.
 *
 * Everything here is gathered by this app from the OS. Nothing that came from a
 * web page, the clipboard, or the screen goes anywhere near it — Jev is
 * documented as steerable by instructions injected into its state.
 */
async function buildContext(transcript: string): Promise<ActionContext> {
  const os = platform();
  // In parallel, and every one of them tolerant of failure: these call out to
  // System Events, which needs an Automation grant the user may not have given
  // yet. A missing grant must degrade the context, never block the command.
  const [focus, running, installed, automations] = await Promise.all([
    os.focus().catch(() => ({ app: "", windowTitle: "" })),
    os.runningApps().catch(() => [] as string[]),
    os.listApps().catch(() => []),
    os.listAutomations().catch(() => [] as string[]),
  ]);
  return {
    transcript,
    focusedApp: focus.app,
    windowTitle: focus.windowTitle ?? "",
    runningApps: running,
    installedApps: installed.map((a) => a.name),
    automations,
  };
}

async function handleCommand(cmd: CommandAudio): Promise<void> {
  const started = Date.now();
  fileLog("pipeline", "command", {
    transcript: cmd.transcript,
    raw: cmd.raw,
    trigger: cmd.trigger,
    transcribeMs: cmd.transcribeMs,
    durationSec: Number(cmd.durationSec.toFixed(2)),
  });
  coordinator.setTranscript(cmd.transcript, false);

  // A pending destructive action takes priority over routing anything new.
  if (pending) {
    await resolveConfirmation(cmd, started);
    return;
  }

  // "that's it, thank you" ends the conversation. Checked here, before routing:
  // it is instant, unambiguous, and sending it to the router would only invite
  // it to be read as some command or other.
  if (pipeline?.inFollowUp && isDismissal(cmd.transcript)) {
    fileLog("agent", "dismissed", { said: cmd.transcript });
    pipeline.closeFollowUp("dismissed");
    finish("cancelled", cmd, null, null, "Okay", started, cmd.transcribeMs, 0, false, 0, "close");
    return;
  }

  coordinator.setState("thinking", "Working out what you meant…");

  let decision: RouteDecision;
  let ctx: ActionContext;
  try {
    ctx = await buildContext(cmd.transcript);
    decision = await route(ctx, { confidenceThreshold: getSettings().confidenceThreshold });
  } catch (err) {
    fileLog("route", "threw", { message: describe(err) });
    finish("failed", cmd, null, null, describe(err), started, cmd.transcribeMs, 0);
    return;
  }

  fileLog("route", "decision", {
    transcript: cmd.transcript,
    action: decision.action,
    args: decision.args,
    confidence: Number(decision.confidence.toFixed(3)),
    addressed: Number(decision.addressed.toFixed(3)),
    risk: Number(decision.risk.toFixed(2)),
    offline: decision.offline,
    routeMs: decision.ms,
    inputTokens: decision.inputTokens,
    reason: decision.reason,
  });

  // Not addressed to the agent — most likely a false wake while the user was
  // talking to someone else. Say nothing and go back to waiting.
  if (decision.addressed < 0.35) {
    // A false trigger: say nothing, and neither open nor close a conversation.
    finish("cancelled", cmd, decision, null, "not addressed to the agent", started, cmd.transcribeMs, decision.ms, true, 0, "leave");
    return;
  }

  if (!decision.action) {
    finish("rejected", cmd, decision, null, decision.reason ?? "No matching command", started, cmd.transcribeMs, decision.ms);
    return;
  }

  const missing = missingSlots(decision.action, decision.args);
  if (missing.length > 0) {
    finish("rejected", cmd, decision, decision.action, `Could not work out the ${missing.join(" and ")}`, started, cmd.transcribeMs, decision.ms);
    return;
  }

  // Confidence gate. Jev reports calibrated confidence, and a 50-command
  // calibration run put correct answers at a mean of 0.98 and wrong ones at
  // 0.53 — so this threshold is a real dial, not a guess.
  if (decision.confidence < getSettings().confidenceThreshold) {
    finish("rejected", cmd, decision, decision.action, `Not sure enough — did you mean to ${phrase(decision.action).toLowerCase()}?`, started, cmd.transcribeMs, decision.ms);
    return;
  }

  // Destructive actions need a spoken yes, gated on BOTH the registry flag and
  // the model's own read of how much damage a misunderstanding would do.
  const dangerous = ACTIONS[decision.action].destructive === true || decision.risk >= 2.5;
  if (dangerous && getSettings().confirmDestructive) {
    pending = { action: decision.action, args: decision.args, ctx, askedAt: Date.now() };
    coordinator.setState("confirming", `${phrase(decision.action)}? Say yes to confirm.`);
    play("confirm");
    showHud();
    // Hold the conversation open, or answering "yes" would mean saying the wake
    // word again first — which is absurd for a question the agent just asked.
    openConversation(CONFIRM_WINDOW_MS);
    fileLog("route", "awaiting-confirmation", { action: decision.action });
    return;
  }

  await runAction(decision.action, decision.args, ctx, cmd, decision, started);
}

async function resolveConfirmation(cmd: CommandAudio, started: number): Promise<void> {
  const held = pending!;
  pending = null;

  if (Date.now() - held.askedAt > CONFIRM_WINDOW_MS) {
    finish("cancelled", cmd, null, held.action, "Confirmation expired", started, cmd.transcribeMs, 0);
    return;
  }

  const answer = readConfirmation(cmd.transcript);
  fileLog("route", "confirmation", { action: held.action, answer, said: cmd.transcript });

  if (answer === "yes") {
    await runAction(held.action, held.args, held.ctx, cmd, null, started);
    return;
  }
  // Anything that is not a clear yes is a no. Silence, a mumble, or a brand new
  // command all mean "do not do the destructive thing".
  finish("cancelled", cmd, null, held.action, answer === "no" ? "Cancelled" : "Not confirmed", started, cmd.transcribeMs, 0);
}

async function runAction(
  action: ActionKey,
  args: Record<string, string | number>,
  ctx: ActionContext,
  cmd: CommandAudio,
  decision: RouteDecision | null,
  started: number,
): Promise<void> {
  coordinator.setState("executing", phrase(action));
  const execStarted = Date.now();
  try {
    const result = await execute(action, args, platform(), ctx);
    const execMs = Date.now() - execStarted;
    fileLog("execute", "ok", { action, args, execMs });

    // A couple of actions steer the agent itself rather than the OS.
    const stops = action === "stop_listening" || action === "cancel";
    if (action === "stop_listening") stopListening();

    finish("ok", cmd, decision, action, result.detail ?? phrase(action), started, cmd.transcribeMs,
           decision?.ms ?? 0, false, execMs, stops ? "close" : "open");
  } catch (err) {
    fileLog("execute", "failed", { action, args, message: describe(err) });
    finish("failed", cmd, decision, action, describe(err), started, cmd.transcribeMs, decision?.ms ?? 0);
  }
}

/** Human-readable name for an action key. */
function phrase(action: ActionKey): string {
  return action.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Single exit point: earcon, HUD, activity log, and return to idle. */
function finish(
  outcome: "ok" | "rejected" | "failed" | "cancelled",
  cmd: CommandAudio,
  decision: RouteDecision | null,
  action: ActionKey | null,
  detail: string,
  started: number,
  transcribeMs: number,
  routeMs: number,
  silent = false,
  execMs = 0,
  /**
   * What to do with the conversation afterwards.
   *  open  — keep listening for another command (the normal case)
   *  close — the user dismissed us, or turned listening off
   *  leave — a false trigger: do not open a window, do not close an open one
   */
  conversation: "open" | "close" | "leave" = "open",
): void {
  if (!silent) play(outcome === "ok" ? "success" : outcome === "cancelled" ? "cancel" : "error");
  coordinator.setState(outcome === "ok" ? "executing" : outcome === "failed" ? "error" : "idle", detail);
  fileLog("agent", "finish", { outcome, action, detail });

  log({
    transcript: cmd.transcript,
    action,
    confidence: decision?.confidence ?? null,
    offline: decision?.offline ?? false,
    outcome,
    detail,
    timings: {
      transcribe: transcribeMs,
      route: routeMs,
      execute: execMs,
      total: Date.now() - started + transcribeMs,
    },
    ...(decision?.inputTokens ? { inputTokens: decision.inputTokens } : {}),
  });

  if (conversation === "open") openConversation();
  else if (conversation === "close") pipeline?.closeFollowUp("finished");

  setTimeout(
    () => {
      if (coordinator.getState() === "confirming") return; // a new prompt took over
      coordinator.setTranscript("", false);
      if (pipeline?.inFollowUp) {
        // Stay visible and say so. The user needs to know the microphone is
        // still live without having to guess.
        coordinator.setState("conversing", "Listening — say \u201cthat\u2019s it\u201d when you\u2019re done");
        showHud();
        return;
      }
      coordinator.setState("idle");
      hideHud();
    },
    outcome === "ok" ? 1600 : 2600,
  );
}

/** Hold the conversation open so the next command needs no wake word. */
function openConversation(windowMs?: number): void {
  const settings = getSettings();
  if (!settings.followUp || !pipeline) return;
  pipeline.openFollowUp(windowMs ?? settings.followUpSeconds * 1000);
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
