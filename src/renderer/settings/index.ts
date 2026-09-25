import type {
  ActionSummary,
  ModelDownloadProgress,
  SttModelInfo,
  AgentState,
  AppSettings,
  CommandLogEntry,
  PermissionId,
  PermissionInfo,
  PermissionState,
} from "../../shared/types.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const navs = [...document.querySelectorAll<HTMLButtonElement>(".nav")];
const tabs = [...document.querySelectorAll<HTMLElement>("section.tab")];

function showTab(name: string): void {
  if (!navs.some((n) => n.dataset.tab === name)) return;
  for (const n of navs) n.setAttribute("aria-current", String(n.dataset.tab === name));
  for (const t of tabs) t.hidden = t.dataset.tab !== name;
  if (name === "permissions") void renderPermissions();
  if (name === "activity") void renderLog();
  if (name === "commands") void renderCommands();
  if (name === "about") void renderAbout();
}

for (const btn of navs) btn.addEventListener("click", () => showTab(btn.dataset.tab!));
// "About JVA" in the menu bar opens this window on a given tab.
window.jev.on.showTab(showTab);

// A grant given in System Settings shows here the moment the user comes back,
// or the moment the app notices it — not on the next visit to this pane.
const permissionsShowing = () => !tabs.find((t) => t.dataset.tab === "permissions")?.hidden;
window.jev.on.permissionsChanged(() => {
  if (permissionsShowing()) void renderPermissions();
});
window.addEventListener("focus", () => {
  if (permissionsShowing()) void renderPermissions();
});

// ---------------------------------------------------------------------------
// Settings binding
// ---------------------------------------------------------------------------

let settings: AppSettings;
/** Guards the change handlers while we populate inputs programmatically. */
let hydrating = true;

async function save(patch: Partial<AppSettings>): Promise<void> {
  if (hydrating) return;
  settings = await window.jev.settings.set(patch);
}

function bindCheckbox(id: keyof AppSettings & string): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("change", () => void save({ [id]: el.checked } as Partial<AppSettings>));
}

function bindText(id: keyof AppSettings & string): void {
  const el = $<HTMLInputElement>(id);
  // Commit on blur/Enter rather than every keystroke: each save rebuilds the
  // Jev client, and doing that per character is pointless churn.
  const commit = () => void save({ [id]: el.value.trim() } as Partial<AppSettings>);
  el.addEventListener("change", commit);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.blur();
  });
}

