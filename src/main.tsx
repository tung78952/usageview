import React, { Component, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import "./styles.css";

type Provider = "claude" | "codex" | "codex-1";
type UsageStatus = "ok" | "not_open" | "not_logged_in" | "not_found" | "parser_failed" | "page_unavailable";

type UsageSnapshot = {
  provider: Provider;
  status: UsageStatus;
  message: string;
  usedLabel?: string;
  remainingLabel?: string;
  percentUsed?: number;
  resetLabel?: string;
  weeklyLabel?: string;
  debugText?: string;
  updatedAt: string;
};

type Settings = {
  claudeUrl: string;
  codexUrl: string;
  codex1Url: string;
  theme: "terminal" | "light";
  opacity: number;
  uiScale: number;
  alwaysOnTop: boolean;
  refreshIntervalSec: number;
  effectsEnabled: boolean;
  effectDurationMs: number;
  effectBarBrightness: number;
  effectDeltaBrightness: number;
  effectDropCell: boolean;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  showClaude: boolean;
  showCodex: boolean;
  showCodex1: boolean;
};

type AppMode = "widget" | "settings" | "compact";

type WindowGeometry = {
  width: number;
  height: number;
  x: number;
  y: number;
};

const defaultSettings: Settings = {
  claudeUrl: "https://claude.ai/settings/usage",
  codexUrl: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  codex1Url: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  theme: "terminal",
  opacity: 0.96,
  uiScale: 0.9,
  alwaysOnTop: true,
  refreshIntervalSec: 60,
  effectsEnabled: true,
  effectDurationMs: 4000,
  effectBarBrightness: 1.25,
  effectDeltaBrightness: 2,
  effectDropCell: true,
  corner: "top-right",
  showClaude: true,
  showCodex: true,
  showCodex1: false,
};

const GEOMETRY_KEY = "usageview.windowGeometry.v6";
const WIDGET_MIN_WIDTH = 320;
const WIDGET_MAX_WIDTH = 900;
const WIDGET_MIN_HEIGHT_FALLBACK = 260;
const COMPACT_MIN_WIDTH = 260;
const COMPACT_MIN_HEIGHT_FALLBACK = 130;

type EffectParticle = {
  x: number;
  y: number;
  size: number;
  delay: number;
};

type UsageEffect = {
  from: number;
  to: number;
  particles: EffectParticle[];
};

const emptySnapshot = (provider: Provider): UsageSnapshot => ({
  provider,
  status: "not_open",
  message: "Open settings to login",
  updatedAt: new Date().toISOString(),
});

function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem("usageview.settings");
    const loaded = saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    return {
      ...loaded,
      uiScale: 1,
      theme: loaded.theme === "light" ? "light" : "terminal", // glass/dark themes were removed
      effectsEnabled: loaded.effectsEnabled ?? true,
      effectDurationMs: clampNumber(loaded.effectDurationMs, 800, 8000, 4000),
      effectBarBrightness: clampNumber(loaded.effectBarBrightness, 0.45, 1.8, 1.25),
      effectDeltaBrightness: clampNumber(loaded.effectDeltaBrightness, 0.45, 2.2, 2),
      effectDropCell: loaded.effectDropCell ?? true,
      showClaude: loaded.showClaude ?? true,
      showCodex: loaded.showCodex ?? true,
      showCodex1: loaded.showCodex1 ?? false,
    };
  } catch {
    return { ...defaultSettings, uiScale: 1, showClaude: true, showCodex: true, showCodex1: false };
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

function themeClass(theme: Settings["theme"]) {
  return theme === "light" ? "theme-light" : "theme-terminal";
}

function panelStyle(settings: Settings): React.CSSProperties {
  return {
    "--ui-scale": 1,
    "--panel-opacity": settings.opacity,
    "--panel-opacity-pct": `${Math.round(settings.opacity * 100)}%`,
    "--effect-duration": `${settings.effectDurationMs}ms`,
    "--effect-bar-brightness": settings.effectBarBrightness,
    "--effect-delta-brightness": settings.effectDeltaBrightness,
  } as React.CSSProperties;
}

function loadWindowGeometry(): Partial<Record<AppMode, WindowGeometry>> {
  try {
    const saved = localStorage.getItem(GEOMETRY_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function saveWindowGeometry(mode: AppMode, geometry: WindowGeometry) {
  const normalized = normalizeWindowGeometry(mode, geometry, defaultWindowPosition(defaultSettings.corner));
  const current = loadWindowGeometry();
  localStorage.setItem(GEOMETRY_KEY, JSON.stringify({ ...current, [mode]: normalized }));
}

function defaultWindowSize(mode: AppMode) {
  if (mode === "settings") return { width: 460, height: 760 };
  if (mode === "compact") return { width: 320, height: 238 };
  return { width: 392, height: 500 };
}

function defaultWindowPosition(corner: Settings["corner"]) {
  const safeInset = Math.max(20, Math.min(80, Math.floor((window.screen.availWidth || 900) * 0.04)));
  const safeWidth = Math.max(360, window.screen.availWidth || 900);
  const safeHeight = Math.max(500, window.screen.availHeight || 700);
  const positions: Record<Settings["corner"], { x: number; y: number }> = {
    "top-left": { x: safeInset, y: safeInset },
    "top-right": { x: Math.max(safeInset, safeWidth - defaultWindowSize("widget").width - safeInset), y: safeInset },
    "bottom-left": { x: safeInset, y: Math.max(safeInset, safeHeight - defaultWindowSize("widget").height - safeInset) },
    "bottom-right": { x: Math.max(safeInset, safeWidth - defaultWindowSize("widget").width - safeInset), y: Math.max(safeInset, safeHeight - defaultWindowSize("widget").height - safeInset) },
  };
  return positions[corner];
}

function isGeometryVisible(geometry: WindowGeometry) {
  const screenWidth = window.screen.availWidth || 0;
  const screenHeight = window.screen.availHeight || 0;
  if (!screenWidth || !screenHeight) return true;
  const visibleWidth = Math.min(screenWidth, geometry.x + geometry.width) - Math.max(0, geometry.x);
  const visibleHeight = Math.min(screenHeight, geometry.y + geometry.height) - Math.max(0, geometry.y);
  return visibleWidth >= 120 && visibleHeight >= 80;
}

function normalizeWindowGeometry(mode: AppMode, geometry: Partial<WindowGeometry> | undefined, fallbackPosition: { x: number; y: number }): WindowGeometry {
  const fallbackSize = defaultWindowSize(mode);
  const minWidth = mode === "settings" ? 430 : mode === "compact" ? COMPACT_MIN_WIDTH : WIDGET_MIN_WIDTH;
  const minHeight = mode === "settings" ? 620 : mode === "compact" ? COMPACT_MIN_HEIGHT_FALLBACK : WIDGET_MIN_HEIGHT_FALLBACK;
  const maxWidth = Math.max(minWidth, window.screen.availWidth || fallbackSize.width);
  const maxHeight = Math.max(minHeight, window.screen.availHeight || fallbackSize.height);
  const width = Number.isFinite(geometry?.width) ? Math.min(maxWidth, Math.max(minWidth, Math.round(geometry!.width!))) : fallbackSize.width;
  const height = Number.isFinite(geometry?.height) ? Math.min(maxHeight, Math.max(minHeight, Math.round(geometry!.height!))) : fallbackSize.height;
  const maxX = Math.max(0, maxWidth - width);
  const maxY = Math.max(0, maxHeight - height);
  const rawX = Number.isFinite(geometry?.x) ? Math.round(geometry!.x!) : fallbackPosition.x;
  const rawY = Number.isFinite(geometry?.y) ? Math.round(geometry!.y!) : fallbackPosition.y;

  const normalized = {
    width,
    height,
    x: Math.min(maxX, Math.max(0, rawX)),
    y: Math.min(maxY, Math.max(0, rawY)),
  };
  if (!isGeometryVisible(normalized)) {
    return { width: fallbackSize.width, height: fallbackSize.height, x: fallbackPosition.x, y: fallbackPosition.y };
  }
  return normalized;
}

async function recoverVisibleWindow(mode: AppMode, corner: Settings["corner"]) {
  const appWindow = getCurrentWindow();
  const fallbackPosition = defaultWindowPosition(corner);
  const saved = loadWindowGeometry()[mode];
  const geometry = normalizeWindowGeometry(mode, saved, fallbackPosition);
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
  } catch {
    // no-op: older platforms can reject this while the window is being created.
  }
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.setSize(new LogicalSize(geometry.width, geometry.height)).catch(() => undefined);
  await appWindow.setPosition(new LogicalPosition(geometry.x, geometry.y)).catch(() => undefined);
  await appWindow.show().catch(() => undefined);
  await appWindow.setFocus().catch(() => undefined);
}

// Switching modes (widget <-> settings <-> compact) should resize the window in place, not teleport
// it to that mode's remembered corner. Keep the current top-left; only change the size (clamped so a
// taller mode stays on-screen).
async function resizeWindowForMode(mode: AppMode) {
  const appWindow = getCurrentWindow();
  const scaleFactor = await appWindow.scaleFactor();
  const position = (await appWindow.outerPosition()).toLogical(scaleFactor);
  const here = { x: Math.round(position.x), y: Math.round(position.y) };
  const saved = loadWindowGeometry()[mode];
  const size = defaultWindowSize(mode);
  const geometry = normalizeWindowGeometry(
    mode,
    { width: saved?.width ?? size.width, height: saved?.height ?? size.height, x: here.x, y: here.y },
    here,
  );
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
  } catch {
    // no-op
  }
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.setSize(new LogicalSize(geometry.width, geometry.height)).catch(() => undefined);
  await appWindow.setPosition(new LogicalPosition(geometry.x, geometry.y)).catch(() => undefined);
}

async function readCurrentGeometry(): Promise<WindowGeometry> {
  const appWindow = getCurrentWindow();
  const scaleFactor = await appWindow.scaleFactor();
  const size = (await appWindow.innerSize()).toLogical(scaleFactor);
  const position = (await appWindow.outerPosition()).toLogical(scaleFactor);
  return {
    width: Math.round(size.width),
    height: Math.round(size.height),
    x: Math.round(position.x),
    y: Math.round(position.y),
  };
}

function shouldStartWindowDrag(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest(
    "button, input, select, textarea, a, label, summary, details, [role='button'], .window-controls, .advanced-tools, .debug-text",
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

function retainLastGoodClaude(snapshot: UsageSnapshot): UsageSnapshot {
  if (snapshot.provider !== "claude" || (snapshot.status !== "page_unavailable" && snapshot.status !== "not_found")) {
    return snapshot;
  }
  const previous = loadSnapshot("claude");
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
  if (provider === "claude") return "Claude";
  if (provider === "codex-1") return "Codex 2";
  return "Codex";
}

function providerUrl(provider: Provider, settings: Settings): string {
  if (provider === "claude") return settings.claudeUrl;
  if (provider === "codex-1") return settings.codex1Url;
  return settings.codexUrl;
}

function resetCountdownLabel(snapshot: UsageSnapshot): string | undefined {
  if (!snapshot.resetLabel) return undefined;
  const resetMs = parseResetMs(snapshot.resetLabel);
  if (resetMs === null) return "resetting soon";
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return "resetting soon";
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${minutes}m`;
}

function providerMessage(snapshot: UsageSnapshot) {
  if (snapshot.status === "ok") {
    return resetCountdownLabel(snapshot) ?? "up to date";
  }
  if (snapshot.status === "not_found" && snapshot.provider === "claude") return "Usage page not detected";
  if (snapshot.status === "not_open") return "Open login";
  if (snapshot.status === "not_logged_in") return "Sign in needed";
  return snapshot.message;
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

function usageMetaLeft(snapshot: UsageSnapshot, _percent?: number) {
  // Only ever show a clean "Weekly left X%" (or a placeholder) — never raw scraped text, which for
  // Claude's DOM fallback can contain promo/Fable copy.
  const weeklyUsed = snapshot.weeklyLabel?.match(/Weekly\s+(\d{1,3})(?:\.\d+)?%\s+used/i)?.[1];
  if (weeklyUsed !== undefined) return `Weekly left ${100 - Number(weeklyUsed)}%`;
  const weeklyLeft = snapshot.remainingLabel?.match(/Weekly left\s+(\d{1,3})%/i)?.[1];
  if (weeklyLeft !== undefined) return `Weekly left ${weeklyLeft}%`;
  return "Weekly left --";
}

function usageMetaRight(snapshot: UsageSnapshot) {
  return resetLabelToClock(snapshot.resetLabel) || "Reset --";
}

function hasUsageDisplayValue(snapshot: UsageSnapshot) {
  return (
    snapshot.percentUsed !== undefined ||
    !!snapshot.usedLabel ||
    !!snapshot.remainingLabel ||
    !!snapshot.resetLabel ||
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

function trayTooltipText(snapshots: Record<Provider, UsageSnapshot>) {
  return [
    `Claude: ${tooltipLeftLabel(snapshots.claude)}`,
    `Codex 1: ${tooltipLeftLabel(snapshots.codex)}`,
    `Codex 2: ${tooltipLeftLabel(snapshots["codex-1"])}`,
  ].join("\n");
}

const LIMITED_RESET_REFRESH_LEAD_MS = 2 * 60 * 1000;
const LIMITED_FALLBACK_REFRESH_MS = 10 * 60 * 1000;

function limitedThreshold(provider: Provider) {
  return provider === "claude" ? 99 : 100;
}

function isProviderLimited(provider: Provider, snapshot: UsageSnapshot) {
  return (snapshot.percentUsed ?? 0) >= limitedThreshold(provider);
}

function shouldAutoRefreshProvider(provider: Provider, snapshot: UsageSnapshot, now: number, lastLimitedRefreshAt: Record<Provider, number>) {
  if (!isProviderLimited(provider, snapshot)) return true;

  const resetMs = parseResetMs(snapshot.resetLabel);
  if (resetMs !== null) return resetMs <= now + LIMITED_RESET_REFRESH_LEAD_MS;

  return now - (lastLimitedRefreshAt[provider] || 0) >= LIMITED_FALLBACK_REFRESH_MS;
}

function providerForLabel(label: string): Provider | null {
  if (label === "provider_claude") return "claude";
  if (label === "provider_codex") return "codex";
  if (label === "provider_codex_1") return "codex-1";
  return null;
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
  await invoke("open_provider_window", { provider, url });
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
  await invoke("logout_provider", { provider, url });
}

// Open in Chrome; fall back to the OS default browser if Chrome isn't installed.
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
  const encoded = await invoke<string>("discover_provider_api", { provider, url });
  try {
    return JSON.stringify(JSON.parse(decodeURIComponent(encoded)), null, 2);
  } catch {
    return decodeURIComponent(encoded);
  }
}

async function extractProvider(provider: Provider, url: string): Promise<UsageSnapshot> {
  try {
    const encoded = await invoke<string>("extract_provider", { provider, url });
    const snapshot = retainLastGoodClaude(decodeSnapshot(provider, encoded));
    saveSnapshot(snapshot);
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
    saveSnapshot(snapshot);
    return snapshot;
  }
}

async function refreshProviderFromUrl(provider: Provider, url: string, background = false): Promise<UsageSnapshot> {
  try {
    await refreshProviderPage(provider, url, background);
    await wait(provider === "claude" ? 2600 : 900);
  } catch {
    // If navigation fails, still try the extractor so the UI gets a useful error snapshot.
  }
  return extractProvider(provider, url);
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
  return <WidgetApp />;
}

// Cross-window command bus: the detached Settings window can't touch the widget's tile/engine directly.
// Effect-tester and per-account "Refresh now" are posted to localStorage; the widget window runs them via
// its "storage" listener (single owner of the extract engine + in-flight guard). Other account actions
// (login/logout/reload/browser/find-api) act on global provider windows and run locally in either window.
const APP_CMD_KEY = "usageview.appcmd";
type AppCommand =
  | { nonce: string; type: "play"; provider: Provider; from: number; to: number; driveBar: boolean }
  | { nonce: string; type: "restore" }
  | { nonce: string; type: "refresh"; provider: Provider };

function postAppCommand(command: AppCommand) {
  localStorage.setItem(APP_CMD_KEY, JSON.stringify(command));
}

function newNonce() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Detached Settings window: same bundle, rendered when the window label is "settings". Hosts the full
// settings screen (Status + Accounts + Widget config) reusing the same components. Settings persist to
// localStorage (widget mirrors them via its "storage" listener). Snapshots shown here come from
// localStorage and update when the widget saves a fresh read. Tester + Refresh route through the bus.
function SettingsWindowApp() {
  const [settings, setSettings] = useState(loadSettings);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [snapshots, setSnapshots] = useState<Record<Provider, UsageSnapshot>>({
    claude: loadSnapshot("claude"),
    codex: loadSnapshot("codex"),
    "codex-1": loadSnapshot("codex-1"),
  });
  const [discovery, setDiscovery] = useState<Partial<Record<Provider, string>>>({});
  const [busy, setBusy] = useState<Provider | `${Provider}-open` | `${Provider}-close` | `${Provider}-reload` | `${Provider}-logout` | `${Provider}-discover` | null>(null);
  const [message, setMessage] = useState("Settings");
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(pinned);
  }, [pinned]);

  useEffect(() => {
    function reload() {
      setSettings(loadSettings());
      setSnapshots({ claude: loadSnapshot("claude"), codex: loadSnapshot("codex"), "codex-1": loadSnapshot("codex-1") });
    }
    window.addEventListener("storage", reload);
    window.addEventListener("usageview:settings", reload);
    window.addEventListener("usageview:snapshot", reload);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener("usageview:settings", reload);
      window.removeEventListener("usageview:snapshot", reload);
    };
  }, []);

  function handleChange(next: Settings) {
    setSettings(next);
    saveSettings(next);
    setSavedAt(new Date());
  }

  async function openInApp(provider: Provider) {
    setBusy(`${provider}-open`);
    try { await openProvider(provider, settings); setMessage(`${providerLabel(provider)} login window opened.`); }
    catch (error) { setMessage(`${providerLabel(provider)} open failed: ${String(error)}`); }
    setBusy(null);
  }
  async function closeInApp(provider: Provider) {
    setBusy(`${provider}-close`);
    try { await closeProvider(provider); setMessage(`${providerLabel(provider)} window hidden.`); }
    catch (error) { setMessage(`${providerLabel(provider)} close failed: ${String(error)}`); }
    setBusy(null);
  }
  async function reloadInApp(provider: Provider) {
    setBusy(`${provider}-reload`);
    try { await refreshProviderPage(provider, providerUrl(provider, settings)); setMessage(`${providerLabel(provider)} usage page opened.`); }
    catch (error) { setMessage(`${providerLabel(provider)} reload failed: ${String(error)}`); }
    setBusy(null);
  }
  async function openBrowser(provider: Provider) {
    const via = await openInChrome(providerUrl(provider, settings));
    setMessage(via === "chrome" ? `${providerLabel(provider)} opened in Chrome.` : `${providerLabel(provider)} opened in default browser (Chrome not found).`);
  }
  async function findApi(provider: Provider) {
    setBusy(`${provider}-discover`);
    try {
      const result = await discoverProviderApi(provider, providerUrl(provider, settings));
      setDiscovery((current) => ({ ...current, [provider]: result }));
      setMessage(`${providerLabel(provider)}: API discovery done.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setDiscovery((current) => ({ ...current, [provider]: `Error: ${msg}` }));
      setMessage(`${providerLabel(provider)} discovery failed: ${msg}`);
    }
    setBusy(null);
  }
  async function logoutInApp(provider: Provider) {
    setBusy(`${provider}-logout`);
    try { await logoutProvider(provider, providerUrl(provider, settings)); setMessage(`${providerLabel(provider)} signed out.`); }
    catch (error) { setMessage(`${providerLabel(provider)} logout failed: ${String(error)}`); }
    setBusy(null);
  }
  // Refresh runs on the widget (single engine owner) via the command bus; the fresh snapshot comes back
  // here through the storage event that saveSnapshot fires.
  function refresh(provider: Provider) {
    postAppCommand({ nonce: newNonce(), type: "refresh", provider });
    setMessage(`${providerLabel(provider)}: refresh requested.`);
  }

  const providerPercents: Partial<Record<Provider, number>> = {
    claude: snapshotPercent(snapshots.claude),
    codex: snapshotPercent(snapshots.codex),
    "codex-1": snapshotPercent(snapshots["codex-1"]),
  };
  const providerFields: [Provider, keyof Settings, keyof Settings, keyof Settings][] = [
    ["claude", "claudeUrl", "showClaude", "showClaude"],
    ["codex", "codexUrl", "showCodex", "showCodex"],
    ["codex-1", "codex1Url", "showCodex1", "showCodex1"],
  ];

  return (
    <main className={`control-shell ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={startWindowDrag}>
      <div className="scale-shell">
        <header className="titlebar">
          <div className="window-title">
            <strong>UsageView.cfg</strong>
            <span>{savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Auto-save on"}</span>
          </div>
          <div className="title-actions">
            <WindowControls
              pinned={pinned}
              onTogglePin={() => setPinned((prev) => !prev)}
              onMinimize={() => undefined}
              onMaximize={() => undefined}
              onClose={() => void getCurrentWindow().hide()}
              showMinimize={false}
              showMaximize={false}
            />
          </div>
        </header>

        <section className="settings-section">
          <h2>Status</h2>
          <div className="status-line"><span />{message}<strong>{settings.alwaysOnTop ? "pinned" : "unpinned"}</strong></div>
        </section>

        <section className="settings-section">
          <h2>Accounts</h2>
          {providerFields.map(([provider, urlKey, showKey]) => (
            <ProviderPanel
              key={provider}
              provider={provider}
              url={settings[urlKey] as string}
              snapshot={snapshots[provider]}
              busy={busy}
              onOpen={() => void openInApp(provider)}
              onBrowser={() => void openBrowser(provider)}
              onReload={() => void reloadInApp(provider)}
              onClose={() => void closeInApp(provider)}
              onLogout={() => void logoutInApp(provider)}
              onDiscover={() => void findApi(provider)}
              discovery={discovery[provider]}
              onExtract={() => refresh(provider)}
              onUrlChange={(url) => handleChange({ ...settings, [urlKey]: url })}
              shownInWidget={settings[showKey] as boolean}
              onToggleShown={() => handleChange({ ...settings, [showKey]: !(settings[showKey] as boolean) })}
            />
          ))}
        </section>

        <WidgetSettings
          settings={settings}
          savedAt={savedAt}
          onChange={handleChange}
          onEffectPlay={(provider, from, to, driveBar) => postAppCommand({ nonce: newNonce(), type: "play", provider, from, to, driveBar })}
          onEffectRestore={() => postAppCommand({ nonce: newNonce(), type: "restore" })}
          providerPercents={providerPercents}
        />
      </div>
    </main>
  );
}

function WidgetApp() {
  const widgetRef = useRef<HTMLElement | null>(null);
  const widgetHeaderRef = useRef<HTMLDivElement | null>(null);
  const providersRef = useRef<HTMLDivElement | null>(null);
  const compactProvidersRef = useRef<HTMLDivElement | null>(null);
  const compactPointerRef = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const [mode, setMode] = useState<AppMode>("widget");
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  const [compactTimerSet, setCompactTimerSet] = useState<Set<Provider>>(new Set());
  const [compactHovered, setCompactHovered] = useState<Provider | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  const [snapshots, setSnapshots] = useState<Record<Provider, UsageSnapshot>>({
    claude: loadSnapshot("claude"),
    codex: loadSnapshot("codex"),
    "codex-1": loadSnapshot("codex-1"),
  });
  const snapshotsRef = useRef(snapshots);
  const refreshInFlightRef = useRef<Set<Provider>>(new Set());
  const lastLimitedAutoRefreshRef = useRef<Record<Provider, number>>({ claude: 0, codex: 0, "codex-1": 0 });
  const prevFlashTokenRef = useRef<Partial<Record<Provider, string>>>({});
  const prevEffectPercentRef = useRef<Partial<Record<Provider, number>>>({});
  const runtimeValidReadRef = useRef<Partial<Record<Provider, boolean>>>({});
  const lastFreshAtRef = useRef<Partial<Record<Provider, string>>>({});
  const flashTimersRef = useRef<Partial<Record<Provider, number>>>({});
  const effectTimersRef = useRef<Partial<Record<Provider, number>>>({});
  const lastCmdNonceRef = useRef<string | null>(null);
  const [flashSet, setFlashSet] = useState<Set<Provider>>(new Set());
  const [activeEffects, setActiveEffects] = useState<Partial<Record<Provider, UsageEffect>>>({});
  const [, setAgoTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [busy, setBusy] = useState<Provider | `${Provider}-open` | `${Provider}-close` | `${Provider}-reload` | `${Provider}-logout` | `${Provider}-discover` | null>(null);
  const [settingsSavedAt, setSettingsSavedAt] = useState<Date | null>(null);

  function updateSettings(next: Settings) {
    setSettings(next);
    saveSettings(next);
    setSettingsSavedAt(new Date());
  }

  function activateUsageEffects(effectPayloads: Partial<Record<Provider, UsageEffect>>) {
    if (!settingsRef.current.effectsEnabled) return;
    const effectProviders = (["claude", "codex", "codex-1"] as Provider[]).filter((provider) => effectPayloads[provider]);
    if (!effectProviders.length) return;

    for (const provider of effectProviders) {
      const existingTimer = effectTimersRef.current[provider];
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    }

    setActiveEffects((prev) => ({ ...prev, ...effectPayloads }));
    const duration = clampNumber(settingsRef.current.effectDurationMs, 800, 8000, 4000) + 900;
    for (const provider of effectProviders) {
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
      const base = snapshotsRef.current[provider];
      const synthetic: UsageSnapshot = { ...base, provider, status: "ok", percentUsed: t, updatedAt: base.updatedAt };
      // Neutralize the auto-trigger for this synthetic write so our from->to wins (no double-fire).
      prevFlashTokenRef.current[provider] = flashToken(synthetic);
      prevEffectPercentRef.current[provider] = t;
      runtimeValidReadRef.current[provider] = true;
      setSnapshots((current) => ({ ...current, [provider]: synthetic }));
    }
    activateUsageEffects({ [provider]: makeUsageEffect(f, t) });
  }

  async function restoreTestEffect() {
    for (const timer of Object.values(effectTimersRef.current)) {
      if (timer !== undefined) window.clearTimeout(timer);
    }
    effectTimersRef.current = {};
    setActiveEffects({});
    const providers = ["claude", "codex", "codex-1"] as Provider[];
    const results = await Promise.all(providers.map((p) => guardedRefresh(p, providerUrl(p, settings), true)));
    setSnapshots((current) => results.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), current));
  }

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop);
  }, [settings.alwaysOnTop]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    void appWindow.clearEffects().catch(() => undefined);
    void recoverVisibleWindow("widget", settings.corner);
  }, []);

  useEffect(() => {
    void resizeWindowForMode(mode);
  }, [mode]);


  useEffect(() => {
    if (mode !== "widget" && mode !== "compact") {
      void getCurrentWindow().setMinSize(new LogicalSize(430, 620)).catch(() => undefined);
      return;
    }

    if (mode === "compact") {
      const appWindow = getCurrentWindow();
      let animationFrame = 0;
      // Clear the widget mode's height clamp so compact can size itself freely.
      void appWindow.setMaxSize(new LogicalSize(4000, 4000)).catch(() => undefined);

      function updateCompactLayout() {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = window.requestAnimationFrame(() => {
          const providers = compactProvidersRef.current;
          if (!providers) return;
          const height = Math.max(COMPACT_MIN_HEIGHT_FALLBACK, Math.ceil(providers.scrollHeight + 14));
          void appWindow.innerSize().then((size) => {
            if (size.height < height) {
              return appWindow.setSize(new LogicalSize(size.width, height));
            }
            return undefined;
          }).catch(() => undefined);
          void appWindow.setMinSize(new LogicalSize(COMPACT_MIN_WIDTH, height)).catch(() => undefined);
        });
      }

      updateCompactLayout();
      const observer = new ResizeObserver(updateCompactLayout);
      if (compactProvidersRef.current) observer.observe(compactProvidersRef.current);
      compactProvidersRef.current?.querySelectorAll(".provider-tile, .empty-state").forEach((element) => observer.observe(element));

      return () => {
        window.cancelAnimationFrame(animationFrame);
        observer.disconnect();
      };
    }

    const appWindow = getCurrentWindow();
    let animationFrame = 0;

    // Auto-fit: window height always equals content height (grow AND shrink) so there is never dead
    // space at the bottom, and it adapts when providers are added/removed. Height is locked (min==max)
    // so the window can't be dragged vertically into empty space; width stays freely resizable.
    function updateLayout() {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const widget = widgetRef.current;
        const header = widgetHeaderRef.current;
        const providers = providersRef.current;
        if (!widget || !header || !providers) return;

        const widgetStyle = window.getComputedStyle(widget);
        const borderHeight = (Number.parseFloat(widgetStyle.borderTopWidth) || 0) + (Number.parseFloat(widgetStyle.borderBottomWidth) || 0);
        const boxesMin = Math.ceil(header.getBoundingClientRect().height + providers.scrollHeight + borderHeight);
        const contentH = Math.max(WIDGET_MIN_HEIGHT_FALLBACK, boxesMin);

        const rect = widget.getBoundingClientRect();
        const innerWidth = Math.round(rect.width);
        const innerHeight = Math.round(rect.height);

        void appWindow.setMinSize(new LogicalSize(WIDGET_MIN_WIDTH, contentH)).catch(() => undefined);
        void appWindow.setMaxSize(new LogicalSize(WIDGET_MAX_WIDTH, contentH)).catch(() => undefined);
        if (Math.abs(innerHeight - contentH) > 1) {
          void appWindow.setSize(new LogicalSize(Math.max(WIDGET_MIN_WIDTH, innerWidth), contentH)).catch(() => undefined);
        }
      });
    }

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    if (widgetRef.current) observer.observe(widgetRef.current);
    if (widgetHeaderRef.current) observer.observe(widgetHeaderRef.current);
    if (providersRef.current) observer.observe(providersRef.current);
    providersRef.current?.querySelectorAll(".provider-tile").forEach((element) => observer.observe(element));

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [mode, settings.theme, snapshots.claude, snapshots.codex, snapshots["codex-1"], settings.showClaude, settings.showCodex, settings.showCodex1]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let saveTimer: number | undefined;
    let unlistenResize: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let disposed = false;

    function scheduleSave() {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        if (!disposed) saveWindowGeometry(mode, await readCurrentGeometry());
      }, 250);
    }

    void Promise.all([
      appWindow.onResized(scheduleSave),
      appWindow.onMoved(scheduleSave),
    ]).then(([resizeUnlisten, moveUnlisten]) => {
      unlistenResize = resizeUnlisten;
      unlistenMove = moveUnlisten;
    });

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      unlistenResize?.();
      unlistenMove?.();
    };
  }, [mode]);

  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  useEffect(() => {
    void invoke("update_tray_tooltip", { text: trayTooltipText(snapshots) }).catch(() => undefined);
  }, [snapshots]);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(flashTimersRef.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
      for (const timer of Object.values(effectTimersRef.current)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    const effectPayloads: Partial<Record<Provider, UsageEffect>> = {};
    for (const provider of ["claude", "codex", "codex-1"] as Provider[]) {
      const percent = snapshotPercent(snapshotsRef.current[provider]);
      if (typeof percent !== "number") continue;
      prevEffectPercentRef.current[provider] = percent;
      runtimeValidReadRef.current[provider] = true;
      if (percent > 0) effectPayloads[provider] = makeUsageEffect(0, percent);
    }
    activateUsageEffects(effectPayloads);
  }, []);

  // Close the compact context menu whenever the window loses focus. This also covers
  // hiding via the tray "Hide" item (which bypasses React), so the menu never lingers
  // and reappears when the widget is shown again.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) setCompactMenuOpen(false);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  // Record the timestamp of the last GENUINE valid read per provider (a non-empty flashToken).
  // Retained Claude snapshots bump updatedAt but have an empty flashToken, so this stays put and
  // "updated ago" reflects real freshness instead of the retain time.
  useEffect(() => {
    for (const p of ["claude", "codex", "codex-1"] as Provider[]) {
      if (flashToken(snapshots[p])) lastFreshAtRef.current[p] = snapshots[p].updatedAt;
    }
  }, [snapshots]);

  // Re-render every 30s so the "updated ago" labels stay current between refreshes.
  useEffect(() => {
    const id = window.setInterval(() => setAgoTick((tick) => tick + 1), 30000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    function reloadLocal() {
      setSettings(loadSettings());
      setSnapshots({ claude: loadSnapshot("claude"), codex: loadSnapshot("codex"), "codex-1": loadSnapshot("codex-1") });
      setLastUpdated(new Date());
    }
    window.addEventListener("storage", reloadLocal);
    window.addEventListener("usageview:snapshot", reloadLocal);
    window.addEventListener("usageview:settings", reloadLocal);
    return () => {
      window.removeEventListener("storage", reloadLocal);
      window.removeEventListener("usageview:snapshot", reloadLocal);
      window.removeEventListener("usageview:settings", reloadLocal);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshOpenProviders(force = false) {
      const now = Date.now();
      const currentSnapshots = snapshotsRef.current;
      const providers: Provider[] = (["claude", "codex", "codex-1"] as Provider[]).filter((provider) =>
        force || shouldAutoRefreshProvider(provider, currentSnapshots[provider], now, lastLimitedAutoRefreshRef.current)
      );
      if (!providers.length) return;

      for (const provider of providers) {
        if (isProviderLimited(provider, currentSnapshots[provider]) && parseResetMs(currentSnapshots[provider].resetLabel) === null) {
          lastLimitedAutoRefreshRef.current[provider] = now;
        }
      }

      const results = await Promise.all(
        providers.map((provider) => guardedRefresh(provider, providerUrl(provider, settings), true)),
      );
      if (!cancelled) {
        setSnapshots((current) => results.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), current));
        setLastUpdated(new Date());
      }
    }
    // Refresh once shortly after launch (gives the hidden WebViews a moment to exist/navigate),
    // then keep refreshing on the interval — all silently in the background.
    const initial = window.setTimeout(() => refreshOpenProviders(true), 800);
    const interval = window.setInterval(refreshOpenProviders, Math.max(10, settings.refreshIntervalSec) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [settings.refreshIntervalSec, settings.claudeUrl, settings.codexUrl, settings.codex1Url]);

  const shown = useMemo(() => {
    return (["claude", "codex", "codex-1"] as Provider[]).filter((provider) =>
      provider === "claude" ? settings.showClaude : provider === "codex-1" ? settings.showCodex1 : settings.showCodex
    );
  }, [settings.showClaude, settings.showCodex, settings.showCodex1]);

  // Never let two reads of the same provider run at once. At low refresh intervals a slow Claude
  // read (reload + scrape, ~3-15s) would otherwise be reloaded out from under itself by the next
  // tick, fail, and fall back to the cached value. Codex reads are fast so they are never skipped.
  async function guardedRefresh(provider: Provider, url: string, background: boolean): Promise<UsageSnapshot> {
    if (refreshInFlightRef.current.has(provider)) return snapshotsRef.current[provider];
    refreshInFlightRef.current.add(provider);
    try {
      return await refreshProviderFromUrl(provider, url, background);
    } finally {
      refreshInFlightRef.current.delete(provider);
    }
  }

  async function refresh(provider: Provider) {
    setBusy(provider);
    const snapshot = await guardedRefresh(provider, providerUrl(provider, settings), false);
    triggerManualReplay(provider, snapshot);
    setSnapshots((currentSnapshots) => ({ ...currentSnapshots, [provider]: snapshot }));
    setBusy(null);
  }

  useEffect(() => {
    setCompactTimerSet((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const p of ["claude", "codex", "codex-1"] as Provider[]) {
        if (isProviderLimited(p, snapshots[p]) && !next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [snapshots]);

  useEffect(() => {
    const newly: Provider[] = [];
    const effectPayloads: Partial<Record<Provider, UsageEffect>> = {};
    for (const p of ["claude", "codex", "codex-1"] as Provider[]) {
      const token = flashToken(snapshots[p]);
      const previousToken = prevFlashTokenRef.current[p];
      const previousPercent = prevEffectPercentRef.current[p];
      const nextPercent = snapshotPercent(snapshots[p]);
      const hasRuntimeValidRead = runtimeValidReadRef.current[p] === true;
      prevFlashTokenRef.current[p] = token;
      if (previousToken !== undefined && token && token !== previousToken) {
        newly.push(p);
        if (typeof nextPercent === "number" && nextPercent > 0) {
          const isStartupReveal = !hasRuntimeValidRead;
          const increased = hasRuntimeValidRead && typeof previousPercent === "number" && nextPercent > previousPercent;
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

  function toggleCompactTimer(provider: Provider) {
    setCompactTimerSet((prev) => {
      const next = new Set(prev);
      next.has(provider) ? next.delete(provider) : next.add(provider);
      return next;
    });
  }

  // Execute commands posted by the detached Settings window (single engine owner lives here).
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== APP_CMD_KEY || !event.newValue) return;
      let command: AppCommand;
      try { command = JSON.parse(event.newValue) as AppCommand; } catch { return; }
      if (!command?.nonce || command.nonce === lastCmdNonceRef.current) return;
      lastCmdNonceRef.current = command.nonce;
      if (command.type === "play") playTestEffect(command.provider, command.from, command.to, command.driveBar);
      else if (command.type === "restore") void restoreTestEffect();
      else if (command.type === "refresh") void refresh(command.provider);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [settings]);

  async function refreshAll() {
    setBusy("claude");
    const results = await Promise.all(
      (["claude", "codex", "codex-1"] as Provider[]).map((provider) => guardedRefresh(provider, providerUrl(provider, settings), false)),
    );
    results.forEach((snapshot) => triggerManualReplay(snapshot.provider, snapshot));
    setSnapshots((currentSnapshots) => results.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), currentSnapshots));
    setLastUpdated(new Date());
    setBusy(null);
  }

  async function minimizeWindow() {
    await getCurrentWindow().minimize();
  }

  async function toggleMaximizeWindow() {
    const appWindow = getCurrentWindow();
    if (await appWindow.isMaximized()) {
      await appWindow.unmaximize();
    } else {
      await appWindow.maximize();
    }
  }

  async function closeWindow() {
    await getCurrentWindow().close();
  }

  function openCompactMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    if ((event.target as HTMLElement).closest("button")) return;
    if (compactPointerRef.current?.dragged) {
      compactPointerRef.current = null;
      return;
    }
    setCompactMenuOpen((open) => !open);
  }

  function prepareCompactDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    compactPointerRef.current = { x: event.clientX, y: event.clientY, dragged: false };
  }

  function maybeStartCompactDrag(event: React.MouseEvent<HTMLElement>) {
    const pointer = compactPointerRef.current;
    if (!pointer || pointer.dragged || (event.buttons & 1) !== 1) return;
    if (Math.abs(event.clientX - pointer.x) < 5 && Math.abs(event.clientY - pointer.y) < 5) return;
    pointer.dragged = true;
    setCompactMenuOpen(false);
    void getCurrentWindow().startDragging().catch(() => undefined);
  }

  function togglePinned() {
    updateSettings({ ...settings, alwaysOnTop: !settings.alwaysOnTop });
  }

  const now = Date.now();
  const isPaused = (p: Provider) =>
    !shouldAutoRefreshProvider(p, snapshots[p], now, lastLimitedAutoRefreshRef.current);
  const agoFor = (p: Provider) => formatAgo(lastFreshAtRef.current[p]);

  if (mode === "compact") {
    // While a usage effect is running, freeze hover so a stray cursor move across a tile edge
    // doesn't swap UsageBlock<->CompactUsageBlock — that remount restarts the CSS animation and
    // replays the effect. Check any provider: hovering B while A animates would collapse A too.
    const effectRunning = (["claude", "codex", "codex-1"] as Provider[]).some((p) => activeEffects[p] !== undefined);
    return (
      <main className={`compact-widget ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={prepareCompactDrag} onMouseMove={maybeStartCompactDrag} onContextMenu={openCompactMenu} onClick={() => { if (compactMenuOpen) setCompactMenuOpen(false); }}>
        <div ref={compactProvidersRef} className="compact-providers">
          {shown.length > 0 ? shown.map((provider) => (
            <div
              key={provider}
              onMouseEnter={() => { if (effectRunning) return; setCompactHovered(provider); }}
              onMouseLeave={() => { if (effectRunning) return; setCompactHovered(null); }}
              onClick={() => { if (compactMenuOpen) { setCompactMenuOpen(false); return; } if (!compactTimerSet.has(provider)) toggleCompactTimer(provider); }}
              style={{ cursor: compactTimerSet.has(provider) ? "default" : "pointer" }}
            >
              {compactTimerSet.has(provider)
                ? <CompactTimerView snapshot={snapshots[provider]} onBack={() => toggleCompactTimer(provider)} paused={isPaused(provider)} />
              : compactHovered === provider
                ? <UsageBlock snapshot={snapshots[provider]} flash={flashSet.has(provider)} paused={isPaused(provider)} updatedAgo={agoFor(provider)} effect={settings.effectsEnabled ? activeEffects[provider] : undefined} dropCell={settings.effectDropCell} />
                : <CompactUsageBlock snapshot={snapshots[provider]} flash={flashSet.has(provider)} paused={isPaused(provider)} updatedAgo={agoFor(provider)} effect={settings.effectsEnabled ? activeEffects[provider] : undefined} dropCell={settings.effectDropCell} />
              }
            </div>
          )) : <EmptyProviderState />}
        </div>
        {compactMenuOpen && (
          <div className="compact-menu" role="menu" onClick={(event) => event.stopPropagation()}>
            <button onClick={() => { togglePinned(); setCompactMenuOpen(false); }}>{settings.alwaysOnTop ? "Unpin" : "Pin"}</button>
            <button onClick={() => { setCompactMenuOpen(false); void refreshAll(); }}>Refresh</button>
            <button onClick={() => { setCompactMenuOpen(false); void invoke("toggle_settings_window"); }}>Settings</button>
            <button onClick={() => { setCompactMenuOpen(false); setMode("widget"); }}>Full view</button>
            <button className="danger" onClick={() => { setCompactMenuOpen(false); void closeWindow(); }}>Close</button>
          </div>
        )}
      </main>
    );
  }

  return (
    <main ref={widgetRef} className={`widget ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={startWindowDrag}>
      <div className="scale-shell">
      <div ref={widgetHeaderRef} className="widget-header">
        <div className="window-title">
          <span>updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div className="header-actions">
          <button className={`window-control refresh${busy !== null ? " spinning" : ""}`} type="button" title="Refresh now" aria-label="Refresh now" onClick={() => void refreshAll()} disabled={busy !== null}><RefreshIcon /></button>
          <button className="window-control gear" type="button" title="Settings" aria-label="Settings" onClick={() => void invoke("toggle_settings_window")}><GearIcon /></button>
          <button className="window-control compact" type="button" title="Compact mode" aria-label="Compact mode" onClick={() => setMode("compact")}><CompactIcon /></button>
          <WindowControls pinned={settings.alwaysOnTop} onTogglePin={togglePinned} onMinimize={() => void minimizeWindow()} onMaximize={() => void toggleMaximizeWindow()} onClose={() => void closeWindow()} showMinimize={false} showMaximize={false} />
        </div>
      </div>
      <div ref={providersRef} className="providers">
        {shown.length > 0 ? shown.map((provider) => <UsageBlock key={provider} snapshot={snapshots[provider]} compact flash={flashSet.has(provider)} paused={isPaused(provider)} updatedAgo={agoFor(provider)} effect={settings.effectsEnabled ? activeEffects[provider] : undefined} dropCell={settings.effectDropCell} />) : <EmptyProviderState />}
      </div>
      </div>
    </main>
  );
}

function WindowControls({
  pinned,
  onTogglePin,
  onMinimize,
  onMaximize,
  onClose,
  showMinimize = true,
  showMaximize = true,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  showMinimize?: boolean;
  showMaximize?: boolean;
}) {
  return (
    <div className="window-controls" aria-label="Window controls">
      <button className={`window-control pin ${pinned ? "active" : ""}`} type="button" title={pinned ? "Unpin from top" : "Pin always on top"} aria-label={pinned ? "Unpin from top" : "Pin always on top"} onClick={onTogglePin}><PinIcon /></button>
      {showMinimize && <button className="window-control minimize" type="button" title="Minimize" aria-label="Minimize" onClick={onMinimize}>-</button>}
      {showMaximize && <button className="window-control maximize" type="button" title="Maximize" aria-label="Maximize" onClick={onMaximize}>[]</button>}
      <button className="window-control close" type="button" title="Close" aria-label="Close" onClick={onClose}>x</button>
    </div>
  );
}

function PinIcon() {
  return (
    <svg className="pin-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3l7 7-4.2 4.2-3.2-.8-5.9 5.9-3-3 5.9-5.9-.8-3.2L14 3z" />
      <path d="M7.2 16.8 3 21" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
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

function CompactIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 8l5 5 5-5" />
      <path d="M7 16l5-5 5 5" />
    </svg>
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
    await getCurrentWindow().hide();
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
        <div className="status-line"><span />{status}</div>
        <p className="hint">Browser fallback is only for viewing. Extract mode needs login inside this app window.</p>
      </section>
    </main>
  );
}

function ProviderPanel({
  provider,
  url,
  snapshot,
  busy,
  onOpen,
  onBrowser,
  onReload,
  onClose,
  onLogout,
  onDiscover,
  discovery,
  onExtract,
  onUrlChange,
  shownInWidget,
  onToggleShown,
}: {
  provider: Provider;
  url: string;
  snapshot: UsageSnapshot;
  busy: Provider | `${Provider}-open` | `${Provider}-close` | `${Provider}-reload` | `${Provider}-logout` | `${Provider}-discover` | null;
  onOpen: () => void;
  onBrowser: () => void;
  onReload: () => void;
  onClose: () => void;
  onLogout: () => void;
  onDiscover: () => void;
  discovery?: string;
  onExtract: () => void;
  onUrlChange: (url: string) => void;
  shownInWidget: boolean;
  onToggleShown: () => void;
}) {
  return (
    <section className="mini-card">
      <div className="mini-head">
        <div>
          <h2><ProviderMark provider={provider} />{providerLabel(provider)}</h2>
          <p>{provider === "claude" ? "Claude account session." : provider === "codex-1" ? "Codex account 2 (isolated session)." : "Codex account session."}</p>
        </div>
        <StatusPill status={snapshot.status} />
      </div>
      <UsageBlock snapshot={snapshot} compact />
      <div className="daily-actions">
        <button className="primary" onClick={onOpen} disabled={busy === `${provider}-open`}>{busy === `${provider}-open` ? "Opening" : "Login"}</button>
        <button onClick={onExtract} disabled={busy === provider}>{busy === provider ? "Refreshing" : "Refresh now"}</button>
        <button onClick={onToggleShown}>{shownInWidget ? "Hide widget" : "Show widget"}</button>
      </div>
      <div className="daily-actions secondary-actions">
        <button onClick={onLogout} disabled={busy === `${provider}-logout`}>{busy === `${provider}-logout` ? "Signing out" : "Log out"}</button>
      </div>
      <details className="advanced-tools">
        <summary>Advanced</summary>
        <label className="url-field">Login / usage link<input value={url} onChange={(event) => onUrlChange(event.target.value)} /></label>
        <div className="button-grid">
          <button onClick={onReload} disabled={busy === `${provider}-reload`}>Reload page</button>
          <button onClick={onClose} disabled={busy === `${provider}-close`}>Hide window</button>
          <button onClick={onBrowser}>Open Chrome</button>
          <button onClick={onDiscover} disabled={busy === `${provider}-discover`}>{busy === `${provider}-discover` ? "Finding API..." : "Find API"}</button>
        </div>
        <p className="hint">Log out clears the shared in-app browser session for both providers.</p>
      {discovery && (
        <details className="debug-text" open>
          <summary>Discovered API</summary>
          <pre>{discovery}</pre>
        </details>
      )}
      {snapshot.debugText && (
        <details className="debug-text">
          <summary>Raw page text</summary>
          <pre>{snapshot.debugText}</pre>
        </details>
      )}
      </details>
    </section>
  );
}

function WidgetSettings({ settings, savedAt, onChange, onEffectPlay, onEffectRestore, providerPercents }: {
  settings: Settings;
  savedAt: Date | null;
  onChange: (settings: Settings) => void;
  onEffectPlay?: (provider: Provider, from: number, to: number, driveBar: boolean) => void;
  onEffectRestore?: () => void;
  providerPercents?: Partial<Record<Provider, number>>;
}) {
  function patch(next: Partial<Settings>) {
    onChange({ ...settings, ...next });
  }

  // Effect tester local state. Fields walk upward as you click Step so you can eyeball 1->2->3->4...
  const [testProvider, setTestProvider] = useState<Provider>("codex");
  const [testFrom, setTestFrom] = useState(36);
  const [testTo, setTestTo] = useState(37);
  const [driveBar, setDriveBar] = useState(false);
  const testable = !!onEffectPlay && settings.effectsEnabled;
  const presets: [string, number, number][] = [["36→37", 36, 37], ["80→81", 80, 81], ["0→63", 0, 63], ["99→100", 99, 100], ["0→100", 0, 100]];

  function play(from: number, to: number) {
    onEffectPlay?.(testProvider, from, to, driveBar);
  }
  function stepUp() {
    const from = Math.max(0, Math.min(100, testTo));
    const to = Math.min(100, from + 1);
    play(from, to);
    setTestFrom(from);
    setTestTo(to);
  }
  function loadCurrent() {
    const cur = providerPercents?.[testProvider];
    if (typeof cur === "number") { setTestFrom(cur); setTestTo(Math.min(100, cur + 1)); }
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

  return (
    <section className="settings-section mini-card settings-card">
      <div className="mini-head">
        <div>
          <h2>Widget</h2>
          <p>Auto-saves when changed.</p>
        </div>
        <span className="save-state">{savedAt ? `Saved ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Auto-save on"}</span>
      </div>
      <div className="settings-row">
        <label>Theme<select value={settings.theme} onChange={(event) => patch({ theme: event.target.value as Settings["theme"] })}><option value="terminal">Dark</option><option value="light">Light</option></select></label>
        <label>Opacity<input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(event) => patch({ opacity: Number(event.target.value) })} /></label>
      </div>
      <div className="settings-row">
        <label>Refresh seconds (all AIs)<input
          type="number"
          min="10"
          value={secondsDraft}
          onChange={(event) => setSecondsDraft(event.target.value)}
          onBlur={commitSeconds}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitSeconds(); } }}
        /></label>
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
      <details className="effect-settings">
        <summary><span>Usage effect</span><strong>{settings.effectsEnabled ? "on" : "off"}</strong></summary>
        <label className="toggle-row">
          <span>Enable effect</span>
          <input type="checkbox" checked={settings.effectsEnabled} onChange={(event) => patch({ effectsEnabled: event.target.checked })} />
        </label>
        <label>Effect duration <span>{(settings.effectDurationMs / 1000).toFixed(1)}s</span><input
          type="range"
          min="800"
          max="8000"
          step="100"
          value={settings.effectDurationMs}
          onChange={(event) => patch({ effectDurationMs: Number(event.target.value) })}
        /></label>
        <label>Bar brightness <span>{settings.effectBarBrightness.toFixed(2)}x</span><input
          type="range"
          min="0.45"
          max="1.8"
          step="0.05"
          value={settings.effectBarBrightness}
          onChange={(event) => patch({ effectBarBrightness: Number(event.target.value) })}
        /></label>
        <label>Delta brightness <span>{settings.effectDeltaBrightness.toFixed(2)}x</span><input
          type="range"
          min="0.45"
          max="2.2"
          step="0.05"
          value={settings.effectDeltaBrightness}
          onChange={(event) => patch({ effectDeltaBrightness: Number(event.target.value) })}
        /></label>
        <label className="toggle-row">
          <span>Drop cell effect</span>
          <input type="checkbox" checked={settings.effectDropCell} onChange={(event) => patch({ effectDropCell: event.target.checked })} />
        </label>
        {onEffectPlay && (
          <div className="effect-tester">
            <div className="effect-tester-head">
              <span>Test / replay</span>
              {!settings.effectsEnabled && <em>enable effect to test</em>}
            </div>
            <div className="effect-tester-row">
              <label>Account<select value={testProvider} onChange={(event) => setTestProvider(event.target.value as Provider)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="codex-1">Codex 2</option>
              </select></label>
              <label>From<input type="number" min="0" max="100" value={testFrom} onChange={(event) => setTestFrom(Number(event.target.value))} /></label>
              <label>To<input type="number" min="0" max="100" value={testTo} onChange={(event) => setTestTo(Number(event.target.value))} /></label>
              <button type="button" onClick={loadCurrent} title="Load this account's current %">current</button>
            </div>
            <label className="toggle-row">
              <span>Drive bar too (fake %, restores on next read)</span>
              <input type="checkbox" checked={driveBar} onChange={(event) => setDriveBar(event.target.checked)} />
            </label>
            <div className="effect-tester-actions">
              <button type="button" className="primary" disabled={!testable} onClick={() => play(testFrom, testTo)}>Play</button>
              <button type="button" disabled={!testable} onClick={stepUp}>Step +1%</button>
              <button type="button" onClick={() => onEffectRestore?.()}>Restore</button>
            </div>
            <div className="effect-tester-presets">
              {presets.map(([label, from, to]) => (
                <button type="button" key={label} disabled={!testable} onClick={() => { setTestFrom(from); setTestTo(to); play(from, to); }}>{label}</button>
              ))}
            </div>
          </div>
        )}
      </details>
    </section>
  );
}

