use std::sync::mpsc;
use std::time::Duration;

use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Listener, Manager, WebviewUrl, WebviewWindowBuilder,
};

const PAYLOAD_PREFIX: &str = "__USAGEVIEW__";
const EXTRACT_EVENT: &str = "usageview-extract-result";
const TRAY_SHOW_WIDGET: &str = "show_widget";
const TRAY_HIDE_WIDGET: &str = "hide_widget";
const TRAY_QUIT: &str = "quit";

#[tauri::command]
fn open_provider_window(app: tauri::AppHandle, provider: String, url: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label)?;
  let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
  window.navigate(target).map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn close_provider_window(app: tauri::AppHandle, provider: String) -> Result<(), String> {
  // Hide instead of close so the logged-in session and remote page survive for reopen.
  let label = provider_label(&provider)?;
  if let Some(window) = app.get_webview_window(&label) {
    window.hide().map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn reload_provider_window(app: tauri::AppHandle, provider: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  let window = app.get_webview_window(&label).ok_or_else(|| format!("{} WebView is not open", provider))?;
  window.eval("window.location.reload();").map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn refresh_provider_page(app: tauri::AppHandle, provider: String, url: String, background: bool) -> Result<(), String> {
  let label = provider_label(&provider)?;
  let window = app.get_webview_window(&label).ok_or_else(|| format!("{} WebView is not open", provider))?;
  // Background refresh must never yank a visible window — the user may be mid-login on it.
  if background && window.is_visible().unwrap_or(false) {
    return Ok(());
  }
  let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
  window.navigate(target).map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
fn prepare_provider_refresh(app: tauri::AppHandle, provider: String, url: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  let window = app.get_webview_window(&label).ok_or_else(|| format!("{} WebView is not open", provider))?;
  if provider != "claude" {
    return Ok(());
  }

  let visible = window.is_visible().unwrap_or(false);

  // Auto-refresh Claude usage only when the window is hidden. When visible, leave the
  // page alone so the user isn't interrupted and so we can scrape the already-loaded DOM
  // without a reload race. Manual Reload/Refresh still uses refresh_provider_page and
  // forces the configured usage URL.
  if !visible {
    let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    window.navigate(target).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn open_widget_window(app: tauri::AppHandle) -> Result<(), String> {
  show_widget_window(&app)
}

fn show_widget_window(app: &tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("widget") {
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    return Ok(());
  }

  WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("index.html".into()))
    .title("UsageView Widget")
    .inner_size(350.0, 230.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
    .build()
    .map_err(|error| error.to_string())?;
  Ok(())
}

fn hide_widget_window(app: &tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("widget") {
    window.hide().map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
  show_settings_window(&app)
}

// Gear button toggles: hide when already visible, otherwise show.
#[tauri::command]
fn toggle_settings_window(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("settings") {
    if window.is_visible().unwrap_or(false) {
      window.hide().map_err(|error| error.to_string())?;
      return Ok(());
    }
  }
  show_settings_window(&app)
}

fn show_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
  // Rebuild the window if it was destroyed (e.g. the user hit the native close button); state lives in
  // localStorage so a fresh window comes back identical.
  let window = match app.get_webview_window("settings") {
    Some(window) => window,
    None => WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
      .title("UsageView - Settings")
      .inner_size(460.0, 780.0)
      .min_inner_size(430.0, 560.0)
      .resizable(true)
      .decorations(false)
      .transparent(true)
      .shadow(false)
      .always_on_top(true)
      .skip_taskbar(true)
      .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
      .build()
      .map_err(|error| error.to_string())?,
  };

  // Place the settings window next to the widget so both stay visible side by side.
  if let Some(widget) = app.get_webview_window("widget") {
    if let (Ok(wpos), Ok(wsize), Ok(ssize)) =
      (widget.outer_position(), widget.outer_size(), window.outer_size())
    {
      let gap: i32 = 12;
      let left = wpos.x - ssize.width as i32 - gap;
      let x = if left >= 0 { left } else { wpos.x + wsize.width as i32 + gap };
      let y = wpos.y.max(0);
      let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
  }

  window.unminimize().map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())?;
  Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
  let show = MenuItem::with_id(app, TRAY_SHOW_WIDGET, "Show UsageView", true, None::<&str>)?;
  let hide = MenuItem::with_id(app, TRAY_HIDE_WIDGET, "Hide UsageView", true, None::<&str>)?;
  let separator = PredefinedMenuItem::separator(app)?;
  let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

  let mut tray = TrayIconBuilder::with_id("usageview-tray")
    .tooltip("UsageView")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id().as_ref() {
      TRAY_SHOW_WIDGET => {
        let _ = show_widget_window(app);
      }
      TRAY_HIDE_WIDGET => {
        let _ = hide_widget_window(app);
      }
      TRAY_QUIT => app.exit(0),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        let _ = show_widget_window(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon().cloned() {
    tray = tray.icon(icon);
  }

  tray.build(app)?;
  Ok(())
}

#[tauri::command]
fn update_tray_tooltip(app: tauri::AppHandle, text: String) -> Result<(), String> {
  if let Some(tray) = app.tray_by_id("usageview-tray") {
    tray.set_tooltip(Some(text)).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn open_in_chrome(url: String) -> Result<(), String> {
  // Launch Chrome explicitly. We resolve chrome.exe from its known install locations rather
  // than relying on PATH or `start chrome`, so a missing Chrome fails cleanly (no Windows
  // "cannot find chrome" popup) and the frontend can fall back to the default browser.
  for path in chrome_paths() {
    if std::path::Path::new(&path).exists() {
      return std::process::Command::new(&path)
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string());
    }
  }
  Err("Chrome not found".to_string())
}

#[tauri::command]
fn logout_provider(app: tauri::AppHandle, provider: String, url: String) -> Result<(), String> {
  // Clear the WebView session (cookies/storage) so the user is truly signed out, then send
  // the window back to the login/usage URL.
  // Note: primary provider windows share one WebView2 profile, so signing out of claude or
  // codex also affects the other. Isolated accounts (codex-1 etc.) have separate profiles.
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label)?;
  window.clear_all_browsing_data().map_err(|error| error.to_string())?;
  let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
  window.navigate(target).map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
async fn extract_provider(app: tauri::AppHandle, provider: String, url: String) -> Result<String, String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label)?;
  let expected_host = provider_host(&provider)?;

  // A freshly-created dynamic window (Codex 2 / provider_codex_1) isn't ready right after build();
  // calling url()/navigate()/eval() too early throws "failed to receive message from webview" and the
  // first read fails until a manual refresh. Wait until the webview responds. Predeclared windows
  // (Claude/Codex) answer immediately, so this adds no delay for them.
  for _ in 0..20 {
    if window.url().is_ok() {
      break;
    }
    std::thread::sleep(Duration::from_millis(100));
  }

  // Silent background refresh: if the window is hidden and not already on the provider site
  // (e.g. right after launch it sits on the local wrapper), navigate it there without showing
  // it. The login cookie persists, so the usage page loads logged in. We never navigate a
  // visible window — the user may be mid-login on it.
  let visible = window.is_visible().unwrap_or(false);
  let current_url = window.url().ok();
  let on_target = current_url
    .as_ref()
    .map(|current| is_usable_provider_page(&provider, current, expected_host, &url))
    .unwrap_or(false);
  if (provider == "claude" && !on_target) || (!visible && !on_target) {
    let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    window.navigate(target).map_err(|error| error.to_string())?;
  }

  // The extractor hands its result back through the URL fragment (#...), because eval() is
  // fire-and-forget and document.title is not reflected by window.title() on WebView2.
  // A per-call nonce in the marker guarantees we read THIS call's fragment, never a stale one.
  // The fragment is "<marker><status>|<encodedJson>" so we know when to stop waiting.
  let nonce = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis())
    .unwrap_or(0);
  let marker = format!("{}{}:", PAYLOAD_PREFIX, nonce);
  let script = extract_script(&provider, &marker)?;
  let (event_tx, event_rx) = mpsc::channel::<(String, String)>();
  let event_marker = marker.clone();
  let event_id = app.listen(EXTRACT_EVENT, move |event| {
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
      return;
    };
    let marker = payload.get("marker").and_then(|value| value.as_str()).unwrap_or_default();
    if marker != event_marker {
      return;
    }
    let status = payload.get("status").and_then(|value| value.as_str()).unwrap_or_default().to_string();
    let encoded = payload.get("encoded").and_then(|value| value.as_str()).unwrap_or_default().to_string();
    if !encoded.is_empty() {
      let _ = event_tx.send((status, encoded));
    }
  });

  let mut last_payload: Option<String> = None;
  // Claude's SPA can be slow after a forced navigation, so give it a larger budget.
  let mut result: Option<String> = None;
  let max_attempts = if provider == "claude" { 48 } else { 24 };
  for attempt in 0..max_attempts {
    if let Ok((status, encoded)) = event_rx.try_recv() {
      last_payload = Some(encoded.clone());
      if status == "ok" || status == "not_logged_in" {
        result = Some(encoded);
        break;
      }
    }
    let current = window.url().map_err(|error| error.to_string())?;
    // Eval as soon as we are on the provider's host. Claude now reads usage from a same-origin JSON
    // API (works on any claude.ai page), so we must NOT gate on the /settings path: the SPA often
    // routes away from it, which previously blocked the eval entirely and starved the API fetch.
    let here = current.host_str().unwrap_or_default().contains(expected_host);
    if here {
      if attempt % 4 == 0 {
        window.eval(&script).map_err(|error| error.to_string())?;
      }
      if let Some((_, rest)) = current.as_str().split_once(&marker) {
        if let Some((status, encoded)) = rest.split_once('|') {
          last_payload = Some(encoded.to_string());
          // Stop as soon as we have usable data, or know the session needs a re-login.
          if status == "ok" || status == "not_logged_in" {
            result = Some(encoded.to_string());
            break;
          }
        }
      }
    }
    std::thread::sleep(Duration::from_millis(250));
  }
  app.unlisten(event_id);

  if let Some(encoded) = result {
    return Ok(encoded);
  }

  // Timed out: hand back the last (incomplete) snapshot if we got one, else a clear hint.
  last_payload.ok_or_else(|| {
    format!(
      "Could not read {} usage. Open Settings and Login if your session expired.",
      provider
    )
  })
}

/// One-off discovery: find the JSON endpoint the provider's usage page actually calls, so we
/// can later read usage directly from that API instead of scraping the rendered DOM.
#[tauri::command]
async fn discover_provider_api(app: tauri::AppHandle, provider: String, url: String) -> Result<String, String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label)?;
  let expected_host = provider_host(&provider)?;

  let visible = window.is_visible().unwrap_or(false);
  let on_host = window
    .url()
    .map(|current| current.host_str().unwrap_or_default().contains(expected_host))
    .unwrap_or(false);
  if !visible && !on_host {
    let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
    window.navigate(target).map_err(|error| error.to_string())?;
  }

  let nonce = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis())
    .unwrap_or(0);
  let marker = format!("{}{}:", PAYLOAD_PREFIX, nonce);
  let script = discover_script(&provider, &marker)?;

  let mut last_payload: Option<String> = None;
  // Generous budget: the page must finish loading and firing its own API calls first, and the
  // discovery probe itself awaits several fetches.
  for attempt in 0..48 {
    let current = window.url().map_err(|error| error.to_string())?;
    let here = current.host_str().unwrap_or_default().contains(expected_host);
    if here {
      if attempt % 8 == 0 {
        window.eval(&script).map_err(|error| error.to_string())?;
      }
      if let Some((_, rest)) = current.as_str().split_once(&marker) {
        if let Some((status, encoded)) = rest.split_once('|') {
          last_payload = Some(encoded.to_string());
          if status == "ok" {
            return Ok(encoded.to_string());
          }
        }
      }
    }
    std::thread::sleep(Duration::from_millis(250));
  }

  last_payload.ok_or_else(|| {
    format!(
      "No usage JSON endpoint found for {}. Make sure the usage page is loaded and you are signed in.",
      provider
    )
  })
}

pub fn run() {
  tauri::Builder::default()
    // Single-instance must be registered first: a second launch just focuses the running widget.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      let _ = show_widget_window(app);
    }))
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      setup_tray(app.handle())?;
      Ok(())
    })
    .on_window_event(|window, event| {
      // Close hides app windows so UsageView can keep running from the tray.
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let label = window.label();
        if label == "widget" {
          api.prevent_close();
          let _ = window.hide();
        } else if label.starts_with("provider_") {
          api.prevent_close();
          if let Some(widget) = window.app_handle().get_webview_window("widget") {
            let _ = widget.show();
            let _ = widget.set_focus();
          }
          let _ = window.hide();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      open_provider_window,
      close_provider_window,
      reload_provider_window,
      refresh_provider_page,
      prepare_provider_refresh,
      open_widget_window,
      open_settings_window,
      toggle_settings_window,
      update_tray_tooltip,
      open_in_chrome,
      logout_provider,
      extract_provider,
      discover_provider_api
    ])
    .run(tauri::generate_context!())
    .expect("error while running UsageView");
}

