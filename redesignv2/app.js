const providers = [
  {
    id: "claude",
    name: "Claude",
    percent: 64,
    state: "live",
    message: "resets in 4h 18m",
    metaLeft: "Weekly left 63%",
    metaRight: "Reset Fri 08:00",
  },
  {
    id: "codex",
    name: "Codex",
    percent: 82,
    state: "cached",
    message: "resets in 2h 41m",
    metaLeft: "Credits 118 left",
    metaRight: "Reset 11:30 PM",
  },
  {
    id: "codex-2",
    name: "Codex 2",
    percent: 37,
    state: "paused",
    message: "cap cooldown",
    metaLeft: "Secondary window",
    metaRight: "Reset 01:15 AM",
  },
];

const states = ["live", "cached", "paused", "login", "error"];
const stateMessages = {
  live: "live",
  cached: "cached",
  paused: "paused",
  login: "login",
  error: "error",
};

const statusClassByState = {
  live: "ok",
  cached: "stale",
  paused: "paused",
  login: "warn",
  error: "warn",
};

let effectPreview = true;
const inspectTargets = [
  { selector: ".source-pill, .pill", label: "Status pill", tokens: ["--pill-live-bg", "--pill-live-border", "--pill-live-text", "--pill-cached-bg", "--pill-cached-border", "--pill-cached-text", "--pill-paused-bg", "--pill-paused-border", "--pill-paused-text", "--pill-error-bg", "--pill-error-border", "--pill-error-text"] },
  { selector: ".bar, .compact-bar, .cell", label: "Usage bar and effect", tokens: ["--bar-empty", "--bar-active", "--bar-current", "--bar-border", "--bar-glow", "--effect-sweep", "--effect-delta", "--effect-delta-border", "--effect-particle", "--effect-drop-cell", "--effect-drop-shadow", "--effect-partial-on", "--effect-partial-edge"] },
  { selector: ".percent, .compact-percent", label: "Percent number", tokens: ["--percent-text", "--fg", "--claude", "--codex", "--codex-2"] },
  { selector: ".message, .compact-message", label: "Reset/message text", tokens: ["--message-text", "--muted", "--warn", "--danger"] },
  { selector: ".usage-meta, .compact-meta, .meta-left, .meta-right", label: "Meta text", tokens: ["--meta-text", "--muted", "--updated-ago-text"] },
  { selector: ".updated-ago", label: "Updated ago text", tokens: ["--updated-ago-text", "--muted"] },
  { selector: ".mark, .provider-name", label: "Provider mark/name", tokens: ["--claude", "--codex", "--codex-2", "--header-text", "--bg"] },
  { selector: ".usage, .compact-usage, .mini-card", label: "Provider tile/card", tokens: ["--card-bg", "--card-bg-strong", "--border", "--claude", "--codex", "--codex-2", "--accent", "--shadow"] },
  { selector: "button, .window-control", label: "Button/control", tokens: ["--button-bg", "--button-hover-bg", "--button-border", "--button-text", "--primary-bg", "--primary-border", "--primary-text", "--danger", "--accent"] },
  { selector: "input, select, textarea", label: "Input/select", tokens: ["--input-bg", "--input-border", "--fg", "--muted", "--focus", "--accent"] },
  { selector: ".status-line", label: "Settings status line", tokens: ["--card-bg", "--border", "--muted", "--accent", "--fg"] },
  { selector: ".widget-header, .titlebar", label: "Header/titlebar", tokens: ["--surface", "--border", "--header-text", "--muted", "--button-bg", "--button-border", "--button-text", "--accent", "--danger"] },
  { selector: ".widget-shell, .compact-widget-shell, .control-shell", label: "Window shell", tokens: ["--bg", "--surface", "--surface-2", "--border", "--shadow", "--inset-highlight", "--panel-opacity", "--lab-bg"] },
  { selector: ".lab-topbar, .panel-head, .panel-tools, .color-group", label: "Color lab panel", tokens: ["--lab-bg", "--surface", "--surface-2", "--border", "--shadow", "--header-text", "--muted", "--button-bg"] },
];

let selectedInspectElement = null;

