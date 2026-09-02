use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const AUTH_URI: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct DriveTokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct DriveCreds {
    client_id: String,
    client_secret: String,
}

fn creds_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("drive_creds.json");
    p
}

fn tokens_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("drive_tokens.json");
    p
}

fn db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut p = app_handle.path().app_config_dir().unwrap_or_default();
    p.push("teno.db");
    p
}

// F11: 憑證不再硬編碼。build 不依賴密件（option_env! 未設定照常編譯，None→""）；
// 發佈者可選注入 TENO_DRIVE_CLIENT_ID / TENO_DRIVE_CLIENT_SECRET；
// 終端使用者經 設定→Google Drive 輸入，落地 0600。
// （const 位置用 match 形：Option::unwrap_or 非 const fn，直接 .unwrap_or("") 觸 E0658。）
const DEFAULT_CLIENT_ID: &str = match option_env!("TENO_DRIVE_CLIENT_ID") {
    Some(s) => s,
    None => "",
};
const DEFAULT_CLIENT_SECRET: &str = match option_env!("TENO_DRIVE_CLIENT_SECRET") {
    Some(s) => s,
    None => "",
};

fn load_creds(app_handle: &tauri::AppHandle) -> DriveCreds {
    let p = creds_path(app_handle);
    std::fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| DriveCreds {
            client_id: DEFAULT_CLIENT_ID.into(),
            client_secret: DEFAULT_CLIENT_SECRET.into(),
        })
}

/// F11: 私有檔寫入——建立即 0600，既有舊檔（舊版 0644）經 fd 顯式收緊後才寫入，
/// 憑證/token 不再同機世界可讀。Windows 無 POSIX mode，依賴 NTFS ACL/使用者目錄。
#[cfg(unix)]
fn write_private(path: &std::path::Path, s: &str) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true).create(true).truncate(true).mode(0o600)
        .open(path)?;
    // .mode() 僅「建立」時生效；既有 0644 舊檔經 fd 顯式收緊（先 chmod 後寫，
    // 新內容不明文暴露；fd 版免 path TOCTOU）
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(s.as_bytes())?;
    f.flush()
}
#[cfg(not(unix))]
fn write_private(path: &std::path::Path, s: &str) -> std::io::Result<()> {
    std::fs::write(path, s)
}

fn save_creds(app_handle: &tauri::AppHandle, creds: &DriveCreds) {
    if let Ok(s) = serde_json::to_string(creds) {
        let _ = write_private(&creds_path(app_handle), &s);
    }
}

fn load_tokens(app_handle: &tauri::AppHandle) -> DriveTokens {
    let p = tokens_path(app_handle);
    std::fs::read_to_string(p).ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_tokens(app_handle: &tauri::AppHandle, tokens: &DriveTokens) {
    if let Ok(s) = serde_json::to_string(tokens) {
        let _ = write_private(&tokens_path(app_handle), &s);
    }
}

fn creds_valid(app_handle: &tauri::AppHandle) -> bool {
    let c = load_creds(app_handle);
    !c.client_id.is_empty() && !c.client_secret.is_empty()
}

fn urlencode_form(pairs: &[(&str, &str)]) -> String {
    pairs.iter()
        .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn urlencode(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        ' ' => '+'.to_string(),
        _ => format!("%{:02X}", c as u8),
    }).collect()
}

fn url_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '+' => result.push(' '),
            '%' => {
                let hi = chars.next().and_then(|c| c.to_digit(16)).unwrap_or(0);
                let lo = chars.next().and_then(|c| c.to_digit(16)).unwrap_or(0);
                result.push((hi as u8 * 16 + lo as u8) as char);
            }
            _ => result.push(c),
        }
    }
    result
}

