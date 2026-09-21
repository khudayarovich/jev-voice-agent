import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKLET_SOURCE } from "../src/renderer/capture/worklet-source.ts";

/**
 * Runs the real AudioWorklet source in plain Node against a fake worklet
 * runtime. This matters because the resampler only exists at all to avoid
 * forcing a non-native AudioContext sample rate — which wedged CoreAudio and
 * hung unrelated audio playback on macOS — so its correctness cannot be
 * verified by just listening.
 */
interface FakeProcessor {
  process(inputs: Float32Array[][]): boolean;
  port: { postMessage(msg: { pcm: Int16Array; level: number }): void };
}

function instantiate(deviceRate: number, block: number, targetRate: number) {
  const messages: { pcm: Int16Array; level: number }[] = [];
  let Registered: new (o: { processorOptions: Record<string, number> }) => FakeProcessor;

  const scope = {
    sampleRate: deviceRate,
    AudioWorkletProcessor: class {
      port = { postMessage: (m: { pcm: Int16Array; level: number }) => messages.push(m) };
    },
    registerProcessor: (_name: string, cls: unknown) => {
      Registered = cls as typeof Registered;
    },
  };

  // eslint-disable-next-line no-new-func
  new Function(
    "sampleRate",
    "AudioWorkletProcessor",
    "registerProcessor",
    WORKLET_SOURCE,
  )(scope.sampleRate, scope.AudioWorkletProcessor, scope.registerProcessor);

  const node = new Registered!({ processorOptions: { block, targetRate } });
  return { node, messages };
}

/** Feed `seconds` of a sine at `freq`, in 128-sample render quanta. */
function feedSine(
  node: FakeProcessor,
  deviceRate: number,
  freq: number,
  seconds: number,
): void {
  const total = Math.floor(deviceRate * seconds);
  const quantum = 128;
  let n = 0;
  while (n < total) {
    const buf = new Float32Array(quantum);
    for (let i = 0; i < quantum; i++) buf[i] = Math.sin((2 * Math.PI * freq * (n + i)) / deviceRate);
    node.process([[buf]]);
    n += quantum;
  }
}

function peakAmplitude(messages: { pcm: Int16Array }[]): number {
  let peak = 0;
  // Skip the first block: the FIR history is still filling and the level ramps.
  for (const m of messages.slice(1)) {
    for (const v of m.pcm) peak = Math.max(peak, Math.abs(v) / 32768);
  }
  return peak;
}

test("decimates 48 kHz to 16 kHz at the correct rate", () => {
  const { node, messages } = instantiate(48000, 1024, 16000);
  feedSine(node, 48000, 440, 1);
  const samples = messages.reduce((a, m) => a + m.pcm.length, 0);
  // One second in should be ~16000 samples out, within one block of quantisation.
  assert.ok(
    Math.abs(samples - 16000) <= 1024,
    `expected ~16000 samples, got ${samples}`,
  );
});

test("handles a non-integer ratio (44.1 kHz devices)", () => {
  const { node, messages } = instantiate(44100, 1024, 16000);
  feedSine(node, 44100, 440, 1);
  const samples = messages.reduce((a, m) => a + m.pcm.length, 0);
  assert.ok(
    Math.abs(samples - 16000) <= 1024,
    `expected ~16000 samples, got ${samples}`,
  );
});

test("passes speech-band tones through largely intact", () => {
  const { node, messages } = instantiate(48000, 1024, 16000);
  feedSine(node, 48000, 440, 0.5);
  const peak = peakAmplitude(messages);
  assert.ok(peak > 0.7, `440 Hz should survive, peak was ${peak.toFixed(3)}`);
});

test("attenuates content above the target Nyquist so it cannot alias", () => {
  // 12 kHz is above 16 kHz/2. Without the anti-alias filter this would fold
  // back into the speech band as a spurious 4 kHz tone.
  const { node, messages } = instantiate(48000, 1024, 16000);
  feedSine(node, 48000, 12000, 0.5);
  const peak = peakAmplitude(messages);
  assert.ok(peak < 0.2, `12 kHz should be suppressed, peak was ${peak.toFixed(3)}`);
});

test("reports a level that tracks input amplitude", () => {
  const { node, messages } = instantiate(48000, 1024, 16000);
  feedSine(node, 48000, 440, 0.5);
  const levels = messages.slice(1).map((m) => m.level);
  assert.ok(levels.length > 0);
  // RMS of a full-scale sine is 1/sqrt(2).
  for (const l of levels) assert.ok(l > 0.5 && l <= 1.01, `unexpected level ${l}`);
});

test("emits silence as silence", () => {
  const { node, messages } = instantiate(48000, 1024, 16000);
  const quantum = new Float32Array(128);
  for (let i = 0; i < 400; i++) node.process([[quantum]]);
  assert.ok(messages.length > 0, "should still emit blocks");
  assert.equal(peakAmplitude(messages), 0);
});

test("survives an absent input without throwing", () => {
  const { node } = instantiate(48000, 1024, 16000);
  assert.equal(node.process([[]]), true);
  assert.equal(node.process([]), true);
});