const tokenGroups = [
  {
    title: "Window",
    tokens: [
      ["--lab-bg", "Lab background"],
      ["--bg", "Widget bottom bg"],
      ["--surface", "Widget top bg"],
      ["--surface-2", "Surface secondary"],
      ["--border", "Main border"],
      ["--shadow", "Pixel shadow"],
      ["--inset-highlight", "Inset highlight"],
    ],
  },
  {
    title: "Text",
    tokens: [
      ["--fg", "Main text"],
      ["--muted", "Muted text"],
      ["--header-text", "Header text"],
      ["--percent-text", "Percent number"],
      ["--message-text", "Message text"],
      ["--meta-text", "Meta text"],
      ["--updated-ago-text", "Updated ago text"],
    ],
  },
  {
    title: "Surfaces",
    tokens: [
      ["--card-bg", "Tile background"],
      ["--card-bg-strong", "Tile hover bg"],
      ["--input-bg", "Input background"],
      ["--input-border", "Input border"],
      ["--focus", "Focus outline"],
    ],
  },
  {
    title: "Provider",
    tokens: [
      ["--claude", "Claude tone"],
      ["--codex", "Codex tone"],
      ["--codex-2", "Codex 2 tone"],
      ["--accent", "Accent"],
      ["--warn", "Warning"],
      ["--danger", "Danger"],
      ["--success", "Success"],
    ],
  },
  {
    title: "Status Pill",
    tokens: [
      ["--pill-live-bg", "Live bg"],
      ["--pill-live-border", "Live border"],
      ["--pill-live-text", "Live text"],
      ["--pill-cached-bg", "Cached bg"],
      ["--pill-cached-border", "Cached border"],
      ["--pill-cached-text", "Cached text"],
      ["--pill-paused-bg", "Paused bg"],
      ["--pill-paused-border", "Paused border"],
      ["--pill-paused-text", "Paused text"],
      ["--pill-error-bg", "Error bg"],
      ["--pill-error-border", "Error border"],
      ["--pill-error-text", "Error text"],
    ],
  },
  {
    title: "Usage Bar",
    tokens: [
      ["--bar-empty", "Empty cell"],
      ["--bar-active", "Active cell"],
      ["--bar-current", "Current cell"],
      ["--bar-border", "Cell border"],
      ["--bar-glow", "Glow"],
    ],
  },
  {
    title: "Usage Effect",
    tokens: [
      ["--effect-sweep", "Sweep overlay"],
      ["--effect-delta", "Delta highlight"],
      ["--effect-delta-border", "Delta border"],
      ["--effect-particle", "Particle color"],
      ["--effect-drop-cell", "Drop cell"],
      ["--effect-drop-shadow", "Drop shadow"],
      ["--effect-partial-on", "Partial on"],
      ["--effect-partial-edge", "Partial edge"],
    ],
  },
  {
    title: "Controls",
    tokens: [
      ["--button-bg", "Button bg"],
      ["--button-hover-bg", "Button hover bg"],
      ["--button-border", "Button border"],
      ["--button-text", "Button text"],
      ["--primary-bg", "Primary bg"],
      ["--primary-border", "Primary border"],
      ["--primary-text", "Primary text"],
    ],
  },
];

