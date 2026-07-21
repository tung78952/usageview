use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder,
};

#[cfg(windows)]
mod asus_acpi;

#[cfg(windows)]
mod gpu_perf;

const PAYLOAD_PREFIX: &str = "__USAGEVIEW__";
const EXTRACT_EVENT: &str = "usageview-extract-result";
const TRAY_SHOW_WIDGET: &str = "show_widget";
const TRAY_HIDE_WIDGET: &str = "hide_widget";
const TRAY_QUIT: &str = "quit";
const CONTEXT_MINI: &str = "widget_context_mini";
const CONTEXT_FULL: &str = "widget_context_full";
const CONTEXT_PIN: &str = "widget_context_pin";
const CONTEXT_REFRESH: &str = "widget_context_refresh";
const CONTEXT_SETTINGS: &str = "widget_context_settings";
const CONTEXT_CLOSE: &str = "widget_context_close";
const CONTEXT_ACTION_EVENT: &str = "usageview-context-action";
const PROVIDER_RELEASED_EVENT: &str = "usageview-provider-released";
const WIDGET_VISIBILITY_EVENT: &str = "usageview-widget-visibility";
/// Fraction of the SMALLER of (tile, widget) that must overlap before a dropped tile docks.
///
/// Do not go back to "is the tile's centre inside the widget": a detached tile is ~248px tall while
/// the Mini widget is only ~48-150px, so the tile's centre sits ~124px below its own top edge and
/// had to be aimed at a 48px-tall strip — while the user's cursor is over the grip at the tile's
/// left edge, nowhere near that centre. Docking from Mini was luck. Measuring against the smaller
/// area makes one formula fit both modes: in Mini the widget is smaller, so covering it is enough;
/// in Full the tile is smaller, so it must genuinely be dragged inside and a tile merely parked
/// against the widget's edge stays put.
const DOCK_OVERLAP_RATIO: f64 = 0.35;
/// WebView2 builds one environment per user-data folder, and every webview sharing that folder must
/// request the same browser arguments — mismatch one window and its creation silently fails (Codex
/// then reads "failed to receive message from webview" and Claude freezes on its cached value).
/// Hence a single constant, and it must stay byte-identical to `additionalBrowserArgs` on every
/// window in tauri.conf.json. Changing it for one window only is not possible.
///
/// The throttle-defeating flags cost real idle CPU — the hidden claude.ai/chatgpt.com pages account
/// for ~30% of a core (measured: turning AI usage off drops the app from ~40% to ~3.5%). Dropping
/// them was tried and measured no better, apparently because a Tauri-hidden window is still visible
/// to Chromium, so it never backgrounds the renderer anyway. They are kept because the widget is the
/// single refresh engine and its timers must not throttle while it sits in the tray. The explicit
/// WebView2 low-memory target below can trim hidden renderers, but reclaiming all provider cost still
/// requires destroying their windows — see `suspend_provider_windows`.
const WEBVIEW_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

const DETACHED_HIDE_PREFIX: &str = "detached_hide:";
const DETACHED_DOCK_EVENT: &str = "usageview-dock-tile";
const DETACHED_POSITION_EVENT: &str = "usageview-detached-position";
const DETACHED_HIDE_EVENT: &str = "usageview-hide-tile";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WindowPosition {
  x: f64,
  y: f64,
}

struct CurrentWidgetMode(Mutex<String>);
struct WindowPositionStoreLock(Mutex<()>);
struct ProviderEnabledState(Mutex<HashMap<String, (bool, u64)>>);
struct RemovedProviderState(Mutex<HashSet<String>>);

#[cfg(windows)]
fn set_webview_memory_target(window: &tauri::WebviewWindow, low: bool) -> Result<(), String> {
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
  };
  use windows::core::Interface;

  let target = if low {
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
  } else {
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
  };
  window
    .with_webview(move |webview| {
      // This is only a memory hint. Never wait for the WebView event-loop callback: a newly
      // created or hidden controller may not dispatch it immediately, which must not block open.
      let _ = unsafe {
        webview
          .controller()
          .CoreWebView2()
          .and_then(|core| core.cast::<ICoreWebView2_19>())
          .and_then(|core| core.SetMemoryUsageTargetLevel(target))
      };
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn set_webview_memory_target(_window: &tauri::WebviewWindow, _low: bool) -> Result<(), String> {
  Ok(())
}

/// Labels of detached tiles we are closing from code. `on_window_event` reads any *unmarked*
/// tile close as the user hiding the tile, so docking and master toggles must mark first —
/// otherwise they would silently turn the tile's Show setting off.
struct ProgrammaticCloses(Mutex<HashSet<String>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DetachedTileEvent {
  tile_id: String,
  x: f64,
  y: f64,
  screen_y: f64,
}

/// Live hardware readings. Purely additive: nothing here touches usage extraction.
/// The `sysinfo::System` is kept alive so CPU% has two samples to diff between reads.
/// NVML is optional — if the NVIDIA driver/lib is missing, GPU fields stay `None`.
struct SystemMonitorState {
  sys: Mutex<sysinfo::System>,
  nvml: Option<nvml_wrapper::Nvml>,
  // Last good NVIDIA (dGPU) readings. On Optimus laptops the dGPU sleeps when idle and NVML
  // queries then fail; reusing the last value keeps the tile from flickering to N/A.
  dgpu_last: Mutex<(Option<f32>, Option<f32>)>, // (percent, temp)
  #[cfg(windows)]
  igpu: Mutex<gpu_perf::IgpuMonitor>,
  #[cfg(windows)]
  asus_acpi: Mutex<asus_acpi::AsusAcpiMonitor>,
  sensor_task_cache: Mutex<Option<(bool, std::time::Instant)>>,
}

#[derive(Clone, Serialize)]
struct SystemMetrics {
  ram_percent: f32,
  ram_used_mb: u64,
  ram_total_mb: u64,
  ram_free_mb: u64,
  swap_used_mb: u64,
  swap_total_mb: u64,
  cpu_percent: f32,
  cpu_temp_c: Option<f32>,
  cpu_temp_cores: Vec<f32>,
  cpu_fan_rpm: Option<u32>,
  cpu_name: String,
  cpu_physical_cores: Option<u32>,
  cpu_logical_cores: u32,
  cpu_freq_mhz: u32,
  gpu_percent: Option<f32>,
  gpu_temp_c: Option<f32>,
  gpu_name: Option<String>,
  gpu_vram_used_mb: Option<u64>,
  gpu_vram_total_mb: Option<u64>,
  gpu_power_w: Option<f32>,
  gpu_clock_mhz: Option<u32>,
  gpu_fan_rpm: Option<u32>,
  igpu_percent: Option<f32>,
  igpu_name: Option<String>,
}

/// Sensor readings written by the elevated `uvsensord` sidecar (LibreHardwareMonitor) to
/// `%LOCALAPPDATA%\UsageView\sensors.json`. Absent/stale file → all None (tile shows N/A).
#[derive(Deserialize)]
struct SidecarSensors {
  ts: i64,
  cpu_temp_c: Option<f32>,
  #[serde(default)]
  cpu_temp_cores: Vec<f32>,
  cpu_fan_rpm: Option<f32>,
  gpu_fan_rpm: Option<f32>,
}

fn sidecar_json_path() -> Option<PathBuf> {
  let base = std::env::var_os("LOCALAPPDATA")?;
  Some(PathBuf::from(base).join("UsageView").join("sensors.json"))
}

/// Read the sidecar sensor file if it exists and is fresh (written within the last ~8s).
fn read_sidecar_sensors() -> Option<SidecarSensors> {
  let path = sidecar_json_path()?;
  let text = fs::read_to_string(&path).ok()?;
  let data: SidecarSensors = serde_json::from_str(&text).ok()?;
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0);
  if now.saturating_sub(data.ts) > 8 {
    return None; // stale — the sidecar isn't running
  }
  Some(data)
}

#[tauri::command]
async fn open_provider_window(app: tauri::AppHandle, provider: String, url: String, display_label: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label, Some(&display_label))?;
  window.set_title(&format!("{} Usage - UsageView", display_label.trim())).map_err(|error| error.to_string())?;
  let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
  window.navigate(target).map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())?;
  let _ = set_webview_memory_target(&window, false);
  Ok(())
}

