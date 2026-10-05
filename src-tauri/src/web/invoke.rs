// WEB-SERVE1：POST /api/invoke/{cmd} 分派。
// 契約（與 Tauri invoke 對齊，前端 wrapper 零判斷）：
//   請求 = JSON body（平鋪 args；無參也送 {} — Json extractor 拒空白 body）
//   成功 = 200 + JSON 回傳值；失敗 = 4xx/5xx + {"error": 字串}（前端 throw 字串）
//   頂層 key 走 camelCase（Tauri 同款：apiFormat→api_format），巢狀結構吃 serde derive 原樣。
// 黑名單 = 危險（run_cli RCE）或伺服器無意義（開 port / Android 殼）→ 403；
// 其餘未接線 command → 501，P3 逐條補。
use super::{err, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use serde::Deserialize;
use serde_json::Value;

// 危險/殼類：網頁版永不通過（安全邊界，勿放寬）
const BLACKLIST: &[&str] = &[
    "run_cli",                                          // 伺服器任意命令執行 → RCE
    "webdav_server_start", "webdav_server_stop",        // 伺服器開 port 供外部連線
    "webdav_server_get_config", "webdav_server_save_config",
    "webdav_server_status", "webdav_server_list_local", "webdav_server_delete_local",
    "set_launcher_icon", "get_launcher_icon",           // Android 殼
    "widget_get_status", "widget_save_config", "widget_refresh", "widget_request_perms",
    "speak_android", "stop_android", "list_voices_android", "finish_app",
    "save_export_file", "copy_uri_to_cache",            // Android 檔案/URI
    "import_db_dialog", "export_db_dialog", "export_bundle_dialog", "export_csv_dialog",
    "export_backup_dialog", "import_piper_model_dialog", "inspect_apkg_dialog",
    "import_share_pack_dialog", "export_db_to_downloads", // 原生對話框（P2 起由前端瀏覽器路徑吃掉，不進本端）
];

pub async fn handler(
    State(st): State<AppState>,
    Path(cmd): Path<String>,
    Extension(user): Extension<String>,
    axum::Json(args): axum::Json<Value>,
) -> Response {
    if BLACKLIST.contains(&cmd.as_str()) {
        return err(StatusCode::FORBIDDEN, "此功能僅桌面/手機版");
    }
    let args = if args.is_object() { args } else { Value::Object(Default::default()) };
    let ctx = crate::Ctx::web(st.data_dir.join("users").join(&user));
    match dispatch(&cmd, args, ctx).await {
        Ok(v) => axum::response::Json(v).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn dispatch(cmd: &str, a: Value, app_handle: crate::Ctx) -> Result<Value, String> {
    match cmd {
        "fetch_get" => {
            #[derive(Deserialize)] struct A { url: String }
            let a: A = parse(a)?;
            Ok(Value::String(crate::fetch_get(a.url).await?))
        }
        "fetch_llm" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                url: String, model: String, prompt: String,
                #[serde(default)] api_format: Option<String>,
                #[serde(default)] api_key: Option<String>,
                #[serde(default)] messages: Option<Vec<Value>>,
            }
            let a: A = parse(a)?;
            Ok(Value::String(crate::fetch_llm(
                a.url, a.model, a.prompt, a.api_format, a.api_key, a.messages,
            ).await?))
        }
        "lookup_merriam" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A { word: String, #[serde(default)] dict_key: Option<String>, #[serde(default)] thes_key: Option<String> }
            let a: A = parse(a)?;
            Ok(Value::String(crate::lookup_merriam(a.word, a.dict_key, a.thes_key).await?))
        }
        "scrape_quizlet" => {
            #[derive(Deserialize)] struct A { url: String }
            let a: A = parse(a)?;
            Ok(Value::String(crate::scrape_quizlet(a.url)?))
        }
        "zh_traditional" => {
            #[derive(Deserialize)] struct A { text: String }
            let a: A = parse(a)?;
            Ok(Value::String(crate::zh_traditional(a.text)))
        }
        "optimize_fsrs" => {
            #[derive(Deserialize)] struct A { reviews: Vec<crate::FsrsReviewEntry> }
            let a: A = parse(a)?;
            Ok(serde_json::to_value(crate::optimize_fsrs(a.reviews)?).map_err(|e| e.to_string())?)
        }
        "simulate_fsrs" => {
            #[derive(Deserialize)] struct A { req: crate::SimulateFsrsRequest }
            let a: A = parse(a)?;
            Ok(serde_json::to_value(crate::simulate_fsrs(a.req)?).map_err(|e| e.to_string())?)
        }
        "backup_db" => ok(crate::backup_db(app_handle)),
        "delete_backup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            filename: String,
            }
            let a: A = parse(a)?;
            ok(crate::delete_backup(app_handle, a.filename))
        }
        "delete_piper_model" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            name: String,
            }
            let a: A = parse(a)?;
            ok(crate::delete_piper_model(a.name, app_handle))
        }
        "export_app_log_text" => ok(crate::export_app_log_text(app_handle).await),
        "export_backup_data" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            filename: String,
            }
            let a: A = parse(a)?;
            ok(crate::export_backup_data(app_handle, a.filename).await)
        }
        "export_db_bundle_data" => ok(crate::export_db_bundle_data(app_handle).await),
        "export_db_data" => ok(crate::export_db_data(app_handle).await),
        "export_share_pack" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            csv: String,
            filename: String,
            word_ids: Vec<String>,
            }
            let a: A = parse(a)?;
            ok(crate::share_pack::export_share_pack(app_handle, a.csv, a.filename, a.word_ids).await)
        }
        "get_apkg_media" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            filename: String,
            token: Option<String>,
            }
            let a: A = parse(a)?;
            ok(crate::apkg::get_apkg_media(a.filename, app_handle, a.token).await)
        }
        "get_app_log_mtime" => ok(crate::get_app_log_mtime(app_handle)),
        "get_app_paths" => ok(crate::get_app_paths(app_handle)),
        "get_db_mtime" => ok(crate::get_db_mtime(app_handle)),
        "get_share_media" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            filename: String,
            token: Option<String>,
            }
            let a: A = parse(a)?;
            ok(crate::share_pack::get_share_media(app_handle, a.filename, a.token).await)
        }
        "import_app_log_text" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            text: String,
            }
            let a: A = parse(a)?;
            ok(crate::import_app_log_text(app_handle, a.text).await)
        }
        "install_piper_model" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            url: String,
            }
            let a: A = parse(a)?;
            ok(crate::install_piper_model(a.url, app_handle))
        }
        "list_backups" => ok(crate::list_backups(app_handle)),
        "list_piper_voices" => ok(crate::list_piper_voices(app_handle)),
        "log_msg" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            msg: String,
            }
            let a: A = parse(a)?;
            crate::log_msg(a.msg, app_handle);
            Ok(Value::Null)
        }
        "lookup_cambridge" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            word: String,
            lang: Option<String>,
            }
            let a: A = parse(a)?;
            ok(crate::lookup_cambridge(a.word, a.lang, app_handle).await)
        }
        "media_get" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            sha: String,
            ext: Option<String>,
            }
            let a: A = parse(a)?;
            ok(crate::media_store::media_get(app_handle, a.sha, a.ext).await)
        }
        "media_list" => ok(crate::media_store::media_list(app_handle).await),
        "media_put" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            data: String,
            filename: Option<String>,
            }
            let a: A = parse(a)?;
            ok(crate::media_store::media_put(app_handle, a.data, a.filename).await)
        }
        "prune_backups" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            max_count: u32,
            }
            let a: A = parse(a)?;
            ok(crate::prune_backups(app_handle, a.max_count))
        }
        "reset_app_log" => ok(crate::icon_android::reset_app_log(app_handle).await),
        "restore_backup" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            filename: String,
            }
            let a: A = parse(a)?;
            ok(crate::restore_backup(app_handle, a.filename))
        }
        "speak_text" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            text: String,
            voice: Option<String>,
            length_scale: Option<f64>,
            noise_scale: Option<f64>,
            }
            let a: A = parse(a)?;
            ok(crate::speak_text(a.text, a.voice, a.length_scale, a.noise_scale, app_handle).await)
        }
        "tts_synthesize" => {
            // WEB-SERVE1：伺服器 Piper 合成 → 回 base64 WAV 給瀏覽器播放（不本機出聲）
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                text: String,
                voice: Option<String>,
                length_scale: Option<f64>,
                noise_scale: Option<f64>,
            }
            let a: A = parse(a)?;
            Ok(Value::String(crate::tts_synthesize(a.text, a.voice, a.length_scale, a.noise_scale, app_handle).await?))
        }
        "sql_tx" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            statements: Vec<crate::TxStmt>,
            }
            let a: A = parse(a)?;
            ok(crate::sql_tx(app_handle, a.statements).await)
        }
        "webdav_cloud_delete" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            path: String,
            }
            let a: A = parse(a)?;
            ok(crate::webdav_sync::webdav_cloud_delete(app_handle, a.path).await)
        }
        "webdav_cloud_get" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            path: String,
            }
            let a: A = parse(a)?;
            ok(crate::webdav_sync::webdav_cloud_get(app_handle, a.path).await)
        }
        "webdav_cloud_list" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            path: Option<String>,
            }
            let a: A = parse(a)?;
            ok(crate::webdav_sync::webdav_cloud_list(app_handle, a.path).await)
        }
        "webdav_download" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            force: Option<bool>,
            }
            let a: A = parse(a)?;
            ok(crate::webdav_sync::webdav_download(app_handle, a.force).await)
        }
        "webdav_log_archive_prune" => ok(crate::webdav_sync::webdav_log_archive_prune(app_handle).await),
        "webdav_log_archive_status" => ok(crate::webdav_sync::webdav_log_archive_status(app_handle).await),
        "webdav_log_archive_upload" => ok(crate::webdav_sync::webdav_log_archive_upload(app_handle).await),
        "webdav_logout" => ok(crate::webdav_sync::webdav_logout(app_handle).await),
        "webdav_media_download" => ok(crate::webdav_sync::webdav_media_download(app_handle).await),
        "webdav_media_upload" => ok(crate::webdav_sync::webdav_media_upload(app_handle).await),
        "webdav_patch_download" => ok(crate::webdav_sync::webdav_patch_download(app_handle).await),
        "webdav_patch_upload" => ok(crate::webdav_sync::webdav_patch_upload(app_handle).await),
        "webdav_save_config" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            url: String,
            username: String,
            password: String,
            }
            let a: A = parse(a)?;
            ok(crate::webdav_sync::webdav_save_config(app_handle, a.url, a.username, a.password).await)
        }
        "webdav_status" => ok(crate::webdav_sync::webdav_status(app_handle).await),
        "webdav_test" => ok(crate::webdav_sync::webdav_test(app_handle).await),
        "webdav_upload" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
            force: Option<bool>,
            }
            let a: A = parse(a)?;
            ok(crate::webdav_sync::webdav_upload(app_handle, a.force).await)
        }
        // WEB：匯入三件套（瀏覽器 <input type=file> → bytes；Rust 與 dialog 同一條核心路）
        "write_db_bytes" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                data: Vec<u8>,
            }
            let a: A = parse(a)?;
            ok(crate::write_db_bytes(app_handle, a.data))
        }
        "import_share_pack_bytes" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                data: Vec<u8>,
                file_name: String,
            }
            let a: A = parse(a)?;
            ok(crate::share_pack::import_share_pack_bytes(app_handle, a.data, a.file_name).await)
        }
        "inspect_apkg_data" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                data: Vec<u8>,
                file_name: String,
            }
            let a: A = parse(a)?;
            ok(crate::apkg::inspect_apkg_data(app_handle, a.data, a.file_name).await)
        }
        _ => Err(format!("尚未接線（WEB-SERVE P3）: {cmd}")),
    }
}

// Result<T: Serialize> → Tauri invoke 回傳值（serde_json 與 Tauri 同一條路）
fn ok<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

// 參數型別錯誤要照 Tauri 語意 reject 字串，不能變成 500 內部錯 → 分派層先攔
fn parse<T: for<'de> Deserialize<'de>>(a: Value) -> Result<T, String> {
    serde_json::from_value(a).map_err(|e| format!("參數錯誤: {e}"))
}
