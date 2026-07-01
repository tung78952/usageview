import React, { Component, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import "./styles.css";

type Provider = "claude" | "codex";
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
  theme: "terminal" | "dark" | "light" | "glass" | "glass-light";
  opacity: number;
  uiScale: number;
  alwaysOnTop: boolean;
  refreshIntervalSec: number;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  showClaude: boolean;
  showCodex: boolean;
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
  theme: "terminal",
  opacity: 0.96,
  uiScale: 0.9,
  alwaysOnTop: true,
  refreshIntervalSec: 60,
  corner: "top-right",
  showClaude: true,
  showCodex: true,
};

const GEOMETRY_KEY = "usageview.windowGeometry.v6";
const WIDGET_MIN_WIDTH = 320;
const WIDGET_MIN_HEIGHT_FALLBACK = 260;
const COMPACT_MIN_WIDTH = 260;
const COMPACT_MIN_HEIGHT_FALLBACK = 130;

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
      showClaude: loaded.showClaude ?? true,
      showCodex: loaded.showCodex ?? true,
    };
  } catch {
    return { ...defaultSettings, uiScale: 1, showClaude: true, showCodex: true };
  }
}

function saveSettings(settings: Settings) {
  localStorage.setItem("usageview.settings", JSON.stringify(settings));
  window.dispatchEvent(new Event("usageview:settings"));
}

function themeClass(theme: Settings["theme"]) {
  if (theme === "glass-light") return "theme-glass theme-light theme-glass-light";
  return `theme-${theme}`;
}

function isGlassTheme(theme: Settings["theme"]) {
  return theme === "glass" || theme === "glass-light";
}

function isLightTheme(theme: Settings["theme"]) {
  return theme === "light" || theme === "glass-light";
}

function toggleGlassTheme(theme: Settings["theme"]): Settings["theme"] {
  if (theme === "glass") return "terminal";
  if (theme === "glass-light") return "light";
  if (theme === "light") return "glass-light";
  return "glass";
}

function toggleLightTheme(theme: Settings["theme"]): Settings["theme"] {
  if (theme === "light") return "terminal";
  if (theme === "glass-light") return "glass";
  if (theme === "glass") return "glass-light";
  return "light";
}

