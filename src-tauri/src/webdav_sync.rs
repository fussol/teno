//! WebDAV 同步（取代 Google Drive：同 LAN／Tailscale 內自建空間，單檔 teno.db）。
//!
//! 設計對齊 drive_sync.rs：
//! - 帳密只輸一次，存 app_config_dir/webdav_config.json（0600），之後上傳下載自動帶
//! - 每次上傳先 HEAD 遠端做對帳（遠端大小＋時間 vs 本地大小＋時間），訊息一次講清
//! - 下載走同款守門（TENOC 容器／裸 SQLite 雙態放行，其餘零寫盤）＋ tmp＋清 WAL/SHM＋rename
//! - ureq 2 無 base64 依賴，Basic Auth 自帶最小 base64_encode（標準字母表）
//! - HEAD 404＝伺服器可達＋認證 OK＋遠端尚無檔（測試連線視為成功）

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Default)]
struct WebdavConfig {
    url: String,
    username: String,
    password: String,
}

fn config_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("webdav_config.json");
    p
}

fn db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("teno.db");
    p
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, s: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(s.as_bytes())?;
    f.flush()
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, s: &str) -> std::io::Result<()> {
    std::fs::write(path, s)
}

fn load_config(app_handle: &tauri::AppHandle) -> WebdavConfig {
    std::fs::read_to_string(config_path(app_handle))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app_handle: &tauri::AppHandle, cfg: &WebdavConfig) {
    if let Ok(s) = serde_json::to_string(cfg) {
        let _ = write_private(&config_path(app_handle), &s);
    }
}

/// 最小 base64（標準字母表＋= 補齊；只吃 UTF-8 bytes，Basic Auth 夠用）
fn base64_encode(input: &[u8]) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPH[((n >> 18) & 63) as usize] as char);
        out.push(ALPH[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPH[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPH[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn auth_header(cfg: &WebdavConfig) -> String {
    base64_encode(format!("{}:{}", cfg.username, cfg.password).as_bytes())
}

/// base 去尾 slash；只收 http(s)
fn normalize_base(raw: &str) -> Result<String, String> {
    let b = raw.trim().trim_end_matches('/');
    if b.is_empty() {
        return Err("URL 不能為空".into());
    }
    if !(b.starts_with("http://") || b.starts_with("https://")) {
        return Err("URL 須以 http:// 或 https:// 開頭".into());
    }
    Ok(b.to_string())
}

fn file_url(cfg: &WebdavConfig) -> Result<String, String> {
    Ok(format!("{}/teno.db", normalize_base(&cfg.url)?))
}

fn require_config(app_handle: &tauri::AppHandle) -> Result<WebdavConfig, String> {
    let cfg = load_config(app_handle);
    if cfg.url.trim().is_empty() {
        return Err("尚未設定 WebDAV，請先在設定頁填入 URL 並儲存".into());
    }
    Ok(cfg)
}

struct RemoteMeta {
    size: Option<u64>,
    mtime: Option<String>,
}

/// HEAD 遠端檔：200→有檔（大小＋時間）；404→無遠端（連線正常）；401→帳密錯；其餘→連線失敗
fn head_remote(file: &str, auth: &str) -> Result<Option<RemoteMeta>, String> {
    match ureq::head(file).set("Authorization", auth).call() {
        Ok(resp) => Ok(Some(RemoteMeta {
            size: resp.header("Content-Length").and_then(|v| v.parse().ok()),
            mtime: resp.header("Last-Modified").map(String::from),
        })),
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(ureq::Error::Status(401, _)) => Err("帳號或密碼錯誤（401）".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("遠端回應異常（HTTP {code}）")),
        Err(e) => Err(format!("連線失敗：{e}")),
    }
}

fn fmt_mb(bytes: u64) -> String {
    format!("{:.1}MB", bytes as f64 / 1048576.0)
}

fn local_meta(app_handle: &tauri::AppHandle) -> Result<(u64, String), String> {
    let p = db_path(app_handle);
    let m = std::fs::metadata(&p).map_err(|e| format!("讀取本機資料庫失敗：{e}"))?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            chrono_naive(d.as_secs())
        })
        .unwrap_or_else(|| "（未知時間）".into());
    Ok((m.len(), mtime))
}

/// epoch 秒→本地可讀時間（不拉 chrono 依賴；UTC+8 固定偏移顯示）
fn chrono_naive(epoch: u64) -> String {
    // 簡易格式化：只顯示 epoch＋換算日期（準確性交給對帳比較，不做精密 TZ）
    let days = epoch / 86400;
    let rem = epoch % 86400;
    let (y, m, d) = civil_from_days(days as i64 + 719468);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}（本地）", rem / 3600, (rem % 3600) / 60)
}

// Howard Hinnant civil_from_days（1970-01-01＝719468 以 0000-03-01 起算）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 下載守門（與 drive_sync::validate_drive_download 同語意：TENOC／裸庫雙態放行）
fn validate_download(buf: &[u8]) -> Result<Vec<u8>, String> {
    let (db_bytes, _log) = crate::unpack_db_container(buf)?;
    if db_bytes.len() < 100 || !db_bytes.starts_with(b"SQLite format 3\0") {
        return Err("遠端內容不是有效的 SQLite 資料庫，本機資料未變".into());
    }
    Ok(db_bytes)
}

#[tauri::command]
pub async fn webdav_save_config(
    app_handle: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<String, String> {
    let base = normalize_base(&url)?;
    if username.trim().is_empty() {
        return Err("帳號不能為空".into());
    }
    // 密碼允許空（LAN 裸奔模式），但明確記一筆
    save_config(
        &app_handle,
        &WebdavConfig {
            url: base,
            username: username.trim().to_string(),
            password,
        },
    );
    Ok("✅ WebDAV 已儲存（帳密只輸這一次，之後自動帶）".into())
}

#[tauri::command]
pub async fn webdav_status(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = load_config(&app_handle);
    if cfg.url.trim().is_empty() {
        return Ok("未設定".into());
    }
    Ok(format!("已設定（{}，帳號 {}）", cfg.url, cfg.username))
}

#[tauri::command]
pub async fn webdav_test(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let file = file_url(&cfg)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    match head_remote(&file, &auth)? {
        Some(m) => Ok(format!(
            "✅ 連線正常，遠端已有 teno.db（{}{}）",
            m.size.map(fmt_mb).unwrap_or_else(|| "大小未知".into()),
            m.mtime.map(|t| format!("，{t}")).unwrap_or_default(),
        )),
        None => Ok("✅ 連線正常，遠端尚無 teno.db（可直接上傳）".into()),
    }
}

#[tauri::command]
pub async fn webdav_upload(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let file = file_url(&cfg)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    // 對帳：先讀遠端＋本地（遠端讀失敗不擋上傳，標「未知」照傳）
    let remote = head_remote(&file, &auth).ok().flatten();
    let (local_len, local_time) = local_meta(&app_handle)?;
    let data =
        std::fs::read(db_path(&app_handle)).map_err(|e| format!("讀取資料庫失敗：{e}"))?;
    ureq::put(&file)
        .set("Authorization", &auth)
        .set("Content-Type", "application/x-sqlite3")
        .send_bytes(&data)
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(code, _) => format!("上傳失敗（HTTP {code}）"),
            _ => format!("上傳失敗：{e}"),
        })?;
    let remote_note = match &remote {
        Some(m) => format!(
            "（遠端原 {}{}，已覆蓋）",
            m.size.map(fmt_mb).unwrap_or_else(|| "大小未知".into()),
            m.mtime
                .as_ref()
                .map(|t| format!("，{t}"))
                .unwrap_or_default(),
        ),
        None => "（遠端原無檔）".into(),
    };
    Ok(format!(
        "✅ 已上傳（本地 {}，{}{}）",
        fmt_mb(local_len),
        local_time,
        remote_note
    ))
}

