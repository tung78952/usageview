// Integrated-GPU (Intel) utilization via Windows perf counters.
//
// NVML only enumerates NVIDIA devices, so it cannot see the Intel iGPU that drives the
// desktop on Optimus laptops. Task Manager's GPU numbers come from the
// `\GPU Engine(*)\Utilization Percentage` performance counters — we read the same source
// here and isolate the Intel adapter by its LUID (found via DXGI).
//
// Everything is best-effort: any failure yields `None` so the iGPU tile shows "N/A" and the
// rest of the app is unaffected. Windows-only (guarded by cfg(windows) at the module site).

use std::collections::HashMap;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

const ERROR_SUCCESS: u32 = 0;

/// Holds a live PDH query for the GPU-engine counters plus the Intel adapter's LUID string.
/// Not `Clone`; kept behind a `Mutex` in app state because PDH queries are not reentrant.
#[derive(Default)]
pub struct IgpuMonitor {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
    /// e.g. "luid_0x00000000_0x0001345a" — matched as a substring of counter instance names.
    intel_luid: Option<String>,
    intel_name: Option<String>,
}

// The handles are just integer values; sharing them across threads behind the state Mutex is safe.
unsafe impl Send for IgpuMonitor {}
unsafe impl Sync for IgpuMonitor {}

impl IgpuMonitor {
    /// Best-effort init: locate the Intel adapter (DXGI) and open the GPU-engine PDH query.
    /// Never panics; on any failure the returned monitor simply reports `None`.
    pub fn init() -> Self {
        let (intel_luid, intel_name) = find_intel_adapter();
        let (query, counter) = open_gpu_query().unwrap_or_default();
        IgpuMonitor {
            query,
            counter,
            intel_luid,
            intel_name,
        }
    }

    fn ready(&self) -> bool {
        self.intel_luid.is_some() && !self.query.0.is_null() && !self.counter.0.is_null()
    }

    /// Returns (utilization_percent, adapter_name). Utilization is the max across engine types
    /// (3D / Copy / VideoDecode / …) of the summed per-process usage — matching Task Manager.
    pub fn read(&self) -> (Option<f32>, Option<String>) {
        if !self.ready() {
            return (None, self.intel_name.clone());
        }
        let luid = self.intel_luid.as_deref().unwrap_or_default();
        let percent = unsafe { self.read_percent(luid) };
        (percent, self.intel_name.clone())
    }

    unsafe fn read_percent(&self, luid: &str) -> Option<f32> {
        if PdhCollectQueryData(self.query) != ERROR_SUCCESS {
            return None;
        }

        // First call: discover the required buffer size (returns PDH_MORE_DATA).
        let mut buf_size: u32 = 0;
        let mut item_count: u32 = 0;
        let _ = PdhGetFormattedCounterArrayW(
            self.counter,
            PDH_FMT_DOUBLE,
            &mut buf_size,
            &mut item_count,
            None,
        );
        if buf_size == 0 {
            // No active engines this instant — treat as idle rather than N/A.
            return Some(0.0);
        }

        // Allocate an 8-byte-aligned backing buffer of exactly buf_size bytes (PDH appends the
        // instance-name strings after the item array inside the same buffer).
        let mut backing: Vec<u64> = vec![0u64; (buf_size as usize).div_ceil(8)];
        let items_ptr = backing.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let status = PdhGetFormattedCounterArrayW(
            self.counter,
            PDH_FMT_DOUBLE,
            &mut buf_size,
            &mut item_count,
            Some(items_ptr),
        );
        if status != ERROR_SUCCESS {
            return None;
        }

        let items = std::slice::from_raw_parts(items_ptr, item_count as usize);
        let mut per_engtype: HashMap<String, f64> = HashMap::new();
        for item in items {
            // Counter instance names spell the LUID in uppercase hex; our formatted luid is
            // lowercase — compare case-insensitively so the Intel engines actually match.
            let name = item.szName.to_string().unwrap_or_default().to_lowercase();
            if !name.contains(luid) {
                continue;
            }
            let engtype = name
                .split("engtype_")
                .nth(1)
                .unwrap_or("other")
                .to_string();
            let value = item.FmtValue.Anonymous.doubleValue;
            *per_engtype.entry(engtype).or_insert(0.0) += value;
        }
        let max = per_engtype.values().cloned().fold(0.0f64, f64::max);
        Some(max.clamp(0.0, 100.0) as f32)
    }
}

/// Enumerate DXGI adapters and return the Intel one's LUID (formatted to match perf-counter
/// instance names) and human-readable name.
fn find_intel_adapter() -> (Option<String>, Option<String>) {
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return (None, None),
        };
        let mut index = 0u32;
        loop {
            let adapter = match factory.EnumAdapters1(index) {
                Ok(a) => a,
                Err(_) => break, // DXGI_ERROR_NOT_FOUND ends enumeration
            };
            index += 1;
            let desc = match adapter.GetDesc1() {
                Ok(d) => d,
                Err(_) => continue,
            };
            let name = String::from_utf16_lossy(&desc.Description);
            let name = name.trim_end_matches('\0').trim().to_string();
            if name.to_lowercase().contains("intel") {
                let luid = format!(
                    "luid_0x{:08x}_0x{:08x}",
                    desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
                );
                return (Some(luid), Some(name));
            }
        }
        (None, None)
    }
}

/// Open a PDH query on the wildcard GPU-engine utilization counter and prime one sample.
fn open_gpu_query() -> Option<(PDH_HQUERY, PDH_HCOUNTER)> {
    unsafe {
        let mut query = PDH_HQUERY::default();
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != ERROR_SUCCESS {
            return None;
        }
        let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0"
            .encode_utf16()
            .collect();
        let mut counter = PDH_HCOUNTER::default();
        if PdhAddEnglishCounterW(query, PCWSTR::from_raw(path.as_ptr()), 0, &mut counter)
            != ERROR_SUCCESS
        {
            return None;
        }
        // Prime: the utilization percentage needs a prior sample to diff against.
        let _ = PdhCollectQueryData(query);
        Some((query, counter))
    }
}
