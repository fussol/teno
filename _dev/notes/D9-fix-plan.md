# D9 修復計畫書 — OAuth timeout／busy-wait 卡 runtime worker（v1.2）

> 定案來源：`_dev/notes/fix-plan-critical-v3.md` 批次 7 · D9（裁決：⚠️→✅ 理由修正）
> 持有者：首相 B（src-tauri/src/drive_sync.rs、src-tauri/Cargo.toml）
> 建立日期：2026-08-15 ｜ v1.1：第 1 輪 3 委員 ⚠️ 條件通過 → 全數採納 ｜ v1.2：第 2 輪 #1/#2 ✅、#3 ⚠️（C1 型別錯誤必改＋C2 計數矛盾）→ 採納升版

---

## 1. Bug 定義

**標題**：Google Drive OAuth 授權流程無逾時保護＋async fn 內 blocking busy-wait 卡死 runtime worker；listener 不處理 `error` query param（使用者拒絕授權時永久卡死）。

**可觀察症狀**：
1. 使用者開啟 Drive 授權頁後**不動作（或拒絕授權）**，`drive_oauth` 永不返回 — UI 永遠卡在登入中。
2. 授權等待期間，`std::thread::sleep(100ms)` busy-wait 在 **async fn 內執行**，佔住 Tauri async runtime 的 worker thread，其他 async 任務（DB 查詢、其他 tauri command）被延遲 — 影響整體 UI 回應。

**嚴重度**：🔴 高（功能卡死＋全局效能劣化）

---

## 2. Root Cause

### 2.1 busy-wait 卡 runtime worker（主因）

`src-tauri/src/drive_sync.rs:235-238`：

```rust
let auth_code = loop {
    if let Some(c) = code.lock().unwrap().take() { break c; }
    std::thread::sleep(std::time::Duration::from_millis(100));
};
```

`drive_oauth` 是 `#[tauri::command] pub async fn`，執行於 Tokio runtime 之上。在 async fn 內直接 `std::thread::sleep` 是 **blocking 呼叫** — 該 worker thread 在 sleep 期間無法處理其他 task。雖然每次只睡 100ms，但這個迴圈本質是忙等，佔住 worker 直到使用者完成授權；若使用者永不動作，該 worker 被**永久佔用**。

### 2.2 無逾時保護（次因）

`std::thread::sleep` 迴圈沒有任何時間上限。使用者開啟瀏覽器後關閉／遺忘，授權等待**永不結束**。Tauri command 不返回 → JS `invoke('drive_oauth')`（src/lib/api.js:121）的 promise 永不 settle。

### 2.3 listener 不處理 error query param（次因）

`drive_sync.rs:221-225` 只解析 `code`：

```rust
if let Some(c) = uri.split('?').nth(1)
    .and_then(|q| q.split('&').find_map(|kv| {
        let mut p = kv.splitn(2, '=');
        if p.next()? == "code" { p.next().map(url_decode) } else { None }
    }))
```

Google OAuth 授權失敗（使用者按「拒絕」）時，redirect 是 `http://localhost:{port}/?error=access_denied&error_description=...` — 沒有 `code`。現行 code 對這種請求**不回應任何 HTTP response、不 set code** → listener thread 繼續等下一條連線，主迴圈繼續 busy-wait → **永久卡死**。（審查委員 #3 逐行實錘：221-225 if let 不匹配 → 231 不 break，描述吻合。）

### 2.4 為什麼 compile 不會失敗（v3 理由修正實錘）

v3 前稿曾稱「tokio time feature 未啟用 → compile 失敗」，經 #1/#4 委員實錘修正：
- `src-tauri/src/lib.rs:313`（fetch_llm）**已出貨** `tokio::time::timeout(...)`，且現況 `cargo check --locked` 通過 → tokio `time` feature 已由依賴鏈（tauri-plugin-sql → sqlx 等）間接啟用。
- 附註：Cargo.lock tokio 版本 1.52.3；lock 檔中 mio/socket2 為 tokio io/net 依賴，**不作為 time feature 證據**（真正證據是 lib.rs:313 已編譯出貨）。
- 因此 **compile 沒有問題，問題純粹是運行時行為**。