fn provider_label(provider: &str) -> Result<String, String> {
  match provider {
    "claude" => Ok("provider_claude".to_string()),
    "codex" => Ok("provider_codex".to_string()),
    "codex-1" => Ok("provider_codex_1".to_string()),
    _ => Err(format!("Unknown provider: {}", provider)),
  }
}

fn provider_host(provider: &str) -> Result<&'static str, String> {
  match provider {
    "claude" => Ok("claude.ai"),
    "codex" | "codex-1" => Ok("chatgpt.com"),
    _ => Err(format!("Unknown provider: {}", provider)),
  }
}

/// Get a provider window if it exists, or create it with an isolated WebView2 profile.
/// Primary provider windows (provider_claude, provider_codex) are pre-declared in
/// tauri.conf.json so get_webview_window always finds them. Additional account windows
/// (provider_codex_1 etc.) are created dynamically with a separate data_directory so
/// they can hold an independent login session.
fn get_or_create_provider_window(app: &tauri::AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
  if let Some(window) = app.get_webview_window(label) {
    return Ok(window);
  }
  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("profiles")
    .join(label);
  let title = label.strip_prefix("provider_").unwrap_or(label).replace('_', " ");
  WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
    .title(format!("{} \u{2014} UsageView", title))
    .inner_size(980.0, 760.0)
    .min_inner_size(720.0, 520.0)
    .center()
    .visible(false)
    .data_directory(data_dir)
    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    .build()
    .map_err(|e| e.to_string())
}

