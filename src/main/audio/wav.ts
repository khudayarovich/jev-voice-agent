/** In-memory WAV encoding. The STT server takes a file upload, not raw PCM. */

export const SAMPLE_RATE = 16000;

/** Mono 16-bit PCM WAV from float samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return withHeader(data, sampleRate);
}

/** Mono 16-bit PCM WAV from samples that are already int16. */
export function encodeWavFromInt16(samples: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  return withHeader(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength), sampleRate);
}

function withHeader(data: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function int16ToFloat32(src: Int16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = (src[i] ?? 0) / 32768;
  return out;
}

/** Root-mean-square level of a block, for the HUD meter. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}
