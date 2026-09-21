import { EventEmitter } from "node:events";
import type { AgentState, CommandLogEntry, HudModel } from "../shared/types.ts";

/**
 * The state machine every other module reports into.
 *
 * Phase 1 only tracks state and fans it out to the tray and HUD; the audio
 * pipeline and the Jev router hang off this in later phases. Keeping it as the
 * single owner of `AgentState` is what stops the tray, the HUD, and the
 * transcript from ever disagreeing.
 */
class Coordinator extends EventEmitter {
  private state: AgentState = "disabled";
  private listening = false;
  private hud: HudModel = {
    state: "disabled",
    transcript: "",
    partial: false,
    detail: "",
    level: 0,
  };
  private log: CommandLogEntry[] = [];

  getState(): AgentState {
    return this.state;
  }

  isListening(): boolean {
    return this.listening;
  }

  getHud(): HudModel {
    return this.hud;
  }

  getLog(): CommandLogEntry[] {
    return this.log;
  }

  setState(state: AgentState, detail = ""): void {
    if (this.state === state && this.hud.detail === detail) return;
    this.state = state;
    this.hud = { ...this.hud, state, detail };
    this.emit("state", state);
    this.emit("hud", this.hud);
  }

  /** Update the live transcript shown in the HUD. */
  setTranscript(text: string, partial: boolean): void {
    this.hud = { ...this.hud, transcript: text, partial };
    this.emit("hud", this.hud);
  }

  setLevel(level: number): void {
    // Meter updates are frequent; only emit on a visible change.
    const next = Math.max(0, Math.min(1, level));
    if (Math.abs(next - this.hud.level) < 0.02) return;
    this.hud = { ...this.hud, level: next };
    this.emit("hud", this.hud);
  }

  setListening(on: boolean): void {
    if (this.listening === on) return;
    this.listening = on;
    this.setState(on ? "idle" : "disabled");
    this.emit("listening", on);
  }

  append(entry: CommandLogEntry): void {
    this.log.unshift(entry);
    // Bounded: this is a diagnostics aid, not an archive.
    if (this.log.length > 200) this.log.length = 200;
    this.emit("log", entry);
  }
}

export const coordinator = new Coordinator();