// D9: OAuth 授權成功/失敗回頁（Content-Length 以 .len() 動態計算，避免手數誤差）
const SUCCESS_BODY: &[u8] = b"<html><body><h2>\xe6\x8e\x88\xe6\xac\x8a\xe6\x88\x90\xe5\x8a\x9f</h2><p>\xe5\x8f\xaf\xe4\xbb\xa5\xe9\x97\x9c\xe9\x96\x89\xe6\xad\xa4\xe9\xa0\x81\xe9\x9d\xa2\xef\xbc\x8c\xe5\x9b\x9e\xe5\x88\xb0 Teno</p></body></html>";
const ERROR_BODY: &[u8] = b"<html><body><h2>\xe6\x8e\x88\xe6\xac\x8a\xe5\xa4\xb1\xe6\x95\x97</h2><p>\xe5\x8f\xaf\xe4\xbb\xa5\xe9\x97\x9c\xe9\x96\x89\xe6\xad\xa4\xe9\xa0\x81</p></body></html>";
// D9: 授權等待逾時（v3 定案值 180 秒）
const OAUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// D9: 解析 OAuth redirect query → (code, error)。無 code/error 時兩者皆 None；參數順序不影響。
fn parse_oauth_query(q: &str) -> (Option<String>, Option<String>) {
    let mut code = None;
    let mut err = None;
    for kv in q.split('&') {
        let mut p = kv.splitn(2, '=');
        match p.next() {
            Some("code") => code = p.next().map(url_decode),
            Some("error") => err = p.next().map(url_decode),
            _ => {}
        }
    }
    (code, err)
}

/// D9: 等待 OAuth 授權結果 — listener thread 解析後送 channel，async 端純 await；
/// 逾時/中斷以 shutdown flag + dummy-connect 喚醒 accept 關閉 listener。
/// 取代舊版 async fn 內 std::thread::sleep busy-wait（卡 runtime worker、無逾時）。
async fn wait_auth_result(
    listener: std::net::TcpListener,
    port: u16,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<String, String>>(1);
    let shutdown = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shutdown_t = shutdown.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            // timeout/錯誤分支會 set shutdown → 本迴圈應退出（dummy-connect 喚醒 accept）
            if shutdown_t.load(std::sync::atomic::Ordering::Relaxed) { break; }
            let Ok(mut s) = stream else { continue };
            let mut r = std::io::BufReader::new(&s);
            let mut line = String::new();
            r.read_line(&mut line).ok();
            let uri = line.split_whitespace().nth(1).unwrap_or("");
            let (code, err) = parse_oauth_query(uri.split('?').nth(1).unwrap_or(""));
            if let Some(c) = code {
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", SUCCESS_BODY.len());
                let _ = s.write_all(SUCCESS_BODY);
                let _ = tx.blocking_send(Ok(c));
                break;
            }
            if let Some(e) = err {
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", ERROR_BODY.len());
                let _ = s.write_all(ERROR_BODY);
                let _ = tx.blocking_send(Err(format!("Google 授權失敗：{e}")));
                break;
            }
            // 無 code 無 error（例如 favicon 或首頁連線）→ 回 204 繼續等
            let _ = s.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
        }
    });
    match tokio::time::timeout(timeout, rx.recv()).await {
        Err(_) => {
            shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = std::net::TcpStream::connect(format!("127.0.0.1:{port}")); // dummy-connect 喚醒 accept
            Err("Google 授權逾時，請重新嘗試".into())
        }
        Ok(None) => {
            shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = std::net::TcpStream::connect(format!("127.0.0.1:{port}"));
            Err("授權程序意外中斷，請重新嘗試".into())
        }
        Ok(Some(r)) => r,
    }
}

fn json_from_resp(resp: ureq::Response) -> Result<serde_json::Value, String> {
    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader().read_to_end(&mut buf)
        .map_err(|e| format!("讀取回應失敗: {}", e))?;
    serde_json::from_slice(&buf).map_err(|e| format!("JSON 解析失敗: {}", e))
}

