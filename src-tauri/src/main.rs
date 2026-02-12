#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Wry, WindowEvent};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};

#[derive(Serialize, Deserialize, Clone)]
struct BluetoothDeviceInfo {
    name: String,
    address: String,
    connected: bool,
    has_gaia: bool,
    #[serde(default = "default_true")]
    paired: bool,
}

fn default_true() -> bool {
    true
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

#[derive(Serialize, Deserialize, Clone)]
struct ConnectionInfo {
    address: String,
    link: bool,
    rfcomm: bool,
}

#[derive(Serialize, Clone)]
struct DeviceStateEvent {
    address: String,
    connected: bool,
}

#[derive(Serialize, Clone)]
struct ConnectResult {
    address: String,
    ok: bool,
    error: Option<String>,
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
        0xE0020002 => "kIOBluetoothConnectionAlreadyExists",
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
static TRAY: OnceCell<TrayIcon<Wry>> = OnceCell::new();
static TRAY_MENU: OnceCell<Menu<Wry>> = OnceCell::new();
static TRAY_BATTERY_ITEM: OnceCell<MenuItem<Wry>> = OnceCell::new();
static CONNECT_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

fn get_parser() -> &'static Mutex<GaiaParser> {
    PARSER.get_or_init(|| Mutex::new(GaiaParser::new()))
}

#[cfg(target_os = "macos")]
extern "C" {
    fn macos_bt_list_paired_devices() -> *mut std::os::raw::c_char;
    fn macos_bt_scan_unpaired_stone_devices() -> *mut std::os::raw::c_char;
    fn macos_bt_connect(address: *const std::os::raw::c_char) -> i32;
    fn macos_bt_disconnect() -> i32;
    fn macos_bt_write(data: *const u8, len: usize) -> i32;
    fn macos_bt_sdp_query(address: *const std::os::raw::c_char) -> i32;
    fn macos_bt_last_error_context() -> *mut std::os::raw::c_char;
    fn macos_bt_get_connection_info() -> *mut std::os::raw::c_char;
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

#[no_mangle]
pub extern "C" fn macos_bt_on_device_event(address: *const std::os::raw::c_char, connected: i32) {
    if address.is_null() {
        return;
    }
    let addr = unsafe { CStr::from_ptr(address) }.to_string_lossy().to_string();
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "bt_device_event",
            DeviceStateEvent {
                address: addr,
                connected: connected != 0,
            },
        );
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
async fn scan_unpaired_stone_devices() -> Result<Vec<BluetoothDeviceInfo>, String> {
    #[cfg(target_os = "macos")]
    {
        if CONNECT_IN_FLIGHT.load(Ordering::SeqCst) {
            back_log("RUST", "Skip scan while connect is in progress".to_string());
            return Ok(Vec::new());
        }
        back_log("RUST", "Scan unpaired STONE devices".to_string());
        let json = tauri::async_runtime::spawn_blocking(move || {
            let ptr = unsafe { macos_bt_scan_unpaired_stone_devices() };
            if ptr.is_null() {
                return Ok::<String, String>("[]".to_string());
            }
            unsafe { CString::from_raw(ptr) }
                .into_string()
                .map_err(|_| "Invalid scan list encoding".to_string())
        })
        .await
        .map_err(|_| "Join error".to_string())??;
        let list: Vec<BluetoothDeviceInfo> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        Ok(list)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn get_connection_info() -> Result<ConnectionInfo, String> {
    #[cfg(target_os = "macos")]
    {
        let ptr = unsafe { macos_bt_get_connection_info() };
        if ptr.is_null() {
            return Ok(ConnectionInfo {
                address: "".to_string(),
                link: false,
                rfcomm: false,
            });
        }
        let json = unsafe { CString::from_raw(ptr) }
            .into_string()
            .map_err(|_| "Invalid connection info encoding".to_string())?;
        let info: ConnectionInfo = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        Ok(info)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Not supported on this platform".to_string())
    }
}
#[tauri::command]
async fn connect_device_async(address: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if CONNECT_IN_FLIGHT.swap(true, Ordering::SeqCst) {
            return Err("Connect already in progress".to_string());
        }
        let app = APP_HANDLE
            .get()
            .cloned()
            .ok_or_else(|| "App not ready".to_string())?;
        tauri::async_runtime::spawn(async move {
            let result = connect_device_inner(address.clone()).await;
            CONNECT_IN_FLIGHT.store(false, Ordering::SeqCst);
            let payload = match result {
                Ok(()) => ConnectResult {
                    address,
                    ok: true,
                    error: None,
                },
                Err(err) => ConnectResult {
                    address,
                    ok: false,
                    error: Some(err),
                },
            };
            let _ = app.emit("bt_connect_result", payload);
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = address;
        Err("Not supported on this platform".to_string())
    }
}

async fn connect_device_inner(address: String) -> Result<(), String> {
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

#[tauri::command]
async fn disconnect_device() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        back_log("RUST", "Disconnect request".to_string());
        let status = tauri::async_runtime::spawn_blocking(move || unsafe { macos_bt_disconnect() })
            .await
            .map_err(|_| "Join error".to_string())?;
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
async fn sdp_query(address: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        back_log("RUST", format!("SDP query request: {}", address));
        let status = tauri::async_runtime::spawn_blocking(move || -> Result<i32, String> {
            let cstr = CString::new(address).map_err(|_| "Invalid address".to_string())?;
            Ok(unsafe { macos_bt_sdp_query(cstr.as_ptr()) })
        })
        .await
        .map_err(|_| "Join error".to_string())??;
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "IOBluetooth error {} ({}) (sdp_query)",
                status,
                ioreturn_name(status)
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
fn log_line(line: String, tone: String, _ts: String) {
    println!("[STONE][FRONT][{}] {}", tone, line);
}

#[tauri::command]
fn open_url(url: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
}

#[tauri::command]
fn set_tray_battery(percent: Option<u8>, charging: bool, full: bool) {
    let Some(tray) = TRAY.get() else { return; };
    let title = percent.map(|p| format!("{p}%")).unwrap_or_default();
    let _ = tray.set_title(Some(title));
    if let Some(item) = TRAY_BATTERY_ITEM.get() {
        let label = match percent {
            Some(p) => {
                if full {
                    format!("배터리: {p}% (충전 완료)")
                } else if charging {
                    format!("배터리: {p}% (충전 중)")
                } else {
                    format!("배터리: {p}%")
                }
            }
            None => "배터리: --".to_string(),
        };
        let _ = item.set_text(label);
    }
    let tooltip = match percent {
        Some(p) => {
            if full {
                format!("배터리: {p}% (충전 완료)")
            } else if charging {
                format!("배터리: {p}% (충전 중)")
            } else {
                format!("배터리: {p}%")
            }
        }
        None => "배터리: --".to_string(),
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            let _ = app.set_dock_visibility(false);
            if let Some(window) = app.get_webview_window("main") {
                let window_handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_handle.hide();
                    }
                });
            }
            if let Some(icon) = app.default_window_icon().cloned() {
                let battery_item = MenuItem::with_id(app, "battery", "배터리: --", false, None::<&str>)
                .ok();
                let separator = PredefinedMenuItem::separator(app).ok();
                let show_item = MenuItem::with_id(app, "show", "STONE 매니저 열기", true, None::<&str>)
                .ok();
                let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)
                .ok();
                let menu = if let (Some(battery), Some(sep), Some(show), Some(quit)) = (battery_item, separator, show_item, quit_item) {
                    let menu = Menu::with_items(app, &[&battery, &sep, &show, &quit]).ok();
                    let _ = TRAY_BATTERY_ITEM.set(battery);
                    menu
                } else {
                    None
                };
                if let Some(menu) = menu {
                    let _ = TRAY_MENU.set(menu.clone());
                    if let Ok(tray) = TrayIconBuilder::new()
                        .icon(icon)
                        .tooltip("STONE 매니저")
                        .menu(&menu)
                        .show_menu_on_left_click(true)
                        .on_menu_event(|app, event| {
                            match event.id().as_ref() {
                                "show" => {
                                    if let Some(win) = app.get_webview_window("main") {
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                    }
                                }
                                "quit" => {
                                    app.exit(0);
                                }
                                _ => {}
                            }
                        })
                        .build(app)
                    {
                        let _ = TRAY.set(tray);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            scan_unpaired_stone_devices,
            get_connection_info,
            connect_device_async,
            disconnect_device,
            send_gaia_command,
            sdp_query,
            log_line,
            set_tray_battery,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
