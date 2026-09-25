import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { isInstalled } from "./audio/download.ts";
import { modelById } from "./audio/models.ts";
import { Vad } from "./audio/vad.ts";
import { WakeWord } from "./audio/wake.ts";
import { WhisperEngine, binaryPath } from "./audio/whisper.ts";
import { screenHelper } from "./platform/macos/index.ts";
import { getSettings } from "./settings-store.ts";

const exec = promisify(execFile);

/**
 * `--self-test`: check that every native piece works, then exit.
 *
 *   "/Applications/Jev Voice Agent.app/Contents/MacOS/Jev Voice Agent" --self-test
 *
 * No microphone, no window, no network, no permission prompt — so it can prove
 * an installed copy is whole (the speech engine runs, the bundled models load)
 * on a machine nobody is sitting at, and it gives a bug report something
 * concrete to paste.
 */
export async function selfTest(): Promise<boolean> {
  const results: { check: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => Promise<string> | string) => {
    try {
      results.push({ check: name, ok: true, detail: await fn() });
    } catch (err) {
      results.push({ check: name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await check("speech engine", async () => {
    const bin = binaryPath();
    if (!existsSync(bin)) throw new Error(`missing: ${bin}`);
    // --help loads the binary and everything it links, then exits.
    await exec(bin, ["--help"], { timeout: 10_000 });
    return bin;
  });

  await check("clicking helper", async () => {
    const bin = screenHelper();
    if (!existsSync(bin)) throw new Error(`missing: ${bin}`);
    const { stdout } = await exec(bin, ["--version"], { timeout: 10_000 });
    if (!(JSON.parse(stdout) as { ok?: boolean }).ok) throw new Error(stdout.trim());
    return bin;
  });

  await check("voice activity model", () => {
    if (!new Vad().start()) throw new Error("did not load");
    return "Silero VAD loaded";
  });

  await check("wake-word model", () => {
    const wake = new WakeWord({ phrases: ["hey jeff"] });
    if (!wake.start()) throw new Error("did not load");
    wake.stop();
    return "keyword spotter loaded";
  });

  const id = getSettings().sttModel;
  if (isInstalled(modelById(id))) {
    await check(`speech model ${id}`, async () => {
      const engine = new WhisperEngine(id);
      try {
        await engine.start();
        const started = Date.now();
        await engine.transcribe(new Float32Array(16_000));
        return `transcribed a second of audio in ${Date.now() - started} ms`;
      } finally {
        engine.stop();
      }
    });
  } else {
    results.push({ check: `speech model ${id}`, ok: true, detail: "not downloaded yet; fetched on first start" });
  }

  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.check.padEnd(24)} ${r.detail}`);
  return results.every((r) => r.ok);
}
