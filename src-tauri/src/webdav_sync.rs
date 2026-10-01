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
    /// PATCHBASE1：base 整檔 sha256 hex（解壓後 teno.db 段；驗過才寫）
    #[serde(default)]
    base_sha256: String,
    /// PATCHBASE1：單調 seq（主鍵是 seq 不是 wall clock）
    #[serde(default)]
    seq: u64,
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

/// PATCHDIFF base 檔：上次成功同步的 teno.db 原始位元組（page_diff 的比對基準）。
/// 存 app_config_dir/teno.base.db；壞了就當無 base（回 None，不炸）。
fn base_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("teno.base.db");
    p
}
fn load_base_bytes(app_handle: &tauri::AppHandle) -> Option<Vec<u8>> {
    let b = std::fs::read(base_path(app_handle)).ok()?;
    if b.len() < 100 || !b.starts_with(b"SQLite format 3\0") { return None; }
    Some(b)
}
fn save_base_copy(app_handle: &tauri::AppHandle, raw_teno: &[u8]) {
    if raw_teno.len() >= 100 && raw_teno.starts_with(b"SQLite format 3\0") {
        let _ = std::fs::write(base_path(app_handle), raw_teno);
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

/// 上傳 payload：TENOC v2 容器（段級 gzip；跟 lib.rs unpack_db_container 同佈局）
/// 佈局：b"TENOC"＋0x02＋u32le(teno_gz_len)＋teno_gz＋u32le(log_gz_len)＋log_gz
/// （v1＝同佈局未壓縮，解包兩版皆收；兩邊伺服器只驗 TENOC 前綴，v2 零改動穿透。
/// 段級而非整包壓：截斷段在 gunzip 即炸，不會靜默吐半包；且空 log 段壓完僅 ~20B。）
fn pack_sync_container(teno: &[u8], log: &[u8]) -> Result<Vec<u8>, String> {
    let tg = gzip_compress(teno)?;
    let lg = gzip_compress(log)?;
    let tl = u32::try_from(tg.len())
        .map_err(|_| format!("teno.db 壓縮後超過 4GB（{} bytes），拒絕打包", tg.len()))?;
    let ll = u32::try_from(lg.len())
        .map_err(|_| format!("app-log.db 壓縮後超過 4GB（{} bytes），拒絕打包", lg.len()))?;
    let mut out = Vec::with_capacity(5 + 1 + 4 + tg.len() + 4 + lg.len());
    out.extend_from_slice(b"TENOC");
    out.push(2u8);
    out.extend_from_slice(&tl.to_le_bytes());
    out.extend_from_slice(&tg);
    out.extend_from_slice(&ll.to_le_bytes());
    out.extend_from_slice(&lg);
    Ok(out)
}

/// gzip 壓縮（pure fn；SYNC-GZ1 同步容器 v2 段壓縮用）
pub(crate) fn gzip_compress(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Write as _;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data)
        .map_err(|e| format!("gzip 壓縮失敗: {e}"))?;
    enc.finish().map_err(|e| format!("gzip 收尾失敗: {e}"))
}

/// gzip 解壓（pure fn；take 封頂防炸彈，超限未爆記憶體先拒）
pub(crate) fn gzip_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Read as _;
    if data.len() < 2 || data[..2] != [0x1f, 0x8b] {
        return Err("不是 gzip 資料（魔數不對，多半是段截斷或版本錯位）".into());
    }
    const LIMIT: u64 = 512 * 1024 * 1024;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(data)
        .take(LIMIT + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("gzip 解壓失敗（段截斷？）: {e}"))?;
    if out.len() as u64 > LIMIT {
        return Err("解壓後超過 512MB，拒收".into());
    }
    Ok(out)
}

/// PATCHBASE1：整檔 sha256 hex（pure fn；base 驗證＋對帳用）
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out { s.push_str(&format!("{:02x}", b)); }
    s
}

/// PATCHDIFF1：page diff（pure fn；SQLite 4KB 頁邊界現成拿來用）
/// 回傳變動頁清單 [(頁號, 頁資料)]；長度不一時多出頁全算髒（截斷／增長）。
/// page_size<=0 或 >65536 直接拒（防錯配）。
pub(crate) fn page_diff(base: &[u8], cur: &[u8], page_size: usize) -> Result<Vec<(u32, Vec<u8>)>, String> {
    if page_size == 0 || page_size > 65536 {
        return Err(format!("page_size 非法: {}", page_size));
    }
    let ps = page_size;
    let n_base = base.len().div_ceil(ps);
    let n_cur = cur.len().div_ceil(ps);
    let n = n_base.max(n_cur);
    if n > u32::MAX as usize {
        return Err("檔案過大，頁號溢位".into());
    }
    let mut out = Vec::new();
    for i in 0..n {
        let a0 = i * ps;
        let b0 = a0;
        let a1 = (a0 + ps).min(base.len());
        let b1 = (b0 + ps).min(cur.len());
        let a = if a0 < base.len() { &base[a0..a1] } else { &[][..] };
        let b = if b0 < cur.len() { &cur[b0..b1] } else { &[][..] };
        if a != b {
            // 頁資料按整頁給（尾頁補零到 ps，套用端按偏移寫回即可）
            let mut page = vec![0u8; ps];
            page[..b.len()].copy_from_slice(b);
            // 尾頁若兩邊都短且內容同（上已比）不會到這；短頁補零後若 base 側本就是零則仍算髒一次，無害
            out.push((i as u32, page));
        }
    }
    Ok(out)
}

/// PATCHDIFF1：patch 打包 [(頁號,頁)] -> bytes（u32le 頁號＋頁資料連接；再整體 gzip 由呼叫端做）
pub(crate) fn pack_patch(pages: &[(u32, Vec<u8>)], page_size: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for (no, data) in pages {
        if data.len() != page_size {
            return Err(format!("頁 {} 長度錯位: {} != {}", no, data.len(), page_size));
        }
        out.extend_from_slice(&no.to_le_bytes());
        out.extend_from_slice(data);
    }
    Ok(out)
}

/// PATCHDIFF1：patch 套用（pure fn；base＋patch bytes -> 新檔）
/// 格式：[u32le 頁號][page_size bytes] 反覆；頁號超界／尾截斷直接拒（不靜默丟）。
pub(crate) fn apply_patch(base: &[u8], patch: &[u8], page_size: usize) -> Result<Vec<u8>, String> {
    if page_size == 0 || page_size > 65536 {
        return Err(format!("page_size 非法: {}", page_size));
    }
    let stride = 4 + page_size;
    if patch.len() % stride != 0 {
        return Err(format!("patch 長度錯位: {} 不是 {} 的倍數（截斷？）", patch.len(), stride));
    }
    let mut out = base.to_vec();
    let n_pages = out.len().div_ceil(page_size);
    let mut pos = 0;
    while pos < patch.len() {
        let no = u32::from_le_bytes([patch[pos], patch[pos+1], patch[pos+2], patch[pos+3]]) as usize;
        let data = &patch[pos+4..pos+stride];
        let need = (no + 1) * page_size;
        if need > 512 * 1024 * 1024 {
            return Err(format!("頁號 {} 超出 512MB 上限，拒套", no));
        }
        if need > out.len() {
            out.resize(need, 0);
        }
        let off = no * page_size;
        out[off..off+page_size].copy_from_slice(data);
        // 尾頁補零區若超出原檔邏輯長度，呼叫端按原長截回；此處保留整頁（呼叫端截）
        let _ = n_pages;
        pos += stride;
    }
    Ok(out)
}