function bindRange(id: keyof AppSettings & string, out: HTMLOutputElement, fmt: (v: number) => string): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("input", () => {
    out.textContent = fmt(Number(el.value));
  });
  el.addEventListener("change", () =>
    void save({ [id]: Number(el.value) } as unknown as Partial<AppSettings>),
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

async function hydrate(): Promise<void> {
  hydrating = true;
  settings = await window.jev.settings.get();

  $<HTMLInputElement>("model").value = settings.model;
  $<HTMLInputElement>("baseUrl").value = settings.baseUrl;
  $<HTMLInputElement>("offlineFallback").checked = settings.offlineFallback;
  $<HTMLInputElement>("wakeWordEnabled").checked = settings.wakeWordEnabled;
  $<HTMLInputElement>("wakeWords").value = settings.wakeWords.join(", ");
  $<HTMLInputElement>("wakeThreshold").value = String(settings.wakeThreshold);
  $<HTMLInputElement>("hotkey").value = settings.hotkey;
  $<HTMLInputElement>("earcons").checked = settings.earcons;
  $<HTMLInputElement>("earconVolume").value = String(settings.earconVolume);
  $<HTMLInputElement>("confidenceThreshold").value = String(settings.confidenceThreshold);
  $<HTMLInputElement>("confirmDestructive").checked = settings.confirmDestructive;
  $<HTMLInputElement>("launchAtLogin").checked = settings.launchAtLogin;
  $<HTMLInputElement>("followUp").checked = settings.followUp;
  $<HTMLInputElement>("listenOnStart").checked = settings.listenOnStart;
  $<HTMLInputElement>("followUpSeconds").value = String(settings.followUpSeconds);
  $<HTMLInputElement>("realtime").checked = settings.realtime;
  $<HTMLInputElement>("instantCommands").checked = settings.instantCommands;
  $<HTMLInputElement>("learning").checked = settings.learning;
  $<HTMLInputElement>("learnModel").value = settings.learnModel;
  $<HTMLInputElement>("knowledgeBaseUrl").value = settings.knowledgeBaseUrl;

  $<HTMLOutputElement>("wakeThresholdOut").textContent = pct(settings.wakeThreshold);
  $<HTMLOutputElement>("earconVolumeOut").textContent = pct(settings.earconVolume);
  $<HTMLOutputElement>("confidenceOut").textContent = pct(settings.confidenceThreshold);
  $<HTMLOutputElement>("followUpSecondsOut").textContent = `${settings.followUpSeconds}s of quiet`;

  hydrating = false;
}

for (const id of ["offlineFallback", "wakeWordEnabled", "earcons", "confirmDestructive", "launchAtLogin", "followUp", "listenOnStart", "realtime", "instantCommands", "learning"] as const) {
  bindCheckbox(id);
}
for (const id of ["model", "baseUrl", "hotkey", "learnModel", "knowledgeBaseUrl"] as const) bindText(id);

bindRange("wakeThreshold", $<HTMLOutputElement>("wakeThresholdOut"), pct);
bindRange("earconVolume", $<HTMLOutputElement>("earconVolumeOut"), pct);
bindRange("confidenceThreshold", $<HTMLOutputElement>("confidenceOut"), pct);
bindRange("followUpSeconds", $<HTMLOutputElement>("followUpSecondsOut"), (v) => `${v}s of quiet`);

$<HTMLInputElement>("wakeWords").addEventListener("change", (e) => {
  const words = (e.target as HTMLInputElement).value
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  void save({ wakeWords: words });
});

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

async function refreshKeyHint(): Promise<void> {
  const info = await window.jev.apiKey.info();
  const hint = $("keyHint");
  if (!info.present) {
    hint.textContent = "Stored in the macOS Keychain. It never reaches this window again.";
    return;
  }
  hint.textContent = info.encrypted
    ? `Saved (…${info.tail}), encrypted in the macOS Keychain.`
    : `Saved (…${info.tail}). OS encryption was unavailable, so it is stored as plain text in your user data folder.`;
}

$("saveKey").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("apiKey");
  await window.jev.apiKey.set(input.value);
  input.value = "";
  await refreshKeyHint();
  await testKey();
});

const keyStatus = $("keyStatus");

async function testKey(): Promise<void> {
  keyStatus.className = "status";
  keyStatus.textContent = "Checking…";
  const r = await window.jev.apiKey.probe();
  keyStatus.className = `status ${r.ok ? "ok" : r.configured ? "bad" : "warn"}`;
  keyStatus.textContent = r.message;
}

$("testKey").addEventListener("click", () => void testKey());

// ---------------------------------------------------------------------------
// OpenRouter key, for learning
// ---------------------------------------------------------------------------

async function refreshOpenRouterHint(): Promise<void> {
  const info = await window.jev.openRouter.info();
  $("openRouterHint").textContent = !info.present
    ? "Stored in the macOS Keychain. It never reaches this window again."
    : info.encrypted
      ? `Saved (…${info.tail}), encrypted in the macOS Keychain.`
      : `Saved (…${info.tail}). OS encryption was unavailable, so it is stored as plain text in your user data folder.`;
}

async function testOpenRouterKey(): Promise<void> {
  const status = $("openRouterStatus");
  status.className = "status";
  status.textContent = "Checking…";
  const r = await window.jev.openRouter.probe();
  status.className = `status ${r.ok ? "ok" : "bad"}`;
  status.textContent = r.message;
}

$("saveOpenRouterKey").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("openRouterKey");
  await window.jev.openRouter.set(input.value);
  input.value = "";
  await refreshOpenRouterHint();
  await testOpenRouterKey();
});
$("testOpenRouterKey").addEventListener("click", () => void testOpenRouterKey());

// ---------------------------------------------------------------------------
// Speech models
// ---------------------------------------------------------------------------

let sttModels: SttModelInfo[] = [];

function modelRow(m: SttModelInfo, selected: string): HTMLElement {
  const el = document.createElement("label");
  el.className = `model${m.id === selected ? " active" : ""}`;
  el.dataset.model = m.id;

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "sttModel";
  radio.checked = m.id === selected;

  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = m.label;

  const meta = document.createElement("span");
  meta.className = "model-meta";
  meta.textContent = m.installed
    ? `${m.size} · ~${m.latencyMs} ms`
    : `${m.size} · not downloaded`;

  const note = document.createElement("span");
  note.className = "model-note";
  note.textContent = m.note;

  const bar = document.createElement("span");
  bar.className = "model-bar";
  bar.hidden = true;
  bar.append(document.createElement("i"));

  el.append(radio, name, meta, note, bar);

  radio.addEventListener("change", async () => {
    if (!m.installed) {
      // Download first, then switch — selecting a model that is not there yet
      // would just fail inside the engine.
      meta.textContent = "starting download…";
      bar.hidden = false;
      await window.jev.stt.download(m.id);
      return;
    }
    await save({ sttModel: m.id });
    await renderModels();
  });

  return el;
}