---

## 3. 修法（檔名：行號）

### 3.1 `src-tauri/Cargo.toml:30` — 顯式宣告 tokio time feature

```toml
# 修改前
tokio = { version = "1", features = ["rt", "sync"] }
# 修改後
tokio = { version = "1", features = ["rt", "sync", "time"] }
```

理由：v3 定案要求顯式宣告（不依賴傳遞依賴的隱含啟用），並使 `tokio::time::timeout` 成為本 crate 的直接依賴保證。`sync` 涵蓋 mpsc、`rt` 涵蓋 spawn_blocking（token exchange 用，見 3.2 末段）。Cargo.lock 不需手動改（feature unification 自動合併；`--locked` 下不變）。

### 3.2 `src-tauri/src/drive_sync.rs:212-251` — mpsc + timeout + error 解析（含抽函數）

**新增 module 級常數與純函數**（置於 `url_decode` 之後，檔案內既有 `use std::io::{BufRead, Write}` 已涵蓋）：

```rust
const SUCCESS_BODY: &[u8] = b"<html><body><h2>\xe6\x8e\x88\xe6\xac\x8a\xe6\x88\x90\xe5\x8a\x9f</h2><p>\xe5\x8f\xaf\xe4\xbb\xa5\xe9\x97\x9c\xe9\x96\x89\xe6\xad\xa4\xe9\xa0\x81\xe9\x9d\xa2\xef\xbc\x8c\xe5\x9b\x9e\xe5\x88\xb0 Teno</p></body></html>";
const ERROR_BODY: &[u8] = b"<html><body><h2>\xe6\x8e\x88\xe6\xac\x8a\xe5\xa4\xb1\xe6\x95\x97</h2><p>\xe5\x8f\xaf\xe4\xbb\xa5\xe9\x97\x9c\xe9\x96\x89\xe6\xad\xa4\xe9\xa0\x81</p></body></html>";
const OAUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// 解析 OAuth redirect query → (code, error)。無 code/error 時兩者皆 None；參數順序不影響。
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

/// 等待 OAuth 授權結果（listener thread 解析後送 channel；逾時/中斷關 listener）。
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
```

**`drive_oauth` 內改寫**（取代原 212-238 的 code 共用 + Mutex + busy-wait）：

```rust
let auth_code = wait_auth_result(listener, port, OAUTH_TIMEOUT).await?;
```

**token exchange 補強**（原 240-251 的 blocking ureq — 審查委員 #3 發現的風險遺漏）：async fn 內直接 `ureq::post(...).send_string()` 是 blocking 網路呼叫且無逾時，與 2.1 root cause 同類。依 lib.rs:289-315 fetch_llm 既有典範，以 `spawn_blocking` + `timeout` 包覆（⚠️ 不可用 `tokio::time::timeout` 直接包 blocking call — 無 await 點 timeout 無效）：

```rust
let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
let body = urlencode_form(&[
    ("code", auth_code.as_str()),
    ("client_id", creds.client_id.as_str()),
    ("client_secret", creds.client_secret.as_str()),
    ("redirect_uri", actual_redirect.as_str()),
    ("grant_type", "authorization_code"),
]);
let handle = tokio::task::spawn_blocking(move || {
    ureq::post(TOKEN_URI)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&body)
        .map_err(|e| format!("取得憑證失敗: {e}"))
});
// 型別鏈：timeout(...).await → Result<Result<Result<Response,String>, JoinError>, Elapsed>
// 第一個 ? 解 Elapsed（From<String>）；map_err 把 JoinError format 成 String；?? 雙解包 → Response
// （第 2 輪審查 #3 修正：初稿 .map_err(|e| e)? 遇 JoinError 缺 From 實作 → E0277，且少一層解包 → E0308）
let resp: ureq::Response = tokio::time::timeout(std::time::Duration::from_secs(30), handle).await
    .map_err(|_| "取得憑證逾時（30 秒），請檢查網路".to_string())?
    .map_err(|e| format!("取得憑證任務失敗: {e}"))??;
let v: serde_json::Value = json_from_resp(resp)?;
```