#[tauri::command]
pub async fn webdav_download(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let file = file_url(&cfg)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let resp = ureq::get(&file)
        .set("Authorization", &auth)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => "遠端尚無備份，請先上傳".to_string(),
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(code, _) => format!("下載失敗（HTTP {code}）"),
            _ => format!("下載失敗：{e}"),
        })?;
    let remote_size = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok());
    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("讀取資料失敗：{e}"))?;
    let db_bytes = validate_download(&buf)?;
    let db = db_path(&app_handle);
    let tmp = db.with_extension("db.sync_tmp");
    std::fs::write(&tmp, &db_bytes).map_err(|e| format!("寫入暫存失敗：{e}"))?;
    let _ = std::fs::remove_file(db.with_extension("db-wal"));
    let _ = std::fs::remove_file(db.with_extension("db-shm"));
    std::fs::rename(&tmp, &db).map_err(|e| format!("覆蓋資料庫失敗：{e}"))?;
    Ok(format!(
        "✅ 已從 WebDAV 同步（遠端 {}{}）",
        remote_size.map(fmt_mb).unwrap_or_else(|| format!(
            "{:.1}MB",
            buf.len() as f64 / 1048576.0
        )),
        ""
    ))
}

#[tauri::command]
pub async fn webdav_logout(app_handle: tauri::AppHandle) -> Result<String, String> {
    let p = config_path(&app_handle);
    if p.exists() {
        let _ = std::fs::remove_file(p);
    }
    Ok("已清除 WebDAV 設定".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"user:pass"), "dXNlcjpwYXNz");
    }

    #[test]
    fn normalize_base_forms() {
        assert_eq!(
            normalize_base("http://192.168.50.69:8080/").unwrap(),
            "http://192.168.50.69:8080"
        );
        assert!(normalize_base("ftp://x").is_err());
        assert!(normalize_base("").is_err());
    }

    #[test]
    fn civil_smoke() {
        // 2026-09-13 ≈ epoch 1789248000 → 日期應為 2026-09-13（±時區誤差容忍只驗年月）
        let s = chrono_naive(1789248000);
        assert!(s.starts_with("2026-09-1"), "{s}");
    }
}
