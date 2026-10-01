// 桌面建置：Register/manage 與 handle 只存在於 Android（icon/tts 同款 pattern，這裡額外消警告守住 37-warning 基準）
#![cfg_attr(not(target_os = "android"), allow(unused_imports, unused_variables, dead_code))]

use tauri::{
    Manager,
    plugin::{self, PluginApi},
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.teno.app";

#[derive(Clone)]
pub struct WidgetHandle(pub plugin::PluginHandle<tauri::Wry>);

pub fn init() -> plugin::TauriPlugin<tauri::Wry> {
    plugin::Builder::new("teno_widget")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "WidgetPlugin")?;
                app.manage(WidgetHandle(handle));
            }
            Ok(())
        })
        .build()
}

/// 呼叫 Kotlin WidgetPlugin 命令。桌面端回 supported:false（設定頁不顯示控制項）。
async fn call(
    app_handle: &tauri::AppHandle,
    cmd: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<WidgetHandle>().0;
        handle
            .run_mobile_plugin(cmd, args)
            .map_err(|e| format!("Android widget {cmd}: {e:?}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app_handle, cmd, args);
        Ok(serde_json::json!({ "supported": false }))
    }
}

/// 讀 widget 設定＋權限狀態（設定頁初始化）。
#[tauri::command]
pub async fn widget_get_status(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    call(&app_handle, "getStatus", serde_json::json!({})).await
}

/// 存 widget 設定（全欄位一起送）→ 存檔＋重武裝鬧鐘＋立即渲染＋常駐同步。
#[tauri::command]
pub async fn widget_save_config(
    app_handle: tauri::AppHandle,
    cfg: serde_json::Value,
) -> Result<serde_json::Value, String> {
    call(&app_handle, "saveConfig", cfg).await
}

/// 立即刷新 Widget（開 App／手動鈕）。
#[tauri::command]
pub async fn widget_refresh(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    call(&app_handle, "refreshNow", serde_json::json!({})).await
}

/// 請求通知權限＋精確鬧鐘權限（31+ 精確鬧鐘走系統設定頁）。
#[tauri::command]
pub async fn widget_request_perms(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    call(&app_handle, "requestPerms", serde_json::json!({})).await
}
