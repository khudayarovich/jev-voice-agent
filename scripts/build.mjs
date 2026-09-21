import * as esbuild from "esbuild";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

/** Renderer entry points: each is a folder under src/renderer with index.ts + index.html */
const RENDERERS = ["settings", "hud", "capture"];

const common = {
  bundle: true,
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  logLevel: "info",
};

/** Main + preload run in Node/Electron: CommonJS, electron kept external. */
const nodeTargets = [
  {
    ...common,
    entryPoints: [path.join(root, "src/main/index.ts")],
    outfile: path.join(root, "dist/main/index.js"),
    platform: "node",
    target: "node22",
    format: "cjs",
    // electron is provided by the runtime; native addons must not be bundled
    external: ["electron", "sherpa-onnx-node", "node-*"],
  },
  {
    ...common,
    entryPoints: [path.join(root, "src/preload/index.ts")],
    outfile: path.join(root, "dist/preload/index.js"),
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
  },
];

/** Renderers run in Chromium: IIFE, no Node builtins. */
const webTargets = RENDERERS.filter((r) =>
  existsSync(path.join(root, `src/renderer/${r}/index.ts`)),
).map((r) => ({
  ...common,
  entryPoints: [path.join(root, `src/renderer/${r}/index.ts`)],
  outfile: path.join(root, `dist/renderer/${r}/index.js`),
  platform: "browser",
  target: "chrome130",
  format: "iife",
}));

async function copyStatic() {
  for (const r of RENDERERS) {
    const src = path.join(root, `src/renderer/${r}`);
    if (!existsSync(src)) continue;
    const dest = path.join(root, `dist/renderer/${r}`);
    await mkdir(dest, { recursive: true });
    for (const f of await readdir(src)) {
      if (f.endsWith(".html") || f.endsWith(".css")) {
        await cp(path.join(src, f), path.join(dest, f));
      }
    }
  }
  // AudioWorklet processors are loaded by URL at runtime, never bundled into the page.
  const worklet = path.join(root, "src/renderer/capture/pcm-worklet.js");
  if (existsSync(worklet)) {
    await mkdir(path.join(root, "dist/renderer/capture"), { recursive: true });
    await cp(worklet, path.join(root, "dist/renderer/capture/pcm-worklet.js"));
  }
}

const all = [...nodeTargets, ...webTargets];

if (watch) {
  for (const cfg of all) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  await copyStatic();
  console.log("[build] watching…");
} else {
  await Promise.all(all.map((cfg) => esbuild.build(cfg)));
  await copyStatic();
  console.log("[build] done");
}