#[tauri::command]
fn set_provider_window_title(app: tauri::AppHandle, provider: String, display_label: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  if let Some(window) = app.get_webview_window(&label) {
    window.set_title(&format!("{} Usage - UsageView", display_label.trim())).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[tauri::command]
fn close_provider_window(app: tauri::AppHandle, provider: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  if let Some(window) = app.get_webview_window(&label) {
    window.hide().map_err(|error| error.to_string())?;
    if !provider_enabled(&app, &label) {
      window.destroy().map_err(|error| error.to_string())?;
      let _ = app.emit_to("widget", PROVIDER_RELEASED_EVENT, label);
    } else {
      let _ = set_webview_memory_target(&window, true);
    }
  }
  Ok(())
}

fn provider_enabled(app: &tauri::AppHandle, label: &str) -> bool {
  app
    .try_state::<ProviderEnabledState>()
    .and_then(|state| state.0.lock().ok().and_then(|values| values.get(label).map(|value| value.0)))
    .unwrap_or(true)
}

/// Outcome of a release request. The caller must be able to tell these apart:
/// - `visible`: a login page is up; only the user's Hide/close may finish the release.
/// - `superseded`: a newer ON/OFF owns this provider, so this command must stay silent.
/// - `absent`: no window to destroy *yet*. At startup the predeclared provider windows are built by
///   Tauri after the widget's JS runs, so an OFF that lands first finds nothing and would otherwise
///   report success while Tauri quietly brings the window up behind it — leaving a disabled
///   provider's WebView alive for the whole session.
const RELEASE_RELEASED: &str = "released";
const RELEASE_VISIBLE: &str = "visible";
const RELEASE_SUPERSEDED: &str = "superseded";
const RELEASE_ABSENT: &str = "absent";

fn release_provider_window(app: &tauri::AppHandle, label: &str) -> Result<&'static str, String> {
  let Some(window) = app.get_webview_window(label) else {
    return Ok(RELEASE_ABSENT);
  };
  // Never tear down a visible login page. The next explicit Hide/close will finish the release.
  // If the visibility query itself fails, assume visible: destroying a login window the user is
  // typing into is unrecoverable, while deferring the release only postpones freeing memory.
  if window.is_visible().unwrap_or(true) {
    return Ok(RELEASE_VISIBLE);
  }
  window.destroy().map_err(|error| error.to_string())?;
  Ok(RELEASE_RELEASED)
}

#[tauri::command]
fn set_provider_enabled(app: tauri::AppHandle, provider: String, enabled: bool, generation: u64) -> Result<bool, String> {
  let label = provider_label(&provider)?;
  let state = app.state::<ProviderEnabledState>();
  let mut values = state.0.lock().map_err(|error| error.to_string())?;
  if values.get(&label).is_some_and(|value| value.1 > generation) {
    return Ok(false);
  }
  values.insert(label, (enabled, generation));
  Ok(true)
}

#[tauri::command]
fn release_provider_window_command(app: tauri::AppHandle, provider: String, generation: u64) -> Result<&'static str, String> {
  let label = provider_label(&provider)?;
  let state = app.state::<ProviderEnabledState>();
  let current = state
    .0
    .lock()
    .map_err(|error| error.to_string())?
    .get(&label)
    .copied();
  if current != Some((false, generation)) {
    return Ok(RELEASE_SUPERSEDED);
  }
  let outcome = release_provider_window(&app, &label)?;
  if outcome == RELEASE_RELEASED {
    let _ = app.emit_to("widget", PROVIDER_RELEASED_EVENT, label);
  }
  Ok(outcome)
}

/// Tear an account down for good: destroy its window and delete its on-disk login profile so a later
/// re-add of the same kind starts signed out. Any account can be removed — there are no permanent
/// built-ins.
#[tauri::command]
fn remove_provider_account(app: tauri::AppHandle, provider: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  {
    let state = app.state::<RemovedProviderState>();
    state.0.lock().map_err(|error| error.to_string())?.insert(label.clone());
  }
  if let Some(window) = app.get_webview_window(&label) {
    if let Err(error) = window.destroy() {
      if let Ok(mut removed) = app.state::<RemovedProviderState>().0.lock() {
        removed.remove(&label);
      }
      return Err(error.to_string());
    }
  }
  if let Ok(base) = app.path().app_data_dir() {
    let profile = base.join("profiles").join(&label);
    // WebView2 keeps the profile folder locked for a short moment after destroy(), so a single delete
    // here usually fails. Retry off-thread until the lock clears — the command itself stays instant.
    std::thread::spawn(move || {
      for attempt in 0..20 {
        if profile.exists() && fs::remove_dir_all(&profile).is_ok() {
          return;
        }
        std::thread::sleep(Duration::from_millis(250 * (attempt + 1).min(4)));
      }
    });
  }
  // No PROVIDER_RELEASED_EVENT here — that fires the widget's "stopped" toast, which must stay
  // distinct from removal. The Settings window emits its own "removed" toast event instead.
  Ok(())
}

/// Delete any provider profile folder that no longer belongs to a current account. Called at startup
/// with the live account ids, this reclaims disk and, more importantly, wipes the login of an account
/// whose delete-time cleanup lost the race with WebView2's file lock.
#[tauri::command]
fn prune_provider_profiles(app: tauri::AppHandle, keep: Vec<String>) -> Result<(), String> {
  let keep_labels: HashSet<String> = keep.iter().filter_map(|id| provider_label(id).ok()).collect();
  if let Ok(base) = app.path().app_data_dir() {
    if let Ok(entries) = fs::read_dir(base.join("profiles")) {
      for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("provider_") && !keep_labels.contains(&name) {
          let _ = fs::remove_dir_all(entry.path());
        }
      }
    }
  }
  Ok(())
}

#[tauri::command]
fn set_webview_memory_target_command(app: tauri::AppHandle, label: String, low: bool) -> Result<(), String> {
  // Accept the settings window or any dynamic provider window (provider_*), not a fixed set.
  if label != "settings" && !label.starts_with("provider_") {
    return Err("Invalid WebView label".to_string());
  }
  if let Some(window) = app.get_webview_window(&label) {
    if low && window.is_visible().unwrap_or(false) {
      return Ok(());
    }
    let _ = set_webview_memory_target(&window, low);
  }
  Ok(())
}

#[tauri::command]
fn suspend_provider_windows(app: tauri::AppHandle) -> Result<(), String> {
  // Accounts are dynamic now, so destroy every provider window rather than a fixed three.
  for (label, window) in app.webview_windows() {
    if label.starts_with("provider_") {
      window.destroy().map_err(|error| error.to_string())?;
    }
  }
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
fn open_widget_window(app: tauri::AppHandle) -> Result<(), String> {
  show_widget_window(&app)
}

#[tauri::command]
fn close_widget_window(app: tauri::AppHandle) -> Result<(), String> {
  hide_widget_window(&app)
}

#[tauri::command]
fn get_widget_visibility(app: tauri::AppHandle) -> Result<bool, String> {
  widget_window_visible(&app)
}

#[tauri::command]
fn toggle_widget_window(app: tauri::AppHandle) -> Result<bool, String> {
  if widget_window_visible(&app)? {
    hide_widget_window(&app)?;
    Ok(false)
  } else {
    show_widget_window(&app)?;
    Ok(true)
  }
}

#[tauri::command]
fn load_window_geometry(app: tauri::AppHandle) -> Result<HashMap<String, WindowPosition>, String> {
  let state = app.state::<WindowPositionStoreLock>();
  let _guard = state.0.lock().map_err(|error| error.to_string())?;
  read_window_geometry_store(&app)
}

#[tauri::command]
fn save_window_geometry(app: tauri::AppHandle, mode: String, position: WindowPosition) -> Result<(), String> {
  if (mode != "widget" && mode != "mini") || !valid_window_position(&position) {
    return Err("Invalid window position".to_string());
  }
  let state = app.state::<WindowPositionStoreLock>();
  let _guard = state.0.lock().map_err(|error| error.to_string())?;
  let mut store = read_window_geometry_store(&app)?;
  store.insert(mode, position);
  write_window_geometry_store(&app, &store)
}

#[tauri::command]
fn reset_window_geometry(app: tauri::AppHandle) -> Result<(), String> {
  let state = app.state::<WindowPositionStoreLock>();
  let _guard = state.0.lock().map_err(|error| error.to_string())?;
  let path = geometry_store_path(&app)?;
  for path in [
    path.clone(),
    path.with_file_name("window-position-v3.json.tmp"),
    path.with_file_name("window-position-v3.json.bak"),
    legacy_geometry_store_path(&app)?,
  ] {
    match fs::remove_file(path) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(error.to_string()),
    }
  }
  Ok(())
}