**單元測試模組**（同檔尾，`#[cfg(test)]`，手動建 current_thread runtime，不需 dev-dependencies／macros）：

```rust
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
}
```

設計要點（含審查委員採納項目）：
1. **async 端不再有任何 blocking 呼叫** — `rx.recv().await` 純 async 等待。✅ 解決 2.1
2. **180 秒逾時**（v3 定案值）→ `tokio::time::timeout` 回 `Err(_)` → 關 listener＋回錯誤。✅ 解決 2.2
3. **error query param 解析**（與 code 同層級，抽成 `parse_oauth_query` 純函數）→ 拒絕授權快速回錯誤頁＋`Err`。✅ 解決 2.3
4. **listener 關閉**：shutdown flag ＋ `TcpStream::connect` dummy-connect 喚醒 `incoming()` 阻塞（v3 明訂）。thread 見 flag 即 break。無洩漏。
5. **mpsc channel 容量 1**：單 sender 單次 send，`blocking_send` 永不阻塞；rx drop 後 send 失敗被 `let _ =` 吞掉（tokio 1.52.3 原始碼實錘：`blocking_send` 官方 doc 範例即 std::thread 內使用）。
6. **Content-Length 動態計算**（`SUCCESS_BODY.len()`／`ERROR_BODY.len()`）：避免手數 byte 錯誤（第 1 輪審查抓到：成功頁實 89B 舊 code 寫 88、錯誤頁實 72B 初稿寫 77）。
7. **`port` 使用修正**：thread closure 捕獲 `port` 的拷貝（u16: Copy），async 端分支直接用 `port`（第 1 輪審查抓到初稿 `port_t` use-after-move E0382）。
8. **token exchange 移入 `spawn_blocking` + 30s timeout**（委員 #3 風險遺漏採納；第 2 輪 #3 修正型別：`format!` 處理 JoinError ＋ `??` 雙解包 → `ureq::Response`）。
9. **測試 runtime 用 `enable_time()`**（第 2 輪 #3 建議採納）：只依賴已顯式宣告的 `rt+time`，不依賴 net/io 隱含 feature。

### 3.3 不修改的檔案（明確排除）

| 檔案 | 原因 |
|---|---|
| `src-tauri/src/lib.rs` | 首相 C 持有；lib.rs:313/360 既有 `tokio::time::timeout` 已出貨，本 bug 不動 |
| `src/lib/store.js` | 首相 A 持有；無關 |
| `src/lib/chart.js`、`src/styles/base.css` | 其他首相舊改動；無關 |
| `src/lib/api.js` | invoke 簽名不變（`drive_oauth()` 無參數、回 `Result<String,String>` 語意不變），無需修改 |
| `src/pages/settings.js` | 消費端相容（見 §4 形態一），不需修改 |

---

## 4. 使用點窮舉（grep 三形態）

### 形態一：字面 `drive_oauth`／`driveOAuth`（雙形態 grep）

`grep -rn 'drive_oauth\|driveOAuth' src/ tools/ --include='*.js' --include='*.mjs' --include='*.html'`

| 位置 | 型態 | 處理 |
|---|---|---|
| `src-tauri/src/drive_sync.rs:190` | 函數定義（本次修改主體） | 改 |
| `src-tauri/src/lib.rs:1652` | invoke_handler 註冊（`drive_sync::drive_oauth`） | 不動（首相 C 持有；註冊名不變） |
| `src/lib/api.js:121` | `invoke('drive_oauth')`（封裝為 `driveOAuth`） | 不動（簽名/回傳語意不變） |
| `src/lib/api.js:118` | `invoke('drive_save_creds')` | 不動（無關） |
| `src/pages/settings.js:12` | `import { ..., driveOAuth, ... } from '../lib/api.js'`（camelCase） | 不動 |
| `src/pages/settings.js:901` | **唯一消費點**：`const oauthResult = await driveOAuth(); toast(oauthResult, 'toast-success');` — Ok→成功 toast；Err 走 catch → `toast(String(e), 'toast-error')` | 不動（Err 字串相容：逾時/授權失敗/意外中斷全部經 catch 顯示為 error toast，與既有 Err 同軌） |

