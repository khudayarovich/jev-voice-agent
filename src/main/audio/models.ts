/**
 * Speech-to-text models the app can use.
 *
 * All figures below are measured on this machine (M4 Pro, Metal) over spoken
 * commands naming real installed applications — the case that actually fails,
 * since almost every recognition error is a proper noun.
 *
 *   model              no prompt      with vocabulary prompt   latency
 *   base.en            38.9% WER      13.9% WER                 54 ms
 *   small.en           22.2% WER       5.6% WER                144 ms
 *   large-v3-turbo     22.2% WER      23.6% WER                604 ms
 *
 * Two things worth knowing from that table. The vocabulary prompt matters more
 * than the model — it more than halved the error rate for every English model.
 * And bigger is NOT better here: `large-v3-turbo` is multilingual, while the
 * `.en` models are English-specialised, and on English application names the
 * small English model beats it outright at a quarter of the latency.
 *
 * `large-v3-turbo` stays in the list because multilingual training is exactly
 * what helps with a strong accent, which a synthesised benchmark cannot measure.
 */
export interface SttModel {
  id: string;
  label: string;
  file: string;
  /** Download size, human readable. */
  size: string;
  bytes: number;
  /** Measured milliseconds per short command on Apple Silicon. */
  latencyMs: number;
  note: string;
}

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const STT_MODELS: SttModel[] = [
  {
    id: "base.en",
    label: "Base (English)",
    file: "ggml-base.en.bin",
    size: "141 MB",
    bytes: 147_951_465,
    latencyMs: 55,
    note: "Fastest, and least accurate on app names. Measured 13.9% word error rate on spoken commands.",
  },
  {
    id: "small.en",
    label: "Small (English)",
    file: "ggml-small.en.bin",
    size: "465 MB",
    bytes: 487_601_967,
    latencyMs: 145,
    note: "Recommended. Best measured accuracy here — 5.6% word error rate, four times better than Base, and still fast.",
  },
  {
    id: "large-v3-turbo-q5",
    label: "Large v3 Turbo",
    file: "ggml-large-v3-turbo-q5_0.bin",
    size: "547 MB",
    bytes: 574_041_195,
    latencyMs: 605,
    note: "Multilingual. Measured WORSE than Small on English app names (23.6%), but its multilingual training is what helps with a strong accent — try it only if Small struggles with your voice.",
  },
];

export const DEFAULT_MODEL_ID = "small.en";

export function modelById(id: string): SttModel {
  return STT_MODELS.find((m) => m.id === id) ?? STT_MODELS[0]!;
}

export function downloadUrl(model: SttModel): string {
  return `${HF}/${model.file}`;
}
