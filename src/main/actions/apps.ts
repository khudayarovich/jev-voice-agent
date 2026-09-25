import type { ActionContext } from "./types.ts";

/**
 * What apps are, in the words people use for them.
 *
 * Jev chooses an app from a list, and a bare list of names only works when the
 * user says the name. People describe instead: "open the camera", "my
 * browser", "the text editor". Observed in real use: "open selfie camera"
 * opened FaceTime and "open camera to take a selfie" opened Google Chrome,
 * because nothing said that Photo Booth is the Mac's camera app. These
 * descriptions ride along as the choice's criteria, so the model can match a
 * description to a name.
 *
 * Pure data and functions: no Electron, easy to test.
 */

const BROWSER = "Web browser.";
const EDITOR = "Code editor.";
const VPN = "VPN.";

const HINTS: Record<string, string> = {
  // --- Apple ---------------------------------------------------------------
  "photo booth": "The Mac's camera app: takes photos, selfies and videos with the built-in camera.",
  facetime: "Video and audio calls.",
  "image capture": "Imports pictures from a connected iPhone, camera or scanner.",
  magnifier: "Magnifies things held in front of a camera, for reading small print.",
  "image playground": "Makes images with AI.",
  safari: BROWSER,
  "safari technology preview": BROWSER,
  finder: "Files and folders: the file manager.",
  "system settings": "Settings for the Mac: Wi-Fi, Bluetooth, display, sound, and so on.",
  "system preferences": "Settings for the Mac: Wi-Fi, Bluetooth, display, sound, and so on.",
  "system information": "Hardware and software details of this Mac.",
  terminal: "The command line: a shell for typing commands.",
  "script editor": "Writes and runs AppleScript.",
  automator: "Builds simple automations; the older cousin of Shortcuts.",
  "activity monitor": "Task manager: running processes, CPU and memory use.",
  textedit: "A simple text editor, like Notepad.",
  notes: "Notes: jotting things down.",
  reminders: "To-do lists and reminders.",
  calendar: "Calendar, events and meetings.",
  mail: "Email.",
  messages: "Text messages: iMessage and SMS.",
  music: "Apple Music, Apple's own music app: songs, albums and playlists. Not other music services.",
  podcasts: "Podcasts.",
  tv: "Films and TV shows.",
  photos: "The photo library: view and edit pictures.",
  preview: "Opens PDFs and images.",
  calculator: "Calculator.",
  maps: "Maps and directions.",
  weather: "Weather forecast.",
  clock: "Alarms, timers, a stopwatch and world clocks.",
  contacts: "The address book: people's numbers and emails.",
  "app store": "Download and update apps.",
  books: "E-books and audiobooks.",
  "voice memos": "Records audio.",
  voicememos: "Records audio.",
  "quicktime player": "Plays video, and records the screen or the camera.",
  screenshot: "Takes screenshots and screen recordings.",
  "keychain access": "Stored passwords and certificates.",
  passwords: "Saved passwords.",
  "disk utility": "Disks and drives.",
  stickies: "Sticky notes on the desktop.",
  freeform: "A whiteboard.",
  shortcuts: "Automations.",
  home: "Smart home devices.",
  news: "News.",
  stocks: "Stock prices.",
  dictionary: "Dictionary and thesaurus.",
  "font book": "Fonts.",
  console: "System logs.",
  phone: "Phone calls, through an iPhone.",
  "iphone mirroring": "Uses the iPhone from the Mac.",
  "find my": "Finds lost devices and people.",
  findmy: "Finds lost devices and people.",
  journal: "A journal or diary.",
  pages: "Word processor for documents.",
  numbers: "Spreadsheets.",
  keynote: "Presentations and slides.",
  garageband: "Makes music.",
  imovie: "Edits video.",
  xcode: "Apple's code editor.",
  siri: "Siri, Apple's voice assistant.",
  tips: "Tips for using the Mac.",
  chess: "A chess game.",
  games: "Apple's games app.",
  apps: "Lists every app, like Launchpad.",
  "screen sharing": "Controls another Mac's screen remotely.",
  "time machine": "Backups: restores files from a Time Machine backup.",
  "migration assistant": "Moves data over from another Mac or PC.",
  "print center": "The printer queue.",
  "audio midi setup": "Audio devices and MIDI.",
  "bluetooth file exchange": "Sends files over Bluetooth.",
  "digital color meter": "Measures the colour of anything on screen.",
  grapher: "Draws graphs of equations.",
  "voiceover utility": "Settings for VoiceOver, the screen reader.",
  // --- common third-party --------------------------------------------------
  "google chrome": BROWSER,
  "google chrome canary": BROWSER,
  firefox: BROWSER,
  "firefox developer edition": BROWSER,
  "microsoft edge": BROWSER,
  "brave browser": BROWSER,
  arc: BROWSER,
  opera: BROWSER,
  vivaldi: BROWSER,
  chromium: BROWSER,
  orion: BROWSER,
  "zen browser": BROWSER,
  zen: BROWSER,
  dia: BROWSER,
  comet: BROWSER,
  duckduckgo: BROWSER,
  "tor browser": BROWSER,
  telegram: "Messaging.",
  whatsapp: "Messaging.",
  signal: "Messaging.",
  slack: "Work chat.",
  discord: "Chat and voice for communities.",
  "zoom.us": "Video meetings (Zoom).",
  "microsoft teams": "Video meetings and work chat.",
  spotify: "Music streaming.",
  vlc: "Plays video.",
  iina: "Plays video.",
  obs: "Records and streams the screen.",
  "microsoft word": "Word processor for documents.",
  "microsoft excel": "Spreadsheets.",
  "microsoft powerpoint": "Presentations and slides.",
  "microsoft outlook": "Email and calendar.",
  "microsoft onenote": "Notebooks and notes.",
  "microsoft remote desktop": "Remote desktop.",
  "google docs": "Documents.",
  "google sheets": "Spreadsheets.",
  "google slides": "Presentations and slides.",
  "google drive": "Cloud files.",
  "foxit pdf reader": "Opens PDFs.",
  "visual studio code": EDITOR,
  code: EDITOR,
  cursor: EDITOR,
  zed: EDITOR,
  "sublime text": EDITOR,
  webstorm: EDITOR,
  pycharm: EDITOR,
  phpstorm: EDITOR,
  "intellij idea": EDITOR,
  "android studio": EDITOR,
  iterm: "Terminal: the command line.",
  iterm2: "Terminal: the command line.",
  warp: "Terminal: the command line.",
  ghostty: "Terminal: the command line.",
  termius: "SSH client for remote servers.",
  chatgpt: "ChatGPT, the AI assistant.",
  "chatgpt classic": "ChatGPT, the AI assistant (older app).",
  claude: "Claude, the AI assistant.",
  opencode: "OpenCode, an AI coding agent.",
  codex: "Codex, OpenAI's coding agent.",
  figma: "Design tool.",
  notion: "Notes, documents and wikis.",
  obsidian: "Notes.",
  trello: "Boards and task cards.",
  postman: "Tests web APIs.",
  docker: "Containers.",
  "github desktop": "Git and GitHub.",
  bitwarden: "Password manager.",
  "1password": "Password manager.",
  metamask: "Crypto wallet.",
  "openvpn connect": VPN,
  wireguard: VPN,
  "proton vpn": VPN,
  anydesk: "Remote desktop.",
  "parallels desktop": "Runs Windows and other systems in a virtual machine.",
  "hik-connect": "Views security cameras (CCTV), not the Mac's own camera.",
  "ip scanner": "Finds devices on the local network.",
  wireshark: "Captures network traffic.",
  unifi: "Manages UniFi network equipment.",
  "ntfs for mac": "Reads and writes Windows (NTFS) drives.",
  "unzip - rar zip 7z unarchiver": "Opens zip and rar archives.",
  "3utools": "Manages an iPhone: backups, files, firmware.",
  steam: "Games.",
  "epic games launcher": "Games.",
  moonlight: "Streams games from a PC.",
  godot: "Game engine.",
  "unity hub": "Game engine.",
};