附註：
- `dist/assets/*.js` 為 build 產物（含打包後同一 invoke 字串）— src 不改則不需動。
- `tools/cli.mjs`、`_dev/cli/cli.mjs` 含「OAuth」字串但僅為**錯誤訊息文字、`oauth2.googleapis.com` URL 與 `drive_creds.json`/`drive_tokens.json` 檔名**（CLI 自打 Google token API），**不 invoke drive_oauth** — 不受影響（第 2 輪 #2 措辭精確化採納）。
- 全 repo 原始碼無 .ts/.tsx/.vue/.svelte/inline script 引用；`src-tauri/capabilities/default.json` 自訂 command 不需白名單 — 無其他路徑。
- 範圍外備註（第 2 輪 #2 觀察）：`ensure_token`（drive_sync.rs:119，sync fn）內 :141 blocking token refresh，被 `drive_upload`/`drive_download` 呼叫時仍在 async 路徑 blocking — 屬既有出貨、D9 scope 外，不納入本次動工（backlog 觀察）。

### 形態二：正則 `std::thread::sleep|tokio::time::timeout|\.incoming\(\)|spawn_blocking`

| 位置 | 型態 | 處理 |
|---|---|---|
| `src-tauri/src/drive_sync.rs:237` | `std::thread::sleep(100ms)` busy-wait | **刪除**（改 async recv） |
| `src-tauri/src/drive_sync.rs:215` | `listener.incoming()`（thread 內 blocking 迴圈） | 改（加 shutdown flag 檢查） |
| `src-tauri/src/drive_sync.rs:248` | `ureq::post` blocking 呼叫（async fn 內） | 改（spawn_blocking + 30s timeout） |
| `src-tauri/src/lib.rs:313` | `tokio::time::timeout(90s)` fetch_llm | 不動（既有出貨，佐證 time feature 可用；spawn_blocking 典範 289-315） |
| `src-tauri/src/lib.rs:360` | `tokio::time::timeout(15s)` **lookup_cambridge**（334 行定義；非 fetch_get — 第 1 輪審查更正） | 不動 |
| `src-tauri/src/lib.rs:319` | fetch_get（同步 fn，無 timeout） | 不動 |
| `src-tauri/src/lib.rs:143/289/342/382` | `spawn_blocking` 既有用法 | 不動（參考典範） |

### 形態三：`*.rs` 內 OAuth redirect query 解析（code/error）

| 位置 | 型態 | 處理 |
|---|---|---|
| `src-tauri/src/drive_sync.rs:221-225` | 只解析 `code` 的 find_map | 改（抽 `parse_oauth_query` 雙解析） |
| `src-tauri/src/drive_sync.rs:235-238` | busy-wait loop | 刪除（改 timeout+recv） |

**結論**：D9 影響面完全收斂於 `drive_sync.rs:190-262` 區塊與 `Cargo.toml:30`，無其他使用點；JS 端零修改且消費語意相容。

---

## 5. 驗證項目（憲法第 4 條 ✅ 附實測）

1. **`cargo check`（src-tauri，`--locked`）**：tokio features 宣告正確、新 code 可編譯（重點：`write!`/`SUCCESS_BODY.len()`、mpsc/AtomicBool/TcpStream 型別、`blocking_send` 於 std thread 使用、spawn_blocking closure 捕獲）。
2. **`cargo test`（drive_sync 單元測試，4 測試函數）**：
   - `parse_oauth_query_forms`：code／error／無參數／混合順序／url_decode 五情境（6 斷言）。
   - `wait_auth_success_path`：真實 TCP 連線送 `?code=abc123` → 取回 code（5s 逾時視窗）。
   - `wait_auth_error_path`：送 `?error=access_denied` → `Err` 含「授權失敗」。
   - `wait_auth_timeout_branch`：50ms 短逾時 → 真實觸發 shutdown flag＋dummy-connect 喚醒 accept 路徑 → `Err` 含「逾時」。
