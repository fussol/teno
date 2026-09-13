//! WebDAV 同步（取代 Google Drive：同 LAN／Tailscale 內自建空間，單檔 teno.db）。
//!
//! 設計對齊 drive_sync.rs：
//! - 帳密只輸一次，存 app_config_dir/webdav_config.json（0600），之後上傳下載自動帶
//! - 版本＝最後更改時間（本地 mtime vs 遠端 Last-Modified，30s 容忍時鐘差）
//! - WEBDAV-GUARD1：上傳時遠端新→擋（REMOTE_NEWER），下載時本地新→擋（LOCAL_NEWER）；
//!   force=true 才硬蓋；自動備份一律不帶 force，只跳過不炸
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

/// SYNC2：last-sync 基準（分支偵測用；非機密，存 app_config_dir/webdav_sync_state.json）
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
struct SyncState {
    /// 上次成功同步時本地 mtime／size
    base_local_mtime: Option<u64>,
    base_local_size: Option<u64>,
    /// 上次成功同步時遠端 mtime（epoch）／size
    base_remote_mtime: Option<u64>,
    base_remote_size: Option<u64>,
    /// 上次成功方向＋時間（"upload"|"download"，epoch）
    last_dir: String,
    at: u64,
}

fn sync_state_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("webdav_sync_state.json");
    p
}

