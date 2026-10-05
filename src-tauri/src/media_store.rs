//! MEDIAPEEL1：媒體庫（content-addressed，SHA-1 檔名）。
//!
//! 約定：`{app_config_dir}/media/<sha1>.<ext>`，sha1＝圖片 raw bytes SHA-1 hex，
//! ext 按 mime（png/jpg/gif/webp）。DB `word_images.sha1` 只存索引，位元組落地檔案。
//! 讀路徑 sha1 優先、缺檔回退 DB data 欄（搬遷中間態不斷圖）。
//! 寫入只存 sha1，不再產生新的內嵌巨圖。

use crate::Ctx;

/// media 目錄（不存在即建；建失敗回錯，不靜默）。
fn media_dir(app: &Ctx) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("media");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 media 目錄失敗: {}", e))?;
    Ok(dir)
}

fn sha1_hex(data: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(data);
    let out = h.finalize();
    let mut s = String::with_capacity(40);
    for b in out {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        _ => "bin",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// data URL 解碼 → (mime, bytes)；非 data URL 回 None。
fn decode_data_url(s: &str) -> Option<(String, Vec<u8>)> {
    let s = s.trim();
    if !s.starts_with("data:") {
        return None;
    }
    let comma = s.find(',')?;
    let (head, b64) = (&s[..comma], &s[comma + 1..]);
    if !head.contains(";base64") {
        return None;
    }
    let mime = head["data:".len()..].split(';').next().unwrap_or("").to_string();
    if mime.is_empty() || !mime.starts_with("image/") {
        return None;
    }
    let bytes = b64_decode(b64)?;
    Some((mime, bytes))
}

/// 存一張圖：data URL 或 http(s) 直連（下載落地）→ 寫 media/<sha>.<ext>（已存在跳過）→ 回 {sha, ext, size}。
/// http 下載失敗回錯（呼叫端記 skipped，不整批掛）。
#[tauri::command]
pub async fn media_put(
    app_handle: Ctx,
    data: String,
    filename: Option<String>,
) -> Result<String, String> {
    let t = data.trim();
    let (mime, bytes): (String, Vec<u8>) = if let Some((m, b)) = decode_data_url(t) {
        (m, b)
    } else if t.starts_with("http://") || t.starts_with("https://") {
        // 直連下載落地（Tenor 有時效）；沿用 share_pack 下載語義但此處需同步拿位元組
        let bytes = download_bytes_sync(t)?;
        let ext = std::path::Path::new(filename.as_deref().unwrap_or(""))
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let mime = mime_for_ext(ext).to_string();
        (mime, bytes)
    } else {
        return Err("不支援的圖片格式（只收 data: URL 或 http(s) 直連）".into());
    };
    if bytes.is_empty() {
        return Err("空圖拒存".into());
    }
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("單圖超過 10MB，拒存".into());
    }
    let sha = sha1_hex(&bytes);
    let ext = ext_for_mime(&mime);
    let dir = media_dir(&app_handle)?;
    let fp = dir.join(format!("{}.{}", sha, ext));
    if !fp.is_file() {
        std::fs::write(&fp, &bytes).map_err(|e| format!("寫 media 檔失敗: {}", e))?;
    }
    Ok(serde_json::json!({"sha": sha, "ext": ext, "size": bytes.len()}).to_string())
}

/// 讀一張圖 → data URL（渲染用；單張 10MB 守門）。
#[tauri::command]
pub async fn media_get(app_handle: Ctx, sha: String, ext: Option<String>) -> Result<String, String> {
    let safe: String = sha.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if safe.len() != 40 || safe != sha {
        return Err("sha 非法（要 40 位 hex）".into());
    }
    let dir = media_dir(&app_handle)?;
    // ext 不對也找得到：掃同 sha 前綴
    let fp = if let Some(e) = ext.filter(|e| !e.is_empty()) {
        let safe_e: String = e.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        dir.join(format!("{}.{}", safe, safe_e))
    } else {
        find_by_sha(&dir, &safe).ok_or("找不到該圖（可能尚未同步下來）")?;
        find_by_sha(&dir, &safe).unwrap()
    };
    if !fp.is_file() {
        // ext 猜錯時再掃一次
        let found = find_by_sha(&dir, &safe).ok_or("找不到該圖（可能尚未同步下來）")?;
        return read_as_data_url(&found);
    }
    read_as_data_url(&fp)
}

fn find_by_sha(dir: &std::path::Path, sha: &str) -> Option<std::path::PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(sha) {
            Some(e.path())
        } else {
            None
        }
    })
}

