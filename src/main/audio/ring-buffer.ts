/**
 * Fixed-capacity ring of audio samples.
 *
 * This exists for one reason: people say "Hey Jeff, open Safari" as a single
 * unbroken breath, and a hotkey gets pressed *while* the user is already
 * speaking. Without retained audio from before the trigger, the beginning of
 * every command is clipped — the single most-reported bug in comparable tools,
 * usually blamed on the ~500 ms it takes to open a microphone. Here the stream
 * is opened once and left running, and this holds the recent past.
 */
export class RingBuffer {
  private readonly buf: Float32Array;
  private write = 0;
  private filled = 0;

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i] ?? 0;
      this.write = (this.write + 1) % this.capacity;
    }
    this.filled = Math.min(this.capacity, this.filled + samples.length);
  }

  /** The most recent `count` samples, oldest first. */
  tail(count: number): Float32Array {
    const n = Math.min(count, this.filled);
    const out = new Float32Array(n);
    let read = (this.write - n + this.capacity * 2) % this.capacity;
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[read] ?? 0;
      read = (read + 1) % this.capacity;
    }
    return out;
  }

  clear(): void {
    this.write = 0;
    this.filled = 0;
  }
}