3. **行為驗證**：上述 3/4 直接覆蓋 timeout 分支與錯誤分支的真實行為（非僅編譯）。
4. **JS 側回歸**：`node --check src/lib/api.js`（不改，確認無語法問題）。
5. **回歸**：`cargo check` 全 crate 通過即證明 lib.rs:313/360 既有 timeout 用法不受影響（同 crate 同 feature 集）。

---

## 6. 風險評估

| 風險 | 等級 | 緩解 |
|---|---|---|
| tokio mpsc `blocking_send` 在 std thread 使用 | 低 | channel 容量 1、無背壓路徑；rx drop 後 send 回 Err 被忽略（`let _ =`）；tokio 原始碼實錘合法 |
| dummy-connect 喚醒時機競態（timeout 與使用者授權同時發生） | 低 | 180s 視窗極寬；即便競態，兩路皆返回（授權成功或逾時錯誤其一），無懸空 |
| listener thread 洩漏 | 低 | shutdown flag ＋ dummy-connect 雙保險；thread 見 flag 即 break；即便未即時退出，process 層級隨 app 結束回收，且不再佔 async worker |
| `Content-Length` 與實際 body 不符 | 低 | 改為 `body.len()` 動態計算，消除手數誤差（第 1 輪審查抓到的 88/77 錯誤已根治） |
| token exchange blocking ureq 無逾時 | 低（已修） | `spawn_blocking` + `timeout(30s)` 包覆（委員 #3 發現之遺漏，3.2 已採納）；⚠️ 不可用 timeout 直接包 blocking call |
| 逾時 180s 對慢速使用者太短 | 中低 | v3 定案值 180s；比照 fetch_llm 90s 更寬，且可從 JS 端重試 |
| `write!` 失敗（連線中斷） | 低 | `let _ =` 忽略；瀏覽器端顯示瑕疵不影響 OAuth 流程 |

---

## 7. 審查歷程

