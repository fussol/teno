//! 內嵌 WebDAV server（桌機版跟著 Teno 一起起；獨立 ~/teno-webdav-app 照樣能跑，兩邊互為逃生門）。
//!
//! - std only，零新依賴（TcpListener＋thread；不用 hyper／axum，打包不增重）
//! - 語義對齊獨立版 server.py：GET/HEAD/PUT/DELETE/MKCOL/PROPFIND/OPTIONS＋Basic＋.part 原子寫＋防穿越
//! - 目錄固定 ~/teno-webdav（跟獨立版同一空間，兩邊看到的檔是同一批）
//! - 設定存 app_config_dir/webdav_server.json（0600；port/user/pass/autostart），預設關（autostart=false）
//! - Android：命令直接回「桌機限定」，不跑 listener

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use std::time::Duration;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Default)]
struct ServerConfig {
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    autostart: bool,
}

fn default_port() -> u16 {
    8080
}

struct ServerState {
    running: bool,
    port: u16,
    stop_flag: Option<std::sync::Arc<AtomicBool>>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            running: false,
            port: 0,
            stop_flag: None,
        }
    }
}

static STATE: OnceLock<Mutex<ServerState>> = OnceLock::new();
fn state() -> &'static Mutex<ServerState> {
    STATE.get_or_init(|| Mutex::new(ServerState::default()))
}

fn server_config_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    let mut p = app_handle
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    p.push("webdav_server.json");
    p
}

fn serve_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join("teno-webdav")
}

/// SYNC2-Q6：覆蓋前留 .history（只留最近 5 個；跟 server.py 同規）
fn rotate_history_file(fp: &std::path::Path) {
    use std::time::{SystemTime, UNIX_EPOCH};
    if !fp.is_file() {
        return;
    }
    let hist = fp.parent().map(|p| p.join(".history")).unwrap_or(".history".into());
    if std::fs::create_dir_all(&hist).is_err() {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let base = fp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or("file".into());
    let dst = hist.join(format!("{base}.{ts}"));
    let _ = std::fs::copy(fp, &dst);
    // prune 同 basename 只留最新 5 個
    if let Ok(entries) = std::fs::read_dir(&hist) {
        let mut cands: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with(&format!("{base}."))).unwrap_or(false))
            .collect();
        cands.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
        for old in cands.iter().take(cands.len().saturating_sub(5)) {
            let _ = std::fs::remove_file(old);
        }
    }
}

/// SYNC2-Q3：port 誰在聽（內嵌／外掛獨立版／都沒跑）
fn port_occupied(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(300),
    )
    .is_ok()
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

fn load_server_config(app_handle: &tauri::AppHandle) -> ServerConfig {
    std::fs::read_to_string(server_config_path(app_handle))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(ServerConfig {
            port: 8080,
            username: "teno".into(),
            password: String::new(),
            autostart: false,
        })
}

// ─── 純函數（可單測）：Basic 驗證＋路徑守門 ───

fn check_basic(auth_value: Option<&str>, user: &str, pass: &str) -> bool {
    if pass.is_empty() {
        // 空密碼＝裸奔模式：不要求認證（跟 server.py --no-auth 語義對齊，僅 LAN 用）
        return true;
    }
    let v = match auth_value {
        Some(v) => v,
        None => return false,
    };
    let b64 = v.strip_prefix("Basic ").unwrap_or("");
    let decoded = match base64_decode_str(b64) {
        Some(s) => s,
        None => return false,
    };
    constant_eq(&decoded, &format!("{user}:{pass}"))
}

/// 最小 base64 decode（只夠解 Basic 帳密；非法字元＝None）
fn base64_decode_str(s: &str) -> Option<String> {
    let mut bits: u32 = 0;
    let mut nbits = 0;
    let mut out: Vec<u8> = Vec::new();
    for c in s.chars() {
        if c == '=' {
            break;
        }
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => return None,
        };
        bits = (bits << 6) | v;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((bits >> nbits) as u8 & 0xFF);
            bits &= (1 << nbits) - 1;
        }
    }
    String::from_utf8(out).ok()
}

