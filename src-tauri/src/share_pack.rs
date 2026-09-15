//! SHAREPACK1: 單字套含圖打包 — words.csv + media/ + manifest.json (zip v1)。
//!
//! 動機：分享 CSV 裝不下圖（base64 灌格子炸轉義＋體積爆炸），且新表 word_images
//! 根本沒進包（對方收到的字全無圖）。學 Anki .apkg：zip 內文字＋媒體分開。
//! 佈局（v1）：
//!   words.csv     — 分享 CSV（BOM＋buildShareCSV 同格式；image 欄留空，圖走 manifest）
//!   manifest.json — {version:1, files:[{word, deck, file}]}（匯入以此為準）
//!   media/<file>  — 圖片二進位（data URL 解碼／直連下載落地；Tenor 有時效故下載轉本地）
//! GIF 無特殊待遇＝普通一張圖同機制。
//! IPC 安全：圖位元組永不經過 IPC（EXPORTBIG1 同課）——匯出 Rust 直讀 DB 打包直寫檔；
//! 匯入 Rust 解包放 temp，前端逐張 get_share_media 取 data URL（單張 10MB 守門，吃
//! 到 word_images，跟 apkg 圖片管線同形）。

use std::collections::HashMap;
use std::io::{Read as _, Write as _};

const MAX_PACK_BYTES: usize = 500 * 1024 * 1024;
const MAX_MEDIA_BYTES: usize = 10 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
pub struct PackManifestFile {
    pub word: String,
    pub deck: String,
    pub file: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PackManifest {
    pub version: u32,
    pub files: Vec<PackManifestFile>,
}

#[derive(serde::Serialize)]
pub struct SharePackInspect {
    pub csv: String,
    pub files: Vec<SharePackFile>,
    pub manifest: Vec<PackManifestFile>,
    pub media_token: String,
    pub file_name: String,
}

#[derive(serde::Serialize)]
pub struct SharePackFile {
    pub file: String,
    pub size: u64,
}

// ─── 純函式 ───

/// data URL → (mime, bytes)。非 data URL 回 None（呼叫端再判 http 下載／跳過）。
pub fn decode_data_url(s: &str) -> Option<(String, Vec<u8>)> {
    let s = s.trim();
    if !s.starts_with("data:") {
        return None;
    }
    let comma = s.find(',')?;
    let (meta, payload) = (&s[5..comma], &s[comma + 1..]);
    if !meta.ends_with(";base64") {
        return None;
    }
    let mime = meta.trim_end_matches(";base64").to_string();
    let bytes = base64_decode(payload.trim())?;
    Some((mime, bytes))
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ if c.is_ascii_whitespace() => continue,
            _ => return None,
        } as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8 & 0xFF);
        }
    }
    Some(out)
}

/// 無 base64 crate 依賴 → 自寫 RFC4648 standard encode（apkg.rs 同形）。
fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TBL[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TBL[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// MEDIAPEEL1：按 sha 讀 media 檔（ext 未知時掃同 sha 前綴；找不到回 None，呼叫端回退）。
fn read_media_by_sha(root: Option<&std::path::Path>, sha: &str) -> Option<Vec<u8>> {
    let root = root?;
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    for e in entries.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(sha) {
            if let Ok(b) = std::fs::read(e.path()) {
                if !b.is_empty() && b.len() <= MAX_MEDIA_BYTES {
                    return Some(b);
                }
                return None;
            }
        }
    }
    None
}

fn mime_from_ext(ext: Option<&str>) -> String {
    let lower = ext.unwrap_or("").to_ascii_lowercase();
    match lower.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn ext_from_mime(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    let m = m.split(';').next().unwrap_or("").trim();
    match m {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "bin",
    }
}

/// 包內檔名：<word-stem>-<idx>.<ext>（ASCII 安全；呼叫端保證 idx 遞增去重）。
/// 原檔名只取副檔名（防 ../ 穿越；無副檔名按 mime 猜）。
pub fn safe_media_name(word: &str, idx: usize, orig_filename: &str, mime: &str) -> String {
    let stem: String = word
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim_matches('_').to_string();
    let stem = if stem.is_empty() { "img".to_string() } else { stem };
    let stem: String = stem.chars().take(24).collect();
    let ext = std::path::Path::new(orig_filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| {
            matches!(
                e.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "avif"
            )
        })
        .unwrap_or_else(|| ext_from_mime(mime).to_string());
    format!("{stem}-{idx}.{ext}")
}

fn is_http_url(s: &str) -> bool {
    let t = s.trim().to_ascii_lowercase();
    t.starts_with("http://") || t.starts_with("https://")
}

fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(15))
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("下載圖失敗: {}", e))?;
    let len: Option<usize> = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok());
    if len.map(|n| n > MAX_MEDIA_BYTES).unwrap_or(false) {
        return Err("圖過大（>10MB），跳過".to_string());
    }
    let mut buf = Vec::new();
    resp.into_reader()
        .take((MAX_MEDIA_BYTES + 1) as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("讀圖失敗: {}", e))?;
    if buf.len() > MAX_MEDIA_BYTES {
        return Err("圖過大（>10MB），跳過".to_string());
    }
    Ok(buf)
}