#[tauri::command]
fn set_widget_mode(state: tauri::State<CurrentWidgetMode>, mode: String) -> Result<(), String> {
  if mode == "widget" || mode == "mini" {
    *state.0.lock().map_err(|error| error.to_string())? = mode;
  }
  Ok(())
}

#[tauri::command]
fn show_widget_context_menu(
  app: tauri::AppHandle,
  window: tauri::WebviewWindow,
  mode: String,
  pinned: bool,
  x: f64,
  y: f64,
) -> Result<(), String> {
  if mode != "widget" && mode != "mini" {
    return Err(format!("Unknown widget mode: {}", mode));
  }
  // View mode, pin and refresh moved into Settings; the right-click menu is now just Settings + Close.
  let _ = pinned;

  let settings = MenuItem::with_id(&app, CONTEXT_SETTINGS, "Settings", true, None::<&str>).map_err(|error| error.to_string())?;
  let close = MenuItem::with_id(&app, CONTEXT_CLOSE, "Close", true, None::<&str>).map_err(|error| error.to_string())?;
  let menu = Menu::with_items(
    &app,
    &[&settings, &close],
  ).map_err(|error| error.to_string())?;

  window
    .popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))
    .map_err(|error| error.to_string())
}

fn is_account_id(id: &str) -> bool {
  !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn detached_tile_parts(tile_id: &str) -> Result<(&str, &str), String> {
  let (kind, id) = tile_id.split_once(':').ok_or_else(|| "Invalid tile id".to_string())?;
  let valid = match kind {
    // Provider tiles carry a dynamic account id, so validate its shape rather than a fixed set.
    "provider" => is_account_id(id),
    "monitor" => matches!(id, "cpu" | "ram" | "gpu" | "igpu" | "cputemp" | "gputemp"),
    _ => false,
  };
  if valid { Ok((kind, id)) } else { Err("Invalid tile id".to_string()) }
}

fn detached_tile_label(tile_id: &str) -> Result<String, String> {
  let (kind, id) = detached_tile_parts(tile_id)?;
  Ok(format!("tile_{}_{}", kind, id.replace('-', "_")))
}

fn detached_tile_title(tile_id: &str, display_label: Option<&str>) -> Result<String, String> {
  let (kind, id) = detached_tile_parts(tile_id)?;
  if kind == "provider" {
    return Ok(display_label.filter(|label| !label.trim().is_empty()).unwrap_or(id).to_string());
  }
  Ok(match id {
    "cpu" => "CPU usage",
    "ram" => "RAM",
    "gpu" => "GPU usage",
    "igpu" => "iGPU usage",
    "cputemp" => "CPU temperature",
    "gputemp" => "GPU temperature",
    _ => id,
  }.to_string())
}

/// Reverse of detached_tile_label: `tile_<kind>_<rest>` → `<kind>:<rest with _→->`. Rebuilt rather
/// than looked up in a fixed list so a dynamic account's tile resolves too. Ids/kinds never contain a
/// literal `_` (account ids are [a-z0-9-]), so turning `_` back into `-` is exact.
fn tile_id_for_label(label: &str) -> Option<String> {
  let body = label.strip_prefix("tile_")?;
  let (kind, rest) = body.split_once('_')?;
  let tile_id = format!("{}:{}", kind, rest.replace('_', "-"));
  if detached_tile_parts(&tile_id).is_ok() { Some(tile_id) } else { None }
}

fn mark_programmatic_close(app: &tauri::AppHandle, label: &str) {
  if let Some(state) = app.try_state::<ProgrammaticCloses>() {
    if let Ok(mut labels) = state.0.lock() {
      labels.insert(label.to_string());
    }
  }
}

fn unmark_programmatic_close(app: &tauri::AppHandle, label: &str) -> bool {
  app
    .try_state::<ProgrammaticCloses>()
    .and_then(|state| state.0.lock().ok().map(|mut labels| labels.remove(label)))
    .unwrap_or(false)
}

/// Close a detached tile from code. Always go through this instead of `window.close()`, so the
/// close is marked and `on_window_event` does not mistake it for the user hiding the tile.
fn close_tile_window(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
  let Some(window) = app.get_webview_window(label) else { return Ok(()) };
  mark_programmatic_close(app, label);
  if let Err(error) = window.close() {
    unmark_programmatic_close(app, label);
    return Err(error.to_string());
  }
  Ok(())
}

#[cfg(windows)]
fn current_cursor_position() -> Option<(f64, f64)> {
  use windows::Win32::Foundation::POINT;
  use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
  let mut point = POINT::default();
  unsafe { GetCursorPos(&mut point).ok()?; }
  Some((point.x as f64, point.y as f64))
}

#[cfg(windows)]
fn left_mouse_button_down() -> bool {
  use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
  unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 }
}

#[cfg(not(windows))]
fn left_mouse_button_down() -> bool { false }

#[cfg(not(windows))]
fn current_cursor_position() -> Option<(f64, f64)> { None }

#[cfg(windows)]
fn clamp_detached_to_work_area(position: &WindowPosition, width: u32, height: u32) -> WindowPosition {
  use windows::Win32::Foundation::RECT;
  use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST};

  let left = position.x.round() as i32;
  let top = position.y.round() as i32;
  let rect = RECT { left, top, right: left.saturating_add(width as i32), bottom: top.saturating_add(height as i32) };
  let monitor = unsafe { MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST) };
  let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
  if unsafe { GetMonitorInfoW(monitor, &mut info).as_bool() } {
    let max_x = info.rcWork.right.saturating_sub(width as i32);
    let max_y = info.rcWork.bottom.saturating_sub(height as i32);
    return WindowPosition {
      x: position.x.round().clamp(info.rcWork.left as f64, max_x.max(info.rcWork.left) as f64),
      y: position.y.round().clamp(info.rcWork.top as f64, max_y.max(info.rcWork.top) as f64),
    };
  }
  position.clone()
}

#[cfg(not(windows))]
fn clamp_detached_to_work_area(position: &WindowPosition, _width: u32, _height: u32) -> WindowPosition {
  position.clone()
}

fn place_detached_tile(window: &tauri::WebviewWindow, position: &WindowPosition) -> Result<WindowPosition, String> {
  let size = window.outer_size().map_err(|error| error.to_string())?;
  let clamped = clamp_detached_to_work_area(position, size.width, size.height);
  window
    .set_position(tauri::PhysicalPosition::new(clamped.x.round() as i32, clamped.y.round() as i32))
    .map_err(|error| error.to_string())?;
  Ok(clamped)
}

