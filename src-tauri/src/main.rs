#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
struct BluetoothDeviceInfo {
    name: String,
    address: String,
    connected: i8,
}

#[derive(Serialize, Clone)]
struct GaiaPacketEvent {
    vendor_id: u16,
    command_id: u16,
    command: u16,
    ack: bool,
    flags: u8,
    payload: Vec<u8>,
    status: Option<u8>,
}

struct GaiaParser {
    packet: [u8; 270],
    packet_length: usize,
    expected: usize,
    flags: u8,
}

impl GaiaParser {
    fn new() -> Self {
        Self {
            packet: [0u8; 270],
            packet_length: 0,
            expected: 254,
            flags: 0,
        }
    }

    fn push_bytes(&mut self, data: &[u8]) -> Vec<GaiaPacketEvent> {
        let mut packets = Vec::new();
        for &byte in data {
            if self.packet_length > 0 && self.packet_length < self.packet.len() {
                self.packet[self.packet_length] = byte;
                if self.packet_length == 2 {
                    self.flags = byte;
                } else if self.packet_length == 3 {
                    let payload_length = byte as usize;
                    let check_len = if (self.flags & 1) != 0 { 1 } else { 0 };
                    self.expected = payload_length + 8 + check_len;
                    if self.expected > self.packet.len() {
                        self.packet_length = 0;
                        self.expected = 254;
                        continue;
                    }
                }

                self.packet_length += 1;
                if self.packet_length == self.expected {
                    if let Some(packet) = parse_gaia_packet(&self.packet[..self.packet_length]) {
                        packets.push(packet);
                    }
                    self.packet_length = 0;
                    self.expected = 254;
                }
            } else if byte == 0xFF {
                self.packet[0] = 0xFF;
                self.packet_length = 1;
            }
        }
        packets
    }
}

fn parse_gaia_packet(data: &[u8]) -> Option<GaiaPacketEvent> {
    if data.len() < 8 {
        return None;
    }
    let flags = data[2];
    let payload_length = data[3] as usize;
    let check_len = if (flags & 1) != 0 { 1 } else { 0 };
    if data.len() < payload_length + 8 + check_len {
        return None;
    }

    if (flags & 1) != 0 {
        let mut check: u8 = 0;
        for b in &data[..data.len() - 1] {
            check ^= *b;
        }
        if check != data[data.len() - 1] {
            return None;
        }
    }

    let vendor_id = u16::from_be_bytes([data[4], data[5]]);
    let command_id = u16::from_be_bytes([data[6], data[7]]);
    let ack = (command_id & 0x8000) != 0;
    let command = command_id & 0x7FFF;

    let payload_end = 8 + payload_length;
    let payload = if payload_length > 0 && data.len() >= payload_end {
        data[8..payload_end].to_vec()
    } else {
        Vec::new()
    };

    let status = if ack && !payload.is_empty() {
        Some(payload[0])
    } else {
        None
    };

    Some(GaiaPacketEvent {
        vendor_id,
        command_id,
        command,
        ack,
        flags,
        payload,
        status,
    })
}

fn gaia_frame(vendor_id: u16, command_id: u16, payload: &[u8], flags: u8) -> Result<Vec<u8>, String> {
    if payload.len() > 254 {
        return Err("Payload too long".to_string());
    }

    let check_len = if (flags & 1) != 0 { 1 } else { 0 };
    let mut frame = Vec::with_capacity(8 + payload.len() + check_len);
    frame.push(0xFF);
    frame.push(0x01);
    frame.push(flags);
    frame.push(payload.len() as u8);
    frame.extend_from_slice(&vendor_id.to_be_bytes());
    frame.extend_from_slice(&command_id.to_be_bytes());
    frame.extend_from_slice(payload);

    if check_len == 1 {
        let mut check: u8 = 0;
        for b in &frame {
            check ^= *b;
        }
        frame.push(check);
    }

    Ok(frame)
}