function EmptyProviderState() {
  return (
    <article className="empty-state">
      <strong>No providers shown</strong>
      <span>Open Settings to show Claude or Codex in the widget.</span>
    </article>
  );
}

function parseResetMs(resetLabel?: string): number | null {
  if (!resetLabel) return null;
  const stripped = resetLabel.replace(/^Reset\s+/i, "").trim();
  const year = new Date().getFullYear();
  for (const candidate of [stripped, `${stripped}, ${year}`, `${stripped} ${year}`]) {
    const d = new Date(candidate);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now() - 60_000) return d.getTime();
  }
  return null;
}

function formatCountdown(resetMs: number): string {
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return "Resetting soon";
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  const s = Math.floor((remaining % 60_000) / 1_000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function CompactTimerView({ snapshot, onBack, paused = false }: { snapshot: UsageSnapshot; onBack: () => void; paused?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const resetMs = parseResetMs(snapshot.resetLabel);
  const countdown = resetMs !== null ? formatCountdown(resetMs) : null;
  return (
    <article className={`compact-usage provider-tile ${snapshot.provider} timer-view${paused ? " mark-paused" : ""}`} onClick={onBack}>
      <div className="compact-usage-head">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="timer-label">reset at</span>
      </div>
      <div className="compact-timer-clock">{countdown ?? (snapshot.resetLabel ? "Resetting soon" : "—")}</div>
      <div className="compact-timer-sub">
        {snapshot.resetLabel && <span>{snapshot.resetLabel}</span>}
        <span className="compact-timer-hint">tap to dismiss</span>
      </div>
    </article>
  );
}

function snapshotPercent(snapshot: UsageSnapshot): number | undefined {
  return typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
}

function makeUsageEffect(from: number, to: number): UsageEffect {
  return { from, to, particles: makeEffectParticles() };
}

function makeEffectParticles(): EffectParticle[] {
  const count = 12 + Math.floor(Math.random() * 6);
  return Array.from({ length: count }, (_, index) => {
    const angle = (Math.PI * 2 * index) / count + (Math.random() - 0.5) * 1.1;
    const distance = 20 + Math.random() * 44;
    return {
      x: Math.round(Math.cos(angle) * distance + (Math.random() - 0.5) * 12),
      y: Math.round(Math.sin(angle) * distance * 0.8 + (Math.random() - 0.5) * 14),
      size: Math.random() > 0.72 ? 5 : Math.random() > 0.35 ? 4 : 3,
      delay: Math.round(Math.random() * 150),
    };
  });
}

function effectStyle(effect: UsageEffect | undefined, fallbackPercent: number | undefined, compact = false): React.CSSProperties {
  const from = effect ? Math.max(0, Math.min(100, effect.from)) : fallbackPercent ?? 0;
  const to = effect ? Math.max(0, Math.min(100, effect.to)) : fallbackPercent ?? 0;
  const start = Math.min(from, to);
  const width = Math.abs(to - from);
  const dropMinWidth = compact ? 6 : 8;
  const dropWidth = width > 0 ? `max(${dropMinWidth}px, ${width}%)` : `${dropMinWidth}px`;
  return {
    "--delta-start": `${start}%`,
    "--delta-width": `${width}%`,
    "--delta-edge": `${to}%`,
    "--drop-left": `${start + width / 2}%`,
    "--drop-width": dropWidth,
  } as React.CSSProperties;
}

function EffectOverlays({ effect, dropCell }: { effect?: UsageEffect; dropCell: boolean }) {
  if (!effect) return null;
  return (
    <>
      <span className="effect-delta-range" aria-hidden="true" />
      <span className="effect-edge-glow" aria-hidden="true" />
      <span className="effect-ripple" aria-hidden="true" />
      {dropCell && <span className="effect-drop-cell" aria-hidden="true" />}
      {effect.particles.map((particle, index) => (
        <span
          key={index}
          className="effect-particle"
          style={{
            "--particle-x": `${particle.x}px`,
            "--particle-y": `${particle.y}px`,
            "--particle-size": `${particle.size}px`,
            "--particle-delay": `${particle.delay}ms`,
          } as React.CSSProperties}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

function buildUsageCells(percent: number | undefined, cellCount: number, showFxPartial: boolean): ReactNode[] {
  const normalized = Math.max(0, Math.min(100, Number(percent ?? 0)));
  const cellWidth = 100 / cellCount;
  const fullCells = Math.floor(normalized / cellWidth);
  const remainder = normalized - fullCells * cellWidth;
  const partialRatio = remainder > 0 && fullCells < cellCount ? Math.max(0.04, Math.min(0.96, remainder / cellWidth)) : 0;
  const miniCount = Math.max(1, Math.min(5, Math.ceil(partialRatio * 5)));

  return Array.from({ length: cellCount }, (_, index) => {
    if (index < fullCells) {
      return <span key={index} className={`cell active${index === fullCells - 1 && partialRatio === 0 ? " current" : ""}`} />;
    }
    if (index === fullCells && partialRatio > 0) {
      if (showFxPartial) {
        return (
          <span key={index} className="cell partial current fx-partial" style={{ "--partial-ratio": partialRatio } as React.CSSProperties}>
            {Array.from({ length: 5 }, (_, mini) => (
              <span key={mini} className={`mini-cell ${mini < miniCount ? `on${mini === miniCount - 1 ? " edge" : ""}` : ""}`} />
            ))}
          </span>
        );
      }
      return <span key={index} className="cell partial current" style={{ "--partial-ratio": partialRatio } as React.CSSProperties} />;
    }
    return <span key={index} className="cell" />;
  });
}


function CompactUsageBlock({ snapshot, flash = false, paused = false, updatedAgo, effect, dropCell = false }: { snapshot: UsageSnapshot; flash?: boolean; paused?: boolean; updatedAgo?: string; effect?: UsageEffect; dropCell?: boolean }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const stale = isStale(snapshot);
  const metaLeft = usageMetaLeft(snapshot, percent);
  const metaRight = usageMetaRight(snapshot);
  return (
    <article className={`compact-usage provider-tile ${snapshot.provider}${flash ? " mark-flash" : ""}${paused ? " mark-paused" : ""}`}>
      <div className="compact-usage-head">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="tile-status">
          {updatedAgo && <span className="updated-ago">{updatedAgo}</span>}
          <span className={`source-pill ${stale ? "stale" : snapshot.status !== "ok" ? "warn" : paused ? "paused" : "ok"}`}>{stale ? "cached" : snapshot.status !== "ok" ? readableStatus(snapshot.status) : paused ? "paused" : "live"}</span>
        </span>
      </div>
      <div className="compact-usage-main">
        <span className="compact-percent">{percent !== undefined ? `${Math.round(percent)}%` : "--"}</span>
        <span className="compact-message">{providerMessage(snapshot)}</span>
      </div>
      <div className={`compact-bar${effect ? " usage-effect-bar" : ""}${effect && dropCell ? " drop-impact" : ""}`} style={effectStyle(effect, percent, true)} aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {buildUsageCells(percent, 12, !!effect)}
        <EffectOverlays effect={effect} dropCell={dropCell} />
      </div>
      <div className="compact-meta">
        <span>{metaLeft}</span>
        <span>{metaRight}</span>
      </div>
    </article>
  );
}

function UsageBlock({ snapshot, compact = false, flash = false, paused = false, updatedAgo, effect, dropCell = false }: { snapshot: UsageSnapshot; compact?: boolean; flash?: boolean; paused?: boolean; updatedAgo?: string; effect?: UsageEffect; dropCell?: boolean }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const stale = isStale(snapshot);
  const metaLeft = usageMetaLeft(snapshot, percent);
  const metaRight = usageMetaRight(snapshot);
  return (
    <article className={`${compact ? "usage compact" : "usage"} provider-tile ${snapshot.provider}${flash ? " mark-flash" : ""}${paused ? " mark-paused" : ""}`}>
      <div className="usage-top">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="tile-status">
          {updatedAgo && <span className="updated-ago">{updatedAgo}</span>}
          <span className={`source-pill ${stale ? "stale" : snapshot.status !== "ok" ? "warn" : paused ? "paused" : "ok"}`}>{stale ? "cached" : snapshot.status !== "ok" ? readableStatus(snapshot.status) : paused ? "paused" : "live"}</span>
        </span>
      </div>
      <div className="metric">
        <span className="percent">{percent !== undefined ? `${Math.round(percent)}%` : "--"}</span>
        <span className="message">{providerMessage(snapshot)}</span>
      </div>
      <div className={`bar${effect ? " usage-effect-bar" : ""}${effect && dropCell ? " drop-impact" : ""}`} style={effectStyle(effect, percent)} aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {buildUsageCells(percent, 20, !!effect)}
        <EffectOverlays effect={effect} dropCell={dropCell} />
      </div>
      <div className="usage-meta" data-tip={`${metaLeft}\n${metaRight}`}>
        <span>{metaLeft}</span>
        <span>{metaRight}</span>
      </div>
    </article>
  );
}

function StatusPill({ status }: { status: UsageStatus }) {
  return <span className={`pill ${status}`}>{readableStatus(status)}</span>;
}

function ProviderMark({ provider }: { provider: Provider }) {
  if (provider === "claude") {
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
