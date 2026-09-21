import { IPC } from "../shared/ipc.ts";
import { getHud } from "./windows.ts";
import { getSettings } from "./settings-store.ts";

export type EarconName = "wake" | "endpoint" | "success" | "error" | "confirm" | "cancel";

/**
 * Indicator sounds.
 *
 * Playback happens in the HUD renderer, which holds one long-lived AudioContext
 * with every cue pre-decoded. That costs 10-20 ms per cue; spawning `afplay`
 * instead would cost 80-200 ms of process start and CoreAudio setup, which is
 * far too jittery for a "listening" cue that must feel instant.
 *
 * `lastPlayedAt` is what the audio pipeline consults to gate the microphone:
 * Electron's echo cancellation is confirmed non-functional, so self-hearing is
 * prevented by dropping frames while a cue plays plus a short reverb tail.
 */
let lastPlayedAt = 0;
let lastDurationMs = 0;

/** Approximate durations, from the generator. Used only for mic gating. */
const DURATION: Record<EarconName, number> = {
  wake: 90,
  endpoint: 80,
  success: 143,
  error: 230,
  confirm: 170,
  cancel: 100,
};

/** Room reverb keeps ringing after playback stops. */
const TAIL_MS = 200;

export function play(name: EarconName): void {
  const { earcons, earconVolume } = getSettings();
  if (!earcons) return;
  const hud = getHud();
  if (!hud) return;
  lastPlayedAt = Date.now();
  lastDurationMs = DURATION[name] ?? 120;
  hud.webContents.send(IPC.playEarcon, name, earconVolume);
}

/** True while the app's own output could still be reaching the microphone. */
export function isSelfAudioActive(): boolean {
  return Date.now() - lastPlayedAt < lastDurationMs + TAIL_MS;
}
