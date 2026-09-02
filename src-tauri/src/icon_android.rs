use tauri::{
    Manager,
    plugin::{self, PluginApi},
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.teno.app";

#[derive(Clone)]
pub struct IconHandle(pub plugin::PluginHandle<tauri::Wry>);

pub fn init() -> plugin::TauriPlugin<tauri::Wry> {
    plugin::Builder::new("teno_icon")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "IconPlugin")?;
                app.manage(IconHandle(handle));
            }
            Ok(())
        })
        .build()
}

/// 讀取目前 launcher icon（Android activity-alias 機制，resolve LAUNCHER intent）。
/// 回傳 icon key："original" | "ocean" | ... | "ch10"。
#[tauri::command]
pub async fn get_launcher_icon(app_handle: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<IconHandle>().0;
        let val: serde_json::Value = handle
            .run_mobile_plugin("getCurrentIcon", serde_json::json!({}))
            .map_err(|e| format!("Android icon query: {:?}", e))?;
        let key = val
            .get("icon")
            .and_then(|v| v.as_str())
            .unwrap_or("original")
            .to_string();
        log::info!("get_launcher_icon -> {key}");
        Ok(key)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app_handle;
        Ok("original".into())
    }
}

/// 重置 app-log.db（操作日誌 DB）。SQLite malformed 時 JS 端呼叫刪檔重建。
/// teno.db 學習資料絕不受影響。
/// DB 位置 = tauri-plugin-sql 的 app_config_dir()（wrapper.rs connect 同源路徑）。
#[tauri::command]
pub async fn reset_app_log(app_handle: tauri::AppHandle) -> Result<String, String> {
    use std::fs;
    let dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir: {e}"))?;
    let mut deleted = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir {:?}: {e}", dir))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.starts_with("app-log") {
            match fs::remove_file(&path) {
                Ok(()) => deleted.push(name),
                Err(e) => log::warn!("reset_app_log remove {name} failed: {e}"),
            }
        }
    }
    log::info!("reset_app_log deleted: {}", deleted.join(","));
    Ok(deleted.join(","))
}

/// 切換 launcher icon（Android activity-alias 機制）。
/// name: "original" | "ocean" | "forest" | "sunset" | "midnight" | "lemon" | "mint" | "rose" | "graphite" | "cream"
#[tauri::command]
pub async fn set_launcher_icon(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<IconHandle>().0;
        handle
            .run_mobile_plugin::<serde_json::Value>(
                "setIcon",
                serde_json::json!({ "name": name }),
            )
            .map_err(|e| format!("Android icon switch: {:?}", e))?;
        log::info!("set_launcher_icon -> {}", name);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app_handle, &name);
        log::info!("set_launcher_icon ignored (non-Android)");
    }
    Ok(())
}