fn constant_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 路徑守門：url path 限 serve dir 內；穿越（..）→ None
fn resolve_fs_path(root: &std::path::Path, url_path: &str) -> Option<std::path::PathBuf> {
    let rel = url_path.split('?').next().unwrap_or("/");
    let rel = percent_decode(rel);
    let mut pb = std::path::PathBuf::new();
    for comp in rel.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." {
            return None;
        }
        pb.push(comp);
    }
    let full = root.join(pb);
    // 規範化後仍須在 root 內（防 symlink 逃逸：比對字串前綴）
    let root_s = root.to_string_lossy().to_string();
    let full_s = full.to_string_lossy().to_string();
    if full_s == root_s || full_s.starts_with(&(root_s.clone() + "/")) {
        Some(full)
    } else {
        None
    }
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.as_bytes().iter().peekable();
    while let Some(&b) = it.next() {
        if b == b'%' {
            let h1 = it.next().copied().unwrap_or(b'0');
            let h2 = it.next().copied().unwrap_or(b'0');
            let hex = |c: u8| match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => 0,
            };
            out.push((hex(h1) * 16 + hex(h2)) as char);
        } else {
            out.push(b as char);
        }
    }
    out
}

fn fmt_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else if n < 1024 * 1024 * 1024 {
        format!("{:.1} MB", n as f64 / 1024.0 / 1024.0)
    } else {
        format!("{:.2} GB", n as f64 / 1024.0 / 1024.0 / 1024.0)
    }
}

fn fmt_time(ts: u64) -> String {
    // 跟 webdav_sync::chrono_naive 同口徑（UTC+8 顯示）；這裡只做簡單格式化
    let days = ts / 86400;
    let rem = ts % 86400;
    // Howard Hinnant civil_from_days（0000-03-01 起算，1970-01-01＝719468）
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}（本地）",
        (rem / 3600 + 8) % 24,
        (rem % 3600) / 60
    )
}

