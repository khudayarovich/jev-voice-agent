import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelDownloadProgress } from "../../shared/types.ts";
import { STT_MODELS, type SttModel, downloadUrl, modelById } from "./models.ts";
import { modelsDir } from "./whisper.ts";

/**
 * Fetches speech models on demand.
 *
 * Models are hundreds of megabytes, so shipping every one in the app bundle
 * would be absurd. They download to the same directory the engine reads from,
 * through a temporary file that is only renamed into place once complete — a
 * half-written model would otherwise look installed and fail at load.
 */

export function isInstalled(model: SttModel): boolean {
  const file = path.join(modelsDir(), model.file);
  if (!existsSync(file)) return false;
  // A truncated download is worse than a missing one: it looks present and then
  // fails deep inside the engine. Anything well under the expected size is junk.
  return statSync(file).size > model.bytes * 0.9;
}

export function catalogue(): (SttModel & { installed: boolean })[] {
  return STT_MODELS.map((m) => ({ ...m, installed: isInstalled(m) }));
}

const inFlight = new Map<string, AbortController>();

export async function downloadModel(
  id: string,
  onProgress: (p: ModelDownloadProgress) => void,
): Promise<void> {
  const model = modelById(id);
  if (isInstalled(model)) {
    onProgress({ id, receivedBytes: model.bytes, totalBytes: model.bytes, done: true });
    return;
  }
  if (inFlight.has(id)) return; // already going

  const controller = new AbortController();
  inFlight.set(id, controller);

  const dir = modelsDir();
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, model.file);
  const temp = `${target}.part`;

  try {
    const res = await fetch(downloadUrl(model), { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);

    const totalBytes = Number(res.headers.get("content-length")) || model.bytes;
    let receivedBytes = 0;
    let lastReport = 0;

    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      // Throttle: this fires thousands of times and each one crosses IPC.
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        onProgress({ id, receivedBytes, totalBytes, done: false });
      }
    });

    await pipeline(source, createWriteStream(temp));
    renameSync(temp, target);
    onProgress({ id, receivedBytes: totalBytes, totalBytes, done: true });
  } catch (err) {
    rmSync(temp, { force: true });
    onProgress({
      id,
      receivedBytes: 0,
      totalBytes: model.bytes,
      done: true,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight.delete(id);
  }
}

export function cancelDownload(id: string): void {
  inFlight.get(id)?.abort();
  inFlight.delete(id);
}
