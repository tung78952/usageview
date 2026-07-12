import React, { Component, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./styles.css";
import "./glass-theme.css";
import "./glass-effect.css";

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
  theme: "terminal" | "light" | "glass-light" | "glass-dark";
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

type AppMode = "widget" | "settings" | "mini";

type WindowGeometry = {
  width: number;
  height: number;
  x: number;
  y: number;
};

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

const GEOMETRY_KEY = "usageview.windowGeometry.v7";
const WIDGET_BASE_WIDTH = 392;
const MINI_LOCK_WIDTH = 240;
const MINI_MIN_HEIGHT_FALLBACK = 48;
const MODE_KEY = "usageview.mode";
let windowGeometryCache: Partial<Record<AppMode, WindowGeometry>> | undefined;

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

type EffectParticle = {
  x: number;
  y: number;
  size: number;
  delay: number;
  position: number;
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
      uiScale: clampNumber(loaded.uiScale, 0.25, 2, 1),
      theme: normalizeTheme(loaded.theme),
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

function panelStyle(settings: Settings): React.CSSProperties {
  return {
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

async function loadWindowGeometryAsync(): Promise<Partial<Record<AppMode, WindowGeometry>>> {
  if (windowGeometryCache) return windowGeometryCache;
  const localGeometry = loadWindowGeometry();
  try {
    const stored = await invoke<Partial<Record<AppMode, WindowGeometry>>>("load_window_geometry");
    windowGeometryCache = Object.keys(stored).length ? stored : localGeometry;
  } catch {
    windowGeometryCache = localGeometry;
  }
  return windowGeometryCache;
}

function saveWindowGeometry(mode: AppMode, geometry: WindowGeometry) {
  const current = windowGeometryCache ?? loadWindowGeometry();
  windowGeometryCache = { ...current, [mode]: geometry };
  localStorage.setItem(GEOMETRY_KEY, JSON.stringify(windowGeometryCache));
  void invoke("save_window_geometry", { mode, geometry }).catch(() => undefined);
}

function defaultWindowSize(mode: AppMode) {
  if (mode === "settings") return { width: 460, height: 720 };
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
  const minWidthL = mode === "settings" ? 430 : fallbackSize.width * fixedModeScale;
  const minHeightL = mode === "settings" ? 520 : fallbackSize.height * fixedModeScale;
  const maxWidthL = mode === "settings" ? Math.max(minWidthL, fallbackSize.width) : minWidthL;
  const minWidth = Math.round(minWidthL * scale);
  const minHeight = Math.round(minHeightL * scale);
  const maxWindowWidth = mode === "settings"
    ? Math.max(minWidth, targetRect?.width ?? Math.round(maxWidthL * scale))
    : Math.round(maxWidthL * scale);
  const maxWindowHeight = Math.max(minHeight, targetRect?.height ?? Math.round(Math.max(minHeightL, fallbackSize.height) * scale));
  // Widget and Mini dimensions are controlled by their layout engines. Persisted geometry contributes
  // position only, so a stale manually-resized width can never become the next 100% zoom baseline.
  const width = mode !== "settings"
    ? minWidth
    : Number.isFinite(geometry?.width) ? Math.min(maxWindowWidth, Math.max(minWidth, Math.round(geometry!.width!))) : Math.round(fallbackSize.width * scale);
  const height = mode !== "settings"
    ? minHeight
    : Number.isFinite(geometry?.height) ? Math.min(maxWindowHeight, Math.max(minHeight, Math.round(geometry!.height!))) : Math.round(fallbackSize.height * scale);
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

async function recoverVisibleWindow(mode: AppMode, corner: Settings["corner"], widgetScale = 1) {
  const appWindow = getCurrentWindow();
  const fallbackPosition = defaultWindowPosition(corner);
  const saved = (await loadWindowGeometryAsync())[mode];
  const geometry = await normalizeWindowGeometryForMonitors(mode, saved, fallbackPosition, widgetScale);
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
  } catch {
    // no-op: older platforms can reject this while the window is being created.
  }
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.setSize(new PhysicalSize(geometry.width, geometry.height)).catch(() => undefined);
  await appWindow.setPosition(new PhysicalPosition(geometry.x, geometry.y)).catch(() => undefined);
  await appWindow.show().catch(() => undefined);
  await appWindow.setFocus().catch(() => undefined);
}

// Switching modes (widget <-> settings <-> compact) should resize the window in place, not teleport
// it to that mode's remembered corner. Keep the current top-left; only change the size (clamped so a
// taller mode stays on-screen).
async function resizeWindowForMode(mode: AppMode, widgetScale = 1) {
  const appWindow = getCurrentWindow();
  // Keep the current top-left (physical px); only change size. Saved size is physical too.
  const position = await appWindow.outerPosition();
  const here = { x: Math.round(position.x), y: Math.round(position.y) };
  const saved = (await loadWindowGeometryAsync())[mode];
  const geometry = await normalizeWindowGeometryForMonitors(
    mode,
    { width: saved?.width, height: saved?.height, x: here.x, y: here.y },
    here,
    widgetScale,
  );
  try {
    if (await appWindow.isMaximized()) await appWindow.unmaximize();
  } catch {
    // no-op
  }
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.setSize(new PhysicalSize(geometry.width, geometry.height)).catch(() => undefined);
  await appWindow.setPosition(new PhysicalPosition(geometry.x, geometry.y)).catch(() => undefined);
}

// Returns the window geometry in PHYSICAL px (outer position + inner size), matching what is stored and
// restored. No toLogical() conversion — physical keeps multi-monitor / mixed-DPI coordinates exact.
async function readCurrentGeometry(): Promise<WindowGeometry> {
  const appWindow = getCurrentWindow();
  const size = await appWindow.innerSize();
  const position = await appWindow.outerPosition();
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
    "button, input, select, textarea, a, label, summary, details, [role='button'], .window-controls, .advanced-tools, .debug-text, .provider-tile",
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
  return "Codex 1";
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

function weeklyResetLabel(snapshot: UsageSnapshot) {
  // The weekly reset clock is carried inside weeklyLabel as ".../ Reset <clock>" (both Claude and
  // Codex now emit that shape). Pull out the "Reset ..." segment and normalize it, so the meta-right
  // cell (next to "Weekly left X%") shows the WEEKLY reset — the 5-hour reset already lives in the
  // message countdown ("resets in Xh Ym") and the flip-timer.
  const resetPart = snapshot.weeklyLabel
    ?.split(" / ")
    .find((part) => /^\s*Reset\b/i.test(part));
  return resetLabelToClock(resetPart) || "Reset --";
}

function usageMetaRight(snapshot: UsageSnapshot) {
  return weeklyResetLabel(snapshot);
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
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
      <div ref={scrollRef} className="scale-shell">
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
      <OverlayScrollbar targetRef={scrollRef} />
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
  const [timerSet, setTimerSet] = useState<Set<Provider>>(new Set());
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  const modeRef = useRef(mode);
  const webviewZoomRef = useRef<number | null>(null);
  const webviewZoomQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fullContentHeightRef = useRef(defaultWindowSize("widget").height);
  const skipInitialModeResizeRef = useRef(true);
  function setWidgetWebviewZoom(target: number) {
    const operation = webviewZoomQueueRef.current.catch(() => undefined).then(async () => {
      if (webviewZoomRef.current === target) return;
      await getCurrentWebview().setZoom(target);
      webviewZoomRef.current = target;
    });
    webviewZoomQueueRef.current = operation.catch(() => undefined);
    return operation;
  }
  // Guard against persisting the initial default position: the window is created visible at its
  // tauri.conf.json corner and auto-fit fires resize events before recoverVisibleWindow has applied the
  // saved position. Don't save geometry until the restore has run, or we'd overwrite it with the default.
  const hasRestoredGeometryRef = useRef(false);
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
    const appWindow = getCurrentWindow();
    void appWindow.clearEffects().catch(() => undefined);
    // Reopen in the last-used mode + its saved geometry (mode here is the value restored by loadMode).
    // Only allow geometry to be persisted once the restore has actually applied, so early auto-fit
    // resize events can't save the initial default position over the saved one.
    void recoverVisibleWindow(mode, settings.corner, settings.uiScale).finally(() => {
      hasRestoredGeometryRef.current = true;
    });
  }, []);

  useEffect(() => {
    saveMode(mode);
    if (skipInitialModeResizeRef.current) {
      skipInitialModeResizeRef.current = false;
      return;
    }
    void resizeWindowForMode(mode, settingsRef.current.uiScale);
  }, [mode]);


  useEffect(() => {
    if (mode !== "widget" && mode !== "mini") {
      void getCurrentWindow().setMinSize(new LogicalSize(430, 620)).catch(() => undefined);
      return;
    }

    const appWindow = getCurrentWindow();
    let animationFrame = 0;
    let desiredSize: { width: number; height: number } | undefined;
    let applyingSize = false;
    let disposed = false;
    let layoutReady = false;
    void appWindow.setResizable(false).catch(() => undefined);

    // Every mode uses one serialized size writer. Clearing the previous exact constraints first lets
    // 25% Full and 240px Mini shrink below the old static minimum without racing ResizeObserver bursts.
    function applyLockedSize(width: number, height: number) {
      desiredSize = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
      if (applyingSize) return;
      applyingSize = true;
      void (async () => {
        while (desiredSize && !disposed) {
          const target = desiredSize;
          desiredSize = undefined;
          await appWindow.setMinSize(null).catch(() => undefined);
          await appWindow.setMaxSize(null).catch(() => undefined);
          if (disposed) break;
          await appWindow.setSize(new LogicalSize(target.width, target.height)).catch(() => undefined);
          await appWindow.setMinSize(new LogicalSize(target.width, target.height)).catch(() => undefined);
          await appWindow.setMaxSize(new LogicalSize(target.width, target.height)).catch(() => undefined);
        }
        applyingSize = false;
      })();
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
          const height = Math.max(MINI_MIN_HEIGHT_FALLBACK, Math.ceil(providers.scrollHeight + chromeHeight));
          applyLockedSize(MINI_LOCK_WIDTH, height);
        });
      }

      const observer = new ResizeObserver(updateCompactLayout);
      if (compactProvidersRef.current) observer.observe(compactProvidersRef.current);
      compactProvidersRef.current?.querySelectorAll(".provider-tile, .empty-state").forEach((element) => observer.observe(element));
      void (async () => {
        await appWindow.setMinSize(null).catch(() => undefined);
        await appWindow.setMaxSize(null).catch(() => undefined);
        await setWidgetWebviewZoom(1).catch(() => undefined);
        if (disposed) return;
        await appWindow.setSize(new LogicalSize(MINI_LOCK_WIDTH, defaultWindowSize("mini").height)).catch(() => undefined);
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
        const boxesMin = Math.ceil(header.getBoundingClientRect().height + providers.scrollHeight + borderHeight);
        const contentH = Math.max(96, boxesMin);
        fullContentHeightRef.current = contentH;
        applyLockedSize(WIDGET_BASE_WIDTH * fullScale, contentH * fullScale);
      });
    }

    const observer = new ResizeObserver(updateFullLayout);
    if (widgetRef.current) observer.observe(widgetRef.current);
    if (widgetHeaderRef.current) observer.observe(widgetHeaderRef.current);
    if (providersRef.current) observer.observe(providersRef.current);
    providersRef.current?.querySelectorAll(".provider-tile").forEach((element) => observer.observe(element));
    void (async () => {
      await appWindow.setMinSize(null).catch(() => undefined);
      await appWindow.setMaxSize(null).catch(() => undefined);
      await setWidgetWebviewZoom(fullScale).catch(() => undefined);
      if (disposed) return;
      await appWindow.setSize(new LogicalSize(
        Math.round(WIDGET_BASE_WIDTH * fullScale),
        Math.max(96, Math.round(fullContentHeightRef.current * fullScale)),
      )).catch(() => undefined);
      if (disposed) return;
      layoutReady = true;
      updateFullLayout();
    })();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [mode, settings.theme, snapshots.claude, snapshots.codex, snapshots["codex-1"], settings.showClaude, settings.showCodex, settings.showCodex1, settings.uiScale]);

  async function saveCurrentGeometryNow(targetMode = modeRef.current) {
    // Never persist before the saved geometry has been restored, or a startup resize event would
    // overwrite the remembered position with the initial default one.
    if (!hasRestoredGeometryRef.current) return;
    try {
      saveWindowGeometry(targetMode, await readCurrentGeometry());
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
      if (!disposed) void saveCurrentGeometryNow(modeRef.current);
    }

    function scheduleSave() {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(async () => {
        if (!disposed) await saveCurrentGeometryNow(modeRef.current);
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
    setTimerSet((prev) => {
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

  function toggleTimer(provider: Provider) {
    setTimerSet((prev) => {
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
    await saveCurrentGeometryNow();
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
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, .mini-mark-btn")) return;
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
    !shouldAutoRefreshProvider(p, snapshots[p], now, lastLimitedAutoRefreshRef.current);
  const agoFor = (p: Provider) => formatAgo(lastFreshAtRef.current[p]);

  if (mode === "mini") {
    return (
      <main className={`compact-widget mini-widget ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={prepareCompactDrag} onMouseMove={maybeStartCompactDrag} onContextMenu={openCompactMenu}>
        <div ref={compactProvidersRef} className="mini-providers">
          {shown.length > 0 ? shown.map((provider) => (
            timerSet.has(provider)
              ? <MiniTimerRow key={provider} snapshot={snapshots[provider]} onBack={() => toggleTimer(provider)} paused={isPaused(provider)} />
              : <MiniUsageRow key={provider} snapshot={snapshots[provider]} paused={isPaused(provider)} updatedAgo={agoFor(provider)} flash={flashSet.has(provider)} onFlip={() => toggleTimer(provider)} />
          )) : <EmptyProviderState />}
        </div>
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
          <button className="window-control mini" type="button" title="Mini mode" aria-label="Mini mode" onClick={() => setMode("mini")}><MiniIcon /></button>
          <WindowControls pinned={settings.alwaysOnTop} onTogglePin={togglePinned} onMinimize={() => void minimizeWindow()} onMaximize={() => void toggleMaximizeWindow()} onClose={() => void closeWindow()} showMinimize={false} showMaximize={false} />
        </div>
      </div>
      <div ref={providersRef} className="providers">
        {shown.length > 0 ? shown.map((provider) => (
          timerSet.has(provider)
            ? <TimerView key={provider} snapshot={snapshots[provider]} onBack={() => toggleTimer(provider)} paused={isPaused(provider)} />
            : <UsageBlock key={provider} snapshot={snapshots[provider]} compact flash={flashSet.has(provider)} paused={isPaused(provider)} updatedAgo={agoFor(provider)} effect={settings.effectsEnabled ? activeEffects[provider] : undefined} dropCell={settings.effectDropCell} onFlip={() => toggleTimer(provider)} />
        )) : <EmptyProviderState />}
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

function MiniIcon() {
  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="8" width="14" height="3" rx="1.2" />
      <rect x="5" y="13" width="14" height="3" rx="1.2" />
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
        <div className="seg-field">
          <span className="seg-label">Style</span>
          <div className="seg" role="group" aria-label="Theme style">
            <button type="button" className={`seg-btn${themeStyle(settings.theme) === "pixel" ? " active" : ""}`} onClick={() => patch({ theme: composeTheme("pixel", themeMode(settings.theme)) })}>Pixel</button>
            <button type="button" className={`seg-btn${themeStyle(settings.theme) === "glass" ? " active" : ""}`} onClick={() => patch({ theme: composeTheme("glass", themeMode(settings.theme)) })}>Glass</button>
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
          <span className="seg-label">Refresh (all AIs)</span>
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
      </div>
      <div className="settings-row">
        <div className="seg-field">
          <span className="seg-label">Opacity <span className="seg-value">{Math.round(settings.opacity * 100)}%</span></span>
          <input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(event) => patch({ opacity: Number(event.target.value) })} />
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
      <details className="effect-settings">
        <summary>
          <span className="summary-left">
            <svg className="disclosure-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            <span>Usage effect</span>
          </span>
          <strong>{settings.effectsEnabled ? "on" : "off"}</strong>
        </summary>
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

function TimerView({ snapshot, onBack, paused = false }: { snapshot: UsageSnapshot; onBack: () => void; paused?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const resetMs = parseResetMs(snapshot.resetLabel);
  const countdown = resetMs !== null ? formatCountdown(resetMs) : null;
  return (
    <article className={`usage compact provider-tile ${snapshot.provider} timer-view flippable${paused ? " mark-paused" : ""}`} onClick={onBack} title="Tap to dismiss">
      <div className="usage-top">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="timer-label">reset in</span>
      </div>
      <div className="timer-clock">{countdown ?? (snapshot.resetLabel ? "Resetting soon" : "—")}</div>
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

function makeUsageEffect(from: number, to: number): UsageEffect {
  return { from, to, particles: makeEffectParticles(from, to) };
}

function makeEffectParticles(from: number, to: number): EffectParticle[] {
  const delta = Math.abs(to - from);
  const count = 10 + Math.ceil(delta * 0.65);
  return Array.from({ length: count }, (_, index) => {
    const angle = index * 2.39996 + (Math.random() - 0.5) * 0.45;
    const distance = 26 + Math.random() * 46;
    return {
      x: Math.round(Math.cos(angle) * distance * 0.65 + (Math.random() - 0.5) * 8),
      y: Math.round(Math.sin(angle) * distance * 1.15 + (Math.random() - 0.5) * 10),
      size: Math.random() > 0.72 ? 5 : Math.random() > 0.35 ? 4 : 3,
      delay: Math.round(Math.random() * 150),
      position: delta <= 1 ? 1 : Math.max(0, Math.min(1, (index + Math.random()) / count)),
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

  // Glass liquid variables — mirror the prototype's barShell() math (redesign/interactive-prototype).
  // These drive glass-effect.css; the Pixel effect ignores them. `--gl-drop-left/-width` are kept
  // separate from the Pixel `--drop-left/-width` above so glass never shifts the Pixel drop-cell.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const target = Math.max(from, to);
  const glDropLeft = from <= 0 ? target / 2 : from / 2;
  const flowWidth = Math.max(0, target - glDropLeft);
  const leftWave = Math.max(0, glDropLeft);
  const rightWave = Math.max(0, target - glDropLeft);
  const pocketMin = compact ? 3 : 4;
  const pocketWidth = width > 0 || flowWidth > 0
    ? Math.min(target, Math.max(pocketMin, Math.min(18, width + 2), flowWidth * 0.28))
    : 0;
  const pocketStart = pocketWidth > 0
    ? Math.max(0, Math.min(Math.max(0, target - pocketWidth), glDropLeft - pocketWidth / 2))
    : 0;
  const pocketOrigin = pocketWidth > 0 ? clamp(((glDropLeft - pocketStart) / pocketWidth) * 100, 0, 100) : 50;
  const dropScale = clamp(0.72 + Math.sqrt(Math.max(0, width)) * 0.16, 0.72, 1.65);
  const impactStrength = clamp(0.72 + Math.sqrt(Math.max(0, width)) * 0.14, 0.72, 1.55);
  const rippleScale = clamp(1.55 + flowWidth / 8, 1.8, 6.8);
  const glDropMinWidth = compact ? 5 : 8;
  const glDropWidth = `max(${glDropMinWidth}px, ${flowWidth || 2}%)`;

  return {
    "--delta-start": `${start}%`,
    "--delta-width": `${width}%`,
    "--delta-edge": `${to}%`,
    "--drop-left": `${start + width / 2}%`,
    "--drop-width": dropWidth,
    "--pixel-impact-strength": compact ? impactStrength * 0.72 : impactStrength,
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
    "--ripple-scale": rippleScale,
  } as React.CSSProperties;
}

// The 11 glass liquid layers (order matches the prototype markup). Hidden by default; shown/animated
// only under .theme-glass. Rendered always so the glass fill (--bar-fill) shows even when idle.
function LiquidLayers() {
  return (
    <>
      <span className="liquid-refraction" aria-hidden="true" />
      <span className="liquid-impact-pocket" aria-hidden="true" />
      <span className="liquid-dimple" aria-hidden="true" />
      <span className="liquid-neck-left" aria-hidden="true" />
      <span className="liquid-neck" aria-hidden="true" />
      <span className="liquid-fill-mask" aria-hidden="true" />
      <span className="liquid-flow" aria-hidden="true" />
      <span className="liquid-wave-left" aria-hidden="true" />
      <span className="liquid-wave-right" aria-hidden="true" />
      <span className="liquid-ripple" aria-hidden="true" />
      <span className="liquid-drop" aria-hidden="true" />
    </>
  );
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
            "--particle-left": `${Math.min(effect.from, effect.to) + Math.abs(effect.to - effect.from) * particle.position}%`,
          } as React.CSSProperties}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

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
    if (intersectsEffect) {
      const filledMinis = Math.max(0, Math.min(10, Math.ceil(((normalized - cellStart) / cellWidth) * 10)));
      return (
        <span key={index} className="cell partial current fx-partial">
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
      return <span key={index} className={`cell active${index === fullCells - 1 && partialRatio === 0 ? " current" : ""}`} />;
    }
    if (index === fullCells && partialRatio > 0) {
      return <span key={index} className="cell partial current" style={{ "--partial-ratio": partialRatio } as React.CSSProperties} />;
    }
    return <span key={index} className="cell" />;
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

function MiniUsageRow({ snapshot, paused = false, updatedAgo, flash = false, onFlip }: { snapshot: UsageSnapshot; paused?: boolean; updatedAgo?: string; flash?: boolean; onFlip?: () => void }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const stale = isStale(snapshot);
  const state = stale ? "stale" : snapshot.status !== "ok" ? "warn" : paused ? "paused" : "ok";
  const statusLabel = stale ? "stale" : snapshot.status !== "ok" ? readableStatus(snapshot.status) : paused ? "paused" : "ok";
  const resetCountdown = resetCountdownLabel(snapshot);
  const resetLabel = resetCountdown === "resetting soon" ? "soon" : resetCountdown?.replace(/^resets?\s+in\s+/i, "") ?? "--";
  const freshnessLabel = (updatedAgo ?? formatAgo(snapshot.updatedAt) ?? "--").replace(/^just now$/i, "now");
  return (
    <article className={`mini-usage provider-tile ${snapshot.provider}${flash ? " mark-flash" : ""}${paused ? " mark-paused" : ""}`}>
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
}

function MiniTimerRow({ snapshot, onBack, paused = false }: { snapshot: UsageSnapshot; onBack: () => void; paused?: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const resetMs = parseResetMs(snapshot.resetLabel);
  const countdown = resetMs !== null ? formatCountdown(resetMs) : null;
  return (
    <article className={`mini-usage mini-timer provider-tile ${snapshot.provider}${paused ? " mark-paused" : ""}`}>
      <MiniMarkButton provider={snapshot.provider} onClick={onBack} title="Tap to dismiss" />
      <strong className="mini-timer-clock">{countdown ?? (snapshot.resetLabel ? "soon" : "--")}</strong>
    </article>
  );
}
function UsageBlock({ snapshot, compact = false, flash = false, paused = false, updatedAgo, effect, dropCell = false, onFlip }: { snapshot: UsageSnapshot; compact?: boolean; flash?: boolean; paused?: boolean; updatedAgo?: string; effect?: UsageEffect; dropCell?: boolean; onFlip?: () => void }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const stale = isStale(snapshot);
  const metaLeft = usageMetaLeft(snapshot, percent);
  const metaRight = usageMetaRight(snapshot);
  return (
    <article className={`${compact ? "usage compact" : "usage"} provider-tile ${snapshot.provider}${flash ? " mark-flash" : ""}${paused ? " mark-paused" : ""}${onFlip ? " flippable" : ""}`} onClick={onFlip} title={onFlip ? "Tap for reset countdown" : undefined}>
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
        {buildUsageCells(percent, 10, effect)}
        <EffectOverlays effect={effect} dropCell={dropCell} />
        <LiquidLayers />
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