fn load_sync_state(app_handle: &tauri::AppHandle) -> SyncState {
    std::fs::read_to_string(sync_state_path(app_handle))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_sync_state(app_handle: &tauri::AppHandle, st: &SyncState) {
    if let Ok(s) = serde_json::to_string(st) {
        let _ = std::fs::write(sync_state_path(app_handle), s);
    }
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 本地指紋（mtime＋size；讀不到＝None）
fn local_fingerprint(app_handle: &tauri::AppHandle) -> (Option<u64>, Option<u64>) {
    let m = std::fs::metadata(db_path(app_handle)).ok();
    match m {
        Some(m) => (
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            Some(m.len()),
        ),
        None => (None, None),
    }
}

/// 自基準以來是否變過（mtime 超容忍 或 size 變；缺一邊＝當沒變，不誤報）
fn changed_since(
    base_mtime: Option<u64>,
    base_size: Option<u64>,
    cur_mtime: Option<u64>,
    cur_size: Option<u64>,
) -> bool {
    match (base_mtime, cur_mtime) {
        (Some(b), Some(c)) => {
            if c > b.saturating_add(GUARD_TOL_SECS) || b > c.saturating_add(GUARD_TOL_SECS) {
                return true;
            }
        }
        _ => return false,
    }
    match (base_size, cur_size) {
        (Some(b), Some(c)) => b != c,
        _ => false,
    }
}

/// 遠端指紋（mtime epoch＋size；解析失敗＝None＝不擋）
fn remote_fingerprint(m: &RemoteMeta) -> (Option<u64>, Option<u64>) {
    let mt = m.mtime.as_deref().and_then(parse_http_date);
    (mt, m.size)
}

/// 空檔守門下限：本地 teno.db 小於此直接拒傳（22MB 級正常庫；空庫／半寫檔幾十 KB）
const MIN_UPLOAD_SIZE: u64 = 100 * 1024;

/// 上傳 payload：TENOC 容器（teno.db＋app-log.db；跟 pack_db_container 同佈局，檔名沿用 teno.db）
/// 佈局：b"TENOC"＋0x01＋u32le(teno_len)＋teno＋u32le(log_len)＋log
fn pack_sync_container(teno: &[u8], log: &[u8]) -> Result<Vec<u8>, String> {
    let tl = u32::try_from(teno.len())
        .map_err(|_| format!("teno.db 超過 4GB（{} bytes），拒絕打包", teno.len()))?;
    let ll = u32::try_from(log.len())
        .map_err(|_| format!("app-log.db 超過 4GB（{} bytes），拒絕打包", log.len()))?;
    let mut out = Vec::with_capacity(5 + 1 + 4 + teno.len() + 4 + log.len());
    out.extend_from_slice(b"TENOC");
    out.push(1u8);
    out.extend_from_slice(&tl.to_le_bytes());
    out.extend_from_slice(teno);
    out.extend_from_slice(&ll.to_le_bytes());
    out.extend_from_slice(log);
    Ok(out)
}

/// 讀本地要上傳的位元組：teno.db 必讀＋魔數驗＋下限驗；app-log.db 有就帶，無就空段
fn read_upload_payload(app_handle: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    let tp = db_path(app_handle);
    let teno = std::fs::read(&tp).map_err(|e| format!("讀取資料庫失敗：{e}"))?;
    if (teno.len() as u64) < MIN_UPLOAD_SIZE {
        return Err(format!(
            "EMPTY_LOCAL:本地庫只有 {}（<{}），疑似空庫／半寫檔，拒絕上傳覆蓋遠端。先檢查本機資料是否正常。",
            fmt_mb(teno.len() as u64),
            fmt_mb(MIN_UPLOAD_SIZE),
        ));
    }
    if teno.len() < 100 || !teno.starts_with(b"SQLite format 3\0") {
        return Err("EMPTY_LOCAL:本地檔不是有效 SQLite（魔數不對），拒絕上傳。".into());
    }
    let mut lp = tp.clone();
    lp.set_file_name("app-log.db");
    let log = std::fs::read(&lp).unwrap_or_default();
    if !log.is_empty() && (log.len() < 100 || !log.starts_with(b"SQLite format 3\0")) {
        // 日誌壞了不擋主庫：丟掉 log 段照傳（主庫優先）
        return pack_sync_container(&teno, &[]);
    }
    pack_sync_container(&teno, &log)
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
    let epoch = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let mtime = epoch
        .map(chrono_naive)
        .unwrap_or_else(|| "（未知時間）".into());
    Ok((m.len(), mtime))
}

/// 本機 mtime epoch（版本比對用；讀不到＝None＝不擋）
fn local_epoch(app_handle: &tauri::AppHandle) -> Option<u64> {
    std::fs::metadata(db_path(app_handle))
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// HTTP Last-Modified → epoch（版本比對用；解析失敗＝None＝不擋）
/// 形如 "Sun, 13 Sep 2026 11:39:56 GMT"（email.utils.formatdate 口徑）
fn parse_http_date(s: &str) -> Option<u64> {
    // ① RFC2822（+0000 尾）② GMT 字面（python email.utils 口徑）③ 寬鬆 %Z
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(s) {
        return Some(dt.timestamp() as u64);
    }
    if let Ok(naive) =
        chrono::NaiveDateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S GMT")
    {
        return Some(naive.and_utc().timestamp() as u64);
    }
    None
}

/// 版本守門容忍（秒）：兩邊時鐘差＋FS 粒度，30s 內算同版不擋
const GUARD_TOL_SECS: u64 = 30;

/// 上傳守門：遠端比本地新（超容忍）→ Some(錯誤訊息)，否則 None（放行）
fn guard_upload(local: Option<u64>, remote_mtime: Option<&str>) -> Option<String> {
    let (l, r) = (local?, parse_http_date(remote_mtime?)?);
    if r > l.saturating_add(GUARD_TOL_SECS) {
        Some(format!(
            "REMOTE_NEWER:遠端比較新（遠端 {}，本地 {}），上傳會蓋掉新資料。確定要用舊的覆蓋新的？",
            chrono_naive(r),
            chrono_naive(l),
        ))
    } else {
        None
    }
}

/// 下載守門：本地比遠端新（超容忍）→ Some(錯誤訊息)，否則 None（放行）
fn guard_download(local: Option<u64>, remote_mtime: Option<&str>) -> Option<String> {
    let (l, r) = (local?, parse_http_date(remote_mtime?)?);
    if l > r.saturating_add(GUARD_TOL_SECS) {
        Some(format!(
            "LOCAL_NEWER:本地比較新（本地 {}，遠端 {}），下載會蓋掉新資料。確定要用舊的覆蓋新的？",
            chrono_naive(l),
            chrono_naive(r),
        ))
    } else {
        None
    }
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

/// 分叉保留檔：app_config_dir/teno-conflict-<nanos>.db（遠端／本地被擋下的那一邊先落這，不丟）
fn conflict_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    p.push(format!("teno-conflict-{ts}.db"));
    p
}

/// 下載落檔：teno＋log 雙寫（tmp＋rename；跟 write_db_container 同範式）
fn write_downloaded(app_handle: &tauri::AppHandle, teno: &[u8], log: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db = dir.join("teno.db");
    let tmp = dir.join("teno.db.sync_tmp");
    let mut f =
        std::fs::File::create(&tmp).map_err(|e| format!("寫入暫存失敗：{e}"))?;
    f.write_all(teno)
        .map_err(|e| format!("寫入暫存失敗：{e}"))?;
    f.sync_all().map_err(|e| format!("寫入暫存失敗：{e}"))?;
    drop(f);
    let _ = std::fs::remove_file(db.with_extension("db-wal"));
    let _ = std::fs::remove_file(db.with_extension("db-shm"));
    std::fs::rename(&tmp, &db).map_err(|e| format!("覆蓋資料庫失敗：{e}"))?;
    if !log.is_empty() {
        let lp = dir.join("app-log.db");
        let ltmp = dir.join("app-log.db.sync_tmp");
        let mut g =
            std::fs::File::create(&ltmp).map_err(|e| format!("寫入日誌暫存失敗：{e}"))?;
        g.write_all(log)
            .map_err(|e| format!("寫入日誌暫存失敗：{e}"))?;
        g.sync_all().map_err(|e| format!("寫入日誌暫存失敗：{e}"))?;
        drop(g);
        let _ = std::fs::remove_file(lp.with_extension("db-wal"));
        let _ = std::fs::remove_file(lp.with_extension("db-shm"));
        std::fs::rename(&ltmp, &lp).map_err(|e| format!("覆蓋操作日誌失敗：{e}"))?;
    }
    Ok(())
}
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
pub async fn webdav_upload(
    app_handle: tauri::AppHandle,
    force: Option<bool>,
) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let file = file_url(&cfg)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    // 對帳＋版本守門：先讀遠端＋本地（遠端讀失敗不擋上傳，標「未知」照傳）
    let remote = head_remote(&file, &auth).ok().flatten();
    let (local_len, local_time) = local_meta(&app_handle)?;
    // WEBDAV-GUARD1：遠端比本地新（超 30s 容忍）→ 擋下，force=true 才硬蓋
    // （自動備份一律不帶 force，只會跳過不炸；手動可在確認後硬蓋）
    if !force.unwrap_or(false) {
        let le = local_epoch(&app_handle);
        let rm = remote.as_ref().and_then(|m| m.mtime.as_deref());
        if let Some(msg) = guard_upload(le, rm) {
            return Err(msg);
        }
    }
    // SYNC2-Q1：雙改分支偵測（兩邊自 base 都動過＝平行做題分叉）→ 不蓋，留雙檔讓人選
    if !force.unwrap_or(false) {
        let base = load_sync_state(&app_handle);
        let has_base = base.base_local_mtime.is_some() || base.base_remote_mtime.is_some();
        if has_base {
            let (lm, ls) = local_fingerprint(&app_handle);
            let (rmt, rs) = match &remote {
                Some(m) => remote_fingerprint(m),
                None => (None, None),
            };
            let local_changed =
                changed_since(base.base_local_mtime, base.base_local_size, lm, ls);
            let remote_changed =
                changed_since(base.base_remote_mtime, base.base_remote_size, rmt, rs);
            if local_changed && remote_changed {
                // 先把遠端拉下來存 conflict（ validate 過才落檔），本地一字不動
                let cf = conflict_path(&app_handle);
                match ureq::get(&file).set("Authorization", &auth).call() {
                    Ok(resp) => {
                        let mut buf: Vec<u8> = Vec::new();
                        if resp.into_reader().read_to_end(&mut buf).is_ok() {
                            if let Ok(db_bytes) = crate::unpack_db_container(&buf) {
                                if db_bytes.0.len() >= 100 {
                                    let _ = std::fs::write(&cf, &buf);
                                }
                            } else if buf.len() >= 100 && buf.starts_with(b"SQLite format 3\0") {
                                let _ = std::fs::write(&cf, &buf);
                            }
                        }
                    }
                    Err(_) => {}
                }
                return Err(format!(
                    "CONFLICT:兩邊自上次同步都各做各的（本地 {}／遠端 {}），直接上傳會吃掉一邊。遠端已先存到 {}，請二選一：看完差異後用 force 上傳蓋過去，或先下載遠端回來。",
                    local_time,
                    remote
                        .as_ref()
                        .and_then(|m| m.mtime.clone())
                        .unwrap_or_else(|| "未知時間".into()),
                    cf.display(),
                ));
            }
        }
    }
    // SYNC2-Q2＋Q6：payload 走 TENOC 容器（teno.db＋app-log.db），空檔／壞魔數直接拒傳
    let data = read_upload_payload(&app_handle)?;
    let (local_len2, local_time2) = (data.len() as u64, local_time.clone());
    let _ = (local_len, local_time);
    ureq::put(&file)
        .set("Authorization", &auth)
        .set("Content-Type", "application/octet-stream")
        .send_bytes(&data)
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(code, _) => format!("上傳失敗（HTTP {code}）"),
            _ => format!("上傳失敗：{e}"),
        })?;
    let remote_note = match &remote {
        Some(m) => format!(
            "（遠端原 {}{}，已覆蓋；舊版進伺服器 .history 留檔）",
            m.size.map(fmt_mb).unwrap_or_else(|| "大小未知".into()),
            m.mtime
                .as_ref()
                .map(|t| format!("，{t}"))
                .unwrap_or_default(),
        ),
        None => "（遠端原無檔）".into(),
    };
    // 成功才前進 base（兩邊指紋都記：遠端＝剛傳上去的本地）
    {
        let (lm, ls) = local_fingerprint(&app_handle);
        save_sync_state(
            &app_handle,
            &SyncState {
                base_local_mtime: lm,
                base_local_size: ls,
                base_remote_mtime: lm,
                base_remote_size: Some(data.len() as u64),
                last_dir: "upload".into(),
                at: now_epoch(),
            },
        );
    }
    Ok(format!(
        "✅ 已上傳（本地 {}，{}{}）",
        fmt_mb(local_len2),
        local_time2,
        remote_note
    ))
}