const presets = {
  "Current App": {
    "--lab-bg": "#0f0f10",
    "--bg": "#141414",
    "--surface": "#1d1d1d",
    "--surface-2": "#282726",
    "--card-bg": "rgba(255, 255, 255, 0.03)",
    "--card-bg-strong": "rgba(255, 255, 255, 0.055)",
    "--fg": "#ecebe8",
    "--muted": "#b9b6af",
    "--header-text": "#ecebe8",
    "--percent-text": "#ecebe8",
    "--message-text": "#b9b6af",
    "--meta-text": "#b9b6af",
    "--border": "#42403b",
    "--shadow": "rgba(0, 0, 0, 0.55)",
    "--inset-highlight": "rgba(255, 255, 255, 0.05)",
    "--claude": "#c46f42",
    "--codex": "#7b8cff",
    "--codex-2": "#7b8cff",
    "--accent": "#c46f42",
    "--warn": "#d7b76a",
    "--danger": "#db6b58",
    "--success": "#86efac",
    "--pill-live-bg": "rgba(134, 239, 172, 0.13)",
    "--pill-live-border": "rgba(134, 239, 172, 0.44)",
    "--pill-live-text": "#86efac",
    "--pill-cached-bg": "rgba(215, 183, 106, 0.13)",
    "--pill-cached-border": "rgba(215, 183, 106, 0.46)",
    "--pill-cached-text": "#d7b76a",
    "--pill-paused-bg": "rgba(185, 182, 175, 0.12)",
    "--pill-paused-border": "rgba(185, 182, 175, 0.38)",
    "--pill-paused-text": "#b9b6af",
    "--pill-error-bg": "rgba(219, 107, 88, 0.14)",
    "--pill-error-border": "rgba(219, 107, 88, 0.46)",
    "--pill-error-text": "#db6b58",
    "--updated-ago-text": "#8f8a82",
    "--bar-empty": "rgba(255, 255, 255, 0.075)",
    "--bar-active": "var(--tone)",
    "--bar-current": "#fff1d8",
    "--bar-border": "rgba(255, 255, 255, 0.07)",
    "--bar-glow": "rgba(196, 111, 66, 0.38)",
    "--effect-sweep": "rgba(255, 241, 216, 0.34)",
    "--effect-delta": "#fff1d8",
    "--effect-delta-border": "rgba(255, 241, 216, 0.78)",
    "--effect-particle": "rgba(255, 210, 138, 0.88)",
    "--effect-drop-cell": "#ffd28a",
    "--effect-drop-shadow": "rgba(255, 210, 138, 0.5)",
    "--effect-partial-on": "#fff1d8",
    "--effect-partial-edge": "#ffd28a",
    "--button-bg": "rgba(40, 39, 38, 0.58)",
    "--button-hover-bg": "rgba(255, 255, 255, 0.08)",
    "--button-border": "#42403b",
    "--button-text": "#ecebe8",
    "--primary-bg": "rgba(196, 111, 66, 0.14)",
    "--primary-border": "rgba(196, 111, 66, 0.44)",
    "--primary-text": "#c46f42",
    "--input-bg": "#282726",
    "--input-border": "#42403b",
    "--focus": "#c46f42",
  },
  "Amber Terminal": {
    "--lab-bg": "#120d08",
    "--bg": "#18100a",
    "--surface": "#24170e",
    "--surface-2": "#342315",
    "--card-bg": "rgba(255, 169, 77, 0.055)",
    "--card-bg-strong": "rgba(255, 169, 77, 0.095)",
    "--fg": "#fff0d2",
    "--muted": "#d6a968",
    "--header-text": "#fff5dc",
    "--percent-text": "#ffd38a",
    "--message-text": "#d6a968",
    "--meta-text": "#bd8b4b",
    "--border": "#6a4526",
    "--shadow": "rgba(0, 0, 0, 0.62)",
    "--inset-highlight": "rgba(255, 219, 160, 0.08)",
    "--claude": "#ff934f",
    "--codex": "#ffc857",
    "--codex-2": "#ffb14a",
    "--accent": "#ff934f",
    "--warn": "#ffd166",
    "--danger": "#ff6f59",
    "--success": "#a8ff9e",
  },
  "Blue Pixel": {
    "--lab-bg": "#080b17",
    "--bg": "#0c1022",
    "--surface": "#111933",
    "--surface-2": "#182447",
    "--card-bg": "rgba(105, 142, 255, 0.06)",
    "--card-bg-strong": "rgba(105, 142, 255, 0.105)",
    "--fg": "#e9f0ff",
    "--muted": "#9aaadc",
    "--header-text": "#f4f7ff",
    "--percent-text": "#b7c7ff",
    "--message-text": "#9aaadc",
    "--meta-text": "#8393c8",
    "--border": "#334472",
    "--shadow": "rgba(0, 0, 0, 0.65)",
    "--inset-highlight": "rgba(178, 197, 255, 0.08)",
    "--claude": "#73d2de",
    "--codex": "#7b8cff",
    "--codex-2": "#c084fc",
    "--accent": "#7b8cff",
    "--warn": "#ffd166",
    "--danger": "#ff6b8a",
    "--success": "#78f2b5",
  },
  "Green LCD": {
    "--lab-bg": "#06100b",
    "--bg": "#07140d",
    "--surface": "#0c1d13",
    "--surface-2": "#112a1a",
    "--card-bg": "rgba(122, 255, 154, 0.045)",
    "--card-bg-strong": "rgba(122, 255, 154, 0.09)",
    "--fg": "#d9ffe0",
    "--muted": "#8acb96",
    "--header-text": "#eaffed",
    "--percent-text": "#9dffac",
    "--message-text": "#8acb96",
    "--meta-text": "#75ad7f",
    "--border": "#285c35",
    "--shadow": "rgba(0, 0, 0, 0.7)",
    "--inset-highlight": "rgba(157, 255, 172, 0.07)",
    "--claude": "#b8ff79",
    "--codex": "#52ffa8",
    "--codex-2": "#78d9ff",
    "--accent": "#52ffa8",
    "--warn": "#e8ff80",
    "--danger": "#ff7777",
    "--success": "#9dffac",
  },
  "Light Paper": {
    "--lab-bg": "#e7ddcd",
    "--bg": "#f1ece3",
    "--surface": "#faf6ef",
    "--surface-2": "#ebe3d6",
    "--card-bg": "rgba(20, 16, 10, 0.035)",
    "--card-bg-strong": "rgba(20, 16, 10, 0.065)",
    "--fg": "#221e18",
    "--muted": "#5b5346",
    "--header-text": "#221e18",
    "--percent-text": "#201810",
    "--message-text": "#5b5346",
    "--meta-text": "#675a4a",
    "--border": "#cec4b2",
    "--shadow": "rgba(40, 28, 14, 0.18)",
    "--inset-highlight": "rgba(255, 255, 255, 0.55)",
    "--claude": "#bd6b40",
    "--codex": "#5264c8",
    "--codex-2": "#8358c7",
    "--accent": "#bd6b40",
    "--warn": "#9f7426",
    "--danger": "#b95043",
    "--success": "#267a49",
  },
  "High Contrast": {
    "--lab-bg": "#000000",
    "--bg": "#050505",
    "--surface": "#0b0b0b",
    "--surface-2": "#151515",
    "--card-bg": "rgba(255, 255, 255, 0.035)",
    "--card-bg-strong": "rgba(255, 255, 255, 0.09)",
    "--fg": "#ffffff",
    "--muted": "#bdbdbd",
    "--header-text": "#ffffff",
    "--percent-text": "#ffffff",
    "--message-text": "#c9c9c9",
    "--meta-text": "#bdbdbd",
    "--border": "#777777",
    "--shadow": "rgba(0, 0, 0, 0.85)",
    "--inset-highlight": "rgba(255, 255, 255, 0.12)",
    "--claude": "#ff8b3d",
    "--codex": "#5b8cff",
    "--codex-2": "#bd7cff",
    "--accent": "#ff8b3d",
    "--warn": "#ffe15b",
    "--danger": "#ff4d4d",
    "--success": "#50ff8a",
  },
};