async function renderModels(): Promise<void> {
  sttModels = await window.jev.stt.models();
  const selected = (await window.jev.settings.get()).sttModel;
  $("sttModels").replaceChildren(...sttModels.map((m) => modelRow(m, selected)));
}

window.jev.stt.onProgress(async (p: ModelDownloadProgress) => {
  const pctDone = p.totalBytes ? (p.receivedBytes / p.totalBytes) * 100 : 0;
  // Shown in the sidebar too: on a fresh install this download starts on its
  // own, while the user is still on the Connection tab.
  downloading = p.done ? "" : `Downloading speech model ${Math.round(pctDone)}%`;
  paintState(agentState);

  const row = document.querySelector<HTMLElement>(`.model[data-model="${p.id}"]`);
  if (!row) return;
  const meta = row.querySelector(".model-meta") as HTMLElement;
  const bar = row.querySelector(".model-bar") as HTMLElement;
  const fill = row.querySelector(".model-bar > i") as HTMLElement;

  if (p.error) {
    meta.textContent = `download failed — ${p.error}`;
    bar.hidden = true;
    return;
  }
  if (p.done) {
    // Downloaded, so make it the active model — that is what the click meant.
    await save({ sttModel: p.id });
    await renderModels();
    return;
  }
  bar.hidden = false;
  fill.style.width = `${pctDone}%`;
  meta.textContent = `downloading ${Math.round(pctDone)}%`;
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Granted",
  denied: "Denied",
  "not-determined": "Not set",
  restricted: "Restricted",
  broken: "Broken",
  unsupported: "N/A",
};

async function renderPermissions(): Promise<void> {
  const list = await window.jev.permissions.list();
  const host = $("permList");
  host.replaceChildren(...list.map(permCard));
  await renderSigningNote();
}

function permCard(p: PermissionInfo): HTMLElement {
  const el = document.createElement("div");
  el.className = "perm";

  const head = document.createElement("div");
  head.className = "perm-head";
  const name = document.createElement("span");
  name.className = "perm-name";
  name.textContent = p.label;
  const badge = document.createElement("span");
  badge.className = `badge ${p.state}`;
  badge.textContent = STATE_LABEL[p.state];
  head.append(name, badge);
  if (!p.required) {
    const opt = document.createElement("span");
    opt.className = "badge optional";
    opt.textContent = "Optional";
    head.append(opt);
  }

  const why = document.createElement("p");
  why.className = "perm-why";
  why.textContent = p.why;

  const detail = document.createElement("p");
  detail.className = "perm-detail";

  const actions = document.createElement("div");
  actions.className = "perm-actions";

  if (p.state !== "granted") {
    const missing = document.createElement("p");
    missing.className = "perm-missing";
    missing.textContent = p.ifMissing;
    el.append(head, why, missing, detail, actions);
  } else {
    el.append(head, why, detail, actions);
  }

  if (p.canPrompt && p.state !== "granted") {
    const grant = document.createElement("button");
    grant.className = "btn primary";
    grant.textContent = "Grant…";
    grant.addEventListener("click", async () => {
      await window.jev.permissions.request(p.id);
      await renderPermissions();
    });
    actions.append(grant);
  }

  const test = document.createElement("button");
  test.className = "btn";
  test.textContent = "Check";
  test.addEventListener("click", async () => {
    test.disabled = true;
    detail.textContent = "Checking…";
    const r = await window.jev.permissions.test(p.id);
    detail.textContent = r.detail;
    badge.className = `badge ${r.state}`;
    badge.textContent = STATE_LABEL[r.state];
    test.disabled = false;
  });

  const open = document.createElement("button");
  open.className = "btn";
  open.textContent = "Open System Settings";
  open.addEventListener("click", () => void window.jev.permissions.open(p.id as PermissionId));

  actions.append(test, open);
  return el;
}

async function renderSigningNote(): Promise<void> {
  const d = await window.jev.agent.diagnostics();
  const note = $("signingNote");
  const packaged = Boolean(d.packaged);
  note.replaceChildren();

  const add = (html: string) => {
    const p = document.createElement("p");
    p.innerHTML = html;
    note.append(p);
  };

  add("<b>Why permissions sometimes reset</b>");
  add(
    "macOS binds each grant to the app's <i>code signature</i>, not its name or location. " +
      "An ad-hoc signature is pinned to the exact binary, so every rebuild looks like a brand new app and silently loses every grant.",
  );
  if (packaged) {
    add(
      `This build runs as <code>${String(d.bundleId)}</code>. Signed with a Developer ID, grants persist across updates.`,
    );
  } else {
    add(
      `This is a development build, so it runs inside Electron's own bundle (<code>${String(
        d.bundleId,
      )}</code>). That identity is stable between your rebuilds, so grants given here stick until Electron itself is upgraded.`,
    );
  }
  add(
    `<span style="opacity:.75">Electron ${String(d.electron)} · Node ${String(
      d.node,
    )} · macOS ${String(d.osRelease)}</span>`,
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function entryRow(e: CommandLogEntry): HTMLElement {
  const el = document.createElement("div");
  el.className = `entry ${e.outcome}`;
  const said = document.createElement("span");
  said.className = "said";
  said.textContent = `“${e.transcript}”`;
  const meta = document.createElement("span");
  meta.className = "meta";
  // The number that decides whether it feels instant: how long after the user
  // stopped talking the action was done. Negative means before they finished.
  const after = e.timings.afterSpeech;
  meta.textContent =
    after === undefined
      ? e.timings.total ? `${Math.round(e.timings.total)} ms` : ""
      : after < 0
        ? "before you finished"
        : `${Math.round(after)} ms after you stopped`;
  const did = document.createElement("span");
  did.className = "did";
  const conf = !e.instant && e.confidence !== null ? ` · ${Math.round(e.confidence * 100)}% confident` : "";
  did.textContent = `${e.action ?? "no match"}${conf}${e.detail ? ` — ${e.detail}` : ""}`;
  el.append(said, meta, did);

  const tags: [string, string][] = [];
  if (e.timings.afterSpeech !== undefined && e.timings.afterSpeech < 0) tags.push(["realtime", "before you finished"]);
  else if (e.early) tags.push(["realtime", "at the first pause"]);
  if (e.instant) tags.push(["instant", "instant — no network"]);
  if (e.offline) tags.push(["offline", "offline matcher"]);
  if (tags.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const [cls, label] of tags) {
      chips.append(Object.assign(document.createElement("span"), { className: `chip ${cls}`, textContent: label }));
    }
    el.append(chips);
  }
  return el;
}

/**
 * The headline number: typically how long after the user stops talking the
 * command is done. Only successful commands count — a refusal being fast is
 * not the point.
 */
function renderSpeed(log: CommandLogEntry[]): void {
  const host = $("speed");
  const done = log.filter((e) => e.outcome === "ok" && e.timings.afterSpeech !== undefined);
  if (done.length === 0) {
    host.hidden = true;
    return;
  }
  const times = done.map((e) => Math.max(0, e.timings.afterSpeech!)).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  const before = done.filter((e) => e.timings.afterSpeech! < 0).length;
  const early = done.filter((e) => e.early).length;
  const instant = done.filter((e) => e.instant).length;

  const num = Object.assign(document.createElement("div"), {
    className: "speed-num",
    textContent: median < 1000 ? `${Math.round(median)} ms` : `${(median / 1000).toFixed(1)} s`,
  });
  const label = Object.assign(document.createElement("div"), {
    className: "speed-label",
    textContent: `typical time from the end of your sentence to done, over the last ${done.length} command${done.length === 1 ? "" : "s"}`,
  });
  const chips = document.createElement("div");
  chips.className = "chips";
  const add = (cls: string, text: string) =>
    chips.append(Object.assign(document.createElement("span"), { className: `chip ${cls}`, textContent: text }));
  if (before) add("realtime", `${before} before you finished`);
  if (early) add("realtime", `${early} acted on at the pause`);
  if (instant) add("instant", `${instant} instant`);
  host.replaceChildren(num, label, chips);
  host.hidden = false;
}

async function renderLog(): Promise<void> {
  const log = await window.jev.agent.log();
  renderSpeed(log);
  const host = $("logList");
  if (log.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Nothing yet. Commands you speak will appear here.";
    host.replaceChildren(empty);
  } else {
    host.replaceChildren(...log.map(entryRow));
  }

  const d = await window.jev.agent.diagnostics();
  $("diagNote").replaceChildren(
    Object.assign(document.createElement("p"), {
      textContent: `Settings and logs live in ${String(d.userData)}`,
    }),
  );
}

window.jev.on.log(() => void renderLog());

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

let allActions: ActionSummary[] = [];

function commandCard(a: ActionSummary): HTMLElement {
  const el = document.createElement("div");
  el.className = "cmd";

  const head = document.createElement("div");
  head.className = "cmd-head";
  const key = document.createElement("span");
  key.className = "cmd-key";
  key.textContent = a.key;
  head.append(key);

  for (const slot of a.slots) {
    const t = document.createElement("span");
    t.className = "tag slot";
    t.textContent = slot;
    head.append(t);
  }
  if (a.destructive) {
    const t = document.createElement("span");
    t.className = "tag destructive";
    t.textContent = "asks first";
    head.append(t);
  }
  if (a.dynamic) {
    const t = document.createElement("span");
    t.className = "tag dynamic";
    t.textContent = "your shortcut";
    head.append(t);
  }
  if (a.learned) {
    const t = document.createElement("span");
    t.className = "tag learned";
    t.textContent = "learned";
    head.append(t);
    const forget = document.createElement("button");
    forget.className = "btn forget";
    forget.textContent = "Forget";
    forget.addEventListener("click", async () => {
      forget.disabled = true;
      await window.jev.actions.forget(a.learned!.id);
      allActions = await window.jev.actions.list();
      paintCommands($<HTMLInputElement>("commandFilter").value);
    });
    head.append(forget);
  }

  const desc = document.createElement("p");
  desc.className = "cmd-desc";
  desc.textContent = a.learned ? `${a.describe} ${a.learned.steps}.` : a.describe;

  const ex = document.createElement("p");
  ex.className = "cmd-ex";
  ex.textContent = a.examples.map((e) => `“${e}”`).join("   ");

  el.append(head, desc, ex);
  return el;
}

function paintCommands(filter: string): void {
  const f = filter.trim().toLowerCase();
  const shown = f
    ? allActions.filter(
        (a) =>
          a.key.toLowerCase().includes(f) ||
          a.describe.toLowerCase().includes(f) ||
          a.examples.some((e) => e.toLowerCase().includes(f)),
      )
    : allActions;
  $("commandList").replaceChildren(...shown.map(commandCard));
  const dynamic = allActions.filter((a) => a.dynamic).length;
  const learned = allActions.filter((a) => a.learned).length;
  $("commandCount").textContent =
    `${shown.length} of ${allActions.length} commands` +
    (learned ? ` · ${learned} learned` : "") +
    (dynamic ? ` · ${dynamic} from your own Shortcuts` : "");
}

async function renderCommands(): Promise<void> {
  if (allActions.length === 0) allActions = await window.jev.actions.list();
  paintCommands($<HTMLInputElement>("commandFilter").value);
}

$<HTMLInputElement>("commandFilter").addEventListener("input", (e) => {
  paintCommands((e.target as HTMLInputElement).value);
});

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------

const STATE_TEXT: Record<AgentState, string> = {
  disabled: "Listening off",
  idle: "Ready",
  conversing: "Listening for more…",
  listening: "Listening…",
  thinking: "Thinking…",
  executing: "Running…",
  confirming: "Waiting for confirmation",
  error: "Error",
};

/** The agent's last known state, and any model download under way. */
let agentState: AgentState = "disabled";
let downloading = "";

function paintState(state: AgentState): void {
  agentState = state;
  $("brandDot").className = `brand-dot ${state}`;
  $("brandState").textContent = downloading || STATE_TEXT[state];
  $<HTMLInputElement>("listeningToggle").checked = state !== "disabled";
}

$<HTMLInputElement>("listeningToggle").addEventListener("change", (e) => {
  void window.jev.agent.setListening((e.target as HTMLInputElement).checked);
});

window.jev.on.state(paintState);

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

async function renderAbout(): Promise<void> {
  const d = await window.jev.agent.diagnostics();
  $("aboutVersion").textContent = `Version ${String(d.version ?? "")} · Electron ${String(d.electron ?? "")}`;
}

// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const requested = location.hash.slice(1);
  if (requested) showTab(requested);
  await hydrate();
  await refreshKeyHint();
  await refreshOpenRouterHint();
  const { state } = await window.jev.agent.state();
  paintState(state);
  await renderPermissions();
  await renderModels();
  void testKey();
}

void boot();
