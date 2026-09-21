import path from "node:path";
import { app } from "electron";

/**
 * Lazy access to the sherpa-onnx native addon.
 *
 * It is a N-API addon, so it is ABI-stable across Node and Electron versions and
 * needs no rebuild — but it is ~33 MB of dylibs, so loading is deferred until
 * something actually needs speech. A failure to load must degrade to "wake word
 * unavailable", never to a crash on launch.
 */

// The addon has no bundled types; this describes only what we use.
export interface SherpaModule {
  Vad: new (config: unknown, bufferSizeSeconds: number) => SherpaVad;
  KeywordSpotter: new (config: unknown) => SherpaKws;
  readWave: (p: string) => { sampleRate: number; samples: Float32Array };
}

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  /**
   * `enableExternalBuffer` MUST be false inside Electron — see Vad.drain().
   * The addon defaults it to true.
   */
  front(enableExternalBuffer: boolean): { start: number; samples: Float32Array };
  pop(): void;
  clear(): void;
  reset(): void;
  flush(): void;
}

export interface SherpaKwsStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

export interface SherpaKws {
  createStream(): SherpaKwsStream;
  isReady(s: SherpaKwsStream): boolean;
  decode(s: SherpaKwsStream): void;
  reset(s: SherpaKwsStream): void;
  getResult(s: SherpaKwsStream): { keyword: string };
}

let cached: SherpaModule | null = null;
let failed = false;

export function loadSherpa(): SherpaModule | null {
  if (cached) return cached;
  if (failed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("sherpa-onnx-node") as SherpaModule;
    return cached;
  } catch (err) {
    failed = true;
    console.error("[sherpa] native addon failed to load:", err);
    return null;
  }
}

export function modelDir(...parts: string[]): string {
  return path.join(app.getAppPath(), "resources", "models", ...parts);
}

export const KWS_MODEL_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