function panelStyle(settings: Settings): React.CSSProperties {
  return {
    "--ui-scale": 1,
    "--panel-opacity": settings.opacity,
    "--panel-opacity-pct": `${Math.round(settings.opacity * 100)}%`,
    "--glass-dark-opacity-pct": `${Math.round(settings.opacity * 48)}%`,
    "--glass-light-opacity-pct": `${Math.round(settings.opacity * 72)}%`,
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
  return provider === "claude" ? "Claude" : "Codex";
}

function providerSourceLabel(provider: Provider, status: UsageStatus) {
  if (status !== "ok") return readableStatus(status);
  return provider === "claude" ? "page check" : "api synced";
}

function providerMessage(snapshot: UsageSnapshot) {
  if (snapshot.status === "ok") {
    return snapshot.provider === "claude" ? "Usage page detected" : "JSON usage read";
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

  const lower = label.toLowerCase();
  if (!lower.includes("in")) return label;
  const hours = Number(lower.match(/(\d+)\s*h/)?.[1] ?? lower.match(/(\d+)\s*hr/)?.[1] ?? 0);
  const minutes = Number(lower.match(/(\d+)\s*m/)?.[1] ?? lower.match(/(\d+)\s*min/)?.[1] ?? 0);
  if (!hours && !minutes) return label;

  return `Reset ${formatCompactDate(new Date(Date.now() + (hours * 60 + minutes) * 60 * 1000))}`;
}

function usageMetaLeft(snapshot: UsageSnapshot, percent?: number) {
  const weeklyUsed = snapshot.weeklyLabel?.match(/Weekly\s+(\d{1,3})(?:\.\d+)?%\s+used/i)?.[1];
  if (weeklyUsed !== undefined) return `Weekly left ${100 - Number(weeklyUsed)}%`;
  if (snapshot.remainingLabel?.toLowerCase().includes("weekly")) return snapshot.remainingLabel;
  if (percent !== undefined) return `Remaining ${100 - Math.round(percent)}%`;
  return snapshot.remainingLabel || "Weekly left --";
}

function usageMetaRight(snapshot: UsageSnapshot) {
  return resetLabelToClock(snapshot.resetLabel) || "Reset --";
}

function providerForLabel(label: string): Provider | null {
  if (label === "provider_claude") return "claude";
  if (label === "provider_codex") return "codex";
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
  const url = provider === "claude" ? settings.claudeUrl : settings.codexUrl;
  localStorage.setItem(`usageview.providerTarget.${provider}`, url);
  await invoke("open_provider_window", { provider, url });
}

async function closeProvider(provider: Provider) {
  await invoke("close_provider_window", { provider });
}

async function reloadProvider(provider: Provider) {
  await invoke("reload_provider_window", { provider });
}

async function refreshProviderPage(provider: Provider, url: string) {
  await invoke("refresh_provider_page", { provider, url });
}

async function prepareProviderRefresh(provider: Provider, url: string) {
  await invoke("prepare_provider_refresh", { provider, url });
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

async function refreshProviderFromUrl(provider: Provider, url: string): Promise<UsageSnapshot> {
  try {
    await refreshProviderPage(provider, url);
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
  return <WidgetApp />;
}

function WidgetApp() {
  const widgetRef = useRef<HTMLElement | null>(null);
  const widgetHeaderRef = useRef<HTMLDivElement | null>(null);
  const providersRef = useRef<HTMLDivElement | null>(null);
  const compactProvidersRef = useRef<HTMLDivElement | null>(null);
  const compactPointerRef = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const widgetFooterRef = useRef<HTMLElement | null>(null);
  const footerHeightRef = useRef<number>(0);
  const [mode, setMode] = useState<AppMode>("widget");
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  const [compactTimerSet, setCompactTimerSet] = useState<Set<Provider>>(new Set());
  const [compactHovered, setCompactHovered] = useState<Provider | null>(null);
  const [showFooter, setShowFooter] = useState(true);
  const [settings, setSettings] = useState(loadSettings);
  const [snapshots, setSnapshots] = useState<Record<Provider, UsageSnapshot>>({
    claude: loadSnapshot("claude"),
    codex: loadSnapshot("codex"),
  });
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [busy, setBusy] = useState<Provider | `${Provider}-open` | `${Provider}-close` | `${Provider}-reload` | `${Provider}-logout` | `${Provider}-discover` | null>(null);
  const [discovery, setDiscovery] = useState<Partial<Record<Provider, string>>>({});
  const [message, setMessage] = useState("Login inside app windows, then extract usage.");
  const [settingsSavedAt, setSettingsSavedAt] = useState<Date | null>(null);

  function updateSettings(next: Settings) {
    setSettings(next);
    saveSettings(next);
    setSettingsSavedAt(new Date());
  }

  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop);
  }, [settings.alwaysOnTop]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    void appWindow.clearEffects().catch(() => undefined);
    void recoverVisibleWindow("widget", settings.corner);
  }, []);

  useEffect(() => {
    void recoverVisibleWindow(mode, settings.corner);
  }, [mode, settings.corner]);

  useEffect(() => {
    if (mode !== "widget" && mode !== "compact") {
      void getCurrentWindow().setMinSize(new LogicalSize(430, 620)).catch(() => undefined);
      return;
    }

    if (mode === "compact") {
      const appWindow = getCurrentWindow();
      let animationFrame = 0;

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

    // Minimum height stops flush at the bottom of the last provider tile. The footer is
    // hidden once the window is too short to fit it beneath the tiles, so collapsing bottoms
    // out right at the last status box. Uses providers.scrollHeight and observes each tile, so
    // it adapts automatically when more providers are added.
    function updateLayout() {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const widget = widgetRef.current;
        const header = widgetHeaderRef.current;
        const providers = providersRef.current;
        if (!widget || !header || !providers) return;

        // Remember the footer's height while it is mounted; we need it to decide when there is
        // room to show it again after it has been removed from the DOM.
        const footer = widgetFooterRef.current;
        if (footer) footerHeightRef.current = footer.getBoundingClientRect().height;
        const footerHeight = footerHeightRef.current;

        const widgetStyle = window.getComputedStyle(widget);
        const borderHeight = (Number.parseFloat(widgetStyle.borderTopWidth) || 0) + (Number.parseFloat(widgetStyle.borderBottomWidth) || 0);
        const boxesMin = Math.ceil(header.getBoundingClientRect().height + providers.scrollHeight + borderHeight);
        const innerHeight = widget.getBoundingClientRect().height;

        // Hysteresis (~4px) prevents the footer from flickering right at the threshold.
        setShowFooter((visible) =>
          visible ? innerHeight >= boxesMin + footerHeight - 4 : innerHeight >= boxesMin + footerHeight + 4,
        );

        void appWindow.setMinSize(new LogicalSize(WIDGET_MIN_WIDTH, Math.max(WIDGET_MIN_HEIGHT_FALLBACK, boxesMin + footerHeight))).catch(() => undefined);
      });
    }

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    if (widgetRef.current) observer.observe(widgetRef.current);
    if (widgetHeaderRef.current) observer.observe(widgetHeaderRef.current);
    if (providersRef.current) observer.observe(providersRef.current);
    if (widgetFooterRef.current) observer.observe(widgetFooterRef.current);
    providersRef.current?.querySelectorAll(".provider-tile").forEach((element) => observer.observe(element));

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [mode, settings.theme, snapshots.claude, snapshots.codex, settings.showClaude, settings.showCodex]);

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
    function reloadLocal() {
      setSettings(loadSettings());
      setSnapshots({ claude: loadSnapshot("claude"), codex: loadSnapshot("codex") });
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
    async function refreshOpenProviders() {
      const providers: Provider[] = ["claude", "codex"];
      const results = await Promise.all(
        providers.map((provider) => {
          const url = provider === "claude" ? settings.claudeUrl : settings.codexUrl;
          return refreshProviderFromUrl(provider, url);
        }),
      );
      if (!cancelled) {
        setSnapshots((current) => results.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), current));
        setLastUpdated(new Date());
      }
    }
    // Refresh once shortly after launch (gives the hidden WebViews a moment to exist/navigate),
    // then keep refreshing on the interval — all silently in the background.
    const initial = window.setTimeout(refreshOpenProviders, 800);
    const interval = window.setInterval(refreshOpenProviders, Math.max(15, settings.refreshIntervalSec) * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [settings.refreshIntervalSec, settings.claudeUrl, settings.codexUrl]);

  const shown = useMemo(() => {
    return (["claude", "codex"] as Provider[]).filter((provider) => provider === "claude" ? settings.showClaude : settings.showCodex);
  }, [settings.showClaude, settings.showCodex]);

  async function refresh(provider: Provider) {
    setBusy(provider);
    const url = provider === "claude" ? settings.claudeUrl : settings.codexUrl;
    const snapshot = await refreshProviderFromUrl(provider, url);
    setSnapshots((currentSnapshots) => ({ ...currentSnapshots, [provider]: snapshot }));
    setMessage(`${providerLabel(provider)}: ${snapshot.message}`);
    setBusy(null);
  }

  useEffect(() => {
    setCompactTimerSet((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const p of ["claude", "codex"] as Provider[]) {
        if ((snapshots[p].percentUsed ?? 0) >= 100 && !next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [snapshots]);

  function toggleCompactTimer(provider: Provider) {
    setCompactTimerSet((prev) => {
      const next = new Set(prev);
      next.has(provider) ? next.delete(provider) : next.add(provider);
      return next;
    });
  }

  async function refreshAll() {
    setBusy("claude");
    const results = await Promise.all(
      (["claude", "codex"] as Provider[]).map((provider) => refreshProviderFromUrl(provider, provider === "claude" ? settings.claudeUrl : settings.codexUrl)),
    );
    setSnapshots((currentSnapshots) => results.reduce((next, snapshot) => ({ ...next, [snapshot.provider]: snapshot }), currentSnapshots));
    setLastUpdated(new Date());
    setMessage("Usage refreshed.");
    setBusy(null);
  }

  async function openInApp(provider: Provider) {
    setBusy(`${provider}-open`);
    try {
      await openProvider(provider, settings);
      setMessage(`${providerLabel(provider)} login window opened.`);
    } catch (error) {
      setMessage(`${providerLabel(provider)} open failed: ${String(error)}`);
    }
    setBusy(null);
  }

  async function closeInApp(provider: Provider) {
    setBusy(`${provider}-close`);
    try {
      await closeProvider(provider);
      setMessage(`${providerLabel(provider)} window hidden.`);
    } catch (error) {
      setMessage(`${providerLabel(provider)} close failed: ${String(error)}`);
    }
    setBusy(null);
  }

  async function reloadInApp(provider: Provider) {
    setBusy(`${provider}-reload`);
    try {
      await refreshProviderPage(provider, provider === "claude" ? settings.claudeUrl : settings.codexUrl);
      setMessage(`${providerLabel(provider)} usage page opened.`);
    } catch (error) {
      setMessage(`${providerLabel(provider)} reload failed: ${String(error)}`);
    }
    setBusy(null);
  }

  async function openBrowser(provider: Provider) {
    const url = provider === "claude" ? settings.claudeUrl : settings.codexUrl;
    const via = await openInChrome(url);
    setMessage(
      via === "chrome"
        ? `${providerLabel(provider)} opened in Chrome. Browser view cannot be extracted.`
        : `${providerLabel(provider)} opened in default browser (Chrome not found).`,
    );
  }

  async function findApi(provider: Provider) {
    setBusy(`${provider}-discover`);
    try {
      const result = await discoverProviderApi(provider, provider === "claude" ? settings.claudeUrl : settings.codexUrl);
      setDiscovery((current) => ({ ...current, [provider]: result }));
      setMessage(`${providerLabel(provider)}: API discovery done — see "Discovered API" below.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDiscovery((current) => ({ ...current, [provider]: `Error: ${message}` }));
      setMessage(`${providerLabel(provider)} discovery failed: ${message}`);
    }
    setBusy(null);
  }

  async function logoutInApp(provider: Provider) {
    setBusy(`${provider}-logout`);
    try {
      const url = provider === "claude" ? settings.claudeUrl : settings.codexUrl;
      await logoutProvider(provider, url);
      setMessage(`${providerLabel(provider)} signed out — in-app session cleared.`);
    } catch (error) {
      setMessage(`${providerLabel(provider)} logout failed: ${String(error)}`);
    }
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

  if (mode === "compact") {
    return (
      <main className={`compact-widget ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={prepareCompactDrag} onMouseMove={maybeStartCompactDrag} onContextMenu={openCompactMenu}>
        <div ref={compactProvidersRef} className="compact-providers">
          {shown.length > 0 ? shown.map((provider) => (
            <div
              key={provider}
              onMouseEnter={() => setCompactHovered(provider)}
              onMouseLeave={() => setCompactHovered(null)}
              onClick={() => { if (!compactTimerSet.has(provider)) toggleCompactTimer(provider); }}
              style={{ cursor: compactTimerSet.has(provider) ? "default" : "pointer" }}
            >
              {compactTimerSet.has(provider)
                ? <CompactTimerView snapshot={snapshots[provider]} onBack={() => toggleCompactTimer(provider)} />
                : compactHovered === provider
                ? <UsageBlock snapshot={snapshots[provider]} />
                : <CompactUsageBlock snapshot={snapshots[provider]} />
              }
            </div>
          )) : <EmptyProviderState />}
        </div>
        {compactMenuOpen && (
          <div className="compact-menu" role="menu" onClick={(event) => event.stopPropagation()}>
            <button onClick={() => { setCompactMenuOpen(false); void refreshAll(); }}>Refresh</button>
            <button onClick={() => { setCompactMenuOpen(false); setMode("settings"); }}>Settings</button>
            <button onClick={() => { setCompactMenuOpen(false); setMode("widget"); }}>Full view</button>
            <button onClick={() => void minimizeWindow()}>Minimize</button>
            <button className="danger" onClick={() => void closeWindow()}>Close</button>
          </div>
        )}
      </main>
    );
  }

  if (mode === "settings") {
    return (
      <main className={`control-shell ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={startWindowDrag}>
        <div className="scale-shell">
        <header className="titlebar" data-tauri-drag-region>
          <div className="window-title" data-tauri-drag-region>
            <strong data-tauri-drag-region>UsageView.cfg</strong>
            <span data-tauri-drag-region>{settingsSavedAt ? `Saved ${settingsSavedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Auto-save on"}</span>
          </div>
          <div className="title-actions">
            <button className="back-btn" onClick={() => setMode("widget")}>Back</button>
            <WindowControls pinned={settings.alwaysOnTop} onTogglePin={togglePinned} onMinimize={() => void minimizeWindow()} onMaximize={() => void toggleMaximizeWindow()} onClose={() => void closeWindow()} />
          </div>
        </header>

        <section className="settings-section">
          <h2>Status</h2>
          <div className="status-line"><span />{message}<strong>{settings.alwaysOnTop ? "pinned" : "unpinned"}</strong></div>
        </section>

        <section className="settings-section">
          <h2>Accounts</h2>
        <ProviderPanel
          provider="claude"
          url={settings.claudeUrl}
          snapshot={snapshots.claude}
          busy={busy}
          onOpen={() => void openInApp("claude")}
          onBrowser={() => void openBrowser("claude")}
          onReload={() => void reloadInApp("claude")}
          onClose={() => void closeInApp("claude")}
          onLogout={() => void logoutInApp("claude")}
          onDiscover={() => void findApi("claude")}
          discovery={discovery.claude}
          onExtract={() => void refresh("claude")}
          onUrlChange={(url) => updateSettings({ ...settings, claudeUrl: url })}
          shownInWidget={settings.showClaude}
          onToggleShown={() => updateSettings({ ...settings, showClaude: !settings.showClaude })}
        />

        <ProviderPanel
          provider="codex"
          url={settings.codexUrl}
          snapshot={snapshots.codex}
          busy={busy}
          onOpen={() => void openInApp("codex")}
          onBrowser={() => void openBrowser("codex")}
          onReload={() => void reloadInApp("codex")}
          onClose={() => void closeInApp("codex")}
          onLogout={() => void logoutInApp("codex")}
          onDiscover={() => void findApi("codex")}
          discovery={discovery.codex}
          onExtract={() => void refresh("codex")}
          onUrlChange={(url) => updateSettings({ ...settings, codexUrl: url })}
          shownInWidget={settings.showCodex}
          onToggleShown={() => updateSettings({ ...settings, showCodex: !settings.showCodex })}
        />
        </section>

        <WidgetSettings settings={settings} savedAt={settingsSavedAt} onChange={updateSettings} />
        </div>
      </main>
    );
  }

  return (
    <main ref={widgetRef} className={`widget ${themeClass(settings.theme)}`} style={panelStyle(settings)} onMouseDown={startWindowDrag} data-tauri-drag-region>
      <div className="scale-shell" data-tauri-drag-region>
      <div ref={widgetHeaderRef} className="widget-header" data-tauri-drag-region>
        <div className="window-title" data-tauri-drag-region>
          <span data-tauri-drag-region>updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <WindowControls pinned={settings.alwaysOnTop} onTogglePin={togglePinned} onMinimize={() => void minimizeWindow()} onMaximize={() => void toggleMaximizeWindow()} onClose={() => void closeWindow()} />
      </div>
      <div ref={providersRef} className="providers" data-tauri-drag-region>
        {shown.length > 0 ? shown.map((provider) => <UsageBlock key={provider} snapshot={snapshots[provider]} compact />) : <EmptyProviderState />}
      </div>
      {showFooter && (
        <footer ref={widgetFooterRef} className="widget-footer">
          <div className="appearance">
            <button className={isGlassTheme(settings.theme) ? "active" : ""} onClick={() => updateSettings({ ...settings, theme: toggleGlassTheme(settings.theme) })}>
              {isGlassTheme(settings.theme) ? "Glass" : "Pixel"}
            </button>
            <button className={isLightTheme(settings.theme) ? "active" : ""} onClick={() => updateSettings({ ...settings, theme: toggleLightTheme(settings.theme) })}>
              {isLightTheme(settings.theme) ? "Light" : "Dark"}
            </button>
          </div>
          <div className="actions">
            <button className="compact-toggle" title="Compact mode" aria-label="Compact mode" onClick={() => setMode("compact")}>▣</button>
            <button onClick={() => void refreshAll()} disabled={busy !== null}>{busy ? "Reading" : "Refresh now"}</button>
            <button onClick={() => setMode("settings")}>Settings</button>
          </div>
        </footer>
      )}
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
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="window-controls" aria-label="Window controls">
      <button className={`window-control pin ${pinned ? "active" : ""}`} type="button" title={pinned ? "Unpin from top" : "Pin always on top"} aria-label={pinned ? "Unpin from top" : "Pin always on top"} onClick={onTogglePin}><PinIcon /></button>
      <button className="window-control minimize" type="button" title="Minimize" aria-label="Minimize" onClick={onMinimize}>-</button>
      <button className="window-control maximize" type="button" title="Maximize" aria-label="Maximize" onClick={onMaximize}>[]</button>
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

function ProviderLoginApp({ provider }: { provider: Provider }) {
  const settings = loadSettings();
  const targetUrl = localStorage.getItem(`usageview.providerTarget.${provider}`) || (provider === "claude" ? settings.claudeUrl : settings.codexUrl);
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
          <p>{provider === "claude" ? "Claude account session." : "Codex account session."}</p>
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

function WidgetSettings({ settings, savedAt, onChange }: { settings: Settings; savedAt: Date | null; onChange: (settings: Settings) => void }) {
  function patch(next: Partial<Settings>) {
    onChange({ ...settings, ...next });
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
        <label>Theme<select value={settings.theme} onChange={(event) => patch({ theme: event.target.value as Settings["theme"] })}><option value="terminal">Pixel Dark</option><option value="light">Pixel Light</option><option value="glass">Glass Dark</option><option value="glass-light">Glass Light</option><option value="dark">Dark</option></select></label>
        <label>Opacity<input type="range" min="0.45" max="1" step="0.01" value={settings.opacity} onChange={(event) => patch({ opacity: Number(event.target.value) })} /></label>
      </div>
      <div className="settings-row">
        <label>Refresh seconds<input type="number" min="15" value={settings.refreshIntervalSec} onChange={(event) => patch({ refreshIntervalSec: Number(event.target.value) })} /></label>
      </div>
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

function CompactTimerView({ snapshot, onBack }: { snapshot: UsageSnapshot; onBack: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const resetMs = parseResetMs(snapshot.resetLabel);
  const countdown = resetMs !== null ? formatCountdown(resetMs) : null;
  return (
    <article className={`compact-usage provider-tile ${snapshot.provider} timer-view`} onClick={onBack}>
      <div className="compact-usage-head">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className="timer-label">reset at</span>
      </div>
      <div className="compact-timer-clock">{countdown ?? snapshot.resetLabel ?? "—"}</div>
      <div className="compact-timer-sub">
        {snapshot.resetLabel && <span>{snapshot.resetLabel}</span>}
        <span className="compact-timer-hint">tap to dismiss</span>
      </div>
    </article>
  );
}

function CompactExpandedView({ snapshot }: { snapshot: UsageSnapshot }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const activeCells = Math.max(0, Math.min(20, Math.round((percent ?? 0) / 5)));
  const metaLeft = usageMetaLeft(snapshot, percent);
  const metaRight = usageMetaRight(snapshot);
  return (
    <article className={`compact-usage provider-tile ${snapshot.provider} hovered-expand`}>
      <div className="compact-usage-head">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className={`source-pill ${snapshot.status === "ok" ? "ok" : "warn"}`}>{providerSourceLabel(snapshot.provider, snapshot.status)}</span>
      </div>
      <div className="expand-percent">{percent !== undefined ? `${Math.round(percent)}%` : "—"}</div>
      <div className="expand-bar" aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {Array.from({ length: 20 }, (_, i) => <span key={i} className={i < activeCells ? "cell active" : "cell"} />)}
      </div>
      <div className="expand-message">{snapshot.message}</div>
      <div className="compact-meta">
        <span>{metaLeft}</span>
        <span>{metaRight}</span>
      </div>
    </article>
  );
}

function CompactUsageBlock({ snapshot }: { snapshot: UsageSnapshot }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const activeCells = Math.max(0, Math.min(12, Math.round((percent ?? 0) / 8.333)));
  const metaLeft = usageMetaLeft(snapshot, percent);
  const metaRight = usageMetaRight(snapshot);
  return (
    <article className={`compact-usage provider-tile ${snapshot.provider}`}>
      <div className="compact-usage-head">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className={`source-pill ${snapshot.status === "ok" ? "ok" : "warn"}`}>{providerSourceLabel(snapshot.provider, snapshot.status)}</span>
      </div>
      <div className="compact-usage-main">
        <span className="compact-percent">{percent !== undefined ? `${Math.round(percent)}%` : "--"}</span>
        <span className="compact-message">{providerMessage(snapshot)}</span>
      </div>
      <div className="compact-bar" aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {Array.from({ length: 12 }, (_, index) => <span key={index} className={index < activeCells ? "cell active" : "cell"} />)}
      </div>
      <div className="compact-meta">
        <span>{metaLeft}</span>
        <span>{metaRight}</span>
      </div>
    </article>
  );
}

function UsageBlock({ snapshot, compact = false }: { snapshot: UsageSnapshot; compact?: boolean }) {
  const percent = typeof snapshot.percentUsed === "number" ? Math.max(0, Math.min(100, snapshot.percentUsed)) : undefined;
  const activeCells = Math.max(0, Math.min(20, Math.round((percent ?? 0) / 5)));
  const metaLeft = usageMetaLeft(snapshot, percent);
  const metaRight = usageMetaRight(snapshot);
  return (
    <article className={`${compact ? "usage compact" : "usage"} provider-tile ${snapshot.provider}`}>
      <div className="usage-top">
        <strong><ProviderMark provider={snapshot.provider} />{providerLabel(snapshot.provider)}</strong>
        <span className={`source-pill ${snapshot.status === "ok" ? "ok" : "warn"}`}>{providerSourceLabel(snapshot.provider, snapshot.status)}</span>
      </div>
      <div className="metric">
        <span className="percent">{percent !== undefined ? `${Math.round(percent)}%` : "--"}</span>
        <span className="message">{providerMessage(snapshot)}</span>
      </div>
      <div className="bar" aria-label={`${providerLabel(snapshot.provider)} usage ${percent ?? 0} percent`}>
        {Array.from({ length: 20 }, (_, index) => <span key={index} className={index < activeCells ? "cell active" : "cell"} />)}
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
