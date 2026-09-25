import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, net } from "electron";
import type { LearnedCommand } from "./lesson.ts";

/**
 * The agent's memory of what it has learned, and its knowledge base.
 *
 *   learned-commands.json   what it knows now: read at every command
 *   knowledge-base.jsonl    every lesson ever, learned or forgotten, one per
 *                           line — the record to improve the agent from later
 *
 * Both live in the app's own folder in Application Support. With a knowledge
 * base address set in Settings, each lesson is also sent there as JSON; that
 * is off unless the user sets one.
 */

let cache: LearnedCommand[] | null = null;

const folder = () => app.getPath("userData");
const memoryFile = () => path.join(folder(), "learned-commands.json");
export const knowledgeFile = () => path.join(folder(), "knowledge-base.jsonl");

export function learnedCommands(): LearnedCommand[] {
  if (cache) return cache;
  try {
    const raw = existsSync(memoryFile()) ? (JSON.parse(readFileSync(memoryFile(), "utf8")) as { commands?: LearnedCommand[] }) : {};
    cache = Array.isArray(raw.commands) ? raw.commands : [];
  } catch {
    // A damaged file must not stop the agent: it simply knows nothing learned.
    cache = [];
  }
  return cache;
}

function persist(commands: LearnedCommand[]): void {
  mkdirSync(folder(), { recursive: true });
  const tmp = `${memoryFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, commands }, null, 2), { mode: 0o600 });
  renameSync(tmp, memoryFile());
  cache = commands;
}

/** Remember a command; one with the same id is replaced. */
export function remember(command: LearnedCommand): void {
  persist([...learnedCommands().filter((c) => c.id !== command.id), command]);
}

export function forget(id: string): LearnedCommand | null {
  const found = learnedCommands().find((c) => c.id === id) ?? null;
  if (found) persist(learnedCommands().filter((c) => c.id !== id));
  return found;
}

export function countUse(id: string): void {
  const commands = learnedCommands().map((c) => (c.id === id ? { ...c, uses: c.uses + 1 } : c));
  persist(commands);
}

export interface KnowledgeEvent {
  event: "learned" | "forgotten";
  at: string;
  appVersion: string;
  platform: string;
  command: LearnedCommand;
}

/**
 * Add a lesson to the knowledge base: always the file on this Mac, and the
 * address in Settings when there is one. Sending never blocks or fails the
 * command; a failure is returned for the log.
 */
export async function recordLesson(
  event: KnowledgeEvent["event"],
  command: LearnedCommand,
  sendTo: string,
): Promise<string | null> {
  const entry: KnowledgeEvent = {
    event,
    at: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    command,
  };
  mkdirSync(folder(), { recursive: true });
  appendFileSync(knowledgeFile(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  if (!/^https:\/\//i.test(sendTo.trim())) return null;
  try {
    const res = await net.fetch(sendTo.trim(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? null : `knowledge base answered ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
