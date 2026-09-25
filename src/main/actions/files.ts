import { homedir } from "node:os";
import path from "node:path";

/**
 * Files and folders, as people name them.
 */

/** The folders people ask for by name, and where they are. */
export const FOLDERS: Record<string, string> = {
  Desktop: path.join(homedir(), "Desktop"),
  Downloads: path.join(homedir(), "Downloads"),
  Documents: path.join(homedir(), "Documents"),
  Pictures: path.join(homedir(), "Pictures"),
  Music: path.join(homedir(), "Music"),
  Movies: path.join(homedir(), "Movies"),
  Applications: "/Applications",
  Home: homedir(),
};

const FOLDER_WORDS: Record<string, string[]> = {
  Desktop: ["desktop"],
  Downloads: ["downloads", "download"],
  Documents: ["documents", "document"],
  Pictures: ["pictures", "photos folder"],
  Music: ["music folder"],
  Movies: ["movies", "videos folder"],
  Applications: ["applications", "apps folder", "applications folder"],
  Home: ["home", "home folder", "my folder", "user folder"],
};

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;

/** The folders a request names, best first. */
export function shortlistFolders(transcript: string): string[] {
  const t = norm(transcript);
  return Object.entries(FOLDER_WORDS)
    .map(([name, words]) => ({ name, score: Math.max(0, ...words.filter((w) => t.includes(` ${w} `)).map((w) => w.length)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.name);
}

/**
 * "rename the untitled folder on the desktop to Hello World" → which item,
 * and what to call it. The item is null when the words name none in
 * particular — "rename it", "rename the folder" — and the selection is meant.
 */
export function renameRequest(transcript: string): { item: string | null; to: string | null } {
  const m = transcript
    .trim()
    .replace(/[.?!]+$/, "")
    // "And the name the folder as hello": speech adds a word or two in front.
    .match(/^(?:please\s+|and\s+|the\s+|then\s+)*(?:rename|name|call)\s+(.*?)\s+(?:to|as|into)\s+(?:a\s+|an\s+|the\s+)?(.+)$/i);
  if (!m) return { item: null, to: null };
  let item = m[1]!
    .replace(/\s+(?:on|in|at|from)\s+(?:the\s+|my\s+)?(?:desktop|finder|screen|window|downloads|documents)(?:\s+folder)?$/i, "")
    .replace(/^(?:the|this|that|it|my)\s+/i, "")
    .replace(/^(?:new|selected|current|highlighted)\s+/i, "")
    .trim();
  if (/^(?:it|this|that|folder|file|item|one|new folder|new file|selected)?$/i.test(item)) item = "";
  return { item: item || null, to: m[2]!.trim() };
}

/** "create a new folder called reports" → "reports"; nothing named → null. */
export function newFolderName(transcript: string): string | null {
  const m = transcript
    .trim()
    .replace(/[.?!]+$/, "")
    .match(/\b(?:called|named|name it|with the name|with name|titled)\s+(?:a\s+|the\s+)?(.+)$/i);
  return m?.[1]?.replace(/\s+(?:on|in)\s+(?:the\s+)?(?:desktop|finder|downloads|documents)(?:\s+folder)?$/i, "").trim() || null;
}