fn is_usable_provider_page(provider: &str, current: &tauri::Url, expected_host: &str, target_url: &str) -> bool {
  let on_host = current.host_str().unwrap_or_default().contains(expected_host);
  if !on_host {
    return false;
  }
  if provider != "claude" {
    return true;
  }
  let current_path = current.path().trim_end_matches('/');
  let target_matches = tauri::Url::parse(target_url)
    .map(|target| current_path == target.path().trim_end_matches('/'))
    .unwrap_or(false);
  target_matches || current_path == "/settings" || current_path.starts_with("/settings/")
}

fn chrome_paths() -> Vec<String> {
  let suffix = r"\Google\Chrome\Application\chrome.exe";
  ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
    .iter()
    .filter_map(|var| std::env::var(var).ok())
    .map(|base| format!("{}{}", base, suffix))
    .collect()
}

fn js_string(value: &str) -> String {
  serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn extract_script(provider: &str, marker: &str) -> Result<String, String> {
  if provider != "claude" && provider != "codex" && provider != "codex-1" {
    return Err(format!("Unknown provider: {}", provider));
  }

  if provider == "codex" || provider == "codex-1" {
    return Ok(format!(
      r#"(async () => {{
  const provider = {provider_name};
  const marker = {marker};

  function finish(status, snapshot) {{
    const encoded = encodeURIComponent(JSON.stringify(snapshot));
    try {{ window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit('{event}', {{ marker, status, encoded }}); }} catch (e) {{}}
    try {{ history.replaceState(null, '', location.pathname + location.search + '#' + marker + status + '|' + encoded); }} catch (e) {{}}
  }}

  function resetLabel(prefix, windowInfo) {{
    if (!windowInfo) return undefined;
    if (windowInfo.reset_at) {{
      return `Reset ${{new Date(windowInfo.reset_at * 1000).toLocaleString([], {{ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }})}}`;
    }}
    if (typeof windowInfo.reset_after_seconds === 'number') {{
      return `Reset ${{new Date(Date.now() + windowInfo.reset_after_seconds * 1000).toLocaleString([], {{ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }})}}`;
    }}
    return undefined;
  }}

  function creditsLabel(credits, resetCredits) {{
    if (!credits) return undefined;
    const parts = [];
    if (credits.has_credits) parts.push(`Credits ${{credits.balance ?? 'unknown'}}`);
    if (resetCredits && typeof resetCredits.available_count === 'number') parts.push(`${{resetCredits.available_count}} reset credits`);
    if (credits.overage_limit_reached) parts.push('overage limit reached');
    return parts.length ? parts.join(' / ') : undefined;
  }}

  function fallbackSnapshot(message, debugText) {{
    return {{
      provider,
      status: 'not_found',
      message,
      debugText: debugText ? String(debugText).slice(0, 600) : undefined
    }};
  }}

  try {{
    const session = await fetch(location.origin + '/api/auth/session', {{ credentials: 'include' }});
    if (!session.ok) {{
      finish('not_logged_in', {{
        provider,
        status: 'not_logged_in',
        message: 'ChatGPT session was not available. Open Login inside the app.'
      }});
      return;
    }}
    const sessionJson = await session.json();
    if (!sessionJson || !sessionJson.accessToken) {{
      finish('not_logged_in', {{
        provider,
        status: 'not_logged_in',
        message: 'ChatGPT access token was not available. Open Login inside the app.'
      }});
      return;
    }}
    const accessToken = sessionJson.accessToken;

    const response = await fetch(location.origin + '/backend-api/wham/usage', {{
      credentials: 'include',
      headers: {{ Authorization: 'Bearer ' + accessToken }}
    }});
    const raw = await response.text();
    if (!response.ok) {{
      finish('not_found', fallbackSnapshot(`Codex usage API returned HTTP ${{response.status}}`, raw));
      return;
    }}

    const data = JSON.parse(raw);
    const primary = data && data.rate_limit && data.rate_limit.primary_window;
    const secondary = data && data.rate_limit && data.rate_limit.secondary_window;
    const percentUsed = primary && typeof primary.used_percent === 'number' ? primary.used_percent : undefined;
    const weeklyPercent = secondary && typeof secondary.used_percent === 'number' ? secondary.used_percent : undefined;
    const reset = resetLabel('5-hour window', primary);
    const weeklyReset = resetLabel('Weekly window', secondary);
    const remaining = weeklyPercent !== undefined
      ? `Weekly left ${{Math.max(0, 100 - Math.round(weeklyPercent))}}%`
      : creditsLabel(data.credits, data.rate_limit_reset_credits);

    if (percentUsed === undefined && !reset && !weeklyReset && !remaining) {{
      finish('not_found', fallbackSnapshot('Codex usage API responded, but no usage fields were detected.', raw));
      return;
    }}

    finish('ok', {{
      provider,
      status: 'ok',
      message: 'Usage values read from ChatGPT internal usage API',
      usedLabel: percentUsed !== undefined ? `${{Math.round(percentUsed)}}% used` : undefined,
      remainingLabel: remaining,
      percentUsed,
      resetLabel: reset,
      weeklyLabel: weeklyPercent !== undefined
        ? `Weekly ${{Math.round(weeklyPercent)}}% used`
        : weeklyReset,
      debugText: raw.slice(0, 600)
    }});
  }} catch (error) {{
    finish('not_found', fallbackSnapshot('Codex usage API fetch failed.', error && error.message ? error.message : error));
  }}
}})();"#,
      provider_name = js_string(provider),
      marker = js_string(marker),
      event = EXTRACT_EVENT
    ));
  }

  // Claude: prefer its internal JSON usage API (works even while the WebView is hidden, since
  // fetch needs no rendering) and fall back to scraping the rendered page. Written with
  // placeholder replacement instead of format!() to avoid brace-escaping the large script.
  let claude_script = r#"(async () => {
  const provider = __PROVIDER__;
  const marker = __MARKER__;
  const origin = location.origin;

  function finish(status, snapshot) {
    const encoded = encodeURIComponent(JSON.stringify(snapshot));
    try { window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit('__EVENT__', { marker: marker, status: status, encoded: encoded }); } catch (e) {}
    try { history.replaceState(null, '', location.pathname + location.search + '#' + marker + status + '|' + encoded); } catch (e) {}
  }

  function clock(ms) {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function toMs(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number' && isFinite(value)) return value < 1e12 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : undefined;
  }
  function toPercent(value) {
    if (typeof value !== 'number' || !isFinite(value)) return undefined;
    if (value >= 0 && value <= 1) return value * 100;
    if (value > 1 && value <= 100) return value;
    return undefined;
  }

  // Pull {percent, resetMs} out of a window-like object using fuzzy key names.
  function readWindow(node) {
    if (!node || typeof node !== 'object') return {};
    let percent, resetMs, remaining;
    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      const value = node[key];
      if (percent === undefined && /(utiliz|percent)/.test(lower) && !/dollar/.test(lower)) {
        const p = toPercent(value);
        if (p !== undefined) percent = p;
      }
      if (remaining === undefined && /(remaining|left)/.test(lower)) {
        const r = toPercent(value);
        if (r !== undefined) remaining = r;
      }
      if (resetMs === undefined && /(reset|resets_at|expires|renew|refresh)/.test(lower)) {
        const m = toMs(value);
        if (m !== undefined) resetMs = m;
      }
    }
    if (percent === undefined && remaining !== undefined) percent = Math.max(0, 100 - remaining);
    return { percent: percent, resetMs: resetMs };
  }

  // Locate the 5-hour (primary) and 7-day (weekly) windows anywhere in the payload.
  function findWindows(data) {
    let primary, weekly;
    (function walk(node, keyPath) {
      if (!node || typeof node !== 'object') return;
      const lower = String(keyPath).toLowerCase();
      if (primary === undefined && /(five|5).?hour|primary|current|session/.test(lower)) {
        const w = readWindow(node);
        if (w.percent !== undefined || w.resetMs !== undefined) primary = w;
      }
      if (weekly === undefined && /(seven|7).?day|weekly|week/.test(lower)) {
        const w = readWindow(node);
        if (w.percent !== undefined || w.resetMs !== undefined) weekly = w;
      }
      for (const key of Object.keys(node)) walk(node[key], key);
    })(data, 'root');
    return { primary: primary, weekly: weekly };
  }

  // Claude's usage endpoint returns { five_hour:{utilization,resets_at}, seven_day:{...} }
  // where utilization is a 0..1 fraction. Parse that known shape precisely.
  function windowFromClaude(win) {
    if (!win || typeof win !== 'object') return undefined;
    const resetMs = toMs(win.resets_at);
    // A secondary/empty org returns utilization 0 with resets_at null. Treat that as "no data" so the
    // candidate loop skips it and picks the org that actually has an active usage window (a user can
    // belong to several orgs; only one has real usage).
    if (resetMs === undefined && !win.utilization) return undefined;
    const percent = toPercent(win.utilization);
    if (percent === undefined && resetMs === undefined) return undefined;
    return { percent: percent, resetMs: resetMs };
  }

  function fromApi(data, raw) {
    let primary, weekly;
    if (data && typeof data === 'object' && (data.five_hour || data.seven_day)) {
      primary = windowFromClaude(data.five_hour);
      weekly = windowFromClaude(data.seven_day);
    } else {
      const windows = findWindows(data);
      primary = windows.primary;
      weekly = windows.weekly;
    }
    primary = primary || {};
    weekly = weekly || {};
    if (primary.percent === undefined && primary.resetMs === undefined) {
      return undefined;
    }
    const percentUsed = primary.percent !== undefined ? primary.percent : weekly.percent;
    const resetLabel = primary.resetMs ? 'Reset ' + clock(primary.resetMs) : (weekly.resetMs ? 'Reset ' + clock(weekly.resetMs) : undefined);
    const weeklyPercent = weekly.percent;
    const weeklyReset = weekly.resetMs ? 'Reset ' + clock(weekly.resetMs) : undefined;
    return {
      provider: provider,
      status: 'ok',
      message: 'Usage values read from Claude internal usage API',
      usedLabel: percentUsed !== undefined ? Math.round(percentUsed) + '% used' : undefined,
      remainingLabel: weeklyPercent !== undefined ? 'Weekly left ' + Math.max(0, 100 - Math.round(weeklyPercent)) + '%' : undefined,
      percentUsed: percentUsed,
      resetLabel: resetLabel,
      weeklyLabel: weeklyPercent !== undefined ? ('Weekly ' + Math.round(weeklyPercent) + '% used' + (weeklyReset ? ' / ' + weeklyReset : '')) : weeklyReset,
      debugText: String(raw || '').slice(0, 600)
    };
  }

  // Fallback: scrape the rendered usage page (only reliable once the SPA has painted).
  function domScrape() {
    const body = document.body;
    const raw = body ? ((body.innerText && body.innerText.trim()) ? body.innerText : (body.textContent || '')) : '';
    const text = raw.replace(/\s+/g, ' ').trim();

    function findPercent() {
      const matches = [...text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1])).filter((value) => value >= 0 && value <= 100);
      if (!matches.length) return undefined;
      const usageWords = /(usage|used|limit|credit|credits|message|messages|5-hour|weekly)/i;
      const scored = matches.map((value) => {
        const index = text.indexOf(value + '%');
        const sample = text.slice(Math.max(0, index - 80), index + 80);
        return { value: value, score: usageWords.test(sample) ? 1 : 0 };
      });
      return scored.sort((a, b) => b.score - a.score)[0].value;
    }
    function findPercentIn(sample) {
      const matches = [...String(sample || '').matchAll(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:used)?/gi)]
        .map((match) => Number(match[1]))
        .filter((value) => value >= 0 && value <= 100);
      return matches.length ? matches[0] : undefined;
    }
    function findReset() {
      const match = text.match(/(?:reset|resets|renews|refreshes|available again|next reset)[^.]{0,90}/i);
      return match ? match[0].trim() : undefined;
    }
    function findResetIn(sample) {
      const match = String(sample || '').match(/(?:reset|resets|renews|refreshes|available again|next reset)[^%]{0,90}/i);
      return match ? match[0].trim() : undefined;
    }
    function resetToClock(label) {
      if (!label) return undefined;
      const lower = label.toLowerCase();
      const hours = Number((lower.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)/) || [])[1] || 0);
      const minutes = Number((lower.match(/(\d+)\s*(?:m|min|mins|minute|minutes)/) || [])[1] || 0);
      if (lower.includes('in') && (hours || minutes)) {
        return 'Reset ' + clock(Date.now() + (hours * 60 + minutes) * 60 * 1000);
      }
      return label;
    }
    function blockAfter(mark, stopMarkers) {
      const start = text.search(mark);
      if (start < 0) return '';
      const rest = text.slice(start);
      let end = rest.length;
      for (const stop of stopMarkers) {
        const index = rest.search(stop);
        if (index > 0) end = Math.min(end, index);
      }
      return rest.slice(0, end);
    }
    function findWeekly() {
      const match = text.match(/weekly[^.]{0,110}/i) || text.match(/week[^.]{0,110}usage[^.]{0,60}/i);
      return match ? match[0].trim() : undefined;
    }
    function findRemaining() {
      const match = text.match(/(?:remaining|left|available|credits? left)[^.]{0,90}/i);
      return match ? match[0].trim() : undefined;
    }
    function inferLoginStatus() {
      if (/sign in|log in|continue with google|continue with email|authenticate/i.test(text)) return 'not_logged_in';
      if (!text || text.length < 30) return 'page_unavailable';
      return 'not_found';
    }

    const currentBlock = blockAfter(/current session/i, [/weekly limits/i, /all models/i, /learn more/i]);
    const weeklyBlock = blockAfter(/weekly limits|all models/i, []);
    const weeklyPercent = findPercentIn(weeklyBlock);
    const weeklyReset = resetToClock(findResetIn(weeklyBlock));
    const percentUsed = (findPercentIn(currentBlock) ?? findPercent());
    const resetLabel = (resetToClock(findResetIn(currentBlock)) || resetToClock(findReset()));
    const weeklyLabel = weeklyPercent !== undefined ? ('Weekly ' + Math.round(weeklyPercent) + '% used' + (weeklyReset ? ' / ' + weeklyReset : '')) : findWeekly();
    const remainingLabel = weeklyPercent !== undefined ? ('Weekly left ' + Math.max(0, 100 - Math.round(weeklyPercent)) + '%') : findRemaining();
    const hasUsagePageMarkers = /plan usage limits|usage|limit|reset|resets|messages?|weekly|5[-\s]?hour|%/i.test(text);
    const ok = hasUsagePageMarkers && (percentUsed !== undefined || resetLabel || weeklyPercent !== undefined || remainingLabel);
    const status = ok ? 'ok' : inferLoginStatus();
    const snapshot = {
      provider: provider,
      status: status,
      message: ok
        ? 'Usage values extracted from official page'
        : status === 'not_logged_in'
          ? 'Not signed in on this page yet'
          : status === 'page_unavailable'
            ? 'Page has no readable content yet'
            : 'Signed in, but usage values were not detected yet',
      usedLabel: percentUsed !== undefined ? (Math.round(percentUsed) + '% used') : undefined,
      remainingLabel: remainingLabel,
      percentUsed: percentUsed,
      resetLabel: resetLabel,
      weeklyLabel: weeklyLabel,
      debugText: '[url] ' + location.href + '\n[text] ' + text.slice(0, 600)
    };
    return { status: status, snapshot: snapshot };
  }

  // API-first: Claude exposes a cookie-authed JSON usage endpoint
  // (/api/organizations/<uuid>/usage -> { five_hour:{utilization,resets_at}, seven_day:{...} }),
  // confirmed 200 in-session. Read it like Codex — no page render needed, so it stays reliable even
  // in a hidden/throttled WebView. Only report 'ok' when we actually parse usage; otherwise fall
  // through to the DOM scrape below. Never short-circuit login state from a bare API call.
  const apiLog = [];
  try {
    // Same-origin resource URLs the page already fetched.
    let perfNames = [];
    try {
      perfNames = performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.indexOf(origin) === 0);
    } catch (e) {}

    // Resolve the organization uuid from the organizations API, or from any org-scoped URL the
    // page already called (works even if /api/organizations rejects a header-less fetch).
    let orgUuid;
    try {
      const orgResp = await fetch(origin + '/api/organizations', { credentials: 'include' });
      apiLog.push('organizations ' + orgResp.status);
      if (orgResp.ok) {
        const orgs = await orgResp.clone().json();
        if (Array.isArray(orgs)) {
          const found = orgs.find((o) => o && o.uuid);
          if (found) orgUuid = found.uuid;
        }
      }
    } catch (e) { apiLog.push('organizations error'); }
    if (!orgUuid) {
      for (const name of perfNames) {
        const match = name.match(/\/api\/organizations\/([0-9a-fA-F-]{36})/);
        if (match) { orgUuid = match[1]; break; }
      }
    }

    // Candidates: the exact usage endpoint first, then any usage-looking call the page made.
    const candidates = [];
    if (orgUuid) candidates.push(origin + '/api/organizations/' + orgUuid + '/usage');
    for (const name of perfNames) {
      if (/usage|rate.?limit|limits|quota/i.test(name) && candidates.indexOf(name) === -1) candidates.push(name);
    }

    for (const url of candidates) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        const contentType = resp.headers.get('content-type') || '';
        apiLog.push(url.replace(origin, '') + ' ' + resp.status + (contentType.indexOf('json') === -1 ? ' non-json' : ''));
        if (!resp.ok || contentType.indexOf('json') === -1) continue;
        const raw = await resp.text();
        let data;
        try { data = JSON.parse(raw); } catch (e) { continue; }
        const snapshot = fromApi(data, raw);
        if (snapshot) { finish('ok', snapshot); return; }
      } catch (e) { apiLog.push('fetch error'); }
    }
  } catch (e) {}

  // 3) Fallback to the DOM scrape of the rendered page. Append the API attempt log to
  //    debugText so "Advanced -> Raw page text" reveals exactly what each endpoint returned.
  try {
    const result = domScrape();
    if (result && result.snapshot) {
      result.snapshot.debugText = (result.snapshot.debugText || '') + '\n[api] ' + (apiLog.length ? apiLog.join(' | ') : 'no api calls');
    }
    finish(result.status, result.snapshot);
  } catch (e) {
    finish('page_unavailable', { provider: provider, status: 'page_unavailable', message: 'Claude usage could not be read.', debugText: '[api] ' + apiLog.join(' | ') });
  }
})();"#;

  Ok(
    claude_script
      .replace("__PROVIDER__", &js_string(provider))
      .replace("__MARKER__", &js_string(marker))
      .replace("__EVENT__", EXTRACT_EVENT),
  )
}