#[tauri::command]
fn open_detached_tile(
  app: tauri::AppHandle,
  tile_id: String,
  position: Option<WindowPosition>,
  pinned: bool,
  scale: f64,
  display_label: Option<String>,
) -> Result<WindowPosition, String> {
  let label = detached_tile_label(&tile_id)?;
  let title = detached_tile_title(&tile_id, display_label.as_deref())?;
  let is_cursor_position = position.is_none();
  let requested = position
    .as_ref()
    .map(|position| (position.x, position.y))
    .or_else(current_cursor_position)
    .unwrap_or((80.0, 80.0));
  let target = WindowPosition { x: requested.0 - if is_cursor_position { 196.0 } else { 0.0 }, y: requested.1 - if is_cursor_position { 100.0 } else { 0.0 } };
  let scale = scale.clamp(0.5, 1.5);

  if let Some(window) = app.get_webview_window(&label) {
    window.set_title(&format!("{title} — UsageView")).map_err(|error| error.to_string())?;
    window.set_always_on_top(pinned).map_err(|error| error.to_string())?;
    window.set_size(tauri::LogicalSize::new(392.0 * scale, 220.0 * scale)).map_err(|error| error.to_string())?;
    let target = place_detached_tile(&window, &target)?;
    window.show().map_err(|error| error.to_string())?;
    return Ok(target);
  }

  let create_target = target.clone();
  tauri::async_runtime::spawn(async move {
    let result = (|| -> Result<(), String> {
      let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("{title} — UsageView"))
        .inner_size(392.0 * scale, 220.0 * scale)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(pinned)
        .skip_taskbar(true)
        .resizable(false)
        .zoom_hotkeys_enabled(false)
        .additional_browser_args(WEBVIEW_BROWSER_ARGS)
        .build()
        .map_err(|error| error.to_string())?;
      let placed = place_detached_tile(&window, &create_target)?;
      let size = window.outer_size().map_err(|error| error.to_string())?;
      let payload = DetachedTileEvent {
        tile_id,
        x: placed.x,
        y: placed.y,
        screen_y: placed.y + size.height as f64 / 2.0,
      };
      app.emit_to("widget", DETACHED_POSITION_EVENT, payload).map_err(|error| error.to_string())?;
      Ok(())
    })();
    if let Err(error) = result { eprintln!("Could not create detached tile: {error}"); }
  });
  Ok(target)
}

#[tauri::command]
fn close_detached_tile(app: tauri::AppHandle, tile_id: String) -> Result<(), String> {
  let label = detached_tile_label(&tile_id)?;
  close_tile_window(&app, &label)
}

#[tauri::command]
fn close_all_detached_tiles(app: tauri::AppHandle) -> Result<(), String> {
  for (label, _) in app.webview_windows() {
    if label.starts_with("tile_") {
      let _ = close_tile_window(&app, &label);
    }
  }
  Ok(())
}

#[tauri::command]
fn set_detached_tiles_pinned(app: tauri::AppHandle, pinned: bool) -> Result<(), String> {
  for (_, window) in app.webview_windows() {
    if window.label().starts_with("tile_") {
      let _ = window.set_always_on_top(pinned);
    }
  }
  Ok(())
}

#[tauri::command]
fn show_detached_tile_context_menu(
  app: tauri::AppHandle,
  window: tauri::WebviewWindow,
  tile_id: String,
  display_label: Option<String>,
  x: f64,
  y: f64,
) -> Result<(), String> {
  detached_tile_parts(&tile_id)?;
  let hide = MenuItem::with_id(
    &app,
    format!("{DETACHED_HIDE_PREFIX}{tile_id}"),
    format!("Hide {}", detached_tile_title(&tile_id, display_label.as_deref())?),
    true,
    None::<&str>,
  ).map_err(|error| error.to_string())?;
  let menu = Menu::with_items(&app, &[&hide]).map_err(|error| error.to_string())?;
  window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y)).map_err(|error| error.to_string())
}

#[tauri::command]
fn finish_detached_tile_drag(app: tauri::AppHandle, tile_id: String) -> Result<Option<bool>, String> {
  if left_mouse_button_down() { return Ok(None); }
  let label = detached_tile_label(&tile_id)?;
  let tile = app.get_webview_window(&label).ok_or_else(|| "Detached tile window is missing".to_string())?;
  let tile_position = tile.outer_position().map_err(|error| error.to_string())?;
  let tile_size = tile.outer_size().map_err(|error| error.to_string())?;
  let mut x = tile_position.x as f64;
  let mut y = tile_position.y as f64;
  let mut center_y = y + tile_size.height as f64 / 2.0;
  let mut docked = false;

  if let Some(widget) = app.get_webview_window("widget") {
    if widget.is_visible().unwrap_or(false) {
      if let (Ok(widget_position), Ok(widget_size)) = (widget.outer_position(), widget.outer_size()) {
        let tile_w = tile_size.width as f64;
        let tile_h = tile_size.height as f64;
        let widget_w = widget_size.width as f64;
        let widget_h = widget_size.height as f64;
        let overlap_w = ((x + tile_w).min(widget_position.x as f64 + widget_w) - x.max(widget_position.x as f64)).max(0.0);
        let overlap_h = ((y + tile_h).min(widget_position.y as f64 + widget_h) - y.max(widget_position.y as f64)).max(0.0);
        let overlap = overlap_w * overlap_h;
        let smaller_area = (tile_w * tile_h).min(widget_w * widget_h);
        docked = smaller_area > 0.0 && overlap >= DOCK_OVERLAP_RATIO * smaller_area;
      }
    }
  }

  if docked {
    let payload = DetachedTileEvent { tile_id, x, y, screen_y: center_y };
    app.emit_to("widget", DETACHED_DOCK_EVENT, payload).map_err(|error| error.to_string())?;
    close_tile_window(&app, &label)?;
  } else {
    let placed = place_detached_tile(&tile, &WindowPosition { x, y })?;
    x = placed.x;
    y = placed.y;
    center_y = y + tile_size.height as f64 / 2.0;
    let payload = DetachedTileEvent { tile_id, x, y, screen_y: center_y };
    app.emit_to("widget", DETACHED_POSITION_EVENT, payload).map_err(|error| error.to_string())?;
  }
  Ok(Some(docked))
}

fn geometry_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("window-position-v3.json"))
}

fn legacy_geometry_store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|error| error.to_string())?.join("window-geometry-v2.json"))
}

fn valid_window_position(position: &WindowPosition) -> bool {
  position.x.is_finite()
    && position.y.is_finite()
    && position.x.abs() <= 10_000_000.0
    && position.y.abs() <= 10_000_000.0
}

fn read_window_geometry_store(app: &tauri::AppHandle) -> Result<HashMap<String, WindowPosition>, String> {
  let path = geometry_store_path(app)?;
  for source in [
    path.clone(),
    path.with_file_name("window-position-v3.json.bak"),
    legacy_geometry_store_path(app)?,
  ] {
    if !source.exists() { continue; }
    let text = fs::read_to_string(source).map_err(|error| error.to_string())?;
    if let Ok(parsed) = serde_json::from_str::<HashMap<String, WindowPosition>>(&text) {
      let clean: HashMap<_, _> = parsed.into_iter().filter(|(_, position)| valid_window_position(position)).collect();
      if !clean.is_empty() { return Ok(clean); }
    }
  }
  Ok(HashMap::new())
}

fn write_window_geometry_store(app: &tauri::AppHandle, store: &HashMap<String, WindowPosition>) -> Result<(), String> {
  let path = geometry_store_path(app)?;
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let clean: HashMap<_, _> = store
    .iter()
    .filter(|(_, position)| valid_window_position(position))
    .map(|(mode, position)| (mode.clone(), position))
    .collect();
  let text = serde_json::to_string_pretty(&clean).map_err(|error| error.to_string())?;
  let temp_path = path.with_file_name("window-position-v3.json.tmp");
  let backup_path = path.with_file_name("window-position-v3.json.bak");
  fs::write(&temp_path, text).map_err(|error| error.to_string())?;
  let moved_primary = path.exists();
  if moved_primary {
    if backup_path.exists() { fs::remove_file(&backup_path).map_err(|error| error.to_string())?; }
    fs::rename(&path, &backup_path).map_err(|error| error.to_string())?;
  }
  if let Err(error) = fs::rename(&temp_path, &path) {
    if moved_primary && backup_path.exists() { let _ = fs::rename(&backup_path, &path); }
    return Err(error.to_string());
  }
  let _ = fs::remove_file(backup_path);
  let _ = fs::remove_file(legacy_geometry_store_path(app)?);
  Ok(())
}

