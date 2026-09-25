import type { HudModel } from "./types.ts";

/**
 * The one line the overlay shows: the user's words while they are being said
 * and read, then what the agent has to say — its question, or how the command
 * went. Observed in real use, with the words kept on screen throughout: "Quit
 * Safari? Say yes to confirm" and "Learn X? Say yes to keep it" were never
 * seen, and both timed out unanswered; a failure showed only a shake.
 */
export function hudBody(m: Pick<HudModel, "state" | "transcript" | "detail" | "result">): string {
  const agentSpeaks = m.state === "confirming" || m.state === "error" || m.result !== undefined;
  if (agentSpeaks && m.detail) return m.detail;
  return m.transcript || m.detail;
}
