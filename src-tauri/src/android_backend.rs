use jni::objects::{JByteArray, JObject, JString};
use jni::JNIEnv;
use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};

use crate::{emit_backend_device_event, handle_backend_data, BluetoothDeviceInfo, ConnectionInfo};

pub struct AndroidBluetoothPlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

#[derive(Serialize)]
struct EmptyPayload {}

#[derive(Serialize)]
struct AddressPayload<'a> {
    address: &'a str,
}

#[derive(Serialize)]
struct GaiaWritePayload<'a> {
    address: &'a str,
    data: &'a [u8],
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("stone_android")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("com.stone.manager", "StoneBluetoothPlugin")?;
            app.manage(AndroidBluetoothPlugin(handle));
            Ok(())
        })
        .build()
}

fn plugin_handle(app: &AppHandle) -> Result<tauri::plugin::PluginHandle<Wry>, String> {
    app.try_state::<AndroidBluetoothPlugin<Wry>>()
        .map(|state| state.0.clone())
        .ok_or_else(|| "Android Bluetooth plugin is not initialized".to_string())
}

pub async fn list_devices(app: &AppHandle) -> Result<Vec<BluetoothDeviceInfo>, String> {
    plugin_handle(app)?
        .run_mobile_plugin_async("listDevices", EmptyPayload {})
        .await
        .map_err(|err| err.to_string())
}

pub async fn scan_unpaired_stone_devices(
    app: &AppHandle,
) -> Result<Vec<BluetoothDeviceInfo>, String> {
    plugin_handle(app)?
        .run_mobile_plugin_async("scanUnpairedStoneDevices", EmptyPayload {})
        .await
        .map_err(|err| err.to_string())
}

pub async fn get_connection_infos(app: &AppHandle) -> Result<Vec<ConnectionInfo>, String> {
    plugin_handle(app)?
        .run_mobile_plugin_async("getConnectionInfos", EmptyPayload {})
        .await
        .map_err(|err| err.to_string())
}

pub async fn connect_device(app: &AppHandle, address: &str) -> Result<(), String> {
    plugin_handle(app)?
        .run_mobile_plugin_async("connectDevice", AddressPayload { address })
        .await
        .map_err(|err| err.to_string())
}

pub async fn disconnect_device(app: &AppHandle, address: &str) -> Result<(), String> {
    plugin_handle(app)?
        .run_mobile_plugin_async("disconnectDevice", AddressPayload { address })
        .await
        .map_err(|err| err.to_string())
}

pub async fn send_gaia_command(app: &AppHandle, address: &str, frame: &[u8]) -> Result<(), String> {
    plugin_handle(app)?
        .run_mobile_plugin_async(
            "sendGaiaCommand",
            GaiaWritePayload {
                address,
                data: frame,
            },
        )
        .await
        .map_err(|err| err.to_string())
}

#[no_mangle]
pub extern "system" fn Java_com_stone_manager_StoneBluetoothPlugin_nativeOnData(
    mut env: JNIEnv<'_>,
    _: JObject<'_>,
    address: JString<'_>,
    data: JByteArray<'_>,
) {
    let Ok(address) = env.get_string(&address) else {
        return;
    };
    let Ok(bytes) = env.convert_byte_array(&data) else {
        return;
    };
    handle_backend_data(address.to_string_lossy().as_ref(), &bytes);
}

#[no_mangle]
pub extern "system" fn Java_com_stone_manager_StoneBluetoothPlugin_nativeOnDeviceEvent(
    mut env: JNIEnv<'_>,
    _: JObject<'_>,
    address: JString<'_>,
    connected: jni::sys::jboolean,
) {
    let Ok(address) = env.get_string(&address) else {
        return;
    };
    emit_backend_device_event(address.to_string_lossy().into_owned(), connected != 0);
}