fn save_widget_geometry(app: &tauri::AppHandle, mode: &str) {
  let Some(window) = app.get_webview_window("widget") else { return; };
  let Ok(position) = window.outer_position() else { return; };
  let position = WindowPosition {
    x: position.x as f64,
    y: position.y as f64,
  };
  let _ = save_window_geometry(app.clone(), mode.to_string(), position);
}

fn save_current_widget_geometry(app: &tauri::AppHandle) {
  let mode = app
    .state::<CurrentWidgetMode>()
    .0
    .lock()
    .map(|mode| mode.clone())
    .unwrap_or_else(|_| "widget".to_string());
  save_widget_geometry(app, &mode);
}

fn widget_window_visible(app: &tauri::AppHandle) -> Result<bool, String> {
  match app.get_webview_window("widget") {
    Some(window) => window.is_visible().map_err(|error| error.to_string()),
    None => Ok(false),
  }
}

fn emit_widget_visibility(app: &tauri::AppHandle, visible: bool) {
  let _ = app.emit_to("settings", WIDGET_VISIBILITY_EVENT, visible);
}

fn show_widget_window(app: &tauri::AppHandle) -> Result<(), String> {
  let window = match app.get_webview_window("widget") {
    Some(window) => window,
    None => WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("index.html".into()))
      .title("UsageView Widget")
      .inner_size(392.0, 500.0)
      .decorations(false)
      .transparent(true)
      .always_on_top(true)
      .skip_taskbar(true)
      .resizable(false)
      .zoom_hotkeys_enabled(false)
      .additional_browser_args(WEBVIEW_BROWSER_ARGS)
      .build()
      .map_err(|error| error.to_string())?,
  };
  window.set_resizable(false).map_err(|error| error.to_string())?;
  window.unminimize().map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  emit_widget_visibility(app, true);
  window.set_focus().map_err(|error| error.to_string())?;
  Ok(())
}

fn hide_widget_window(app: &tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("widget") {
    save_current_widget_geometry(app);
    window.hide().map_err(|error| error.to_string())?;
  }
  emit_widget_visibility(app, false);
  Ok(())
}

// Gear button toggles: hide when already visible, otherwise show.
#[tauri::command]
fn toggle_settings_window(app: tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("settings") {
    if window.is_visible().unwrap_or(false) {
      window.hide().map_err(|error| error.to_string())?;
      let _ = set_webview_memory_target(&window, true);
      return Ok(());
    }
  }
  show_settings_window(&app)
}

fn show_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
  // Rebuild the window if it was destroyed (e.g. the user hit the native close button); state lives in
  // localStorage so a fresh window comes back identical.
  //
  // This is a fallback, not the normal path: `settings` is declared in tauri.conf.json. Dropping it
  // from there to save its renderer was tried and the rebuilt window came up blank and transparent —
  // the webview never initialised, `outer_size()` below kept failing, so it never even moved next to
  // the widget. Keep it pre-declared.
  let window = match app.get_webview_window("settings") {
    Some(window) => window,
    None => WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
      .title("UsageView - Settings")
      .inner_size(460.0, 720.0)
      .min_inner_size(430.0, 520.0)
      .resizable(false)
      .zoom_hotkeys_enabled(false)
      .decorations(false)
      .transparent(true)
      .shadow(false)
      .always_on_top(true)
      .skip_taskbar(true)
      .additional_browser_args(WEBVIEW_BROWSER_ARGS)
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
      let mut x = if left >= 0 { left } else { wpos.x + wsize.width as i32 + gap };
      let mut y = wpos.y;
      // Clamp into the monitor work area (taskbar excluded) so the taller Settings window is never cut
      // off at the bottom when the widget sits near the screen edge — it slides up to stay fully visible.
      if let Ok(Some(monitor)) = widget.current_monitor() {
        let wa = monitor.work_area();
        let (wx, wy) = (wa.position.x, wa.position.y);
        let (ww, wh) = (wa.size.width as i32, wa.size.height as i32);
        let max_x = (wx + ww - ssize.width as i32).max(wx);
        let max_y = (wy + wh - ssize.height as i32).max(wy);
        x = x.clamp(wx, max_x);
        y = y.clamp(wy, max_y);
      }
      let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
  }

  window.unminimize().map_err(|error| error.to_string())?;
  window.show().map_err(|error| error.to_string())?;
  // Re-assert topmost every time the window is shown. A hidden→shown topmost window can lose its
  // z-position on Windows, and another app grabbing the foreground can bury it; toggling the flag
  // forces a HWND_TOPMOST reposition so Settings reliably rises above the widget and other windows.
  let _ = window.set_always_on_top(false);
  let _ = window.set_always_on_top(true);
  window.set_focus().map_err(|error| error.to_string())?;
  let _ = set_webview_memory_target(&window, false);
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
      TRAY_QUIT => {
        save_current_widget_geometry(app);
        app.exit(0);
      }
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

// Async so clearing a heavy profile (claude.ai carries a lot of storage) runs off the UI thread —
// a sync command froze the whole app while WebView2 cleared. Every account is isolated now, so a
// logout only signs out that one account.
#[tauri::command]
async fn logout_provider(app: tauri::AppHandle, provider: String, url: String, display_label: String) -> Result<(), String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label, Some(&display_label))?;
  // Show first so the window is responsive while the clear runs, then wipe the session and reload.
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())?;
  window.clear_all_browsing_data().map_err(|error| error.to_string())?;
  let target = tauri::Url::parse(&url).map_err(|error| error.to_string())?;
  window.navigate(target).map_err(|error| error.to_string())?;
  Ok(())
}

