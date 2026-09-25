/**
 * Bundles scripts/bench/main.ts and runs it inside Electron.
 * See that file for what it measures.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "bench", "main.js");

await esbuild.build({
  entryPoints: [path.join(root, "scripts/bench/main.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron", "sherpa-onnx-node"],
  logLevel: "warning",
});

const electron = path.join(root, "node_modules", ".bin", "electron");
const child = spawn(electron, [out, ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, JEV_ROOT: root },
});
child.on("exit", (code) => process.exit(code ?? 1));
