// ASUS laptops expose fan RPM and temperature through ATKACPI instead of standard SuperIO
// sensors. This read-only monitor uses the same DSTS endpoints as G-Helper and degrades to None.

use std::mem::size_of;

use windows::core::w;
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::IO::DeviceIoControl;

const ATKACPI: windows::core::PCWSTR = w!("\\\\.\\ATKACPI");
const CONTROL_CODE: u32 = 0x0022_240C;
const DSTS: u32 = 0x5354_5344;
const CPU_FAN: u32 = 0x0011_0013;
const GPU_FAN: u32 = 0x0011_0014;
const CPU_TEMP: u32 = 0x0012_0094;

#[derive(Clone, Copy, Default)]
pub struct AsusReadings {
    pub cpu_temp_c: Option<f32>,
    pub cpu_fan_rpm: Option<u32>,
    pub gpu_fan_rpm: Option<u32>,
}

pub struct AsusAcpiMonitor {
    handle: Option<HANDLE>,
}

// The handle is only accessed while this monitor is protected by SystemMonitorState's Mutex.
unsafe impl Send for AsusAcpiMonitor {}

impl AsusAcpiMonitor {
    pub fn init() -> Self {
        let mut monitor = Self { handle: None };
        monitor.connect();
        monitor
    }

    pub fn is_available(&self) -> bool {
        self.handle.is_some()
    }

    pub fn read(&mut self) -> AsusReadings {
        if self.handle.is_none() {
            self.connect();
        }
        let Some(handle) = self.handle else {
            return AsusReadings::default();
        };

        AsusReadings {
            cpu_temp_c: self
                .device_get(handle, CPU_TEMP)
                .filter(|value| (0..125).contains(value))
                .map(|value| value as f32),
            cpu_fan_rpm: self.read_fan(handle, CPU_FAN),
            gpu_fan_rpm: self.read_fan(handle, GPU_FAN),
        }
    }

    fn connect(&mut self) {
        let access = GENERIC_READ.0 | GENERIC_WRITE.0;
        let sharing = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0);
        self.handle = unsafe {
            CreateFileW(
                ATKACPI,
                access,
                sharing,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .ok();
    }

    fn read_fan(&mut self, handle: HANDLE, endpoint: u32) -> Option<u32> {
        let raw = self.device_get(handle, endpoint)?;
        let fan = raw as u32 & 0xffff;
        if fan > 120 || (fan == 0 && raw < 0) {
            None
        } else {
            Some(fan * 100)
        }
    }

    fn device_get(&mut self, handle: HANDLE, endpoint: u32) -> Option<i32> {
        let mut input = [0u8; 16];
        input[0..4].copy_from_slice(&DSTS.to_le_bytes());
        input[4..8].copy_from_slice(&8u32.to_le_bytes());
        input[8..12].copy_from_slice(&endpoint.to_le_bytes());

        let mut output = [0u8; 16];
        let mut _returned = 0u32;
        let result = unsafe {
            DeviceIoControl(
                handle,
                CONTROL_CODE,
                Some(input.as_ptr().cast()),
                size_of::<[u8; 16]>() as u32,
                Some(output.as_mut_ptr().cast()),
                size_of::<[u8; 16]>() as u32,
                Some(&mut _returned),
                None,
            )
        };
        // The ASUS driver does not consistently report lpBytesReturned even when it fills output.
        // Match G-Helper and trust the DeviceIoControl success result here.
        if result.is_err() {
            self.disconnect();
            return None;
        }

        let raw = i32::from_le_bytes(output[0..4].try_into().ok()?);
        Some(raw.saturating_sub(65_536))
    }

    fn disconnect(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = unsafe { CloseHandle(handle) };
        }
    }
}

impl Drop for AsusAcpiMonitor {
    fn drop(&mut self) {
        self.disconnect();
    }
}