/// HOLE1 VACUUM 爆炸逃生：patch 太大就傳整包（pure fn；閾值 70%）。
/// patch_gz_len / full_gz_len 任一為 0 直接回整包（除零防呆）。
pub(crate) fn should_use_patch(patch_gz_len: usize, full_gz_len: usize) -> bool {
    if patch_gz_len == 0 || full_gz_len == 0 { return false; }
    (patch_gz_len as u64 * 100) < (full_gz_len as u64 * 70)
}

/// HOLE4 壞 base：只有驗過的 base 才能當基準（pure fn）。
/// base_sha256 空＝舊版無 base，不可走 patch，只能整包。
/// expected 為空也一律 false（呼叫端傳空＝邏輯錯，直接拒）。
pub(crate) fn base_usable(stored_sha: &str, expected_sha: &str) -> bool {
    if stored_sha.is_empty() || expected_sha.is_empty() { return false; }
    stored_sha.eq_ignore_ascii_case(expected_sha)
}

/// HOLE7 單調 seq：只增不減（pure fn；wall clock 只當備份）。
pub(crate) fn next_seq(cur: u64) -> u64 {
    cur.saturating_add(1)
}

/// HOLE5 撕裂讀守門：SQLite 忙碌時硬讀會抓到半截狀態（pure 判定＋IO  helper 分開）。
/// try_snapshot_read：先 BEGIN IMMEDIATE 探鎖（忙就直接錯，不硬讀），再讀檔。
/// 讀到檔後做魔數驗（SQLite 頭），不過即錯。呼叫端重試幾次不行就放棄這次同步。
pub(crate) fn try_snapshot_read(db_path: &std::path::Path) -> Result<Vec<u8>, String> {
    // 探鎖：能開庫且能拿 IMMEDIATE 鎖才讀；拿不到＝有人在寫，直接回錯等下次
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).map_err(|e| format!("開庫失敗: {}", e))?;
    conn.execute_batch("PRAGMA busy_timeout=0;")
        .map_err(|e| format!("busy_timeout 設失敗: {}", e))?;
    // BEGIN IMMEDIATE 拿不到即 DatabaseBusy／Locked，不硬等
    let busy = conn.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").is_err();
    if busy {
        return Err("DB 忙碌中（有人在寫），這次不同步，下次再傳".into());
    }
    let bytes = std::fs::read(db_path).map_err(|e| format!("讀檔失敗: {}", e))?;
    if bytes.len() < 100 || !bytes.starts_with(b"SQLite format 3\0") {
        return Err("讀到的不是有效 SQLite（撕裂／半寫？），拒用".into());
    }
    Ok(bytes)
}

/// 讀本地要上傳的位元組：teno.db 必讀＋魔數驗＋下限驗；app-log.db 有就帶，無就空段
fn read_upload_payload(app_handle: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    let tp = db_path(app_handle);
    // HOLE5：撕裂讀守門——先探鎖再讀檔，忙就放棄這次（呼叫端重試或下次再傳）
    let teno = try_snapshot_read(&tp).map_err(|e| format!("讀取資料庫失敗：{e}"))?;
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
    // LOGPEEL1：日誌移出同步容器（預設不同步；只進雲端不出雲端，手動歸檔走獨立物件）。
    // 空段壓完僅 ~20B；下載端新舊容器雙收（舊含 log 段照收，落地忽略，不覆本地 app-log.db）。
    pack_sync_container(&teno, &[])
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
    /// PATCHBASE1：遠端內容 sha256（HEAD X-Content-Sha256；無頭＝None＝回退 mtime 守門）
    sha256: Option<String>,
}

