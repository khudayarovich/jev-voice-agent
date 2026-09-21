import { MacPlatform } from "./macos/index.ts";
import type { PlatformAdapter } from "./types.ts";
import { WindowsPlatform } from "./windows/index.ts";

let adapter: PlatformAdapter | null = null;

export function platform(): PlatformAdapter {
  if (!adapter) {
    adapter = process.platform === "win32" ? new WindowsPlatform() : new MacPlatform();
  }
  return adapter;
}

export type { PlatformAdapter } from "./types.ts";
export { NotImplementedError } from "./types.ts";