fn ensure_token(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let creds = load_creds(app_handle);
    if creds.client_id.is_empty() {
        return Err("尚未設定 Google Drive 憑證，請先在設定頁填入".into());
    }
    let mut tokens = load_tokens(app_handle);
    if tokens.access_token.is_empty() {
        return Err("尚未登入 Google Drive，請先同步一次進行登入".into());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if now < tokens.expires_at {
        return Ok(tokens.access_token);
    }
    if tokens.refresh_token.is_empty() {
        return Err("無法更新憑證，請重新登入".into());
    }
    let body = urlencode_form(&[
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("refresh_token", tokens.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ]);
    let resp = ureq::post(TOKEN_URI)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&body)
        .map_err(|e| format!("重新整理憑證失敗: {}", e))?;
    let v: serde_json::Value = json_from_resp(resp)?;

    let new_token = v["access_token"].as_str().ok_or("access_token 不存在")?.to_string();
    let expires_in = v["expires_in"].as_u64().unwrap_or(3600);
    tokens.access_token = new_token.clone();
    tokens.expires_at = now + expires_in - 60;
    save_tokens(app_handle, &tokens);
    Ok(new_token)
}

/// D10: 同名多檔取 modifiedTime（RFC3339 UTC，Google 恆返定格式）最大者——
/// 字典序＝時間序。平手保留首見（R1#1：與 orderBy desc「首顆最新」對齊，
/// max_by std 語意取末顆會與 API 排序意向相反，毫秒平手時 upload/download
/// 可能分岔）。全數缺 modifiedTime 時退回首顆有 id 者（防御性降級，
/// fields 被修剪/退化回傳時不致「看不見」既有檔而誤 create 第二顆）；
/// 條目缺 id 跳過；空陣列/非陣列 → None（語意同舊 first() 路徑）。
fn pick_latest_file(files: &serde_json::Value) -> Option<String> {
    let arr = files.as_array()?;
    let mut best: Option<(&str, &str)> = None;
    for f in arr.iter() {
        if let (Some(t), Some(id)) = (f["modifiedTime"].as_str(), f["id"].as_str()) {
            // 嚴格大於才替換 → 平手留首見
            if best.map_or(true, |(bt, _)| t > bt) {
                best = Some((t, id));
            }
        }
    }
    match best {
        Some((_, id)) => Some(id.to_string()),
        None => arr.iter().find_map(|f| f["id"].as_str().map(String::from)),
    }
}

fn find_db_file(token: &str) -> Result<Option<String>, String> {
    let q = format!("name='teno.db' and trashed=false");
    // D10: orderBy 最新在前（API 端收斂）＋取回 modifiedTime（客戶端獨立比較）
    // ——雙保險，任一端失效另一端仍對準最新檔。
    let url = format!(
        "https://www.googleapis.com/drive/v3/files?q={}&orderBy={}&fields=files(id,modifiedTime)",
        urlencode(&q),
        urlencode("modifiedTime desc"),
    );
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("查詢 Drive 檔案失敗: {}", e))?;
    let v: serde_json::Value = json_from_resp(resp)?;
    Ok(pick_latest_file(&v["files"]))
}

fn create_db_file(token: &str) -> Result<String, String> {
    let meta = serde_json::json!({"name": "teno.db", "mimeType": "application/x-sqlite3"});
    let body = serde_json::to_string(&meta).map_err(|e| format!("序列化失敗: {}", e))?;
    let resp = ureq::post("https://www.googleapis.com/drive/v3/files")
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&body)
        .map_err(|e| format!("建立 Drive 檔案失敗: {}", e))?;
    let v: serde_json::Value = json_from_resp(resp)?;
    v["id"].as_str().ok_or("缺少 file id".into()).map(String::from)
}

#[tauri::command]
pub async fn drive_save_creds(app_handle: tauri::AppHandle, client_id: String, client_secret: String) -> Result<String, String> {
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Client ID 和 Client Secret 不能為空".into());
    }
    save_creds(&app_handle, &DriveCreds { client_id, client_secret });
    Ok("✅ 憑證已儲存".into())
}

