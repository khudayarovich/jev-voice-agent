/**
 * Copies what the agent has learned into knowledge/ in this repository, to
 * review and commit — the knowledge base that future built-in commands are
 * made from.
 *
 *   npm run kb:export
 *
 * Reads the app's own folder in Application Support:
 *   learned-commands.json   what it knows now
 *   knowledge-base.jsonl    every lesson ever, learned or forgotten
 *
 * Each entry includes the request that taught it, in the user's own words:
 * read it through before committing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(os.homedir(), "Library", "Application Support", "jev-voice-agent");
const to = path.join(root, "knowledge");
mkdirSync(to, { recursive: true });

const memory = path.join(from, "learned-commands.json");
const log = path.join(from, "knowledge-base.jsonl");

const commands = existsSync(memory) ? (JSON.parse(readFileSync(memory, "utf8")).commands ?? []) : [];
commands.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(path.join(to, "learned-commands.json"), `${JSON.stringify({ version: 1, commands }, null, 2)}\n`);

const lessons = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
writeFileSync(path.join(to, "knowledge-base.jsonl"), lessons.length ? `${lessons.join("\n")}\n` : "");

console.log(`${commands.length} learned command${commands.length === 1 ? "" : "s"}, ${lessons.length} lesson${lessons.length === 1 ? "" : "s"} → ${path.relative(root, to)}/`);
for (const c of commands) console.log(`  ${c.id.padEnd(28)} ${c.title}  (used ${c.uses}×)`);