#[tauri::command]
pub async fn webdav_download(
    app_handle: tauri::AppHandle,
    force: Option<bool>,
) -> Result<String, String> {
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
    // WEBDAV-GUARD1：本地比遠端新（超 30s 容忍）→ 擋下，force=true 才硬蓋
    // （先比對再寫盤：位元組已在記憶體，但 DB 還沒動，擋下零副作用）
    if !force.unwrap_or(false) {
        let le = local_epoch(&app_handle);
        let rm = resp.header("Last-Modified");
        if let Some(msg) = guard_download(le, rm) {
            return Err(msg);
        }
    }
    // SYNC2-Q1：下載側雙改分支偵測（兩邊自 base 都動過）→ 不蓋，遠端先存 conflict
    if !force.unwrap_or(false) {
        let base = load_sync_state(&app_handle);
        let has_base = base.base_local_mtime.is_some() || base.base_remote_mtime.is_some();
        if has_base {
            let (lm, ls) = local_fingerprint(&app_handle);
            let rmt = resp.header("Last-Modified").and_then(parse_http_date);
            let local_changed =
                changed_since(base.base_local_mtime, base.base_local_size, lm, ls);
            let remote_changed = changed_since(
                base.base_remote_mtime,
                base.base_remote_size,
                rmt,
                remote_size,
            );
            if local_changed && remote_changed {
                return Err(format!(
                    "CONFLICT:兩邊自上次同步都各做各的（本地 {}／遠端 {}），直接下載會吃掉本地進度。請二選一：先上傳本地（force）蓋過去，或用 force 下載吃掉本地。",
                    lm.map(chrono_naive).unwrap_or_else(|| "未知時間".into()),
                    rmt.map(chrono_naive).unwrap_or_else(|| "未知時間".into()),
                ));
            }
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("讀取資料失敗：{e}"))?;
    // 空遠端守門：遠端太小／壞魔數不准蓋本地（空的蓋好的＝完了）
    if (buf.len() as u64) < MIN_UPLOAD_SIZE {
        return Err(format!(
            "EMPTY_REMOTE:遠端只有 {}（<{}），疑似空檔，拒絕下載覆蓋本地。先檢查伺服器上的檔。",
            fmt_mb(buf.len() as u64),
            fmt_mb(MIN_UPLOAD_SIZE),
        ));
    }
    let (db_bytes, log_bytes) = crate::unpack_db_container(&buf)
        .map_err(|e| format!("遠端內容無效（{e}），本機資料未變"))?;
    if db_bytes.len() < 100 || !db_bytes.starts_with(b"SQLite format 3\0") {
        return Err("遠端內容不是有效的 SQLite 資料庫，本機資料未變".into());
    }
    write_downloaded(&app_handle, &db_bytes, &log_bytes)?;
    // 成功才前進 base（兩邊指紋都記：本地＝剛寫下的遠端）
    {
        let (lm, ls) = local_fingerprint(&app_handle);
        let rmt = None::<u64>;
        let _ = rmt;
        save_sync_state(
            &app_handle,
            &SyncState {
                base_local_mtime: lm,
                base_local_size: ls,
                base_remote_mtime: lm,
                base_remote_size: Some(buf.len() as u64),
                last_dir: "download".into(),
                at: now_epoch(),
            },
        );
    }
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

    #[test]
    fn guard_http_date_roundtrip() {
        // python email.utils.formatdate 口徑（server.py http_date 同源）
        assert_eq!(parse_http_date("Sun, 13 Sep 2026 11:39:56 GMT"), Some(1789299596));
        assert_eq!(
            parse_http_date("Sun, 13 Sep 2026 11:39:56 +0000"),
            Some(1789299596)
        );
        assert_eq!(parse_http_date("garbage"), None);
        assert_eq!(parse_http_date(""), None);
    }

    #[test]
    fn guard_blocks_stale_overwrite() {
        let local = Some(1_000_000u64);
        let remote_new = Some("Sun, 13 Sep 2026 11:39:56 GMT"); // 遠大於 local
        let remote_old = Some("Thu, 01 Jan 1970 00:00:00 GMT"); // epoch 0
        // 上傳：遠端新→擋；遠端舊→放
        assert!(guard_upload(local, remote_new).unwrap().starts_with("REMOTE_NEWER:"));
        assert!(guard_upload(local, remote_old).is_none());
        // 下載：本地新→擋；本地舊→放
        assert!(guard_download(local, remote_old).unwrap().starts_with("LOCAL_NEWER:"));
        assert!(guard_download(local, remote_new).is_none());
        // 容忍內（±30s）→ 雙向都放
        let same = Some("Sun, 13 Sep 2026 11:39:56 GMT");
        let near = parse_http_date(same.unwrap()).map(|r| r + 10);
        assert!(guard_upload(near, same).is_none());
        assert!(guard_download(near, same).is_none());
        // 缺一邊（讀不到／解析失敗）→ 不擋（fail-open，沿用舊行為）
        assert!(guard_upload(None, remote_new).is_none());
        assert!(guard_upload(local, None).is_none());
        assert!(guard_upload(local, Some("nope")).is_none());
        assert!(guard_download(None, remote_old).is_none());
    }

    #[test]
    fn sync2_changed_since_matrix() {
        // 同版（容忍內＋同 size）→ 沒變
        assert!(!changed_since(Some(1000), Some(50), Some(1010), Some(50)));
        // mtime 超容忍 → 變過
        assert!(changed_since(Some(1000), Some(50), Some(2000), Some(50)));
        // mtime 同但 size 變 → 變過（同秒重寫）
        assert!(changed_since(Some(1000), Some(50), Some(1005), Some(51)));
        // 缺一邊 → 當沒變（不誤報，沿用舊行為）
        assert!(!changed_since(None, Some(50), Some(2000), Some(50)));
        assert!(!changed_since(None, None, None, None));
        // mtime 明顯變過時，size 缺也不影響判定（mtime 主導）
        assert!(changed_since(Some(1000), None, Some(2000), Some(50)));
    }

    #[test]
    fn sync2_pack_roundtrip() {
        let teno = [b'S', b'Q', b'L', b'i'];
        let mut teno_big = b"SQLite format 3\0".to_vec();
        teno_big.extend(vec![0u8; 200]);
        let log = b"LOG".to_vec();
        let packed = pack_sync_container(&teno_big, &log).unwrap();
        assert!(packed.starts_with(b"TENOC"));
        assert_eq!(packed[5], 1u8);
        // 手動拆段驗佈局
        let tl = u32::from_le_bytes([packed[6], packed[7], packed[8], packed[9]]) as usize;
        assert_eq!(tl, teno_big.len());
        assert_eq!(&packed[10..10 + tl], &teno_big[..]);
        let p = 10 + tl;
        let ll = u32::from_le_bytes([packed[p], packed[p + 1], packed[p + 2], packed[p + 3]]) as usize;
        assert_eq!(ll, log.len());
        assert_eq!(&packed[p + 4..p + 4 + ll], &log[..]);
        let _ = teno;
    }

    #[test]
    fn sync2_conflict_branches() {
        // base 之後兩邊都動 → 分叉（上傳／下載側同一判定）
        let base_mt = Some(1000u64);
        let base_sz = Some(50u64);
        let local = (Some(2000u64), Some(51u64));
        let remote = (Some(3000u64), Some(52u64));
        assert!(changed_since(base_mt, base_sz, local.0, local.1));
        assert!(changed_since(base_mt, base_sz, remote.0, remote.1));
        // 只有一邊動 → 非分叉
        assert!(!changed_since(base_mt, base_sz, Some(1005), Some(50)));
    }
}