const BROWSERS = new Set(Object.keys(HINTS).filter((k) => HINTS[k] === BROWSER));

const key = (name: string) => name.trim().toLowerCase();

export function isBrowser(name: string): boolean {
  return BROWSERS.has(key(name));
}

/** What to tell the model about each running or installed app. */
export interface AppNotes {
  /** The browser links open in by default. */
  defaultBrowser?: string;
  /** The app in front right now. */
  frontmost?: string;
  /** The browser the user was just using. */
  lastBrowser?: string;
  /** Apps that are running. */
  running?: ReadonlySet<string>;
}

/**
 * A short description for one app, or null for one we know nothing about.
 * Browsers are told apart, because "the browser" usually means one of them:
 * the one in use, or else the user's default.
 */
export function describeApp(name: string, notes: AppNotes = {}): string | null {
  const hint = HINTS[key(name)] ?? null;
  const extra: string[] = [];
  if (notes.lastBrowser && key(notes.lastBrowser) === key(name)) extra.push("the browser the user just used");
  if (notes.frontmost && key(notes.frontmost) === key(name)) extra.push("in front right now");
  else if (notes.running?.has(name)) extra.push("open now");
  if (notes.defaultBrowser && key(notes.defaultBrowser) === key(name)) extra.push("the user's default browser");
  if (!hint && extra.length === 0) return null;
  return [hint ?? "", extra.length ? `(${extra.join("; ")})` : ""].join(" ").trim();
}