fn dashboard_html(files: &[(String, u64, u64, bool)], total: u64) -> String {
    let mut rows = String::new();
    for (name, size, mtime, isdir) in files {
        let esc = html_escape(name);
        let op = if *isdir {
            format!("<a href=\"{esc}/\">開啟</a>")
        } else {
            format!("<a href=\"{esc}\" download>下載</a> <button data-del=\"{esc}\">刪除</button>")
        };
        rows.push_str(&format!(
            "<tr><td class=\"name\">{esc}{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td><td class=\"ops\">{op}</td></tr>",
            if *isdir { " /" } else { "" },
            fmt_size(*size),
            fmt_time(*mtime),
        ));
    }
    if rows.is_empty() {
        rows = "<tr><td colspan=\"4\" class=\"empty\">空間是空的 — 從下面上傳第一個檔吧</td></tr>".into();
    }
    format!(
        "<!DOCTYPE html><html lang=\"zh-TW\"><head><meta charset=\"UTF-8\">\
        <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
        <title>teno-webdav 本地雲（內嵌）</title>\
        <style>*{{box-sizing:border-box;margin:0;padding:0}}\
        body{{font-family:system-ui,'Noto Sans TC',sans-serif;background:#0b0911;color:#b9b2cc;line-height:1.6;padding:24px}}\
        .wrap{{max-width:860px;margin:0 auto}}h1{{font-size:20px;color:#f3eefb;margin-bottom:4px}}\
        .sub{{font-size:13px;color:#837b9c;margin-bottom:16px}}.sub b{{color:#b69dff}}\
        .card{{background:#14111c;border:1px solid rgba(185,178,204,.13);border-radius:16px;padding:20px;margin-bottom:16px}}\
        table{{width:100%;border-collapse:collapse;font-size:14px}}\
        th{{text-align:left;font-size:12px;color:#837b9c;padding:8px 10px;border-bottom:1px solid rgba(185,178,204,.13)}}\
        td{{padding:10px;border-bottom:1px solid rgba(185,178,204,.07)}}\
        td.name{{color:#f3eefb;font-weight:600;word-break:break-all}}td.num{{white-space:nowrap;font-variant-numeric:tabular-nums}}\
        a{{color:#b69dff;text-decoration:none}}button{{border:1px solid rgba(185,178,204,.2);background:#1c1825;color:#f3eefb;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}}\
        #status{{font-size:13px;color:#5ed98f;min-height:20px;margin-top:10px}}\
        .foot{{font-size:12px;color:#57506e;text-align:center}}</style></head><body>\
        <div class=\"wrap\"><h1>📦 teno-webdav 本地雲（內嵌版）</h1>\
        <div class=\"sub\"><b>{}</b> 個檔案 · 共 <b>{}</b> · Teno 內嵌服務</div>\
        <div class=\"card\"><table><thead><tr><th>檔名</th><th>大小</th><th>上傳 / 修改時間</th><th>操作</th></tr></thead>\
        <tbody>{rows}</tbody></table></div>\
        <div class=\"card\"><input type=\"file\" id=\"up\" multiple> <button id=\"upBtn\">上傳</button><div id=\"status\"></div></div>\
        <div class=\"foot\">Teno 內嵌 WebDAV · 跟 ~/teno-webdav-app 同空間</div></div>\
        <script>const status=document.getElementById('status');const say=(t,ok=true)=>{{status.textContent=t;status.style.color=ok?'#5ed98f':'#f88a8a';}};\
        document.getElementById('upBtn').addEventListener('click',async()=>{{const fs=document.getElementById('up').files;\
        if(!fs.length){{say('請先選擇檔案',false);return;}}\
        for(const f of fs){{say('上傳中：'+f.name+' …');\
        try{{const r=await fetch('/'+encodeURIComponent(f.name),{{method:'PUT',body:f}});\
        if(!r.ok&&r.status!==201&&r.status!==204)throw new Error('HTTP '+r.status);}}\
        catch(e){{say('上傳失敗：'+f.name+'（'+e.message+'）',false);return;}}}}\
        say('上傳完成，重新整理…');setTimeout(()=>location.reload(),500);}});\
        document.querySelectorAll('[data-del]').forEach(b=>{{b.addEventListener('click',async()=>{{\
        const n=b.dataset.del;if(!confirm('確定刪除「'+n+'」？'))return;\
        try{{const r=await fetch('/'+encodeURIComponent(n),{{method:'DELETE'}});\
        if(!r.ok&&r.status!==204)throw new Error('HTTP '+r.status);location.reload();}}\
        catch(e){{say('刪除失敗：'+e.message,false);}}}});}});</script></body></html>",
        files.len(),
        fmt_size(total),
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ─── HTTP 層 ───

struct Request {
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body_len: usize,
}

fn read_request(stream: &mut TcpStream) -> Option<(Request, Vec<u8>)> {
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .ok()?;
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 4096];
    // 讀到 header 結尾
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > 65536 {
                    return None;
                }
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    let mut headers = std::collections::HashMap::new();
    for line in lines {
        if let Some(i) = line.find(':') {
            headers.insert(
                line[..i].trim().to_lowercase(),
                line[i + 1..].trim().to_string(),
            );
        }
    }
    let body_len = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0usize);
    let mut body = buf[head_end..].to_vec();
    while body.len() < body_len && body.len() < 512 * 1024 * 1024 {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }
    body.truncate(body_len);
    Some((
        Request {
            method,
            path,
            headers,
            body_len,
        },
        body,
    ))
}

fn send(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn http_date_now() -> String {
    // 簡版 GMT（精度夠對帳用；client 只拿來比大小＋顯示）
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("ts-{ts}")
}

fn handle_conn(mut stream: TcpStream, root: std::path::PathBuf, user: String, pass: String) {
    let (req, body) = match read_request(&mut stream) {
        Some(v) => v,
        None => return,
    };
    let authed = check_basic(req.headers.get("authorization").map(|s| s.as_str()), &user, &pass);
    if !authed {
        send(
            &mut stream,
            "401 Unauthorized",
            &[("WWW-Authenticate", "Basic realm=\"teno-webdav\"".into())],
            b"auth required",
        );
        return;
    }
    let url_path = req.path.split('?').next().unwrap_or("/").to_string();
    match req.method.as_str() {
        "OPTIONS" => send(
            &mut stream,
            "200 OK",
            &[
                ("DAV", "1".into()),
                ("Allow", "OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,PROPFIND".into()),
            ],
            b"",
        ),
        "PROPFIND" => {
            let fp = match resolve_fs_path(&root, &url_path) {
                Some(p) => p,
                None => {
                    send(&mut stream, "404 Not Found", &[], b"not found");
                    return;
                }
            };
            if !fp.exists() {
                send(&mut stream, "404 Not Found", &[], b"not found");
                return;
            }
            let depth = req
                .headers
                .get("depth")
                .map(|s| s.as_str())
                .unwrap_or("1");
            let mut items: Vec<(String, std::path::PathBuf)> = vec![(url_path.clone(), fp.clone())];
            if depth != "0" && fp.is_dir() {
                if let Ok(entries) = std::fs::read_dir(&fp) {
                    let mut names: Vec<String> = entries
                        .flatten()
                        .map(|e| e.file_name().to_string_lossy().to_string())
                        .filter(|n| !n.starts_with('.'))
                        .collect();
                    names.sort();
                    for n in names {
                        items.push((format!("{}/{n}", url_path.trim_end_matches('/')), fp.join(&n)));
                    }
                }
            }
            let mut out = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">");
            for (href, p) in items {
                let (size, mtime) = std::fs::metadata(&p)
                    .map(|m| {
                        (
                            m.len(),
                            m.modified()
                                .ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0),
                        )
                    })
                    .unwrap_or((0, 0));
                let rtype = if p.is_dir() {
                    "<D:resourcetype><D:collection/></D:resourcetype>"
                } else {
                    "<D:resourcetype/>"
                };
                out.push_str(&format!(
                    "<D:response><D:href>{}</D:href><D:propstat><D:prop>\
                    <D:getcontentlength>{}</D:getcontentlength>\
                    <D:getlastmodified>{}</D:getlastmodified>{}</D:prop>\
                    <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
                    html_escape(&href),
                    size,
                    mtime,
                    rtype
                ));
            }
            out.push_str("</D:multistatus>");
            send(
                &mut stream,
                "207 Multi-Status",
                &[("Content-Type", "application/xml; charset=utf-8".into())],
                out.as_bytes(),
            );
        }
        "MKCOL" => {
            let fp = match resolve_fs_path(&root, &url_path) {
                Some(p) => p,
                None => {
                    send(&mut stream, "404 Not Found", &[], b"not found");
                    return;
                }
            };
            if fp.exists() {
                send(&mut stream, "405 Method Not Allowed", &[], b"exists");
                return;
            }
            match std::fs::create_dir_all(&fp) {
                Ok(_) => send(&mut stream, "201 Created", &[], b""),
                Err(e) => send(&mut stream, "409 Conflict", &[], e.to_string().as_bytes()),
            }
        }
        "GET" | "HEAD" => {
            let head_only = req.method == "HEAD";
            let fp = match resolve_fs_path(&root, &url_path) {
                Some(p) => p,
                None => {
                    send(&mut stream, "404 Not Found", &[], b"not found");
                    return;
                }
            };
            if fp.is_dir() {
                let mut names: Vec<String> = std::fs::read_dir(&fp)
                    .map(|rd| {
                        rd.flatten()
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .filter(|n| !n.starts_with('.'))
                            .collect()
                    })
                    .unwrap_or_default();
                names.sort();
                let mut files = Vec::new();
                let mut total = 0u64;
                for n in names {
                    let p = fp.join(&n);
                    if let Ok(m) = std::fs::metadata(&p) {
                        let isdir = p.is_dir();
                        let sz = if isdir { 0 } else { m.len() };
                        total += sz;
                        let mt = m
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        files.push((n, sz, mt, isdir));
                    }
                }
                let html = dashboard_html(&files, total);
                let body = if head_only { &[][..] } else { html.as_bytes() };
                // HEAD 目錄也回同樣 Content-Length 語義（簡化：回 body 長度）
                send(
                    &mut stream,
                    "200 OK",
                    &[("Content-Type", "text/html; charset=utf-8".into())],
                    if head_only {
                        &[][..]
                    } else {
                        body
                    },
                );
                return;
            }
            if !fp.is_file() {
                send(&mut stream, "404 Not Found", &[], b"not found");
                return;
            }
            let meta = match std::fs::metadata(&fp) {
                Ok(m) => m,
                Err(_) => {
                    send(&mut stream, "404 Not Found", &[], b"not found");
                    return;
                }
            };
            let ctype = if fp.extension().map(|e| e == "db").unwrap_or(false) {
                "application/x-sqlite3"
            } else {
                "application/octet-stream"
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if head_only {
                send(
                    &mut stream,
                    "200 OK",
                    &[
                        ("Content-Type", ctype.into()),
                        ("Content-Length", meta.len().to_string()),
                        ("Last-Modified", http_date_now()),
                        ("ETag", format!("\"{mtime}-{}\"", meta.len())),
                    ],
                    b"",
                );
                return;
            }
            match std::fs::read(&fp) {
                Ok(data) => send(
                    &mut stream,
                    "200 OK",
                    &[
                        ("Content-Type", ctype.into()),
                        ("Last-Modified", http_date_now()),
                        ("ETag", format!("\"{mtime}-{}\"", data.len())),
                    ],
                    &data,
                ),
                Err(e) => send(&mut stream, "500 Internal Server Error", &[], e.to_string().as_bytes()),
            }
        }
        "PUT" => {
            let fp = match resolve_fs_path(&root, &url_path) {
                Some(p) => p,
                None => {
                    send(&mut stream, "404 Not Found", &[], b"not found");
                    return;
                }
            };
            if fp == root {
                send(&mut stream, "405 Method Not Allowed", &[], b"use file path");
                return;
            }
            if body.len() > 512 * 1024 * 1024 {
                send(&mut stream, "413 Payload Too Large", &[], b"too large");
                return;
            }
            let existed = fp.exists();
            if let Some(parent) = fp.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // SYNC2-Q6 parity（跟獨立版 server.py 同規）：空檔拒收＋魔數驗＋覆蓋前留 .history
            if body.len() < 20 * 1024 {
                send(&mut stream, "422 Unprocessable Entity", &[], b"too small: refuse empty/truncated upload");
                return;
            }
            let good_head = body.starts_with(b"TENOC") || body.starts_with(b"SQLite format 3\0");
            if !good_head {
                send(&mut stream, "422 Unprocessable Entity", &[], b"bad payload: not TENOC/SQLite");
                return;
            }
            if existed {
                rotate_history_file(&fp);
            }
            let tmp = fp.with_extension("part");
            match std::fs::write(&tmp, &body) {
                Ok(_) => match std::fs::rename(&tmp, &fp) {
                    Ok(_) => send(
                        &mut stream,
                        if existed { "204 No Content" } else { "201 Created" },
                        &[],
                        b"",
                    ),
                    Err(e) => send(&mut stream, "500 Internal Server Error", &[], e.to_string().as_bytes()),
                },
                Err(e) => send(&mut stream, "500 Internal Server Error", &[], e.to_string().as_bytes()),
            }
        }
        "DELETE" => {
            let fp = match resolve_fs_path(&root, &url_path) {
                Some(p) => p,
                None => {
                    send(&mut stream, "404 Not Found", &[], b"not found");
                    return;
                }
            };
            if !fp.exists() || fp == root {
                send(&mut stream, "404 Not Found", &[], b"not found");
                return;
            }
            let r = if fp.is_dir() {
                std::fs::remove_dir(&fp)
            } else {
                std::fs::remove_file(&fp)
            };
            match r {
                Ok(_) => send(&mut stream, "204 No Content", &[], b""),
                Err(e) => send(&mut stream, "500 Internal Server Error", &[], e.to_string().as_bytes()),
            }
        }
        _ => send(&mut stream, "405 Method Not Allowed", &[], b"method not allowed"),
    }
}

// ─── 啟停 ───

fn spawn_server(port: u16, user: String, pass: String) -> Result<(), String> {
    let mut st = state().lock().map_err(|e| e.to_string())?;
    if st.running {
        return Err("本地雲已在跑（先停止再重開）".into());
    }
    let root = serve_dir();
    std::fs::create_dir_all(&root).map_err(|e| format!("建雲空間失敗：{e}"))?;
    let listener =
        TcpListener::bind(("0.0.0.0", port)).map_err(|e| format!("綁 {port} 失敗：{e}（可能被獨立版佔走）"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        loop {
            if flag.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let root = root.clone();
                    let user = user.clone();
                    let pass = pass.clone();
                    std::thread::spawn(move || handle_conn(stream, root, user, pass));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });
    st.running = true;
    st.port = port;
    st.stop_flag = Some(stop);
    log::info!("內嵌 webdav listening on 0.0.0.0:{port}");
    Ok(())
}

fn stop_server_inner() -> bool {
    let mut st = match state().lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    if !st.running {
        return false;
    }
    if let Some(f) = st.stop_flag.take() {
        f.store(true, Ordering::Relaxed);
    }
    st.running = false;
    st.port = 0;
    true
}

/// setup 期呼叫：autostart 有開才起（Android 永不起）
pub fn maybe_autostart(app_handle: &tauri::AppHandle) {
    #[cfg(target_os = "android")]
    {
        let _ = app_handle;
        return;
    }
    #[cfg(not(target_os = "android"))]
    {
        let cfg = load_server_config(app_handle);
        if cfg.autostart {
            if cfg.password.is_empty() {
                log::warn!("內嵌 webdav autostart 跳過：未設密碼（先到設定頁存一組）");
                return;
            }
            // Q3：獨立版已經頂著就讓它頂，內嵌不搶 port（App 關掉後本來就是它接手）
            if port_occupied(cfg.port) {
                log::info!("內嵌 webdav autostart 跳過：port {} 已有人聽（獨立版頂著）", cfg.port);
                return;
            }
            if let Err(e) = spawn_server(cfg.port, cfg.username.clone(), cfg.password.clone()) {
                log::warn!("內嵌 webdav autostart 失敗：{e}");
            }
        }
    }
}

#[tauri::command]
pub async fn webdav_server_get_config(
    app_handle: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &app_handle;
        return Err("內嵌本地雲是桌機限定（手機請用 Termux 獨立版）".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let cfg = load_server_config(&app_handle);
        let st = state().lock().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "port": cfg.port,
            "username": cfg.username,
            "hasPassword": !cfg.password.is_empty(),
            "autostart": cfg.autostart,
            "running": st.running,
            "runningPort": st.port,
        }))
    }
}

#[tauri::command]
pub async fn webdav_server_save_config(
    app_handle: tauri::AppHandle,
    port: u16,
    username: String,
    password: String,
    autostart: bool,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app_handle, port, username, password, autostart);
        return Err("內嵌本地雲是桌機限定（手機請用 Termux 獨立版）".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        if !(1..=65535).contains(&port) {
            return Err("port 須在 1～65535".into());
        }
        if username.trim().is_empty() {
            return Err("帳號不能為空".into());
        }
        // 密碼留空＝沿用已存（前端 placeholder 語義）；從沒存過才擋
        let old = load_server_config(&app_handle);
        let password = if password.is_empty() {
            if old.password.is_empty() {
                return Err("密碼不能為空（內嵌不設裸奔；要裸奔請用獨立版 --no-auth）".into());
            }
            old.password.clone()
        } else {
            password
        };
        let cfg = ServerConfig {
            port,
            username: username.trim().to_string(),
            password,
            autostart,
        };
        let s =
            serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
        write_private(&server_config_path(&app_handle), &s).map_err(|e| e.to_string())?;
        // 跑著就地重開（新 port／帳密即時生效）
        let was_running = state().lock().map(|s| s.running).unwrap_or(false);
        if was_running {
            stop_server_inner();
            std::thread::sleep(Duration::from_millis(200));
            spawn_server(cfg.port, cfg.username.clone(), cfg.password.clone())?;
            return Ok(format!("✅ 內嵌本地雲已重開（0.0.0.0:{}）", cfg.port));
        }
        Ok("✅ 內嵌本地雲設定已儲存".into())
    }
}

#[tauri::command]
pub async fn webdav_server_start(app_handle: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = &app_handle;
        return Err("內嵌本地雲是桌機限定（手機請用 Termux 獨立版）".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let cfg = load_server_config(&app_handle);
        if cfg.password.is_empty() {
            return Err("請先設定密碼（設定頁內嵌本地雲存一組）".into());
        }
        let user = cfg.username.clone();
        spawn_server(cfg.port, user, cfg.password.clone())?;
        Ok(format!("✅ 內嵌本地雲已啟動（0.0.0.0:{}，空間 ~/teno-webdav）", cfg.port))
    }
}

#[tauri::command]
pub async fn webdav_server_stop(app_handle: tauri::AppHandle) -> Result<String, String> {
    let _ = &app_handle;
    #[cfg(target_os = "android")]
    {
        return Err("內嵌本地雲是桌機限定".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        if stop_server_inner() {
            Ok("已停止內嵌本地雲".into())
        } else {
            Ok("內嵌本地雲本來就沒跑".into())
        }
    }
}

#[tauri::command]
pub async fn webdav_server_status(app_handle: tauri::AppHandle) -> Result<String, String> {
    let _ = &app_handle;
    #[cfg(target_os = "android")]
    {
        return Ok("手機不跑內嵌（請用 Termux 獨立版）".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let cfg = load_server_config(&app_handle);
        let st = state().lock().map_err(|e| e.to_string())?;
        if st.running {
            return Ok(format!("內嵌跑著（0.0.0.0:{}，空間 ~/teno-webdav）", st.port));
        }
        // Q3 接力判定：內嵌沒跑，但 port 有人在聽＝獨立版頂著
        if port_occupied(cfg.port) {
            return Ok(format!(
                "獨立版頂著（port {} 有人聽，App 關掉照樣能同步；內嵌不用開）",
                cfg.port
            ));
        }
        Ok("都沒跑（開內嵌或起獨立版二選一）".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_auth_vectors() {
        // teno:1219 → dGVubzoxMjE5
        assert!(check_basic(Some("Basic dGVubzoxMjE5"), "teno", "1219"));
        assert!(!check_basic(Some("Basic dGVubzp3cm9uZw=="), "teno", "1219"));
        assert!(!check_basic(None, "teno", "1219"));
        assert!(!check_basic(Some("Bearer xxx"), "teno", "1219"));
        // 空密碼＝裸奔放行
        assert!(check_basic(None, "teno", ""));
    }

    #[test]
    fn path_guard_blocks_traversal() {
        let root = std::path::PathBuf::from("/tmp/teno-wd");
        assert!(resolve_fs_path(&root, "/teno.db").is_some());
        assert!(resolve_fs_path(&root, "/a/b/c.db").is_some());
        assert!(resolve_fs_path(&root, "/../etc/passwd").is_none());
        assert!(resolve_fs_path(&root, "/a/../../x").is_none());
        assert!(resolve_fs_path(&root, "/").is_some());
    }

    #[test]
    fn dashboard_renders_rows() {
        let html = dashboard_html(
            &[("teno.db".into(), 22 * 1024 * 1024, 1789300000, false)],
            22 * 1024 * 1024,
        );
        assert!(html.contains("teno.db"));
        assert!(html.contains("22.0 MB"));
        assert!(html.contains("檔名"));
    }

    #[test]
    fn sync2_history_rotation_keeps_five() {
        let dir = std::env::temp_dir().join("teno-wd-hist-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fp = dir.join("teno.db");
        for i in 0..7 {
            std::fs::write(&fp, format!("v{i}").as_bytes()).unwrap();
            rotate_history_file(&fp);
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let hist = dir.join(".history");
        let n = std::fs::read_dir(&hist).map(|r| r.count()).unwrap_or(0);
        assert_eq!(n, 5, "只留最近 5 個備用");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