fn read_as_data_url(fp: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(fp).map_err(|e| format!("讀 media 檔失敗: {}", e))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("圖超過 10MB，拒讀".into());
    }
    let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let mime = mime_for_ext(ext);
    Ok(format!(
        "data:{};base64,{}",
        mime,
        b64_encode(&bytes)
    ))
}

/// 列出本地 media shas（同步對帳用；回 [{sha, size}]）。
#[tauri::command]
pub async fn media_list(app_handle: Ctx) -> Result<String, String> {
    let dir = media_dir(&app_handle)?;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let mut parts = n.rsplitn(2, '.');
            let _ext = parts.next();
            let sha = parts.next().unwrap_or("");
            if sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(serde_json::json!({"sha": sha, "file": n, "size": size}));
            }
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn download_bytes_sync(url: &str) -> Result<Vec<u8>, String> {
    // ureq blocking（跟 webdav_sync 同 client 族；超時 30s）
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("下載圖失敗 {}: {}", url, e))?;
    let mut buf = Vec::new();
    use std::io::Read as _;
    resp.into_reader()
        .take(10 * 1024 * 1024 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("讀圖流失敗: {}", e))?;
    if buf.len() > 10 * 1024 * 1024 {
        return Err("下載的圖超過 10MB，拒收".into());
    }
    Ok(buf)
}


/// 最小 base64（跟 webdav_sync 同字母表；自包含不跨模組耦合）。
fn b64_encode(input: &[u8]) -> String {
    const ALPH: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPH[((n >> 18) & 63) as usize] as char);
        out.push(ALPH[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { ALPH[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPH[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        b'=' => Some(0),
        _ => None,
    }
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 4 != 0 { return None; }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let mut n = 0u32;
        for j in 0..4 { n = (n << 6) | b64_val(b[i + j])?; }
        out.push(((n >> 16) & 0xFF) as u8);
        if b[i + 3] != b'=' { out.push(((n >> 8) & 0xFF) as u8); }
        if b[i + 2] != b'=' { out.push((n & 0xFF) as u8); }
        // 非法 padding 位置（如 = 在中間）保守拒收
        if (b[i + 2] == b'=') != (b[i + 3] == b'=') && b[i + 2] == b'=' && i + 4 < b.len() { return None; }
        i += 4;
    }
    Some(out)
}

#[cfg(test)]
mod tests_b64 {
    use super::*;
    #[test]
    fn b64_roundtrip() {
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_decode("Zm9v").unwrap(), b"foo");
        assert!(b64_decode("!!!").is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_known_vector() {
        // SHA-1("abc") 標準向量
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn ext_mime_roundtrip() {
        assert_eq!(ext_for_mime("image/png"), "png");
        assert_eq!(ext_for_mime("image/jpeg"), "jpg");
        assert_eq!(ext_for_mime("image/gif"), "gif");
        assert_eq!(mime_for_ext("jpg"), "image/jpeg");
        assert_eq!(mime_for_ext("gif"), "image/gif");
    }

    #[test]
    fn decode_data_url_rejects() {
        assert!(decode_data_url("https://x/y.jpg").is_none());
        assert!(decode_data_url("data:text/plain;base64,abc").is_none());
        assert!(decode_data_url("not-a-url").is_none());
    }
}
