import type { JevApi } from "../preload/index";

declare global {
  interface Window {
    jev: JevApi;
  }
}
export {};
