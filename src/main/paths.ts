import { app } from "electron";
import path from "node:path";

/**
 * `app.getAppPath()` resolves to the project root in development and to
 * `.../Contents/Resources/app.asar` once packaged. Both `nativeImage` and the
 * `file://` loader can read straight out of the asar, so one helper covers both.
 */
export function resource(...parts: string[]): string {
  return path.join(app.getAppPath(), "resources", ...parts);
}

export function rendererFile(name: string): string {
  return path.join(app.getAppPath(), "dist", "renderer", name, "index.html");
}

export function preloadFile(): string {
  return path.join(app.getAppPath(), "dist", "preload", "index.js");
}