#[tauri::command]
pub async fn drive_oauth(app_handle: tauri::AppHandle) -> Result<String, String> {
    let creds = load_creds(&app_handle);
    if creds.client_id.is_empty() {
        return Err("請先在設定頁填入 Google Drive Client ID 和 Secret".into());
    }

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("無法開啟本地伺服器: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let actual_redirect = format!("http://localhost:{port}/");

    let auth_url = format!(
        "{}?client_id={}&redirect_uri={}&response_type=code&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent",
        AUTH_URI,
        urlencode(&creds.client_id),
        urlencode(&actual_redirect),
    );

    if let Err(e) = app_handle.opener().open_url(&auth_url, None::<&str>) {
        return Err(format!("開啟瀏覽器失敗: {e}\n請手動複製網址:\n{auth_url}"));
    }

    // D9: 由 wait_auth_result 統一處理 listener/code/error/timeout（取代舊版
    // Mutex 共用 + std::thread::sleep busy-wait：卡 runtime worker、無逾時、不認 error param）
    let auth_code = wait_auth_result(listener, port, OAUTH_TIMEOUT).await?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let body = urlencode_form(&[
        ("code", auth_code.as_str()),
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("redirect_uri", actual_redirect.as_str()),
        ("grant_type", "authorization_code"),
    ]);
    // D9: token exchange 為 blocking 網路呼叫（無 await 點，timeout 無法直接包），
    // 移入 spawn_blocking 避免卡 async worker；30s 逾時比照 fetch_llm 典範。
    let handle = tokio::task::spawn_blocking(move || {
        ureq::post(TOKEN_URI)
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&body)
            .map_err(|e| format!("取得憑證失敗: {e}"))
    });
    // 型別鏈：timeout(...).await → Result<Result<Result<Response,String>, JoinError>, Elapsed>
    // 第一個 ? 解 Elapsed（From<String>）；map_err 把 JoinError format 成 String；?? 雙解包 → Response
    let resp: ureq::Response = tokio::time::timeout(std::time::Duration::from_secs(30), handle).await
        .map_err(|_| "取得憑證逾時（30 秒），請檢查網路".to_string())?
        .map_err(|e| format!("取得憑證任務失敗: {e}"))??;
    let v: serde_json::Value = json_from_resp(resp)?;

    let tokens = DriveTokens {
        access_token: v["access_token"].as_str().ok_or("access_token 不存在")?.to_string(),
        refresh_token: v["refresh_token"].as_str()
            .ok_or("沒有 refresh_token，請撤銷授權後重試")?.to_string(),
        expires_at: now + v["expires_in"].as_u64().unwrap_or(3600) - 60,
    };
    save_tokens(&app_handle, &tokens);
    Ok("✅ Google Drive 登入成功".into())
}