#[tauri::command]
async fn extract_provider(app: tauri::AppHandle, provider: String, kind: String, url: String, display_label: String) -> Result<String, String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label, Some(&display_label))?;
  let expected_host = host_for_kind(&kind)?;

  // Any provider becomes a freshly-created dynamic window after Show OFF destroys it. Do not proceed
  // until the controller responds; otherwise the first read leaks "failed to receive message from
  // webview" into the snapshot and stays broken until a manual refresh.
  let mut webview_ready = false;
  for _ in 0..40 {
    if window.url().is_ok() {
      webview_ready = true;
      break;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  if !webview_ready {
    return Err(format!("{} WebView is still starting", provider));
  }

  // Silent background refresh: if the window is hidden and not already on the provider site
  // (e.g. right after launch it sits on the local wrapper), navigate it there without showing
  // it. The login cookie persists, so the usage page loads logged in. We never navigate a
  // visible window — the user may be mid-login on it.
  let visible = window.is_visible().unwrap_or(false);
  let current_url = window.url().ok();
  let on_target = current_url
    .as_ref()
    .map(|current| is_usable_provider_page(&kind, current, expected_host, &url))
    .unwrap_or(false);
  // Never navigate a visible window: the user may be mid-login (e.g. on a 2FA code screen) and a
  // navigation here would throw them back to the sign-in page. Only a hidden, off-target window is
  // safe to steer onto the usage page — this holds for Claude and Codex alike.
  if !visible && !on_target {
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
  let script = extract_script(&provider, &kind, &marker)?;
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
  let mut last_webview_error: Option<String> = None;
  let max_attempts = if kind == "claude" { 48 } else { 24 };
  for attempt in 0..max_attempts {
    if let Ok((status, encoded)) = event_rx.try_recv() {
      last_payload = Some(encoded.clone());
      if status == "ok" || status == "not_logged_in" {
        result = Some(encoded);
        break;
      }
    }
    let current = match window.url() {
      Ok(current) => current,
      Err(error) => {
        last_webview_error = Some(error.to_string());
        std::thread::sleep(Duration::from_millis(250));
        continue;
      }
    };
    // Eval as soon as we are on the provider's host. Claude now reads usage from a same-origin JSON
    // API (works on any claude.ai page), so we must NOT gate on the /settings path: the SPA often
    // routes away from it, which previously blocked the eval entirely and starved the API fetch.
    let here = current.host_str().unwrap_or_default().contains(expected_host);
    if here {
      if attempt % 4 == 0 {
        if let Err(error) = window.eval(&script) {
          // WebView2 can accept url() before the document is ready to evaluate scripts. Treat this
          // as transient during the polling window; a later attempt can read the same loaded page.
          last_webview_error = Some(error.to_string());
          std::thread::sleep(Duration::from_millis(150));
          continue;
        }
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
    match last_webview_error {
      Some(error) => format!("Could not read {} usage: {}", provider, error),
      None => format!("Could not read {} usage. Open Settings and Login if your session expired.", provider),
    }
  })
}

/// One-off discovery: find the JSON endpoint the provider's usage page actually calls, so we
/// can later read usage directly from that API instead of scraping the rendered DOM.
#[tauri::command]
async fn discover_provider_api(app: tauri::AppHandle, provider: String, kind: String, url: String, display_label: String) -> Result<String, String> {
  let label = provider_label(&provider)?;
  let window = get_or_create_provider_window(&app, &label, Some(&display_label))?;
  let expected_host = host_for_kind(&kind)?;

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

/// Read live hardware metrics. Never returns `Err` and never panics: any source that
/// fails degrades to `None` (or 0) so the widget just shows "N/A" for that tile and the
/// rest of the app is unaffected. CPU temperature is intentionally `None` in Phase 1.
#[tauri::command]
fn read_system_metrics(state: tauri::State<SystemMonitorState>, kinds: Vec<String>) -> SystemMetrics {
  // Only read the sensors whose tiles are actually on screen. Every source here has a real cost
  // (NVML issues 7 device queries, the iGPU counter enumerates every GPU engine, the sidecar hits
  // the disk), and this runs as often as once a second — paying for all of it to show one tile was
  // most of the polling cost.
  let wants = |kind: &str| kinds.iter().any(|k| k == kind);
  let want_cpu = wants("cpu");
  let want_ram = wants("ram");
  let want_sys = want_cpu || want_ram;
  let want_gpu = wants("gpu");
  let want_gputemp = wants("gputemp");
  let want_nvml = want_gpu || want_gputemp;
  let want_igpu = wants("igpu");
  // The sidecar and ASUS ACPI carry CPU package temp plus both fan tachometers.
  let want_temps = wants("cputemp") || wants("gputemp");

  let mut ram_percent = 0.0f32;
  let mut ram_used_mb = 0u64;
  let mut ram_total_mb = 0u64;
  let mut ram_free_mb = 0u64;
  let mut swap_used_mb = 0u64;
  let mut swap_total_mb = 0u64;
  let mut cpu_percent = 0.0f32;
  let mut cpu_name = String::new();
  let mut cpu_freq_mhz = 0u32;
  let mut cpu_logical_cores = 0u32;
  let mut cpu_physical_cores = None;
  if let Some(mut sys) = state.sys.lock().ok().filter(|_| want_sys) {
    if want_ram {
      sys.refresh_memory();
      let total = sys.total_memory();
      let used = sys.used_memory();
      ram_percent = if total > 0 {
        (used as f64 / total as f64 * 100.0) as f32
      } else {
        0.0
      };
      ram_used_mb = used / (1024 * 1024);
      ram_total_mb = total / (1024 * 1024);
      ram_free_mb = sys.available_memory() / (1024 * 1024);
      swap_used_mb = sys.used_swap() / (1024 * 1024);
      swap_total_mb = sys.total_swap() / (1024 * 1024);
    }
    if want_cpu {
      sys.refresh_cpu_all();
      cpu_physical_cores = sys.physical_core_count().map(|c| c as u32);
      cpu_percent = sys.global_cpu_usage();
      let cpus = sys.cpus();
      cpu_logical_cores = cpus.len() as u32;
      if let Some(first) = cpus.first() {
        cpu_name = first.brand().trim().to_string();
        cpu_freq_mhz = first.frequency() as u32;
      }
    }
  }

  let mut gpu_percent = None;
  let mut gpu_temp_c = None;
  let mut gpu_name = None;
  let mut gpu_vram_used_mb = None;
  let mut gpu_vram_total_mb = None;
  let mut gpu_power_w = None;
  let mut gpu_clock_mhz = None;
  let have_nvidia = state.nvml.is_some() && want_nvml;
  if let Some(nvml) = state.nvml.as_ref().filter(|_| want_nvml) {
    if let Ok(device) = nvml.device_by_index(0) {
      if want_gpu {
        if let Ok(util) = device.utilization_rates() {
          gpu_percent = Some(util.gpu as f32);
        }
        if let Ok(mem) = device.memory_info() {
          gpu_vram_used_mb = Some(mem.used / (1024 * 1024));
          gpu_vram_total_mb = Some(mem.total / (1024 * 1024));
        }
        if let Ok(power_mw) = device.power_usage() {
          gpu_power_w = Some(power_mw as f32 / 1000.0);
        }
        if let Ok(clock) = device.clock_info(nvml_wrapper::enum_wrappers::device::Clock::Graphics) {
          gpu_clock_mhz = Some(clock);
        }
      }
      if want_gputemp {
        if let Ok(temp) = device.temperature(nvml_wrapper::enum_wrappers::device::TemperatureSensor::Gpu) {
          gpu_temp_c = Some(temp as f32);
        }
      }
      if let Ok(name) = device.name() {
        if want_gpu || want_gputemp {
          gpu_name = Some(name);
        }
      }
    }
  }
  // The NVIDIA dGPU exists but is asleep: NVML failed this tick. Reuse the last good value so the
  // tile stays "live" at its last reading instead of flashing N/A. On success, record the value.
  if have_nvidia {
    if let Ok(mut last) = state.dgpu_last.lock() {
      if want_gpu {
        match gpu_percent {
          Some(v) => last.0 = Some(v),
          None => gpu_percent = last.0,
        }
      }
      if want_gputemp {
        match gpu_temp_c {
          Some(v) => last.1 = Some(v),
          None => gpu_temp_c = last.1,
        }
      }
    }
  }

  // Integrated GPU (Intel) via Windows perf counters — see gpu_perf.rs.
  let (igpu_percent, igpu_name) = if want_igpu { read_igpu(&state) } else { (None, None) };

  // CPU temperature + fan RPM from the optional elevated sidecar (Phase 2). Absent → None → N/A.
  let mut cpu_temp_c = None;
  let mut cpu_temp_cores = Vec::new();
  let mut cpu_fan_rpm = None;
  let mut gpu_fan_rpm = None;
  if want_temps {
    if let Some(sensors) = read_sidecar_sensors() {
      cpu_temp_c = sensors.cpu_temp_c;
      cpu_temp_cores = sensors.cpu_temp_cores;
      cpu_fan_rpm = sensors.cpu_fan_rpm.map(|v| v.round() as u32);
      gpu_fan_rpm = sensors.gpu_fan_rpm.map(|v| v.round() as u32);
    }

    // ASUS exposes its laptop tachometers through ATKACPI rather than standard SuperIO sensors.
    // Prefer that built-in, non-admin source and retain the LHM sidecar only as a generic fallback.
    #[cfg(windows)]
    if let Ok(mut monitor) = state.asus_acpi.lock() {
      let readings = monitor.read();
      if readings.cpu_temp_c.is_some() {
        cpu_temp_c = readings.cpu_temp_c;
      }
      if readings.cpu_fan_rpm.is_some() {
        cpu_fan_rpm = readings.cpu_fan_rpm;
      }
      if readings.gpu_fan_rpm.is_some() {
        gpu_fan_rpm = readings.gpu_fan_rpm;
      }
    }
  }

  SystemMetrics {
    ram_percent,
    ram_used_mb,
    ram_total_mb,
    ram_free_mb,
    swap_used_mb,
    swap_total_mb,
    cpu_percent,
    cpu_temp_c,
    cpu_temp_cores,
    cpu_fan_rpm,
    cpu_name,
    cpu_physical_cores,
    cpu_logical_cores,
    cpu_freq_mhz,
    gpu_percent,
    gpu_temp_c,
    gpu_name,
    gpu_vram_used_mb,
    gpu_vram_total_mb,
    gpu_power_w,
    gpu_clock_mhz,
    gpu_fan_rpm,
    igpu_percent,
    igpu_name,
  }
}

#[cfg(windows)]
fn read_igpu(state: &SystemMonitorState) -> (Option<f32>, Option<String>) {
  match state.igpu.lock() {
    Ok(monitor) => monitor.read(),
    Err(_) => (None, None),
  }
}

#[cfg(not(windows))]
fn read_igpu(_state: &SystemMonitorState) -> (Option<f32>, Option<String>) {
  (None, None)
}

const SENSOR_TASK_NAME: &str = "UsageViewSensors";

#[cfg(windows)]
fn hidden_command(program: &str) -> std::process::Command {
  use std::os::windows::process::CommandExt;

  let mut command = std::process::Command::new(program);
  command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  command
}

#[cfg(not(windows))]
fn hidden_command(program: &str) -> std::process::Command {
  std::process::Command::new(program)
}

/// Run a PowerShell script elevated (one UAC prompt). The script is written to a temp `.ps1` and
/// launched via `Start-Process -Verb RunAs`. Err if the launcher fails / UAC is declined.
fn run_elevated_ps(script: &str) -> Result<(), String> {
  let mut path = std::env::temp_dir();
  path.push(format!("usageview_sensors_{}.ps1", std::process::id()));
  fs::write(&path, script).map_err(|e| e.to_string())?;
  let launcher = format!(
    "Start-Process -Verb RunAs -WindowStyle Hidden -Wait -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',\"{}\"",
    path.to_string_lossy()
  );
  let status = hidden_command("powershell")
    .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &launcher])
    .status()
    .map_err(|e| e.to_string())?;
  let _ = fs::remove_file(&path);
  if status.success() {
    Ok(())
  } else {
    Err("Elevation was cancelled.".to_string())
  }
}

/// Install the elevated sensor helper as a scheduled task that runs at logon with highest
/// privileges (one UAC), then start it now. Enables CPU temperature (+ fan where available).
#[tauri::command]
fn install_sensor_service(
  app: tauri::AppHandle,
  state: tauri::State<SystemMonitorState>,
) -> Result<(), String> {
  let exe = app
    .path()
    .resolve("resources/sensors/uvsensord.exe", tauri::path::BaseDirectory::Resource)
    .map_err(|error| format!("Cannot locate sensor helper: {error}"))?;
  let exe_str = exe.to_string_lossy().replace('\'', "''"); // escape for a PS single-quoted string
  let script = format!(
    "$exe = '{exe}'\n\
     $action = New-ScheduledTaskAction -Execute $exe\n\
     $trigger = New-ScheduledTaskTrigger -AtLogOn\n\
     $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n\
     $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest\n\
     $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)\n\
     Register-ScheduledTask -TaskName '{task}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null\n\
     Start-ScheduledTask -TaskName '{task}'\n",
    exe = exe_str,
    task = SENSOR_TASK_NAME
  );
  let result = run_elevated_ps(&script);
  if let Ok(mut cache) = state.sensor_task_cache.lock() {
    *cache = None;
  }
  result
}

/// Remove the sensor scheduled task and stop the helper (one UAC).
#[tauri::command]
fn uninstall_sensor_service(state: tauri::State<SystemMonitorState>) -> Result<(), String> {
  let script = format!(
    "Stop-ScheduledTask -TaskName '{task}' -ErrorAction SilentlyContinue\n\
     Unregister-ScheduledTask -TaskName '{task}' -Confirm:$false -ErrorAction SilentlyContinue\n\
     Get-Process -Name uvsensord -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue\n",
    task = SENSOR_TASK_NAME
  );
  let result = run_elevated_ps(&script);
  if let Ok(mut cache) = state.sensor_task_cache.lock() {
    *cache = None;
  }
  result
}

fn sensor_task_exists() -> bool {
  hidden_command("schtasks")
    .args(["/query", "/tn", SENSOR_TASK_NAME])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .status()
    .map(|s| s.success())
    .unwrap_or(false)
}

fn sensor_task_exists_cached(state: &SystemMonitorState) -> bool {
  if let Ok(mut cache) = state.sensor_task_cache.lock() {
    if let Some((exists, checked_at)) = *cache {
      if checked_at.elapsed() < Duration::from_secs(30) {
        return exists;
      }
    }
    let exists = sensor_task_exists();
    *cache = Some((exists, std::time::Instant::now()));
    exists
  } else {
    sensor_task_exists()
  }
}

#[cfg(windows)]
fn asus_acpi_available(state: &SystemMonitorState) -> bool {
  state
    .asus_acpi
    .lock()
    .map(|monitor| monitor.is_available())
    .unwrap_or(false)
}

/// ASUS uses its built-in ACPI source. Other machines can opt into the elevated LHM fallback.
#[tauri::command]
fn sensor_service_status(state: tauri::State<SystemMonitorState>) -> String {
  #[cfg(windows)]
  if asus_acpi_available(&state) {
    return if sensor_task_exists_cached(&state) {
      "asus_installed".to_string()
    } else {
      "asus".to_string()
    };
  }

  if read_sidecar_sensors().is_some() {
    "running".to_string()
  } else if sensor_task_exists_cached(&state) {
    "installed".to_string()
  } else {
    "missing".to_string()
  }
}

pub fn run() {
  tauri::Builder::default()
    // Single-instance must be registered first: a second launch just focuses the running widget.
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      let _ = show_widget_window(app);
    }))
    .plugin(tauri_plugin_opener::init())
    .manage(CurrentWidgetMode(Mutex::new("widget".to_string())))
    .manage(WindowPositionStoreLock(Mutex::new(())))
    .manage(ProviderEnabledState(Mutex::new(HashMap::new())))
    .manage(RemovedProviderState(Mutex::new(HashSet::new())))
    .manage(ProgrammaticCloses(Mutex::new(HashSet::new())))
    .manage({
      let mut sys = sysinfo::System::new();
      sys.refresh_memory();
      sys.refresh_cpu_usage(); // prime a baseline so the first CPU% read isn't 0
      let nvml = nvml_wrapper::Nvml::init().ok();
      SystemMonitorState {
        sys: Mutex::new(sys),
        nvml,
        dgpu_last: Mutex::new((None, None)),
        #[cfg(windows)]
        igpu: Mutex::new(gpu_perf::IgpuMonitor::init()),
        #[cfg(windows)]
        asus_acpi: Mutex::new(asus_acpi::AsusAcpiMonitor::init()),
        sensor_task_cache: Mutex::new(None),
      }
    })
    .setup(|app| {
      setup_tray(app.handle())?;
      Ok(())
    })
    .on_menu_event(|app, event| {
      if let Some(tile_id) = event.id().as_ref().strip_prefix(DETACHED_HIDE_PREFIX) {
        let tile_id = tile_id.to_string();
        let _ = app.emit_to("widget", DETACHED_HIDE_EVENT, tile_id.clone());
        if let Ok(label) = detached_tile_label(&tile_id) {
          // The hide event is already emitted above; mark the close so the window handler
          // does not emit a second one.
          let _ = close_tile_window(app, &label);
        }
        return;
      }
      let action = match event.id().as_ref() {
        CONTEXT_MINI => Some("mini"),
        CONTEXT_FULL => Some("widget"),
        CONTEXT_PIN => Some("pin"),
        CONTEXT_REFRESH => Some("refresh"),
        CONTEXT_SETTINGS => Some("settings"),
        CONTEXT_CLOSE => Some("close"),
        _ => None,
      };
      if let Some(action) = action {
        let _ = app.emit_to("widget", CONTEXT_ACTION_EVENT, action);
      }
    })
    .on_window_event(|window, event| {
      // Close hides app windows so UsageView can keep running from the tray.
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let label = window.label();
        if label == "widget" {
          api.prevent_close();
          let _ = hide_widget_window(window.app_handle());
        } else if label.starts_with("provider_") {
          api.prevent_close();
          let _ = show_widget_window(window.app_handle());
          let _ = window.hide();
          if provider_enabled(window.app_handle(), label) {
            if let Some(webview) = window.app_handle().get_webview_window(label) {
              let _ = set_webview_memory_target(&webview, true);
            }
          } else {
            let _ = window.destroy();
            let _ = window.app_handle().emit_to("widget", PROVIDER_RELEASED_EVENT, label.to_string());
          }
        } else if label.starts_with("tile_") {
          // A detached tile has no titlebar, so Alt+F4 is the only OS close path — treat it as
          // the same Hide the context menu offers. Closes we started ourselves (docking, master
          // toggles, the Hide item) are marked, and must not touch the Show setting.
          let app = window.app_handle();
          if !unmark_programmatic_close(app, label) {
            if let Some(tile_id) = tile_id_for_label(label) {
              let _ = app.emit_to("widget", DETACHED_HIDE_EVENT, tile_id);
            }
          }
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      open_provider_window,
      set_provider_window_title,
      close_provider_window,
      set_provider_enabled,
      release_provider_window_command,
      remove_provider_account,
      prune_provider_profiles,
      suspend_provider_windows,
      refresh_provider_page,
      open_widget_window,
      close_widget_window,
      get_widget_visibility,
      toggle_widget_window,
      load_window_geometry,
      save_window_geometry,
      reset_window_geometry,
      set_widget_mode,
      show_widget_context_menu,
      set_webview_memory_target_command,
      open_detached_tile,
      close_detached_tile,
      close_all_detached_tiles,
      set_detached_tiles_pinned,
      show_detached_tile_context_menu,
      finish_detached_tile_drag,
      toggle_settings_window,
      update_tray_tooltip,
      open_in_chrome,
      logout_provider,
      extract_provider,
      discover_provider_api,
      read_system_metrics,
      install_sensor_service,
      uninstall_sensor_service,
      sensor_service_status
    ])
    .run(tauri::generate_context!())
    .expect("error while running UsageView");
}

