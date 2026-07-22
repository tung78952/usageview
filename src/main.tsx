import React, { Component, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./styles.css";
import "./glass-theme.css";
import "./glass-effect.css";

// A Provider is now just an account id. Accounts are dynamic: added, renamed, and removed freely, so
// nothing here enumerates a fixed set. `kind` picks the login site + extraction; everything else keys
// off the id.
type Provider = string;
type AccountKind = "claude" | "codex";
type Account = { id: string; kind: AccountKind; label: string; url: string; shown: boolean };

const ACCOUNT_DEFAULT_URL: Record<AccountKind, string> = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
};

// Each window (widget / settings) keeps its own copy, refreshed from settings, so the display helpers
// (providerLabel/providerKind/...) can resolve an id without threading `accounts` through every call.
let accountRegistry: Record<string, Account> = {};
function syncAccountRegistry(accounts: Account[]) {
  accountRegistry = Object.fromEntries(accounts.map((account) => [account.id, account]));
}
function providerKind(id: Provider): AccountKind {
  return accountRegistry[id]?.kind ?? "codex";
}
function providerRemovingKey(id: Provider) {
  return `${PROVIDER_REMOVING_KEY_PREFIX}${id}`;
}
function providerRemovalPending(id: Provider) {
  const startedAt = Number(localStorage.getItem(providerRemovingKey(id)));
  return Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < 120_000;
}
function accountIdsFrom(settings: Settings): Provider[] {
  return settings.accounts.map((account) => account.id);
}
function makeAccountId(kind: AccountKind, existing: Account[]): string {
  const taken = new Set(existing.map((account) => account.id));
  let id = "";
  do {
    id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id) || !/^[a-z0-9-]+$/.test(id));
  return id;
}

type UsageStatus = "ok" | "not_open" | "not_logged_in" | "not_found" | "parser_failed" | "page_unavailable";

type UsageSnapshot = {
  provider: Provider;
  status: UsageStatus;
  message: string;
  usedLabel?: string;
  remainingLabel?: string;
  percentUsed?: number;
  resetLabel?: string;
  resetAtMs?: number;
  displayPeriod?: "weekly";
  weeklyResetAtMs?: number;
  weeklyLabel?: string;
  debugText?: string;
  updatedAt: string;
};

type ProviderLifecyclePhase = "stopped" | "starting" | "retrying" | "ready" | "login-needed" | "stopping" | "waiting-close" | "error";
/// Mirrors `release_provider_window_command` in lib.rs: `visible` means a login window is still up
/// and the release waits for its Hide/close; `superseded` means a newer toggle already owns this
/// provider and this command must stay silent; `absent` means there is nothing to destroy yet —
/// see PROVIDER_RELEASE_SWEEPS.
type ReleaseOutcome = "released" | "visible" | "superseded" | "absent";
type ProviderLifecycle = {
  provider: Provider;
  phase: ProviderLifecyclePhase;
  generation: number;
  attempt?: number;
  message?: string;
};
type MonitorToast = { id: number; text: string; tone: string };

// --- System monitors (RAM/CPU/GPU/temperatures) ---------------------------------
// A fully parallel model to UsageSnapshot: these are live local-hardware readings, not
// scraped provider usage. Nothing here touches the protected Provider/UsageSnapshot flow.
type MonitorKind = "cpu" | "ram" | "gpu" | "igpu" | "cputemp" | "gputemp";
type MonitorLevel = "low" | "medium" | "high";
type MonitorPalette = Record<MonitorLevel, string>;
type MonitorColors = Record<MonitorKind, MonitorPalette>;

// Shape returned by the Rust `read_system_metrics` command (snake_case matches serde).
type SystemMetrics = {
  ram_percent: number;
  ram_used_mb: number;
  ram_total_mb: number;
  ram_free_mb: number;
  swap_used_mb: number;
  swap_total_mb: number;
  cpu_percent: number;
  cpu_temp_c: number | null;
  cpu_temp_cores: number[];
  cpu_fan_rpm: number | null;
  cpu_name: string;
  cpu_physical_cores: number | null;
  cpu_logical_cores: number;
  cpu_freq_mhz: number;
  gpu_percent: number | null;
  gpu_temp_c: number | null;
  gpu_name: string | null;
  gpu_vram_used_mb: number | null;
  gpu_vram_total_mb: number | null;
  gpu_power_w: number | null;
  gpu_clock_mhz: number | null;
  gpu_fan_rpm: number | null;
  igpu_percent: number | null;
  igpu_name: string | null;
};

type MonitorDetail = { label: string; value: string };

type MonitorReading = {
  kind: MonitorKind;
  label: string;
  percent?: number; // 0-100 used for the bar fill; for temps this mirrors the °C value
  displayValue: string; // big readout, e.g. "42%", "58°C", or "N/A"
  unit: "%" | "°C";
  sub?: string; // always-visible meta line (component name or "12.3 / 31.9 GB")
  details?: MonitorDetail[]; // full stat rows shown on the flipped/hover face
  available: boolean;
  testing?: boolean;
  testNonce?: string;
};
type MonitorEffectTest = { kind: MonitorKind; value: number; nonce: string };
const MONITOR_TEST_DURATION_MS = 12_000;

type Settings = {
  claudeUrl: string;
  codexUrl: string;
  codex1Url: string;
  theme: "terminal" | "light" | "glass-light" | "glass-dark";
  opacity: number;
  uiScale: number;
  alwaysOnTop: boolean;
  refreshIntervalSec: number;
  aiUsageEnabled: boolean;
  effectsEnabled: boolean;
  effectDropCell: boolean;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  accounts: Account[];
  // Legacy single-account show flags (claudeUrl/codexUrl/codex1Url are above) — kept only so old
  // saved settings migrate into `accounts`. Not read once `accounts` exists.
  showClaude: boolean;
  showCodex: boolean;
  showCodex1: boolean;
  showCpu: boolean;
  showRam: boolean;
  showGpu: boolean;
  showIgpu: boolean;
  showCpuTemp: boolean;
  showGpuTemp: boolean;
  systemMonitorsEnabled: boolean;
  monitorIntervalSec: number;
  colorsEnabled: boolean;
  monitorColors: MonitorColors;
  providerColors: ProviderColors;
  providerColorsVersion: number;
  colorScope: ColorScope;
  baseOverrides: Partial<Record<ThemeKey, BaseOverride>>;
  // Developer mode gates the effect tester, API discovery and the custom-URL field. Default off.
  developerMode: boolean;
};

// Settings window tabs (sidebar). General is an overview: a read-only widget preview + the top-level
// switches. Content of every tab reuses the existing controls unchanged.
type SettingsTab = "general" | "accounts" | "appearance" | "monitors" | "about";
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "accounts", label: "AI Accounts" },
  { id: "monitors", label: "System monitor" },
  { id: "appearance", label: "Appearance" },
  { id: "about", label: "About" },
];

type ThemeKey = "terminal" | "light" | "glass-light" | "glass-dark";
const ACCOUNT_BRAND_COLORS: Record<AccountKind, Record<ThemeKey, string>> = {
  claude: { terminal: "#c46f42", light: "#b85f2e", "glass-light": "#c46f42", "glass-dark": "#c46f42" },
  codex: { terminal: "#7b8cff", light: "#3f66ad", "glass-light": "#4f78b8", "glass-dark": "#76a7e8" },
};
function accountBrandColor(kind: AccountKind, theme: ThemeKey) {
  return ACCOUNT_BRAND_COLORS[kind][theme];
}
type ProviderColors = Record<string, string | null>;
type ColorScope = { text: boolean; bar: boolean; border: boolean; bgTint: boolean };
type BaseOverride = { preset?: string; bg?: string; surface?: string; text?: string };

const DEFAULT_MONITOR_PALETTE: MonitorPalette = { low: "#4faa62", medium: "#e0913d", high: "#e5484d" };
const EFFECT_DURATION_MS = 4000;
const PIXEL_INSERT_SHIFT_MS = 300;
const PIXEL_INSERT_DROP_START_MS = 420;
const PIXEL_INSERT_DROP_DURATION_MS = 430;
const PIXEL_INSERT_DROP_STAGGER_MS = 45;
const PIXEL_INSERT_MS_PER_PERCENT = 26;
const PIXEL_INSERT_BEAM_FADE_MS = 150;
const PIXEL_INSERT_HOP_MIN_MS = 420;
const PIXEL_INSERT_HOP_MAX_MS = 480;
const PIXEL_INSERT_HOP_PEAK = 0.42;
const PIXEL_INSERT_HANDOFF_MS = 200;

function makeDefaultMonitorColors(): MonitorColors {
  return {
    cpu: { ...DEFAULT_MONITOR_PALETTE },
    ram: { ...DEFAULT_MONITOR_PALETTE },
    gpu: { ...DEFAULT_MONITOR_PALETTE },
    igpu: { ...DEFAULT_MONITOR_PALETTE },
    cputemp: { ...DEFAULT_MONITOR_PALETTE },
    gputemp: { ...DEFAULT_MONITOR_PALETTE },
  };
}

function normalizeMonitorColors(value: unknown): MonitorColors {
  const result = makeDefaultMonitorColors();
  if (!value || typeof value !== "object") return result;
  const saved = value as Record<string, unknown>;
  for (const kind of Object.keys(result) as MonitorKind[]) {
    const entry = saved[kind];
    if (typeof entry === "string") {
      // Preserve the old single-color override by applying it to all levels.
      result[kind] = { low: entry, medium: entry, high: entry };
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const palette = entry as Record<string, unknown>;
    for (const level of ["low", "medium", "high"] as MonitorLevel[]) {
      if (typeof palette[level] === "string") result[kind][level] = palette[level] as string;
    }
  }
  return result;
}

type AppMode = "widget" | "mini";

type WindowGeometry = {
  width: number;
  height: number;
  x: number;
  y: number;
};

type WindowPosition = Pick<WindowGeometry, "x" | "y">;

// All window geometry (WindowGeometry) and screen rects below are in PHYSICAL pixels: they live in the
// OS virtual-desktop coordinate space (what outerPosition()/availableMonitors() return). Physical is the
// only unambiguous space across multiple monitors with different DPI/scale — mixing logical spaces per
// monitor is what previously made a saved position on a scaled 2nd monitor look "off-screen" and reset.
type ScreenRect = WindowGeometry & { scale: number };

const defaultSettings: Settings = {
  claudeUrl: "https://claude.ai/settings/usage",
  codexUrl: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  codex1Url: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  theme: "terminal",
  opacity: 0.96,
  uiScale: 1,
  alwaysOnTop: true,
  refreshIntervalSec: 60,
  aiUsageEnabled: true,
  effectsEnabled: true,
  effectDropCell: true,
  corner: "top-right",
  accounts: [],
  showClaude: true,
  showCodex: true,
  showCodex1: false,
  showCpu: false,
  showRam: false,
  showGpu: false,
  showIgpu: false,
  showCpuTemp: false,
  showGpuTemp: false,
  systemMonitorsEnabled: false,
  monitorIntervalSec: 2,
  colorsEnabled: true,
  monitorColors: makeDefaultMonitorColors(),
  providerColors: {},
  providerColorsVersion: 2,
  colorScope: { text: true, bar: true, border: true, bgTint: false },
  baseOverrides: {},
  developerMode: false,
};

// Built-in default base tokens per theme (mirror the CSS defaults) — used as the starting point when the
// user fine-tunes base colors without picking a preset.
const DEFAULT_BASE: Record<ThemeKey, { bg: string; surface: string; surface2: string; fg: string; muted: string; border: string }> = {
  terminal: { bg: "#15171c", surface: "#1c1f26", surface2: "#262a33", fg: "#e9ebef", muted: "#a7aeba", border: "#363b45" },
  light: { bg: "#eef0f3", surface: "#f8f9fb", surface2: "#e4e7ec", fg: "#1b1f27", muted: "#59616e", border: "#d3d8e0" },
  "glass-light": { bg: "#e9ebf0", surface: "#f6f7fa", surface2: "#dfe3ea", fg: "#20242c", muted: "#58606d", border: "#d1d6de" },
  "glass-dark": { bg: "#191a1a", surface: "#232424", surface2: "#2d2e2e", fg: "#ecebe8", muted: "#b9b6af", border: "#42403b" },
};

// Curated base palettes offered in the Colors panel (per light/dark). First of each = the shipped default.
const BASE_PRESETS: Record<"light" | "dark", { id: string; name: string; bg: string; surface: string; surface2: string; fg: string; muted: string; border: string }[]> = {
  light: [
    { id: "clean-gray", name: "Clean Gray", bg: "#eef0f3", surface: "#f8f9fb", surface2: "#e4e7ec", fg: "#1b1f27", muted: "#59616e", border: "#d3d8e0" },
    { id: "warm-ivory", name: "Warm Ivory", bg: "#efe3c6", surface: "#f7edda", surface2: "#e7d7b8", fg: "#241d14", muted: "#4c4231", border: "#cec4b2" },
    { id: "sage", name: "Sage", bg: "#e8ede4", surface: "#f4f7f1", surface2: "#dbe3d5", fg: "#1e241b", muted: "#54604c", border: "#cdd8c6" },
    { id: "slate", name: "Slate", bg: "#e7ebf0", surface: "#f3f6fa", surface2: "#dae1ea", fg: "#1a2130", muted: "#556074", border: "#ccd4e0" },
  ],
  dark: [
    { id: "cool-charcoal", name: "Cool Charcoal", bg: "#15171c", surface: "#1c1f26", surface2: "#262a33", fg: "#e9ebef", muted: "#a7aeba", border: "#363b45" },
    { id: "neutral-black", name: "Neutral Black", bg: "#141414", surface: "#1d1d1d", surface2: "#282726", fg: "#ecebe8", muted: "#b9b6af", border: "#42403b" },
    { id: "navy", name: "Navy", bg: "#111725", surface: "#182034", surface2: "#212c45", fg: "#e6ebf5", muted: "#9aa6bd", border: "#2c3a57" },
    { id: "plum", name: "Plum", bg: "#1a1420", surface: "#221a2b", surface2: "#2e2338", fg: "#efe9f2", muted: "#b0a3bb", border: "#3d3049" },
  ],
};

// Curated accent swatches for the provider color rows (custom picker covers anything else).
const ACCENT_PRESETS = ["#c46f42", "#e0913d", "#d8552f", "#d6486a", "#4faa62", "#2fa8a0", "#3aa3d4", "#5b8def", "#7b8cff", "#9b6be0", "#8a8f9c"];
const MONITOR_ACCENT_PRESETS = Array.from(new Set([
  DEFAULT_MONITOR_PALETTE.low,
  DEFAULT_MONITOR_PALETTE.medium,
  DEFAULT_MONITOR_PALETTE.high,
  ...ACCENT_PRESETS,
]));

function baseModeOf(theme: ThemeKey): "light" | "dark" {
  return theme === "light" || theme === "glass-light" ? "light" : "dark";
}

const GEOMETRY_KEY = "usageview.windowPosition.v8";
const LEGACY_GEOMETRY_KEY = "usageview.windowGeometry.v7";
const WIDGET_BASE_WIDTH = 392;
const MINI_LOCK_WIDTH = 240;
const MINI_MIN_HEIGHT_FALLBACK = 48;
const MODE_KEY = "usageview.mode";
const TILE_LAYOUT_KEY = "usageview.tileLayout.v1";
const TILE_LAYOUT_EVENT = "usageview:tile-layout";
const PROVIDER_LIFECYCLE_EVENT = "usageview-provider-lifecycle";
const PROVIDER_LIFECYCLE_REQUEST_EVENT = "usageview-provider-lifecycle-request";
const PROVIDER_RELEASED_EVENT = "usageview-provider-released";
const PROVIDER_REMOVED_EVENT = "usageview-provider-removed";
const WIDGET_VISIBILITY_EVENT = "usageview-widget-visibility";
const TIMER_TOGGLE_EVENT = "usageview-timer-toggle";
const PROVIDER_REMOVING_KEY_PREFIX = "usageview.provider-removing.";
const PROVIDER_RETRY_EVENT = "usageview-provider-retry";
const PROVIDER_START_ATTEMPTS = 3;
// Tauri builds the predeclared provider windows after the widget's JS is already running, so an OFF
// evaluated at startup can find no window to release and then watch Tauri raise one behind it. Keep
// sweeping for a few seconds so a provider that is switched off stays off.
const PROVIDER_RELEASE_SWEEPS = 6;
const PROVIDER_RELEASE_SWEEP_MS = 700;
// Provider tiles are dynamic (`provider:<accountId>`); monitor tiles are the fixed hardware set.
const MONITOR_TILE_IDS = [
  "monitor:cpu", "monitor:ram", "monitor:gpu", "monitor:igpu", "monitor:cputemp", "monitor:gputemp",
] as const;
type MonitorTileId = typeof MONITOR_TILE_IDS[number];
type TileId = `provider:${string}` | MonitorTileId;
function providerTileId(id: Provider): TileId {
  return `provider:${id}`;
}
function allTileIds(settings: Settings): TileId[] {
  return [...settings.accounts.map((account) => providerTileId(account.id)), ...MONITOR_TILE_IDS];
}
// Must match the size and scale clamp `open_detached_tile` builds the window with in lib.rs.
const DETACHED_TILE_WIDTH = 392;
const DETACHED_TILE_HEIGHT = 220;
const clampTileScale = (scale: number) => Math.min(1.5, Math.max(0.5, scale));
type TileLayout = { version: 1; order: TileId[]; detached: Partial<Record<TileId, WindowPosition>> };
type DetachedTileEvent = { tileId: TileId; x: number; y: number; screenY: number };
type TimerOrigin = "auto" | "manual";
type DetachedRuntimeState = {
  snapshot?: UsageSnapshot;
  monitorReading?: MonitorReading;
  activeEffect?: UsageEffect;
  timerOrigin?: TimerOrigin;
  flash: boolean;
  paused: boolean;
  freshAt?: string;
};
let windowGeometryCache: Partial<Record<AppMode, WindowPosition>> | undefined;
let windowGeometryResetGeneration = 0;

function isTileId(value: unknown): value is TileId {
  if (typeof value !== "string") return false;
  if ((MONITOR_TILE_IDS as readonly string[]).includes(value)) return true;
  return value.startsWith("provider:") && /^[a-z0-9-]+$/.test(value.slice("provider:".length));
}

function normalizeTileLayout(value: unknown): TileLayout {
  const parsed = value && typeof value === "object" ? value as Partial<TileLayout> : {};
  const savedOrder = Array.isArray(parsed.order) ? parsed.order.filter(isTileId) : [];
  // Provider tiles are dynamic, so we cannot enumerate them here (no settings) — keep whatever the
  // saved order had and ensure the monitor tiles are always present. A newly added account's tile is
  // appended by the widget when it renders.
  const order = [...new Set([...savedOrder, ...MONITOR_TILE_IDS])] as TileId[];
  const detached: Partial<Record<TileId, WindowPosition>> = {};
  if (parsed.detached && typeof parsed.detached === "object") {
    for (const [id, position] of Object.entries(parsed.detached)) {
      if (!isTileId(id) || !position || typeof position !== "object") continue;
      const candidate = position as Partial<WindowPosition>;
      if (Number.isFinite(candidate.x) && Number.isFinite(candidate.y)) {
        detached[id] = { x: Math.round(candidate.x!), y: Math.round(candidate.y!) };
      }
    }
  }
  return { version: 1, order, detached };
}

function loadTileLayout(): TileLayout {
  try {
    const saved = localStorage.getItem(TILE_LAYOUT_KEY);
    return normalizeTileLayout(saved ? JSON.parse(saved) : undefined);
  } catch {
    return normalizeTileLayout(undefined);
  }
}

function saveTileLayout(layout: TileLayout) {
  localStorage.setItem(TILE_LAYOUT_KEY, JSON.stringify(normalizeTileLayout(layout)));
  window.dispatchEvent(new Event(TILE_LAYOUT_EVENT));
}

function tileWindowLabel(tileId: TileId) {
  return `tile_${tileId.replace(':', '_').replace(/-/g, '_')}`;
}

function tileIdForWindowLabel(label: string): TileId | null {
  // Reverse of tileWindowLabel: `tile_<kind>_<rest>` → `<kind>:<rest with _→->`. The first underscore
  // after `tile_` was the `:` separator; the rest were `-`. Ids/kinds never contain a literal `_`.
  if (!label.startsWith("tile_")) return null;
  const body = label.slice("tile_".length);
  const sep = body.indexOf("_");
  if (sep < 0) return null;
  const candidate = `${body.slice(0, sep)}:${body.slice(sep + 1).replace(/_/g, "-")}`;
  return isTileId(candidate) ? (candidate as TileId) : null;
}

function providerFromTile(tileId: TileId): Provider | null {
  return tileId.startsWith("provider:") ? tileId.slice("provider:".length) as Provider : null;
}

function monitorFromTile(tileId: TileId): MonitorKind | null {
  return tileId.startsWith("monitor:") ? tileId.slice("monitor:".length) as MonitorKind : null;
}

function tileDisplayLabel(tileId: TileId): string | undefined {
  const provider = providerFromTile(tileId);
  if (provider) return providerLabel(provider);
  const monitor = monitorFromTile(tileId);
  return monitor ? MONITOR_FULL_LABELS[monitor] : undefined;
}


function loadMode(): AppMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "mini" || saved === "widget") return saved;
    // Compact mode was removed — any user saved in it opens in the full widget.
    if (saved === "compact") return "widget";
  } catch {
    // ignore
  }
  return "widget";
}

function saveMode(mode: AppMode) {
  if (mode === "widget" || mode === "mini") localStorage.setItem(MODE_KEY, mode);
}

type UsageEffect = {
  id: number;
  from: number;
  to: number;
};

function pixelInsertDynamics(effect: Pick<UsageEffect, "from" | "to">) {
  const delta = Math.max(0, Math.min(100, effect.to) - Math.max(0, effect.from));
  const strength = Math.sqrt(delta / 100);
  const hopMs = PIXEL_INSERT_HOP_MIN_MS + (PIXEL_INSERT_HOP_MAX_MS - PIXEL_INSERT_HOP_MIN_MS) * strength;
  return { delta, strength, hopMs };
}

function pixelInsertStart(from: number) {
  const clamped = Math.max(0, Math.min(100, from));
  const midpoint = clamped / 2;
  const lower = Math.floor(midpoint / 10) * 10;
  const upper = Math.min(clamped, Math.ceil(midpoint / 10) * 10);
  return midpoint - lower <= upper - midpoint ? lower : upper;
}

function pixelInsertTiming(effect: Pick<UsageEffect, "from" | "to">) {
  const { delta, hopMs } = pixelInsertDynamics(effect);
  const from = Math.max(0, Math.min(100, effect.from));
  const to = Math.max(0, Math.min(100, effect.to));
  const impactCenter = pixelInsertStart(from) + delta / 2;
  const waveMs = Math.max(impactCenter, to - impactCenter) * PIXEL_INSERT_MS_PER_PERCENT;
  const pieceCount = Math.max(1, Math.ceil(delta / 10));
  const impactMs = PIXEL_INSERT_DROP_START_MS + PIXEL_INSERT_DROP_DURATION_MS + (pieceCount - 1) * PIXEL_INSERT_DROP_STAGGER_MS;
  const handoffMs = impactMs + waveMs + hopMs;
  return { pieceCount, impactMs, waveMs, handoffMs, durationMs: handoffMs + PIXEL_INSERT_HANDOFF_MS };
}

const emptySnapshot = (provider: Provider): UsageSnapshot => ({
  provider,
  status: "not_open",
  message: "Open settings to login",
  updatedAt: new Date().toISOString(),
});

function normalizeAccountLabel(kind: AccountKind, label: string) {
  return (label.trim() || (kind === "claude" ? "Claude" : "Codex")).toLocaleUpperCase();
}

function normalizeAccount(value: unknown): Account | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  const id = typeof a.id === "string" ? a.id : "";
  const kind = a.kind === "claude" || a.kind === "codex" ? a.kind : null;
  if (!/^[a-z0-9-]+$/.test(id) || !kind) return null;
  return {
    id,
    kind,
    label: normalizeAccountLabel(kind, typeof a.label === "string" ? a.label : ""),
    url: typeof a.url === "string" && a.url ? a.url : ACCOUNT_DEFAULT_URL[kind],
    shown: a.shown === true,
  };
}

// Existing installs carry the three original accounts in legacy show/url fields; migrate them once,
// preserving their ids so saved snapshots, tile layout and colours keep matching. A brand-new install
// (no prior settings) starts with zero accounts.
function resolveAccounts(parsed: Record<string, unknown>, hadSaved: boolean, loaded: Settings): Account[] {
  if (Array.isArray(parsed.accounts)) {
    return parsed.accounts.map(normalizeAccount).filter((a): a is Account => a !== null);
  }
  if (!hadSaved) return [];
  return [
    { id: "claude", kind: "claude", label: normalizeAccountLabel("claude", "Claude"), url: loaded.claudeUrl, shown: loaded.showClaude ?? true },
    { id: "codex", kind: "codex", label: normalizeAccountLabel("codex", "Codex 1"), url: loaded.codexUrl, shown: loaded.showCodex ?? true },
    { id: "codex-1", kind: "codex", label: normalizeAccountLabel("codex", "Codex 2"), url: loaded.codex1Url, shown: loaded.showCodex1 ?? false },
  ];
}

function normalizeProviderColors(value: unknown, accounts: Account[], version: number): ProviderColors {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: ProviderColors = {};
  for (const account of accounts) {
    const direct = saved[account.id];
    const legacyKind = version < 2 ? saved[account.kind] : undefined;
    const color = typeof direct === "string" ? direct : typeof legacyKind === "string" ? legacyKind : undefined;
    if (color) result[account.id] = color;
  }
  return result;
}

function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem("usageview.settings");
    const parsedValue = saved ? JSON.parse(saved) : {};
    const parsed = (parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue) ? { ...parsedValue } : {}) as Record<string, unknown>;
    const legacyEffectKeys = ["effectDurationMs", "effectBarBrightness", "effectDeltaBrightness"];
    const hadLegacyEffectTuning = legacyEffectKeys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
    for (const key of legacyEffectKeys) delete parsed[key];
    const loaded = { ...defaultSettings, ...parsed };
    const savedColorScope = (parsed.colorScope ?? {}) as Partial<ColorScope>;
    const hadShownMonitor = [loaded.showCpu, loaded.showRam, loaded.showGpu, loaded.showIgpu, loaded.showCpuTemp, loaded.showGpuTemp].some(Boolean);
    const accounts = resolveAccounts(parsed, saved !== null, loaded);
    const providerColorsVersion = Number(parsed.providerColorsVersion) >= 2 ? 2 : 1;
    const providerColors = normalizeProviderColors(parsed.providerColors, accounts, providerColorsVersion);
    if (saved !== null && (hadLegacyEffectTuning || providerColorsVersion < 2)) {
      parsed.providerColors = providerColors;
      parsed.providerColorsVersion = 2;
      localStorage.setItem("usageview.settings", JSON.stringify(parsed));
    }
    syncAccountRegistry(accounts);
    return {
      ...loaded,
      accounts,
      uiScale: clampNumber(loaded.uiScale, 0.25, 2, 1),
      theme: normalizeTheme(loaded.theme),
      aiUsageEnabled: typeof parsed.aiUsageEnabled === "boolean" ? parsed.aiUsageEnabled : accounts.some((a) => a.shown),
      effectsEnabled: loaded.effectsEnabled ?? true,
      effectDropCell: loaded.effectDropCell ?? true,
      showClaude: loaded.showClaude ?? true,
      showCodex: loaded.showCodex ?? true,
      showCodex1: loaded.showCodex1 ?? false,
      showCpu: loaded.showCpu ?? false,
      showRam: loaded.showRam ?? false,
      showGpu: loaded.showGpu ?? false,
      showIgpu: loaded.showIgpu ?? false,
      showCpuTemp: loaded.showCpuTemp ?? false,
      showGpuTemp: loaded.showGpuTemp ?? false,
      systemMonitorsEnabled: typeof parsed.systemMonitorsEnabled === "boolean" ? parsed.systemMonitorsEnabled : hadShownMonitor,
      monitorIntervalSec: clampNumber(loaded.monitorIntervalSec, 1, 10, 2),
      colorsEnabled: true,
      monitorColors: normalizeMonitorColors(loaded.monitorColors),
      providerColors,
      providerColorsVersion: 2,
      colorScope: { text: true, bar: true, border: true, bgTint: false, ...savedColorScope },
      baseOverrides: loaded.baseOverrides ?? {},
    };
  } catch {
    return { ...defaultSettings };
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function saveSettings(settings: Settings) {
  localStorage.setItem("usageview.settings", JSON.stringify(settings));
  window.dispatchEvent(new Event("usageview:settings"));
}

// Legacy/unknown theme values normalize to a supported one. `glass` was an old experimental value.
function normalizeTheme(value: unknown): Settings["theme"] {
  switch (value) {
    case "light":
    case "glass-light":
    case "glass-dark":
      return value;
    case "glass":
      return "glass-light";
    default:
      return "terminal";
  }
}

function themeClass(theme: Settings["theme"]) {
  switch (theme) {
    case "light":
      return "theme-light";
    case "glass-light":
      return "theme-glass theme-glass-light";
    case "glass-dark":
      return "theme-glass theme-glass-dark";
    default:
      return "theme-terminal";
  }
}

// Theme is the single source of truth; the Settings UI presents it as two segmented controls (Style + Mode).
type ThemeStyle = "pixel" | "glass";
type ThemeMode = "light" | "dark";
function themeStyle(theme: Settings["theme"]): ThemeStyle {
  return theme === "glass-light" || theme === "glass-dark" ? "glass" : "pixel";
}
function themeMode(theme: Settings["theme"]): ThemeMode {
  return theme === "light" || theme === "glass-light" ? "light" : "dark";
}
function composeTheme(style: ThemeStyle, mode: ThemeMode): Settings["theme"] {
  if (style === "glass") return mode === "light" ? "glass-light" : "glass-dark";
  return mode === "light" ? "light" : "terminal";
}

// Resolve a theme's base tokens from an override (preset then fine-tune); null = use CSS defaults.
function resolveBaseTokens(theme: ThemeKey, base: BaseOverride | undefined) {
  if (!base || (!base.preset && !base.bg && !base.surface && !base.text)) return null;
  const preset = base.preset ? BASE_PRESETS[baseModeOf(theme)].find((p) => p.id === base.preset) : undefined;
  const start = preset ?? DEFAULT_BASE[theme];
  return {
    bg: base.bg ?? start.bg,
    surface: base.surface ?? start.surface,
    surface2: start.surface2,
    fg: base.text ?? start.fg,
    muted: start.muted,
    border: start.border,
  };
}

function panelStyle(settings: Settings): React.CSSProperties {
  const style: Record<string, string | number> = {
    "--panel-opacity-pct": `${Math.round(settings.opacity * 100)}%`,
    "--effect-duration": `${EFFECT_DURATION_MS}ms`,
  };
  if (settings.colorsEnabled) {
    const base = resolveBaseTokens(settings.theme, settings.baseOverrides[settings.theme]);
    if (base) {
      const glass = settings.theme === "glass-light" || settings.theme === "glass-dark";
      const map = glass
        ? { "--paper-bg": base.bg, "--paper-panel": base.surface, "--paper-panel-2": base.surface2, "--paper-ink": base.fg, "--paper-soft": base.muted, "--paper-faint": base.muted, "--paper-line": base.border }
        : { "--bg": base.bg, "--surface": base.surface, "--surface-2": base.surface2, "--fg": base.fg, "--muted": base.muted, "--border": base.border };
      Object.assign(style, map);
    }
  }
  return style as React.CSSProperties;
}

function providerAccent(provider: Provider, settings: Settings): string | undefined {
  if (!settings.colorsEnabled) return undefined;
  return settings.providerColors[provider] ?? accountBrandColor(providerKind(provider), settings.theme);
}

function providerAccentStyle(accent?: string): React.CSSProperties | undefined {
  return accent ? ({ "--provider-accent": accent } as React.CSSProperties) : undefined;
}

// Scope classes toggle where a provider's accent lands (text/bar/border/bg). Default-on scopes keep the
// current look; the CSS only overrides the OFF states + adds the bg tint.
function panelScopeClasses(settings: Settings): string {
  if (!settings.colorsEnabled) return "scope-text scope-bar scope-border";
  const s = settings.colorScope;
  return [s.text && "scope-text", s.bar && "scope-bar", s.border && "scope-border", s.bgTint && "scope-bgtint"]
    .filter(Boolean)
    .join(" ");
}

function parseWindowPositions(saved: string | null): Partial<Record<AppMode, WindowPosition>> {
  if (!saved) return {};
  try {
    const parsed = JSON.parse(saved) as Record<string, Partial<WindowPosition>>;
    const positions: Partial<Record<AppMode, WindowPosition>> = {};
    for (const mode of ["widget", "mini"] as AppMode[]) {
      const position = parsed[mode];
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
        positions[mode] = { x: Math.round(position!.x!), y: Math.round(position!.y!) };
      }
    }
    return positions;
  } catch {
    return {};
  }
}

function loadWindowGeometry(): Partial<Record<AppMode, WindowPosition>> {
  const current = parseWindowPositions(localStorage.getItem(GEOMETRY_KEY));
  const legacy = parseWindowPositions(localStorage.getItem(LEGACY_GEOMETRY_KEY));
  return { ...legacy, ...current };
}

async function loadWindowGeometryAsync(): Promise<Partial<Record<AppMode, WindowPosition>>> {
  if (windowGeometryCache) return windowGeometryCache;
  const localGeometry = loadWindowGeometry();
  try {
    const stored = await invoke<Partial<Record<AppMode, WindowPosition>>>("load_window_geometry");
    windowGeometryCache = { ...localGeometry, ...stored };
  } catch {
    windowGeometryCache = localGeometry;
  }
  return windowGeometryCache;
}

function saveWindowGeometry(mode: AppMode, position: WindowPosition) {
  const current = windowGeometryCache ?? loadWindowGeometry();
  windowGeometryCache = { ...current, [mode]: position };
  localStorage.setItem(GEOMETRY_KEY, JSON.stringify(windowGeometryCache));
  localStorage.removeItem(LEGACY_GEOMETRY_KEY);
  void invoke("save_window_geometry", { mode, position }).catch(() => undefined);
}

function defaultWindowSize(mode: AppMode) {
  if (mode === "mini") return { width: MINI_LOCK_WIDTH, height: 124 };
  return { width: WIDGET_BASE_WIDTH, height: 500 };
}

// Fallback corner position in PHYSICAL px on the primary monitor. window.screen.* is CSS/logical px, so
// scale by devicePixelRatio to land in the same physical space as everything else.
function defaultWindowPosition(corner: Settings["corner"]) {
  const dpr = window.devicePixelRatio || 1;
  const safeInset = Math.max(20, Math.min(80, Math.floor((window.screen.availWidth || 900) * 0.04)));
  const safeWidth = Math.max(360, window.screen.availWidth || 900);
  const safeHeight = Math.max(500, window.screen.availHeight || 700);
  const widget = defaultWindowSize("widget");
  const positions: Record<Settings["corner"], { x: number; y: number }> = {
    "top-left": { x: safeInset, y: safeInset },
    "top-right": { x: Math.max(safeInset, safeWidth - widget.width - safeInset), y: safeInset },
    "bottom-left": { x: safeInset, y: Math.max(safeInset, safeHeight - widget.height - safeInset) },
    "bottom-right": { x: Math.max(safeInset, safeWidth - widget.width - safeInset), y: Math.max(safeInset, safeHeight - widget.height - safeInset) },
  };
  const pos = positions[corner];
  return { x: Math.round(pos.x * dpr), y: Math.round(pos.y * dpr) };
}

// Physical rect of the (single) browser screen — logical CSS px scaled by devicePixelRatio. Only a
// fallback when availableMonitors() is unavailable; the origin is assumed at 0,0 (primary monitor).
function browserScreenRects(): ScreenRect[] {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round((window.screen.availWidth || window.screen.width || 0) * dpr);
  const height = Math.round((window.screen.availHeight || window.screen.height || 0) * dpr);
  return width && height ? [{ x: 0, y: 0, width, height, scale: dpr }] : [];
}