const editableTokens = tokenGroups.flatMap((group) => group.tokens.map(([token]) => token));
let currentTokens = { ...presets["Current App"] };

function cssValue(token) {
  return currentTokens[token] ?? getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function applyTokens(tokens) {
  currentTokens = { ...currentTokens, ...tokens };
  for (const [token, value] of Object.entries(currentTokens)) {
    document.documentElement.style.setProperty(token, value);
  }
  localStorage.setItem("usageview.redesignv2.palette", JSON.stringify(currentTokens));
  syncControls();
  updateExport();
}

function toColorInput(value) {
  const trimmed = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  const match = trimmed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return "#000000";
  return "#" + [match[1], match[2], match[3]]
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("");
}

function renderProvider(provider, compact = false) {
  const template = document.getElementById(compact ? "compactTemplate" : "providerTemplate");
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(provider.id);
  node.dataset.provider = provider.id;

  const mark = node.querySelector(".mark");
  if (provider.id === "claude") {
    mark.classList.add("claude-mark");
  } else {
    mark.classList.add("codex-mark");
    mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3l7 4v10l-7 4-7-4V7z" /><path d="M12 3v6l5 3M19 7l-5 3v6M19 17l-7-4-7 4M5 7l7 4v10" /></svg>';
  }

  node.querySelector(".provider-name").textContent = provider.name;
  node.querySelector(compact ? ".compact-percent" : ".percent").textContent = provider.state === "login" ? "--" : `${provider.percent}%`;
  node.querySelector(compact ? ".compact-message" : ".message").textContent = provider.state === "error" ? "page unavailable" : provider.state === "login" ? "open settings to login" : provider.message;
  node.querySelector(".meta-left").textContent = provider.state === "login" ? "Login needed" : provider.metaLeft;
  node.querySelector(".meta-right").textContent = provider.state === "error" ? "Check API" : provider.metaRight;

  const pill = node.querySelector(".source-pill");
  pill.className = `source-pill ${statusClassByState[provider.state]}`;
  pill.textContent = stateMessages[provider.state];

  const bar = node.querySelector(compact ? ".compact-bar" : ".bar");
  buildCells(bar, provider.state === "login" ? undefined : provider.percent, compact ? 12 : 20);
  bar.classList.toggle("effect-on", effectPreview && provider.state !== "login");

  node.addEventListener("click", () => {
    const index = states.indexOf(provider.state);
    provider.state = states[(index + 1) % states.length];
    renderProviders();
  });

  return node;
}

function buildCells(container, percent, total) {
  container.textContent = "";
  const active = typeof percent === "number" ? Math.round((Math.max(0, Math.min(100, percent)) / 100) * total) : 0;
  for (let i = 0; i < total; i += 1) {
    const cell = document.createElement("span");
    cell.className = "cell";
    if (i < active) cell.classList.add("active");
    if (i === active - 1 && active > 0) cell.classList.add("current");
    if (i === active && active > 0 && active < total) cell.classList.add("fx-partial");
    container.appendChild(cell);
  }
}

function renderProviders() {
  const full = document.getElementById("fullProviders");
  const compact = document.getElementById("compactProviders");
  full.textContent = "";
  compact.textContent = "";
  providers.forEach((provider) => {
    full.appendChild(renderProvider(provider, false));
    compact.appendChild(renderProvider(provider, true));
  });
}

function renderPreviewControls() {
  const controls = document.getElementById("previewControls");
  controls.textContent = "";
  providers.forEach((provider) => {
    const row = document.createElement("div");
    row.className = "preview-control";
    row.innerHTML = `
      <strong>${provider.name}</strong>
      <output>${provider.percent}%</output>
      <input type="range" min="0" max="100" value="${provider.percent}" />
      <button type="button">Cycle state: ${stateMessages[provider.state]}</button>
    `;
    const output = row.querySelector("output");
    const slider = row.querySelector("input");
    const button = row.querySelector("button");
    slider.addEventListener("input", () => {
      provider.percent = Number(slider.value);
      output.textContent = `${provider.percent}%`;
      renderProviders();
    });
    button.addEventListener("click", () => {
      const index = states.indexOf(provider.state);
      provider.state = states[(index + 1) % states.length];
      button.textContent = `Cycle state: ${stateMessages[provider.state]}`;
      renderProviders();
    });
    controls.appendChild(row);
  });
}

function renderColorPanel() {
  const groups = document.getElementById("colorGroups");
  groups.textContent = "";

  tokenGroups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "color-group";
    section.innerHTML = `<h2>${group.title}</h2><div class="color-grid"></div>`;
    const grid = section.querySelector(".color-grid");

    group.tokens.forEach(([token, label]) => {
      const row = document.createElement("div");
      row.className = "color-row";
      row.dataset.token = token;
      row.innerHTML = `
        <label for="${token.slice(2)}">${label}</label>
        <input id="${token.slice(2)}" type="color" data-token="${token}" />
        <input type="text" data-token-text="${token}" spellcheck="false" />
      `;
      const colorInput = row.querySelector("input[type=color]");
      const textInput = row.querySelector("input[type=text]");

      colorInput.addEventListener("input", () => applyTokens({ [token]: colorInput.value }));
      textInput.addEventListener("change", () => {
        const value = textInput.value.trim();
        if (value) applyTokens({ [token]: value });
      });

      grid.appendChild(row);
    });

    groups.appendChild(section);
  });
}