/// Account ids are user-facing but become window labels and on-disk profile folder names, so they
/// must be a safe slug. `claude`/`codex`/`codex-1` (the migrated originals) still map to the exact
/// same labels as before, so their WebView2 profiles — and logins — survive the upgrade.
fn provider_label(provider: &str) -> Result<String, String> {
  if provider.is_empty() || !provider.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
    return Err(format!("Invalid account id: {}", provider));
  }
  Ok(format!("provider_{}", provider.replace('-', "_")))
}

/// Usage is read per host, not per account, so every account of a kind shares one host. The JS side
/// always knows an account's kind and passes it in, so Rust needs no account registry.
fn host_for_kind(kind: &str) -> Result<&'static str, String> {
  match kind {
    "claude" => Ok("claude.ai"),
    "codex" => Ok("chatgpt.com"),
    _ => Err(format!("Unknown account kind: {}", kind)),
  }
}

/// Get a provider window if it exists, or create it with an isolated WebView2 profile. Every account
/// window is created dynamically here (none are pre-declared in tauri.conf.json) with its own
/// data_directory, so each holds an independent login session.
///
/// This is also the rebuild path after a window is destroyed (Show OFF / suspend), so the builder
/// below must apply the same browser args as `widget`/`settings` — see the browser-args note.
fn get_or_create_provider_window(app: &tauri::AppHandle, label: &str, display_label: Option<&str>) -> Result<tauri::WebviewWindow, String> {
  let is_removed = || -> Result<bool, String> {
    Ok(app
      .state::<RemovedProviderState>()
      .0
      .lock()
      .map_err(|error| error.to_string())?
      .contains(label))
  };
  if is_removed()? {
    return Err("Account was removed".to_string());
  }
  if let Some(window) = app.get_webview_window(label) {
    if let Some(display_label) = display_label.filter(|value| !value.trim().is_empty()) {
      window.set_title(&format!("{} Usage - UsageView", display_label.trim())).map_err(|error| error.to_string())?;
    }
    return Ok(window);
  }
  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?
    .join("profiles")
    .join(label);
  let title = display_label
    .filter(|value| !value.trim().is_empty())
    .map(|value| format!("{} Usage - UsageView", value.trim()))
    .unwrap_or_else(|| format!("{} \u{2014} UsageView", label.strip_prefix("provider_").unwrap_or(label).replace('_', " ")));
  let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
    .title(title)
    .inner_size(980.0, 760.0)
    .min_inner_size(720.0, 520.0)
    .resizable(false)
    .zoom_hotkeys_enabled(false)
    .center()
    .visible(false);
  // Every account gets its own isolated WebView2 profile, so signing out of or deleting one never
  // touches another and two accounts of the same service can hold separate logins. (The old
  // claude/codex shared-default-profile special case is gone — they are ordinary accounts now.)
  let window = builder
    .data_directory(data_dir)
    .additional_browser_args(WEBVIEW_BROWSER_ARGS)
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    .build()
    .map_err(|e| e.to_string())?;
  // Remove may have won the race while WebView2 was building. Do not hand this window to the caller;
  // destroy it here so the tombstone remains authoritative without holding a mutex over build().
  if is_removed()? {
    let _ = window.destroy();
    return Err("Account was removed".to_string());
  }
  let _ = set_webview_memory_target(&window, true);
  Ok(window)
}