// availableMonitors() returns position/size in PHYSICAL px already — use them directly (no dividing by
// scaleFactor). scale is kept so size min/max bounds (declared in logical px) can be converted per-monitor.
async function monitorScreenRects(): Promise<ScreenRect[]> {
  try {
    const monitors = await availableMonitors();
    return monitors
      .map((monitor) => ({
        x: Math.round(monitor.position.x),
        y: Math.round(monitor.position.y),
        width: Math.round(monitor.size.width),
        height: Math.round(monitor.size.height),
        scale: monitor.scaleFactor || 1,
      }))
      .filter((rect) => rect.width > 0 && rect.height > 0);
  } catch {
    return [];
  }
}

function visibleArea(geometry: WindowGeometry, rect: ScreenRect) {
  const visibleWidth = Math.min(rect.x + rect.width, geometry.x + geometry.width) - Math.max(rect.x, geometry.x);
  const visibleHeight = Math.min(rect.y + rect.height, geometry.y + geometry.height) - Math.max(rect.y, geometry.y);
  return Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
}

function isGeometryVisible(geometry: WindowGeometry, screenRects = browserScreenRects()) {
  if (!screenRects.length) return true;
  return screenRects.some((rect) => visibleArea(geometry, rect) >= 120 * 80);
}

function nearestScreenRect(geometry: WindowGeometry, fallbackPosition: { x: number; y: number }, screenRects: ScreenRect[]) {
  if (!screenRects.length) return undefined;
  const centerX = Number.isFinite(geometry.x) ? geometry.x + geometry.width / 2 : fallbackPosition.x;
  const centerY = Number.isFinite(geometry.y) ? geometry.y + geometry.height / 2 : fallbackPosition.y;
  return screenRects.reduce((nearest, rect) => {
    const nearestX = Math.min(nearest.x + nearest.width, Math.max(nearest.x, centerX));
    const nearestY = Math.min(nearest.y + nearest.height, Math.max(nearest.y, centerY));
    const rectX = Math.min(rect.x + rect.width, Math.max(rect.x, centerX));
    const rectY = Math.min(rect.y + rect.height, Math.max(rect.y, centerY));
    const nearestDistance = (nearestX - centerX) ** 2 + (nearestY - centerY) ** 2;
    const rectDistance = (rectX - centerX) ** 2 + (rectY - centerY) ** 2;
    return rectDistance < nearestDistance ? rect : nearest;
  }, screenRects[0]);
}

function clampPositionToScreen(geometry: WindowGeometry, fallbackPosition: { x: number; y: number }, screenRects: ScreenRect[]) {
  const screenRect = nearestScreenRect(geometry, fallbackPosition, screenRects);
  if (!screenRect) return geometry;
  return {
    ...geometry,
    x: Math.min(screenRect.x + screenRect.width - geometry.width, Math.max(screenRect.x, geometry.x)),
    y: Math.min(screenRect.y + screenRect.height - geometry.height, Math.max(screenRect.y, geometry.y)),
  };
}

function normalizeWindowGeometry(mode: AppMode, geometry: Partial<WindowGeometry> | undefined, fallbackPosition: { x: number; y: number }, screenRects = browserScreenRects(), widgetScale = 1): WindowGeometry {
  // Pick the monitor the window will sit on (by position) so we can convert the logical-px size bounds
  // below into this monitor's physical px. Position drives the choice; size fed as 0 to avoid NaN.
  const positionProbe: WindowGeometry = {
    width: Number.isFinite(geometry?.width) ? geometry!.width! : 0,
    height: Number.isFinite(geometry?.height) ? geometry!.height! : 0,
    x: Number.isFinite(geometry?.x) ? geometry!.x! : fallbackPosition.x,
    y: Number.isFinite(geometry?.y) ? geometry!.y! : fallbackPosition.y,
  };
  const targetRect = nearestScreenRect(positionProbe, fallbackPosition, screenRects);
  const scale = targetRect?.scale ?? (window.devicePixelRatio || 1);
  const fallbackSize = defaultWindowSize(mode);
  const fixedModeScale = mode === "widget" ? widgetScale : 1;
  const minWidthL = fallbackSize.width * fixedModeScale;
  const minHeightL = fallbackSize.height * fixedModeScale;
  const minWidth = Math.round(minWidthL * scale);
  const minHeight = Math.round(minHeightL * scale);
  // Widget and Mini dimensions are controlled by their layout engines. Persisted geometry contributes
  // position only, so a stale manually-resized width can never become the next 100% zoom baseline.
  const width = minWidth;
  const height = minHeight;
  const rawX = Number.isFinite(geometry?.x) ? Math.round(geometry!.x!) : fallbackPosition.x;
  const rawY = Number.isFinite(geometry?.y) ? Math.round(geometry!.y!) : fallbackPosition.y;

  const normalized = { width, height, x: rawX, y: rawY };
  if (isGeometryVisible(normalized, screenRects)) {
    return clampPositionToScreen(normalized, fallbackPosition, screenRects);
  }
  return clampPositionToScreen({ width, height, x: fallbackPosition.x, y: fallbackPosition.y }, fallbackPosition, screenRects);
}

async function normalizeWindowGeometryForMonitors(mode: AppMode, geometry: Partial<WindowGeometry> | undefined, fallbackPosition: { x: number; y: number }, widgetScale = 1) {
  const screenRects = await monitorScreenRects();
  return normalizeWindowGeometry(mode, geometry, fallbackPosition, screenRects.length ? screenRects : browserScreenRects(), widgetScale);
}

async function recoverVisibleWindow(mode: AppMode, corner: Settings["corner"], widgetScale = 1, reveal = true) {
  const appWindow = getCurrentWindow();
  const restoreGeneration = windowGeometryResetGeneration;
  const fallbackPosition = defaultWindowPosition(corner);
  const saved = (await loadWindowGeometryAsync())[mode];
  const geometry = await normalizeWindowGeometryForMonitors(mode, saved, fallbackPosition, widgetScale);
  if (restoreGeneration !== windowGeometryResetGeneration) return;
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
  } catch {
    // no-op: older platforms can reject this while the window is being created.
  }
  await appWindow.unminimize().catch(() => undefined);
  if (reveal) await appWindow.setSize(new PhysicalSize(geometry.width, geometry.height)).catch(() => undefined);
  if (restoreGeneration !== windowGeometryResetGeneration) return;
  const positionApplied = await appWindow.setPosition(new PhysicalPosition(geometry.x, geometry.y)).then(() => true).catch(() => false);
  if (positionApplied) {
    const actualPosition = await appWindow.outerPosition().catch(() => new PhysicalPosition(geometry.x, geometry.y));
    if (restoreGeneration === windowGeometryResetGeneration) {
      saveWindowGeometry(mode, { x: Math.round(actualPosition.x), y: Math.round(actualPosition.y) });
    }
  }
  if (reveal) await invoke("open_widget_window").catch(() => undefined);
}

// Persist only the outer position. Full and Mini sizes are layout-controlled and can be transient while
// zoom, content measurement, or DPI changes are settling.
async function readCurrentPosition(): Promise<WindowPosition> {
  const appWindow = getCurrentWindow();
  const position = await appWindow.outerPosition();
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
  };
}

function shouldStartWindowDrag(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest(
    "button, input, select, textarea, a, label, summary, details, [role='button'], .window-controls, .advanced-tools, .debug-text, .provider-tile, .tile-shell, .detached-tile",
  );
}

function startWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0 || !shouldStartWindowDrag(event.target)) return;
  void getCurrentWindow().startDragging().catch(() => undefined);
}

function loadSnapshot(provider: Provider): UsageSnapshot {
  try {
    const saved = localStorage.getItem(`usageview.snapshot.${provider}`);
    return saved ? JSON.parse(saved) : emptySnapshot(provider);
  } catch {
    return emptySnapshot(provider);
  }
}

function saveSnapshot(snapshot: UsageSnapshot) {
  localStorage.setItem(`usageview.snapshot.${snapshot.provider}`, JSON.stringify(snapshot));
  window.dispatchEvent(new Event("usageview:snapshot"));
}

function snapshotsForAccounts(accounts: Account[]): Record<Provider, UsageSnapshot> {
  return Object.fromEntries(accounts.map((account) => [account.id, loadSnapshot(account.id)]));
}

function snapshotOf(snapshots: Record<Provider, UsageSnapshot>, id: Provider): UsageSnapshot {
  return snapshots[id] ?? emptySnapshot(id);
}

function retainLastGoodClaude(snapshot: UsageSnapshot): UsageSnapshot {
  if (providerKind(snapshot.provider) !== "claude" || (snapshot.status !== "page_unavailable" && snapshot.status !== "not_found")) {
    return snapshot;
  }
  const previous = loadSnapshot(snapshot.provider);
  if (previous.status !== "ok") return snapshot;
  return {
    ...previous,
    message: `${snapshot.message || "Claude usage is still loading."} Last good value retained.`,
    debugText: snapshot.debugText,
    updatedAt: new Date().toISOString(),
  };
}

function readableStatus(status: UsageStatus) {
  if (status === "not_found") return "not found";
  if (status === "not_logged_in") return "login needed";
  if (status === "page_unavailable") return "page unavailable";
  return status.replace(/_/g, " ");
}

function providerLabel(provider: Provider) {
  return accountRegistry[provider]?.label ?? provider;
}

function lifecycleShowsTile(lifecycle: ProviderLifecycle | undefined) {
  return lifecycle?.phase === "ready" || lifecycle?.phase === "login-needed";
}

function lifecycleIsTransitioning(lifecycle: ProviderLifecycle | undefined) {
  return lifecycle?.phase === "starting" || lifecycle?.phase === "retrying" || lifecycle?.phase === "stopping" || lifecycle?.phase === "waiting-close";
}

function lifecycleLabel(lifecycle: ProviderLifecycle | undefined) {
  if (!lifecycle) return undefined;
  switch (lifecycle.phase) {
    case "stopped": return "stopped";
    case "starting": return "starting";
    case "retrying": return `retry ${lifecycle.attempt ?? 1}/${PROVIDER_START_ATTEMPTS}`;
    case "ready": return "live";
    case "login-needed": return "login needed";
    case "stopping": return "stopping";
    case "waiting-close": return "close window";
    case "error": return "error";
  }
}

function lifecycleTone(lifecycle: ProviderLifecycle | undefined): "ok" | "warn" | "page_unavailable" {
  if (lifecycle?.phase === "ready" || lifecycle?.phase === "stopped") return "ok";
  if (lifecycle?.phase === "error") return "page_unavailable";
  return "warn";
}

function providerUrl(provider: Provider, settings: Settings): string {
  const account = settings.accounts.find((a) => a.id === provider);
  return account?.url ?? ACCOUNT_DEFAULT_URL[providerKind(provider)];
}

// Pre-pass only: Rust clamps the real window to the monitor work area once it exists and reports
// back over `usageview-detached-position`. Keep the probe the same size Rust builds the window at,
// or the two clamps disagree about what fits.
async function normalizeDetachedTilePosition(position: WindowPosition, uiScale: number): Promise<WindowPosition> {
  const screens = await monitorScreenRects();
  const rects = screens.length ? screens : browserScreenRects();
  const tileScale = clampTileScale(uiScale);
  const probe = { x: position.x, y: position.y, width: DETACHED_TILE_WIDTH * tileScale, height: DETACHED_TILE_HEIGHT * tileScale };
  const target = nearestScreenRect(probe, position, rects);
  const scale = target?.scale ?? (window.devicePixelRatio || 1);
  const clamped = clampPositionToScreen({ ...probe, width: probe.width * scale, height: probe.height * scale }, position, rects);
  return { x: Math.round(clamped.x), y: Math.round(clamped.y) };
}

function providerEnabled(provider: Provider, settings: Settings): boolean {
  if (!settings.aiUsageEnabled) return false;
  return settings.accounts.find((a) => a.id === provider)?.shown ?? false;
}