fn ioreturn_name(code: i32) -> &'static str {
    match code as u32 {
        0x00000000 => "kIOReturnSuccess",
        0xE00002BC => "kIOReturnError",
        0xE00002C0 => "kIOReturnNoDevice",
        0xE00002C5 => "kIOReturnExclusiveAccess",
        0xE00002CD => "kIOReturnNotOpen",
        0xE00002D6 => "kIOReturnTimeout",
        0xE00002E2 => "kIOReturnNotPermitted",
        0xE00002F0 => "kIOReturnNotFound",
        _ => "kIOReturnUnknown",
    }
}

fn back_log(source: &str, message: String) {
    println!("[STONE][BACK][{}] {}", source, message);
}

static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();
static PARSER: OnceCell<Mutex<GaiaParser>> = OnceCell::new();

fn get_parser() -> &'static Mutex<GaiaParser> {
    PARSER.get_or_init(|| Mutex::new(GaiaParser::new()))
}

#[cfg(target_os = "macos")]
extern "C" {
    fn macos_bt_list_paired_devices() -> *mut std::os::raw::c_char;
    fn macos_bt_connect(address: *const std::os::raw::c_char) -> i32;
    fn macos_bt_disconnect();
    fn macos_bt_write(data: *const u8, len: usize) -> i32;
    fn macos_bt_last_error_context() -> *mut std::os::raw::c_char;
}

#[no_mangle]
pub extern "C" fn macos_bt_on_data(data: *const u8, len: usize) {
    if data.is_null() || len == 0 {
        return;
    }
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    let mut parser = match get_parser().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let packets = parser.push_bytes(bytes);
    if let Some(app) = APP_HANDLE.get() {
        for packet in packets {
            let _ = app.emit("gaia_packet", packet);
        }
    }
}

#[tauri::command]
async fn list_devices() -> Result<Vec<BluetoothDeviceInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        back_log("RUST", "List devices".to_string());
        let ptr = unsafe { macos_bt_list_paired_devices() };
        if ptr.is_null() {
            return Ok(Vec::new());
        }
        let json = unsafe { CString::from_raw(ptr) }
            .into_string()
            .map_err(|_| "Invalid device list encoding".to_string())?;
        let list: Vec<BluetoothDeviceInfo> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        Ok(list)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn connect_device(address: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        back_log("RUST", format!("Connect request: {}", address));
        let status = tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
            let cstr = CString::new(address).map_err(|_| "Invalid address".to_string())?;
            Ok(unsafe { macos_bt_connect(cstr.as_ptr()) })
        })
        .await
        .map_err(|_| "Join error".to_string())??;
        if status == 0 {
            Ok(())
        } else {
            let context = unsafe {
                let ptr = macos_bt_last_error_context();
                if ptr.is_null() {
                    "".to_string()
                } else {
                    CString::from_raw(ptr)
                        .into_string()
                        .unwrap_or_else(|_| "".to_string())
                }
            };
            Err(format!(
                "IOBluetooth error {} ({}){}",
                status,
                ioreturn_name(status),
                if context.is_empty() {
                    "".to_string()
                } else {
                    format!(" ({})", context)
                }
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = address;
        Err("Not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn disconnect_device() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        back_log("RUST", "Disconnect request".to_string());
        tauri::async_runtime::spawn_blocking(move || unsafe { macos_bt_disconnect() })
            .await
            .map_err(|_| "Join error".to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn send_gaia_command(vendor_id: u16, command_id: u16, payload: Vec<u8>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        back_log(
            "RUST",
            format!(
                "Send GAIA command: vendor=0x{:04X} cmd=0x{:04X} len={}",
                vendor_id,
                command_id,
                payload.len()
            ),
        );
        let status = tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
            let frame = gaia_frame(vendor_id, command_id, &payload, 0)?;
            Ok(unsafe { macos_bt_write(frame.as_ptr(), frame.len()) })
        })
        .await
        .map_err(|_| "Join error".to_string())??;
        if status == 0 {
            Ok(())
        } else {
            Err(format!("IOBluetooth error {}", status))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (vendor_id, command_id, payload);
        Err("Not supported on this platform".to_string())
    }
}

#[tauri::command]
fn log_line(line: String, tone: String, _ts: String) {
    println!("[STONE][FRONT][{}] {}", tone, line);
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            connect_device,
            disconnect_device,
            send_gaia_command,
            log_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
