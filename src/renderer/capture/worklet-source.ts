/**
 * Source for the capture AudioWorklet.
 *
 * Kept in its own module, as a string, for two reasons: it is injected via a
 * Blob URL (a file:// page cannot `addModule` a relative path — Chromium treats
 * it as a cross-origin fetch), and keeping it importable lets the resampler be
 * tested in plain Node without an audio device. See tests/resampler.test.ts.
 */
export const WORKLET_SOURCE = `
/**
 * Resamples the device's native rate down to 16 kHz and emits int16 blocks.
 *
 * The resampling happens HERE rather than by asking for a 16 kHz AudioContext.
 * Chromium opens an output device for every AudioContext even when nothing is
 * connected to its destination, so requesting a non-native rate forces the
 * system output device to reconfigure — which on macOS wedges CoreAudio and
 * hangs unrelated playback (afplay stops dead). Taking the native rate and
 * converting in software leaves the device alone.
 */
class PcmCollector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { block, targetRate } = options.processorOptions;
    this.block = block;
    this.ratio = sampleRate / targetRate;   // e.g. 48000/16000 = 3
    this.buf = new Float32Array(block);
    this.filled = 0;
    this.phase = 0;                          // fractional read position

    // Anti-alias low-pass just under the 8 kHz Nyquist of the target rate.
    // Decimating without this folds high-frequency energy back into the speech
    // band as noise, which measurably hurts recognition.
    this.taps = this.designLowPass(7200 / sampleRate, 32);
    this.history = new Float32Array(this.taps.length);
  }

  /** Windowed-sinc FIR, Hann window. cutoff is normalised (0..0.5). */
  designLowPass(cutoff, n) {
    const taps = new Float32Array(n);
    const mid = (n - 1) / 2;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      taps[i] = sinc * window;
      sum += taps[i];
    }
    for (let i = 0; i < n; i++) taps[i] /= sum;  // unity DC gain
    return taps;
  }

  /** Push one input sample through the FIR and return the filtered output. */
  filter(x) {
    const h = this.history;
    h.copyWithin(0, 1);
    h[h.length - 1] = x;
    let acc = 0;
    for (let i = 0; i < this.taps.length; i++) acc += this.taps[i] * h[h.length - 1 - i];
    return acc;
  }

  emit() {
    const pcm = new Int16Array(this.block);
    let sum = 0;
    for (let j = 0; j < this.block; j++) {
      const v = Math.max(-1, Math.min(1, this.buf[j]));
      pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
      sum += v * v;
    }
    this.port.postMessage({ pcm, level: Math.sqrt(sum / this.block) }, [pcm.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const filtered = this.filter(channel[i]);
      // Take one output sample every \`ratio\` input samples.
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.buf[this.filled++] = filtered;
        if (this.filled === this.block) this.emit();
      }
    }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);
`;