function filterColorRows(tokens = null) {
  const tokenSet = tokens ? new Set(tokens) : null;
  document.querySelectorAll(".color-row").forEach((row) => {
    const token = row.dataset.token;
    const match = !tokenSet || tokenSet.has(token);
    row.classList.toggle("is-hidden", !match);
    row.classList.toggle("is-match", !!tokenSet && match);
  });
  document.querySelectorAll(".color-group").forEach((group) => {
    const hasVisible = !!group.querySelector(".color-row:not(.is-hidden)");
    group.classList.toggle("is-hidden", !hasVisible);
  });
}

function clearInspection() {
  selectedInspectElement?.classList.remove("inspect-selected");
  selectedInspectElement = null;
  const status = document.getElementById("inspectStatus");
  if (status) status.textContent = "Click any part of the preview to show only the related color controls.";
  filterColorRows(null);
}

function selectInspectTarget(config, element) {
  selectedInspectElement?.classList.remove("inspect-selected");
  selectedInspectElement = element;
  selectedInspectElement.classList.add("inspect-selected");
  const status = document.getElementById("inspectStatus");
  if (status) status.textContent = `${config.label}: showing ${config.tokens.length} related color controls.`;
  filterColorRows(config.tokens);
  const firstToken = config.tokens[0];
  const firstRow = document.querySelector(`.color-row[data-token="${firstToken}"]`);
  firstRow?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function setupInspector() {
  document.querySelector(".preview-pane")?.addEventListener("click", (event) => {
    if (event.target.closest(".view-tabs")) return;
    const match = inspectTargets.find((target) => event.target.closest(target.selector));
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    selectInspectTarget(match, event.target.closest(match.selector));
  }, true);
  document.getElementById("showAllColorsBtn")?.addEventListener("click", clearInspection);
}
function syncControls() {
  editableTokens.forEach((token) => {
    const value = cssValue(token);
    const color = document.querySelector(`input[data-token="${token}"]`);
    const text = document.querySelector(`input[data-token-text="${token}"]`);
    if (color) color.value = toColorInput(value);
    if (text) text.value = value;
  });
}

function updateExport() {
  const box = document.getElementById("exportBox");
  const lines = editableTokens.map((token) => `  ${token}: ${cssValue(token)};`);
  box.value = `:root {\n${lines.join("\n")}\n}`;
}

function renderPresets() {
  const select = document.getElementById("presetSelect");
  select.textContent = "";
  Object.keys(presets).forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
  select.addEventListener("change", () => applyTokens({ ...presets["Current App"], ...presets[select.value] }));
}

function setView(view) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  document.querySelectorAll("[data-preview]").forEach((preview) => {
    preview.classList.toggle("visible", view === "all" || preview.dataset.preview === view);
  });
  localStorage.setItem("usageview.redesignv2.view", view);
}

