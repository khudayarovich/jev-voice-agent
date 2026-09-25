/**
 * Bundles a script and runs it inside Electron, so it uses the same network
 * stack and the same stored API key as the app itself.
 *
 *   node scripts/run-in-electron.mjs scripts/bench/main.ts [args…]
 *
 * See each script for what it measures.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node scripts/run-in-electron.mjs <script.ts> [args…]");
  process.exit(2);
}
const name = path.basename(path.dirname(path.resolve(root, entry)));
const out = path.join(root, "dist", name, "main.js");

await esbuild.build({
  entryPoints: [path.resolve(root, entry)],
  outfile: out,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron", "sherpa-onnx-node"],
  logLevel: "warning",
});

const electron = path.join(root, "node_modules", ".bin", "electron");
const child = spawn(electron, [out, ...args], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, JEV_ROOT: root },
});
child.on("exit", (code) => process.exit(code ?? 1));
