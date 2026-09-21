/**
 * Automatic gain for the recognition path.
 *
 * Chromium's own AGC is switched off at capture, because it smears the signal in
 * exactly the way speech recognition suffers from. But the keyword spotter turns
 * out to be strongly level-dependent: with the wake phrase at full scale it
 * fires reliably, and the SAME audio attenuated to a peak of 0.3 — an ordinary
 * level for someone speaking normally at arm's length — is missed at every
 * threshold. Lowering the threshold does not help; the features themselves are
 * level-sensitive.
 *
 * So gain is applied here instead, deliberately and visibly, rather than left to
 * the browser: a slow-adapting estimate of recent speech peak, used to bring the
 * signal up toward a target. Slow adaptation matters — a fast one pumps the
 * noise floor up between words and makes the VAD hallucinate speech.
 */

/** Where we want speech peaks to sit. Short of 1.0 to leave headroom. */
const TARGET_PEAK = 0.7;
/** Never amplify below this: it is noise, and boosting it helps nothing. */
const NOISE_FLOOR = 0.004;
const MAX_GAIN = 24;
/** Per-block decay of the peak estimate (~64 ms blocks). */
const DECAY = 0.96;

export class AutoGain {
  private peak = 0;
  private gain = 1;

  /** Current gain, for diagnostics. */
  get value(): number {
    return this.gain;
  }

  /**
   * Returns a gained copy, leaving the caller's buffer untouched.
   *
   * The original is kept intact because the un-gained signal is the honest one
   * for level metering.
   */
  process(samples: Float32Array): Float32Array {
    let blockPeak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i] ?? 0);
      if (v > blockPeak) blockPeak = v;
    }

    // Hold everything steady on a silent block.
    //
    // Adapting here would be actively harmful: with no signal the peak estimate
    // decays, the computed gain is TARGET/peak, and so the gain climbs the
    // longer the room stays quiet — winding up to maximum and then slamming the
    // first word of the next utterance. Only blocks containing real signal are
    // allowed to move the estimate.
    if (blockPeak < NOISE_FLOOR) return applyGain(samples, this.gain);

    // Rise instantly to a louder peak, fall away slowly.
    this.peak = Math.max(blockPeak, this.peak * DECAY);

    const wanted = Math.min(MAX_GAIN, Math.max(1, TARGET_PEAK / this.peak));
    // Smooth so the gain cannot jump mid-word.
    this.gain += (wanted - this.gain) * 0.25;
    return applyGain(samples, this.gain);
  }

  reset(): void {
    this.peak = 0;
    this.gain = 1;
  }
}

function applyGain(samples: Float32Array, gain: number): Float32Array {
  if (gain <= 1.001) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] ?? 0) * gain;
    // Soft clip rather than hard: a hard clip is broadband distortion, which is
    // precisely what the recogniser handles worst.
    out[i] = v > 1 || v < -1 ? Math.tanh(v) : v;
  }
  return out;
}

/**
 * Peak-normalise a complete utterance before transcription.
 *
 * Applied to the whole buffer at once, so unlike the streaming gain above this
 * can see the real maximum and needs no smoothing.
 */
export function normalizeUtterance(samples: Float32Array, target = 0.85): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] ?? 0);
    if (v > peak) peak = v;
  }
  if (peak < 1e-4 || peak >= target) return samples;
  const gain = Math.min(MAX_GAIN, target / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) * gain;
  return out;
}