function randomVibe() {
  const hue = Math.floor(Math.random() * 360);
  const hue2 = (hue + 70 + Math.floor(Math.random() * 90)) % 360;
  const warm = (hue + 28) % 360;
  applyTokens({
    ...presets["Current App"],
    "--lab-bg": `hsl(${hue} 32% 5%)`,
    "--bg": `hsl(${hue} 30% 7%)`,
    "--surface": `hsl(${hue} 28% 11%)`,
    "--surface-2": `hsl(${hue} 25% 16%)`,
    "--card-bg": `hsla(${hue2}, 70%, 62%, 0.055)`,
    "--card-bg-strong": `hsla(${hue2}, 70%, 62%, 0.1)`,
    "--fg": `hsl(${hue} 28% 92%)`,
    "--muted": `hsl(${hue} 18% 66%)`,
    "--header-text": `hsl(${hue} 35% 96%)`,
    "--percent-text": `hsl(${hue2} 95% 82%)`,
    "--message-text": `hsl(${hue} 18% 66%)`,
    "--meta-text": `hsl(${hue} 15% 56%)`,
    "--border": `hsl(${hue2} 32% 34%)`,
    "--claude": `hsl(${warm} 88% 65%)`,
    "--codex": `hsl(${hue2} 92% 70%)`,
    "--codex-2": `hsl(${(hue2 + 55) % 360} 88% 72%)`,
    "--accent": `hsl(${warm} 88% 65%)`,
    "--focus": `hsl(${warm} 88% 65%)`,
    "--primary-text": `hsl(${warm} 88% 65%)`,
    "--bar-current": `hsl(${warm} 100% 88%)`,
  });
}

function init() {
  renderProviders();
  renderPreviewControls();
  renderPresets();
  renderColorPanel();
  setupInspector();

  const saved = localStorage.getItem("usageview.redesignv2.palette");
  applyTokens(saved ? JSON.parse(saved) : presets["Current App"]);
  document.getElementById("effectToggle").checked = effectPreview;

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  });
  setView(localStorage.getItem("usageview.redesignv2.view") || "full");

  document.getElementById("resetBtn").addEventListener("click", () => applyTokens(presets["Current App"]));
  document.getElementById("randomBtn").addEventListener("click", randomVibe);
  document.getElementById("darkModeBtn").addEventListener("click", () => applyTokens(presets["Current App"]));
  document.getElementById("lightModeBtn").addEventListener("click", () => applyTokens({ ...presets["Current App"], ...presets["Light Paper"] }));
  document.getElementById("effectToggle").addEventListener("change", (event) => {
    effectPreview = event.target.checked;
    renderProviders();
  });
  document.getElementById("copyBtn").addEventListener("click", async () => {
    updateExport();
    const value = document.getElementById("exportBox").value;
    try {
      await navigator.clipboard.writeText(value);
      document.getElementById("copyBtn").textContent = "Copied";
      setTimeout(() => { document.getElementById("copyBtn").textContent = "Copy CSS variables"; }, 900);
    } catch {
      document.getElementById("exportBox").select();
    }
  });
}

init();