// ---------------------------------------------------------------------------
// Several browsers at once
// ---------------------------------------------------------------------------

/**
 * A group option, for "close all the browsers": acts on every running browser.
 * Offered only when the words ask for more than one, and there is more than one.
 */
export const ALL_BROWSERS = "Every open web browser";

export function wantsAll(transcript: string): boolean {
  return /\bbrowsers\b|\b(all|every|both)\b.*\bbrowser/i.test(transcript);
}

/** The apps a group option stands for; a plain name stands for itself. */
export function expandApps(name: string, running: string[]): string[] {
  return name === ALL_BROWSERS ? running.filter(isBrowser) : [name];
}

/** "Safari", "Safari and Chrome", "Safari, Chrome and Firefox". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ---------------------------------------------------------------------------
// Which browser a link opens in
// ---------------------------------------------------------------------------

/** What people call each browser, and the app names it may be installed as. */
const BROWSER_ALIASES: Record<string, string[]> = {
  chrome: ["Google Chrome", "Google Chrome Canary", "Chromium"],
  safari: ["Safari", "Safari Technology Preview"],
  firefox: ["Firefox", "Firefox Developer Edition"],
  edge: ["Microsoft Edge"],
  brave: ["Brave Browser"],
  arc: ["Arc"],
  opera: ["Opera"],
  vivaldi: ["Vivaldi"],
  orion: ["Orion"],
  zen: ["Zen Browser", "Zen"],
  tor: ["Tor Browser"],
  chromium: ["Chromium"],
};

/**
 * "… in Chrome", "… using Safari", "… with the Firefox browser" at the end of
 * a request. Anchored to the end, so a query that merely contains the word
 * ("search for the edge of tomorrow") is left alone.
 */
const BROWSER_MENTION = new RegExp(
  `\\s*,?\\s*\\b(?:in|on|with|using|via|through)\\s+(?:the\\s+|my\\s+)?(?:google\\s+|microsoft\\s+|mozilla\\s+)?(${Object.keys(BROWSER_ALIASES).join("|")})(?:\\s+browser)?\\s*[.!?]*$`,
  "i",
);

const BROWSER_NAME = new RegExp(`\\b(${Object.keys(BROWSER_ALIASES).join("|")})\\b`, "i");

/**
 * "the browser", "my browser", "a web browser" — a browser, but not which.
 * Which one is then a rule rather than a judgment: see `pickBrowser`.
 */
export function refersToBrowser(transcript: string): boolean {
  return /\bbrowser\b/i.test(transcript) && !BROWSER_NAME.test(transcript);
}

/** The request without a trailing "in Chrome": that part is not the query. */
export function withoutBrowser(transcript: string): string {
  return transcript.replace(BROWSER_MENTION, "").trim();
}

/** The installed browser a request names, if any. */
export function namedBrowser(transcript: string, available: Iterable<string>): string | null {
  const said = BROWSER_MENTION.exec(transcript)?.[1]?.toLowerCase();
  if (!said) return null;
  const have = new Set(available);
  return BROWSER_ALIASES[said]?.find((name) => have.has(name)) ?? null;
}

/**
 * The browser a link or a search should open in, or null for the system
 * default.
 *
 * Observed in real use: "open my browser" opened Chrome, and the search that
 * followed opened in Safari — the default — so the user ended up with two
 * browsers and the result in the one they were not looking at. A link opens,
 * in order of preference:
 *   1. in the browser the user named ("open YouTube in Chrome")
 *   2. in the browser in front, since that is where they are looking
 *   3. in the browser they just used, by voice
 *   4. in a browser that is already open — with a window showing: a browser
 *      running with no window is not what anyone means by the open browser.
 *      Observed in real use: Firefox, running unseen in the background, was
 *      picked for "open browser" over the default.
 *   5. in the default browser
 */
export function pickBrowser(ctx: ActionContext): string | null {
  const available = [...ctx.runningApps, ...ctx.installedApps];
  const named = namedBrowser(ctx.transcript, available);
  if (named) return named;
  if (ctx.focusedApp && isBrowser(ctx.focusedApp)) return ctx.focusedApp;
  if (ctx.lastBrowser && available.includes(ctx.lastBrowser)) return ctx.lastBrowser;

  // Which apps have a window is not always known; then running is the best guess.
  const running = ctx.runningApps.filter(isBrowser);
  const open = ctx.windowedApps ? running.filter((b) => ctx.windowedApps!.includes(b)) : running;
  if (open.length === 0) return null;
  if (ctx.defaultBrowser && open.includes(ctx.defaultBrowser)) return null;
  // Several open, none of them the default: the most recently launched one.
  // installedApps is ordered most recently used first.
  const order = (name: string) => {
    const i = ctx.installedApps.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...open].sort((a, b) => order(a) - order(b))[0] ?? null;
}
