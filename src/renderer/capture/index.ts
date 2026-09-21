/**
 * Microphone capture.
 *
 * This lives in a hidden renderer rather than a spawned helper on purpose:
 * macOS attributes a TCC prompt to the signed app bundle that asks for it, and
 * helper binaries spawned by Electron do not reliably get their own prompts. The
 * window also sets `backgroundThrottling: false`, without which the always-on
 * listener would stall whenever the window is hidden — which it always is.
 */

import { WORKLET_SOURCE } from "./worklet-source.ts";

const TARGET_RATE = 16000;
/** ~64 ms per message: comfortably above VAD's 512-sample window, cheap on IPC. */
const BLOCK = 1024;



let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let node: AudioWorkletNode | null = null;

async function start(deviceId: string): Promise<void> {
  await stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        // All three OFF. Chromium enables them by default, and they smear the
        // signal in exactly the way speech recognition suffers most from.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (err) {
    window.jev.capture.status({
      running: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Deliberately NOT `{ sampleRate: TARGET_RATE }`. Chromium opens an output
  // device for every AudioContext, so demanding a rate the hardware is not
  // already running at forces a device reconfiguration — which on macOS wedges
  // CoreAudio and hangs unrelated audio playback. Take whatever the device is
  // running at and resample in the worklet instead.
  ctx = new AudioContext({ latencyHint: "interactive" });

  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  node = new AudioWorkletNode(ctx, "pcm-collector", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { block: BLOCK, targetRate: TARGET_RATE },
  });
  node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; level: number }>) => {
    window.jev.capture.push(e.data.pcm, e.data.level);
  };

  ctx.createMediaStreamSource(stream).connect(node);
  await ctx.resume();

  window.jev.capture.status({ running: true, sampleRate: ctx.sampleRate });
}

async function stop(): Promise<void> {
  node?.port.close();
  node?.disconnect();
  node = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
  if (ctx) {
    await ctx.close().catch(() => undefined);
    ctx = null;
  }
  window.jev.capture.status({ running: false });
}

window.jev.capture.onStart((deviceId) => void start(deviceId));
window.jev.capture.onStop(() => void stop());