fn discover_script(provider: &str, marker: &str) -> Result<String, String> {
  if provider != "claude" && provider != "codex" && provider != "codex-1" {
    return Err(format!("Unknown provider: {}", provider));
  }

  Ok(format!(
    r#"(async () => {{
  const provider = {provider};
  const marker = {marker};
  const origin = location.origin;
  const usageShape = /usage|limit|reset|utiliz|remaining|rate_limit|five|seven|week|window|credit|quota|balance|message|model/i;
  const nameHint = /usage|limit|rate|credit|quota|analytics|codex|balance|subscription|account|conversation|me$/i;

  // 1) Every API call (fetch/xhr) the page actually made, same-origin — so we can see exactly
  //    what the page fetches (or confirm it server-renders the data with no client call).
  let apiUrls = [];
  try {{
    apiUrls = performance.getEntriesByType('resource')
      .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
      .map((entry) => entry.name)
      .filter((name) => name.indexOf(origin) === 0);
    apiUrls = [...new Set(apiUrls)];
  }} catch (e) {{}}

  // 2) Auth: ChatGPT backend-api needs a Bearer token; claude.ai uses cookies (no token here).
  let authHeader = null;
  try {{
    const sess = await fetch(origin + '/api/auth/session', {{ credentials: 'include' }});
    if (sess.ok) {{
      const sj = await sess.json();
      if (sj && sj.accessToken) authHeader = 'Bearer ' + sj.accessToken;
    }}
  }} catch (e) {{}}

  // 3) Probe the usage-looking calls WITH proper auth and capture body samples.
  const samples = [];
  let endpoint = null;
  let apiRaw = null;
  const probe = apiUrls.filter((u) => nameHint.test(u));
  for (const candidate of probe) {{
    try {{
      const headers = authHeader ? {{ Authorization: authHeader }} : {{}};
      const response = await fetch(candidate, {{ credentials: 'include', headers }});
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || contentType.indexOf('json') === -1) {{
        samples.push({{ url: candidate, status: response.status, ct: contentType }});
        continue;
      }}
      const body = await response.text();
      samples.push({{ url: candidate, status: response.status, body: body.slice(0, 1200) }});
      if (!endpoint && usageShape.test(body)) {{
        endpoint = candidate;
        apiRaw = body.slice(0, 2500);
      }}
    }} catch (e) {{
      samples.push({{ url: candidate, error: true }});
    }}
  }}

  const status = endpoint ? 'ok' : 'not_found';
  const payload = {{ provider, hasAuthToken: !!authHeader, endpoint, apiRaw, apiUrls: apiUrls.slice(0, 60), samples: samples.slice(0, 10) }};
  try {{ history.replaceState(null, '', location.pathname + location.search + '#' + marker + status + '|' + encodeURIComponent(JSON.stringify(payload))); }} catch (e) {{}}
}})();"#,
    provider = js_string(provider),
    marker = js_string(marker)
  ))
}