#[tauri::command]
pub async fn drive_upload(app_handle: tauri::AppHandle) -> Result<String, String> {
    let token = ensure_token(&app_handle)?;
    let file_id = match find_db_file(&token)? {
        Some(id) => id,
        None => create_db_file(&token)?,
    };
    let data = std::fs::read(db_path(&app_handle))
        .map_err(|e| format!("讀取資料庫失敗: {}", e))?;

    let url = format!("https://www.googleapis.com/upload/drive/v3/files/{file_id}?uploadType=media");
    ureq::patch(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/x-sqlite3")
        .send_bytes(&data)
        .map_err(|e| format!("上傳失敗: {}", e))?;

    Ok("✅ 已成功同步至 Google Drive".into())
}

/// D11: 下載內容守門——TENOC 容器（手機備份手放 Drive 的防衛相容）與裸 SQLite
/// 雙態放行，其餘（空檔/垃圾/截斷/容器內段非 SQLite）一切拒絕；拒絕時零寫盤。
/// log 段忽略：本檔唯一正常來源 drive_upload 只傳裸 teno.db（無容器無 log），
/// TENOC 支援為防衛性相容，還原語意=僅還主資料庫（log 還原走 app 內
/// write_db_bytes→write_db_container 路徑）。容器 log 長度欄缺失時上游
/// unpack_db_container 靜默忽略（lib.rs:601）——此處 db 段已雙判，無害。
fn validate_drive_download(buf: &[u8]) -> Result<Vec<u8>, String> {
    let (db_bytes, _log) = crate::unpack_db_container(buf)?;
    // 容器分支不驗內段 magic（殘洞）→ 顯式補釘；>=100+magic 與 CLI import 同判別子（D19）
    if db_bytes.len() < 100 || !db_bytes.starts_with(b"SQLite format 3\0") {
        return Err("下載內容不是有效的 SQLite 資料庫，本機資料未變".into());
    }
    Ok(db_bytes)
}

#[tauri::command]
pub async fn drive_download(app_handle: tauri::AppHandle) -> Result<String, String> {
    let token = ensure_token(&app_handle)?;
    let file_id = find_db_file(&token)?
        .ok_or("遠端尚未有備份，請先上傳")?;

    let url = format!("https://www.googleapis.com/drive/v3/files/{file_id}?alt=media");
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("下載失敗: {}", e))?;

    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader().read_to_end(&mut buf)
        .map_err(|e| format!("讀取資料失敗: {}", e))?;

    // D11: 內容守門先於一切寫點——空檔/垃圾/截斷拒絕時 tmp 未寫、WAL/SHM 未拆、主檔未動
    let db_bytes = validate_drive_download(&buf)?;

    let db = db_path(&app_handle);
    let tmp = db.with_extension("db.sync_tmp");
    std::fs::write(&tmp, &db_bytes).map_err(|e| format!("寫入暫存失敗: {}", e))?;
    // 清殘留 WAL/SHM，避免下次開啟時 replay 舊資料（D2 同源）
    let _ = std::fs::remove_file(db.with_extension("db-wal"));
    let _ = std::fs::remove_file(db.with_extension("db-shm"));
    std::fs::rename(&tmp, &db).map_err(|e| format!("覆蓋資料庫失敗: {}", e))?;

    Ok("✅ 已成功從 Google Drive 同步".into())
}