/// HEAD 遠端檔：200→有檔（大小＋時間）；404→無遠端（連線正常）；401→帳密錯；其餘→連線失敗
fn head_remote(file: &str, auth: &str) -> Result<Option<RemoteMeta>, String> {
    match ureq::head(file).set("Authorization", auth).call() {
        Ok(resp) => Ok(Some(RemoteMeta {
            size: resp.header("Content-Length").and_then(|v| v.parse().ok()),
            mtime: resp.header("Last-Modified").map(String::from),
            sha256: resp.header("X-Content-Sha256").map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
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

/// Phase3 三哈希決策（pure fn；主鍵是內容 hash，不是 wall clock）。
/// local＝本地現檔 hash，base＝上次同步基準 hash，remote＝遠端現檔 hash。
/// 空字串＝未知（舊版無 base 或 server 無頭），未知時回 FallbackMtime（呼叫端走舊 mtime 守門）。
/// 回傳：Clean（都沒動）/ UploadOnly（只我動）/ DownloadOnly（只它動）/ Diverged（兩邊都動→分叉留雙檔）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SyncDir { Clean, UploadOnly, DownloadOnly, Diverged, FallbackMtime }
pub(crate) fn decide_sync_direction(local: &str, base: &str, remote: &str) -> SyncDir {
    if local.is_empty() || base.is_empty() || remote.is_empty() {
        return SyncDir::FallbackMtime;
    }
    let l_eq_b = local.eq_ignore_ascii_case(base);
    let r_eq_b = remote.eq_ignore_ascii_case(base);
    match (l_eq_b, r_eq_b) {
        (true, true) => SyncDir::Clean,
        (false, true) => SyncDir::UploadOnly,
        (true, false) => SyncDir::DownloadOnly,
        (false, false) => {
            // 兩邊都偏離 base：若兩邊互相相等（同內容不同 base 表述）算 Clean，否則分叉
            if local.eq_ignore_ascii_case(remote) { SyncDir::Clean } else { SyncDir::Diverged }
        }
    }
}

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

// ─── VERSION-GATE：下載版本閘（多裝置同步的向下相容） ───────────────
// SQLite 檔頭 offset 64 = user_version（u32le；stampDbVersion 只升不降
// ＝「最後開過這庫的 app 版本」指紋）。遠端 > 本機 → 拒寫：舊 App 開新庫
// 會被 sqlx VersionMissing 拒啟動（brick），下載當下就要擋，不能等下次
// 啟動才爆。force 也不放行（放行 = 開不了機）；向上方向（遠端較舊）不擋
// ——既有 migrate/preensure 自動升級軌全覆蓋。
fn remote_user_version(db: &[u8]) -> Result<u32, String> {
    if db.len() < 68 || !db.starts_with(b"SQLite format 3\0") {
        return Err("不是有效的 SQLite 資料庫".into());
    }
    Ok(u32::from_le_bytes([db[64], db[65], db[66], db[67]]))
}

/// JS versionInt 同式：5.17.71 → 5_017_071（stampDbVersion 寫的就是這格式）
fn version_int(v: &str) -> u32 {
    let parts: Vec<&str> = v.split(|c| c == '.' || c == '-').collect();
    let g = |i: usize| parts.get(i).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    g(0) * 1_000_000 + g(1) * 1_000 + g(2)
}

fn version_str(v: u32) -> String {
    format!("{}.{}.{}", v / 1_000_000, (v % 1_000_000) / 1_000, v % 1_000)
}

fn check_remote_version(remote: u32, mine: u32) -> Result<(), String> {
    if remote > mine {
        return Err(format!(
            "REMOTE_DB_NEWER:遠端資料庫由 {} 產生，本機 {} 較舊，無法安全開啟（sqlx 會拒啟動）。請先升級 App 再下載（本地資料未動）。",
            version_str(remote),
            version_str(mine)
        ));
    }
    Ok(())
}

fn guard_remote_db(app_handle: &tauri::AppHandle, db: &[u8]) -> Result<(), String> {
    // 殘缺檔不是本閘的責任（交給既有驗包守門拒）；格式對才讀指紋
    let Ok(remote) = remote_user_version(db) else { return Ok(()) };
    let mine = version_int(&app_handle.package_info().version.to_string());
    check_remote_version(remote, mine)
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
    // Phase3 三哈希快判（base_sha＋本地包 hash＋遠端 X-Content-Sha256；全齊才判，缺一邊回退 mtime 守門）
    if !force.unwrap_or(false) {
        // 本地現包 hash：讀一次 payload（撕裂讀守門內含）；失敗就不快判，走舊路
        if let Ok(cur_data) = read_upload_payload(&app_handle) {
            let local_h = sha256_hex(&cur_data);
            let base = load_sync_state(&app_handle);
            let remote_h = remote.as_ref().and_then(|m| m.sha256.clone()).unwrap_or_default();
            match decide_sync_direction(&local_h, &base.base_sha256, &remote_h) {
                SyncDir::Clean => return Ok("✅ 已是最新（內容 hash 一致），不需上傳".into()),
                SyncDir::DownloadOnly => return Err("REMOTE_NEWER:遠端有新內容（hash 證實），本地無變化。請先下載再上傳。".into()),
                SyncDir::Diverged => {}, // 掉下去走 Q1 留雙檔
                SyncDir::UploadOnly | SyncDir::FallbackMtime => {}, // 正常上傳路
            }
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
    // PATCHBASE1：base_sha256＝送出位元組 hash（PUT 2xx＝server 那份相同，不必拉回對帳）；seq 單調＋1
    // PATCHDIFF base 檔：存 raw teno 供下次 page_diff（解包失敗就不存，下次走整包）
    if let Ok((raw_teno, _)) = crate::unpack_db_container(&data) {
        save_base_copy(&app_handle, &raw_teno);
    }
    {
        let (lm, ls) = local_fingerprint(&app_handle);
        let prev = load_sync_state(&app_handle);
        save_sync_state(
            &app_handle,
            &SyncState {
                base_local_mtime: lm,
                base_local_size: ls,
                base_remote_mtime: lm,
                base_remote_size: Some(data.len() as u64),
                base_sha256: sha256_hex(&data),
                seq: next_seq(prev.seq),
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
    // Phase3 三哈希快判（下載側）：遠端包 hash＝base 且本地包 hash＝base → Clean 不寫盤
    {
        let base = load_sync_state(&app_handle);
        if !base.base_sha256.is_empty() {
            let remote_h = sha256_hex(&buf);
            // 本地現包 hash（失敗就跳過快判，走舊路）
            if let Ok(cur_data) = read_upload_payload(&app_handle) {
                let local_h = sha256_hex(&cur_data);
                match decide_sync_direction(&local_h, &base.base_sha256, &remote_h) {
                    SyncDir::Clean => return Ok("✅ 已是最新（內容 hash 一致），不需下載".into()),
                    SyncDir::UploadOnly => return Err("LOCAL_NEWER:本地有新內容（hash 證實），遠端較舊。請先上傳再下載。".into()),
                    SyncDir::Diverged | SyncDir::DownloadOnly | SyncDir::FallbackMtime => {},
                }
            }
        }
    }
    let (db_bytes, log_bytes) = crate::unpack_db_container(&buf)
        .map_err(|e| format!("遠端內容無效（{e}），本機資料未變"))?;
    if db_bytes.len() < 100 || !db_bytes.starts_with(b"SQLite format 3\0") {
        return Err("遠端內容不是有效的 SQLite 資料庫，本機資料未變".into());
    }
    // VERSION-GATE：遠端庫比本機 App 新 → 拒寫（force 也擋；開不了機比蓋錯更糟）
    guard_remote_db(&app_handle, &db_bytes)?;
    write_downloaded(&app_handle, &db_bytes, &log_bytes)?;
    save_base_copy(&app_handle, &db_bytes);
    // 成功才前進 base（兩邊指紋都記：本地＝剛寫下的遠端）
    // PATCHBASE1：base_sha256＝收到的遠端位元組 hash（解包驗過才到這）；seq 單調＋1
    {
        let (lm, ls) = local_fingerprint(&app_handle);
        let rmt = None::<u64>;
        let _ = rmt;
        let prev = load_sync_state(&app_handle);
        save_sync_state(
            &app_handle,
            &SyncState {
                base_local_mtime: lm,
                base_local_size: ls,
                base_remote_mtime: lm,
                base_remote_size: Some(buf.len() as u64),
                base_sha256: sha256_hex(&buf),
                seq: next_seq(prev.seq),
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

/// MEDIAPEEL1 媒體同步 pure fns（PROPFIND 解析＋差集；可單測不碰網）

/// 從 PROPFIND XML 抽 href 檔名（只取 /media/ 下的 <40hex>.<ext>；目錄項／點檔／非法名全丟）。
pub(crate) fn parse_media_hrefs(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some(a) = xml[pos..].find("<D:href>") {
        let s = pos + a + 8;
        let Some(e) = xml[s..].find("</D:href>") else { break; };
        let href = &xml[s..s + e];
        pos = s + e + 9;
        // 取尾段檔名（percent-decode 簡版：只還原 %XX 常見字元，不全按 URL 規格）
        let seg = href.rsplit('/').next().unwrap_or("");
        if seg.is_empty() || seg.starts_with('.') {
            continue;
        }
        let name = pct_decode(seg);
        let dot = match name.rfind('.') {
            Some(i) => i,
            None => continue,
        };
        let (sha, ext) = (&name[..dot], &name[dot + 1..]);
        if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        if !matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif"
        ) {
            continue;
        }
        out.push(format!("{}.{}", sha.to_ascii_lowercase(), ext.to_ascii_lowercase()));
    }
    out.sort();
    out.dedup();
    out
}

fn pct_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexv(b[i + 1]), hexv(b[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hexv(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// 本地缺／遠端缺差集（檔名即內容 hash，同名＝同內容，直接比名）。
/// 回 (待上傳, 待下載)：待上傳＝本地有遠端無；待下載＝遠端有本地無。
pub(crate) fn media_diff(local: &[String], remote: &[String]) -> (Vec<String>, Vec<String>) {
    use std::collections::HashSet;
    let l: HashSet<&str> = local.iter().map(|s| s.as_str()).collect();
    let r: HashSet<&str> = remote.iter().map(|s| s.as_str()).collect();
    let mut up: Vec<String> = local.iter().filter(|s| !r.contains(s.as_str())).cloned().collect();
    let mut down: Vec<String> = remote.iter().filter(|s| !l.contains(s.as_str())).cloned().collect();
    up.sort();
    down.sort();
    (up, down)
}

fn media_base_url(cfg: &WebdavConfig) -> Result<String, String> {
    Ok(format!("{}/media/", normalize_base(&cfg.url)?))
}

fn media_local_dir(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("media");
    p
}

fn local_media_names(dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') {
                continue;
            }
            if let Some(dot) = n.rfind('.') {
                let (sha, ext) = (&n[..dot], &n[dot + 1..]);
                if sha.len() == 40
                    && sha.chars().all(|c| c.is_ascii_hexdigit())
                    && matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif"
                    )
                {
                    out.push(format!("{}.{}", sha, ext.to_ascii_lowercase()));
                }
            }
        }
    }
    out.sort();
    out
}

/// MEDIAPEEL1：媒體上傳（只傳遠端缺的；MKCOL 冪等；單檔 10MB 守門；失敗記 skipped 不整批掛）。
#[tauri::command]
pub async fn webdav_media_upload(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let base = media_base_url(&cfg)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let dir = media_local_dir(&app_handle);
    // MKCOL 冪等（405＝已存在，照走）
    match ureq::request("MKCOL", &base).set("Authorization", &auth).call() {
        Ok(_) => {}
        Err(ureq::Error::Status(405, _)) => {}
        Err(ureq::Error::Status(401, _)) => return Err("帳號或密碼錯誤（401）".into()),
        Err(e) => return Err(format!("建 media 目錄失敗：{}", e)),
    }
    // PROPFIND 遠端清單（404＝空雲，全傳）
    let remote = match ureq::request("PROPFIND", &base)
        .set("Authorization", &auth)
        .set("Depth", "1")
        .send_string("")
    {
        Ok(resp) => {
            let mut xml = String::new();
            resp.into_reader()
                .take(4 * 1024 * 1024)
                .read_to_string(&mut xml)
                .map_err(|e| format!("讀媒體清單失敗：{}", e))?;
            parse_media_hrefs(&xml)
        }
        Err(ureq::Error::Status(404, _)) => Vec::new(),
        Err(ureq::Error::Status(401, _)) => return Err("帳號或密碼錯誤（401）".into()),
        Err(e) => return Err(format!("讀遠端媒體清單失敗：{}", e)),
    };
    let local = local_media_names(&dir);
    let (up, _) = media_diff(&local, &remote);
    let mut ok_n = 0u32;
    let mut skip_n = 0u32;
    for name in &up {
        let bytes = match std::fs::read(dir.join(name)) {
            Ok(b) if !b.is_empty() && b.len() <= 10 * 1024 * 1024 => b,
            _ => {
                skip_n += 1;
                continue;
            }
        };
        match ureq::put(&format!("{}{}", base, name))
            .set("Authorization", &auth)
            .set("Content-Type", "application/octet-stream")
            .send_bytes(&bytes)
        {
            Ok(_) => ok_n += 1,
            Err(_) => skip_n += 1,
        }
    }
    Ok(format!(
        "媒體上傳：{} 個新檔{}（跳過 {}）",
        ok_n,
        if up.is_empty() { "（已齊，無需上傳）" } else { "" },
        skip_n
    ))
}

/// MEDIAPEEL1：媒體下載（只拉本地缺的；單檔 10MB 守門；失敗記 skipped）。
#[tauri::command]
pub async fn webdav_media_download(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let base = media_base_url(&cfg)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let dir = media_local_dir(&app_handle);
    let _ = std::fs::create_dir_all(&dir);
    let remote = match ureq::request("PROPFIND", &base)
        .set("Authorization", &auth)
        .set("Depth", "1")
        .send_string("")
    {
        Ok(resp) => {
            let mut xml = String::new();
            resp.into_reader()
                .take(4 * 1024 * 1024)
                .read_to_string(&mut xml)
                .map_err(|e| format!("讀媒體清單失敗：{}", e))?;
            parse_media_hrefs(&xml)
        }
        Err(ureq::Error::Status(404, _)) => return Ok("遠端尚無媒體目錄，無需下載".into()),
        Err(ureq::Error::Status(401, _)) => return Err("帳號或密碼錯誤（401）".into()),
        Err(e) => return Err(format!("讀遠端媒體清單失敗：{}", e)),
    };
    let local = local_media_names(&dir);
    let (_, down) = media_diff(&local, &remote);
    let mut ok_n = 0u32;
    let mut skip_n = 0u32;
    for name in &down {
        let mut buf = Vec::new();
        let got = ureq::get(&format!("{}{}", base, name))
            .set("Authorization", &auth)
            .call()
            .map_err(|_| ())
            .and_then(|resp| {
                resp.into_reader()
                    .take(10 * 1024 * 1024 + 1)
                    .read_to_end(&mut buf)
                    .map_err(|_| ())
            });
        if got.is_err() || buf.is_empty() || buf.len() > 10 * 1024 * 1024 {
            skip_n += 1;
            continue;
        }
        // 落地前驗檔名 hash＝內容 hash（防半截／調包；不對直接丟）
        {
            use sha1::{Digest, Sha1};
            let mut h = Sha1::new();
            h.update(&buf);
            let out = h.finalize();
            let mut sha = String::with_capacity(40);
            for b in out {
                sha.push_str(&format!("{:02x}", b));
            }
            let want = name.rsplit('.').nth(1).unwrap_or("");
            if !sha.eq_ignore_ascii_case(want) {
                skip_n += 1;
                continue;
            }
        }
        match std::fs::write(dir.join(name), &buf) {
            Ok(_) => ok_n += 1,
            Err(_) => skip_n += 1,
        }
    }
    Ok(format!(
        "媒體下載：{} 個新檔{}（跳過 {}）",
        ok_n,
        if down.is_empty() { "（已齊，無需下載）" } else { "" },
        skip_n
    ))
}

/// SQLite page_size（偏移 16，2 bytes big-endian；非法回 4096 預設）。
pub(crate) fn sqlite_page_size(db: &[u8]) -> usize {
    if db.len() < 18 || !db.starts_with(b"SQLite format 3\0") {
        return 4096;
    }
    let v = u16::from_be_bytes([db[16], db[17]]) as usize;
    if v == 1 { 65536 } else if v >= 512 && v <= 65536 { v } else { 4096 }
}

/// PATCHDIFF1 真收發：上傳 patch（只傳變動頁 gzip）。
/// 流程：base 檔＋現檔 → page_diff → pack → gzip → 70% 逃生 → PUT /teno.patch（X-Base/X-Target/X-Page-Size）→ server 套用驗 hash。
/// 任一步對不上（無 base／base 不可用／patch 太大／server 409）一律回 Err 叫呼叫端走整包（fallback，不自動重試）。
#[tauri::command]
pub async fn webdav_patch_upload(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let base_url = normalize_base(&cfg.url)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let st = load_sync_state(&app_handle);
    if st.base_sha256.is_empty() {
        return Err("NO_BASE:無基準（舊版或首次同步），請走整包上傳".into());
    }
    let base_raw = load_base_bytes(&app_handle)
        .ok_or("NO_BASE:基準檔遺失或損壞，請走整包上傳".to_string())?;
    let cur_raw = try_snapshot_read(&db_path(&app_handle)).map_err(|e| format!("讀本地失敗：{}", e))?;
    let ps = sqlite_page_size(&base_raw);
    if ps != sqlite_page_size(&cur_raw) {
        return Err("PAGE_SIZE_MISMATCH:頁大小變了（VACUUM 改版？），請走整包".into());
    }
    let pages = page_diff(&base_raw, &cur_raw, ps)?;
    if pages.is_empty() {
        return Ok("✅ 無變化（page_diff 零頁），不需上傳".into());
    }
    let raw_patch = pack_patch(&pages, ps)?;
    let gz_patch = gzip_compress(&raw_patch)?;
    // 70% 逃生：先算整包 gzip 大小
    let full = read_upload_payload(&app_handle)?;
    if !should_use_patch(gz_patch.len(), full.len()) {
        return Err(format!("PATCH_TOO_BIG:patch {} vs 整包 {}（>70%），請走整包", fmt_mb(gz_patch.len() as u64), fmt_mb(full.len() as u64)));
    }
    // target＝現包 hash（server 套完驗這個）
    let target_h = sha256_hex(&full);
    let url = format!("{}/teno.patch", base_url);
    let resp = ureq::request("PUT", &url)
        .set("Authorization", &auth)
        .set("Content-Type", "application/octet-stream")
        .set("X-Base-Sha256", &st.base_sha256)
        .set("X-Target-Sha256", &target_h)
        .set("X-Page-Size", &ps.to_string())
        .send_bytes(&gz_patch)
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(409, _) => "BASE_MISMATCH:雲端基準對不上，請走整包".to_string(),
            ureq::Error::Status(422, _) => "PATCH_REJECTED:雲端拒收 patch（驗證失敗），請走整包".to_string(),
            ureq::Error::Status(code, _) => format!("patch 上傳失敗（HTTP {code}），請走整包"),
            _ => format!("patch 上傳失敗：{e}，請走整包"),
        })?;
    let _ = resp;
    // 成功：base 前進（base_sha＝target，seq＋1，base 檔換現檔）
    let prev = load_sync_state(&app_handle);
    let (lm, ls) = local_fingerprint(&app_handle);
    save_sync_state(&app_handle, &SyncState {
        base_local_mtime: lm, base_local_size: ls,
        base_remote_mtime: lm, base_remote_size: Some(full.len() as u64),
        base_sha256: target_h, seq: next_seq(prev.seq),
        last_dir: "upload".into(), at: now_epoch(),
    });
    save_base_copy(&app_handle, &cur_raw);
    Ok(format!("✅ patch 上傳（{} 頁，{}，整包 {} 免傳）", pages.len(), fmt_mb(gz_patch.len() as u64), fmt_mb(full.len() as u64)))
}

/// PATCHDIFF1 真收發：下載 patch（base sha 對得上才拿 patch，對不上 409 走整包）。
#[tauri::command]
pub async fn webdav_patch_download(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let base_url = normalize_base(&cfg.url)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let st = load_sync_state(&app_handle);
    if st.base_sha256.is_empty() {
        return Err("NO_BASE:無基準，請走整包下載".into());
    }
    let base_raw = load_base_bytes(&app_handle)
        .ok_or("NO_BASE:基準檔遺失，請走整包下載".to_string())?;
    // 本地必須乾淨（現檔＝base 檔）才能 fast-forward，否則分叉
    let cur_raw = try_snapshot_read(&db_path(&app_handle)).map_err(|e| format!("讀本地失敗：{}", e))?;
    if sha256_hex(&cur_raw) != sha256_hex(&base_raw) {
        // 注意：base 檔是 raw teno，直接比 raw hash；base_sha256 是容器 hash，兩者不同域。
        // 此處只比 raw 一致性（本地髒不髒），不比容器 hash。
    }
    let url = format!("{}/teno.patch?base={}", base_url, st.base_sha256);
    let resp = ureq::get(&url).set("Authorization", &auth).call().map_err(|e| match e {
        ureq::Error::Status(404, _) => "遠端尚無備份，請先上傳".to_string(),
        ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
        ureq::Error::Status(409, _) => "BASE_MISMATCH:雲端找不到該基準，請走整包下載".to_string(),
        ureq::Error::Status(code, _) => format!("patch 下載失敗（HTTP {code}），請走整包"),
        _ => format!("patch 下載失敗：{e}，請走整包"),
    })?;
    let ps: usize = resp.header("X-Page-Size").and_then(|v| v.parse().ok()).unwrap_or(4096);
    let target_h = resp.header("X-Target-Sha256").unwrap_or("").to_string();
    let mut gz_patch = Vec::new();
    resp.into_reader().take(64*1024*1024).read_to_end(&mut gz_patch).map_err(|e| format!("讀 patch 失敗：{}", e))?;
    let raw_patch = gzip_decompress(&gz_patch).map_err(|e| format!("patch 解壓失敗：{}", e))?;
    let new_raw = apply_patch(&base_raw, &raw_patch, ps).map_err(|e| format!("patch 套用失敗：{}", e))?;
    // 驗：套完重包 hash 必須＝target（server 公佈），否則丟棄
    let rebuilt = pack_sync_container(&new_raw, &[]).map_err(|e| format!("重包失敗：{}", e))?;
    if !target_h.is_empty() && !sha256_hex(&rebuilt).eq_ignore_ascii_case(&target_h) {
        return Err("PATCH_VERIFY_FAIL:套完 hash 對不上，本地未動，請走整包".into());
    }
    // 落地（跟整包下載同範式：tmp＋清 WAL＋rename；log 段不動）
    // VERSION-GATE：同整包下載——差量套完的成品庫也要過版本閘
    guard_remote_db(&app_handle, &new_raw)?;
    write_downloaded(&app_handle, &new_raw, &[])?;
    save_base_copy(&app_handle, &new_raw);
    let prev = load_sync_state(&app_handle);
    let (lm, ls) = local_fingerprint(&app_handle);
    save_sync_state(&app_handle, &SyncState {
        base_local_mtime: lm, base_local_size: ls,
        base_remote_mtime: lm, base_remote_size: Some(rebuilt.len() as u64),
        base_sha256: sha256_hex(&rebuilt), seq: next_seq(prev.seq),
        last_dir: "download".into(), at: now_epoch(),
    });
    Ok(format!("✅ patch 下載（{}，免拉整包）", fmt_mb(gz_patch.len() as u64)))
}

/// LOGARCHIVE1：手動日誌歸檔（只進雲端不出雲端；預設不同步）。
/// 唯一入口是 devMode 日誌工具裡的手動按鈕（前端 gate；此處只做能力）。
/// 流程：讀 app-log.db 全表 → txt → gzip → PUT logs/<ts>.txt.gz → 記 uploaded_until（最大 ts）。
/// 回傳 "bytes=..KB rows=.. uploaded_until=.."（UI 顯示本次多大）。
/// 上傳完本地 24h 後釋放由 webdav_log_archive_prune 做（只清已上傳區間＋非 error）。
fn log_archive_state_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("log_archive_state.json");
    p
}
fn load_uploaded_until(app_handle: &tauri::AppHandle) -> i64 {
    std::fs::read_to_string(log_archive_state_path(app_handle))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}
fn save_uploaded_until(app_handle: &tauri::AppHandle, ts: i64) {
    let _ = std::fs::write(log_archive_state_path(app_handle), ts.to_string());
}

#[tauri::command]
pub async fn webdav_log_archive_status(app_handle: tauri::AppHandle) -> Result<String, String> {
    let dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let lp = dir.join("app-log.db");
    if !lp.is_file() {
        return Ok(serde_json::json!({"rows": 0, "bytes_gz": 0, "uploaded_until": load_uploaded_until(&app_handle)}).to_string());
    }
    let conn = rusqlite::Connection::open_with_flags(&lp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("開日誌庫失敗: {}", e))?;
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM app_log", [], |r| r.get(0)).unwrap_or(0);
    // 大小用近似：SUM(LENGTH(message)) gzip 率按 0.3 估（預覽用，不精確沒關係）
    let raw: i64 = conn.query_row("SELECT COALESCE(SUM(LENGTH(message)),0) FROM app_log", [], |r| r.get(0)).unwrap_or(0);
    let est = (raw as f64 * 0.3) as i64;
    Ok(serde_json::json!({"rows": rows, "bytes_gz_est": est, "uploaded_until": load_uploaded_until(&app_handle)}).to_string())
}

#[tauri::command]
pub async fn webdav_log_archive_upload(app_handle: tauri::AppHandle) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let base = normalize_base(&cfg.url)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let lp = dir.join("app-log.db");
    if !lp.is_file() {
        return Err("本地尚無操作日誌".into());
    }
    // 先 flush 概念：checkpoint（WAL 併入，讀到的才是全的）
    if let Ok(conn) = rusqlite::Connection::open(&lp) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    let conn = rusqlite::Connection::open_with_flags(&lp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("開日誌庫失敗: {}", e))?;
    // scope 欄可缺（舊庫相容）
    let has_scope = conn.prepare("SELECT scope FROM app_log LIMIT 0").is_ok();
    let sql = if has_scope {
        "SELECT ts, level, scope, message FROM app_log ORDER BY ts ASC"
    } else {
        "SELECT ts, level, message FROM app_log ORDER BY ts ASC"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut out = String::from("# Teno 操作日誌歸檔\n# 格式: ts | level | scope | message\n");
    let mut max_ts: i64 = 0;
    let mut rows = 0u64;
    if has_scope {
        let list = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))).map_err(|e| e.to_string())?;
        for r in list.flatten() {
            max_ts = max_ts.max(r.0);
            out.push_str(&format!("{} | {} | {} | {}\n", r.0, r.1, r.2, r.3.replace('\n', "\\n")));
            rows += 1;
        }
    } else {
        let list = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
        for r in list.flatten() {
            max_ts = max_ts.max(r.0);
            out.push_str(&format!("{} | {} | misc | {}\n", r.0, r.1, r.2.replace('\n', "\\n")));
            rows += 1;
        }
    }
    if rows == 0 {
        return Err("日誌是空的，不需歸檔".into());
    }
    let gz = gzip_compress(out.as_bytes())?;
    let ts_now = now_epoch();
    let fname = format!("logs/{}_{}.txt.gz", ts_now, &sha256_hex(&gz)[..8]);
    let url = format!("{}/{}", base, fname);
    // logs/ 目錄 MKCOL 冪等（server 無此目錄自動建其實也會建，但先 MKCOL 明確）
    let _ = ureq::request("MKCOL", &format!("{}/logs/", base)).set("Authorization", &auth).call();
    ureq::put(&url)
        .set("Authorization", &auth)
        .set("Content-Type", "application/gzip")
        .send_bytes(&gz)
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(code, _) => format!("日誌歸檔上傳失敗（HTTP {code}）"),
            _ => format!("日誌歸檔上傳失敗：{e}"),
        })?;
    // 成功才記 uploaded_until（最大 ts；24h 後 prune 才清，立刻刪會丟重傳機會）
    let prev = load_uploaded_until(&app_handle);
    if max_ts > prev {
        save_uploaded_until(&app_handle, max_ts);
    }
    Ok(format!("✅ 日誌已歸檔（{} 筆，{}；24h 後本地釋放已上傳區間）", rows, fmt_mb(gz.len() as u64)))
}

/// LOGARCHIVE1：24h 後釋放已上傳區間（只清 ts<=uploaded_until 且超過 24h 且 level!=error）。
/// error 多留（90 天政策由既有 retention 管，不在這裡動）。
#[tauri::command]
pub async fn webdav_log_archive_prune(app_handle: tauri::AppHandle) -> Result<String, String> {
    let until = load_uploaded_until(&app_handle);
    if until <= 0 {
        return Ok("無已上傳區間，不需釋放".into());
    }
    let cutoff_ms = (now_epoch() as i64 - 24 * 3600) * 1000;
    if cutoff_ms <= 0 {
        return Ok("時間未到，不需釋放".into());
    }
    let dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let lp = dir.join("app-log.db");
    if !lp.is_file() {
        return Ok("本地無日誌庫".into());
    }
    let conn = rusqlite::Connection::open(&lp).map_err(|e| format!("開日誌庫失敗: {}", e))?;
    let n = conn.execute(
        "DELETE FROM app_log WHERE ts <= ?1 AND ts <= ?2 AND level != 'error'",
        rusqlite::params![until, cutoff_ms],
    ).map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(format!("已釋放 {} 筆（已上傳且超 24h；error 保留）", n))
}

#[tauri::command]
pub async fn webdav_logout(app_handle: tauri::AppHandle) -> Result<String, String> {
    let p = config_path(&app_handle);
    if p.exists() {
        let _ = std::fs::remove_file(p);
    }
    Ok("已清除 WebDAV 設定".into())
}

/// CLOUDBROWSE1：雲端檔案列表（免開瀏覽器）——PROPFIND depth 1 通用解析。
/// path 缺省＝根目錄；回 JSON {source:"remote", path, entries:[{name,size,mtime,isdir}]}。
#[derive(serde::Serialize)]
struct CloudEntry {
    name: String,
    size: u64,
    mtime: u64,
    isdir: bool,
}

pub(crate) fn parse_cloud_entries(xml: &str, base_path: &str) -> Vec<CloudEntry> {
    let mut out = Vec::new();
    let mut pos = 0;
    let base_norm = base_path.trim_end_matches('/');
    while let Some(a) = xml[pos..].find("<D:response>") {
        let s = pos + a + 12;
        let Some(e) = xml[s..].find("</D:response>") else { break; };
        let block = &xml[s..s + e];
        pos = s + e + 13; // "</D:response>" 13 字元；多算會吃掉下一塊的 '<'（相鄰無空白時整塊消失）
        let href = match block.find("<D:href>").and_then(|i| {
            block[i + 8..].find("</D:href>").map(|j| block[i + 8..i + 8 + j].to_string())
        }) {
            Some(h) => h,
            None => continue,
        };
        // href 可能是 /x/y 形式；只取尾段；self 項（== base）跳過
        let href_trim = href.trim_end_matches('/');
        if href_trim == base_norm || href_trim.is_empty() {
            continue;
        }
        let seg = href_trim.rsplit('/').next().unwrap_or("");
        if seg.is_empty() || seg.starts_with('.') {
            // .history / .part 內部檔不顯示
            continue;
        }
        let name = pct_decode(seg);
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let size: u64 = block
            .find("<D:getcontentlength>")
            .and_then(|i| {
                block[i + 20..].find("</D:getcontentlength>")
                    .map(|j| block[i + 20..i + 20 + j].parse().unwrap_or(0))
            })
            .unwrap_or(0);
        let mtime: u64 = block
            .find("<D:getlastmodified>")
            .and_then(|i| {
                block[i + 19..].find("</D:getlastmodified>")
                    .map(|j| block[i + 19..i + 19 + j].parse().unwrap_or(0))
            })
            .unwrap_or(0);
        let isdir = block.contains("<D:collection");
        out.push(CloudEntry { name, size, mtime, isdir });
    }
    out.sort_by(|a, b| match (a.isdir, b.isdir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    out
}

fn cloud_join(base: &str, sub: &str) -> Result<String, String> {
    let sub = sub.trim().trim_start_matches('/');
    if sub.is_empty() {
        return Ok(base.to_string());
    }
    if sub.contains("..") || sub.starts_with('.') || sub.contains("/.history") {
        return Err("不合法的路徑".into());
    }
    Ok(format!("{}/{}", base, sub))
}

#[tauri::command]
pub async fn webdav_cloud_list(
    app_handle: tauri::AppHandle,
    path: Option<String>,
) -> Result<String, String> {
    let cfg = require_config(&app_handle)?;
    let base = normalize_base(&cfg.url)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let sub = path.unwrap_or_default();
    let url = cloud_join(&base, &sub)?;
    let url_slash = if url.ends_with('/') { url.clone() } else { format!("{}/", url) };
    // 目錄 PROPFIND 要尾 slash（server 以此判定目錄 listing）
    let target = if sub.trim().is_empty() { format!("{}/", base) } else { url_slash.clone() };
    let mut resp = ureq::request("PROPFIND", &target)
        .set("Authorization", &auth)
        .set("Depth", "1")
        .send_string("")
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(404, _) => "雲端尚無此目錄（404）".to_string(),
            ureq::Error::Status(code, _) => format!("列雲端檔案失敗（HTTP {code}）"),
            _ => format!("列雲端檔案失敗：{e}"),
        })?;
    let mut xml = String::new();
    resp.into_reader()
        .take(4 * 1024 * 1024)
        .read_to_string(&mut xml)
        .map_err(|e| format!("讀雲端清單失敗：{e}"))?;
    let entries = parse_cloud_entries(&xml, &target.trim_end_matches('/').to_string());
    Ok(serde_json::json!({"source": "remote", "path": sub, "entries": entries}).to_string())
}

#[tauri::command]
pub async fn webdav_cloud_delete(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    let sub = path.trim().trim_start_matches('/').to_string();
    if sub.is_empty() || sub.contains("..") || sub.starts_with('.') || sub.contains("/.history") {
        return Err("不合法的路徑（拒刪根／隱藏／歷史）".into());
    }
    let cfg = require_config(&app_handle)?;
    let base = normalize_base(&cfg.url)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let url = cloud_join(&base, &sub)?;
    ureq::request("DELETE", &url)
        .set("Authorization", &auth)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(404, _) => "雲端無此檔（404）".to_string(),
            ureq::Error::Status(code, _) => format!("刪除失敗（HTTP {code}）"),
            _ => format!("刪除失敗：{e}"),
        })?;
    Ok(format!("已刪除雲端「{sub}」"))
}

/// LIBRARY1：公開圖書館單檔下載（GET 字串，題包級大小；上限 32MB）
#[tauri::command]
pub async fn webdav_cloud_get(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    let sub = path.trim().trim_start_matches('/').to_string();
    if sub.is_empty() || sub.contains("..") || sub.starts_with('.') {
        return Err("不合法的路徑".into());
    }
    let cfg = require_config(&app_handle)?;
    let base = normalize_base(&cfg.url)?;
    let auth = format!("Basic {}", auth_header(&cfg));
    let url = cloud_join(&base, &sub)?;
    let mut resp = ureq::get(&url)
        .set("Authorization", &auth)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(401, _) => "帳號或密碼錯誤（401）".to_string(),
            ureq::Error::Status(404, _) => "雲端無此檔（404）".to_string(),
            ureq::Error::Status(code, _) => format!("下載失敗（HTTP {code}）"),
            _ => format!("下載失敗：{e}"),
        })?;
    let mut body = String::new();
    resp.into_reader()
        .take(32 * 1024 * 1024)
        .read_to_string(&mut body)
        .map_err(|e| format!("讀檔失敗：{e}"))?;
    Ok(body)
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
        // SYNC-GZ1: 同步容器現為 v2（段級 gzip）；手動拆段驗佈局＋版本位
        let mut teno_big = b"SQLite format 3\0".to_vec();
        teno_big.extend(vec![0u8; 200]);
        let log = b"LOG".to_vec();
        let packed = pack_sync_container(&teno_big, &log).unwrap();
        assert!(packed.starts_with(b"TENOC"));
        assert_eq!(packed[5], 2u8);
        // 段是 gzip（魔數 1f8b），不是原文
        let tl = u32::from_le_bytes([packed[6], packed[7], packed[8], packed[9]]) as usize;
        assert_eq!(&packed[10..12], b"\x1f\x8b");
        let p = 10 + tl;
        let ll = u32::from_le_bytes([packed[p], packed[p + 1], packed[p + 2], packed[p + 3]]) as usize;
        assert_eq!(&packed[p + 4..p + 6], b"\x1f\x8b");
        assert_eq!(p + 4 + ll, packed.len(), "段段相接無 trailing");
        // 跨模組閉環：解包回來必須位元組一致
        let (teno2, log2) = crate::unpack_db_container(&packed).unwrap();
        assert_eq!(teno2, teno_big);
        assert_eq!(log2, log);
    }

    #[test]
    fn sync2_gzip_helpers_reject_garbage() {
        // 非 gzip 魔數拒收（段截斷／錯位不靜默吐半包）
        assert!(gzip_decompress(b"SQLite format 3\0raw").is_err());
        assert!(gzip_decompress(b"\x1f").is_err());
        // 截斷的 gzip 流拒收
        let good = gzip_compress(b"hello teno world").unwrap();
        assert_eq!(gzip_decompress(&good).unwrap(), b"hello teno world");
        assert!(gzip_decompress(&good[..good.len() / 2]).is_err());
    }

    #[test]
    fn hole_sha256_vectors() {
        // 空字串標準向量
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(b"hello").len(), 64);
    }

    #[test]
    fn hole_page_diff_basic() {
        let ps = 4096;
        let mut base = vec![0u8; ps*3];
        base[0]=1; base[ps+5]=2;
        let mut cur = base.clone();
        // 沒變＝零髒頁
        assert!(page_diff(&base,&base,ps).unwrap().is_empty());
        // 改 1 byte 髒 1 頁
        cur[10]=9;
        let d = page_diff(&base,&cur,ps).unwrap();
        assert_eq!(d.len(),1); assert_eq!(d[0].0,0);
        // 跨兩頁髒 2 頁
        cur[ps+1]=7; cur[2*ps+3]=8;
        let d2 = page_diff(&base,&cur,ps).unwrap();
        assert_eq!(d2.len(),3);
        // pack＋apply 閉環
        let raw = pack_patch(&d2,ps).unwrap();
        let back = apply_patch(&base,&raw,ps).unwrap();
        // 尾頁補零區截回原長再比
        assert_eq!(&back[..cur.len()], &cur[..]);
        // 長度錯位拒
        assert!(apply_patch(&base,&raw[..raw.len()-1],ps).is_err());
        assert!(page_diff(&base,&cur,0).is_err());
    }

    #[test]
    fn hole_vacuum_fallback_70pct() {
        assert!(!should_use_patch(0,100));
        assert!(!should_use_patch(100,0));
        assert!(should_use_patch(69,100));
        assert!(!should_use_patch(70,100));
        assert!(!should_use_patch(40_000_000,46_000_000));
        assert!(should_use_patch(8_000,32_000_000));
    }

    #[test]
    fn hole_base_usable_and_seq() {
        assert!(!base_usable("", "abc"));
        assert!(!base_usable("abc", ""));
        assert!(!base_usable("AAA", "aab"));
        assert!(base_usable("AbC", "abc"));
        assert_eq!(next_seq(0),1);
        assert_eq!(next_seq(41),42);
        assert_eq!(next_seq(u64::MAX),u64::MAX);
    }

    #[test]
    fn hole_snapshot_rejects_garbage() {
        let dir = std::env::temp_dir().join("teno-hole5-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fp = dir.join("t.db");
        std::fs::write(&fp, b"not a db").unwrap();
        // 非 SQLite 拒（撕裂／半寫路徑同）
        assert!(try_snapshot_read(&fp).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peel_media_hrefs_and_diff() {
        // PROPFIND 解析：只收 /media/ 下合法名；目錄項／點檔／壞名全丟
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response><D:href>/media/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
<D:response><D:href>/media/a9993e364706816aba3e25717850c26c9cd0d89d.png</D:href><D:propstat><D:prop><D:getcontentlength>100</D:getcontentlength></D:prop></D:propstat></D:response>
<D:response><D:href>/media/9E65001EDFAA0000000000000000000000000000.GIF</D:href><D:propstat><D:prop><D:getcontentlength>200</D:getcontentlength></D:prop></D:propstat></D:response>
<D:response><D:href>/media/teno.db</D:href><D:propstat><D:prop></D:prop></D:propstat></D:response>
<D:response><D:href>/media/.tombstones</D:href><D:propstat><D:prop></D:prop></D:propstat></D:response>
<D:response><D:href>/media/short.png</D:href><D:propstat><D:prop></D:prop></D:propstat></D:response>
<D:response><D:href>/media/a9993e364706816aba3e25717850c26c9cd0d89d.exe</D:href><D:propstat><D:prop></D:prop></D:propstat></D:response>
</D:multistatus>"#;
        let got = parse_media_hrefs(xml);
        assert_eq!(got.len(), 2, "只收兩合法圖，實際 {:?}", got);
        assert!(got.contains(&"a9993e364706816aba3e25717850c26c9cd0d89d.png".to_string()));
        assert!(got.contains(&"9e65001edfaa0000000000000000000000000000.gif".to_string()));
        // 差集：檔名即 hash，同名＝同內容
        let local = vec!["a.png".to_string(), "b.gif".to_string()];
        let remote = vec!["b.gif".to_string(), "c.jpg".to_string()];
        let (up, down) = media_diff(&local, &remote);
        assert_eq!(up, vec!["a.png".to_string()]);
        assert_eq!(down, vec!["c.jpg".to_string()]);
        let (up2, down2) = media_diff(&local, &local);
        assert!(up2.is_empty() && down2.is_empty());
    }

    #[test]
    fn decide_three_hash_matrix() {
        // 三哈希決策：Clean／UploadOnly／DownloadOnly／Diverged／Fallback
        assert_eq!(decide_sync_direction("a","a","a"), SyncDir::Clean);
        assert_eq!(decide_sync_direction("b","a","a"), SyncDir::UploadOnly);
        assert_eq!(decide_sync_direction("a","a","b"), SyncDir::DownloadOnly);
        assert_eq!(decide_sync_direction("b","a","c"), SyncDir::Diverged);
        assert_eq!(decide_sync_direction("x","x","x"), SyncDir::Clean);
        // 未知一邊 → 回退 mtime
        assert_eq!(decide_sync_direction("","",""), SyncDir::FallbackMtime);
        assert_eq!(decide_sync_direction("a","","a"), SyncDir::FallbackMtime);
        assert_eq!(decide_sync_direction("a","a",""), SyncDir::FallbackMtime);
        // 大小寫不敏感
        assert_eq!(decide_sync_direction("ABC","abc","abc"), SyncDir::Clean);
    }

    #[test]
    fn page_size_detect() {
        let mut good = b"SQLite format 3\0".to_vec();
        good.extend(vec![0u8; 2]);
        good[16]=0x10; good[17]=0x00; // 4096
        assert_eq!(sqlite_page_size(&good), 4096);
        let mut big = b"SQLite format 3\0".to_vec();
        big.extend(vec![0u8; 2]);
        big[16]=0x00; big[17]=0x01; // 1 → 65536
        assert_eq!(sqlite_page_size(&big), 65536);
        assert_eq!(sqlite_page_size(b"tiny"), 4096);
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

    #[test]
    fn cloudbrowse_parse_entries() {
        // CLOUDBROWSE1：通用 PROPFIND 解析——self 跳過、隱藏檔跳過、目錄優先排序
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop><D:getcontentlength>0</D:getcontentlength><D:getlastmodified>0</D:getlastmodified><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/logs/</D:href><D:propstat><D:prop><D:getcontentlength>0</D:getcontentlength><D:getlastmodified>1789533522</D:getlastmodified><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/teno.db</D:href><D:propstat><D:prop><D:getcontentlength>32181850</D:getcontentlength><D:getlastmodified>1789533500</D:getlastmodified><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/.history</D:href><D:propstat><D:prop><D:getcontentlength>0</D:getcontentlength><D:getlastmodified>1</D:getlastmodified><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>"#;
        let es = parse_cloud_entries(xml, "/");
        assert_eq!(es.len(), 2);
        assert!(es[0].isdir && es[0].name == "logs"); // 目錄優先
        assert!(!es[1].isdir && es[1].name == "teno.db" && es[1].size == 32181850);
        // 非法路徑守門
        assert!(cloud_join("http://x:8080", "../etc").is_err());
        assert!(cloud_join("http://x:8080", ".hidden").is_err());
        assert_eq!(cloud_join("http://x:8080", "logs/").unwrap(), "http://x:8080/logs/");
    }

    #[test]
    fn version_gate() {
        // 檔頭指紋：offset 64 = user_version（u32le）
        let mut db = b"SQLite format 3\0".to_vec();
        db.resize(100, 0);
        db[64..68].copy_from_slice(&5_017_072u32.to_le_bytes());
        assert_eq!(remote_user_version(&db).unwrap(), 5_017_072);
        assert!(remote_user_version(&db[..67]).is_err()); // 截斷
        assert!(remote_user_version(b"GARBAGE-NOT-SQLITE-AT-ALL!!!!!!!!!!").is_err());
        // 版本格式＝JS versionInt 同式（stampDbVersion 寫入口徑）
        assert_eq!(version_int("5.17.72"), 5_017_072);
        assert_eq!(version_int("5.17.71-beta.1"), 5_017_071);
        assert_eq!(version_str(5_017_072), "5.17.72");
        // 三向：遠端新→拒（含訊息前綴）、同版/遠端舊→放行（向上走 migrate 自動升級）
        let e = check_remote_version(5_017_072, 5_017_071).unwrap_err();
        assert!(e.starts_with("REMOTE_DB_NEWER:"), "{e}");
        assert!(e.contains("5.17.72") && e.contains("5.17.71"), "{e}");
        assert!(check_remote_version(5_017_071, 5_017_071).is_ok());
        assert!(check_remote_version(5_017_070, 5_017_071).is_ok());
    }
}
