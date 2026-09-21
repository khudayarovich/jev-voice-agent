import type {
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

for (const btn of navs) {
  btn.addEventListener("click", () => {
    const name = btn.dataset.tab!;
    for (const n of navs) n.setAttribute("aria-current", String(n === btn));
    for (const t of tabs) t.hidden = t.dataset.tab !== name;
    if (name === "permissions") void renderPermissions();
    if (name === "activity") void renderLog();
  });
}

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

  $<HTMLOutputElement>("wakeThresholdOut").textContent = pct(settings.wakeThreshold);
  $<HTMLOutputElement>("earconVolumeOut").textContent = pct(settings.earconVolume);
  $<HTMLOutputElement>("confidenceOut").textContent = pct(settings.confidenceThreshold);

  hydrating = false;
}

for (const id of ["offlineFallback", "wakeWordEnabled", "earcons", "confirmDestructive", "launchAtLogin"] as const) {
  bindCheckbox(id);
}
for (const id of ["model", "baseUrl", "hotkey"] as const) bindText(id);

bindRange("wakeThreshold", $<HTMLOutputElement>("wakeThresholdOut"), pct);
bindRange("earconVolume", $<HTMLOutputElement>("earconVolumeOut"), pct);
bindRange("confidenceThreshold", $<HTMLOutputElement>("confidenceOut"), pct);

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
  meta.textContent = e.timings.total ? `${Math.round(e.timings.total)} ms` : "";
  const did = document.createElement("span");
  did.className = "did";
  const conf = e.confidence !== null ? ` · ${Math.round(e.confidence * 100)}% confident` : "";
  const off = e.offline ? " · offline" : "";
  did.textContent = `${e.action ?? "no match"}${conf}${off}${e.detail ? ` — ${e.detail}` : ""}`;
  el.append(said, meta, did);
  return el;
}

async function renderLog(): Promise<void> {
  const log = await window.jev.agent.log();
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
// Agent state
// ---------------------------------------------------------------------------

const STATE_TEXT: Record<AgentState, string> = {
  disabled: "Listening off",
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  executing: "Running…",
  confirming: "Waiting for confirmation",
  error: "Error",
};

function paintState(state: AgentState): void {
  $("brandDot").className = `brand-dot ${state}`;
  $("brandState").textContent = STATE_TEXT[state];
  $<HTMLInputElement>("listeningToggle").checked = state !== "disabled";
}

$<HTMLInputElement>("listeningToggle").addEventListener("change", (e) => {
  void window.jev.agent.setListening((e.target as HTMLInputElement).checked);
});

window.jev.on.state(paintState);

// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  await hydrate();
  await refreshKeyHint();
  const { state } = await window.jev.agent.state();
  paintState(state);
  await renderPermissions();
  void testKey();
}

void boot();