| 輪次 | 日期 | 委員 | 裁決 | 發現／採納 |
|---|---|---|---|---|
| 1 | 2026-08-15 | #1（Rust/編譯） | ⚠️ 條件通過 | ①`port_t` use-after-move → E0382 必改（async 端改用 `port`）；②Content-Length 手數錯（錯誤頁實 72B 非 77、成功頁實 89B 舊 code 寫 88）→ 改動態 `body.len()`；③解析邏輯內嵌無法測 → 抽 `parse_oauth_query`；④timeout 硬編碼無法測 → 抽 `wait_auth_result` 參數化；✅ blocking_send 合法、dummy-connect 機制正確、features 宣告正確。全數採納（3.2/5 節） |
| 1 | 2026-08-15 | #2（JS/使用點） | ⚠️ 條件通過 | ①「JS 僅 api.js 兩點」不實 — 漏 camelCase `driveOAuth`：settings.js:12（import）與 :901（唯一消費點，Ok→success toast、Err→catch→error toast，相容）→ §4 形態一補列；②grep 改雙形態 `drive_oauth\|driveOAuth`；③dist 產物/cli.mjs 註記。全數採納（§4） |
| 1 | 2026-08-15 | #3（流程/語意） | ⚠️ 條件通過 | ①Content-Length 不實宣稱（同 #1）→ 動態計算；②風險遺漏：token exchange blocking ureq 無逾時 → spawn_blocking+timeout(30s)（註：不可 timeout 包 blocking call）；③lib.rs:360 實為 lookup_cambridge 非 fetch_get → §2.4/§4 更正；④mio/socket2 不作為 time feature 證據 → 改附註；✅ 與 v3 定案三要點全數一致、OAuth 協議層正確。全數採納 |
| 2 | 2026-08-15 | #1（Rust/編譯） | ✅ 通過 | 第 1 輪 4 點全數正確採納；實錘 write! prelude 巨集＋既有 Write trait、ureq::Response: Send、cargo tree 顯示 rt/rt-multi-thread/sync/time/net/io-util/macros 全啟用、SUCCESS_BODY 89B/ERROR_BODY 72B 實錘、測試三函數可跑性無風險；minor：①`.map_err(|e| e)?` 可簡化（被 #3 的 C1 修法涵蓋）②測試函數名與內容不符 → 更名 `parse_oauth_query_forms`（採納） |
| 2 | 2026-08-15 | #2（JS/使用點） | ✅ 通過 | 重跑雙形態 grep 實錘僅 5 檔 10 點、表格 6 行零遺漏；settings.js:12/:901 消費語意實錘（Ok→success toast、Err→catch→error toast）；dist/cli.mjs 註記屬實；「JS 端零修改」成立；minor：①cli.mjs 附註措辭精確化（採納）②ensure_token :141 blocking refresh 為範圍外同類風險（backlog 備註，採納） |
| 2 | 2026-08-15 | #3（流程/語意） | ⚠️ 條件通過 | **C1（必改・編譯錯誤）**：token exchange 片段 `.map_err(|e| e)?` 遇 JoinError 缺 `From<JoinError> for String` → E0277，且 `json_from_resp` 需 `ureq::Response` 但片段解出 `Result<Response,String>` → E0308 → 修法 `format!`＋`??` 雙解包（v1.2 採納）；**C2（必改）**：§5 寫「3 測試函數」但 §3.2 實為 4 個 → 更正（v1.2 採納）；C3（建議）：測試 `enable_all()` → `enable_time()`（v1.2 採納）；其餘採納項目實錘無誤 |
| 3 | 2026-08-15 | #1（Rust/編譯） | ✅ 通過 | 在 /tmp/teno-d9-verify 獨立 cargo 專案（tokio=1.52.3、ureq=2.12.1 與 Cargo.lock 同版本）逐字複製 v1.2 code：`cargo check --offline` 通過＋`cargo test --offline` 4/4 全綠；實錘 `timeout` 內部 await JoinHandle（型別鏈 `Result<Result<Result<Response,String>,JoinError>,Elapsed>`）、`ureq::Response: Send`、enable_time() 足夠；自我更正第 2 輪「.map_err(|e| e)? 可簡化」表述有誤（#3 修法正確）；現況 cargo check --locked exit 0 |
| 3 | 2026-08-15 | #2（JS/使用點） | ✅ 通過 | §4 附註精確化兩項逐字實錘（cli.mjs :3043-3081 檔名/URL/錯誤訊息、ensure_token :119 sync fn/:141 blocking refresh、呼叫者僅 drive_upload :266/drive_download :286 兩處）；第 2 輪確認內容零破壞 |
| 3 | 2026-08-15 | #3（流程/語意） | ❌→✅（複核改判） | 第 3 輪誤判：主張 token exchange 型別鏈「缺 .await → E0599」。仲裁：`tokio::time::timeout` 內部 poll 內層 future（`Timeout<T>::Output = Result<T::Output, Elapsed>`，tokio 原始碼逐字實錘），`timeout(30s, handle).await` 已含 JoinHandle await → v1.2 型別鏈正確、無需（也不該）加 .await（加了對 Result 呼叫 .await → E0277）。複核委員親跑 `/tmp/d9-arbitration` 編譯 exit 0＋測試 4/4 後**撤回誤判改判 ✅**（唯一勘誤：Cargo.lock tokio 實為 1.53.1 非 1.52.3，API 語義一致不影響結論）。v1.2 定稿 |

---

## 8. 執行狀態

- [x] 計畫書完成（v1.2 定稿，3 輪審查全數通過：第 1 輪 3 委員 ⚠️、第 2 輪 #1/#2 ✅ + #3 ⚠️、第 3 輪 #1/#2 ✅ + #3 複核改判 ✅）
- [x] 審查通過（3 委員 3/3 ✅）
- [x] 動工（Cargo.toml + drive_sync.rs）
- [x] 實測驗證（cargo check --locked 通過；cargo test drive_sync 4/4 全綠；node --check api.js/settings.js SYNTAX_OK；sim_tests 3 失敗為既有環境依賴，stash 對照實錘非本次引入）
- [x] 一 bug 一 commit（c1d068e，message 標 D9；commit 僅含 Cargo.toml + drive_sync.rs + 本計畫書，未帶入他人進行中改動）