#[tauri::command]
pub async fn drive_status(app_handle: tauri::AppHandle) -> Result<String, String> {
    if !creds_valid(&app_handle) {
        return Ok("未設定".into());
    }
    let tokens = load_tokens(&app_handle);
    if tokens.access_token.is_empty() {
        return Ok("未登入".into());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if now < tokens.expires_at {
        Ok("已登入".into())
    } else if !tokens.refresh_token.is_empty() {
        Ok("憑證可更新".into())
    } else {
        Ok("憑證已過期".into())
    }
}

#[tauri::command]
pub async fn drive_logout(app_handle: tauri::AppHandle) -> Result<String, String> {
    let tp = tokens_path(&app_handle);
    if tp.exists() { let _ = std::fs::remove_file(tp); }
    Ok("已登出".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_oauth_query_forms() {
        assert_eq!(parse_oauth_query("code=abc123"), (Some("abc123".into()), None));
        assert_eq!(
            parse_oauth_query("error=access_denied&error_description=user%20denied"),
            (None, Some("access_denied".into()))
        );
        assert_eq!(parse_oauth_query("foo=bar"), (None, None));
        assert_eq!(parse_oauth_query(""), (None, None));
        assert_eq!(
            parse_oauth_query("state=xyz&code=abc123&scope=test"),
            (Some("abc123".into()), None)
        );
        assert_eq!(
            parse_oauth_query("code=a%2Bb+c"),
            (Some("a+b c".into()), None) // %2B→'+'、'+'→' '
        );
    }

    #[test]
    fn wait_auth_success_path() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let mut s = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
                let _ = s.write_all(b"GET /?code=abc123 HTTP/1.1\r\nHost: localhost\r\n\r\n");
            });
            let r = wait_auth_result(listener, port, std::time::Duration::from_secs(5)).await;
            assert_eq!(r.unwrap(), "abc123");
        });
    }

    #[test]
    fn wait_auth_error_path() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let mut s = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
                let _ = s.write_all(b"GET /?error=access_denied HTTP/1.1\r\nHost: localhost\r\n\r\n");
            });
            let r = wait_auth_result(listener, port, std::time::Duration::from_secs(5)).await;
            assert!(r.unwrap_err().contains("授權失敗"));
        });
    }

    #[test]
    fn wait_auth_timeout_branch() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            // 50ms 短逾時：真實觸發 shutdown flag + dummy-connect 喚醒 accept 路徑
            let r = wait_auth_result(listener, port, std::time::Duration::from_millis(50)).await;
            assert!(r.unwrap_err().contains("逾時"));
        });
    }

    /// F11: 把「憑證不入源碼」釘成 CI 級永久擋。
    /// needle 拆串构造——本檔任何處不得出現完整 token（include_str! 自掃與
    /// tools/verify-f11.mjs T1 掃描器共用同一判別，字面寫出即雙必紅，E14 同課）。
    #[test]
    fn f11_no_hardcoded_oauth_secret() {
        let src = include_str!("./drive_sync.rs");
        let secret_prefix = format!("{}{}", "GOCSPX", "-");
        let id_prefix = format!("{}-", "880245257428");
        assert!(!src.contains(&secret_prefix), "源碼中發現硬編碼 Google client secret 前綴");
        assert!(!src.contains(&id_prefix), "源碼中發現舊硬編碼 client_id 字面值");
    }

    /// F11: write_private 行為——覆寫既有 0644 舊檔須收緊 0600；全新建立亦 0600。
    #[test]
    #[cfg(unix)]
    fn f11_write_private_0600() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("teno-f11-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("tokens.json");
        std::fs::write(&old, "x").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&old, "secret").unwrap();
        assert_eq!(std::fs::metadata(&old).unwrap().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "secret");
        let fresh = dir.join("creds.json");
        write_private(&fresh, "s2").unwrap();
        assert_eq!(std::fs::metadata(&fresh).unwrap().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// D11: 下載內容守門七形態——空/垃圾必拒、裸 SQLite 恆等、TENOC 解包、
    /// 截斷/內段垃圾/短小 SQLite 頭必拒（容器殘洞封釘）。
    #[test]
    fn d11_validates_drive_download_forms() {
        assert!(validate_drive_download(&[]).is_err(), "empty must reject");
        let garbage = b"this is not a database".to_vec();
        assert!(validate_drive_download(&garbage).is_err(), "garbage must reject");
        let mut sqlite: Vec<u8> = b"SQLite format 3\0".to_vec();
        sqlite.resize(516, 7);
        assert_eq!(validate_drive_download(&sqlite).unwrap(), sqlite, "bare identity");
        let mut tenoc: Vec<u8> = b"TENOC".to_vec();
        tenoc.push(1u8);
        tenoc.extend_from_slice(&(sqlite.len() as u32).to_le_bytes());
        tenoc.extend_from_slice(&sqlite);
        tenoc.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(validate_drive_download(&tenoc).unwrap(), sqlite, "tenoc unwrapped");
        let mut trunc: Vec<u8> = b"TENOC".to_vec();
        trunc.push(1u8);
        trunc.extend_from_slice(&999999u32.to_le_bytes());
        trunc.extend_from_slice(b"short");
        assert!(validate_drive_download(&trunc).is_err(), "truncated must reject");
        let mut badinner: Vec<u8> = b"TENOC".to_vec();
        badinner.push(1u8);
        badinner.extend_from_slice(&(garbage.len() as u32).to_le_bytes());
        badinner.extend_from_slice(&garbage);
        badinner.extend_from_slice(&0u32.to_le_bytes());
        assert!(validate_drive_download(&badinner).is_err(), "tenoc-garbage-inner must reject");
        let mut tiny: Vec<u8> = b"SQLite format 3\0".to_vec();
        tiny.resize(99, 9);
        assert!(validate_drive_download(&tiny).is_err(), "99B must reject");
    }

    /// D10: pick_latest_file 形態——新者勝（正/反序）、mtime 全缺退回首顆、
    /// 空/非陣列 None、單檔、跨年月 RFC3339 邊界、缺 id 跳過、mixed mtime。
    #[test]
    fn d10_pick_latest_file_forms() {
        // 舊→新排列（舊 first() 必錯=bug 徵狀）
        let l1 = serde_json::json!([
            {"id":"OLD","modifiedTime":"2026-01-01T00:00:00.000Z"},
            {"id":"MID","modifiedTime":"2026-03-05T08:00:00.000Z"},
            {"id":"NEW","modifiedTime":"2026-06-15T12:30:00.500Z"}]);
        assert_eq!(pick_latest_file(&l1).as_deref(), Some("NEW"), "old-to-new 新者勝");
        // 反序仍新者勝
        let l2 = serde_json::json!([
            {"id":"NEW","modifiedTime":"2026-06-15T12:30:00.500Z"},
            {"id":"OLD","modifiedTime":"2026-01-01T00:00:00.000Z"}]);
        assert_eq!(pick_latest_file(&l2).as_deref(), Some("NEW"), "反序仍新者勝");
        // mtime 全缺 → 退回首顆有 id（不退化於現況）
        let l3 = serde_json::json!([{"id":"A"},{"id":"B"}]);
        assert_eq!(pick_latest_file(&l3).as_deref(), Some("A"), "全缺 mtime 退回首顆");
        // 空陣列/非陣列 → None
        assert_eq!(pick_latest_file(&serde_json::json!([])), None, "空陣列 None");
        assert_eq!(pick_latest_file(&serde_json::json!({"id":"X"})), None, "非陣列 None");
        // 單檔
        let l5 = serde_json::json!([{"id":"SOLO","modifiedTime":"2026-02-02T02:02:02.000Z"}]);
        assert_eq!(pick_latest_file(&l5).as_deref(), Some("SOLO"), "單檔");
        // 跨年月邊界（真實 RFC3339 定格式）
        let l6 = serde_json::json!([
            {"id":"DECEMBER","modifiedTime":"2025-12-31T23:59:59.999Z"},
            {"id":"JANUARY","modifiedTime":"2026-01-01T00:00:00.000Z"}]);
        assert_eq!(pick_latest_file(&l6).as_deref(), Some("JANUARY"), "跨年月字典序=時間序");
        // 最新條目缺 id → 跳過取次新
        let l7 = serde_json::json!([
            {"modifiedTime":"2026-09-09T00:00:00.000Z"},
            {"id":"Z","modifiedTime":"2026-01-01T00:00:00.000Z"}]);
        assert_eq!(pick_latest_file(&l7).as_deref(), Some("Z"), "缺 id 跳過");
        // mixed：只在有 mtime 者中取最新
        let l8 = serde_json::json!([
            {"id":"NOMTIME"},
            {"id":"OLD2","modifiedTime":"2024-01-01T00:00:00.000Z"},
            {"id":"NEW2","modifiedTime":"2027-01-01T00:00:00.000Z"}]);
        assert_eq!(pick_latest_file(&l8).as_deref(), Some("NEW2"), "mixed mtime");
        // 平手 modifiedTime → 保留首見（R1#1：與 orderBy desc 首顆最新對齊）
        let l9 = serde_json::json!([
            {"id":"TIE_FIRST","modifiedTime":"2026-05-05T05:05:05.555Z"},
            {"id":"TIE_LAST","modifiedTime":"2026-05-05T05:05:05.555Z"}]);
        assert_eq!(pick_latest_file(&l9).as_deref(), Some("TIE_FIRST"), "平手留首見");
    }
}
