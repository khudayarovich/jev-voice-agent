import type { JevApi } from "../preload/index.ts";

declare global {
  interface Window {
    jev: JevApi;
  }
}
export {};
