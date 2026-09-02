use tauri::{
    Manager,
    plugin::{self, PluginApi},
};
use serde::Deserialize;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.teno.app";

#[derive(Clone)]
pub struct TtsHandle(pub plugin::PluginHandle<tauri::Wry>);

#[derive(Deserialize)]
struct VoicesResponse { voices: Vec<VoiceInfo> }

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct VoiceInfo { pub name: String, pub language: String }

pub fn init() -> plugin::TauriPlugin<tauri::Wry> {
    plugin::Builder::new("teno_tts")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "TtsPlugin")?;
                app.manage(TtsHandle(handle));
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn speak_android(
    app_handle: tauri::AppHandle,
    text: String,
    voice: Option<String>,
    speed: Option<f64>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        handle
            .run_mobile_plugin::<serde_json::Value>(
                "speak",
                serde_json::json!({
                    "text": text,
                    "voice": voice.unwrap_or_default(),
                    "speed": speed.unwrap_or(1.0),
                }),
            )
            .map_err(|e| format!("Android TTS: {:?}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_android(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        handle
            .run_mobile_plugin::<serde_json::Value>("stop", serde_json::json!({}))
            .map_err(|e| format!("Android TTS stop: {:?}", e))?;
    }
    Ok(())
}

// F1：Android back/退出 — run_mobile_plugin 轉發到 Kotlin TtsPlugin.finishApp（finishAndRemoveTask）。
// 非 Android：no-op Ok(())（cfg block 在函數體內，與 stop_android 同款）— __handleAndroidBack 僅 Android native 呼叫，desktop 零影響。
#[tauri::command]
pub async fn finish_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        handle
            .run_mobile_plugin::<serde_json::Value>("finishApp", serde_json::json!({}))
            .map_err(|e| format!("Android finish: {:?}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn save_export_file(
    app_handle: tauri::AppHandle,
    filename: String,
    data_b64: String,
    mime: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        handle
            .run_mobile_plugin::<serde_json::Value>(
                "saveExportFile",
                serde_json::json!({
                    "filename": filename,
                    "data": data_b64,
                    "mime": mime.unwrap_or_else(|| "application/octet-stream".into()),
                }),
            )
            .map_err(|e| format!("Android save export: {:?}", e))?;
        Ok("saved".into())
    }
    #[cfg(not(target_os = "android"))]
    Ok(String::new())
}

#[tauri::command]
pub async fn copy_uri_to_cache(app_handle: tauri::AppHandle, uri: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        let resp = handle
            .run_mobile_plugin::<serde_json::Value>(
                "copyUriToCache",
                serde_json::json!({ "uri": uri }),
            )
            .map_err(|e| format!("Android copy URI: {:?}", e))?;
        resp["path"].as_str().map(String::from).ok_or_else(|| "無法取得複製路徑".into())
    }
    #[cfg(not(target_os = "android"))]
    Err("僅 Android 支援".into())
}

#[tauri::command]
pub async fn list_voices_android(app_handle: tauri::AppHandle) -> Result<Vec<VoiceInfo>, String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        let resp = handle
            .run_mobile_plugin::<VoicesResponse>("listVoices", serde_json::json!({}))
            .map_err(|e| format!("Android TTS list: {:?}", e))?;
        return Ok(resp.voices);
    }
    #[cfg(not(target_os = "android"))]
    Ok(Vec::new())
}