function resetCountdownLabel(snapshot: UsageSnapshot): string | undefined {
  const resetMs = snapshotResetMs(snapshot);
  if (resetMs === null) return snapshot.resetLabel ? "resetting soon" : undefined;
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return "resetting soon";
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  return hours > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${minutes}m`;
}

function snapshotDisplayPeriod(snapshot: UsageSnapshot): "main" | "weekly" {
  return snapshot.displayPeriod === "weekly" ? "weekly" : "main";
}

function providerMessage(snapshot: UsageSnapshot) {
  if (snapshot.status === "ok") {
    if (snapshotDisplayPeriod(snapshot) === "weekly") return "used this week";
    return resetCountdownLabel(snapshot) ?? "up to date";
  }
  if (snapshot.status === "not_found" && providerKind(snapshot.provider) === "claude") return "Usage page not detected";
  if (snapshot.status === "not_open") return "Open login";
  if (snapshot.status === "not_logged_in") return "Sign in needed";
  return snapshot.message;
}

type SettingsHeaderTone = "ok" | "warn" | "error";

function isProviderError(status: UsageStatus) {
  return status === "not_found" || status === "parser_failed" || status === "page_unavailable";
}

function settingsActivityMessage(previous: Settings, next: Settings): string {
  if (previous.theme !== next.theme) {
    if (themeStyle(previous.theme) !== themeStyle(next.theme)) {
      return `${themeStyle(next.theme) === "glass" ? "Glass" : "Pixel"} style selected`;
    }
    return `${themeMode(next.theme) === "light" ? "Light" : "Dark"} mode enabled`;
  }
  if (previous.opacity !== next.opacity) return `Opacity ${Math.round(next.opacity * 100)}%`;
  if (previous.uiScale !== next.uiScale) return `Widget zoom ${Math.round(next.uiScale * 100)}%`;
  if (previous.refreshIntervalSec !== next.refreshIntervalSec) return `Refresh every ${next.refreshIntervalSec}s`;
  if (previous.aiUsageEnabled !== next.aiUsageEnabled) return `AI usage turned ${next.aiUsageEnabled ? "on" : "off"}`;
  if (previous.effectsEnabled !== next.effectsEnabled) return `Usage effect turned ${next.effectsEnabled ? "on" : "off"}`;
  if (previous.effectDropCell !== next.effectDropCell) return `Drop cell effect turned ${next.effectDropCell ? "on" : "off"}`;
  if (previous.systemMonitorsEnabled !== next.systemMonitorsEnabled) return `System monitors turned ${next.systemMonitorsEnabled ? "on" : "off"}`;
  if (previous.monitorIntervalSec !== next.monitorIntervalSec) return `Monitor update every ${next.monitorIntervalSec}s`;
  if (previous.colorsEnabled !== next.colorsEnabled) return `Colors turned ${next.colorsEnabled ? "on" : "off"}`;

  for (const account of next.accounts) {
    const before = previous.accounts.find((a) => a.id === account.id);
    if (!before) return `${account.label} added`;
    if (before.shown !== account.shown) return `${account.label} ${account.shown ? "shown" : "hidden"} on widget`;
    if (before.url !== account.url) return `${account.label} URL updated`;
  }
  const removed = previous.accounts.find((a) => !next.accounts.some((b) => b.id === a.id));
  if (removed) return `${removed.label} removed`;
  const monitorVisibility: [keyof Settings, string][] = [
    ["showCpu", "CPU"], ["showRam", "RAM"], ["showGpu", "GPU"], ["showIgpu", "iGPU"],
    ["showCpuTemp", "CPU temperature"], ["showGpuTemp", "GPU temperature"],
  ];
  for (const [key, label] of monitorVisibility) {
    if (previous[key] !== next[key]) return `${label} monitor ${next[key] ? "shown" : "hidden"}`;
  }
  if (previous.corner !== next.corner) return "Widget corner updated";
  if (previous.alwaysOnTop !== next.alwaysOnTop) return `Widget pin turned ${next.alwaysOnTop ? "on" : "off"}`;
  if (previous.providerColors !== next.providerColors || previous.monitorColors !== next.monitorColors || previous.colorScope !== next.colorScope || previous.baseOverrides !== next.baseOverrides) return "Colors updated";
  return "Settings updated";
}

function statusLineTone(message: string): "ok" | "warn" | "error" {
  const normalized = message.toLowerCase();
  if (normalized.includes("chrome not found")) return "warn";
  if (/(failed|error|not found|unavailable|parser|denied)/.test(normalized)) return "error";
  if (/(refreshing|opening|warning|rate.?limit|not logged|sign in)/.test(normalized)) return "warn";
  return "ok";
}

function formatCompactDate(date: Date) {
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function resetLabelToClock(label?: string) {
  if (!label) return undefined;
  const explicitDate = label.match(/(?:Reset|resets?)\s+(.+)/i);
  const text = explicitDate ? explicitDate[1] : label;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return `Reset ${formatCompactDate(new Date(parsed))}`;

  // Relative "resets in Xh Ym" — only trust short, reset-shaped strings, never long scraped page
  // text (Claude's DOM fallback can grab promo/Fable copy). Otherwise report no clean reset.
  const lower = label.toLowerCase();
  if (label.length <= 40 && lower.includes("in")) {
    const hours = Number(lower.match(/(\d+)\s*h/)?.[1] ?? lower.match(/(\d+)\s*hr/)?.[1] ?? 0);
    const minutes = Number(lower.match(/(\d+)\s*m/)?.[1] ?? lower.match(/(\d+)\s*min/)?.[1] ?? 0);
    if (hours || minutes) return `Reset ${formatCompactDate(new Date(Date.now() + (hours * 60 + minutes) * 60 * 1000))}`;
  }
  return undefined;
}

function usageMetaLeft(snapshot: UsageSnapshot) {
  if (snapshotDisplayPeriod(snapshot) === "weekly" && typeof snapshot.percentUsed === "number") {
    const used = Math.max(0, Math.min(100, snapshot.percentUsed));
    return `${Math.max(0, 100 - Math.round(used))}% left`;
  }
  // Only ever show a clean "Weekly left X%" (or a placeholder) — never raw scraped text, which for
  // Claude's DOM fallback can contain promo/Fable copy.
  const weeklyUsed = snapshot.weeklyLabel?.match(/Weekly\s+(\d{1,3})(?:\.\d+)?%\s+used/i)?.[1];
  if (weeklyUsed !== undefined) return `Weekly left ${100 - Number(weeklyUsed)}%`;
  const weeklyLeft = snapshot.remainingLabel?.match(/Weekly left\s+(\d{1,3})%/i)?.[1];
  if (weeklyLeft !== undefined) return `Weekly left ${weeklyLeft}%`;
  return "Weekly left --";
}

function weeklyResetLabel(snapshot: UsageSnapshot) {
  // The weekly reset clock is carried inside weeklyLabel as ".../ Reset <clock>" (both Claude and
  // Codex now emit that shape). Pull out the "Reset ..." segment and normalize it, so the meta-right
  // cell (next to "Weekly left X%") shows the WEEKLY reset — the 5-hour reset already lives in the
  // message countdown ("resets in Xh Ym") and the flip-timer.
  const resetPart = snapshot.weeklyLabel
    ?.split(" / ")
    .find((part) => /^\s*Reset\b/i.test(part));
  const resetMs = validResetAtMs(snapshot.weeklyResetAtMs);
  if (resetMs !== null) return `Reset ${formatCompactDate(new Date(resetMs))}`;
  const legacyResetMs = parseResetMs(resetPart);
  if (legacyResetMs !== null) return `Reset ${formatCompactDate(new Date(legacyResetMs))}`;
  return resetLabelToClock(resetPart) || "Reset --";
}

function usageMetaRight(snapshot: UsageSnapshot) {
  if (snapshotDisplayPeriod(snapshot) === "weekly") return resetCountdownLabel(snapshot) ?? "Reset --";
  return weeklyResetLabel(snapshot);
}

function hasUsageDisplayValue(snapshot: UsageSnapshot) {
  return (
    snapshot.percentUsed !== undefined ||
    !!snapshot.usedLabel ||
    !!snapshot.remainingLabel ||
    !!snapshot.resetLabel ||
    snapshot.resetAtMs !== undefined ||
    snapshot.weeklyResetAtMs !== undefined ||
    !!snapshot.weeklyLabel
  );
}

function flashToken(snapshot: UsageSnapshot) {
  if (snapshot.status !== "ok") return "";
  if (!hasUsageDisplayValue(snapshot)) return "";
  if (snapshot.message.toLowerCase().includes("last good value retained")) return "";
  return snapshot.updatedAt;
}

function isStale(snapshot: UsageSnapshot) {
  return snapshot.status === "ok" && snapshot.message.toLowerCase().includes("last good value retained");
}

function formatAgo(iso?: string): string | undefined {
  if (!iso) return undefined;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return undefined;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function tooltipLeftLabel(snapshot: UsageSnapshot) {
  if (snapshot.status !== "ok" || typeof snapshot.percentUsed !== "number") return "-- left";
  const left = Math.round(100 - Math.max(0, Math.min(100, snapshot.percentUsed)));
  return `${left}% left`;
}

// Mirrors exactly what the widget currently shows: enabled accounts (aiUsageEnabled && shown) plus the
// enabled system monitors, one metric per line, accounts first. Toggling a metric off in Settings drops
// it from the tooltip too.
function trayTooltipText(
  snapshots: Record<Provider, UsageSnapshot>,
  settings: Settings,
  monitorReadings: Record<MonitorKind, MonitorReading>,
) {
  const lines: string[] = [];
  for (const account of settings.accounts) {
    if (!providerEnabled(account.id, settings)) continue;
    lines.push(`${account.label}: ${tooltipLeftLabel(snapshots[account.id] ?? emptySnapshot(account.id))}`);
  }
  const shownMonitors = settings.systemMonitorsEnabled ? MONITOR_ORDER.filter((kind) => settings[MONITOR_SHOW_KEY[kind]] as boolean) : [];
  for (const kind of shownMonitors) {
    const reading = monitorReadings[kind];
    if (reading) lines.push(`${reading.label}: ${reading.available ? reading.displayValue : "N/A"}`);
  }
  if (!lines.length) return "UsageView — nothing shown";
  return lines.join("\n");
}

const LIMITED_RESET_REFRESH_LEAD_MS = 2 * 60 * 1000;
const LIMITED_FALLBACK_REFRESH_MS = 10 * 60 * 1000;

function limitedThreshold(provider: Provider) {
  return providerKind(provider) === "claude" ? 99 : 100;
}

function isProviderLimited(provider: Provider, snapshot: UsageSnapshot) {
  return (snapshot.percentUsed ?? 0) >= limitedThreshold(provider);
}

function trustworthyLimitState(provider: Provider, snapshot: UsageSnapshot): boolean | undefined {
  const percent = snapshot.percentUsed;
  if (snapshot.status !== "ok" || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return undefined;
  }
  return percent >= limitedThreshold(provider);
}

function shouldAutoRefreshProvider(provider: Provider, snapshot: UsageSnapshot, now: number, lastLimitedRefreshAt: Record<Provider, number>) {
  if (!isProviderLimited(provider, snapshot)) return true;

  const resetMs = snapshotResetMs(snapshot);
  if (resetMs !== null) return resetMs <= now + LIMITED_RESET_REFRESH_LEAD_MS;

  return now - (lastLimitedRefreshAt[provider] || 0) >= LIMITED_FALLBACK_REFRESH_MS;
}

function providerForLabel(label: string): Provider | null {
  // Mirror of provider_label in lib.rs: labels are `provider_<id with - turned into _>`. Account ids
  // only ever use [a-z0-9-] (never _), so turning _ back into - recovers the id exactly.
  if (!label.startsWith("provider_")) return null;
  const id = label.slice("provider_".length).replace(/_/g, "-");
  return /^[a-z0-9-]+$/.test(id) ? id : null;
}

function decodeSnapshot(provider: Provider, encoded: string): UsageSnapshot {
  try {
    const json = decodeURIComponent(encoded);
    const parsed = JSON.parse(json) as UsageSnapshot;
    return { ...parsed, provider, updatedAt: new Date().toISOString() };
  } catch {
    return {
      provider,
      status: "parser_failed",
      message: "Extractor returned unreadable data",
      updatedAt: new Date().toISOString(),
    };
  }
}

async function openProvider(provider: Provider, settings: Settings) {
  const url = providerUrl(provider, settings);
  localStorage.setItem(`usageview.providerTarget.${provider}`, url);
  await invoke("open_provider_window", { provider, url, displayLabel: providerLabel(provider) });
}

async function closeProvider(provider: Provider) {
  await invoke("close_provider_window", { provider });
}

async function refreshProviderPage(provider: Provider, url: string, background = false) {
  await invoke("refresh_provider_page", { provider, url, background });
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function logoutProvider(provider: Provider, url: string) {
  await invoke("logout_provider", { provider, url, displayLabel: providerLabel(provider) });
}

// Open in Chrome; fall back to the OS default browser if Chrome isn't installed. Used by the provider
// login window's "Open Browser" button (the per-account Settings button was removed).
async function openInChrome(url: string): Promise<"chrome" | "default"> {
  try {
    await invoke("open_in_chrome", { url });
    return "chrome";
  } catch {
    await openUrl(url);
    return "default";
  }
}

// One-off: discover the JSON usage endpoint the provider page calls, returned pretty-printed.
async function discoverProviderApi(provider: Provider, url: string): Promise<string> {
  const encoded = await invoke<string>("discover_provider_api", { provider, kind: providerKind(provider), url, displayLabel: providerLabel(provider) });
  try {
    return JSON.stringify(JSON.parse(decodeURIComponent(encoded)), null, 2);
  } catch {
    return decodeURIComponent(encoded);
  }
}

type SnapshotCommitGuard = (snapshot: UsageSnapshot) => boolean;

async function extractProvider(provider: Provider, url: string, shouldCommit: SnapshotCommitGuard = () => true): Promise<UsageSnapshot> {
  try {
    const encoded = await invoke<string>("extract_provider", { provider, kind: providerKind(provider), url, displayLabel: providerLabel(provider) });
    const snapshot = retainLastGoodClaude(decodeSnapshot(provider, encoded));
    if (shouldCommit(snapshot)) saveSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const needsLogin = lower.includes("not_logged_in") || lower.includes("not signed in") || lower.includes("sign in");
    const snapshot = retainLastGoodClaude({
      provider,
      status: needsLogin ? "not_open" : "page_unavailable",
      message,
      updatedAt: new Date().toISOString(),
    });
    if (shouldCommit(snapshot)) saveSnapshot(snapshot);
    return snapshot;
  }
}

async function refreshProviderFromUrl(provider: Provider, url: string, background = false, shouldCommit?: SnapshotCommitGuard): Promise<UsageSnapshot> {
  // Auto refresh reads the provider's cookie-authed usage API, which needs no page render, so it
  // goes straight to the extractor — which already navigates itself when the page is off-target.
  // Reloading the whole SPA every tick, then sleeping below purely to absorb that reload, was work
  // for nothing. (It is not what makes the app expensive at idle, though: the hidden provider pages
  // cost ~30% of a core just by staying loaded.) Manual refresh still reloads first.
  if (background) return extractProvider(provider, url, shouldCommit);
  try {
    await refreshProviderPage(provider, url, background);
    await wait(providerKind(provider) === "claude" ? 2600 : 900);
  } catch {
    // If navigation fails, still try the extractor so the UI gets a useful error snapshot.
  }
  return extractProvider(provider, url, shouldCommit);
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-shell">
          <h1>UsageView render error</h1>
          <pre>{this.state.error.message}</pre>
        </main>
      );
    }
    return this.props.children;
  }
}

function App() {
  const label = getCurrentWindow().label;
  const provider = providerForLabel(label);
  if (provider) return <ProviderLoginApp provider={provider} />;
  if (label === "settings") return <SettingsWindowApp />;
  const queryTileId = new URLSearchParams(window.location.search).get("tile");
  const tileId = isTileId(queryTileId) ? queryTileId : tileIdForWindowLabel(label);
  if (tileId) return <DetachedTileApp tileId={tileId} />;
  return <WidgetApp />;
}

function DetachedTileApp({ tileId }: { tileId: TileId }) {
  const [settings, setSettings] = useState(loadSettings);
  const [runtime, setRuntime] = useState<DetachedRuntimeState>(() => {
    const provider = providerFromTile(tileId);
    const monitor = monitorFromTile(tileId);
    return {
      snapshot: provider ? loadSnapshot(provider) : undefined,
      monitorReading: monitor ? emptyReading(monitor) : undefined,
      flash: false,
      paused: false,
    };
  });
  const rootRef = useRef<HTMLElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const nativeDragActiveRef = useRef(false);
  const dragFinishTimerRef = useRef(0);

  useEffect(() => {
    function reloadSettings() { setSettings(loadSettings()); }
    function onStorage(event: StorageEvent) { if (event.key === "usageview.settings") reloadSettings(); }
    window.addEventListener("storage", onStorage);
    window.addEventListener("usageview:settings", reloadSettings);
    let unlisten: (() => void) | undefined;
    void listen<DetachedRuntimeState>("usageview-runtime-state", ({ payload }) => setRuntime(payload))
      .then((dispose) => { unlisten = dispose; });
    void emitTo("widget", "usageview-runtime-request", { label: getCurrentWindow().label });
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("usageview:settings", reloadSettings);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop).catch(() => undefined);
    void getCurrentWebview().setZoom(settings.uiScale).catch(() => undefined);
    document.documentElement.classList.add("detached-surface");
    return () => {
      document.documentElement.classList.remove("detached-surface");
    };
  }, [settings.alwaysOnTop, settings.uiScale]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    function scheduleFinish() {
      if (!nativeDragActiveRef.current) return;
      window.clearTimeout(dragFinishTimerRef.current);
      dragFinishTimerRef.current = window.setTimeout(async function finish() {
        if (!nativeDragActiveRef.current) return;
        const result = await invoke<boolean | null>("finish_detached_tile_drag", { tileId }).catch(() => false);
        if (result === null) {
          dragFinishTimerRef.current = window.setTimeout(finish, 120);
        } else {
          nativeDragActiveRef.current = false;
          pointerRef.current = null;
        }
      }, 180);
    }
    void appWindow.onMoved(scheduleFinish).then((dispose) => { unlisten = dispose; });
    return () => { window.clearTimeout(dragFinishTimerRef.current); unlisten?.(); };
  }, [tileId]);

  function onMouseDown(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, a, [role='button']")) return;
    pointerRef.current = { x: event.clientX, y: event.clientY, dragging: false };
  }

  function onMouseMove(event: React.MouseEvent<HTMLElement>) {
    const pointer = pointerRef.current;
    if (!pointer || pointer.dragging || (event.buttons & 1) !== 1) return;
    if (Math.abs(event.clientX - pointer.x) < 6 && Math.abs(event.clientY - pointer.y) < 6) return;
    pointer.dragging = true;
    suppressClickRef.current = true;
    nativeDragActiveRef.current = true;
    void getCurrentWindow().startDragging().catch(() => {
      nativeDragActiveRef.current = false;
      pointerRef.current = null;
    });
  }

  const provider = providerFromTile(tileId);
  const monitor = monitorFromTile(tileId);
  const accent = provider ? providerAccent(provider, settings) : undefined;
  const snapshot = provider ? runtime.snapshot ?? emptySnapshot(provider) : null;
  const reading = monitor ? runtime.monitorReading ?? emptyReading(monitor) : null;
  const activeEffect = settings.effectsEnabled ? runtime.activeEffect : undefined;
  const deferAutoTimer = runtime.timerOrigin === "auto" && activeEffect !== undefined && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const toggleTimer = () => { if (provider) void emitTo("widget", TIMER_TOGGLE_EVENT, { provider }); };
  const content = provider
    ? runtime.timerOrigin && !deferAutoTimer
      ? <TimerView snapshot={snapshot!} accent={accent} onBack={toggleTimer} paused={runtime.paused} />
      : <UsageBlock
          snapshot={snapshot!}
          accent={accent}
          flash={runtime.flash}
          paused={runtime.paused}
          updatedAgo={formatAgo(runtime.freshAt)}
          effect={activeEffect}
          dropCell={settings.effectDropCell}
          glass={themeStyle(settings.theme) === "glass"}
          effectsEnabled={settings.effectsEnabled}
          onFlip={deferAutoTimer ? undefined : toggleTimer}
        />
    : monitor
      ? <MonitorBlock key={reading!.testNonce ?? "live"} reading={reading!} tone={monitorTone(settings, reading!)} pulse={settings.effectsEnabled} glass={themeStyle(settings.theme) === "glass"} textEffect={!settings.colorsEnabled || settings.colorScope.text} />
      : null;

  return (
    <main
      ref={rootRef}
      className={`detached-tile widget ${themeClass(settings.theme)} ${panelScopeClasses(settings)}`}
      style={panelStyle(settings)}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void invoke("show_detached_tile_context_menu", { tileId, displayLabel: tileDisplayLabel(tileId), x: event.clientX, y: event.clientY }).catch(() => undefined);
      }}
    >
      {content}
    </main>
  );
}

// Cross-window command bus: the detached Settings window can't touch the widget's tile/engine directly.
// Refresh uses a targeted Tauri event with localStorage as fallback; visual tester commands remain on
// localStorage. The widget stays the single owner of extraction and its in-flight guard.
const APP_CMD_KEY = "usageview.appcmd";
type RefreshRequest = { nonce: string; provider: Provider };
type RefreshResult = { nonce: string; provider: Provider; status: UsageStatus; message: string };
type AppCommand =
  | { nonce: string; type: "play"; provider: Provider; from: number; to: number; driveBar: boolean }
  | { nonce: string; type: "restore" }
  | { nonce: string; type: "play-monitor"; kind: MonitorKind; value: number }
  | { nonce: string; type: "restore-monitor" }
  | { nonce: string; type: "refresh"; provider: Provider }
  | { nonce: string; type: "reset-window" };

function postAppCommand(command: AppCommand) {
  localStorage.setItem(APP_CMD_KEY, JSON.stringify(command));
}

function newNonce() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Custom auto-hiding overlay scrollbar for the Settings window. Draws a thin thumb over the content
// (no reserved gutter, so content stays centered), visible only while scrolling / hovering / dragging.
function OverlayScrollbar({ targetRef }: { targetRef: React.RefObject<HTMLElement | null> }) {
  const [thumb, setThumb] = useState({ top: 0, height: 0 });
  const [overflowing, setOverflowing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hideTimerRef = useRef(0);
  const dragRef = useRef<{ startY: number; startScroll: number } | null>(null);

  const recompute = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    const { clientHeight, scrollHeight, scrollTop } = el;
    const over = scrollHeight > clientHeight + 1;
    setOverflowing(over);
    if (!over) return;
    const height = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = clientHeight - height;
    const denom = scrollHeight - clientHeight;
    const top = denom > 0 ? maxTop * (scrollTop / denom) : 0;
    setThumb({ top, height });
  }, [targetRef]);

  const flash = useCallback(() => {
    setVisible(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!dragRef.current) setVisible(false);
    }, 900);
  }, []);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    recompute();
    function onScroll() { recompute(); flash(); }
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => recompute());
    observer.observe(el);
    Array.from(el.children).forEach((child) => observer.observe(child));
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      window.clearTimeout(hideTimerRef.current);
    };
  }, [targetRef, recompute, flash]);

  useEffect(() => {
    if (!dragging) return;
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      const el = targetRef.current;
      if (!drag || !el) return;
      const { clientHeight, scrollHeight } = el;
      const height = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
      const maxTop = clientHeight - height;
      const ratio = maxTop > 0 ? (event.clientY - drag.startY) / maxTop : 0;
      el.scrollTop = drag.startScroll + ratio * (scrollHeight - clientHeight);
    }
    function onUp() {
      dragRef.current = null;
      setDragging(false);
      flash();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, targetRef, flash]);

  if (!overflowing) return null;
  return (
    <div
      className={`overlay-scrollbar${visible || dragging ? " is-visible" : ""}`}
      onPointerEnter={() => setVisible(true)}
      onPointerLeave={() => { if (!dragRef.current) flash(); }}
    >
      <div
        className={`overlay-scrollbar-thumb${dragging ? " is-dragging" : ""}`}
        style={{ transform: `translateY(${thumb.top}px)`, height: `${thumb.height}px` }}
        onPointerDown={(event) => {
          event.preventDefault();
          const el = targetRef.current;
          if (!el) return;
          dragRef.current = { startY: event.clientY, startScroll: el.scrollTop };
          setDragging(true);
          setVisible(true);
        }}
      />
    </div>
  );
}

// Detached Settings window: same bundle, rendered when the window label is "settings". Hosts the full
// settings screen (activity/health header + Accounts + Widget config) reusing the same components. Settings persist to
// localStorage (widget mirrors them via its "storage" listener). Snapshots shown here come from
// localStorage and update when the widget saves a fresh read. Tester + Refresh route through the bus.
function SettingsWindowApp() {
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  useEffect(() => { syncAccountRegistry(settings.accounts); }, [settings.accounts]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [snapshots, setSnapshots] = useState<Record<Provider, UsageSnapshot>>(() => snapshotsForAccounts(loadSettings().accounts));
  const [discovery, setDiscovery] = useState<Partial<Record<Provider, string>>>({});
  const [busy, setBusy] = useState<Provider | `${Provider}-open` | `${Provider}-close` | `${Provider}-reload` | `${Provider}-logout` | `${Provider}-discover` | null>(null);
  const [activity, setActivity] = useState("Settings ready");
  const [commandErrors, setCommandErrors] = useState<Partial<Record<Provider, string>>>({});
  const [providerLifecycles, setProviderLifecycles] = useState<Partial<Record<Provider, ProviderLifecycle>>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<Account | null>(null);
  const [tab, setTab] = useState<SettingsTab>("general");
  // The widget's Full/Mini mode lives in the widget window; the Settings General tab mirrors it via the
  // shared MODE_KEY (the widget writes it on change) and drives it through the context-action channel.
  const [widgetMode, setWidgetMode] = useState<AppMode>(loadMode);
  const [widgetVisible, setWidgetVisible] = useState<boolean | null>(null);
  const [widgetToggleBusy, setWidgetToggleBusy] = useState(false);
  const widgetVisibilityQueryRef = useRef(0);
  // Live sensor values for the System-monitor tab cards. Local hardware reads are cheap, so this polls
  // only while that tab is open and stops otherwise (accounts are NOT polled — they show last snapshot).
  const [monitorReadings, setMonitorReadings] = useState<Record<MonitorKind, MonitorReading>>(() => buildMonitorReadings(null));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const refreshNonceRef = useRef<Partial<Record<Provider, string>>>({});

  const queryWidgetVisibility = useCallback(async () => {
    const query = ++widgetVisibilityQueryRef.current;
    try {
      const visible = await invoke<boolean>("get_widget_visibility");
      if (query === widgetVisibilityQueryRef.current) setWidgetVisible(visible);
    } catch {
      if (query === widgetVisibilityQueryRef.current) setWidgetVisible(null);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<boolean>(WIDGET_VISIBILITY_EVENT, ({ payload }) => {
      widgetVisibilityQueryRef.current += 1;
      setWidgetVisible(payload);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    void queryWidgetVisibility();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void queryWidgetVisibility();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [queryWidgetVisibility]);

  useEffect(() => {
    function syncMode(event: StorageEvent) { if (event.key === MODE_KEY) setWidgetMode(loadMode()); }
    window.addEventListener("storage", syncMode);
    return () => window.removeEventListener("storage", syncMode);
  }, []);

  useEffect(() => {
    if (tab !== "monitors") return;
    let alive = true;
    let id = 0;
    const poll = async () => {
      const metrics = await readSystemMetrics(MONITOR_ORDER);
      if (alive && metrics) setMonitorReadings(buildMonitorReadings(metrics, MONITOR_ORDER));
    };
    const start = () => {
      if (id) return;
      void poll();
      id = window.setInterval(poll, Math.max(1, settings.monitorIntervalSec) * 1000);
    };
    const stop = () => { if (id) { window.clearInterval(id); id = 0; } };
    // Only read while the Settings window is actually visible — hiding it (the ✕ just hides, not closes)
    // must stop the interval so nothing polls in the background.
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { alive = false; stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [tab, settings.monitorIntervalSec]);

  function setWidgetViewMode(mode: AppMode) {
    setWidgetMode(mode);
    void emitTo("widget", "usageview-context-action", mode).catch(() => undefined);
  }

  async function toggleWidgetVisibility() {
    if (widgetToggleBusy) return;
    setWidgetToggleBusy(true);
    try {
      const visible = await invoke<boolean>("toggle_widget_window");
      widgetVisibilityQueryRef.current += 1;
      setWidgetVisible(visible);
    } catch (error) {
      setActivity(`Widget visibility failed: ${String(error)}`);
      void queryWidgetVisibility();
    } finally {
      setWidgetToggleBusy(false);
    }
  }

  // Refresh everything currently on the widget (shown accounts); hidden accounts are skipped. Monitors
  // refresh on their own poll, so this only re-reads the AI accounts.
  function refreshAllShown() {
    for (const account of settings.accounts) {
      if (providerEnabled(account.id, settings)) void refresh(account.id);
    }
  }

  useEffect(() => {
    function reloadSettings() {
      setSettings(loadSettings());
    }
    function reloadSnapshots() {
      const accounts = loadSettings().accounts;
      const nextSnapshots = snapshotsForAccounts(accounts);
      setSnapshots(nextSnapshots);
      setCommandErrors((current) => {
        const next = { ...current };
        for (const account of accounts) if (snapshotOf(nextSnapshots, account.id).status === "ok") delete next[account.id];
        return next;
      });
    }
    function reloadStorage(event: StorageEvent) {
      if (event.key === "usageview.settings") reloadSettings();
      else if (event.key?.startsWith("usageview.snapshot.")) reloadSnapshots();
    }
    window.addEventListener("storage", reloadStorage);
    window.addEventListener("usageview:settings", reloadSettings);
    window.addEventListener("usageview:snapshot", reloadSnapshots);
    return () => {
      window.removeEventListener("storage", reloadStorage);
      window.removeEventListener("usageview:settings", reloadSettings);
      window.removeEventListener("usageview:snapshot", reloadSnapshots);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<RefreshResult>("usageview-refresh-result", ({ payload }) => {
      if (refreshNonceRef.current[payload.provider] !== payload.nonce) return;
      const snapshot = loadSnapshot(payload.provider);
      setSnapshots((current) => ({ ...current, [payload.provider]: snapshot }));
      setBusy((current) => current === payload.provider ? null : current);
      delete refreshNonceRef.current[payload.provider];
      const text = payload.status === "ok"
        ? `${providerLabel(payload.provider)} usage refreshed`
        : `${providerLabel(payload.provider)}: ${readableStatus(payload.status)}. ${payload.message}`;
      if (isProviderError(payload.status)) {
        setCommandErrors((current) => ({ ...current, [payload.provider]: text }));
      } else {
        setCommandErrors((current) => { const next = { ...current }; delete next[payload.provider]; return next; });
        setActivity(text);
      }
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ProviderLifecycle>(PROVIDER_LIFECYCLE_EVENT, ({ payload }) => {
      if (!payload?.provider) return;
      if (!settingsRef.current.accounts.some((account) => account.id === payload.provider) && !payload.message?.endsWith(" removed")) return;
      setProviderLifecycles((current) => ({ ...current, [payload.provider]: payload }));
      // Settled phases must overwrite the activity line too, or it keeps announcing "Starting
      // Claude..." long after Claude went live.
      if (payload.message) setActivity(payload.message);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    const request = () => void emitTo("widget", PROVIDER_LIFECYCLE_REQUEST_EVENT).catch(() => undefined);
    request();
    const retry = window.setTimeout(request, 600);
    return () => { disposed = true; unlisten?.(); window.clearTimeout(retry); };
  }, []);

  function handleChange(next: Settings) {
    setActivity(settingsActivityMessage(settings, next));
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
    setSavedAt(new Date());
  }

  function addAccount(kind: AccountKind, label: string) {
    const id = makeAccountId(kind, settings.accounts);
    const account: Account = {
      id,
      kind,
      label: normalizeAccountLabel(kind, label),
      url: ACCOUNT_DEFAULT_URL[kind],
      shown: true,
    };
    const next: Settings = { ...settings, aiUsageEnabled: true, accounts: [...settings.accounts, account] };
    syncAccountRegistry(next.accounts);
    handleChange(next);
    // Show the login window straight away so the user can sign this account in.
    setBusy(`${id}-open`);
    setActivity(`Opening ${account.label} login`);
    void openProvider(id, next)
      .then(() => providerSucceeded(id, `${account.label} login window opened`))
      .catch((error) => providerFailed(id, `${account.label} open failed: ${String(error)}`))
      .finally(() => setBusy(null));
  }

  // Called after the in-app confirm modal, so no native confirm() here.
  async function removeAccount(account: Account) {
    const id = account.id;
    setPendingRemove(null);
    setBusy(`${id}-close`);
    setActivity(`Removing ${account.label}`);
    localStorage.setItem(providerRemovingKey(id), String(Date.now()));
    try {
      await invoke("remove_provider_account", { provider: id });
    } catch (error) {
      providerFailed(id, `${account.label} remove failed: ${String(error)}`);
      localStorage.removeItem(providerRemovingKey(id));
      setBusy(null);
      return;
    }
    const currentSettings = settingsRef.current;
    const providerColors = { ...currentSettings.providerColors };
    delete providerColors[id];
    const next: Settings = { ...currentSettings, accounts: currentSettings.accounts.filter((a) => a.id !== id), providerColors };
    syncAccountRegistry(next.accounts);
    handleChange(next);
    localStorage.removeItem(`usageview.snapshot.${id}`);
    localStorage.removeItem(`usageview.providerTarget.${id}`);
    setSnapshots((current) => {
      const updated = { ...current };
      delete updated[id];
      return updated;
    });
    setCommandErrors((current) => { const c = { ...current }; delete c[id]; return c; });
    setDiscovery((current) => { const c = { ...current }; delete c[id]; return c; });
    setProviderLifecycles((current) => { const c = { ...current }; delete c[id]; return c; });
    delete refreshNonceRef.current[id];
    setActivity(`${account.label} removed`);
    // Distinct "removed" toast on the widget (Hide already shows "stopped"). Emit after settings
    // are committed; Rust's removal tombstone already prevents any stale lifecycle retry recreating it.
    void emitTo("widget", PROVIDER_REMOVED_EVENT, { id, label: account.label }).catch(() => undefined);
    // Keep the short-lived marker through the cross-WebView settings event. It expires automatically
    // after two minutes, while any refresh that was already in flight has finished.
    setBusy(null);
  }

  function renameAccount(id: Provider, label: string) {
    const account = settings.accounts.find((candidate) => candidate.id === id);
    if (!account || !label.trim()) return;
    const normalized = normalizeAccountLabel(account.kind, label);
    const next: Settings = { ...settings, accounts: settings.accounts.map((a) => (a.id === id ? { ...a, label: normalized } : a)) };
    syncAccountRegistry(next.accounts);
    handleChange(next);
    // The usage-block label comes from the registry inside a memoised component, so hand it fresh
    // snapshot refs to force a re-render with the new name (the widget already refreshes via storage).
    setSnapshots((current) => Object.fromEntries(Object.entries(current).map(([key, snap]) => [key, key === id ? { ...snap } : snap])));
    void invoke("set_provider_window_title", { provider: id, displayLabel: normalized }).catch(() => undefined);
  }

  function providerSucceeded(provider: Provider, text: string) {
    setCommandErrors((current) => { const next = { ...current }; delete next[provider]; return next; });
    setActivity(text);
  }

  function providerFailed(provider: Provider, text: string) {
    setCommandErrors((current) => ({ ...current, [provider]: text }));
  }

  async function openInApp(provider: Provider) {
    setBusy(`${provider}-open`);
    setActivity(`Opening ${providerLabel(provider)} login`);
    try { await openProvider(provider, settings); providerSucceeded(provider, `${providerLabel(provider)} login window opened`); }
    catch (error) { providerFailed(provider, `${providerLabel(provider)} open failed: ${String(error)}`); }
    setBusy(null);
  }
  async function closeInApp(provider: Provider) {
    setBusy(`${provider}-close`);
    setActivity(`Hiding ${providerLabel(provider)} window`);
    try { await closeProvider(provider); providerSucceeded(provider, `${providerLabel(provider)} window hidden`); }
    catch (error) { providerFailed(provider, `${providerLabel(provider)} close failed: ${String(error)}`); }
    setBusy(null);
  }
  async function reloadInApp(provider: Provider) {
    setBusy(`${provider}-reload`);
    setActivity(`Reloading ${providerLabel(provider)} page`);
    try { await refreshProviderPage(provider, providerUrl(provider, settings)); providerSucceeded(provider, `${providerLabel(provider)} usage page opened`); }
    catch (error) { providerFailed(provider, `${providerLabel(provider)} reload failed: ${String(error)}`); }
    setBusy(null);
  }
  async function findApi(provider: Provider) {
    setBusy(`${provider}-discover`);
    setActivity(`Inspecting ${providerLabel(provider)} API calls`);
    try {
      const result = await discoverProviderApi(provider, providerUrl(provider, settings));
      setDiscovery((current) => ({ ...current, [provider]: result }));
      providerSucceeded(provider, `${providerLabel(provider)} API inspection complete`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setDiscovery((current) => ({ ...current, [provider]: `Error: ${msg}` }));
      providerFailed(provider, `${providerLabel(provider)} API inspection failed: ${msg}`);
    }
    setBusy(null);
  }
  async function logoutInApp(provider: Provider) {
    setBusy(`${provider}-logout`);
    setActivity(`Signing out ${providerLabel(provider)}`);
    try { await logoutProvider(provider, providerUrl(provider, settings)); providerSucceeded(provider, `${providerLabel(provider)} signed out`); }
    catch (error) { providerFailed(provider, `${providerLabel(provider)} logout failed: ${String(error)}`); }
    setBusy(null);
  }
  // Refresh runs on the widget (single engine owner). A targeted result event drives the busy/message
  // state; saveSnapshot's storage write carries the actual snapshot back to this window.
  async function refresh(provider: Provider) {
    const nonce = newNonce();
    refreshNonceRef.current[provider] = nonce;
    setBusy(provider);
    setActivity(`Refreshing ${providerLabel(provider)} usage`);
    try {
      await emitTo("widget", "usageview-refresh-request", { nonce, provider } satisfies RefreshRequest);
    } catch {
      // Keep the localStorage path as a fallback for older/race-prone WebView event startup.
      postAppCommand({ nonce, type: "refresh", provider });
    }
  }

  const providerOrder = settings.accounts.map((account) => account.id);
  const providerPercents: Partial<Record<Provider, number>> = Object.fromEntries(
    settings.accounts.map((account) => [account.id, snapshotPercent(snapshotOf(snapshots, account.id))]),
  );
  const activeProviders = providerOrder.filter((provider) => providerEnabled(provider, settings));
  const commandErrorProviders = settings.aiUsageEnabled ? providerOrder.filter((provider) => commandErrors[provider]) : [];
  const snapshotErrorProviders = activeProviders.filter((provider) =>
    !lifecycleIsTransitioning(providerLifecycles[provider])
    && isProviderError(snapshotOf(snapshots, provider).status)
    && !commandErrors[provider],
  );
  const errorProviders = [...commandErrorProviders, ...snapshotErrorProviders];
  const errorCount = errorProviders.length;
  const firstErrorProvider = errorProviders[0];
  const firstError = firstErrorProvider
    ? commandErrors[firstErrorProvider] ?? `${providerLabel(firstErrorProvider)}: ${providerMessage(snapshotOf(snapshots, firstErrorProvider))}`
    : null;
  const hasProviderWarning = activeProviders.some((provider) => snapshotOf(snapshots, provider).status !== "ok");
  const lifecycleActivity = providerOrder
    .map((provider) => providerLifecycles[provider])
    .find((lifecycle) => lifecycle && lifecycle.phase !== "ready" && lifecycle.phase !== "stopped");
  const lifecycleError = lifecycleActivity?.phase === "error";
  const headerTone: SettingsHeaderTone = firstError ? "error" : lifecycleError ? "error" : busy !== null || hasProviderWarning || lifecycleActivity ? "warn" : "ok";
  const headerMessage = firstError
    ? `${firstError}${errorCount > 1 ? ` (+${errorCount - 1})` : ""}`
    : lifecycleActivity?.message ?? activity;
  const savedLabel = savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Auto-save on";

  return (
    <main className={`control-shell ${themeClass(settings.theme)} ${panelScopeClasses(settings)}`} style={panelStyle(settings)} onMouseDown={startWindowDrag}>
      <header className="titlebar settings-titlebar">
        <div className="settings-header-title"><strong>Settings</strong></div>
        <span className="settings-header-saved">{savedLabel}</span>
        <button className="window-control close settings-close" type="button" title="Close" aria-label="Close" onClick={() => void invoke("toggle_settings_window")}><CloseIcon /></button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`settings-nav-item${tab === t.id ? " is-active" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div ref={scrollRef} className="scale-shell">
          <WidgetSettings
            settings={settings}
            onChange={handleChange}
            activeTab={tab}
            widgetMode={widgetMode}
            onSetMode={setWidgetViewMode}
            onRefreshAll={refreshAllShown}
            widgetVisible={widgetVisible}
            widgetToggleBusy={widgetToggleBusy}
            onToggleWidget={() => void toggleWidgetVisibility()}
            monitorReadings={monitorReadings}
            statusTone={headerTone}
            statusMessage={headerMessage}
            accountPanels={
              <>
                {settings.accounts.map((account) => (
                  <ProviderPanel
                    key={account.id}
                    provider={account.id}
                    accent={providerAccent(account.id, settings)}
                    url={account.url}
                    developerMode={settings.developerMode}
                    snapshot={snapshotOf(snapshots, account.id)}
                    lifecycle={providerLifecycles[account.id]}
                    busy={busy}
                    onOpen={() => void openInApp(account.id)}
                    onReload={() => void reloadInApp(account.id)}
                    onClose={() => void closeInApp(account.id)}
                    onLogout={() => void logoutInApp(account.id)}
                    onDiscover={() => void findApi(account.id)}
                    discovery={discovery[account.id]}
                    onExtract={() => void refresh(account.id)}
                    onRetry={() => void emitTo("widget", PROVIDER_RETRY_EVENT, account.id)}
                    onUrlChange={(url) => handleChange({ ...settings, accounts: settings.accounts.map((a) => (a.id === account.id ? { ...a, url } : a)) })}
                    shownInWidget={account.shown}
                    onToggleShown={() => handleChange(setAccountShown(settings, account.id, !account.shown))}
                    onRemove={() => setPendingRemove(account)}
                    onRename={(label) => renameAccount(account.id, label)}
                  />
                ))}
                <button type="button" className="add-account-btn" onClick={() => setAddOpen(true)}>+ Add account</button>
              </>
            }
            onEffectPlay={(provider, from, to, driveBar) => postAppCommand({ nonce: newNonce(), type: "play", provider, from, to, driveBar })}
            onEffectRestore={() => postAppCommand({ nonce: newNonce(), type: "restore" })}
            onMonitorEffectPlay={(kind, value) => postAppCommand({ nonce: newNonce(), type: "play-monitor", kind, value })}
            onMonitorEffectRestore={() => postAppCommand({ nonce: newNonce(), type: "restore-monitor" })}
            providerPercents={providerPercents}
          />
        </div>
      </div>
      <OverlayScrollbar targetRef={scrollRef} />
      <Modal open={addOpen} onClose={() => setAddOpen(false)}>
        <AddAccountForm onAdd={(kind, label) => { addAccount(kind, label); setAddOpen(false); }} onCancel={() => setAddOpen(false)} />
      </Modal>
      <Modal open={pendingRemove !== null} onClose={() => setPendingRemove(null)}>
        {pendingRemove && (
          <div className="modal-confirm">
            <h2>Remove “{pendingRemove.label}”?</h2>
            <p>This signs it out and deletes its saved login on this PC.</p>
            <div className="daily-actions modal-actions">
              <button type="button" onClick={() => setPendingRemove(null)}>Cancel</button>
              <button type="button" className="account-remove" onClick={() => void removeAccount(pendingRemove)}>Remove</button>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}

function WidgetApp() {
  const widgetRef = useRef<HTMLElement | null>(null);
  const widgetHeaderRef = useRef<HTMLDivElement | null>(null);
  const providersRef = useRef<HTMLDivElement | null>(null);
  const compactProvidersRef = useRef<HTMLDivElement | null>(null);
  const compactPointerRef = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const contextActionHandlerRef = useRef<(action: string) => void>(() => undefined);
  const [mode, setMode] = useState<AppMode>(loadMode);
  const [timerModes, setTimerModes] = useState<Partial<Record<Provider, TimerOrigin>>>({});
  const [settings, setSettings] = useState(loadSettings);
  const [tileLayout, setTileLayout] = useState(loadTileLayout);
  const tileLayoutRef = useRef(tileLayout);
  const tileElementsRef = useRef<Partial<Record<TileId, HTMLDivElement | null>>>({});
  const tileDragRef = useRef<{ tileId: TileId; x: number; y: number; dragged: boolean } | null>(null);
  const suppressTileClickRef = useRef<TileId | null>(null);
  const [draggingTile, setDraggingTile] = useState<TileId | null>(null);
  const settingsRef = useRef(settings);
  const modeRef = useRef(mode);
  const webviewZoomRef = useRef<number | null>(null);
  const webviewZoomQueueRef = useRef<Promise<void>>(Promise.resolve());
  const windowSizeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const windowSizeGenerationRef = useRef(0);
  const initialPositionRestoredRef = useRef(false);
  const initialLayoutCommittedRef = useRef(false);
  const initialRevealDoneRef = useRef(false);
  function setWidgetWebviewZoom(target: number) {
    const operation = webviewZoomQueueRef.current.catch(() => undefined).then(async () => {
      if (webviewZoomRef.current === target) return;
      await getCurrentWebview().setZoom(target);
      webviewZoomRef.current = target;
    });
    webviewZoomQueueRef.current = operation.catch(() => undefined);
    return operation;
  }
  // Don't persist auto-fit resize events until recoverVisibleWindow has applied the saved position,
  // otherwise startup work could overwrite it with the tauri.conf.json fallback corner.
  const hasRestoredGeometryRef = useRef(false);
  const [snapshots, setSnapshots] = useState<Record<Provider, UsageSnapshot>>(() => snapshotsForAccounts(settings.accounts));
  const snapshotsRef = useRef(snapshots);
  const refreshInFlightRef = useRef<Partial<Record<Provider, { operation: Promise<UsageSnapshot>; generation: number }>>>({});
  const [providerLifecycles, setProviderLifecycles] = useState<Record<Provider, ProviderLifecycle>>(() =>
    Object.fromEntries(settings.accounts.map((account) => [
      account.id,
      { provider: account.id, phase: providerEnabled(account.id, settings) ? "starting" : "stopped", generation: 0 } satisfies ProviderLifecycle,
    ])),
  );
  const providerLifecycleRef = useRef(providerLifecycles);
  const providerGenerationRef = useRef<Record<Provider, number>>(Object.fromEntries(settings.accounts.map((account) => [account.id, 0])));
  const providerDesiredRef = useRef<Partial<Record<Provider, boolean>>>({});
  const knownAccountIdsRef = useRef(new Set(settings.accounts.map((account) => account.id)));
  const removedAccountIdsRef = useRef(new Set<Provider>());
  const [providerNotices, setProviderNotices] = useState<Partial<Record<Provider, ProviderLifecycle>>>({});
  const providerNoticeTimersRef = useRef<Partial<Record<Provider, number>>>({});
  const [monitorToasts, setMonitorToasts] = useState<MonitorToast[]>([]);
  const monitorToastSequenceRef = useRef(0);
  const monitorToastTimersRef = useRef<Record<number, number>>({});
  const monitorToastTextsRef = useRef(new Set<string>());
  const initialMonitorToastsDoneRef = useRef(false);
  const widgetDisposedRef = useRef(false);

  function pushMonitorToast(text: string, tone: string) {
    if (monitorToastTextsRef.current.has(text)) return;
    monitorToastTextsRef.current.add(text);
    const id = ++monitorToastSequenceRef.current;
    setMonitorToasts((current) => [...current, { id, text, tone }]);
    monitorToastTimersRef.current[id] = window.setTimeout(() => {
      setMonitorToasts((current) => current.filter((toast) => toast.id !== id));
      monitorToastTextsRef.current.delete(text);
      delete monitorToastTimersRef.current[id];
    }, 2500);
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ label: string; shown: boolean }>("usageview-monitor-toast", ({ payload }) => {
      pushMonitorToast(`${payload.label} ${payload.shown ? "shown" : "hidden"}`, payload.shown ? "ok" : "warn");
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const lastLimitedAutoRefreshRef = useRef<Record<Provider, number>>(Object.fromEntries(settings.accounts.map((account) => [account.id, 0])));
  const prevFlashTokenRef = useRef<Partial<Record<Provider, string>>>({});
  const prevEffectPercentRef = useRef<Partial<Record<Provider, number>>>({});
  const prevEffectPeriodRef = useRef<Partial<Record<Provider, "main" | "weekly">>>({});
  const previousLimitRef = useRef<Partial<Record<Provider, boolean>>>({});
  const runtimeValidReadRef = useRef<Partial<Record<Provider, boolean>>>({});
  const lastFreshAtRef = useRef<Partial<Record<Provider, string>>>({});
  const runtimePayloadRef = useRef<Partial<Record<TileId, DetachedRuntimeState>>>({});
  const flashTimersRef = useRef<Partial<Record<Provider, number>>>({});
  const effectTimersRef = useRef<Partial<Record<Provider, number>>>({});
  const monitorTestTimerRef = useRef(0);
  const lastCmdNonceRef = useRef<string | null>(null);
  const [flashSet, setFlashSet] = useState<Set<Provider>>(new Set());
  const [activeEffects, setActiveEffects] = useState<Partial<Record<Provider, UsageEffect>>>({});
  const [monitorEffectTest, setMonitorEffectTest] = useState<MonitorEffectTest | null>(null);
  const [, setAgoTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [monitorReadings, setMonitorReadings] = useState<Record<MonitorKind, MonitorReading>>(() => buildMonitorReadings(null));
  const monitorReadingsForRender = useMemo(() => {
    if (!monitorEffectTest) return monitorReadings;
    return {
      ...monitorReadings,
      [monitorEffectTest.kind]: monitorTestReading(
        monitorReadings[monitorEffectTest.kind],
        monitorEffectTest.kind,
        monitorEffectTest.value,
        monitorEffectTest.nonce,
      ),
    };
  }, [monitorReadings, monitorEffectTest]);

  useEffect(() => () => window.clearTimeout(monitorTestTimerRef.current), []);

  function updateSettings(next: Settings) {
    setSettings(next);
    saveSettings(next);
  }

  function commitTileLayout(next: TileLayout | ((current: TileLayout) => TileLayout)) {
    setTileLayout((current) => {
      const resolved = normalizeTileLayout(typeof next === "function" ? next(current) : next);
      tileLayoutRef.current = resolved;
      saveTileLayout(resolved);
      return resolved;
    });
  }

  // Keep the persisted order aligned with the dynamic account registry: append new account tiles and
  // remove dead entries so a long Add/Remove session does not accumulate stale layout state.
  useEffect(() => {
    const validProviders = new Set(settings.accounts.map((account) => providerTileId(account.id)));
    const current = tileLayoutRef.current;
    const order = current.order.filter((tileId) => !providerFromTile(tileId) || validProviders.has(tileId));
    const known = new Set(order);
    for (const tileId of validProviders) {
      if (!known.has(tileId)) order.push(tileId);
    }
    const detached = { ...current.detached };
    const removedDetached = (Object.keys(detached) as TileId[]).filter((tileId) => Boolean(providerFromTile(tileId)) && !validProviders.has(tileId));
    removedDetached.forEach((tileId) => delete detached[tileId]);
    if (order.length !== current.order.length || order.some((tileId, index) => current.order[index] !== tileId) || removedDetached.length) {
      commitTileLayout({ ...current, order, detached });
      removedDetached.forEach((tileId) => { void invoke("close_detached_tile", { tileId }).catch(() => undefined); });
    }
  }, [settings.accounts]);

  function activateUsageEffects(effectPayloads: Partial<Record<Provider, UsageEffect>>) {
    if (!settingsRef.current.effectsEnabled) return;
    const effectProviders = Object.keys(effectPayloads) as Provider[];
    if (!effectProviders.length) return;

    for (const provider of effectProviders) {
      const existingTimer = effectTimersRef.current[provider];
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    }

    setActiveEffects((prev) => ({ ...prev, ...effectPayloads }));
    for (const provider of effectProviders) {
      const effect = effectPayloads[provider];
      const duration = themeStyle(settingsRef.current.theme) === "glass" || !effect
        ? EFFECT_DURATION_MS + 900
        : pixelInsertTiming(effect).durationMs + 100;
      effectTimersRef.current[provider] = window.setTimeout(() => {
        setActiveEffects((prev) => {
          const next = { ...prev };
          delete next[provider];
          return next;
        });
        delete effectTimersRef.current[provider];
      }, duration);
    }
  }

  function triggerManualReplay(provider: Provider, snapshot: UsageSnapshot) {
    const percent = snapshotPercent(snapshot);
    if (!flashToken(snapshot) || typeof percent !== "number" || percent <= 0) {
      return;
    }
    prevEffectPercentRef.current[provider] = percent;
    runtimeValidReadRef.current[provider] = true;
    activateUsageEffects({ [provider]: makeUsageEffect(0, percent) });
  }

  // Effect tester (Settings > Usage effect): self-drive the status-line effect without waiting for real
  // usage to move. Play/Step/preset only fire the visual overlay (auto-refresh keeps reading real usage);
  // "drive bar too" additionally fakes the tile percent so the underlying cells match — it is overwritten
  // by the next real read (or immediately by Restore).
  function playTestEffect(provider: Provider, from: number, to: number, driveBar: boolean) {
    const clampP = (v: number) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const f = clampP(from);
    const t = clampP(to);
    if (driveBar) {
      const base = snapshotOf(snapshotsRef.current, provider);
      const synthetic: UsageSnapshot = { ...base, provider, status: "ok", percentUsed: t, updatedAt: base.updatedAt };
      // Neutralize the auto-trigger for this synthetic write so our from->to wins (no double-fire).
      prevFlashTokenRef.current[provider] = flashToken(synthetic);
      prevEffectPercentRef.current[provider] = t;
      runtimeValidReadRef.current[provider] = true;
      setSnapshots((current) => ({ ...current, [provider]: synthetic }));
    }
    if (t <= f) {
      const timer = effectTimersRef.current[provider];
      if (timer !== undefined) window.clearTimeout(timer);
      delete effectTimersRef.current[provider];
      setActiveEffects((current) => {
        const next = { ...current };
        delete next[provider];
        return next;
      });
      return;
    }
    activateUsageEffects({ [provider]: makeUsageEffect(f, t) });
  }

  async function restoreTestEffect() {
    for (const timer of Object.values(effectTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    effectTimersRef.current = {};
    setActiveEffects({});
    const providers = accountIdsFrom(settingsRef.current).filter((p) =>
      providerEnabled(p, settingsRef.current) && lifecycleShowsTile(providerLifecycleRef.current[p]),
    );
    const results = await Promise.all(providers.map((p) => guardedRefresh(p, providerUrl(p, settingsRef.current), true)));
    const currentResults = results.filter((snapshot) =>
      settingsRef.current.accounts.some((account) => account.id === snapshot.provider)
      && !providerRemovalPending(snapshot.provider),
    );
    setSnapshots((current) => currentResults.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), current));
  }

  function restoreMonitorTestEffect() {
    window.clearTimeout(monitorTestTimerRef.current);
    monitorTestTimerRef.current = 0;
    setMonitorEffectTest(null);
  }

  function playMonitorTestEffect(kind: MonitorKind, value: number, nonce: string) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    window.clearTimeout(monitorTestTimerRef.current);
    setMonitorEffectTest({ kind, value: clamped, nonce });
    monitorTestTimerRef.current = window.setTimeout(restoreMonitorTestEffect, MONITOR_TEST_DURATION_MS);
  }

  useEffect(() => {
    if (!monitorEffectTest) return;
    if (!settings.effectsEnabled || !settings.systemMonitorsEnabled || !settings[MONITOR_SHOW_KEY[monitorEffectTest.kind]]) {
      restoreMonitorTestEffect();
    }
  }, [settings, monitorEffectTest]);

  async function resetWindowPosition() {
    windowGeometryResetGeneration += 1;
    localStorage.removeItem(GEOMETRY_KEY);
    localStorage.removeItem(LEGACY_GEOMETRY_KEY);
    windowGeometryCache = {};
    const resetLayout = normalizeTileLayout(undefined);
    tileLayoutRef.current = resetLayout;
    setTileLayout(resetLayout);
    saveTileLayout(resetLayout);
    await invoke("close_all_detached_tiles").catch(() => undefined);
    await invoke("reset_window_geometry").catch(() => undefined);
    await recoverVisibleWindow(modeRef.current, settingsRef.current.corner, settingsRef.current.uiScale);
  }

  async function revealInitialWidget() {
    if (initialRevealDoneRef.current || !initialPositionRestoredRef.current || !initialLayoutCommittedRef.current) return;
    initialRevealDoneRef.current = true;
    await invoke("open_widget_window").catch(() => undefined);
    if (widgetDisposedRef.current) return;
    if (initialMonitorToastsDoneRef.current) return;
    initialMonitorToastsDoneRef.current = true;
    const current = settingsRef.current;
    if (!current.systemMonitorsEnabled) return;
    for (const kind of MONITOR_ORDER) {
      if (current[MONITOR_SHOW_KEY[kind]]) pushMonitorToast(`${MONITOR_LABELS[kind]} shown`, "ok");
    }
  }

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Keep the display registry and the snapshot map in step with the account list: a rename must show
  // immediately, and a freshly added account needs a snapshot entry before its tile renders.
  useEffect(() => {
    const nextIds = new Set(settings.accounts.map((account) => account.id));
    for (const provider of knownAccountIdsRef.current) {
      if (!nextIds.has(provider)) invalidateRemovedProvider(provider);
    }
    knownAccountIdsRef.current = nextIds;
    syncAccountRegistry(settings.accounts);
    setSnapshots((current) => {
      const next: Record<Provider, UsageSnapshot> = {};
      for (const account of settings.accounts) next[account.id] = current[account.id] ?? loadSnapshot(account.id);
      return next;
    });
  }, [settings.accounts]);

  function publishProviderLifecycle(next: ProviderLifecycle) {
    if (removedAccountIdsRef.current.has(next.provider) && next.phase !== "stopped") return;
    providerLifecycleRef.current = { ...providerLifecycleRef.current, [next.provider]: next };
    setProviderLifecycles(providerLifecycleRef.current);
    setProviderNotices((current) => ({ ...current, [next.provider]: next }));
    const existingTimer = providerNoticeTimersRef.current[next.provider];
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    // ready/stopped are the "done" states — dismiss quickly. retrying/error/login-needed can otherwise sit
    // on screen forever (a slow/stuck provider never reaches ready), covering the widget, so they self-clear
    // ~5s after the LAST update — an active retry keeps refreshing this timer, so the toast stays only while
    // things are genuinely moving. starting/stopping/waiting-close keep no timer (short, or user-driven).
    const dismissMs =
      next.phase === "ready" || next.phase === "stopped" ? 1800
      : next.phase === "retrying" || next.phase === "error" || next.phase === "login-needed" ? 5000
      : undefined;
    if (dismissMs !== undefined) {
      providerNoticeTimersRef.current[next.provider] = window.setTimeout(() => {
        setProviderNotices((current) => {
          const updated = { ...current };
          delete updated[next.provider];
          return updated;
        });
        if (removedAccountIdsRef.current.has(next.provider)) {
          const lifecycles = { ...providerLifecycleRef.current };
          delete lifecycles[next.provider];
          providerLifecycleRef.current = lifecycles;
          setProviderLifecycles(lifecycles);
        }
        delete providerNoticeTimersRef.current[next.provider];
      }, dismissMs);
    }
    void emitTo("settings", PROVIDER_LIFECYCLE_EVENT, next).catch(() => undefined);
  }

  function invalidateRemovedProvider(provider: Provider): number {
    if (removedAccountIdsRef.current.has(provider)) return providerGenerationRef.current[provider] ?? 0;
    removedAccountIdsRef.current.add(provider);
    providerDesiredRef.current[provider] = false;
    const generation = (providerGenerationRef.current[provider] ?? 0) + 1;
    providerGenerationRef.current[provider] = generation;

    for (const timers of [flashTimersRef, effectTimersRef, providerNoticeTimersRef]) {
      const timer = timers.current[provider];
      if (timer !== undefined) window.clearTimeout(timer);
      delete timers.current[provider];
    }
    setTimerModes((current) => { const next = { ...current }; delete next[provider]; return next; });
    setFlashSet((current) => { const next = new Set(current); next.delete(provider); return next; });
    setActiveEffects((current) => { const next = { ...current }; delete next[provider]; return next; });
    setProviderNotices((current) => { const next = { ...current }; delete next[provider]; return next; });

    for (const values of [lastLimitedAutoRefreshRef, prevFlashTokenRef, prevEffectPercentRef, prevEffectPeriodRef, runtimeValidReadRef, lastFreshAtRef]) {
      delete values.current[provider];
    }
    delete previousLimitRef.current[provider];
    return generation;
  }

  const lifecycleCurrent = (provider: Provider, generation: number) =>
    providerGenerationRef.current[provider] === generation && providerDesiredRef.current[provider] === true;

  // `set_provider_enabled` answers `false` for a generation Rust has already moved past — that is a
  // normal outcome of rapid toggling and the newer generation owns the phase, so stay quiet. A
  // rejected invoke is different: nobody else will publish, so surface it instead of leaving the UI
  // stuck on STARTING/STOPPING forever.
  async function claimProviderGeneration(provider: Provider, enabled: boolean, generation: number): Promise<boolean> {
    try {
      return await invoke<boolean>("set_provider_enabled", { provider, enabled, generation });
    } catch (error) {
      if (providerGenerationRef.current[provider] === generation) {
        publishProviderLifecycle({
          provider,
          phase: "error",
          generation,
          message: `${providerLabel(provider)} could not ${enabled ? "start" : "stop"}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return false;
    }
  }

  async function startProviderLifecycle(provider: Provider, generation: number) {
    publishProviderLifecycle({ provider, phase: "starting", generation, attempt: 1, message: `Starting ${providerLabel(provider)}...` });
    if (!await claimProviderGeneration(provider, true, generation)) return;
    if (!lifecycleCurrent(provider, generation)) return;

    await settleProviderRefresh(provider, generation);

    let lastSnapshot: UsageSnapshot | undefined;
    for (let attempt = 1; attempt <= PROVIDER_START_ATTEMPTS; attempt += 1) {
      if (!lifecycleCurrent(provider, generation)) return;
      if (attempt > 1) {
        publishProviderLifecycle({
          provider,
          phase: "retrying",
          generation,
          attempt,
          message: `${providerLabel(provider)} is warming up (${attempt}/${PROVIDER_START_ATTEMPTS})...`,
        });
        await wait(450 * attempt);
      }
      if (!lifecycleCurrent(provider, generation)) return;

      const shouldCommit: SnapshotCommitGuard = (snapshot) =>
        lifecycleCurrent(provider, generation)
        && ((snapshot.status === "ok" && !isStale(snapshot)) || snapshot.status === "not_open" || snapshot.status === "not_logged_in");
      const snapshot = await guardedRefresh(provider, providerUrl(provider, settingsRef.current), true, shouldCommit, generation);
      lastSnapshot = snapshot;
      if (!lifecycleCurrent(provider, generation)) return;

      if (snapshot.status === "ok" && !isStale(snapshot)) {
        setSnapshots((current) => ({ ...current, [provider]: snapshot }));
        setLastUpdated(new Date());
        publishProviderLifecycle({ provider, phase: "ready", generation, message: `${providerLabel(provider)} ready` });
        return;
      }
      if (snapshot.status === "not_open" || snapshot.status === "not_logged_in") {
        setSnapshots((current) => ({ ...current, [provider]: snapshot }));
        publishProviderLifecycle({ provider, phase: "login-needed", generation, message: `${providerLabel(provider)} needs login` });
        return;
      }
    }

    if (lifecycleCurrent(provider, generation)) {
      publishProviderLifecycle({
        provider,
        phase: "error",
        generation,
        message: `${providerLabel(provider)} could not start${lastSnapshot?.message ? `: ${lastSnapshot.message}` : ""}`,
      });
    }
  }

  const stopIsCurrent = (provider: Provider, generation: number) =>
    providerGenerationRef.current[provider] === generation && providerDesiredRef.current[provider] === false;

  async function stopProviderLifecycle(provider: Provider, generation: number) {
    publishProviderLifecycle({ provider, phase: "stopping", generation, message: `Stopping ${providerLabel(provider)}...` });
    if (!await claimProviderGeneration(provider, false, generation)) return;
    if (!stopIsCurrent(provider, generation)) return;

    await settleProviderRefresh(provider, generation);
    if (!stopIsCurrent(provider, generation)) return;

    let lastError: unknown;
    let announcedStopped = false;
    for (let sweep = 0; sweep < PROVIDER_RELEASE_SWEEPS; sweep += 1) {
      if (!stopIsCurrent(provider, generation)) return;
      try {
        const outcome = await invoke<ReleaseOutcome>("release_provider_window_command", { provider, generation });
        if (!stopIsCurrent(provider, generation)) return;
        if (outcome === "superseded") return;
        if (outcome === "released") {
          publishProviderLifecycle({ provider, phase: "stopped", generation, message: `${providerLabel(provider)} stopped` });
          return;
        }
        if (outcome === "visible") {
          publishProviderLifecycle({ provider, phase: "waiting-close", generation, message: `Close ${providerLabel(provider)} window to finish stopping` });
          return;
        }
        // absent: nothing exists to destroy. The provider is already off as far as the user is
        // concerned, so say so once, then keep watching in case Tauri is still building the
        // predeclared window underneath us.
        if (!announcedStopped) {
          publishProviderLifecycle({ provider, phase: "stopped", generation, message: `${providerLabel(provider)} stopped` });
          announcedStopped = true;
        }
        await wait(PROVIDER_RELEASE_SWEEP_MS);
      } catch (error) {
        lastError = error;
        await wait(PROVIDER_RELEASE_SWEEP_MS);
      }
    }
    if (lastError && !announcedStopped && stopIsCurrent(provider, generation)) {
      publishProviderLifecycle({
        provider,
        phase: "error",
        generation,
        message: `${providerLabel(provider)} could not stop: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      });
    }
  }

  useEffect(() => {
    for (const provider of accountIdsFrom(settings)) {
      const desired = providerEnabled(provider, settings);
      if (providerDesiredRef.current[provider] === desired) continue;
      providerDesiredRef.current[provider] = desired;
      const generation = (providerGenerationRef.current[provider] ?? 0) + 1;
      providerGenerationRef.current[provider] = generation;
      if (desired) void startProviderLifecycle(provider, generation);
      else void stopProviderLifecycle(provider, generation);
    }
  }, [settings.aiUsageEnabled, settings.accounts]);

  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    const keep = (dispose: () => void) => { if (disposed) dispose(); else disposers.push(dispose); };
    void listen<string>(PROVIDER_RELEASED_EVENT, ({ payload: label }) => {
      const provider = providerForLabel(label);
      if (!provider || removedAccountIdsRef.current.has(provider) || providerDesiredRef.current[provider] !== false) return;
      const generation = providerGenerationRef.current[provider];
      publishProviderLifecycle({ provider, phase: "stopped", generation, message: `${providerLabel(provider)} stopped` });
    }).then(keep);
    void listen<{ id: string; label: string }>(PROVIDER_REMOVED_EVENT, ({ payload }) => {
      if (!payload?.id) return;
      const generation = invalidateRemovedProvider(payload.id);
      publishProviderLifecycle({ provider: payload.id, phase: "stopped", generation, message: `${payload.label} removed` });
    }).then(keep);
    void listen(PROVIDER_LIFECYCLE_REQUEST_EVENT, () => {
      for (const lifecycle of Object.values(providerLifecycleRef.current)) {
        void emitTo("settings", PROVIDER_LIFECYCLE_EVENT, lifecycle).catch(() => undefined);
      }
    }).then(keep);
    void listen<Provider>(PROVIDER_RETRY_EVENT, ({ payload: provider }) => {
      if (!provider || !settingsRef.current.accounts.some((account) => account.id === provider) || providerDesiredRef.current[provider] !== true) return;
      const generation = (providerGenerationRef.current[provider] ?? 0) + 1;
      providerGenerationRef.current[provider] = generation;
      void startProviderLifecycle(provider, generation);
    }).then(keep);
    return () => { disposed = true; disposers.forEach((dispose) => dispose()); };
  }, []);

  useEffect(() => {
    // Provider windows are created on demand and already start on WebView2's low-memory target
    // (get_or_create_provider_window sets it), so only the Settings renderer needs nudging here.
    const id = window.setTimeout(() => {
      void invoke("set_webview_memory_target_command", { label: "settings", low: true }).catch(() => undefined);
      // Sweep profiles left behind by an account whose delete-time cleanup lost the WebView2 lock race.
      void invoke("prune_provider_profiles", { keep: accountIdsFrom(settingsRef.current) }).catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    tileLayoutRef.current = tileLayout;
  }, [tileLayout]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("usageview-context-action", ({ payload }) => contextActionHandlerRef.current(payload))
      .then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    modeRef.current = mode;
    void invoke("set_widget_mode", { mode }).catch(() => undefined);
  }, [mode]);

  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop);
  }, [settings.alwaysOnTop]);

  useEffect(() => {
    // Restore position while the widget remains hidden. The layout effect reveals it after the first
    // measured size is locked, avoiding a visible fallback-height frame on cold launch.
    void recoverVisibleWindow(mode, settings.corner, settings.uiScale, false).finally(() => {
      hasRestoredGeometryRef.current = true;
      initialPositionRestoredRef.current = true;
      void revealInitialWidget();
    });
  }, []);

  useEffect(() => {
    saveMode(mode);
  }, [mode]);


  useEffect(() => {
    const appWindow = getCurrentWindow();
    let animationFrame = 0;
    let disposed = false;
    let layoutReady = false;
    ++windowSizeGenerationRef.current;
    void appWindow.setResizable(false).catch(() => undefined);

    // One queue survives effect recreation. A generation check after every native await prevents an
    // old provider-count/layout request from re-locking the window after a newer request has arrived.
    function applyLockedSize(width: number, height: number) {
      const target = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
      const requestGeneration = ++windowSizeGenerationRef.current;
      windowSizeQueueRef.current = windowSizeQueueRef.current.catch(() => undefined).then(async () => {
        const isCurrent = () => !disposed && requestGeneration === windowSizeGenerationRef.current;
        if (!isCurrent()) return;
        await appWindow.setMinSize(null).catch(() => undefined);
        await appWindow.setMaxSize(null).catch(() => undefined);
        if (!isCurrent()) return;
        await appWindow.setSize(new LogicalSize(target.width, target.height)).catch(() => undefined);
        if (!isCurrent()) return;
        await appWindow.setMinSize(new LogicalSize(target.width, target.height)).catch(() => undefined);
        if (!isCurrent()) return;
        await appWindow.setMaxSize(new LogicalSize(target.width, target.height)).catch(() => undefined);
        if (isCurrent()) {
          initialLayoutCommittedRef.current = true;
          void revealInitialWidget();
        }
      }).catch(() => undefined);
    }

    function scheduleLayout(measure: () => void) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        if (!layoutReady || disposed) return;
        measure();
      });
    }

    if (mode === "mini") {
      function updateCompactLayout() {
        scheduleLayout(() => {
          const providers = compactProvidersRef.current;
          const panel = providers?.closest<HTMLElement>(".compact-widget");
          if (!providers || !panel) return;
          const style = window.getComputedStyle(panel);
          const chromeHeight =
            (Number.parseFloat(style.paddingTop) || 0) +
            (Number.parseFloat(style.paddingBottom) || 0) +
            (Number.parseFloat(style.borderTopWidth) || 0) +
            (Number.parseFloat(style.borderBottomWidth) || 0);
          const height = Math.max(MINI_MIN_HEIGHT_FALLBACK, Math.ceil(providers.getBoundingClientRect().height + chromeHeight));
          applyLockedSize(MINI_LOCK_WIDTH, height);
        });
      }

      const observer = new ResizeObserver(updateCompactLayout);
      if (compactProvidersRef.current) observer.observe(compactProvidersRef.current);
      void (async () => {
        await appWindow.setMinSize(null).catch(() => undefined);
        await appWindow.setMaxSize(null).catch(() => undefined);
        await setWidgetWebviewZoom(1).catch(() => undefined);
        if (disposed) return;
        layoutReady = true;
        updateCompactLayout();
      })();

      return () => {
        disposed = true;
        window.cancelAnimationFrame(animationFrame);
        observer.disconnect();
      };
    }

    const fullScale = settings.uiScale;
    function updateFullLayout() {
      scheduleLayout(() => {
        const widget = widgetRef.current;
        const header = widgetHeaderRef.current;
        const providers = providersRef.current;
        if (!widget || !header || !providers) return;

        const widgetStyle = window.getComputedStyle(widget);
        const borderHeight = (Number.parseFloat(widgetStyle.borderTopWidth) || 0) + (Number.parseFloat(widgetStyle.borderBottomWidth) || 0);
        const boxesMin = Math.ceil(header.getBoundingClientRect().height + providers.getBoundingClientRect().height + borderHeight);
        const contentH = Math.max(96, boxesMin);
        applyLockedSize(WIDGET_BASE_WIDTH * fullScale, contentH * fullScale);
      });
    }

    const observer = new ResizeObserver(updateFullLayout);
    if (widgetHeaderRef.current) observer.observe(widgetHeaderRef.current);
    if (providersRef.current) observer.observe(providersRef.current);
    void (async () => {
      await appWindow.setMinSize(null).catch(() => undefined);
      await appWindow.setMaxSize(null).catch(() => undefined);
      await setWidgetWebviewZoom(fullScale).catch(() => undefined);
      if (disposed) return;
      layoutReady = true;
      updateFullLayout();
    })();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [mode, settings.uiScale]);

  async function saveCurrentPositionNow(targetMode = modeRef.current) {
    // Never persist before the saved geometry has been restored, or a startup resize event would
    // overwrite the remembered position with the initial default one.
    if (!hasRestoredGeometryRef.current) return;
    try {
      saveWindowGeometry(targetMode, await readCurrentPosition());
    } catch {
      // Best-effort persistence; close/hide should never fail because geometry couldn't be read.
    }
  }

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let saveTimer: number | undefined;
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let disposed = false;

    function flushSave() {
      window.clearTimeout(saveTimer);
      if (!disposed) void saveCurrentPositionNow(modeRef.current);
    }

    function scheduleSave() {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        if (!disposed) await saveCurrentPositionNow(modeRef.current);
      }, 250);
    }

    function saveWhenHidden() {
      if (document.visibilityState === "hidden") flushSave();
    }

    void Promise.all([
      appWindow.onResized(scheduleSave),
      appWindow.onMoved(scheduleSave),
    ]).then(([resizeUnlisten, moveUnlisten]) => {
      unlistenResize = resizeUnlisten;
      unlistenMove = moveUnlisten;
    });

    document.addEventListener("visibilitychange", saveWhenHidden);
    window.addEventListener("pagehide", flushSave);
    window.addEventListener("beforeunload", flushSave);

    return () => {
      flushSave();
      disposed = true;
      window.clearTimeout(saveTimer);
      document.removeEventListener("visibilitychange", saveWhenHidden);
      window.removeEventListener("pagehide", flushSave);
      window.removeEventListener("beforeunload", flushSave);
      unlistenResize?.();
      unlistenMove?.();
    };
  }, []);

  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  useEffect(() => {
    void invoke("update_tray_tooltip", { text: trayTooltipText(snapshots, settings, monitorReadings) }).catch(() => undefined);
  }, [snapshots, settings, monitorReadings]);

  useEffect(() => {
    return () => {
      widgetDisposedRef.current = true;
      for (const timer of Object.values(flashTimersRef.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
      for (const timer of Object.values(effectTimersRef.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
      for (const timer of Object.values(providerNoticeTimersRef.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
      for (const timer of Object.values(monitorToastTimersRef.current)) window.clearTimeout(timer);
      monitorToastTextsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (settings.effectsEnabled) return;
    for (const timer of Object.values(effectTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    effectTimersRef.current = {};
    setActiveEffects({});
  }, [settings.effectsEnabled]);

  useLayoutEffect(() => {
    for (const timer of Object.values(effectTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    effectTimersRef.current = {};
    setActiveEffects({});
  }, [settings.theme]);

  useEffect(() => {
    if (settings.aiUsageEnabled) return;
    for (const timer of Object.values(flashTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    for (const timer of Object.values(effectTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    flashTimersRef.current = {};
    effectTimersRef.current = {};
    setFlashSet(new Set());
    setActiveEffects({});
  }, [settings.aiUsageEnabled]);

  useEffect(() => {
    const effectPayloads: Partial<Record<Provider, UsageEffect>> = {};
    for (const provider of accountIdsFrom(settingsRef.current)) {
      const percent = snapshotPercent(snapshotOf(snapshotsRef.current, provider));
      if (typeof percent !== "number") continue;
      prevEffectPercentRef.current[provider] = percent;
      runtimeValidReadRef.current[provider] = true;
      if (percent > 0) effectPayloads[provider] = makeUsageEffect(0, percent);
    }
    activateUsageEffects(effectPayloads);
  }, []);


  // Record the timestamp of the last GENUINE valid read per provider (a non-empty flashToken).
  // Retained Claude snapshots bump updatedAt but have an empty flashToken, so this stays put and
  // "updated ago" reflects real freshness instead of the retain time.
  useEffect(() => {
    for (const p of accountIdsFrom(settingsRef.current)) {
      const snap = snapshotOf(snapshots, p);
      if (flashToken(snap)) lastFreshAtRef.current[p] = snap.updatedAt;
    }
  }, [snapshots]);

  // Re-render every 30s so the "updated ago" labels stay current between refreshes. Only the AI
  // tiles carry those labels, so with AI usage off this ticker would re-render the tree for nothing.
  useEffect(() => {
    if (!settings.aiUsageEnabled) return;
    const id = window.setInterval(() => setAgoTick((tick) => tick + 1), 30000);
    return () => window.clearInterval(id);
  }, [settings.aiUsageEnabled]);

  useEffect(() => {
    function reloadLocal() {
      const next = loadSettings();
      setSettings(next);
      // Rebuild from the live account list — the old fixed-three reset wiped every added account's
      // snapshot on any settings/storage change, which is why new tiles flickered/blanked.
      setSnapshots(snapshotsForAccounts(next.accounts));
      setLastUpdated(new Date());
    }
    window.addEventListener("storage", reloadLocal);
    window.addEventListener("usageview:settings", reloadLocal);
    return () => {
      window.removeEventListener("storage", reloadLocal);
      window.removeEventListener("usageview:settings", reloadLocal);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshOpenProviders(force = false) {
      const now = Date.now();
      const currentSnapshots = snapshotsRef.current;
      const providers: Provider[] = accountIdsFrom(settings)
        .filter((provider) => providerEnabled(provider, settings) && lifecycleShowsTile(providerLifecycleRef.current[provider]))
        .filter((provider) =>
        force || shouldAutoRefreshProvider(provider, snapshotOf(currentSnapshots, provider), now, lastLimitedAutoRefreshRef.current)
      );
      if (!providers.length) return;

      for (const provider of providers) {
        if (isProviderLimited(provider, snapshotOf(currentSnapshots, provider)) && snapshotResetMs(snapshotOf(currentSnapshots, provider)) === null) {
          lastLimitedAutoRefreshRef.current[provider] = now;
        }
      }

      const results = await Promise.all(
        providers.map((provider) => guardedRefresh(provider, providerUrl(provider, settings), true)),
      );
      if (!cancelled) {
        const currentResults = results.filter((snapshot) =>
          settingsRef.current.accounts.some((account) => account.id === snapshot.provider)
          && !providerRemovalPending(snapshot.provider),
        );
        setSnapshots((current) => currentResults.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), current));
        setLastUpdated(new Date());
      }
    }
    // First read after Show ON belongs to the lifecycle controller above. This interval only handles
    // providers that are already ready, so it cannot race a destroy/recreate transition.
    const interval = window.setInterval(refreshOpenProviders, Math.max(10, settings.refreshIntervalSec) * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [settings.aiUsageEnabled, settings.accounts, settings.refreshIntervalSec]);

  const shown = useMemo(() => {
    return accountIdsFrom(settings).filter((provider) => providerEnabled(provider, settings));
  }, [settings.aiUsageEnabled, settings.accounts]);
  const providerLifecyclePending = shown.some((provider) => !lifecycleShowsTile(providerLifecycles[provider]));

  const shownMonitors = useMemo(
    () => settings.systemMonitorsEnabled ? MONITOR_ORDER.filter((kind) => settings[MONITOR_SHOW_KEY[kind]] as boolean) : [],
    [settings.systemMonitorsEnabled, settings.showCpu, settings.showRam, settings.showGpu, settings.showIgpu, settings.showCpuTemp, settings.showGpuTemp],
  );

  function runtimeTileActive(tileId: TileId, currentSettings: Settings) {
    if (!tileActive(tileId, currentSettings)) return false;
    const provider = providerFromTile(tileId);
    return !provider || lifecycleShowsTile(providerLifecycleRef.current[provider]);
  }

  const attachedTileIds = useMemo(
    () => tileLayout.order.filter((tileId) => runtimeTileActive(tileId, settings) && !tileLayout.detached[tileId]),
    [tileLayout, settings, providerLifecycles],
  );

  // Live hardware polling — independent of the 60s usage refresh, and only while at least one
  // monitor tile is shown so it costs nothing when the feature is off. Failures degrade to "N/A".
  const anyMonitorShown = shownMonitors.length > 0;
  useEffect(() => {
    if (!anyMonitorShown) return;
    let cancelled = false;
    async function tick() {
      const metrics = await readSystemMetrics(shownMonitors);
      if (!cancelled) setMonitorReadings(buildMonitorReadings(metrics, shownMonitors));
    }
    void tick();
    const interval = window.setInterval(tick, clampNumber(settings.monitorIntervalSec, 1, 10, 2) * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [anyMonitorShown, shownMonitors, settings.monitorIntervalSec]);

  useEffect(() => {
    function reloadLayout() {
      const next = loadTileLayout();
      tileLayoutRef.current = next;
      setTileLayout(next);
    }
    function onStorage(event: StorageEvent) { if (event.key === TILE_LAYOUT_KEY) reloadLayout(); }
    window.addEventListener("storage", onStorage);
    window.addEventListener(TILE_LAYOUT_EVENT, reloadLayout);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(TILE_LAYOUT_EVENT, reloadLayout);
    };
  }, []);

  // Only the fields this effect actually reads. Depending on the whole `settings` object made an
  // unrelated edit (theme, refresh interval) resize and reposition every detached window.
  // `runtimeTileActive` also reads the provider lifecycle, so that must be a dependency too: without
  // it the starting -> ready transition left the key unchanged and a detached provider tile never
  // reopened after its Show was switched back on.
  const tileReconcileKey = useMemo(
    () => [
      settings.alwaysOnTop ? "1" : "0",
      settings.uiScale,
      ...settings.accounts.map((account) => `${account.id}:${account.label}`),
      ...allTileIds(settings).map((tileId) => `${runtimeTileActive(tileId, settings) ? "1" : "0"}${tileConfigured(tileId, settings) ? "1" : "0"}`),
    ].join("|"),
    [settings, providerLifecycles],
  );

  useEffect(() => {
    const settings = settingsRef.current;
    const detachedEntries = Object.entries(tileLayout.detached) as [TileId, WindowPosition][];
    const invalid = detachedEntries.filter(([tileId]) => !tileConfigured(tileId, settings)).map(([tileId]) => tileId);
    if (invalid.length) {
      commitTileLayout((current) => {
        const detached = { ...current.detached };
        invalid.forEach((tileId) => delete detached[tileId]);
        return { ...current, detached };
      });
      invalid.forEach((tileId) => { void invoke("close_detached_tile", { tileId }).catch(() => undefined); });
      return;
    }
    for (const [tileId, savedPosition] of detachedEntries) {
      if (!runtimeTileActive(tileId, settings)) {
        void invoke("close_detached_tile", { tileId }).catch(() => undefined);
        continue;
      }
      void normalizeDetachedTilePosition(savedPosition, settings.uiScale).then((position) =>
        invoke("open_detached_tile", { tileId, displayLabel: tileDisplayLabel(tileId), position, pinned: settings.alwaysOnTop, scale: settings.uiScale }),
      ).catch(() => undefined);
    }
    void invoke("set_detached_tiles_pinned", { pinned: settings.alwaysOnTop }).catch(() => undefined);
  }, [tileLayout, tileReconcileKey]);

  useEffect(() => {
    const now = Date.now();
    const previous = runtimePayloadRef.current;
    const next: Partial<Record<TileId, DetachedRuntimeState>> = {};
    for (const tileId of Object.keys(tileLayout.detached).filter(isTileId)) {
      if (!runtimeTileActive(tileId, settings)) continue;
      const provider = providerFromTile(tileId);
      const monitor = monitorFromTile(tileId);
      const state: DetachedRuntimeState = provider
        ? {
            snapshot: snapshotOf(snapshots, provider),
            activeEffect: settings.effectsEnabled ? activeEffects[provider] : undefined,
            timerOrigin: timerModes[provider],
            flash: flashSet.has(provider),
            paused: !shouldAutoRefreshProvider(provider, snapshotOf(snapshots, provider), now, lastLimitedAutoRefreshRef.current),
            freshAt: lastFreshAtRef.current[provider],
          }
        : {
            monitorReading: monitor ? monitorReadingsForRender[monitor] : undefined,
            flash: false,
            paused: false,
          };
      next[tileId] = state;
      const old = previous[tileId];
      const changed = !old
        || old.snapshot !== state.snapshot
        || old.monitorReading !== state.monitorReading
        || old.activeEffect !== state.activeEffect
        || old.timerOrigin !== state.timerOrigin
        || old.flash !== state.flash
        || old.paused !== state.paused
        || old.freshAt !== state.freshAt;
      if (changed) void emitTo(tileWindowLabel(tileId), "usageview-runtime-state", state).catch(() => undefined);
    }
    runtimePayloadRef.current = next;
  }, [snapshots, monitorReadingsForRender, activeEffects, timerModes, flashSet, tileLayout, settings]);

  // A late-joining tile asks for the current state. This listener is deliberately kept out of the
  // push effect above: that one re-runs on every monitor poll, and `listen` resolving after its
  // cleanup would strand a handler holding a stale payload.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ label: string }>("usageview-runtime-request", ({ payload: request }) => {
      const tileId = request?.label ? tileIdForWindowLabel(request.label) : null;
      const state = tileId ? runtimePayloadRef.current[tileId] : undefined;
      if (!state || !tileId) return;
      void emitTo(request.label, "usageview-runtime-state", state).catch(() => undefined);
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];
    const keep = (dispose: () => void) => { if (disposed) dispose(); else disposers.push(dispose); };

    async function dockTile(payload: DetachedTileEvent) {
      const windowPosition = await getCurrentWindow().outerPosition().catch(() => new PhysicalPosition(0, 0));
      const clientY = (payload.screenY - windowPosition.y) / (window.devicePixelRatio || 1);
      const current = tileLayoutRef.current;
      const attached = current.order.filter((tileId) => runtimeTileActive(tileId, settingsRef.current) && !current.detached[tileId] && tileId !== payload.tileId);
      const before = attached.find((tileId) => {
        const rect = tileElementsRef.current[tileId]?.getBoundingClientRect();
        return rect ? clientY < rect.top + rect.height / 2 : false;
      });
      commitTileLayout((layout) => {
        const detached = { ...layout.detached };
        delete detached[payload.tileId];
        const order = layout.order.filter((tileId) => tileId !== payload.tileId);
        const index = before ? order.indexOf(before) : order.length;
        order.splice(index < 0 ? order.length : index, 0, payload.tileId);
        return { ...layout, order, detached };
      });
    }

    void listen<DetachedTileEvent>("usageview-dock-tile", ({ payload }) => { if (isTileId(payload.tileId)) void dockTile(payload); })
      .then(keep);
    void listen<DetachedTileEvent>("usageview-detached-position", ({ payload }) => {
      if (!isTileId(payload.tileId)) return;
      commitTileLayout((layout) => ({ ...layout, detached: { ...layout.detached, [payload.tileId]: { x: payload.x, y: payload.y } } }));
    }).then(keep);
    void listen<string>("usageview-hide-tile", ({ payload: tileId }) => {
      if (!isTileId(tileId)) return;
      updateSettings(hideTileInSettings(tileId, settingsRef.current));
      commitTileLayout((layout) => {
        const detached = { ...layout.detached };
        delete detached[tileId];
        return { ...layout, detached };
      });
    }).then(keep);
    void listen<{ provider: Provider }>(TIMER_TOGGLE_EVENT, ({ payload }) => {
      const provider = payload?.provider;
      if (!provider || !settingsRef.current.accounts.some((account) => account.id === provider)) return;
      setTimerModes((current) => {
        const next = { ...current };
        if (current[provider]) delete next[provider];
        else next[provider] = "manual";
        return next;
      });
    }).then(keep);
    return () => { disposed = true; disposers.forEach((dispose) => dispose()); };
  }, []);

  // Never let two reads of the same provider run at once. At low refresh intervals a slow Claude
  // read would otherwise be reloaded out from under itself by the next tick. A manual request that
  // arrives mid-read awaits that read instead of being silently answered with the stale snapshot.
  //
  // A read is bound to the lifecycle generation that started it: its `shouldCommit` guard closes over
  // that generation, and it may be reading a WebView that a Show OFF has since destroyed. Sharing it
  // across generations let a doomed read commit `page_unavailable` over the fresh one's snapshot, so
  // a caller from another generation waits it out and issues its own read instead.
  async function guardedRefresh(
    provider: Provider,
    url: string,
    background: boolean,
    shouldCommit?: SnapshotCommitGuard,
    generation = providerGenerationRef.current[provider] ?? 0,
  ): Promise<UsageSnapshot> {
    const existing = refreshInFlightRef.current[provider];
    if (existing) {
      if (existing.generation === generation) return existing.operation;
      await existing.operation.catch(() => undefined);
      if (providerGenerationRef.current[provider] !== generation) return snapshotOf(snapshotsRef.current, provider);
    }
    const commit = (snapshot: UsageSnapshot) =>
      settingsRef.current.accounts.some((account) => account.id === provider)
      && !providerRemovalPending(provider)
      && providerGenerationRef.current[provider] === generation
      && (shouldCommit ? shouldCommit(snapshot) : true);
    const entry = { operation: refreshProviderFromUrl(provider, url, background, commit), generation };
    refreshInFlightRef.current[provider] = entry;
    const release = () => { if (refreshInFlightRef.current[provider] === entry) delete refreshInFlightRef.current[provider]; };
    void entry.operation.then(release, release);
    return entry.operation;
  }

  // Wait out whatever read is already in flight for this provider so a lifecycle transition never
  // races it, without adopting its result.
  async function settleProviderRefresh(provider: Provider, generation: number) {
    const pending = refreshInFlightRef.current[provider];
    if (!pending) return;
    if (pending.generation === generation) return;
    await pending.operation.catch(() => undefined);
  }

async function refresh(provider: Provider, requestNonce: string) {
    if (!settingsRef.current.accounts.some((account) => account.id === provider) || providerRemovalPending(provider)) return;
    // The widget owns the lifecycle, so it — not the Settings button's disabled state — is what
    // decides a manual read is safe. Settings can miss the transition (its window may have opened
    // after the phase event), and a manual read started mid-STARTING carries no commit guard: the
    // lifecycle's own retry would then adopt that promise and write `page_unavailable` over a
    // healthy snapshot. Answer with what we already have and let the lifecycle finish.
    if (lifecycleIsTransitioning(providerLifecycleRef.current[provider])) {
      const current = snapshotOf(snapshotsRef.current, provider);
      await emitTo("settings", "usageview-refresh-result", {
        nonce: requestNonce,
        provider,
        status: current.status,
        message: `${providerLabel(provider)} is still starting`,
      } satisfies RefreshResult).catch(() => undefined);
      return;
    }
    const snapshot = await guardedRefresh(provider, providerUrl(provider, settingsRef.current), false);
    if (!settingsRef.current.accounts.some((account) => account.id === provider) || providerRemovalPending(provider)) return;
    triggerManualReplay(provider, snapshot);
    setSnapshots((currentSnapshots) => ({ ...currentSnapshots, [provider]: snapshot }));
    setLastUpdated(new Date());
    if (providerDesiredRef.current[provider] === true) {
      const generation = providerGenerationRef.current[provider];
      if (snapshot.status === "ok" && !isStale(snapshot)) {
        publishProviderLifecycle({ provider, phase: "ready", generation, message: `${providerLabel(provider)} ready` });
      } else if (snapshot.status === "not_open" || snapshot.status === "not_logged_in") {
        publishProviderLifecycle({ provider, phase: "login-needed", generation, message: `${providerLabel(provider)} needs login` });
      }
    }
    await emitTo("settings", "usageview-refresh-result", {
      nonce: requestNonce,
      provider,
      status: snapshot.status,
      message: snapshot.message,
    } satisfies RefreshResult).catch(() => undefined);
  }

  useEffect(() => {
    const accountIds = accountIdsFrom(settings);
    const activeIds = new Set(accountIds);
    const previous = previousLimitRef.current;
    const observations = accountIds.map((provider) => {
      const limit = trustworthyLimitState(provider, snapshotOf(snapshots, provider));
      return { provider, limit, enteredLimited: limit === true && previous[provider] !== true };
    });
    const nextPrevious = { ...previous };
    for (const provider of Object.keys(nextPrevious)) if (!activeIds.has(provider)) delete nextPrevious[provider];
    for (const { provider, limit } of observations) if (limit !== undefined) nextPrevious[provider] = limit;
    previousLimitRef.current = nextPrevious;

    setTimerModes((current) => {
      let next = current;
      const mutate = () => { if (next === current) next = { ...current }; };
      for (const provider of Object.keys(current)) {
        if (!activeIds.has(provider)) { mutate(); delete next[provider]; }
      }
      for (const { provider, limit, enteredLimited } of observations) {
        if (limit !== true && current[provider] === "auto") {
          mutate();
          delete next[provider];
        } else if (enteredLimited && current[provider] === undefined) {
          mutate();
          next[provider] = "auto";
        }
      }
      return next;
    });
  }, [snapshots, settings.accounts]);

  useLayoutEffect(() => {
    const newly: Provider[] = [];
    const effectPayloads: Partial<Record<Provider, UsageEffect>> = {};
    for (const p of accountIdsFrom(settingsRef.current)) {
      const snap = snapshotOf(snapshots, p);
      const token = flashToken(snap);
      const previousToken = prevFlashTokenRef.current[p];
      const previousPercent = prevEffectPercentRef.current[p];
      const previousPeriod = prevEffectPeriodRef.current[p];
      const nextPercent = snapshotPercent(snap);
      const nextPeriod = snapshotDisplayPeriod(snap);
      const hasRuntimeValidRead = runtimeValidReadRef.current[p] === true;
      prevFlashTokenRef.current[p] = token;
      prevEffectPeriodRef.current[p] = nextPeriod;
      if (previousToken !== undefined && token && token !== previousToken) {
        newly.push(p);
        if (typeof nextPercent === "number" && nextPercent > 0) {
          const isStartupReveal = !hasRuntimeValidRead;
          const increased = hasRuntimeValidRead && previousPeriod === nextPeriod && typeof previousPercent === "number" && nextPercent > previousPercent;
          if (isStartupReveal || increased) {
            const fromPercent = isStartupReveal ? 0 : Number(previousPercent);
            effectPayloads[p] = makeUsageEffect(fromPercent, nextPercent);
          }
        }
        runtimeValidReadRef.current[p] = true;
        if (typeof nextPercent === "number") prevEffectPercentRef.current[p] = nextPercent;
      }
    }
    if (!newly.length) return;
    // Each provider owns its timer. A new valid snapshot resets only that provider's
    // light, so staggered Codex results cannot hide each other or flash on stale values.
    for (const p of newly) {
      const existingTimer = flashTimersRef.current[p];
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    }
    setFlashSet((prev) => {
      const next = new Set(prev);
      newly.forEach((p) => next.add(p));
      return next;
    });
    activateUsageEffects(effectPayloads);
    for (const p of newly) {
      const duration = 2000;
      flashTimersRef.current[p] = window.setTimeout(() => {
        setFlashSet((prev) => {
          const next = new Set(prev);
          next.delete(p);
          return next;
        });
        delete flashTimersRef.current[p];
      }, duration);
    }
  }, [snapshots]);

  // One stable flip handler per provider. A fresh `() => toggleTimer(p)` on every render would
  // change the prop identity each time and defeat the memo on the tiles below, which is the whole
  // point of memoising them: a monitor poll must not re-render the AI tiles.
  const timerToggles = useMemo(() => {
    const make = (provider: Provider) => () => setTimerModes((current) => {
      const next = { ...current };
      if (current[provider]) delete next[provider];
      else next[provider] = "manual";
      return next;
    });
    return Object.fromEntries(accountIdsFrom(settings).map((id) => [id, make(id)])) as Record<Provider, () => void>;
  }, [settings.accounts]);

  // Execute commands posted by the detached Settings window (single engine owner lives here).
  useEffect(() => {
    let unlistenRefresh: (() => void) | undefined;
    function onStorage(event: StorageEvent) {
      if (event.key !== APP_CMD_KEY || !event.newValue) return;
      let command: AppCommand;
      try { command = JSON.parse(event.newValue) as AppCommand; } catch { return; }
      if (!command?.nonce || command.nonce === lastCmdNonceRef.current) return;
      lastCmdNonceRef.current = command.nonce;
      if (command.type === "play" && settingsRef.current.accounts.some((account) => account.id === command.provider)) playTestEffect(command.provider, command.from, command.to, command.driveBar);
      else if (command.type === "restore") void restoreTestEffect();
      else if (command.type === "play-monitor" && settingsRef.current.systemMonitorsEnabled && settingsRef.current[MONITOR_SHOW_KEY[command.kind]]) playMonitorTestEffect(command.kind, command.value, command.nonce);
      else if (command.type === "restore-monitor") restoreMonitorTestEffect();
      else if (command.type === "refresh") void refresh(command.provider, command.nonce);
      else if (command.type === "reset-window") void resetWindowPosition();
    }
    window.addEventListener("storage", onStorage);
    void listen<RefreshRequest>("usageview-refresh-request", ({ payload }) => {
      if (!payload?.nonce || payload.nonce === lastCmdNonceRef.current) return;
      if (!settingsRef.current.accounts.some((account) => account.id === payload.provider)) return;
      lastCmdNonceRef.current = payload.nonce;
      void refresh(payload.provider, payload.nonce);
    }).then((dispose) => { unlistenRefresh = dispose; });
    return () => {
      window.removeEventListener("storage", onStorage);
      unlistenRefresh?.();
    };
  }, []);

  async function refreshAll() {
    const providers = accountIdsFrom(settings).filter((provider) =>
      providerEnabled(provider, settings) && lifecycleShowsTile(providerLifecycleRef.current[provider]),
    );
    if (!providers.length) return;
    const results = await Promise.all(
      providers.map((provider) => guardedRefresh(provider, providerUrl(provider, settings), false)),
    );
    const currentResults = results.filter((snapshot) =>
      settingsRef.current.accounts.some((account) => account.id === snapshot.provider)
      && !providerRemovalPending(snapshot.provider),
    );
    currentResults.forEach((snapshot) => triggerManualReplay(snapshot.provider, snapshot));
    setSnapshots((currentSnapshots) => currentResults.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), currentSnapshots));
    setLastUpdated(new Date());
  }

  async function closeWindow() {
    await saveCurrentPositionNow();
    await getCurrentWindow().close();
  }

  function openCompactMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    if (compactPointerRef.current?.dragged) {
      compactPointerRef.current = null;
      return;
    }
    void invoke("show_widget_context_menu", {
      mode,
      pinned: settings.alwaysOnTop,
      x: event.clientX,
      y: event.clientY,
    }).catch(() => undefined);
  }

  function prepareCompactDrag(event: React.MouseEvent<HTMLElement>) {
    // The grip owns tile drags; without this the 5px window-drag threshold would always beat the
    // 7px tile threshold and the tile could never be dragged.
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, .mini-mark-btn, .tile-grip")) return;
    compactPointerRef.current = { x: event.clientX, y: event.clientY, dragged: false };
  }

  function maybeStartCompactDrag(event: React.MouseEvent<HTMLElement>) {
    const pointer = compactPointerRef.current;
    if (!pointer || pointer.dragged || (event.buttons & 1) !== 1) return;
    if (Math.abs(event.clientX - pointer.x) < 5 && Math.abs(event.clientY - pointer.y) < 5) return;
    pointer.dragged = true;
    void getCurrentWindow().startDragging().catch(() => undefined);
  }

  function togglePinned() {
    updateSettings({ ...settings, alwaysOnTop: !settings.alwaysOnTop });
  }

  contextActionHandlerRef.current = (action) => {
    if (action === "mini" || action === "widget") {
      setMode(action);
    } else if (action === "pin") {
      togglePinned();
    } else if (action === "refresh") {
      void refreshAll();
    } else if (action === "settings") {
      void invoke("toggle_settings_window");
    } else if (action === "close") {
      void closeWindow();
    }
  };

  const now = Date.now();
  const isPaused = (p: Provider) =>
    !shouldAutoRefreshProvider(p, snapshotOf(snapshots, p), now, lastLimitedAutoRefreshRef.current);
  const agoFor = (p: Provider) => formatAgo(lastFreshAtRef.current[p]);

  function renderFullTile(tileId: TileId) {
    const provider = providerFromTile(tileId);
    if (provider) {
      // A just-added account's tile can render a frame before its snapshot entry lands, so read
      // through snapshotOf (never a raw snapshots[id] that could be undefined).
      const snap = snapshotOf(snapshots, provider);
      const accent = providerAccent(provider, settings);
      const activeEffect = settings.effectsEnabled ? activeEffects[provider] : undefined;
      const timerOrigin = timerModes[provider];
      const deferTimer = timerOrigin === "auto" && activeEffect !== undefined && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      return timerOrigin && !deferTimer
        ? <TimerView snapshot={snap} accent={accent} onBack={timerToggles[provider]} paused={isPaused(provider)} />
        : <UsageBlock snapshot={snap} accent={accent} flash={flashSet.has(provider)} paused={isPaused(provider)} updatedAgo={agoFor(provider)} effect={activeEffect} dropCell={settings.effectDropCell} glass={themeStyle(settings.theme) === "glass"} effectsEnabled={settings.effectsEnabled} onFlip={deferTimer ? undefined : timerToggles[provider]} />;
    }
    const monitor = monitorFromTile(tileId);
    const reading = monitor ? monitorReadingsForRender[monitor] : null;
    return monitor && reading ? <MonitorBlock key={reading.testNonce ?? "live"} reading={reading} tone={monitorTone(settings, reading)} pulse={settings.effectsEnabled} glass={themeStyle(settings.theme) === "glass"} textEffect={!settings.colorsEnabled || settings.colorScope.text} /> : null;
  }

  function renderMiniTile(tileId: TileId) {
    const provider = providerFromTile(tileId);
    if (provider) {
      const snap = snapshotOf(snapshots, provider);
      const accent = providerAccent(provider, settings);
      return timerModes[provider]
        ? <MiniTimerRow snapshot={snap} accent={accent} onBack={timerToggles[provider]} paused={isPaused(provider)} />
        : <MiniUsageRow snapshot={snap} accent={accent} paused={isPaused(provider)} updatedAgo={agoFor(provider)} flash={flashSet.has(provider)} onFlip={timerToggles[provider]} />;
    }
    const monitor = monitorFromTile(tileId);
    return monitor ? <MonitorMiniRow reading={monitorReadings[monitor]} tone={monitorTone(settings, monitorReadings[monitor])} /> : null;
  }

  function previewTileOrder(tileId: TileId, clientY: number) {
    const candidates = attachedTileIds.filter((id) => id !== tileId);
    const before = candidates.find((id) => {
      const rect = tileElementsRef.current[id]?.getBoundingClientRect();
      return rect ? clientY < rect.top + rect.height / 2 : false;
    });
    const current = tileLayoutRef.current;
    const order = current.order.filter((id) => id !== tileId);
    const index = before ? order.indexOf(before) : order.length;
    order.splice(index < 0 ? order.length : index, 0, tileId);
    const next = { ...current, order };
    tileLayoutRef.current = next;
    setTileLayout(next);
  }

  // `handleOnly` is for mini mode, where the tile fills the window: only the grip starts a tile
  // drag, so the rest of the surface still moves the window itself.
  function beginTileDrag(event: React.PointerEvent<HTMLDivElement>, tileId: TileId, handleOnly = false) {
    // A drag that ends in a detach unmounts the tile before its click lands, so the suppression
    // set mid-drag is never consumed. Drop it here or it eats the first click after docking back.
    suppressTileClickRef.current = null;
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, a, [role='button']")) return;
    if (handleOnly && !target.closest(".tile-grip")) return;
    tileDragRef.current = { tileId, x: event.clientX, y: event.clientY, dragged: false };
    // Mini's grip is an explicit drag handle, so capture immediately. Otherwise a fast drag can
    // leave the small window before crossing the threshold and never deliver the outside pointer-up.
    if (handleOnly) event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTileDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = tileDragRef.current;
    if (!drag || (event.buttons & 1) !== 1) return;
    if (!drag.dragged) {
      if (Math.abs(event.clientX - drag.x) < 7 && Math.abs(event.clientY - drag.y) < 7) return;
      // Capturing on pointer-down retargets a normal click to the shell, so Full mode waits until
      // the drag threshold. Mini's explicit grip already captured above; this is a safe fallback.
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
      drag.dragged = true;
      suppressTileClickRef.current = drag.tileId;
      setDraggingTile(drag.tileId);
    }
    if (event.clientX >= 0 && event.clientX <= window.innerWidth && event.clientY >= 0 && event.clientY <= window.innerHeight) {
      previewTileOrder(drag.tileId, event.clientY);
    }
  }

  function finishTileDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = tileDragRef.current;
    tileDragRef.current = null;
    setDraggingTile(null);
    if (!drag?.dragged) return;
    const outside = event.clientX < 0 || event.clientX > window.innerWidth || event.clientY < 0 || event.clientY > window.innerHeight;
    if (!outside) {
      saveTileLayout(tileLayoutRef.current);
      return;
    }
    void invoke<WindowPosition>("open_detached_tile", { tileId: drag.tileId, displayLabel: tileDisplayLabel(drag.tileId), position: null, pinned: settingsRef.current.alwaysOnTop, scale: settingsRef.current.uiScale })
      .then((position) => commitTileLayout((layout) => ({ ...layout, detached: { ...layout.detached, [drag.tileId]: position } })))
      .catch(() => saveTileLayout(tileLayoutRef.current));
  }

  if (mode === "mini") {
    return (
      <main className={`compact-widget mini-widget ${themeClass(settings.theme)} ${panelScopeClasses(settings)}`} style={panelStyle(settings)} onMouseDown={prepareCompactDrag} onMouseMove={maybeStartCompactDrag} onContextMenu={openCompactMenu}>
        <WidgetToasts notices={providerNotices} monitorToasts={monitorToasts} />
        <div ref={compactProvidersRef} className="mini-providers">
          {attachedTileIds.map((tileId) => (
            <div
              key={tileId}
              ref={(node) => { tileElementsRef.current[tileId] = node; }}
              className={`tile-shell mini-tile-shell${draggingTile === tileId ? " is-dragging" : ""}`}
              data-tile-id={tileId}
              onPointerDown={(event) => beginTileDrag(event, tileId, true)}
              onPointerMove={moveTileDrag}
              onPointerUp={finishTileDrag}
              onPointerCancel={finishTileDrag}
              onClickCapture={(event) => {
                if (suppressTileClickRef.current !== tileId) return;
                suppressTileClickRef.current = null;
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <span className="tile-grip" aria-hidden="true" title="Drag to reorder or detach" />
              {renderMiniTile(tileId)}
            </div>
          ))}
          {attachedTileIds.length === 0 && !providerLifecyclePending && <EmptyProviderState />}
        </div>
      </main>
    );
  }

  return (
    <main ref={widgetRef} className={`widget ${themeClass(settings.theme)} ${panelScopeClasses(settings)}`} style={panelStyle(settings)} onMouseDown={startWindowDrag}>
      <WidgetToasts notices={providerNotices} monitorToasts={monitorToasts} />
      <div className="scale-shell">
      <div ref={widgetHeaderRef} className="widget-header">
        <div className="window-title">
          <span>updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div className="header-actions">
          <button className="window-control gear" type="button" title="Settings" aria-label="Settings" onClick={() => void invoke("toggle_settings_window")}><GearIcon /></button>
          <button className="window-control close" type="button" title="Close" aria-label="Close" onClick={() => void closeWindow()}>x</button>
        </div>
      </div>
      <div ref={providersRef} className="providers">
        {attachedTileIds.map((tileId) => (
          <div
            key={tileId}
            ref={(node) => { tileElementsRef.current[tileId] = node; }}
            className={`tile-shell${draggingTile === tileId ? " is-dragging" : ""}`}
            data-tile-id={tileId}
            onPointerDown={(event) => beginTileDrag(event, tileId)}
            onPointerMove={moveTileDrag}
            onPointerUp={finishTileDrag}
            onPointerCancel={finishTileDrag}
            onClickCapture={(event) => {
              if (suppressTileClickRef.current !== tileId) return;
              suppressTileClickRef.current = null;
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {renderFullTile(tileId)}
          </div>
        ))}
        {attachedTileIds.length === 0 && !providerLifecyclePending && <EmptyProviderState />}
      </div>
      </div>
    </main>
  );
}

function GearIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="close-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5l14 14M19 5 5 19" />
    </svg>
  );
}

function DisclosureChevron() {
  return (
    <svg className="disclosure-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

// Shared in-app modal — inherits the window's theme (Pixel/Glass) so it never falls back to the raw
// tauri.localhost confirm() box. Closes on backdrop click or Escape.
function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="app-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="app-modal-card mini-card" role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

function ProviderLoginApp({ provider }: { provider: Provider }) {
  const settings = loadSettings();
  const targetUrl = localStorage.getItem(`usageview.providerTarget.${provider}`) || providerUrl(provider, settings);
  const [status, setStatus] = useState("Ready. Click Open Page to login inside this app window.");

  function openPage() {
    setStatus(`Opening ${targetUrl}`);
    window.location.assign(targetUrl);
  }

  async function hideToWidget() {
    await invoke("open_widget_window");
    await closeProvider(provider);
  }

  return (
    <main className="provider-shell theme-terminal">
      <header className="titlebar" data-tauri-drag-region>
        <div className="title-row" data-tauri-drag-region>
          <ProviderMark provider={provider} />
          <div data-tauri-drag-region>
            <strong data-tauri-drag-region>{providerLabel(provider)} Login Shell</strong>
            <span data-tauri-drag-region>official provider WebView</span>
          </div>
        </div>
        <button className="window-btn" onClick={() => void hideToWidget()}>Hide</button>
      </header>

      <section className="provider-card">
        <h1>{providerLabel(provider)} official page</h1>
        <p>UsageView only frames the local shell. The provider login and usage page stay official inside this WebView.</p>
        <label className="url-field">Official usage/login URL<input readOnly value={targetUrl} /></label>
        <div className="provider-actions">
          <button className="primary" onClick={openPage}>Open Page</button>
          <button onClick={() => window.location.reload()}>Reload</button>
          <button onClick={() => void openInChrome(targetUrl).then((via) => setStatus(via === "chrome" ? "Opened in Chrome (view only)." : "Chrome not found — opened default browser."))}>Open Browser</button>
          <button onClick={() => void hideToWidget()}>Hide</button>
        </div>
        <div className={`status-line ${statusLineTone(status)}`}><span />{status}</div>
        <p className="hint">Browser fallback is only for viewing. Extract mode needs login inside this app window.</p>
      </section>
    </main>
  );
}

function ProviderPanel({
  provider,
  accent,
  url,
  developerMode,
  snapshot,
  lifecycle,
  busy,
  onOpen,
  onReload,
  onClose,
  onLogout,
  onDiscover,
  discovery,
  onExtract,
  onRetry,
  onUrlChange,
  shownInWidget,
  onToggleShown,
  onRemove,
  onRename,
}: {
  provider: Provider;
  accent?: string;
  url: string;
  developerMode: boolean;
  snapshot: UsageSnapshot;
  lifecycle?: ProviderLifecycle;
  busy: Provider | `${Provider}-open` | `${Provider}-close` | `${Provider}-reload` | `${Provider}-logout` | `${Provider}-discover` | null;
  onOpen: () => void;
  onReload: () => void;
  onClose: () => void;
  onLogout: () => void;
  onDiscover: () => void;
  discovery?: string;
  onExtract: () => void;
  onRetry: () => void;
  onUrlChange: (url: string) => void;
  shownInWidget: boolean;
  onToggleShown: () => void;
  onRemove: () => void;
  onRename: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const cancelEditRef = useRef(false);
  function beginEdit() { cancelEditRef.current = false; setDraftLabel(providerLabel(provider)); setEditing(true); }
  function commitEdit() {
    if (cancelEditRef.current) { cancelEditRef.current = false; return; }
    if (editing) { onRename(draftLabel); setEditing(false); }
  }
  const transitioning = lifecycleIsTransitioning(lifecycle);
  const providerCommandBusy = busy === provider || (["open", "close", "reload", "logout", "discover"] as const).some((suffix) => busy === `${provider}-${suffix}`);
  const lifecycleActive = lifecycle && lifecycle.phase !== "ready";
  const pillStatus = lifecycleActive ? lifecycleTone(lifecycle) : snapshot.status;
  const pillLabel = lifecycleActive ? lifecycleLabel(lifecycle) : undefined;
  // Last-known usage from the saved snapshot (no polling in Settings). A hidden account keeps showing its
  // last value + reset countdown, so you can check "is it used up?" without unhiding it.
  const usagePercent = typeof snapshot.percentUsed === "number" ? Math.round(snapshot.percentUsed) : null;
  const usageReset = resetCountdownLabel(snapshot);
  const usageSummary = snapshot.status === "ok"
    ? `${usagePercent !== null ? `${usagePercent}% ${snapshotDisplayPeriod(snapshot) === "weekly" ? "used this week" : "used"}` : "up to date"}${usageReset ? ` · ${usageReset}` : ""}`
    : providerMessage(snapshot);
  const showLabel = lifecycle?.phase === "starting" || lifecycle?.phase === "retrying"
    ? "Cancel"
    : lifecycle?.phase === "stopping" || lifecycle?.phase === "waiting-close"
      ? "Show again"
      : lifecycle?.phase === "error"
        ? "Retry"
      : shownInWidget ? "Hide widget" : "Show widget";
  return (
    <section className={`mini-card ${providerKind(provider)}${lifecycle?.phase === "stopped" ? " provider-stopped" : ""}`} style={providerAccentStyle(accent)}>
      <div className="mini-head">
        <div>
          <h2>
            <ProviderMark provider={provider} />
            {editing ? (
              <input
                className="account-name-edit"
                autoFocus
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value.toLocaleUpperCase())}
                onBlur={commitEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitEdit();
                  else if (event.key === "Escape") { cancelEditRef.current = true; setEditing(false); }
                }}
              />
            ) : (
              <>
                {providerLabel(provider)}
                <button type="button" className="account-rename" title="Rename account" aria-label="Rename account" onClick={beginEdit}><PencilIcon /></button>
              </>
            )}
          </h2>
          <p className="account-usage">{usageSummary}</p>
        </div>
        <StatusPill status={pillStatus} label={pillLabel} />
      </div>
      <div className="daily-actions">
        <button className="primary" onClick={onOpen} disabled={busy === `${provider}-open`}>{busy === `${provider}-open` ? "Opening" : "Login"}</button>
        <button onClick={onExtract} disabled={busy === provider || transitioning}>{busy === provider ? "Refreshing" : "Refresh now"}</button>
        <button onClick={lifecycle?.phase === "error" ? onRetry : onToggleShown} disabled={providerCommandBusy}>{showLabel}</button>
      </div>
      <div className="daily-actions secondary-actions">
        <button onClick={onLogout} disabled={busy === `${provider}-logout`}>{busy === `${provider}-logout` ? "Signing out" : "Log out"}</button>
        <button className="account-remove" onClick={onRemove} disabled={providerCommandBusy}>Remove</button>
      </div>
      {developerMode && (
      <details className="advanced-tools">
        <summary><span className="summary-left"><DisclosureChevron /><span>More options (developer)</span></span></summary>
        <label className="url-field">Login / usage link<input value={url} onChange={(event) => onUrlChange(event.target.value)} /></label>
        <div className="button-grid">
          <button onClick={onReload} disabled={busy === `${provider}-reload`}>Reload page</button>
          <button onClick={onClose} disabled={busy === `${provider}-close`}>Hide window</button>
          <button onClick={onDiscover} disabled={busy === `${provider}-discover`}>{busy === `${provider}-discover` ? "Inspecting API..." : "Inspect API calls"}</button>
        </div>
        <p className="hint">Log out clears only this account's isolated in-app session.</p>
        <p className="hint">API inspection is diagnostic only and does not change usage extraction. Review its output before sharing.</p>
      {discovery && (
        <details className="debug-text" open>
          <summary>API inspection report</summary>
          <pre>{discovery}</pre>
        </details>
      )}
      {snapshot.debugText && (
        <details className="debug-text">
          <summary>Last extraction diagnostic</summary>
          <pre>{snapshot.debugText}</pre>
        </details>
      )}
      </details>
      )}
    </section>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.1" />
      <path d="M12 2.6v2.3M12 19.1v2.3M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.6 12h2.3M19.1 12h2.3M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
      <path d="M20.2 14.7A8.2 8.2 0 0 1 9.3 3.8a.6.6 0 0 0-.82-.78A8.7 8.7 0 1 0 21 15.5a.6.6 0 0 0-.8-.8z" />
    </svg>
  );
}

// Light/Dark presented as a sliding switch (sun on the left, moon on the right). Pure presentation —
// the click just flips the mode half of the composed theme; all wiring stays in patch().
function ModeSwitch({ mode, onToggle }: { mode: ThemeMode; onToggle: () => void }) {
  const dark = mode === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={`Theme mode: ${mode}`}
      className={`mode-switch${dark ? " is-dark" : ""}`}
      onClick={onToggle}
    >
      <span className="mode-switch-end sun" aria-hidden="true"><SunIcon /></span>
      <span className="mode-switch-end moon" aria-hidden="true"><MoonIcon /></span>
      <span className="mode-switch-knob" aria-hidden="true">{dark ? <MoonIcon /> : <SunIcon />}</span>
    </button>
  );
}

function FeatureSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="feature-settings-head">
      <span className="summary-left"><span>{label}</span></span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`${label}: ${checked ? "on" : "off"}`}
        className={`mode-switch feature-mode-switch${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="mode-switch-end feature-switch-end off" aria-hidden="true">OFF</span>
        <span className="mode-switch-end feature-switch-end on" aria-hidden="true">ON</span>
        <span className="mode-switch-knob feature-switch-knob" aria-hidden="true">{checked ? "ON" : "OFF"}</span>
      </button>
    </div>
  );
}

// Custom dropdown so the menu can be themed per style (Pixel = square/mono, Glass = frosted). Closes on
// outside pointerdown + Escape. Generic over the option value so it can be reused beyond the zoom picker.
function ThemedSelect<T extends string | number>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`themed-select${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="themed-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{current?.label ?? String(value)}</span>
        <svg className="themed-select-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <ul className="themed-select-menu" role="listbox">
          {options.map((option) => (
            <li key={String(option.value)}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`themed-select-option${option.value === value ? " is-active" : ""}`}
                onClick={() => { onChange(option.value); setOpen(false); }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ZOOM_OPTIONS: { label: string; value: number }[] = [
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "75%", value: 0.75 },
  { label: "100%", value: 1 },
  { label: "125%", value: 1.25 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
];

// ── Color helpers (hex ↔ HSV) for the custom picker ──
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [136, 136, 136];
}
function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const hexToHsv = (hex: string): [number, number, number] => rgbToHsv(...hexToRgb(hex));
const hsvToHex = (h: number, s: number, v: number): string => rgbToHex(...hsvToRgb(h, s, v));
const isHex = (s: string) => /^#?[0-9a-fA-F]{6}$/.test(s.trim());

// Full custom color picker: 2D saturation/value square + hue strip + hex field. Rendered inline (expands
// under the control). Live onChange; Esc or the Done button closes.
function ColorPicker({ value, onChange, onClose }: { value: string; onChange: (hex: string) => void; onClose: () => void }) {
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(value || "#888888"));
  const [hexText, setHexText] = useState(value || "#888888");
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<"sv" | "hue" | null>(null);

  function apply(next: [number, number, number]) {
    setHsv(next);
    const hex = hsvToHex(next[0], next[1], next[2]);
    setHexText(hex);
    onChange(hex);
  }
  function fromSv(clientX: number, clientY: number) {
    const el = svRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const v = Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
    apply([hsv[0], s, v]);
  }
  function fromHue(clientX: number) {
    const el = hueRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const h = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 360;
    apply([h, hsv[1], hsv[2]]);
  }
  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (dragRef.current === "sv") fromSv(e.clientX, e.clientY);
      else if (dragRef.current === "hue") fromHue(e.clientX);
    }
    function onUp() { dragRef.current = null; }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  });

  const hueHex = hsvToHex(hsv[0], 1, 1);
  const thumbHex = hsvToHex(hsv[0], hsv[1], hsv[2]);
  return (
    <div className="color-picker" onMouseDown={(e) => e.stopPropagation()}>
      <div
        ref={svRef}
        className="cp-sv"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueHex})` }}
        onPointerDown={(e) => { dragRef.current = "sv"; fromSv(e.clientX, e.clientY); }}
      >
        <span className="cp-sv-thumb" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: thumbHex }} />
      </div>
      <div ref={hueRef} className="cp-hue" onPointerDown={(e) => { dragRef.current = "hue"; fromHue(e.clientX); }}>
        <span className="cp-hue-thumb" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      <div className="cp-foot">
        <span className="cp-preview" style={{ background: thumbHex }} />
        <input
          className="cp-hex"
          value={hexText}
          onChange={(e) => {
            setHexText(e.target.value);
            if (isHex(e.target.value)) {
              const hex = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
              setHsv(hexToHsv(hex));
              onChange(hex);
            }
          }}
        />
        <button type="button" className="cp-done" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function ColorsSection({ settings, patch }: { settings: Settings; patch: (next: Partial<Settings>) => void }) {
  type ColorTarget = { kind: "accent"; provider: Provider } | { kind: "monitor"; monitor: MonitorKind };
  type PickerTarget = { kind: "accent"; provider: Provider } | { kind: "monitor"; monitor: MonitorKind; level: MonitorLevel } | { kind: "base"; field: "bg" | "surface" | "text" };
  const [selectedTarget, setSelectedTarget] = useState<ColorTarget | null>(null);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [monitorLevel, setMonitorLevel] = useState<MonitorLevel>("low");
  const themeKey = settings.theme;
  const mode = baseModeOf(themeKey);
  const base = settings.baseOverrides[themeKey] ?? {};
  const resolvedBase = resolveBaseTokens(themeKey, base) ?? DEFAULT_BASE[themeKey];
  const providers = settings.accounts.map((account) => ({ ...account, brand: accountBrandColor(account.kind, settings.theme) }));
  const monitorLevels: [MonitorLevel, string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
  const baseFieldValue = (field: "bg" | "surface" | "text") => field === "text" ? resolvedBase.fg : resolvedBase[field];

  const setProviderColor = (provider: Provider, color: string | null) => {
    const providerColors = { ...settings.providerColors };
    if (color) providerColors[provider] = color;
    else delete providerColors[provider];
    patch({ providerColors });
  };
  const setMonitorColor = (m: MonitorKind, level: MonitorLevel, color: string) => patch({ monitorColors: { ...settings.monitorColors, [m]: { ...settings.monitorColors[m], [level]: color } } });
  const setScope = (key: keyof ColorScope, val: boolean) => patch({ colorScope: { ...settings.colorScope, [key]: val } });
  const setBase = (next: Partial<BaseOverride>) => patch({ baseOverrides: { ...settings.baseOverrides, [themeKey]: { ...base, ...next } } });
  const resetBase = () => { const nb = { ...settings.baseOverrides }; delete nb[themeKey]; patch({ baseOverrides: nb }); };
  const targetIsSelected = (target: ColorTarget) => {
    if (!selectedTarget || selectedTarget.kind !== target.kind) return false;
    return target.kind === "accent"
      ? selectedTarget.kind === "accent" && selectedTarget.provider === target.provider
      : selectedTarget.kind === "monitor" && selectedTarget.monitor === target.monitor;
  };
  const pickerMatches = (target: PickerTarget) => {
    if (!picker || picker.kind !== target.kind) return false;
    if (target.kind === "accent") return picker.kind === "accent" && picker.provider === target.provider;
    if (target.kind === "monitor") return picker.kind === "monitor" && picker.monitor === target.monitor && picker.level === target.level;
    return picker.kind === "base" && picker.field === target.field;
  };
  const chooseTarget = (target: ColorTarget) => {
    if (targetIsSelected(target)) {
      setSelectedTarget(null);
      setPicker(null);
      return;
    }
    setSelectedTarget(target);
    setPicker(null);
    if (target.kind === "monitor") setMonitorLevel("low");
  };
  const openPicker = (target: ColorTarget) => {
    setSelectedTarget(target);
    const pickerTarget: PickerTarget = target.kind === "monitor" ? { ...target, level: monitorLevel } : target;
    setPicker(pickerMatches(pickerTarget) ? null : pickerTarget);
  };
  const selectedLabel = selectedTarget?.kind === "accent"
    ? providers.find((account) => account.id === selectedTarget.provider)?.label
    : selectedTarget ? MONITOR_LABELS[selectedTarget.monitor] : undefined;
  const selectedMonitorPalette = selectedTarget?.kind === "monitor" ? settings.monitorColors[selectedTarget.monitor] : null;

  useEffect(() => {
    if (selectedTarget?.kind !== "accent" || settings.accounts.some((account) => account.id === selectedTarget.provider)) return;
    setSelectedTarget(null);
    setPicker(null);
  }, [selectedTarget, settings.accounts]);

  return (
    <div className="effect-settings colors-settings">
      <div className="feature-settings-body">
      <div className="color-target-group">
        <span className="color-group-label">Providers</span>
        <div className="color-target-grid">
          {providers.map((account) => {
            const provider = account.id;
            const color = settings.providerColors[provider] ?? account.brand;
            const target: ColorTarget = { kind: "accent", provider };
            return (
              <button type="button" className={`color-target${targetIsSelected(target) ? " is-selected" : ""}`} style={{ "--tone": color } as React.CSSProperties} key={provider} onClick={() => chooseTarget(target)} aria-expanded={targetIsSelected(target)}>
                <ProviderMark provider={provider} />
                <span className="color-target-copy"><span className="color-target-name">{account.label}</span><small>{account.kind}</small></span>
                <span className="color-target-preview"><i style={{ background: color }} /></span>
              </button>
            );
          })}
          {!providers.length && <span className="color-empty">No accounts added</span>}
        </div>
      </div>

      {(
        <div className="color-target-group">
          <span className="color-group-label">System monitors</span>
          <div className="color-target-grid">
            {MONITOR_ORDER.map((kind) => {
              const target: ColorTarget = { kind: "monitor", monitor: kind };
              const palette = settings.monitorColors[kind];
              return (
                <button type="button" className={`color-target${targetIsSelected(target) ? " is-selected" : ""}`} style={{ "--tone": palette.low } as React.CSSProperties} key={kind} onClick={() => chooseTarget(target)} aria-expanded={targetIsSelected(target)}>
                  <MonitorMark kind={kind} />
                  <span className="color-target-name">{MONITOR_FULL_LABELS[kind]}</span>
                  <span className="color-target-preview monitor-preview">
                    <i style={{ background: palette.low }} /><i style={{ background: palette.medium }} /><i style={{ background: palette.high }} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selectedTarget && (
        <div className="color-editor">
          <div className="color-editor-head">
            <span>Editing <strong>{selectedLabel}</strong></span>
            <button type="button" className="color-editor-close" onClick={() => { setSelectedTarget(null); setPicker(null); }}>Close</button>
          </div>
          {selectedTarget.kind === "accent" && (() => {
            const provider = selectedTarget.provider;
            const brand = providers.find((account) => account.id === provider)?.brand ?? "#7b8cff";
            const target: ColorTarget = { kind: "accent", provider };
            const pickerTarget: PickerTarget = target;
            const current = settings.providerColors[provider] ?? brand;
            return (
              <div className="color-editor-body">
                <span className="color-editor-caption">Accent</span>
                <div className="swatch-row">
                  {ACCENT_PRESETS.map((color) => <button type="button" key={color} className={`swatch${current.toLowerCase() === color.toLowerCase() ? " is-active" : ""}`} style={{ background: color }} title={color} onClick={() => setProviderColor(provider, color)} />)}
                  <button type="button" className={`swatch swatch-custom${pickerMatches(pickerTarget) ? " is-active" : ""}`} title="Custom color" onClick={() => openPicker(target)}>+</button>
                  <button type="button" className="swatch swatch-reset" title="Reset to brand" onClick={() => { setProviderColor(provider, null); setPicker(null); }}>⟲</button>
                </div>
                {pickerMatches(pickerTarget) && <ColorPicker value={current} onChange={(color) => setProviderColor(provider, color)} onClose={() => setPicker(null)} />}
              </div>
            );
          })()}
          {selectedTarget.kind === "monitor" && selectedMonitorPalette && (() => {
            const target: ColorTarget = selectedTarget;
            const current = selectedMonitorPalette[monitorLevel];
            const levelLabel = monitorLevels.find(([level]) => level === monitorLevel)?.[1] ?? "Low";
            const pickerTarget: PickerTarget = { ...target, level: monitorLevel };
            return (
              <div className="color-editor-body">
                <div className="monitor-level-tabs">
                  {monitorLevels.map(([level, label]) => <button type="button" key={level} className={`monitor-level-tab${monitorLevel === level ? " is-active" : ""}`} onClick={() => { setMonitorLevel(level); setPicker(null); }}><i style={{ background: selectedMonitorPalette[level] }} />{label}</button>)}
                </div>
                <span className="color-editor-caption">{levelLabel} color</span>
                <div className="swatch-row">
                  {MONITOR_ACCENT_PRESETS.map((color) => <button type="button" key={color} className={`swatch${current.toLowerCase() === color.toLowerCase() ? " is-active" : ""}`} style={{ background: color }} title={color} onClick={() => setMonitorColor(selectedTarget.monitor, monitorLevel, color)} />)}
                  <button type="button" className={`swatch swatch-custom${pickerMatches(pickerTarget) ? " is-active" : ""}`} title={`Custom ${levelLabel.toLowerCase()} color`} onClick={() => openPicker(target)}>+</button>
                  <button type="button" className="swatch swatch-reset" title={`Reset ${levelLabel.toLowerCase()} color`} onClick={() => { setMonitorColor(selectedTarget.monitor, monitorLevel, DEFAULT_MONITOR_PALETTE[monitorLevel]); setPicker(null); }}>⟲</button>
                </div>
                {pickerMatches(pickerTarget) && <ColorPicker value={current} onChange={(color) => setMonitorColor(selectedTarget.monitor, monitorLevel, color)} onClose={() => setPicker(null)} />}
              </div>
            );
          })()}
        </div>
      )}

      <div className="colors-advanced">
        <div className="color-row">
          <span className="seg-label">Apply accent to</span>
          <div className="scope-checks">
            {([["text", "Text"], ["bar", "Bar"], ["border", "Border"], ["bgTint", "Tint"]] as [keyof ColorScope, string][]).map(([key, label]) => (
              <label className="scope-check" key={key}><input className="switch-control" type="checkbox" role="switch" checked={settings.colorScope[key]} onChange={(event) => setScope(key, event.target.checked)} /><span>{label}</span></label>
            ))}
          </div>
        </div>

        <div className="color-row">
          <span className="seg-label">Base — {mode} theme</span>
          <div className="base-presets">
            {BASE_PRESETS[mode].map((preset) => (
              <button type="button" key={preset.id} className={`base-chip${base.preset === preset.id ? " is-active" : ""}`} onClick={() => setBase({ preset: preset.id })}>
                <span className="base-chip-swatch" style={{ background: preset.bg, borderColor: preset.border }}><i style={{ background: preset.fg }} /><em style={{ background: preset.surface2 }} /></span>
                {preset.name}
              </button>
            ))}
          </div>
          <div className="base-fine">
            {([["bg", "Background"], ["surface", "Surface"], ["text", "Text"]] as ["bg" | "surface" | "text", string][]).map(([field, label]) => {
              const target: PickerTarget = { kind: "base", field };
              return <button type="button" key={field} className={`fine-swatch${pickerMatches(target) ? " is-active" : ""}`} onClick={() => setPicker(pickerMatches(target) ? null : target)}>{field === "bg" && <span className="fine-ic" style={{ background: baseFieldValue("bg") }} />}{field === "surface" && <span className="fine-ic fine-ic-surface" style={{ background: baseFieldValue("bg") }}><i style={{ background: baseFieldValue("surface") }} /></span>}{field === "text" && <span className="fine-ic fine-ic-text" style={{ background: baseFieldValue("surface"), color: baseFieldValue("text") }}>Aa</span>}{label}</button>;
            })}
            <button type="button" className="base-reset" onClick={() => { resetBase(); setPicker(null); }}>Reset base</button>
          </div>
          {picker?.kind === "base" && <ColorPicker value={baseFieldValue(picker.field)} onChange={(color) => setBase({ [picker.field]: color })} onClose={() => setPicker(null)} />}
        </div>
      </div>
      </div>
    </div>
  );
}

// Phase 2: install/remove the elevated LibreHardwareMonitor sidecar that supplies CPU temperature.
function SensorServiceSettings() {
  const [status, setStatus] = useState<string>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await invoke<string>("sensor_service_status")); } catch { setStatus("missing"); }
  }, []);

  useEffect(() => {
    if (status === "asus" || status === "asus_installed") return;
    const poll = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    poll();
    const id = window.setInterval(poll, 6000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh, status]);

  async function run(command: "install_sensor_service" | "uninstall_sensor_service") {
    setBusy(true);
    setError(null);
    try {
      await invoke(command);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const asus = status === "asus" || status === "asus_installed";
  if (asus || status === "checking") return null;
  const running = status === "running";
  const installed = running || status === "installed";
  const label = running ? "running" : installed ? "installed" : "not installed";

  return (
    <div className="sensor-service">
      <div className="sensor-service-head">
        <span>CPU temperature fallback</span>
        <strong className={running ? "ok" : installed ? "warn" : ""}>{label}</strong>
      </div>
      <p className="monitor-note">
        LibreHardwareMonitor fallback for machines without a built-in sensor source. It needs admin once and may trigger an antivirus warning.
      </p>
      <div className="sensor-service-actions">
        {!installed ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void run("install_sensor_service")}>
            {busy ? "Working…" : "Install (needs admin)"}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void run("uninstall_sensor_service")}>
            {busy ? "Working…" : "Remove"}
          </button>
        )}
      </div>
      {error && <p className="settings-warn">{error}</p>}
    </div>
  );
}

// Small marks for the General overview cards.
function AiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.2l1.7 4.6 4.6 1.7-4.6 1.7L12 15.8l-1.7-4.6L5.7 9.5l4.6-1.7z" />
      <path d="M18.4 15.2l.65 1.75 1.75.65-1.75.65-.65 1.75-.65-1.75-1.75-.65 1.75-.65z" />
    </svg>
  );
}
function MonitorsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="1.6" />
      <path d="M8.5 20h7M12 17v3" />
      <path d="M6.6 12l1.9-2.6 2 3 2-4 1.9 3.4" />
    </svg>
  );
}

function AboutPanel({ settings, patch }: { settings: Settings; patch: (next: Partial<Settings>) => void }) {
  const [version, setVersion] = useState<string>("");
  useEffect(() => { void getVersion().then(setVersion).catch(() => setVersion("")); }, []);
  return (
    <div className="settings-about">
      <div className="mini-head">
        <div className="settings-card-title">
          <h2>UsageView</h2>
          <span>{version ? `Version ${version}` : "Version —"}</span>
        </div>
      </div>
      <p className="about-p">Each account signs in through its own isolated in-app window. There are no API keys and no browser-cookie import — login sessions, snapshots and settings stay on this device.</p>
      <p className="about-p muted">Removing an account deletes its local login profile and snapshot; your Claude/OpenAI account itself is never touched.</p>
      <p className="about-p muted">Built with React and Tauri v2. Fonts: Space Grotesk, JetBrains Mono.</p>
      <label className="toggle-row">
        <span>Developer mode</span>
        <input className="switch-control" type="checkbox" role="switch" checked={settings.developerMode} onChange={(event) => patch({ developerMode: event.target.checked })} />
      </label>
      <p className="about-p muted">Developer mode shows effect testing, API inspection, extraction diagnostics and custom account URLs.</p>
    </div>
  );
}

function WidgetSettings({ settings, onChange, accountPanels, activeTab, widgetMode, onSetMode, onRefreshAll, widgetVisible, widgetToggleBusy, onToggleWidget, monitorReadings, statusTone, statusMessage, onEffectPlay, onEffectRestore, onMonitorEffectPlay, onMonitorEffectRestore, providerPercents }: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  accountPanels: ReactNode;
  activeTab: SettingsTab;
  widgetMode: AppMode;
  onSetMode: (mode: AppMode) => void;
  onRefreshAll: () => void;
  widgetVisible: boolean | null;
  widgetToggleBusy: boolean;
  onToggleWidget: () => void;
  monitorReadings: Record<MonitorKind, MonitorReading>;
  statusTone: SettingsHeaderTone;
  statusMessage: string;
  onEffectPlay: (provider: Provider, from: number, to: number, driveBar: boolean) => void;
  onEffectRestore: () => void;
  onMonitorEffectPlay: (kind: MonitorKind, value: number) => void;
  onMonitorEffectRestore: () => void;
  providerPercents: Partial<Record<Provider, number>>;
}) {
  function patch(next: Partial<Settings>) {
    onChange({ ...settings, ...next });
  }

  // One compact tester drives either the account effect or a temporary system-monitor reading.
  const [testMode, setTestMode] = useState<"ai" | "monitor">("ai");
  const [testProvider, setTestProvider] = useState<Provider>(() => settings.accounts[0]?.id ?? "");
  const [testFrom, setTestFrom] = useState(36);
  const [testTo, setTestTo] = useState(37);
  const [driveBar, setDriveBar] = useState(false);
  const initialTestMonitor = MONITOR_ORDER.find((kind) => settings.systemMonitorsEnabled && settings[MONITOR_SHOW_KEY[kind]] as boolean) ?? "cputemp";
  const [testMonitor, setTestMonitor] = useState<MonitorKind>(initialTestMonitor);
  const [testMonitorValue, setTestMonitorValue] = useState(63);
  const testable = settings.effectsEnabled;
  const aiPresets: [string, number, number][] = [["Small · 36→37", 36, 37], ["High · 80→81", 80, 81], ["Fill · 0→63", 0, 63], ["Edge · 99→100", 99, 100], ["Full · 0→100", 0, 100]];
  const selectedTestProvider = settings.accounts.some((account) => account.id === testProvider) ? testProvider : settings.accounts[0]?.id ?? "";
  const shownTestMonitors = settings.systemMonitorsEnabled
    ? MONITOR_ORDER.filter((kind) => settings[MONITOR_SHOW_KEY[kind]] as boolean)
    : [];
  const selectedTestMonitor = shownTestMonitors.includes(testMonitor) ? testMonitor : shownTestMonitors[0];

  function monitorPresetValue(kind: MonitorKind, level: MonitorLevel) {
    const temperature = kind === "cputemp" || kind === "gputemp";
    if (level === "low") return temperature ? 63 : 37;
    if (level === "medium") return temperature ? 73 : 63;
    return 88;
  }

  function play(from: number, to: number) {
    if (selectedTestProvider) onEffectPlay(selectedTestProvider, from, to, driveBar);
  }
  function stepUp() {
    const from = Math.max(0, Math.min(100, testTo));
    const to = Math.min(100, from + 1);
    play(from, to);
    setTestFrom(from);
    setTestTo(to);
  }
  function loadCurrent() {
    const cur = providerPercents[selectedTestProvider];
    if (typeof cur === "number") { setTestFrom(cur); setTestTo(Math.min(100, cur + 1)); }
  }

  function playMonitor(value = testMonitorValue) {
    if (selectedTestMonitor) onMonitorEffectPlay(selectedTestMonitor, value);
  }

  // The refresh interval applies to ALL providers. Values >=60s apply immediately; values below 60s
  // are held behind an explicit confirmation because frequent refreshing costs resources and can be
  // rate-limited by the providers.
  const [secondsDraft, setSecondsDraft] = useState(String(settings.refreshIntervalSec));
  const [pendingLow, setPendingLow] = useState<number | null>(null);

  useEffect(() => {
    setSecondsDraft(String(settings.refreshIntervalSec));
    setPendingLow(null);
  }, [settings.refreshIntervalSec]);

  function commitSeconds() {
    const parsed = Math.round(Number(secondsDraft));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setSecondsDraft(String(settings.refreshIntervalSec));
      setPendingLow(null);
      return;
    }
    const clamped = Math.max(10, parsed);
    if (clamped >= 60) {
      setPendingLow(null);
      if (clamped !== settings.refreshIntervalSec) patch({ refreshIntervalSec: clamped });
      setSecondsDraft(String(clamped));
    } else {
      setPendingLow(clamped); // require explicit confirmation before applying
    }
  }

  function confirmLow() {
    if (pendingLow === null) return;
    patch({ refreshIntervalSec: pendingLow });
    setSecondsDraft(String(pendingLow));
    setPendingLow(null);
  }

  function cancelLow() {
    setSecondsDraft(String(settings.refreshIntervalSec));
    setPendingLow(null);
  }

  const shownAccountCount = settings.accounts.filter((a) => providerEnabled(a.id, settings)).length;
  const shownMonitorCount = settings.systemMonitorsEnabled ? MONITOR_ORDER.filter((k) => settings[MONITOR_SHOW_KEY[k]] as boolean).length : 0;

  return (
    <section className="settings-section mini-card settings-card">
      {activeTab === "general" && (
        <>
          <div className={`general-status ${statusTone}`}>
            <span className="settings-health-dot" aria-hidden="true" />
            <span className="general-status-msg">{statusMessage}</span>
          </div>
          <div className="general-summary">
            <span><strong>{shownAccountCount}</strong> {shownAccountCount === 1 ? "account" : "accounts"}</span>
            <span><strong>{shownMonitorCount}</strong> {shownMonitorCount === 1 ? "sensor" : "sensors"}</span>
          </div>
          <div className="settings-group">
            <h3 className="settings-group-title">Widget</h3>
            <div className="setting-card">
              <span className="setting-card-text">
                <span className="setting-card-label">View mode</span>
                <small className="setting-card-desc">Full or compact widget</small>
              </span>
              <div className="seg" role="group" aria-label="View mode">
                <button type="button" className={`seg-btn${widgetMode === "widget" ? " active" : ""}`} aria-pressed={widgetMode === "widget"} onClick={() => onSetMode("widget")}>Full</button>
                <button type="button" className={`seg-btn${widgetMode === "mini" ? " active" : ""}`} aria-pressed={widgetMode === "mini"} onClick={() => onSetMode("mini")}>Mini</button>
              </div>
            </div>
            <label className="setting-card">
              <span className="setting-card-icon"><AiIcon /></span>
              <span className="setting-card-text">
                <span className="setting-card-label">AI usage</span>
                <small className="setting-card-desc">Track Claude &amp; Codex usage</small>
              </span>
              <input className="switch-control" type="checkbox" role="switch" checked={settings.aiUsageEnabled} onChange={(event) => patch({ aiUsageEnabled: event.target.checked })} />
            </label>
            <label className="setting-card">
              <span className="setting-card-icon"><MonitorsIcon /></span>
              <span className="setting-card-text">
                <span className="setting-card-label">System monitors</span>
                <small className="setting-card-desc">Local CPU / RAM / GPU readings</small>
              </span>
              <input className="switch-control" type="checkbox" role="switch" checked={settings.systemMonitorsEnabled} onChange={(event) => patch({ systemMonitorsEnabled: event.target.checked })} />
            </label>
            <label className="setting-card">
              <span className="setting-card-text">
                <span className="setting-card-label">Always on top</span>
                <small className="setting-card-desc">Keep the widget above other windows</small>
              </span>
              <input className="switch-control" type="checkbox" role="switch" checked={settings.alwaysOnTop} onChange={(event) => patch({ alwaysOnTop: event.target.checked })} />
            </label>
          </div>

          <div className="settings-group">
            <h3 className="settings-group-title">Actions</h3>
            <div className="general-actions">
              <button type="button" className="refresh-all-btn" onClick={onToggleWidget} disabled={widgetVisible === null || widgetToggleBusy}>
                {widgetToggleBusy ? "Updating..." : widgetVisible === null ? "Checking..." : widgetVisible ? "Hide widget" : "Show widget"}
              </button>
              <button type="button" className="refresh-all-btn" onClick={onRefreshAll}>Refresh all</button>
            </div>
          </div>

          {settings.developerMode && (
            <div className="settings-group">
              <h3 className="settings-group-title">Developer</h3>
              <div className="settings-row">
                <div className="seg-field">
                  <span className="seg-label">Refresh (enabled AIs)</span>
                  <div className="num-field">
                    <input
                      type="number"
                      min="10"
                      value={secondsDraft}
                      onChange={(event) => setSecondsDraft(event.target.value)}
                      onBlur={commitSeconds}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitSeconds(); } }}
                    />
                    <span className="num-unit">sec</span>
                  </div>
                </div>
                <div className="seg-field">
                  <span className="seg-label">Monitor update</span>
                  <div className="num-field">
                    <input
                      type="number"
                      min="1"
                      max="10"
                      step="1"
                      value={settings.monitorIntervalSec}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isInteger(next) && next >= 1 && next <= 10) patch({ monitorIntervalSec: next });
                      }}
                    />
                    <span className="num-unit">sec</span>
                  </div>
                </div>
              </div>
              {pendingLow !== null && (
                <div className="settings-warn">
                  <span>Under 60s refreshes more often — costs more resources and may get rate-limited. Apply {pendingLow}s anyway?</span>
                  <div className="settings-warn-actions">
                    <button className="primary" onClick={confirmLow}>Apply {pendingLow}s</button>
                    <button onClick={cancelLow}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {activeTab === "accounts" && (
        <div className="effect-settings ai-usage-settings">
          <div className="feature-settings-body ai-accounts-body">
            <span className="ai-accounts-label">Accounts</span>
            {accountPanels}
          </div>
        </div>
      )}

      {activeTab === "appearance" && (
        <>
          <div className="settings-row">
            <div className="seg-field">
              <span className="seg-label">Style</span>
              <div className="seg" role="group" aria-label="Theme style">
                <button type="button" className={`seg-btn${themeStyle(settings.theme) === "pixel" ? " active" : ""}`} aria-pressed={themeStyle(settings.theme) === "pixel"} onClick={() => patch({ theme: composeTheme("pixel", themeMode(settings.theme)) })}>Pixel</button>
                <button type="button" className={`seg-btn${themeStyle(settings.theme) === "glass" ? " active" : ""}`} aria-pressed={themeStyle(settings.theme) === "glass"} onClick={() => patch({ theme: composeTheme("glass", themeMode(settings.theme)) })}>Glass</button>
              </div>
            </div>
            <div className="seg-field">
              <span className="seg-label">Mode</span>
              <ModeSwitch
                mode={themeMode(settings.theme)}
                onToggle={() => patch({ theme: composeTheme(themeStyle(settings.theme), themeMode(settings.theme) === "light" ? "dark" : "light") })}
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="seg-field">
              <span className="seg-label">Zoom (Full view)</span>
              <ThemedSelect
                ariaLabel="Full view zoom"
                value={settings.uiScale}
                options={ZOOM_OPTIONS}
                onChange={(value) => patch({ uiScale: value })}
              />
            </div>
            <div className="seg-field">
              <span className="seg-label">Opacity <span className="seg-value">{Math.round(settings.opacity * 100)}%</span></span>
              <input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(event) => patch({ opacity: Number(event.target.value) })} />
            </div>
          </div>
          <div className="effect-settings">
            <FeatureSwitch label="Enable effect" checked={settings.effectsEnabled} onChange={(effectsEnabled) => patch({ effectsEnabled })} />
            {settings.effectsEnabled && settings.developerMode && <div className="feature-settings-body">
            <details className="effect-tester">
              <summary><span className="summary-left"><svg className="disclosure-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg><span>Effect tester</span></span></summary>
              <div className="effect-tester-body">
                <div className="seg effect-tester-tabs" role="tablist" aria-label="Effect type">
                  <button type="button" className={`seg-btn${testMode === "ai" ? " active" : ""}`} role="tab" aria-selected={testMode === "ai"} disabled={!settings.accounts.length} onClick={() => setTestMode("ai")}>AI usage</button>
                  <button type="button" className={`seg-btn${testMode === "monitor" ? " active" : ""}`} role="tab" aria-selected={testMode === "monitor"} disabled={!shownTestMonitors.length} onClick={() => setTestMode("monitor")}>System monitor</button>
                </div>
                {widgetMode !== "widget" && <div className="effect-tester-hint"><span>Effects are visible in Full view.</span><button type="button" onClick={() => onSetMode("widget")}>Use Full</button></div>}
                {testMode === "ai" ? (
                  <>
                    <div className="effect-tester-grid effect-tester-targets">
                      <label>Account<select value={selectedTestProvider} onChange={(event) => setTestProvider(event.target.value as Provider)}>
                        {settings.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
                      </select></label>
                      <label>Scenario<select value="" onChange={(event) => {
                        if (event.target.value === "") return;
                        const preset = aiPresets[Number(event.target.value)];
                        if (!preset) return;
                        setTestFrom(preset[1]);
                        setTestTo(preset[2]);
                      }}>
                        <option value="">Custom</option>
                        {aiPresets.map(([label], index) => <option key={label} value={index}>{label}</option>)}
                      </select></label>
                    </div>
                    <div className="effect-tester-grid effect-tester-values">
                      <label>From<input type="number" min="0" max="100" value={testFrom} onChange={(event) => setTestFrom(Number(event.target.value))} /></label>
                      <label>To<input type="number" min="0" max="100" value={testTo} onChange={(event) => setTestTo(Number(event.target.value))} /></label>
                      <button type="button" onClick={loadCurrent} title="Load this account's current %">Current</button>
                    </div>
                    <label className="toggle-row effect-tester-toggle">
                      <span>Move bar to the test value</span>
                      <input className="switch-control" type="checkbox" role="switch" checked={driveBar} onChange={(event) => setDriveBar(event.target.checked)} />
                    </label>
                    <div className="effect-tester-actions">
                      <button type="button" className="primary" disabled={!testable || !selectedTestProvider} onClick={() => play(testFrom, testTo)}>Play</button>
                      <button type="button" disabled={!testable || !selectedTestProvider} onClick={stepUp}>Step +1%</button>
                      <button type="button" onClick={onEffectRestore}>Restore</button>
                    </div>
                  </>
                ) : selectedTestMonitor ? (
                  <>
                    <div className="effect-tester-grid effect-tester-monitor-fields">
                      <label>Sensor<select value={selectedTestMonitor} onChange={(event) => {
                        const kind = event.target.value as MonitorKind;
                        setTestMonitor(kind);
                        setTestMonitorValue(monitorPresetValue(kind, "low"));
                      }}>
                        {shownTestMonitors.map((kind) => <option key={kind} value={kind}>{MONITOR_FULL_LABELS[kind]}</option>)}
                      </select></label>
                      <label>Value<input type="number" min="0" max="100" value={testMonitorValue} onChange={(event) => setTestMonitorValue(Number(event.target.value))} /></label>
                    </div>
                    <div className="effect-monitor-levels" role="group" aria-label="Monitor test level">
                      {(["low", "medium", "high"] as MonitorLevel[]).map((level) => {
                        const value = monitorPresetValue(selectedTestMonitor, level);
                        return <button type="button" key={level} className={testMonitorValue === value ? "active" : ""} onClick={() => { setTestMonitorValue(value); playMonitor(value); }}>{level} {value}{selectedTestMonitor === "cputemp" || selectedTestMonitor === "gputemp" ? "°" : "%"}</button>;
                      })}
                    </div>
                    <p className="effect-tester-note">Temporary test value · restores automatically after 12 seconds.</p>
                    <div className="effect-tester-actions two">
                      <button type="button" className="primary" disabled={!testable} onClick={() => playMonitor()}>Play</button>
                      <button type="button" onClick={onMonitorEffectRestore}>Restore</button>
                    </div>
                  </>
                ) : <p className="effect-tester-note">Show a system-monitor sensor first, then reopen this tester.</p>}
              </div>
            </details>
            </div>}
          </div>
          <ColorsSection settings={settings} patch={patch} />
        </>
      )}

      {activeTab === "monitors" && (
        <>
          <div className="settings-group">
            <h3 className="settings-group-title">Sensors</h3>
            {MONITOR_ORDER.map((k) => {
              const shown = settings[MONITOR_SHOW_KEY[k]] as boolean;
              const r = monitorReadings[k];
              const tone = r && r.available ? monitorTone(settings, r) : settings.monitorColors[k].low;
              return (
                <section className="mini-card monitor-sensor-card" key={k} style={{ "--tone": tone, "--provider-color": tone } as React.CSSProperties}>
                  <div className="mini-head">
                    <div>
                      <h2><MonitorMark kind={k} />{MONITOR_FULL_LABELS[k]}</h2>
                      <p className="account-usage">{r && r.available ? (r.sub ?? r.displayValue) : "Not detected"}</p>
                    </div>
                    <StatusPill status={shown ? "ok" : "warn"} label={shown ? "shown" : "hidden"} />
                  </div>
                  <div className="daily-actions">
                    <span className="sensor-value">{r && r.available ? r.displayValue : "—"}</span>
                    <button className="primary" onClick={() => {
                      patch({ [MONITOR_SHOW_KEY[k]]: !shown } as Partial<Settings>);
                      void emitTo("widget", "usageview-monitor-toast", { label: MONITOR_LABELS[k], shown: !shown }).catch(() => undefined);
                    }}>{shown ? "Hide widget" : "Show widget"}</button>
                  </div>
                </section>
              );
            })}
          </div>
          <div className="settings-group">
            <h3 className="settings-group-title">Sensor service</h3>
            <SensorServiceSettings />
          </div>
        </>
      )}

      {activeTab === "about" && <AboutPanel settings={settings} patch={patch} />}
    </section>
  );
}

function EmptyProviderState() {
  return (
    <article className="empty-state">
      <strong>No accounts yet</strong>
      <span>Open Settings and use “Add account” to add a Claude or Codex login.</span>
    </article>
  );
}

function AddAccountForm({ onAdd, onCancel }: { onAdd: (kind: AccountKind, label: string) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<AccountKind>("claude");
  const [label, setLabel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="add-account-form">
      <div className="mini-head"><div><h2>Add account</h2><p>Pick a service, name it, then sign in.</p></div></div>
      <div className="seg-field">
        <span className="seg-label">Service</span>
        <div className="seg" role="group" aria-label="Account type">
          <button type="button" className={`seg-btn${kind === "claude" ? " active" : ""}`} aria-pressed={kind === "claude"} onClick={() => setKind("claude")}>Claude</button>
          <button type="button" className={`seg-btn${kind === "codex" ? " active" : ""}`} aria-pressed={kind === "codex"} onClick={() => setKind("codex")}>Codex</button>
        </div>
      </div>
      <label className="url-field">Account name
        <input ref={inputRef} value={label} placeholder={kind === "claude" ? "e.g. Claude work" : "e.g. Codex personal"} onChange={(event) => setLabel(event.target.value.toLocaleUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") onAdd(kind, label); }} />
      </label>
      <div className="daily-actions modal-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={() => onAdd(kind, label)}>Add &amp; sign in</button>
      </div>
    </div>
  );
}

const RESET_TIMESTAMP_MIN_MS = 1_000_000_000_000;
const RESET_TIMESTAMP_MAX_FUTURE_MS = 366 * 86_400_000;
const LEGACY_RESET_NEXT_YEAR_HORIZON_MS = 8 * 86_400_000;

function validResetAtMs(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < RESET_TIMESTAMP_MIN_MS || value > now + RESET_TIMESTAMP_MAX_FUTURE_MS) return null;
  return value;
}

function parseResetMs(resetLabel?: string): number | null {
  if (!resetLabel) return null;
  const stripped = resetLabel.replace(/^Reset\s+/i, "").trim();
  const now = Date.now();
  const year = new Date(now).getFullYear();
  const hasExplicitYear = /\b\d{4}\b/.test(stripped);
  const horizon = hasExplicitYear ? RESET_TIMESTAMP_MAX_FUTURE_MS : LEGACY_RESET_NEXT_YEAR_HORIZON_MS;
  for (const candidate of [stripped, `${stripped}, ${year}`, `${stripped} ${year}`]) {
    const d = new Date(candidate);
    if (!isNaN(d.getTime()) && d.getTime() > now - 60_000 && d.getTime() <= now + horizon) return d.getTime();
  }
  if (!hasExplicitYear) {
    for (const candidate of [`${stripped}, ${year + 1}`, `${stripped} ${year + 1}`]) {
      const d = new Date(candidate);
      if (!isNaN(d.getTime()) && d.getTime() > now - 60_000 && d.getTime() <= now + LEGACY_RESET_NEXT_YEAR_HORIZON_MS) return d.getTime();
    }
  }
  return null;
}

function snapshotResetMs(snapshot: UsageSnapshot): number | null {
  return validResetAtMs(snapshot.resetAtMs) ?? parseResetMs(snapshot.resetLabel);
}

function countdownParts(resetMs: number): { days: number; clock: string } | null {
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return null;
  const d = Math.floor(remaining / 86_400_000);
  const h = Math.floor((remaining % 86_400_000) / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  const s = Math.floor((remaining % 60_000) / 1_000);
  const hh = d > 0 ? String(h).padStart(2, "0") : String(h);
  return { days: d, clock: `${hh}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` };
}

// Renders "6d | 23:30:12" — a dimmed day count + thin divider before the live ticking clock (the divider
// and days appear only when >=24h remain). Falls back to a text label when there's no live countdown.
function CountdownFace({ resetMs, fallback }: { resetMs: number | null; fallback: string }) {
  const parts = resetMs !== null ? countdownParts(resetMs) : null;
  if (!parts) return <>{fallback}</>;
  return (
    <>
      {parts.days > 0 && (
        <>
          <span className="count-days">{parts.days}d</span>
          <span className="count-divider" aria-hidden="true" />
        </>
      )}
      {parts.clock}
    </>
  );
}

function TimerView({ snapshot, accent, onBack, paused = false }: { snapshot: UsageSnapshot; accent?: string; onBack: () => void; paused?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const resetMs = snapshotResetMs(snapshot);
  return (
    <article className={`usage compact provider-tile ${providerKind(snapshot.provider)} timer-view flippable${paused ? " mark-paused" : ""}`} style={providerAccentStyle(accent)} onClick={onBack} title="Tap to dismiss">
      <div className="usage-top">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="timer-label">reset in</span>
      </div>
      <div className="timer-clock"><CountdownFace resetMs={resetMs} fallback={resetMs !== null || snapshot.resetLabel ? "Resetting soon" : "—"} /></div>
      <div className="timer-sub">
        {snapshot.resetLabel && <span>{snapshot.resetLabel}</span>}
        <span className="timer-hint">tap to dismiss</span>
      </div>
    </article>
  );
}

function snapshotPercent(snapshot: UsageSnapshot): number | undefined {
  return typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
}

let usageEffectSequence = 0;

function makeUsageEffect(from: number, to: number): UsageEffect {
  return { id: ++usageEffectSequence, from, to };
}

const GLASS_WAVE_WIDTH = 180;
const GLASS_WAVE_HEIGHT = 25;
const GLASS_AI_WAVE_INNER = 28;
const GLASS_AI_WAVE_SUPPORT = 54;
const GLASS_MONITOR_WAVE_INNER = 40;
const GLASS_MONITOR_WAVE_SUPPORT = 76;
const GLASS_UNDERLIGHT_AURA_SUPPORT = 0.78;
const GLASS_MONITOR_UNDERLIGHT_HALF_RATIO = GLASS_MONITOR_WAVE_SUPPORT * GLASS_UNDERLIGHT_AURA_SUPPORT / GLASS_WAVE_WIDTH;
const GLASS_AI_UNDERLIGHT_HALF_RATIO = GLASS_AI_WAVE_SUPPORT * GLASS_UNDERLIGHT_AURA_SUPPORT / GLASS_WAVE_WIDTH;
const PIXEL_MONITOR_NUMBER_LIGHT_LAG_MS = 180;
const GLASS_MONITOR_NUMBER_LIGHT_LAG_MS = 350;

type GlassWaveDraw = (timestamp: number) => boolean;

const glassWaveDrawers = new Set<GlassWaveDraw>();
let glassWaveFrame: number | null = null;
let glassWaveVisibilityReady = false;

function requestGlassWaveFrame() {
  if (glassWaveFrame !== null || document.hidden || glassWaveDrawers.size === 0) return;
  glassWaveFrame = requestAnimationFrame((timestamp) => {
    glassWaveFrame = null;
    let keepRunning = false;
    glassWaveDrawers.forEach((draw) => { keepRunning = draw(timestamp) || keepRunning; });
    if (keepRunning) requestGlassWaveFrame();
  });
}

function registerGlassWave(draw: GlassWaveDraw): () => void {
  glassWaveDrawers.add(draw);
  if (!glassWaveVisibilityReady) {
    glassWaveVisibilityReady = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) requestGlassWaveFrame();
    });
  }
  requestGlassWaveFrame();
  return () => {
    glassWaveDrawers.delete(draw);
    if (glassWaveDrawers.size === 0 && glassWaveFrame !== null) {
      cancelAnimationFrame(glassWaveFrame);
      glassWaveFrame = null;
    }
  };
}

function glassWaveStrength(delta: number): number {
  return Math.max(0.32, Math.min(1, 0.32 + Math.max(0, Math.sqrt(Math.max(0, delta)) - 1) * 0.136));
}

const GLASS_WAVE_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_position.x, 1.0 - a_position.y);
  gl_Position = vec4(a_position * 2.0 - 1.0, 0.0, 1.0);
}`;

// The shader evaluates one closed silhouette directly per pixel. No path tessellation or canvas texture
// upload occurs while the phase changes; each bar is one GPU quad.
const GLASS_WAVE_FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform float u_width;
uniform float u_dpr;
uniform float u_fill;
uniform float u_crest;
uniform float u_trough;
uniform float u_inner;
uniform float u_support;
uniform vec2 u_centers;
uniform float u_center_count;
uniform vec2 u_highlights;
uniform float u_highlight_count;
uniform float u_highlight_alpha;
uniform float u_underlight;
uniform vec3 u_color;

const float PI = 3.141592653589793;
const float W = 180.0;
const float H = 25.0;
const float TOP = 8.0;
const float BOTTOM = 24.0;

float waveOffset(float distance) {
  float d = abs(distance);
  float crestOffset = u_crest - TOP;
  float troughOffset = u_trough - TOP;
  if (d <= u_inner) {
    float blend = (1.0 - cos(PI * d / u_inner)) * 0.5;
    return mix(crestOffset, troughOffset, blend);
  }
  if (d <= u_support) {
    float blend = (1.0 - cos(PI * (d - u_inner) / (u_support - u_inner))) * 0.5;
    return troughOffset * (1.0 - blend);
  }
  return 0.0;
}

float topAt(float x) {
  float weighted = 0.0;
  float weights = 0.0;
  for (int index = 0; index < 2; index++) {
    float enabled = index == 0 ? step(0.5, u_center_count) : step(1.5, u_center_count);
    float center = index == 0 ? u_centers.x : u_centers.y;
    float distance = abs(x - center);
    float active = enabled * (1.0 - step(u_support, distance));
    float weight = max(0.001, 1.0 - distance / u_support) * active;
    weighted += waveOffset(x - center) * weight;
    weights += weight;
  }
  return weights > 0.0 ? TOP + weighted / weights : TOP;
}

float verticalMask(float y, float top, float bottom) {
  float aa = 0.75 / u_dpr;
  return smoothstep(top - aa, top + aa, y) * (1.0 - smoothstep(bottom - aa, bottom + aa, y));
}

float capMask(float x, float y, float centerX, float centerY, float radiusX, float radiusY) {
  float dx = (x - centerX) / max(0.001, radiusX);
  float dy = (y - centerY) / max(0.001, radiusY);
  float distance = sqrt(dx * dx + dy * dy);
  float aa = 0.85 / max(1.0, radiusY * u_dpr);
  return 1.0 - smoothstep(1.0 - aa, 1.0 + aa, distance);
}

float highlightAt(float x, float y, float surface, float center) {
  float span = u_support * 0.72;
  float dx = (x - center) / span;
  float dy = (y - surface) / (y < surface ? 3.2 : 6.4);
  float broad = 1.0 - smoothstep(0.12, 1.0, sqrt(dx * dx + dy * dy));
  float coreDx = (x - center) / max(1.0, u_inner * 0.62);
  float coreDy = (y - surface) / (y < surface ? 1.35 : 2.1);
  float core = 1.0 - smoothstep(0.08, 1.0, sqrt(coreDx * coreDx + coreDy * coreDy));
  return min(1.0, broad * 0.58 + core * 0.62);
}

float underlightBroadAt(float x, float y, float center) {
  float dx = abs((x - center) / max(1.0, u_support * 0.70));
  float horizontal = 1.0 - smoothstep(0.12, 1.0, dx);
  float rise = 1.0 - smoothstep(1.0, 16.0, max(0.0, BOTTOM - y));
  return horizontal * rise;
}

float underlightCoreAt(float x, float y, float center) {
  float dx = abs((x - center) / max(1.0, u_inner * 0.68));
  float horizontal = 1.0 - smoothstep(0.04, 1.0, dx);
  float rise = 1.0 - smoothstep(2.0, 20.0, max(0.0, BOTTOM - y));
  return horizontal * rise;
}

float underlightAuraAt(float x, float y, float center) {
  float dx = (x - center) / max(1.0, u_support * ${GLASS_UNDERLIGHT_AURA_SUPPORT});
  float dy = (y - (BOTTOM - 5.0)) / 10.0;
  return 1.0 - smoothstep(0.08, 1.0, sqrt(dx * dx + dy * dy));
}

void main() {
  float x = v_uv.x * W;
  float y = v_uv.y * H;
  float fill = clamp(u_fill, 0.0, 1.0);
  float waterX = x / max(fill, 0.001);
  float baseRadiusX = min(8.0, u_width * 0.5) / max(1.0, u_width) * W;

  float leftTop = topAt(baseRadiusX);
  float leftBottom = BOTTOM + (leftTop - TOP) * 0.2;
  float leftRadiusY = (leftBottom - leftTop) * 0.5;
  float leftRadiusX = min(u_width * 0.5, leftRadiusY) / max(1.0, u_width) * W;
  leftTop = topAt(leftRadiusX);
  leftBottom = BOTTOM + (leftTop - TOP) * 0.2;
  leftRadiusY = (leftBottom - leftTop) * 0.5;
  leftRadiusX = min(u_width * 0.5, leftRadiusY) / max(1.0, u_width) * W;

  float rightTop = topAt(W - baseRadiusX);
  float rightBottom = BOTTOM + (rightTop - TOP) * 0.2;
  float rightRadiusY = (rightBottom - rightTop) * 0.5;
  float rightRadiusX = min(u_width * 0.5, rightRadiusY) / max(1.0, u_width) * W;
  rightTop = topAt(W - rightRadiusX);
  rightBottom = BOTTOM + (rightTop - TOP) * 0.2;
  rightRadiusY = (rightBottom - rightTop) * 0.5;
  rightRadiusX = min(u_width * 0.5, rightRadiusY) / max(1.0, u_width) * W;

  float top = topAt(waterX);
  float bottom = BOTTOM + (top - TOP) * 0.2;
  float middle = verticalMask(y, top, bottom) * step(leftRadiusX, waterX) * step(waterX, W - rightRadiusX);
  float left = capMask(waterX, y, leftRadiusX, (leftTop + leftBottom) * 0.5, leftRadiusX, leftRadiusY);
  float right = capMask(waterX, y, W - rightRadiusX, (rightTop + rightBottom) * 0.5, rightRadiusX, rightRadiusY);
  float fillAa = 0.8 * W / max(1.0, u_width * u_dpr);
  float fillMask = 1.0 - smoothstep(W - fillAa, W + fillAa, waterX);
  float mask = max(middle, max(left, right)) * fillMask * step(0.001, fill);

  float ramp = y / H;
  float baseAlpha = ramp <= 0.52 ? mix(0.58, 0.68, ramp / 0.52) : mix(0.68, 0.76, (ramp - 0.52) / 0.48);
  float light = 0.0;
  if (u_highlight_count >= 0.5) light = max(light, highlightAt(waterX, y, top, u_highlights.x));
  if (u_highlight_count >= 1.5) light = max(light, highlightAt(waterX, y, top, u_highlights.y));
  float underBroad = 0.0;
  float underCore = 0.0;
  float underAura = 0.0;
  if (u_underlight > 0.0 && u_highlight_count >= 0.5) {
    underBroad = max(underBroad, underlightBroadAt(waterX, y, u_highlights.x));
    underCore = max(underCore, underlightCoreAt(waterX, y, u_highlights.x));
    underAura = max(underAura, underlightAuraAt(waterX, y, u_highlights.x));
  }
  if (u_underlight > 0.0 && u_highlight_count >= 1.5) {
    underBroad = max(underBroad, underlightBroadAt(waterX, y, u_highlights.y));
    underCore = max(underCore, underlightCoreAt(waterX, y, u_highlights.y));
    underAura = max(underAura, underlightAuraAt(waterX, y, u_highlights.y));
  }
  underBroad *= u_underlight;
  underCore *= u_underlight;
  underAura *= u_underlight;
  float highlight = clamp(light * u_highlight_alpha, 0.0, 0.78);
  vec3 waterColor = mix(u_color, vec3(1.0), highlight);
  float underWhite = clamp(underBroad * 0.42 + underCore * 0.78, 0.0, 0.92);
  vec3 underColor = mix(u_color, vec3(1.0), underWhite);
  waterColor = mix(waterColor, underColor, clamp(underBroad * 0.55 + underCore * 0.68, 0.0, 0.86));
  float waterAlpha = baseAlpha * mask;
  float haloBand = 1.0 - smoothstep(0.7, 3.4, abs(y - top));
  float haloAlpha = light * u_highlight_alpha * haloBand * 0.15 * fillMask * step(0.001, fill);
  float auraAlpha = underAura * 0.26 * fillMask * step(0.001, fill);
  float alpha = max(waterAlpha, max(haloAlpha, auraAlpha));
  float haloWeight = alpha > 0.0 ? haloAlpha / alpha : 0.0;
  float auraWeight = alpha > 0.0 ? auraAlpha / alpha : 0.0;
  vec3 haloColor = mix(u_color, vec3(1.0), 0.76);
  vec3 auraColor = mix(u_color, vec3(1.0), 0.46);
  vec3 finalColor = mix(waterColor, haloColor, haloWeight);
  gl_FragColor = vec4(mix(finalColor, auraColor, auraWeight), alpha);
}`;

function compileGlassWaveShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Glass wave shader failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createGlassWaveProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const vertex = compileGlassWaveShader(gl, gl.VERTEX_SHADER, GLASS_WAVE_VERTEX_SHADER);
  const fragment = compileGlassWaveShader(gl, gl.FRAGMENT_SHADER, GLASS_WAVE_FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Glass wave program failed", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function glassWaveRgb(color: string): [number, number, number] {
  const values = color.match(/[\d.]+/g)?.map(Number);
  if (!values || values.length < 3) return [1, 1, 1];
  return [values[0] / 255, values[1] / 255, values[2] / 255];
}

function GlassWaveCanvas({
  kind,
  strength,
  fill,
  colorToken,
  level = "low",
  onReadyChange,
  phaseOrigin,
}: {
  kind: "ai" | "monitor";
  strength?: number;
  fill: number;
  colorToken?: string;
  level?: MonitorLevel;
  onReadyChange?: (ready: boolean) => void;
  phaseOrigin?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [contextRevision, setContextRevision] = useState(0);
  const paramsRef = useRef({ strength: strength ?? 0.32, fill, level });
  const colorRef = useRef<[number, number, number]>([1, 1, 1]);
  paramsRef.current = { strength: strength ?? 0.32, fill, level };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    colorRef.current = glassWaveRgb(getComputedStyle(canvas).color);
    requestGlassWaveFrame();
  }, [colorToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onReadyChange?.(false);
    const contextLost = (event: Event) => {
      event.preventDefault();
      onReadyChange?.(false);
    };
    const contextRestored = () => setContextRevision((current) => current + 1);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: "low-power" });
    if (!gl) return () => {
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
    };
    const program = createGlassWaveProgram(gl);
    if (!program) return () => {
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
    };
    const buffer = gl.createBuffer();
    if (!buffer) return () => {
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      gl.deleteProgram(program);
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = {
      width: gl.getUniformLocation(program, "u_width"),
      dpr: gl.getUniformLocation(program, "u_dpr"),
      fill: gl.getUniformLocation(program, "u_fill"),
      crest: gl.getUniformLocation(program, "u_crest"),
      trough: gl.getUniformLocation(program, "u_trough"),
      inner: gl.getUniformLocation(program, "u_inner"),
      support: gl.getUniformLocation(program, "u_support"),
      centers: gl.getUniformLocation(program, "u_centers"),
      centerCount: gl.getUniformLocation(program, "u_center_count"),
      highlights: gl.getUniformLocation(program, "u_highlights"),
      highlightCount: gl.getUniformLocation(program, "u_highlight_count"),
      highlightAlpha: gl.getUniformLocation(program, "u_highlight_alpha"),
      underlight: gl.getUniformLocation(program, "u_underlight"),
      color: gl.getUniformLocation(program, "u_color"),
    };
    let width = 0;
    let dpr = 1;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = phaseOrigin ?? performance.now();
    let readySent = false;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      dpr = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
      const pixelHeight = Math.max(1, Math.round(GLASS_WAVE_HEIGHT * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      colorRef.current = glassWaveRgb(getComputedStyle(canvas).color);
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      requestGlassWaveFrame();
    };

    const draw = (timestamp: number): boolean => {
      if (reducedMotion.matches || width <= 0.5) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        return false;
      }
      let centerOne = 0;
      let centerTwo = 0;
      let centerCount = 0;
      let highlightOne = 0;
      let highlightTwo = 0;
      let highlightCount = 0;
      let crestY: number;
      let troughY: number;
      let highlightAlpha = 0;
      let underlight = 0;
      let keepRunning = kind === "monitor";
      const params = paramsRef.current;
      const fillRatio = Math.max(0, Math.min(1, params.fill / 100));
      const inner = kind === "monitor" ? GLASS_MONITOR_WAVE_INNER : GLASS_AI_WAVE_INNER;
      const support = kind === "monitor" ? GLASS_MONITOR_WAVE_SUPPORT : GLASS_AI_WAVE_SUPPORT;
      if (kind === "monitor") {
        const levelStrength = params.level === "high" ? 1 : params.level === "medium" ? 0.5 : 0;
        crestY = 5 - 4 * levelStrength;
        troughY = 9 + 2 * levelStrength;
        highlightAlpha = 0.54 + levelStrength * 0.18;
        underlight = 0.56 + levelStrength * 0.38;
        const progress = timestamp % 3300 / 3300;
        centerOne = -support + (GLASS_WAVE_WIDTH + support * 2) * progress;
        centerCount = 1;
        highlightOne = centerOne;
        highlightCount = 1;
      } else {
        const elapsed = timestamp - startedAt;
        const phase = Math.max(0, Math.min(1, elapsed / 4000));
        const normalized = Math.max(0, Math.min(1, (params.strength - 0.32) / 0.68));
        crestY = 5 - 4 * normalized;
        troughY = 8.64 + 1.36 * normalized;
        highlightAlpha = 0.48 + normalized * 0.24;
        keepRunning = elapsed < 4000;
        if (phase >= 0.2 && phase < 0.8) {
          const progress = (phase - 0.2) / 0.6;
          const eased = 1 - Math.pow(1 - progress, 2.1);
          const distance = eased * (GLASS_WAVE_WIDTH / 2 + support);
          centerOne = GLASS_WAVE_WIDTH / 2 - distance;
          centerTwo = GLASS_WAVE_WIDTH / 2 + distance;
          centerCount = 2;
          const opacity = progress < 0.12 ? progress / 0.12 : progress < 0.72 ? 1 - 0.28 * (progress - 0.12) / 0.6 : Math.max(0, 0.72 * (1 - progress) / 0.28);
          highlightOne = centerOne;
          highlightTwo = centerTwo;
          highlightCount = 2;
          highlightAlpha *= opacity;
          underlight = (0.56 + normalized * 0.34) * opacity;
        }
      }
      gl.uniform1f(uniforms.width, Math.max(1, width * fillRatio));
      gl.uniform1f(uniforms.dpr, dpr);
      gl.uniform1f(uniforms.fill, fillRatio);
      gl.uniform1f(uniforms.crest, crestY);
      gl.uniform1f(uniforms.trough, troughY);
      gl.uniform1f(uniforms.inner, inner);
      gl.uniform1f(uniforms.support, support);
      gl.uniform2f(uniforms.centers, centerOne, centerTwo);
      gl.uniform1f(uniforms.centerCount, centerCount);
      gl.uniform2f(uniforms.highlights, highlightOne, highlightTwo);
      gl.uniform1f(uniforms.highlightCount, highlightCount);
      gl.uniform1f(uniforms.highlightAlpha, highlightCount === 0 ? 0 : highlightAlpha);
      gl.uniform1f(uniforms.underlight, underlight);
      const color = colorRef.current;
      gl.uniform3f(uniforms.color, color[0], color[1], color[2]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!readySent) {
        readySent = true;
        onReadyChange?.(true);
      }
      return keepRunning;
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const unregister = registerGlassWave(draw);
    const resume = () => requestGlassWaveFrame();
    reducedMotion.addEventListener("change", resume);
    resize();
    return () => {
      onReadyChange?.(false);
      unregister();
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", resume);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [kind, contextRevision, onReadyChange, phaseOrigin]);
  return <canvas ref={canvasRef} className={`glass-wave-canvas glass-${kind}-wave`} aria-hidden="true" />;
}

const GlassAiWave = React.memo(function GlassAiWave({ strength, fill, colorToken, phaseOrigin }: { strength: number; fill: number; colorToken?: string; phaseOrigin: number }) {
  return <GlassWaveCanvas kind="ai" strength={strength} fill={fill} colorToken={colorToken} phaseOrigin={phaseOrigin} />;
});

const GlassMonitorWave = React.memo(function GlassMonitorWave({ fill, colorToken, level, onReadyChange }: { fill: number; colorToken: string; level: MonitorLevel; onReadyChange: (ready: boolean) => void }) {
  return <GlassWaveCanvas kind="monitor" fill={fill} colorToken={colorToken} level={level} onReadyChange={onReadyChange} />;
});

function effectStyle(effect: UsageEffect | undefined, fallbackPercent: number | undefined): React.CSSProperties {
  const from = effect ? Math.max(0, Math.min(100, effect.from)) : fallbackPercent ?? 0;
  const to = effect ? Math.max(0, Math.min(100, effect.to)) : fallbackPercent ?? 0;
  const width = Math.abs(to - from);
  const insertDelta = Math.max(0, to - from);
  const insertStart = pixelInsertStart(from);
  const dynamics = pixelInsertDynamics({ from, to });
  const pixelTiming = pixelInsertTiming({ from, to });

  // Glass liquid variables — mirror the prototype's barShell() math (redesign/interactive-prototype).
  // These drive glass-effect.css; the Pixel insertion geometry above is intentionally independent.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const target = Math.max(from, to);
  const glDropLeft = from <= 0 ? target / 2 : from / 2;
  const flowWidth = Math.max(0, target - glDropLeft);
  const leftWave = Math.max(0, glDropLeft);
  const rightWave = Math.max(0, target - glDropLeft);
  const pocketMin = 4;
  const pocketWidth = width > 0 || flowWidth > 0
    ? Math.min(target, Math.max(pocketMin, Math.min(18, width + 2), flowWidth * 0.28))
    : 0;
  const pocketStart = pocketWidth > 0
    ? Math.max(0, Math.min(Math.max(0, target - pocketWidth), glDropLeft - pocketWidth / 2))
    : 0;
  const pocketOrigin = pocketWidth > 0 ? clamp(((glDropLeft - pocketStart) / pocketWidth) * 100, 0, 100) : 50;
  const dropScale = clamp(0.72 + Math.sqrt(Math.max(0, width)) * 0.16, 0.72, 1.65);
  const impactStrength = clamp(0.72 + Math.sqrt(Math.max(0, width)) * 0.14, 0.72, 1.55);
  const glDropMinWidth = 8;
  const glDropWidth = `max(${glDropMinWidth}px, ${flowWidth || 2}%)`;

  return {
    "--pixel-gap-start": `${insertStart}%`,
    "--pixel-gap-end": `${insertStart + insertDelta}%`,
    "--pixel-insert-width": `${insertDelta}%`,
    "--pixel-target-fill": `${to}%`,
    "--pixel-shift-duration": `${PIXEL_INSERT_SHIFT_MS}ms`,
    "--pixel-wave-duration": `${pixelTiming.waveMs}ms`,
    "--pixel-hop-duration": `${dynamics.hopMs}ms`,
    "--pixel-cell-rise": `${-(2 + dynamics.strength * 5)}px`,
    "--pixel-cell-glow-opacity": 0.28 + dynamics.strength * 0.58,
    "--pixel-contact-opacity": 0.2 + dynamics.strength * 0.48,
    "--pixel-impact-spread-x": 1.025 + dynamics.strength * 0.055,
    "--pixel-impact-spread-y": 1.18 + dynamics.strength * 0.42,
    "--pixel-bar-recoil": `${0.45 + dynamics.strength * 1.55}px`,
    "--pixel-bar-rebound": `${-(0.14 + dynamics.strength * 0.5)}px`,
    "--pixel-beam-glow-blur": `${6 + dynamics.strength * 6}px`,
    "--pixel-beam-glow-alpha": `${34 + dynamics.strength * 30}%`,
    "--pixel-final-impact-delay": `${pixelTiming.impactMs}ms`,
    "--pixel-handoff-delay": `${pixelTiming.handoffMs}ms`,
    "--pixel-handoff-duration": `${PIXEL_INSERT_HANDOFF_MS}ms`,
    // Glass fill + liquid drivers (real prototype variable names).
    "--bar-fill": `${to}%`,
    "--gl-drop-left": `${glDropLeft}%`,
    "--gl-drop-width": glDropWidth,
    "--drop-scale": dropScale,
    "--impact-strength": impactStrength,
    "--flow-width": `${flowWidth}%`,
    "--left-wave-width": `${leftWave}%`,
    "--right-wave-width": `${rightWave}%`,
    "--pocket-start": `${pocketStart}%`,
    "--pocket-width": `${pocketWidth}%`,
    "--pocket-origin": `${pocketOrigin}%`,
  } as React.CSSProperties;
}

// The 11 glass liquid layers (order matches the prototype markup). Hidden by default; shown/animated
// only under .theme-glass. Rendered always so the glass fill (--bar-fill) shows even when idle.
const LiquidLayers = React.memo(function LiquidLayers({ waveStrength, waveFill, colorToken, phaseOrigin }: { waveStrength?: number; waveFill?: number; colorToken?: string; phaseOrigin?: number }) {
  return (
    <>
      <span className="liquid-refraction" aria-hidden="true" />
      <span className="liquid-impact-pocket" aria-hidden="true" />
      <span className="liquid-dimple" aria-hidden="true" />
      <span className="liquid-neck-left" aria-hidden="true" />
      <span className="liquid-neck" aria-hidden="true" />
      <span className="liquid-fill-mask" aria-hidden="true" />
      <span className="liquid-flow" aria-hidden="true" />
      {waveStrength !== undefined && waveFill !== undefined && phaseOrigin !== undefined && <GlassAiWave strength={waveStrength} fill={waveFill} colorToken={colorToken} phaseOrigin={phaseOrigin} />}
      <span className="liquid-ripple" aria-hidden="true" />
      <span className="liquid-drop" aria-hidden="true" />
    </>
  );
});

type PixelInsertSegment = {
  start: number;
  width: number;
  gapLeft: boolean;
  gapRight: boolean;
  hopDelay: number;
};

function pixelInsertSegments(start: number, end: number, shift: number, impactMs: number, insertStart: number, delta: number, hopMs: number): PixelInsertSegment[] {
  const segments: PixelInsertSegment[] = [];
  const impactCenter = insertStart + delta / 2;
  for (let cell = Math.floor(start / 10); cell < 10; cell += 1) {
    const cellStart = cell * 10;
    const cellEnd = cellStart + 10;
    const segmentStart = Math.max(start, cellStart);
    const segmentEnd = Math.min(end, cellEnd);
    if (segmentEnd - segmentStart <= 0.001) continue;
    const finalCenter = (segmentStart + segmentEnd) / 2 + shift;
    const beamCenterMs = Math.abs(finalCenter - impactCenter) * PIXEL_INSERT_MS_PER_PERCENT;
    segments.push({
      start: segmentStart,
      width: segmentEnd - segmentStart,
      gapLeft: Math.abs(segmentStart - cellStart) < 0.001 && cellStart > 0,
      gapRight: Math.abs(segmentEnd - cellEnd) < 0.001 && cellEnd < 100,
      hopDelay: Math.max(impactMs, Math.round(impactMs + beamCenterMs - hopMs * PIXEL_INSERT_HOP_PEAK)),
    });
  }
  return segments;
}

type PixelDropPiece = {
  start: number;
  width: number;
  gapLeft: boolean;
  gapRight: boolean;
  delay: number;
};

function pixelDropPieces(start: number, delta: number): PixelDropPiece[] {
  const pieces: PixelDropPiece[] = [];
  for (let offset = 0, index = 0; offset < delta - 0.001; offset += 10, index += 1) {
    const width = Math.min(10, delta - offset);
    pieces.push({
      start: start + offset,
      width,
      gapLeft: index > 0,
      gapRight: offset + width < delta - 0.001,
      delay: PIXEL_INSERT_DROP_START_MS + index * PIXEL_INSERT_DROP_STAGGER_MS,
    });
  }
  return pieces;
}

const PixelInsertionScene = React.memo(function PixelInsertionScene({
  effect,
  leftBeamRef,
  rightBeamRef,
}: {
  effect: UsageEffect;
  leftBeamRef: React.RefObject<HTMLSpanElement | null>;
  rightBeamRef: React.RefObject<HTMLSpanElement | null>;
}) {
  const from = Math.max(0, Math.min(100, effect.from));
  const to = Math.max(0, Math.min(100, effect.to));
  const delta = Math.max(0, to - from);
  if (delta <= 0.001) return null;
  const split = pixelInsertStart(from);
  const dynamics = pixelInsertDynamics(effect);
  const timing = pixelInsertTiming(effect);
  const leftSegments = pixelInsertSegments(0, split, 0, timing.impactMs, split, delta, dynamics.hopMs);
  const rightSegments = pixelInsertSegments(split, from, delta, timing.impactMs, split, delta, dynamics.hopMs);
  const dropPieces = pixelDropPieces(split, delta);
  const segmentStyle = (segment: PixelInsertSegment, groupStart: number, groupWidth: number) => ({
    "--pixel-unit-left": `${(segment.start - groupStart) / groupWidth * 100}%`,
    "--pixel-unit-width": `${segment.width / groupWidth * 100}%`,
    "--pixel-unit-gap-left": segment.gapLeft ? "calc(var(--bar-gap) / 2)" : "0px",
    "--pixel-unit-gap-right": segment.gapRight ? "calc(var(--bar-gap) / 2)" : "0px",
    "--pixel-hop-delay": `${segment.hopDelay}ms`,
  } as React.CSSProperties);
  const rightWidth = from - split;
  return (
    <span className="pixel-insert-scene" aria-hidden="true">
      <span className="pixel-insert-track">
        {Array.from({ length: 10 }, (_, index) => <span key={index} />)}
      </span>
      {split > 0.001 && <>
        <span className="pixel-insert-old-group pixel-insert-old-left" style={{ width: `${split}%` }}>
          {leftSegments.map((segment, index) => <span key={index} className="pixel-insert-unit" style={segmentStyle(segment, 0, split)} />)}
        </span>
      </>}
      {rightWidth > 0.001 && <>
        <span
          className="pixel-insert-old-group pixel-insert-old-right"
          style={{
            left: `${split}%`,
            width: `${rightWidth}%`,
            "--pixel-right-shift": `${delta / rightWidth * 100}%`,
          } as React.CSSProperties}
        >
          {rightSegments.map((segment, index) => <span key={index} className="pixel-insert-unit" style={segmentStyle(segment, split, rightWidth)} />)}
        </span>
      </>}
      {dropPieces.map((piece, index) => (
        <span
          key={index}
          className="pixel-insert-drop-piece"
          style={{
            "--pixel-piece-left": `${piece.start}%`,
            "--pixel-piece-width": `${piece.width}%`,
            "--pixel-piece-gap-left": piece.gapLeft ? "calc(var(--bar-gap) / 2)" : "0px",
            "--pixel-piece-gap-right": piece.gapRight ? "calc(var(--bar-gap) / 2)" : "0px",
            "--pixel-drop-delay": `${piece.delay}ms`,
            "--pixel-drop-impact-delay": `${piece.delay + PIXEL_INSERT_DROP_DURATION_MS}ms`,
          } as React.CSSProperties}
        >
          <span />
        </span>
      ))}
      <span className="pixel-insert-impact" />
      <span className="pixel-insert-beam-clip">
        <span ref={leftBeamRef} className="pixel-insert-beam pixel-insert-beam-left" />
        <span ref={rightBeamRef} className="pixel-insert-beam pixel-insert-beam-right" />
      </span>
    </span>
  );
});

function buildUsageCells(percent: number | undefined, cellCount: number, effect?: UsageEffect): ReactNode[] {
  const normalized = Math.max(0, Math.min(100, Number(percent ?? 0)));
  const cellWidth = 100 / cellCount;
  const fullCells = Math.floor(normalized / cellWidth);
  const remainder = normalized - fullCells * cellWidth;
  const partialRatio = remainder > 0 && fullCells < cellCount ? Math.max(0.04, Math.min(0.96, remainder / cellWidth)) : 0;
  const effectStart = effect ? Math.min(effect.from, effect.to) : 0;
  const effectEnd = effect ? Math.max(effect.from, effect.to) : 0;

  return Array.from({ length: cellCount }, (_, index) => {
    const cellStart = index * cellWidth;
    const cellEnd = cellStart + cellWidth;
    const intersectsEffect = !!effect && effectEnd > cellStart && effectStart < cellEnd;
    // Pha cua song quet: vet quet chay het phan da fill trong 1 chu ky, nen o o vi tri x% cua phan fill
    // se nho len o thoi diem x% cua chu ky. Chi .monitor-scan doc bien nay.
    const waveCenter = index === fullCells && partialRatio > 0
      ? cellStart + cellWidth * partialRatio / 2
      : cellStart + cellWidth / 2;
    const waveDelay = normalized > 0 ? Math.min(1, waveCenter / normalized) : 0;
    const waveStyle = { "--wave-delay": waveDelay } as React.CSSProperties;
    if (intersectsEffect) {
      const filledMinis = Math.max(0, Math.min(10, Math.ceil(((normalized - cellStart) / cellWidth) * 10)));
      return (
        <span key={index} className="cell partial current fx-partial" style={waveStyle}>
          {Array.from({ length: 10 }, (_, mini) => {
            const miniStart = cellStart + mini * (cellWidth / 10);
            const on = mini < filledMinis;
            const added = on && miniStart >= effectStart && miniStart < effectEnd;
            return <span key={mini} className={`mini-cell${on ? " on" : ""}${added ? " added" : ""}${on && mini === filledMinis - 1 ? " edge" : ""}`} />;
          })}
        </span>
      );
    }
    if (index < fullCells) {
      return <span key={index} className={`cell active${index === fullCells - 1 && partialRatio === 0 ? " current" : ""}`} style={waveStyle} />;
    }
    if (index === fullCells && partialRatio > 0) {
      return <span key={index} className="cell partial current" style={{ ...waveStyle, "--partial-ratio": partialRatio } as React.CSSProperties} />;
    }
    return <span key={index} className="cell" style={waveStyle} />;
  });
}


function MiniMarkButton({ provider, onClick, title }: { provider: Provider; onClick?: () => void; title?: string }) {
  return (
    <span
      className="mini-mark-btn"
      role="button"
      tabIndex={onClick ? 0 : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={onClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } } : undefined}
    >
      <ProviderMark provider={provider} />
    </span>
  );
}

// --- System monitor tiles ------------------------------------------------------
// Additive UI: reuses the provider-tile shell + buildUsageCells for a consistent look,
// but deliberately renders NO drop/particle effect (those are for slow monotonic usage).
// Live values ease between reads via useSmoothedValue; color reflects load (green→red).
const MONITOR_ORDER: MonitorKind[] = ["cpu", "ram", "gpu", "igpu", "cputemp", "gputemp"];
const MONITOR_LABELS: Record<MonitorKind, string> = {
  cpu: "CPU",
  ram: "RAM",
  gpu: "GPU",
  igpu: "iGPU",
  cputemp: "CPU °C",
  gputemp: "GPU °C",
};
const MONITOR_FULL_LABELS: Record<MonitorKind, string> = {
  cpu: "CPU usage",
  ram: "RAM usage",
  gpu: "GPU usage (NVIDIA)",
  igpu: "iGPU usage (Intel)",
  cputemp: "CPU temperature",
  gputemp: "GPU temperature",
};
const MONITOR_SHOW_KEY: Record<MonitorKind, keyof Settings> = {
  cpu: "showCpu",
  ram: "showRam",
  gpu: "showGpu",
  igpu: "showIgpu",
  cputemp: "showCpuTemp",
  gputemp: "showGpuTemp",
};

function tileConfigured(tileId: TileId, settings: Settings) {
  const provider = providerFromTile(tileId);
  if (provider) return settings.accounts.some((a) => a.id === provider && a.shown);
  const monitor = monitorFromTile(tileId);
  return monitor ? Boolean(settings[MONITOR_SHOW_KEY[monitor]]) : false;
}

function tileActive(tileId: TileId, settings: Settings) {
  const provider = providerFromTile(tileId);
  if (provider) return settings.aiUsageEnabled && settings.accounts.some((a) => a.id === provider && a.shown);
  const monitor = monitorFromTile(tileId);
  return monitor ? settings.systemMonitorsEnabled && Boolean(settings[MONITOR_SHOW_KEY[monitor]]) : false;
}

function setAccountShown(settings: Settings, id: Provider, shown: boolean): Settings {
  return { ...settings, accounts: settings.accounts.map((a) => (a.id === id ? { ...a, shown } : a)) };
}

function hideTileInSettings(tileId: TileId, settings: Settings): Settings {
  const provider = providerFromTile(tileId);
  if (provider) return setAccountShown(settings, provider, false);
  const monitor = monitorFromTile(tileId);
  return monitor ? { ...settings, [MONITOR_SHOW_KEY[monitor]]: false } : settings;
}

async function readSystemMetrics(kinds: MonitorKind[]): Promise<SystemMetrics | null> {
  try {
    return await invoke<SystemMetrics>("read_system_metrics", { kinds });
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function emptyReading(kind: MonitorKind): MonitorReading {
  const unit: "%" | "°C" = kind === "cputemp" || kind === "gputemp" ? "°C" : "%";
  return { kind, label: MONITOR_LABELS[kind], displayValue: "N/A", unit, available: false };
}

function monitorTestReading(base: MonitorReading, kind: MonitorKind, value: number, nonce: string): MonitorReading {
  const unit: "%" | "°C" = kind === "cputemp" || kind === "gputemp" ? "°C" : "%";
  const percent = Math.max(0, Math.min(100, value));
  return {
    ...base,
    kind,
    label: MONITOR_LABELS[kind],
    percent,
    displayValue: `${Math.round(percent)}${unit}`,
    unit,
    available: true,
    testing: true,
    testNonce: nonce,
  };
}

function shortGpuName(name: string | null): string | undefined {
  if (!name) return undefined;
  if (/intel/i.test(name)) return "Intel Iris Xe";
  return name.replace(/^NVIDIA\s+GeForce\s+/i, "").replace(/^NVIDIA\s+/i, "");
}

// "13th Gen Intel(R) Core(TM) i9-13900H" -> "Intel Core i9-13900H"; drop (R)/(TM) noise.
function shortCpuName(name: string): string {
  const cleaned = name.replace(/\((?:R|TM)\)/gi, "").replace(/\s+/g, " ").trim();
  const core = cleaned.match(/((?:Intel|AMD)\s+)?(?:Core|Ryzen|Xeon|Pentium|Celeron|Athlon)[^,]*/i);
  return (core ? core[0] : cleaned).trim();
}

const GB = 1024;
const NA = "—";
function gb(mb: number): string {
  return (mb / GB).toFixed(1);
}
function optNum(value: number | null, suffix: string): string {
  return value == null ? NA : `${Math.round(value)}${suffix}`;
}
function rpm(value: number | null): string {
  return value == null || value <= 0 ? NA : `${Math.round(value)} RPM`;
}
// Drop rows whose value isn't available yet, so the details panel never shows bare "—" dashes.
function keepAvailable(details: MonitorDetail[]): MonitorDetail[] {
  return details.filter((d) => d.value !== NA);
}

// `kinds` limits the work to the tiles on screen; the others still get a key so the record shape
// holds, they just skip building a reading and its details array on every poll.
function buildMonitorReadings(m: SystemMetrics | null, kinds?: MonitorKind[]): Record<MonitorKind, MonitorReading> {
  const make = (kind: MonitorKind): MonitorReading => {
    if (!m || (kinds && !kinds.includes(kind))) return emptyReading(kind);
    switch (kind) {
      case "cpu": {
        const pct = clampPercent(m.cpu_percent);
        const name = shortCpuName(m.cpu_name) || "CPU";
        const cores = `${m.cpu_physical_cores ?? "?"} cores · ${m.cpu_logical_cores} threads`;
        const clock = m.cpu_freq_mhz > 0 ? `${(m.cpu_freq_mhz / 1000).toFixed(2)} GHz` : "—";
        const details: MonitorDetail[] = [
          { label: "Model", value: name },
          { label: "Cores", value: cores },
          { label: "Clock", value: clock },
          { label: "Load", value: `${Math.round(pct)}%` },
        ];
        return { kind, label: "CPU", percent: pct, displayValue: `${Math.round(pct)}%`, unit: "%", sub: name, details: keepAvailable(details), available: true };
      }
      case "ram": {
        const pct = clampPercent(m.ram_percent);
        const details: MonitorDetail[] = [
          { label: "Used", value: `${gb(m.ram_used_mb)} GB` },
          { label: "Free", value: `${gb(m.ram_free_mb)} GB` },
          { label: "Total", value: `${gb(m.ram_total_mb)} GB` },
          { label: "Swap", value: m.swap_total_mb > 0 ? `${gb(m.swap_used_mb)} / ${gb(m.swap_total_mb)} GB` : NA },
        ];
        return { kind, label: "RAM", percent: pct, displayValue: `${Math.round(pct)}%`, unit: "%", sub: `${gb(m.ram_used_mb)} / ${gb(m.ram_total_mb)} GB`, details: keepAvailable(details), available: true };
      }
      case "gpu": {
        if (m.gpu_percent == null) return emptyReading(kind);
        const pct = clampPercent(m.gpu_percent);
        const name = shortGpuName(m.gpu_name) ?? "GPU";
        const vram = m.gpu_vram_total_mb != null ? `${gb(m.gpu_vram_used_mb ?? 0)} / ${gb(m.gpu_vram_total_mb)} GB` : NA;
        // Temp + Fan live on the GPU °C tile instead — keep this panel to load-related stats.
        const details: MonitorDetail[] = [
          { label: "Model", value: name },
          { label: "Load", value: `${Math.round(pct)}%` },
          { label: "VRAM", value: vram },
          { label: "Power", value: m.gpu_power_w == null ? NA : `${m.gpu_power_w.toFixed(0)} W` },
          { label: "Clock", value: optNum(m.gpu_clock_mhz, " MHz") },
        ];
        return { kind, label: "GPU", percent: pct, displayValue: `${Math.round(pct)}%`, unit: "%", sub: name, details: keepAvailable(details), available: true };
      }
      case "igpu": {
        if (m.igpu_percent == null) return emptyReading(kind);
        const pct = clampPercent(m.igpu_percent);
        const name = shortGpuName(m.igpu_name) ?? "iGPU";
        const details: MonitorDetail[] = [
          { label: "Model", value: name },
          { label: "Load", value: `${Math.round(pct)}%` },
        ];
        return { kind, label: "iGPU", percent: pct, displayValue: `${Math.round(pct)}%`, unit: "%", sub: name, details: keepAvailable(details), available: true };
      }
      case "cputemp": {
        if (m.cpu_temp_c == null) return emptyReading(kind);
        const hottest = m.cpu_temp_cores.length > 0 ? Math.max(...m.cpu_temp_cores) : null;
        const details: MonitorDetail[] = [
          { label: "Package", value: `${Math.round(m.cpu_temp_c)}°C` },
          { label: "Hottest core", value: hottest == null ? NA : `${Math.round(hottest)}°C` },
          { label: "Fan", value: rpm(m.cpu_fan_rpm) },
        ];
        return { kind, label: MONITOR_LABELS.cputemp, percent: clampPercent(m.cpu_temp_c), displayValue: `${Math.round(m.cpu_temp_c)}°C`, unit: "°C", sub: "CPU package", details: keepAvailable(details), available: true };
      }
      case "gputemp": {
        if (m.gpu_temp_c == null) return emptyReading(kind);
        const name = shortGpuName(m.gpu_name);
        const details: MonitorDetail[] = [
          { label: "Sensor", value: name ?? "GPU" },
          { label: "Temp", value: `${Math.round(m.gpu_temp_c)}°C` },
          { label: "Fan", value: rpm(m.gpu_fan_rpm) },
        ];
        return { kind, label: MONITOR_LABELS.gputemp, percent: clampPercent(m.gpu_temp_c), displayValue: `${Math.round(m.gpu_temp_c)}°C`, unit: "°C", sub: name, details: keepAvailable(details), available: true };
      }
    }
  };
  return { cpu: make("cpu"), ram: make("ram"), gpu: make("gpu"), igpu: make("igpu"), cputemp: make("cputemp"), gputemp: make("gputemp") };
}

function monitorLevel(kind: MonitorKind, value: number | undefined): MonitorLevel {
  const current = value ?? 0;
  if (kind === "cputemp" || kind === "gputemp") {
    return current >= 85 ? "high" : current >= 70 ? "medium" : "low";
  }
  return current >= 85 ? "high" : current >= 60 ? "medium" : "low";
}

function monitorTone(settings: Settings, reading: MonitorReading): string {
  const level = monitorLevel(reading.kind, reading.percent);
  return settings.colorsEnabled ? settings.monitorColors[reading.kind]?.[level] ?? DEFAULT_MONITOR_PALETTE[level] : DEFAULT_MONITOR_PALETTE[level];
}

// Ease a displayed number toward its target with requestAnimationFrame so fast-changing
// metrics glide instead of snapping each poll. Cheap: stops itself once it reaches the goal.
// The readout is rounded to a whole percent, so settling closer than half a point buys nothing
// visible and only costs frames — every frame re-renders the tile and rebuilds its bar cells.
function useSmoothedValue(target: number, durationMs = 260): number {
  const [display, setDisplay] = useState(target);
  const currentRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    const from = currentRef.current;
    const startedAt = performance.now();
    const tick = (timestamp: number) => {
      const progress = Math.min(1, (timestamp - startedAt) / durationMs);
      const eased = progress * progress * (3 - 2 * progress);
      currentRef.current = from + (target - from) * eased;
      setDisplay(currentRef.current);
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, durationMs]);
  return display;
}

function MonitorMark({ kind }: { kind: MonitorKind }) {
  const glyph = (() => {
    switch (kind) {
      case "cpu":
        return (
          <>
            <rect x="7" y="7" width="10" height="10" rx="1" />
            <rect x="10" y="10" width="4" height="4" />
            <path d="M9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3" />
          </>
        );
      case "gpu":
        return (
          <>
            <rect x="3" y="7" width="18" height="10" rx="1" />
            <circle cx="9" cy="12" r="2.2" />
            <circle cx="15" cy="12" r="2.2" />
          </>
        );
      case "igpu":
        return (
          <>
            <rect x="6" y="6" width="12" height="12" rx="1" />
            <rect x="9.5" y="9.5" width="5" height="5" rx="0.5" />
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
          </>
        );
      case "ram":
        return (
          <>
            <rect x="3" y="8" width="18" height="8" rx="1" />
            <path d="M7 8V6M11 8V6M13 8V6M17 8V6M7 16v2M17 16v2" />
          </>
        );
      default: // cputemp / gputemp
        return (
          <>
            <path d="M12 4a2 2 0 0 1 2 2v7a3.5 3.5 0 1 1-4 0V6a2 2 0 0 1 2-2z" />
            <circle cx="12" cy="16.5" r="1.3" fill="currentColor" stroke="none" />
          </>
        );
    }
  })();
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">{glyph}</svg>
    </span>
  );
}

function useMonitorNumberLight({
  enabled,
  glass,
  fill,
  text,
  level,
}: {
  enabled: boolean;
  glass: boolean;
  fill: number;
  text: string;
  level: MonitorLevel;
}) {
  const numberRef = useRef<HTMLSpanElement>(null);
  const lightRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const rebuildRef = useRef<(() => void) | null>(null);
  const paramsRef = useRef({ fill, level });
  paramsRef.current = { fill, level };

  useEffect(() => {
    const number = numberRef.current;
    const light = lightRef.current;
    const bar = barRef.current;
    if (!number || !light || !bar || !enabled) {
      animationRef.current?.cancel();
      animationRef.current = null;
      if (light) light.style.opacity = "0";
      return;
    }

    let disposed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const duration = glass ? 3300 : 2200;
    const centerRate = glass ? 1.844444 : 1.665015;
    const numberLightLag = glass ? GLASS_MONITOR_NUMBER_LIGHT_LAG_MS : PIXEL_MONITOR_NUMBER_LIGHT_LAG_MS;
    const fadeInLag = numberLightLag / duration;
    const centerStart = glass ? -0.422222 : -0.27;
    const beamHalfRatio = glass ? GLASS_MONITOR_UNDERLIGHT_HALF_RATIO : 0.225;

    const stop = () => {
      animationRef.current?.cancel();
      animationRef.current = null;
      light.style.opacity = "0";
    };

    const rebuild = () => {
      if (disposed || reducedMotion.matches) {
        stop();
        return;
      }
      const numberRect = number.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const textWidth = numberRect.width;
      const trackWidth = Math.max(0, bar.clientWidth - 6);
      const params = paramsRef.current;
      const fillWidth = trackWidth * Math.max(0, Math.min(100, params.fill)) / 100;
      if (textWidth <= 0.5 || fillWidth <= 0.5) {
        stop();
        return;
      }

      const fillLeft = barRect.left + bar.clientLeft + 3;
      const fillOffset = fillLeft - numberRect.left;
      const beamHalfWidth = fillWidth * beamHalfRatio;
      const maxOpacity = params.level === "low" ? 0.95 : 1;
      const clampPhase = (value: number) => Math.max(0, Math.min(1, value));
      const phaseAt = (fillPosition: number) => (fillPosition - centerStart) / centerRate;
      let frames: Keyframe[];

      if (fillWidth <= textWidth + 1) {
        light.classList.add("is-whole-pulse");
        light.style.backgroundSize = "";
        const start = clampPhase(phaseAt(0.5 - beamHalfRatio));
        const peak = clampPhase(phaseAt(0.5));
        const end = clampPhase(phaseAt(0.5 + beamHalfRatio));
        const delayedStart = Math.min(peak, start + fadeInLag);
        frames = [
          { offset: 0, opacity: 0 },
          { offset: start, opacity: 0 },
          { offset: delayedStart, opacity: 0 },
          { offset: peak, opacity: maxOpacity },
          { offset: end, opacity: 0 },
          { offset: 1, opacity: 0 },
        ];
      } else {
        light.classList.remove("is-whole-pulse");
        const beamWidth = Math.max(18, beamHalfWidth * 2);
        light.style.backgroundSize = `${beamWidth}px 145%`;
        const centerAt = (phase: number) => fillOffset + fillWidth * (centerStart + centerRate * phase);
        const positionAt = (phase: number) => `${centerAt(phase) - beamHalfWidth}px 50%`;
        const start = clampPhase(phaseAt((-fillOffset - beamHalfWidth) / fillWidth));
        const end = clampPhase(phaseAt((textWidth - fillOffset + beamHalfWidth) / fillWidth));
        const span = Math.max(0.02, end - start);
        const fade = Math.min(0.07, span * 0.22);
        // Delay only the entrance. The mask keeps the crest's path and original exit so it never trails the wave.
        const delayedStart = Math.max(start, Math.min(end - fade, start + fadeInLag));
        const fullStart = Math.min(end, delayedStart + fade);
        const fullEnd = Math.max(fullStart, end - fade);
        frames = [
          { offset: 0, opacity: 0, backgroundPosition: positionAt(0) },
          { offset: start, opacity: 0, backgroundPosition: positionAt(start) },
          { offset: delayedStart, opacity: 0, backgroundPosition: positionAt(delayedStart) },
          { offset: fullStart, opacity: maxOpacity, backgroundPosition: positionAt(fullStart) },
          { offset: fullEnd, opacity: maxOpacity, backgroundPosition: positionAt(fullEnd) },
          { offset: end, opacity: 0, backgroundPosition: positionAt(end) },
          { offset: 1, opacity: 0, backgroundPosition: positionAt(1) },
        ];
      }

      light.style.opacity = "";
      const existing = animationRef.current;
      if (existing) {
        const currentTime = existing.currentTime;
        const effect = existing.effect as KeyframeEffect;
        effect.setKeyframes(frames);
        effect.updateTiming({ duration, iterations: Infinity, easing: "linear" });
        if (currentTime !== null) existing.currentTime = currentTime;
        return;
      }

      const animation = light.animate(frames, { duration, iterations: Infinity, easing: "linear" });
      animationRef.current = animation;
      if (glass) {
        const timelineNow = typeof document.timeline.currentTime === "number" ? document.timeline.currentTime : performance.now();
        animation.startTime = timelineNow - performance.now() % duration;
      } else {
        const beam = bar.getAnimations({ subtree: true }).find((candidate) =>
          (candidate as CSSAnimation).animationName === "monitor-scan-band",
        );
        const beamStart = beam?.startTime;
        const beamTime = beam?.currentTime;
        if (typeof beamStart === "number") {
          animation.startTime = beamStart;
        } else {
          animation.currentTime = typeof beamTime === "number" ? beamTime % duration : performance.now() % duration;
        }
      }
    };

    rebuildRef.current = rebuild;
    const observer = new ResizeObserver(rebuild);
    observer.observe(number);
    observer.observe(bar);
    reducedMotion.addEventListener("change", rebuild);
    const frame = window.requestAnimationFrame(rebuild);
    void document.fonts.ready.then(() => { if (!disposed) rebuild(); });
    return () => {
      disposed = true;
      rebuildRef.current = null;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", rebuild);
      stop();
    };
  }, [enabled, glass]);

  useLayoutEffect(() => {
    rebuildRef.current?.();
  }, [fill, level, text]);

  return { numberRef, lightRef, barRef };
}

function useAiUsageNumberLight({
  enabled,
  fill,
  strength,
  effectId,
  phaseOrigin,
  text,
}: {
  enabled: boolean;
  fill: number;
  strength: number;
  effectId?: number;
  phaseOrigin?: number;
  text: string;
}) {
  const numberRef = useRef<HTMLSpanElement>(null);
  const leftLightRef = useRef<HTMLSpanElement>(null);
  const rightLightRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const animationsRef = useRef<[Animation | null, Animation | null]>([null, null]);
  const rebuildRef = useRef<(() => void) | null>(null);
  const paramsRef = useRef({ fill, strength });
  paramsRef.current = { fill, strength };

  useEffect(() => {
    const number = numberRef.current;
    const leftLight = leftLightRef.current;
    const rightLight = rightLightRef.current;
    const bar = barRef.current;
    if (!enabled || effectId === undefined || phaseOrigin === undefined || !number || !leftLight || !rightLight || !bar) {
      animationsRef.current.forEach((animation) => animation?.cancel());
      animationsRef.current = [null, null];
      return;
    }

    let disposed = false;
    const duration = 4000;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const lights = [leftLight, rightLight] as const;

    const stop = () => {
      animationsRef.current.forEach((animation) => animation?.cancel());
      animationsRef.current = [null, null];
      lights.forEach((light) => { light.style.opacity = "0"; });
    };

    const rebuild = () => {
      if (disposed || reducedMotion.matches) {
        stop();
        return;
      }
      const numberRect = number.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const trackWidth = Math.max(0, bar.clientWidth - 6);
      const params = paramsRef.current;
      const fillWidth = trackWidth * Math.max(0, Math.min(100, params.fill)) / 100;
      if (numberRect.width <= 0.5 || fillWidth <= 0.5) {
        stop();
        return;
      }

      const fillOffset = barRect.left + bar.clientLeft + 3 - numberRect.left;
      const beamHalfWidth = fillWidth * GLASS_AI_UNDERLIGHT_HALF_RATIO;
      const normalizedStrength = Math.max(0, Math.min(1, (params.strength - 0.32) / 0.68));
      const maxOpacity = 0.9 + normalizedStrength * 0.1;
      lights.forEach((light) => { light.style.backgroundSize = `${Math.max(18, beamHalfWidth * 2)}px 145%`; });

      const makeFrames = (direction: -1 | 1): Keyframe[] => Array.from({ length: 41 }, (_, index) => {
        const phase = index / 40;
        let opacity = 0;
        let center = fillOffset + fillWidth * 0.5;
        if (phase >= 0.2 && phase < 0.8) {
          const progress = (phase - 0.2) / 0.6;
          const eased = 1 - Math.pow(1 - progress, 2.1);
          const distance = eased * (GLASS_WAVE_WIDTH / 2 + GLASS_AI_WAVE_SUPPORT);
          const centerWorld = GLASS_WAVE_WIDTH / 2 + direction * distance;
          center = fillOffset + fillWidth * centerWorld / GLASS_WAVE_WIDTH;
          const envelope = progress < 0.12
            ? progress / 0.12
            : progress < 0.72
              ? 1 - 0.28 * (progress - 0.12) / 0.6
              : Math.max(0, 0.72 * (1 - progress) / 0.28);
          opacity = maxOpacity * envelope;
        }
        return {
          offset: phase,
          opacity,
          backgroundPosition: `${center - beamHalfWidth}px 50%`,
        };
      });

      const frames = [makeFrames(-1), makeFrames(1)] as const;
      const elapsed = Math.max(0, Math.min(duration, performance.now() - phaseOrigin));
      lights.forEach((light, index) => {
        light.style.opacity = "";
        const existing = animationsRef.current[index];
        if (existing) {
          const currentTime = existing.currentTime;
          (existing.effect as KeyframeEffect).setKeyframes(frames[index]);
          if (currentTime !== null) existing.currentTime = currentTime;
          return;
        }
        const animation = light.animate(frames[index], { duration, easing: "linear", fill: "both" });
        const timelineNow = typeof document.timeline.currentTime === "number" ? document.timeline.currentTime : performance.now();
        animation.startTime = timelineNow - elapsed;
        animationsRef.current[index] = animation;
      });
    };

    rebuildRef.current = rebuild;
    const observer = new ResizeObserver(rebuild);
    observer.observe(number);
    observer.observe(bar);
    reducedMotion.addEventListener("change", rebuild);
    const frame = window.requestAnimationFrame(rebuild);
    void document.fonts.ready.then(() => { if (!disposed) rebuild(); });
    return () => {
      disposed = true;
      rebuildRef.current = null;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", rebuild);
      stop();
    };
  }, [effectId, enabled, phaseOrigin]);

  useLayoutEffect(() => {
    rebuildRef.current?.();
  }, [fill, strength, text]);

  return { numberRef, leftLightRef, rightLightRef, barRef };
}

function usePixelInsertionLights({
  enabled,
  effect,
  phaseOrigin,
}: {
  enabled: boolean;
  effect?: UsageEffect;
  phaseOrigin?: number;
}) {
  const numberRef = useRef<HTMLSpanElement>(null);
  const leftLightRef = useRef<HTMLSpanElement>(null);
  const rightLightRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const leftBeamRef = useRef<HTMLSpanElement>(null);
  const rightBeamRef = useRef<HTMLSpanElement>(null);
  const startTimeRef = useRef<{ id?: number; value: number }>({ value: 0 });

  useLayoutEffect(() => {
    const number = numberRef.current;
    const leftLight = leftLightRef.current;
    const rightLight = rightLightRef.current;
    const bar = barRef.current;
    const leftBeam = leftBeamRef.current;
    const rightBeam = rightBeamRef.current;
    const elements = [leftLight, rightLight, leftBeam, rightBeam];
    if (!enabled || !effect || phaseOrigin === undefined || !number || !leftLight || !rightLight || !bar || !leftBeam || !rightBeam) {
      elements.forEach((element) => element?.getAnimations().forEach((animation) => animation.cancel()));
      return;
    }

    let disposed = false;
    let geometryKey = "";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timing = pixelInsertTiming(effect);
    const dynamics = pixelInsertDynamics(effect);
    const target = Math.max(0, Math.min(100, effect.to));
    const insertStart = pixelInsertStart(effect.from);
    const impactCenterPct = insertStart + dynamics.delta / 2;
    const rebuild = (force = false) => {
      if (disposed) return;
      if (reducedMotion.matches) {
        elements.forEach((element) => element?.getAnimations().forEach((animation) => animation.cancel()));
        return;
      }
      const scene = leftBeam.closest<HTMLElement>(".pixel-insert-scene");
      if (!scene) return;
      const sceneRect = scene.getBoundingClientRect();
      const numberRect = number.getBoundingClientRect();
      if (sceneRect.width <= 0.5 || numberRect.width <= 0.5) return;
      const nextGeometryKey = `${sceneRect.left.toFixed(2)}:${sceneRect.width.toFixed(2)}:${numberRect.left.toFixed(2)}`;
      if (!force && nextGeometryKey === geometryKey) return;
      geometryKey = nextGeometryKey;
      elements.forEach((element) => element?.getAnimations().forEach((animation) => animation.cancel()));
      const fillWidth = sceneRect.width * target / 100;
      const center = sceneRect.width * impactCenterPct / 100;
      const leftDistance = Math.max(0, center);
      const rightDistance = Math.max(0, fillWidth - center);
      const cellWidth = sceneRect.width / 10;
      const beamWidth = Math.min(sceneRect.width, cellWidth * (1.75 + dynamics.strength * 0.5));
      const peakOpacity = 0.58 + dynamics.strength * 0.4;
      const numberOffset = sceneRect.left - numberRect.left;
      leftLight.style.backgroundSize = `${beamWidth}px 145%`;
      rightLight.style.backgroundSize = `${beamWidth}px 145%`;
      leftBeam.style.width = `${beamWidth}px`;
      rightBeam.style.width = `${beamWidth}px`;
      number.style.setProperty("--monitor-number-glow-blur", `${4 + dynamics.strength * 7}px`);
      number.style.setProperty("--monitor-number-glow-alpha", `${30 + dynamics.strength * 42}%`);

      const makeFrames = (end: number, textLayer: boolean, travelDuration: number): Keyframe[] => {
        const totalDuration = travelDuration + PIXEL_INSERT_BEAM_FADE_MS;
        const arrivalOffset = travelDuration / totalDuration;
        const fadeInOffset = arrivalOffset * 0.12;
        const frame = (offset: number, travelProgress: number, opacity: number): Keyframe => {
          const position = center + (end - center) * travelProgress - beamWidth / 2;
          return textLayer
            ? { offset, opacity, backgroundPosition: `${numberOffset + position}px 50%` }
            : { offset, opacity, transform: `translate3d(${position}px, 0, 0)` };
        };
        return [
          frame(0, 0, 0),
          frame(fadeInOffset, 0.12, peakOpacity),
          frame(arrivalOffset, 1, peakOpacity),
          frame(1, 1, 0),
        ];
      };

      const animations = [
        { element: leftLight, end: 0, textLayer: true, distance: leftDistance, travelDuration: impactCenterPct * PIXEL_INSERT_MS_PER_PERCENT },
        { element: rightLight, end: fillWidth, textLayer: true, distance: rightDistance, travelDuration: Math.max(0, target - impactCenterPct) * PIXEL_INSERT_MS_PER_PERCENT },
        { element: leftBeam, end: 0, textLayer: false, distance: leftDistance, travelDuration: impactCenterPct * PIXEL_INSERT_MS_PER_PERCENT },
        { element: rightBeam, end: fillWidth, textLayer: false, distance: rightDistance, travelDuration: Math.max(0, target - impactCenterPct) * PIXEL_INSERT_MS_PER_PERCENT },
      ];
      const impactAt = phaseOrigin + timing.impactMs;
      const timelineNow = typeof document.timeline.currentTime === "number" ? document.timeline.currentTime : performance.now();
      if (startTimeRef.current.id !== effect.id) {
        startTimeRef.current = { id: effect.id, value: timelineNow + impactAt - performance.now() };
      }
      const startTime = startTimeRef.current.value;
      animations.forEach(({ element, end, textLayer, distance, travelDuration }) => {
        if (distance <= 0.5) {
          element.style.opacity = "0";
          return;
        }
        element.style.opacity = "";
        const frames = makeFrames(end, textLayer, travelDuration);
        const duration = travelDuration + PIXEL_INSERT_BEAM_FADE_MS;
        const animation = element.animate(frames, { duration, easing: "linear", fill: "both" });
        animation.startTime = startTime;
      });
    };

    const observer = new ResizeObserver(() => rebuild());
    observer.observe(bar);
    const handleMotion = () => {
      geometryKey = "";
      rebuild(true);
    };
    reducedMotion.addEventListener("change", handleMotion);
    rebuild(true);
    void document.fonts.ready.then(() => { if (!disposed) rebuild(); });
    return () => {
      disposed = true;
      observer.disconnect();
      reducedMotion.removeEventListener("change", handleMotion);
      elements.forEach((element) => element?.getAnimations().forEach((animation) => animation.cancel()));
      number.style.removeProperty("--monitor-number-glow-blur");
      number.style.removeProperty("--monitor-number-glow-alpha");
    };
  }, [effect?.id, enabled, phaseOrigin]);

  return { numberRef, leftLightRef, rightLightRef, barRef, leftBeamRef, rightBeamRef };
}

function usePixelInsertionImpact(effect: UsageEffect | undefined, enabled: boolean, phaseOrigin: number | undefined) {
  const active = enabled && effect !== undefined && effect.to > effect.from;
  const effectId = active ? effect.id : undefined;
  const reducedNow = active && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [state, setState] = useState<{ id?: number; impacted: boolean; suppressed: boolean }>({ impacted: true, suppressed: false });
  const impacted = !active || reducedNow || (state.id === effectId && state.impacted);
  const sceneActive = active && !reducedNow && !(state.id === effectId && state.suppressed);

  useEffect(() => {
    if (!active || effectId === undefined) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = (suppressed = false) => setState({ id: effectId, impacted: true, suppressed });
    if (reducedMotion.matches) {
      finish(true);
      return;
    }
    setState({ id: effectId, impacted: false, suppressed: false });
    const elapsed = phaseOrigin === undefined ? 0 : Math.max(0, performance.now() - phaseOrigin);
    const impactMs = effect ? pixelInsertTiming(effect).impactMs : 0;
    const timeout = window.setTimeout(() => finish(false), Math.max(0, impactMs - elapsed));
    const handleMotion = () => { if (reducedMotion.matches) finish(true); };
    reducedMotion.addEventListener("change", handleMotion);
    return () => {
      window.clearTimeout(timeout);
      reducedMotion.removeEventListener("change", handleMotion);
    };
  }, [active, effectId, phaseOrigin]);

  return { active: sceneActive, impacted };
}

function usePixelUsageNumberFlash(percent: number | undefined, enabled: boolean) {
  const previousRef = useRef(percent);
  const timerRef = useRef(0);
  const [flash, setFlash] = useState({ active: false, sequence: 0 });

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = percent;
    window.clearTimeout(timerRef.current);
    if (!enabled || previous === undefined || percent === undefined || percent <= previous) {
      setFlash((current) => current.active ? { ...current, active: false } : current);
      return;
    }
    setFlash((current) => ({ active: true, sequence: current.sequence + 1 }));
    timerRef.current = window.setTimeout(() => {
      setFlash((current) => ({ ...current, active: false }));
    }, 1000);
    return () => window.clearTimeout(timerRef.current);
  }, [enabled, percent]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  return flash;
}

const MonitorBlock = React.memo(function MonitorBlock({ reading, tone, pulse = false, glass = false, textEffect = true }: { reading: MonitorReading; tone: string; pulse?: boolean; glass?: boolean; textEffect?: boolean }) {
  const [flipped, setFlipped] = useState(false);
  const [glassWaveReady, setGlassWaveReady] = useState(false);
  const smoothed = useSmoothedValue(reading.available ? reading.percent ?? 0 : 0);
  const details = reading.details ?? [];
  const canFlip = reading.available && details.length > 0;
  const showBack = flipped && canFlip;
  // Ambient "scanner": a bright band sweeps across only the *used* portion of the bar, brighter as the
  // value climbs. The sweep runs at a FIXED speed (so a changing value never restarts the animation and
  // it stays smooth); the load only drives brightness/width, which transition smoothly in CSS.
  const scanOn = pulse && reading.available && !showBack;
  const waveLevel = monitorLevel(reading.kind, reading.percent);
  const displayValue = reading.available ? reading.displayValue : "N/A";
  const { numberRef, lightRef, barRef } = useMonitorNumberLight({
    enabled: scanOn && textEffect,
    glass,
    fill: reading.available ? smoothed : 0,
    text: displayValue,
    level: waveLevel,
  });
  return (
    <article
      className={`usage compact provider-tile monitor monitor-${reading.kind} monitor-wave-${waveLevel}${reading.available ? "" : " monitor-unavailable"}${canFlip ? " flippable" : ""}${scanOn ? " monitor-scan" : ""}${glassWaveReady ? " glass-wave-ready" : ""}`}
      style={{ "--tone": tone, "--provider-color": tone } as React.CSSProperties}
      onClick={canFlip ? () => setFlipped((f) => !f) : undefined}
      title={canFlip ? (showBack ? "Click to go back" : "Click for details") : undefined}
    >
      <div className="usage-top">
        <strong><MonitorMark kind={reading.kind} /><span>{reading.label}</span></strong>
        <span className="tile-status">
          <span className={`source-pill ${reading.testing ? "test" : reading.available ? "ok" : "warn"}`}>{reading.testing ? "test" : reading.available ? "live" : "n/a"}</span>
        </span>
      </div>
      {showBack ? (
        <div className="monitor-details">
          {details.map((d) => (
            <div className="monitor-detail-row" key={d.label}>
              <span>{d.label}</span>
              <strong>{d.value}</strong>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="metric">
            <span ref={numberRef} className="percent monitor-number"><span className="monitor-number-base">{displayValue}</span><span ref={lightRef} className="monitor-number-light" aria-hidden="true">{displayValue}</span></span>
            {reading.sub && <span className="message">{reading.sub}</span>}
          </div>
          <div ref={barRef} className="bar monitor-bar" style={{ "--bar-fill": `${reading.available ? smoothed : 0}%` } as React.CSSProperties} aria-label={`${reading.label} ${reading.displayValue}`}>
            {buildUsageCells(reading.available ? smoothed : 0, 10)}
            {scanOn && glass && <GlassMonitorWave fill={reading.available ? smoothed : 0} colorToken={tone} level={waveLevel} onReadyChange={setGlassWaveReady} />}
          </div>
        </>
      )}
    </article>
  );
});

const MonitorMiniRow = React.memo(function MonitorMiniRow({ reading, tone }: { reading: MonitorReading; tone: string }) {
  const smoothed = useSmoothedValue(reading.available ? reading.percent ?? 0 : 0);
  const fill = reading.available ? smoothed : 0;
  return (
    <article className={`mini-usage provider-tile monitor monitor-${reading.kind}${reading.available ? "" : " monitor-unavailable"}`} style={{ "--tone": tone, "--provider-color": tone } as React.CSSProperties}>
      <span className={`mini-status ${reading.available ? "ok" : "warn"}`} aria-label={reading.available ? "live" : "n/a"} />
      <span className="mini-mark-btn"><MonitorMark kind={reading.kind} /></span>
      <span className="mini-provider">{reading.label}</span>
      <strong className="mini-percent">{reading.available ? reading.displayValue : "N/A"}</strong>
      <span className="mini-bar" style={{ "--bar-fill": `${fill}%` } as React.CSSProperties} aria-label={`${reading.label} ${reading.displayValue}`}>
        {buildUsageCells(fill, 8)}
      </span>
      <span className="mini-details" aria-hidden="true">
        <span className="mini-reset">{reading.sub ?? (reading.available ? "live" : "n/a")}</span>
      </span>
    </article>
  );
});

const MiniUsageRow = React.memo(function MiniUsageRow({ snapshot, accent, paused = false, updatedAgo, flash = false, onFlip }: { snapshot: UsageSnapshot; accent?: string; paused?: boolean; updatedAgo?: string; flash?: boolean; onFlip?: () => void }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const stale = isStale(snapshot);
  const state = stale ? "stale" : snapshot.status !== "ok" ? "warn" : paused ? "paused" : "ok";
  const statusLabel = stale ? "stale" : snapshot.status !== "ok" ? readableStatus(snapshot.status) : paused ? "paused" : "ok";
  const resetCountdown = resetCountdownLabel(snapshot);
  const resetLabel = resetCountdown === "resetting soon" ? "soon" : resetCountdown?.replace(/^resets?\s+in\s+/i, "") ?? "--";
  const freshnessLabel = (updatedAgo ?? formatAgo(snapshot.updatedAt) ?? "--").replace(/^just now$/i, "now");
  return (
    <article className={`mini-usage provider-tile ${providerKind(snapshot.provider)}${flash ? " mark-flash" : ""}${paused ? " mark-paused" : ""}`} style={providerAccentStyle(accent)}>
      <span className={`mini-status ${state}`} aria-label={state} />
      <MiniMarkButton provider={snapshot.provider} onClick={onFlip} title="Tap for reset countdown" />
      <span className="mini-provider">{providerLabel(snapshot.provider)}</span>
      <strong className="mini-percent">{percent !== undefined ? `${Math.round(percent)}%` : "--"}</strong>
      <span className="mini-bar" style={{ "--bar-fill": `${percent ?? 0}%` } as React.CSSProperties} aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {buildUsageCells(percent, 8)}
      </span>
      <span className="mini-details" aria-hidden="true">
        <span className="mini-reset">{resetLabel}</span>
        <span className="mini-detail-meta"><strong className={state}>{statusLabel}</strong><i>·</i><span>{freshnessLabel}</span></span>
      </span>
    </article>
  );
});

function MiniTimerRow({ snapshot, accent, onBack, paused = false }: { snapshot: UsageSnapshot; accent?: string; onBack: () => void; paused?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const resetMs = snapshotResetMs(snapshot);
  return (
    <article className={`mini-usage mini-timer provider-tile ${providerKind(snapshot.provider)}${paused ? " mark-paused" : ""}`} style={providerAccentStyle(accent)}>
      <MiniMarkButton provider={snapshot.provider} onClick={onBack} title="Tap to dismiss" />
      <strong className="mini-timer-clock"><CountdownFace resetMs={resetMs} fallback={resetMs !== null || snapshot.resetLabel ? "soon" : "--"} /></strong>
    </article>
  );
}
// Memoised: a system-monitor poll lands as often as once a second and re-renders the widget, but
// nothing about an AI tile changed — without this every poll rebuilt each tile's bar cells and its
// eleven liquid layers. Same reasoning for the other tiles below.
const UsageBlock = React.memo(function UsageBlock({ snapshot, accent, flash = false, paused = false, updatedAgo, effect, dropCell = false, glass = false, effectsEnabled = true, onFlip }: { snapshot: UsageSnapshot; accent?: string; flash?: boolean; paused?: boolean; updatedAgo?: string; effect?: UsageEffect; dropCell?: boolean; glass?: boolean; effectsEnabled?: boolean; onFlip?: () => void }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const stale = isStale(snapshot);
  const sourceState = stale ? "stale" : snapshot.status !== "ok" ? snapshot.status : paused ? "paused" : "ok";
  const metaLeft = usageMetaLeft(snapshot);
  const metaRight = usageMetaRight(snapshot);
  const waveStrength = effect && dropCell ? glassWaveStrength(Math.abs(effect.to - effect.from)) : 0.32;
  const waveFill = effect && dropCell ? Math.max(0, Math.min(100, effect.to)) : percent ?? 0;
  const effectOriginRef = useRef<{ id?: number; time: number }>({ time: 0 });
  if (effect && effectOriginRef.current.id !== effect.id) {
    effectOriginRef.current = { id: effect.id, time: performance.now() };
  } else if (!effect && effectOriginRef.current.id !== undefined) {
    effectOriginRef.current = { time: 0 };
  }
  const phaseOrigin = effect ? effectOriginRef.current.time : undefined;
  const pixelInsertion = usePixelInsertionImpact(effect, !glass && dropCell && effectsEnabled, phaseOrigin);
  const pixelStagesValue = pixelInsertion.active && percent !== undefined && effect !== undefined && Math.abs(percent - effect.to) < 0.01;
  const displayPercent = pixelStagesValue && !pixelInsertion.impacted && effect
    ? Math.max(0, Math.min(100, effect.from))
    : percent;
  const percentText = displayPercent !== undefined ? `${Math.round(displayPercent)}%` : "--";
  const glassNumberLight = useAiUsageNumberLight({
    enabled: glass && dropCell && effect !== undefined,
    fill: waveFill,
    strength: waveStrength,
    effectId: effect?.id,
    phaseOrigin,
    text: percentText,
  });
  const pixelNumberLight = usePixelInsertionLights({
    enabled: pixelInsertion.active,
    effect,
    phaseOrigin,
  });
  const numberLight = glass ? glassNumberLight : pixelNumberLight;
  const pixelNumberFlash = usePixelUsageNumberFlash(percent, effectsEnabled && !glass && !pixelInsertion.active);
  const pixelFlashClass = pixelNumberFlash.active ? ` pixel-number-flash-${pixelNumberFlash.sequence % 2}` : "";
  return (
    <article className={`usage compact provider-tile ${providerKind(snapshot.provider)}${flash ? " mark-flash" : ""}${paused ? " mark-paused" : ""}${onFlip ? " flippable" : ""}`} style={providerAccentStyle(accent)} onClick={onFlip} title={onFlip ? "Tap for reset countdown" : undefined}>
      <div className="usage-top">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="tile-status">
          {updatedAgo && <span className="updated-ago">{updatedAgo}</span>}
          <span className={`source-pill ${sourceState}`}>{stale ? "cached" : snapshot.status !== "ok" ? readableStatus(snapshot.status) : paused ? "paused" : "live"}</span>
        </span>
      </div>
      <div className="metric">
        <span ref={numberLight.numberRef} className={`percent ai-usage-number${pixelFlashClass}`}><span className="ai-number-base">{percentText}</span><span ref={numberLight.leftLightRef} className="ai-number-light ai-number-light-left" aria-hidden="true">{percentText}</span><span ref={numberLight.rightLightRef} className="ai-number-light ai-number-light-right" aria-hidden="true">{percentText}</span></span>
        <span className="message">{providerMessage(snapshot)}</span>
      </div>
      <div ref={numberLight.barRef} key={effect?.id ?? "idle"} className={`bar${effect ? " usage-effect-bar" : ""}${effect && dropCell ? " drop-impact" : ""}${pixelInsertion.active ? " pixel-insert-active" : ""}`} style={effectStyle(effect, percent)} aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {buildUsageCells(percent, 10, glass ? effect : undefined)}
        {pixelInsertion.active && effect && <PixelInsertionScene effect={effect} leftBeamRef={pixelNumberLight.leftBeamRef} rightBeamRef={pixelNumberLight.rightBeamRef} />}
        <LiquidLayers
          waveStrength={effect && dropCell ? waveStrength : undefined}
          waveFill={effect && dropCell ? waveFill : undefined}
          colorToken={accent}
          phaseOrigin={effect && dropCell ? phaseOrigin : undefined}
        />
      </div>
      <div className="usage-meta" data-tip={`${metaLeft}\n${metaRight}`}>
        <span>{metaLeft}</span>
        <span>{metaRight}</span>
      </div>
    </article>
  );
});

function StatusPill({ status, label }: { status: UsageStatus | "warn"; label?: string }) {
  return <span className={`pill ${status}`}>{label ?? readableStatus(status as UsageStatus)}</span>;
}

function WidgetToasts({ notices, monitorToasts }: { notices: Partial<Record<Provider, ProviderLifecycle>>; monitorToasts: MonitorToast[] }) {
  // Every account, not a fixed three — a freshly added provider must toast on the widget too.
  const rows = Object.values(notices).filter((lifecycle): lifecycle is ProviderLifecycle =>
    Boolean(lifecycle) && !(lifecycle?.phase === "stopped" && lifecycle.generation === 1),
  );
  return (
    <div className="provider-lifecycle-toasts" aria-live="polite" aria-atomic="false">
      {rows.map((lifecycle) => (
        <div key={`provider-${lifecycle.provider}-${lifecycle.generation}-${lifecycle.phase}`} className={`provider-lifecycle-toast provider-toast ${lifecycleTone(lifecycle)}`}>
          <span className="provider-lifecycle-dot" aria-hidden="true" />
          <span>{lifecycle.message ?? `${providerLabel(lifecycle.provider)} ${lifecycleLabel(lifecycle)}`}</span>
        </div>
      ))}
      {monitorToasts.map((toast) => (
        <div key={`monitor-${toast.id}`} className={`provider-lifecycle-toast monitor-toast ${toast.tone}`}>
          <span className="provider-lifecycle-dot" aria-hidden="true" />
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  );
}

function ProviderMark({ provider }: { provider: Provider }) {
  // `provider` may be an account id or, from the colour editor, a literal kind. Both resolve here.
  if (provider === "claude" || accountRegistry[provider]?.kind === "claude") {
    return (
      <span className="mark pixel-claude-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <rect className="pixel-claude-fill" x="3" y="3" width="10" height="8" />
          <rect className="pixel-claude-fill" x="1" y="6" width="2" height="2" />
          <rect className="pixel-claude-fill" x="13" y="6" width="2" height="2" />
          <rect className="pixel-claude-eye" x="5" y="6" width="2" height="2" />
          <rect className="pixel-claude-eye" x="10" y="6" width="2" height="2" />
          <rect className="pixel-claude-fill" x="4" y="11" width="2" height="3" />
          <rect className="pixel-claude-fill" x="7" y="11" width="2" height="3" />
          <rect className="pixel-claude-fill" x="10" y="11" width="2" height="3" />
        </svg>
      </span>
    );
  }
  return (
    <span className="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path className="codex-knot" d="M12 3l7 4v10l-7 4-7-4V7z" />
        <path className="codex-knot" d="M12 3v6l5 3M19 7l-5 3v6M19 17l-7-4-7 4M5 7l7 4v10" />
      </svg>
    </span>
  );
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