fn is_usable_provider_page(kind: &str, current: &tauri::Url, expected_host: &str, target_url: &str) -> bool {
  let on_host = current.host_str().unwrap_or_default().contains(expected_host);
  if !on_host {
    return false;
  }
  if kind != "claude" {
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

/// `id` is the account id embedded in the snapshot (so it keys back to the right tile); `kind` picks
/// which reader to run. Branching on kind — not id — is what lets any dynamically-added account read
/// usage, since every Codex account shares the Codex reader and every Claude account the Claude one.
fn extract_script(id: &str, kind: &str, marker: &str) -> Result<String, String> {
  if kind != "claude" && kind != "codex" {
    return Err(format!("Unknown account kind: {}", kind));
  }

  if kind == "codex" {
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
        ? `Weekly ${{Math.round(weeklyPercent)}}% used${{weeklyReset ? ' / ' + weeklyReset : ''}}`
        : weeklyReset,
      debugText: raw.slice(0, 600)
    }});
  }} catch (error) {{
    finish('not_found', fallbackSnapshot('Codex usage API fetch failed.', error && error.message ? error.message : error));
  }}
}})();"#,
      provider_name = js_string(id),
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

    // Resolve organization uuids from the organizations API, plus any org-scoped URL the page
    // already called (works even if /api/organizations rejects a header-less fetch). A user can
    // belong to several orgs where only one has real usage (the others return utilization 0 /
    // resets_at null); we must try EVERY org's usage endpoint, not just the first, otherwise an
    // empty personal org shadows the org that actually holds the plan usage.
    let orgUuids = [];
    try {
      const orgResp = await fetch(origin + '/api/organizations', { credentials: 'include' });
      apiLog.push('organizations ' + orgResp.status);
      if (orgResp.ok) {
        const orgs = await orgResp.clone().json();
        if (Array.isArray(orgs)) {
          for (const o of orgs) {
            if (o && o.uuid && orgUuids.indexOf(o.uuid) === -1) orgUuids.push(o.uuid);
          }
        }
      }
    } catch (e) { apiLog.push('organizations error'); }
    for (const name of perfNames) {
      const match = name.match(/\/api\/organizations\/([0-9a-fA-F-]{36})/);
      if (match && orgUuids.indexOf(match[1]) === -1) orgUuids.push(match[1]);
    }

    // Candidates: every org's usage endpoint (the loop below skips empty/secondary orgs because
    // fromApi() returns undefined for them), then any usage-looking call the page already made.
    const candidates = [];
    for (const uuid of orgUuids) candidates.push(origin + '/api/organizations/' + uuid + '/usage');
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
      .replace("__PROVIDER__", &js_string(id))
      .replace("__MARKER__", &js_string(marker))
      .replace("__EVENT__", EXTRACT_EVENT),
  )
}

fn discover_script(provider: &str, marker: &str) -> Result<String, String> {
  // Discovery is generic (it just reports what endpoints the page calls), so it accepts any account
  // id — the caller has already validated the id via provider_label.
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