// ─── temp（share-temp；apkg-temp 同形，token 綁定防串檔）───

fn share_temp_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager as _;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("share-temp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn cleanup_old_temp(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "tenopack").unwrap_or(false) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}

fn random_temp_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    // 非密碼學用途（temp 檔名防碰撞＋token 綁定），雜湊夠用
    let mut h: u64 = ns as u64 ^ ((pid as u64) << 32) ^ 0x9E3779B97F4A7C15;
    h ^= h >> 29;
    h = h.wrapping_mul(0xBF58476D1CE4E5B9);
    h ^= h >> 32;
    format!("{:016x}{:016x}", h, ns & 0xFFFF_FFFF_FFFF_FFFF)
}

fn valid_media_token(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 64
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn resolve_pack_tmp(
    dir: &std::path::Path,
    token: Option<&str>,
) -> Option<std::path::PathBuf> {
    if let Some(t) = token {
        if valid_media_token(t) {
            let p = dir.join(format!("{t}.tenopack"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

// ─── 打包核心（純函式，不碰 Tauri）───

/// 打包核心：讀 DB → 組 zip 位元組。抽出來的理由——命令層被 AppHandle／對話框綁死，
/// 端到端測不到；這裡可拿真 SQLite 驗（見 tests/pack_from_real_db）。
pub(crate) struct PackedZip {
    pub bytes: Vec<u8>,
    pub images: usize,
    pub skipped: u32,
    pub words: usize,
}

pub(crate) fn pack_from_db(
    db_path: &std::path::Path,
    csv: &str,
    word_ids: &[String],
) -> Result<PackedZip, String> {
    // 直讀 teno.db（唯讀，不搶 plugin-sql 的寫鎖）
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("開啟單字庫失敗: {}", e))?;
    let ph = word_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut id_meta: HashMap<String, (String, String)> = HashMap::new();
    {
        let sql = format!("SELECT id, word, deck FROM words WHERE id IN ({ph})");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(word_ids.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            id_meta.insert(r.0, (r.1, r.2));
        }
    }
    // MEDIAPEEL1：sha1 欄可缺（舊庫無 v15 時回退無 sha 查詢；舊測試表亦無此欄）
    let has_sha_col: bool = conn
        .prepare("SELECT sha1 FROM word_images LIMIT 0")
        .is_ok();
    let mut imgs: Vec<(String, String, String, String)> = Vec::new();
    {
        let sql = if has_sha_col {
            format!(
                "SELECT word_id, filename, data, sha1 FROM word_images WHERE word_id IN ({ph}) ORDER BY word_id, id"
            )
        } else {
            format!(
                "SELECT word_id, filename, data FROM word_images WHERE word_id IN ({ph}) ORDER BY word_id, id"
            )
        };
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        if has_sha_col {
            let rows = stmt
                .query_map(rusqlite::params_from_iter(word_ids.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, String>(2).unwrap_or_default(),
                        r.get::<_, String>(3).unwrap_or_default(),
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                imgs.push(r);
            }
        } else {
            let rows = stmt
                .query_map(rusqlite::params_from_iter(word_ids.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1).unwrap_or_default(),
                        r.get::<_, String>(2).unwrap_or_default(),
                    ))
                })
                .map_err(|e| e.to_string())?;
            for r in rows.flatten() {
                imgs.push((r.0, r.1, r.2, String::new()));
            }
        }
    }
    // MEDIAPEEL1：media 目錄（app_config_dir/media；單測無 AppHandle 時跳過，只用 DB data 欄）
    let media_root: Option<std::path::PathBuf> = crate::app_config_dir_opt()
        .map(|d| d.join("media"));
    drop(conn);

    let mut manifest = PackManifest {
        version: 1,
        files: Vec::new(),
    };
    let mut media: Vec<(String, Vec<u8>)> = Vec::new();
    let mut skipped = 0u32;
    let mut per_word_idx: HashMap<String, usize> = HashMap::new();
    for (wid, orig_name, data, sha) in &imgs {
        let Some((word, deck)) = id_meta.get(wid) else {
            skipped += 1;
            continue;
        };
        let idx = per_word_idx.entry(wid.clone()).or_insert(0);
        *idx += 1;
        // MEDIAPEEL1：sha 優先讀 media 檔（剝離後 data 欄已清空）；缺檔回退 data 欄
        let t = data.trim();
        let sha_t = sha.trim();
        let (mime, bytes): (String, Vec<u8>) = if !sha_t.is_empty() {
            if let Some(media_bytes) = read_media_by_sha(media_root.as_deref(), sha_t) {
                let ext = std::path::Path::new(orig_name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                (mime_from_ext(Some(ext)), media_bytes)
            } else if let Some((m, b)) = decode_data_url(t) {
                (m, b)
            } else if is_http_url(t) {
                match download_bytes(t) {
                    Ok(b) => {
                        let ext = std::path::Path::new(orig_name)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("");
                        (mime_from_ext(Some(ext)), b)
                    }
                    Err(e) => {
                        log::warn!("share-pack 下載圖跳過 {}: {}", orig_name, e);
                        skipped += 1;
                        continue;
                    }
                }
            } else {
                skipped += 1;
                continue;
            }
        } else if let Some((m, b)) = decode_data_url(t) {
            (m, b)
        } else if is_http_url(t) {
            match download_bytes(t) {
                Ok(b) => {
                    let ext = std::path::Path::new(orig_name)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("");
                    (mime_from_ext(Some(ext)), b)
                }
                Err(e) => {
                    log::warn!("share-pack 下載圖跳過 {}: {}", orig_name, e);
                    skipped += 1;
                    continue;
                }
            }
        } else {
            skipped += 1;
            continue;
        };
        if bytes.is_empty() || bytes.len() > MAX_MEDIA_BYTES {
            skipped += 1;
            continue;
        }
        let name = safe_media_name(word, *idx, orig_name, &mime);
        manifest.files.push(PackManifestFile {
            word: word.clone(),
            deck: deck.clone(),
            file: format!("media/{name}"),
        });
        media.push((name, bytes));
    }

    let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts: zip::write::SimpleFileOptions = Default::default();
    let mut csv_bytes = vec![0xEF, 0xBB, 0xBF];
    csv_bytes.extend_from_slice(csv.as_bytes());
    zw.start_file("words.csv", opts)
        .map_err(|e| e.to_string())?;
    zw.write_all(&csv_bytes).map_err(|e| e.to_string())?;
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zw.start_file("manifest.json", opts)
        .map_err(|e| e.to_string())?;
    zw.write_all(manifest_json.as_bytes())
        .map_err(|e| e.to_string())?;
    for (name, bytes) in &media {
        zw.start_file(format!("media/{name}"), opts)
            .map_err(|e| e.to_string())?;
        zw.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let zip_bytes = zw.finish().map_err(|e| e.to_string())?.into_inner();
    log::info!(
        "share_pack words={} images={} skipped={} bytes={}",
        id_meta.len(),
        media.len(),
        skipped,
        zip_bytes.len()
    );
    Ok(PackedZip {
        bytes: zip_bytes,
        images: media.len(),
        skipped,
        words: id_meta.len(),
    })
}

// ─── commands ───

/// 匯出分享包：前端傳 CSV＋word_ids；Rust 直讀 DB 取圖、打包、存檔對話框。
/// 回 JSON {path, images, skipped}（圖位元組零 IPC，EXPORTBIG1 同課）。
#[tauri::command]
pub async fn export_share_pack(
    app_handle: tauri::AppHandle,
    csv: String,
    filename: String,
    word_ids: Vec<String>,
) -> Result<String, String> {
    use tauri::Manager as _;
    if word_ids.is_empty() {
        return Err("沒有單字可打包".to_string());
    }
    let fname = std::path::Path::new(&filename)
        .file_name()
        .ok_or("非法檔名")?
        .to_string_lossy()
        .to_string();
    if fname == "." || fname == ".." {
        return Err("非法檔名".to_string());
    }

    let app_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    let packed = pack_from_db(&app_dir.join("teno.db"), &csv, &word_ids)?;
    let zip_bytes = packed.bytes;
    let (media_len, skipped) = (packed.images, packed.skipped);

    // 存檔：桌機對話框；Android 走 MediaStore（EXPORTBIG1 同路）
    #[cfg(target_os = "android")]
    {
        let exports = app_dir.join("exports");
        std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
        let tmp = exports.join(&fname);
        std::fs::write(&tmp, &zip_bytes).map_err(|e| format!("寫入暫存失敗: {}", e))?;
        let r = app_handle
            .state::<crate::tts_android::TtsHandle>()
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "saveFileToDownloads",
                serde_json::json!({
                    "path": tmp.to_string_lossy(),
                    "filename": fname,
                    "mime": "application/zip",
                }),
            )
            .map_err(|e| format!("Android save export: {:?}", e));
        let _ = std::fs::remove_file(&tmp);
        r?;
        return Ok(
            serde_json::json!({"path": fname, "images": media_len, "skipped": skipped})
                .to_string(),
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_dialog::DialogExt;
        use tokio::sync::oneshot;
        let (tx, rx) = oneshot::channel();
        app_handle
            .dialog()
            .file()
            .add_filter("Teno 分享包", &["zip"])
            .set_file_name(&fname)
            .save_file(move |file| {
                let _ = tx.send(file);
            });
        let file = rx
            .await
            .map_err(|_| "對話框錯誤".to_string())?
            .ok_or_else(|| "使用者取消".to_string())?;
        use tauri_plugin_dialog::FilePath;
        match file {
            FilePath::Path(dest) => {
                std::fs::write(&dest, &zip_bytes)
                    .map_err(|e| format!("寫入分享包失敗: {}", e))?;
                log::info!("export_share_pack OK dst={:?}", dest);
                Ok(serde_json::json!({
                    "path": dest.display().to_string(),
                    "images": media_len,
                    "skipped": skipped,
                })
                .to_string())
            }
            FilePath::Url(_url) => {
                let exports = app_dir.join("exports");
                std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
                let safe: String = fname
                    .chars()
                    .filter(|c| {
                        c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_'
                    })
                    .collect();
                let fallback =
                    exports.join(if safe.is_empty() { "share.zip" } else { &safe });
                std::fs::write(&fallback, &zip_bytes)
                    .map_err(|e| format!("寫入失敗: {}", e))?;
                Ok(serde_json::json!({
                    "path": fallback.display().to_string(),
                    "images": media_len,
                    "skipped": skipped,
                })
                .to_string())
            }
        }
    }
}

/// 匯入：選分享包 → 回 csv＋manifest＋媒體清單；本體存 temp，圖片逐張取。
#[tauri::command]
pub async fn import_share_pack_dialog(
    app_handle: tauri::AppHandle,
) -> Result<SharePackInspect, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("Teno 分享包", &["zip"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let file = rx
        .await
        .map_err(|_| "對話框錯誤".to_string())?
        .ok_or_else(|| "使用者取消".to_string())?;
    #[cfg(target_os = "android")]
    let src = match file {
        tauri_plugin_dialog::FilePath::Path(p) => p,
        tauri_plugin_dialog::FilePath::Url(u) => {
            let cached =
                crate::tts_android::copy_uri_to_cache(app_handle.clone(), u.to_string())
                    .await?;
            std::path::PathBuf::from(cached)
        }
    };
    #[cfg(not(target_os = "android"))]
    let src = file.into_path().map_err(|_| "無法取得路徑".to_string())?;
    let data = std::fs::read(&src).map_err(|e| format!("讀取檔案失敗: {}", e))?;
    if data.len() > MAX_PACK_BYTES {
        return Err(format!(
            "檔案過大（{}MB > 500MB），拒絕匯入",
            data.len() / (1024 * 1024)
        ));
    }
    let (csv, manifest, files) = inspect_pack_bytes(&data)?;
    let file_name = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let dir = share_temp_dir(&app_handle)?;
    cleanup_old_temp(&dir);
    let token = random_temp_name();
    std::fs::write(dir.join(format!("{token}.tenopack")), &data)
        .map_err(|e| format!("寫入暫存失敗: {e}"))?;
    log::info!(
        "import_share_pack src={:?} csv_len={} media={}",
        src,
        csv.len(),
        files.len()
    );
    Ok(SharePackInspect {
        csv,
        files,
        manifest,
        media_token: token,
        file_name,
    })
}

fn inspect_pack_bytes(
    data: &[u8],
) -> Result<(String, Vec<PackManifestFile>, Vec<SharePackFile>), String> {
    if data.is_empty() {
        return Err("不是有效的分享包（空檔）".to_string());
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|_| "不是有效的分享包（zip 解不開）".to_string())?;
    let mut csv_buf = Vec::new();
    match z.by_name("words.csv") {
        Ok(mut f) => {
            f.read_to_end(&mut csv_buf)
                .map_err(|e| format!("讀取 words.csv 失敗: {}", e))?;
        }
        Err(_) => return Err("不是有效的分享包（缺少 words.csv）".to_string()),
    }
    let csv = String::from_utf8(csv_buf).map_err(|_| "words.csv 非 UTF-8".to_string())?;
    let csv = csv.trim_start_matches('\u{FEFF}').to_string();
    let manifest: PackManifest = match z.by_name("manifest.json") {
        Ok(mut f) => {
            let mut s = String::new();
            f.read_to_string(&mut s)
                .map_err(|e| format!("讀取 manifest 失敗: {}", e))?;
            serde_json::from_str(&s).unwrap_or_default()
        }
        Err(_) => PackManifest::default(),
    };
    let mut files = Vec::new();
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().to_string();
        if name.starts_with("media/") && !name.ends_with('/') {
            files.push(SharePackFile {
                file: name,
                size: f.size(),
            });
        }
    }
    Ok((csv, manifest.files, files))
}

/// 匯入時逐張取圖 → data URL（單張 10MB 守門；失敗記 skipped 不整批掛）。
#[tauri::command]
pub async fn get_share_media(
    app_handle: tauri::AppHandle,
    filename: String,
    token: Option<String>,
) -> Result<String, String> {
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .ok_or("非法檔名")?
        .to_string_lossy()
        .to_string();
    // manifest 記的是 media/xxx；只允許該前綴（防 ../ 穿越）
    let inner = format!("media/{safe_name}");
    let dir = share_temp_dir(&app_handle)?;
    let tmp_path = resolve_pack_tmp(&dir, token.as_deref())
        .ok_or("沒有已解析的分享包（請先選檔）".to_string())?;
    let data = std::fs::read(&tmp_path).map_err(|e| format!("讀取暫存失敗: {}", e))?;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&data[..]))
        .map_err(|e| format!("暫存 zip 解不開: {}", e))?;
    let mut f = z
        .by_name(inner.as_str())
        .map_err(|_| format!("媒體不存在: {}", safe_name))?;
    if f.size() > MAX_MEDIA_BYTES as u64 {
        return Err(format!("媒體過大（>10MB）: {}", safe_name));
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("讀取媒體失敗: {}", e))?;
    if buf.len() > MAX_MEDIA_BYTES {
        return Err(format!("媒體過大（>10MB）: {}", safe_name));
    }
    let b64 = base64_encode(&buf);
    let mime = mime_from_ext(
        std::path::Path::new(&safe_name)
            .extension()
            .and_then(|e| e.to_str()),
    );
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn data_url_roundtrip() {
        let raw = b"fake-png-bytes\x00\xff";
        let enc = base64_encode(raw);
        let (mime, back) =
            decode_data_url(&format!("data:image/png;base64,{}", enc)).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(back, raw);
        assert!(decode_data_url("https://x/y.jpg").is_none());
        assert!(decode_data_url("data:image/png,abc").is_none());
        assert!(decode_data_url("not-a-url").is_none());
    }

    #[test]
    fn safe_names_ascii_and_unique() {
        assert_eq!(safe_media_name("ant", 1, "a.png", "image/png"), "ant-1.png");
        assert_eq!(
            safe_media_name("off the hook", 2, "x.GIF", "image/gif"),
            "off_the_hook-2.gif"
        );
        // 中文全壓成底線→空→img 回退
        assert_eq!(safe_media_name("蘋果", 1, "", "image/jpeg"), "img-1.jpg");
        // 非圖片副檔名按 mime 猜
        assert_eq!(safe_media_name("ant", 1, "a.xyz", "image/webp"), "ant-1.webp");
        // 穿越檔名只取副檔名
        assert_eq!(
            safe_media_name("ant", 1, "../evil.png", "image/png"),
            "ant-1.png"
        );
    }

    #[test]
    fn pack_roundtrip_layout() {
        // 空包：words.csv＋manifest.json 必在；media 可空
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts: zip::write::SimpleFileOptions = Default::default();
        zw.start_file("words.csv", opts).unwrap();
        zw.write_all(b"\xEF\xBB\xBFword,definition\nant,\xE8\x9E\xA0\xE8\x9F\xBB")
            .unwrap();
        zw.start_file("manifest.json", opts).unwrap();
        zw.write_all(br#"{"version":1,"files":[]}"#).unwrap();
        let bytes = zw.finish().unwrap().into_inner();
        let (csv, manifest, files) = inspect_pack_bytes(&bytes).unwrap();
        assert!(csv.starts_with("word,definition"));
        assert!(manifest.is_empty() && files.is_empty());
        // 缺 words.csv 拒收
        let mut zw2 = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zw2.start_file("manifest.json", opts).unwrap();
        zw2.write_all(b"{}").unwrap();
        let bad = zw2.finish().unwrap().into_inner();
        assert!(inspect_pack_bytes(&bad).is_err());
        assert!(inspect_pack_bytes(b"not a zip").is_err());
    }

    #[test]
    fn manifest_filters_by_word() {
        // manifest 只是透傳清單；匯入端按 word+deck 對 id（前端職責），此處釘格式
        let m: PackManifest = serde_json::from_str(
            r#"{"version":1,"files":[{"word":"ant","deck":"D1","file":"media/ant-1.png"}]}"#,
        )
        .unwrap();
        assert_eq!(m.version, 1);
        assert_eq!(m.files[0].file, "media/ant-1.png");
    }

    // 端到端：真 SQLite → pack_from_db → 解 zip 驗位元組。
    // 這條才是「真的能跑」的證據（前面的純函式測不到 DB 讀取與 zip 佈局）。
    #[test]
    fn pack_from_real_db_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sp-rt-{}", random_temp_name()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("teno.db");
        // 真表：words(id,word,deck)＋word_images(word_id,filename,data)
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE words(id TEXT PRIMARY KEY, word TEXT, deck TEXT);
             CREATE TABLE word_images(id INTEGER PRIMARY KEY AUTOINCREMENT,
                 word_id TEXT, filename TEXT, data TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO words(id,word,deck) VALUES('w1','ant','D1'),('w2','off the hook','D2')",
            [],
        )
        .unwrap();
        let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 0x00, 0xFF];
        let d1 = format!("data:image/png;base64,{}", base64_encode(&png));
        conn.execute(
            "INSERT INTO word_images(word_id,filename,data) VALUES
             ('w1','a.png',?1),('w1','../evil.png',?1),('w2','x.gif','data:image/gif;base64,!!bad'),
             ('w9','ghost.png',?1),('w1','ok.png','https://example.invalid/none.png')",
            rusqlite::params![d1],
        )
        .unwrap();
        drop(conn);

        // ids 帶 w9：w9 有圖但 words 無此列（懸空 FK）→ 查詢會取到，靠 id_meta miss 擋掉。
        let ids = vec!["w1".to_string(), "w2".to_string(), "w9".to_string()];
        let packed = pack_from_db(&db, "word,definition\nant,螞蟻", &ids).unwrap();
        assert_eq!(packed.words, 2, "只有 w1/w2 在 words 表，w9 是懸空 FK");
        // w1 兩張好圖（a.png＋evil.png 都解得出）；w2 的 data URL 壞掉跳過；
        // w9 的圖有列但無對應字（懸空）跳過；w1 的 http 直連 example.invalid 下載失敗跳過。
        assert_eq!(packed.images, 2, "只收得到那兩張");
        assert_eq!(packed.skipped, 3, "壞 data URL＋懸空 FK＋下載失敗");

        // 解包驗佈局與位元組
        let mut za = zip::ZipArchive::new(std::io::Cursor::new(packed.bytes.clone())).unwrap();
        let names: Vec<String> = (0..za.len())
            .map(|i| za.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"words.csv".to_string()));
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(names.iter().any(|n| n.starts_with("media/")), "要有 media/ 條目");
        assert!(names.iter().all(|n| !n.contains("..")), "不得有穿越檔名");

        // words.csv 帶 BOM
        let mut csv = String::new();
        {
            use std::io::Read as _;
            za.by_name("words.csv").unwrap().read_to_string(&mut csv).unwrap();
        }
        assert!(csv.starts_with('\u{feff}'), "CSV 要帶 BOM");

        // manifest 指向的檔案真的存在，且位元組 == 原圖
        let mut mj = String::new();
        {
            use std::io::Read as _;
            za.by_name("manifest.json").unwrap().read_to_string(&mut mj).unwrap();
        }
        let m: PackManifest = serde_json::from_str(&mj).unwrap();
        assert_eq!(m.files.len(), 2);
        assert!(m.files.iter().all(|f| f.word == "ant"), "w2 的圖壞掉不該進 manifest");
        for f in &m.files {
            let mut got = Vec::new();
            {
                use std::io::Read as _;
                za.by_name(&f.file).unwrap().read_to_end(&mut got).unwrap();
            }
            assert_eq!(got, png, "包內圖位元組要跟原圖一致: {}", f.file);
        }
        // ── 閉環：打包輸出直接餵匯入端解析器 ──
        drop(za);
        let (csv2, manifest2, files2) = inspect_pack_bytes(&packed.bytes).unwrap();
        assert!(csv2.contains("ant"), "匯入端讀到的 CSV 要有內容");
        assert_eq!(manifest2.len(), 2, "匯入端 manifest 兩筆");
        assert_eq!(files2.len(), 2, "匯入端媒體清單兩筆");
        assert!(manifest2.iter().all(|f| f.word == "ant"));
        // manifest 的 file 要在媒體清單裡（匯入端靠這對應去 get_share_media）
        for f in &manifest2 {
            assert!(files2.iter().any(|x| x.file == f.file), "manifest 指向的檔要在清單: {}", f.file);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
