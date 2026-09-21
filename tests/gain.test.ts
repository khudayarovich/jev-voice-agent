import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoGain, normalizeUtterance } from "../src/main/audio/gain.ts";

const tone = (n: number, amp: number) =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 200 * i) / 16000) * amp);

const peakOf = (s: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < s.length; i++) m = Math.max(m, Math.abs(s[i] ?? 0));
  return m;
};

test("brings a quiet signal up toward the target", () => {
  const ag = new AutoGain();
  // Feed several blocks so the smoothed gain can settle.
  let out: ArrayLike<number> = [];
  for (let i = 0; i < 40; i++) out = ag.process(tone(1024, 0.05));
  assert.ok(peakOf(out) > 0.4, `expected boosted signal, peak was ${peakOf(out).toFixed(3)}`);
  assert.ok(ag.value > 5, `expected real gain, got ${ag.value.toFixed(1)}x`);
});

test("leaves an already-loud signal alone", () => {
  const ag = new AutoGain();
  let out: ArrayLike<number> = [];
  for (let i = 0; i < 10; i++) out = ag.process(tone(1024, 0.8));
  assert.ok(ag.value < 1.2, `should not amplify, got ${ag.value.toFixed(2)}x`);
  assert.ok(peakOf(out) <= 1.0);
});

test("never exceeds full scale, even at maximum gain", () => {
  const ag = new AutoGain();
  let out: ArrayLike<number> = [];
  for (let i = 0; i < 60; i++) out = ag.process(tone(1024, 0.01));
  assert.ok(peakOf(out) <= 1.0, `soft clip must hold the signal in range, got ${peakOf(out)}`);
});

test("does not wind up during silence", () => {
  const ag = new AutoGain();
  for (let i = 0; i < 20; i++) ag.process(tone(1024, 0.6));
  const settled = ag.value;
  // Pure silence afterwards must not ramp the gain to maximum, or the first
  // word after a pause gets slammed and the noise floor fires the VAD.
  for (let i = 0; i < 40; i++) ag.process(new Float32Array(1024));
  assert.ok(ag.value <= settled + 0.01, `gain drifted from ${settled.toFixed(2)} to ${ag.value.toFixed(2)}`);
});

test("reset returns it to unity", () => {
  const ag = new AutoGain();
  for (let i = 0; i < 30; i++) ag.process(tone(1024, 0.02));
  ag.reset();
  assert.equal(ag.value, 1);
});

test("utterance normalisation scales the peak to the target", () => {
  const out = normalizeUtterance(tone(16000, 0.1), 0.85);
  assert.ok(Math.abs(peakOf(out) - 0.85) < 0.02, `peak was ${peakOf(out).toFixed(3)}`);
});

test("utterance normalisation leaves loud or silent input untouched", () => {
  const loud = tone(1000, 0.9);
  assert.equal(normalizeUtterance(loud), loud, "already loud enough");
  const silent = new Float32Array(1000);
  assert.equal(normalizeUtterance(silent), silent, "nothing to normalise");
});
