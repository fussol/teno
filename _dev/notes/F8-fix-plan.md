# F8 修復計畫書 — fetch_get/fetch_llm 換 ureq＋HTTP 白名單（v1.3）

> 定案來源：`_dev/notes/fix-plan-critical-v3.md` 批次 7 · F8（裁決：⚠️→✅，+ureq）
> 持有者：首相 B（src-tauri/src/lib.rs fetch_llm/fetch 區段、src-tauri/Cargo.toml）
> 建立日期：2026-08-15 ｜ v1.0：初稿（送審） ｜ v1.1：第 1 輪 3 委員 ⚠️ 條件通過 → 全數採納（C1-1 IPv6 白名單改型別化比對；C1-2 404 語意如實記載；C2 全批修正） ｜ v1.2：第 2 輪 #1 ⚠️ 條件通過（C2-1 ureq 預設 read timeout 記載不實 → 實錘為 None 非 30s，修正後成立）＋#2/#3 ✅（等效 3/3） ｜ v1.3：第 3 輪 #1/#2 ✅、#3 ⚠️（§7 斷言數字補註未落地）→ 落地＋C3 全批採納（等效 3/3 ✅ 定案）

---

## 1. Bug 定義

**標題**：`fetch_get` 強制 https-only 使本機 Ollama（`http://localhost:11434/api/tags`）無法使用；且 `fetch_get`／`fetch_llm` 依賴外部 `curl` binary，**Android 環境無 curl**（僅 desktop 有），Android 版功能損壞。`fetch_get` 之 `https://` 前置字串檢查過於粗糙（無 hostname 概念，無法精確放行本機 http）。

**可觀察症狀**：
1. 使用者在工具頁填入本機 Ollama 網址 `http://localhost:11434`（預設值，見 `tools.js:300`）→ `fetchGet('http://localhost:11434/api/tags')` 被 `lib.rs:321` 拒絕 → 「僅允許 HTTPS 連線」錯誤 → 無法列出 Ollama 模型、無法使用 LLM 詞性/IPA/例句功能。
2. 在 Android 裝置上，所有經 `fetch_llm`／`fetch_get` 的功能（LLM 補全、Ollama 連線）皆失敗 — `std::process::Command::new("curl")` 找不到 curl binary（Android 系統無此執行檔）。

**嚴重度**：🔴 高（功能損壞＋跨平台不一致）

---

## 2. Root Cause

### 2.1 fetch_get 白名單缺失（本機 Ollama 被擋）

`src-tauri/src/lib.rs:321`：

```rust
if !url.starts_with("https://") { return Err("僅允許 HTTPS 連線".to_string()); }
```

前置字串檢查把 **`http://localhost:11434` 一併擋掉**。但 Ollama 的合法部署即為本機 http 服務（`ollama serve` 預設 `127.0.0.1:11434`，無 TLS）。v3 定案：以 URL hostname 白名單取代 — `localhost`/`127.0.0.1`/`[::1]` 的 **http** 允許，其餘一律 https-only。這同時兼顧「本機 Ollama 可用」與「遠端明文 http 不可用」兩端。

### 2.2 curl 依賴（Android 無 curl binary）

`src-tauri/src/lib.rs:290`（fetch_llm）、`:322`（fetch_get）皆為：

```rust
let output = std::process::Command::new("curl")...
```

Android 環境不存在 curl binary（v3 #4 委員實錘）。既有 `lookup_cambridge`（lib.rs:342-359）已改 `ureq`（註解 `// ponytail: ureq instead of curl — Android has no curl binary`）並出貨 — **fetch_llm／fetch_get 是同一類問題的漏網**。（附註：v3 定案文字稱「fetch_llm 已改 ureq」為**事實落差** — 實測 lib.rs:290 仍為 curl；本計畫書按任務授權（fetch_llm/fetch 區段）一併處理。）

### 2.3 v3 定案要素核對

| v3 定案要素 | 本計畫書對應 |
|---|---|
| lib.rs:321 URL.hostname 白名單（localhost/127.0.0.1/[::1] http 允許，其餘 https-only） | §3.2 `check_fetch_get_url` 純函數 |
| 一併換 ureq（fetch_get 同問題） | §3.2 fetch_get 改 async + spawn_blocking + ureq |
| fetch_llm 亦換 ureq（任務授權 fetch_llm/fetch 區段；v3 誤稱已改） | §3.1 fetch_llm 換 ureq |
| Cargo.toml 加 `url = "2"`（已在 Cargo.lock 為傳遞依賴，零成本） | §3.3 |

---

## 3. 修法（檔名：行號）

### 3.1 `src-tauri/src/lib.rs:273-316` — fetch_llm：curl → ureq（POST 語義不變）

**修改前**（:289-292）：

```rust
let handle = tokio::task::spawn_blocking(move || {
    let output = std::process::Command::new("curl")
        .args(["-s", "--max-time", "60", "--connect-timeout", "10", "-X", "POST", "-H", "Content-Type: application/json", "-d", &json_str, "--", &url])
        .output()
        .map_err(|e| format!("curl fail: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("curl error: {}", stderr));
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
```

**修改後**（同區段）：

```rust
let handle = tokio::task::spawn_blocking(move || {
    // ponytail: ureq instead of curl — Android has no curl binary
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60)) // 對齊原 curl --max-time 60（整體上限）
        .build();
    let resp = agent.post(&url)
        .set("Content-Type", "application/json")
        .send_string(&json_str)
        .map_err(|e| format!("HTTP error: {}", e))?;
    let text = resp.into_string().map_err(|e| format!("body error: {}", e))?;
```

其餘（:300-311 JSON 解析 openai/預設兩分支、:313-315 timeout 90s）**不變**。`ureq::post` 為 blocking 呼叫但位於 `spawn_blocking` 內 — 與 lookup_cambridge 典範（:342-359）一致，不卡 async worker。外層 `tokio::time::timeout(90s)` 為總上限保險層（60s agent timeout < 90s，先觸發者勝）。AgentBuilder 顯式 timeout 必要性的實錘（第 2 輪 #1 修正）：ureq 2.12.1 預設 read timeout 為 **None（無上限）**（agent.rs:256-259 Config Default 實錘；CHANGELOG「Read and write timeouts continue to be unset by default」）→ 不設時掛死/慢回應伺服器會無限等待（原 curl 有 `--max-time` 保護）→ 顯式 timeout(60s) 對齊 curl 後已修。

### 3.2 `src-tauri/src/lib.rs:318-331` — fetch_get：白名單＋ureq

**新增純函數**（置於 fetch_get 前）：

```rust
/// fetch_get URL 白名單：http 僅允許本機 host（localhost/127.0.0.1/[::1]），其餘一律 https-only。
/// （v3 定案：hostname 白名單取代 https:// 前置字串檢查；url crate 已在 Cargo.lock 為傳遞依賴）
/// 型別化比對（第 1 輪審查 #1 採納）：不用 host_str() 字串比對 — url 2.5.8 源碼實錘
/// host_str() 切片的是 parse 正規化重寫後的內部字串，IPv6 含方括號（"[::1]"）；
/// Host 列舉才是正規化型別（Domain/Ipv4/Ipv6；Ipv6Addr::LOCALHOST == ::1，
/// 長寫法 0:0:0:0:0:0:0:1 亦歸一；Domain host 已被小寫化，eq_ignore_ascii_case 為雙保險）。
fn check_fetch_get_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL 解析失敗: {}", e))?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => match parsed.host() {
            Some(url::Host::Domain(d)) if d.eq_ignore_ascii_case("localhost") => Ok(()),
            Some(url::Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => Ok(()),
            Some(url::Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => Ok(()),
            _ => Err("僅允許 HTTPS 連線（http 僅限 localhost）".to_string()),
        },
        _ => Err("僅允許 HTTPS 連線".to_string()),
    }
}
```

**修改後**（fetch_get 本體）：

```rust
#[tauri::command]
async fn fetch_get(url: String) -> Result<String, String> {
    log::info!("fetch_get url={}", url);
    check_fetch_get_url(&url)?;
    let handle = tokio::task::spawn_blocking(move || {
        // ponytail: ureq instead of curl — Android has no curl binary
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(15)) // 對齊原 curl --max-time 15（整體上限）
            .build();
        let resp = agent.get(&url)
            .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .call()
            .map_err(|e| format!("HTTP error: {}", e))?;
        resp.into_string().map_err(|e| format!("body error: {}", e))
    });
    tokio::time::timeout(std::time::Duration::from_secs(20), handle).await
        .map_err(|_| format!("fetch_get request timed out"))?
        .map_err(|e| format!("task failed: {}", e))?
}
```

**語意對照**：

| 原 curl 行為 | 新 ureq 行為 |
|---|---|
| `--max-time 15`（**整體上限，含 connect**，非可疊加） | agent `timeout(15s)` 同為整體上限（含 connect；ureq 實錘 timeout() 涵蓋 DNS/連線/redirect/讀 body，優先於 read/write 但不含 timeout_connect）→ 行為對齊；外層 `tokio::time::timeout(20s)` 為保險層（15s < 20s，agent 先觸發） |
| `--connect-timeout 10` | agent `timeout_connect(10s)`（connect 階段以此為準；ureq 預設 30s，顯式 10s 對齊 curl） |
| `-s` 靜默 | ureq 無輸出 |
| **404（curl 無 `-f`）**：exit code 0 → `status.success()==true` → **`Ok(404 body 文字)`**；JS 消費端 `JSON.parse` 失敗才進 catch | **404**：`Err(Error::Status(404, resp))` → `Err("HTTP error: ...")` → 直接進 JS catch。**行為改變（實為改善）**：404 由 Ok(body)→Err，兩者最終皆進 JS catch 相容；差異在錯誤路徑（舊 Ok→parse 失敗 vs 新直接 Err）與訊息文字（第 1 輪 #1 C2-1/#3 C1-2 如實記載採納） |
| stdout 為 body | `resp.into_string()` |
| UA：curl 預設 `curl/x.y.z` | 顯式 Chrome UA（與 lookup_cambridge 典範一致；部分伺服器對非瀏覽器 UA 較嚴） |
| 同步 fn（tauri sync command 執行緒） | async fn + spawn_blocking（不佔 sync 執行緒、有 timeout 語義） |

fetch_get 由 sync fn 改 async fn：`invoke_handler`（:1652）註冊名 `fetch_get` 不變，tauri 對 async command 支援相同 — JS 端 `invoke('fetch_get')`（api.js:15）零修改。fetch_llm 404 情境：舊版 404 body 為 HTML → JSON parse 失敗 → Err；新版直接 Err(Status) — 兩者皆 Err，僅訊息不同（該列無行為爭議）。

### 3.3 `src-tauri/Cargo.toml` — 加 `url = "2"`

```toml
# 修改前（:31 後）
ureq = { version = "2", default-features = false, features = ["gzip", "tls"] }
# 修改後
ureq = { version = "2", default-features = false, features = ["gzip", "tls"] }
url = "2"
```

理由：v3 定案要求顯式宣告。Cargo.lock 中 `url v2.5.8` 已為傳遞依賴（`cargo tree -i url` 實錘：cambridge_scraper/quizlet_scraper/schemars 依賴鏈）— 直接依賴化零新增版本解析成本；`--locked` 下 Cargo.lock 不變（同版本 2.5.8）。

### 3.4 單元測試模組（同檔尾 `#[cfg(test)]`）

```rust
#[cfg(test)]
mod fetch_tests {
    use super::*;

    #[test]
    fn fetch_get_url_whitelist() {
        // https 一律允許
        assert!(check_fetch_get_url("https://example.com/api/tags").is_ok());
        assert!(check_fetch_get_url("https://api.openai.com/v1/chat").is_ok());
        // http 僅限本機 host
        assert!(check_fetch_get_url("http://localhost:11434/api/tags").is_ok());
        assert!(check_fetch_get_url("http://127.0.0.1:11434/api/tags").is_ok());
        assert!(check_fetch_get_url("http://[::1]:11434/api/tags").is_ok());
        assert!(check_fetch_get_url("http://[0:0:0:0:0:0:0:1]:11434/api/tags").is_ok()); // ::1 長寫法亦歸一
        // 大小寫不敏感（url crate 正規化 scheme/host）
        assert!(check_fetch_get_url("HTTP://LOCALHOST:11434/api/tags").is_ok());
        // 其餘 http 拒絕
        assert!(check_fetch_get_url("http://example.com/api/tags").is_err());
        assert!(check_fetch_get_url("http://192.168.1.5:11434/api/tags").is_err());
        // 非 http/https scheme 拒絕
        assert!(check_fetch_get_url("ftp://example.com/file").is_err());
        // 偽 scheme（"localhost" 為合法 RFC 3986 scheme）→ 落 _ 分支拒絕
        assert!(check_fetch_get_url("localhost:11434/api/tags").is_err());
    }
}
```

設計要點：
1. **純函數**：白名單邏輯抽離 command 本體 → 可直接單元測試（D9 `parse_oauth_query` 同款典範）。
2. **IPv6 正規化**（第 1 輪審查 #1 C1-1 採納）：`Host::Ipv6(Ipv6Addr)` 為正規化型別 — `[::1]` 與長寫法 `0:0:0:0:0:0:0:1` 皆等於 `Ipv6Addr::LOCALHOST`；`[::1]` 直接以 `parsed.host()` 型別比對，**不依賴 host_str() 字串**（url 2.5.8 源碼實錘 host_str() 回含方括號的 `"[::1]"`，字串比對會誤擋）。
3. **時序**：白名單檢查在 async fn 內 `spawn_blocking` 之前同步執行 → 不合規 URL 不進 blocking pool。
4. **測試不發網路請求**：純字串解析 — cargo test 離線可跑。

### 3.5 不修改的檔案（明確排除）

| 檔案 | 原因 |
|---|---|
| `src-tauri/src/lib.rs` 其他區段（scrape_quizlet :247-268、piper 下載 :456/:464 等 curl） | 任務授權僅 fetch_llm/fetch 區段＋Cargo.toml；其餘 curl 使用點屬既有出貨、不在 F8 scope |
| `src/lib/store.js` | 首相 A 持有；無關 |
| `src-tauri/gen/android/` | 首相 C 持有；無關 |
| `src/lib/chart.js`、`src/styles/base.css` | 其他首相舊改動；無關 |
| `src/lib/api.js` | invoke 簽名不變（`fetchGet(url)`/`fetchLLM(url, model, prompt, apiFormat)`、回 `Result<String,String>` 語意不變），無需修改 |
| `src/pages/tools.js`、`browser.js`、`deck-browser.js` | 消費端相容（見 §4），不需修改 |
| `dist/assets/*.js` | build 產物；src 未改則不需動 |

---

## 4. 使用點窮舉（grep 三形態）

### 形態一：字面 `fetch_get`／`fetchGet`（雙形態 grep）

`grep -rn 'fetch_get\|fetchGet' src/ src-tauri/src/ --include='*.js' --include='*.rs'`

| 位置 | 型態 | 處理 |
|---|---|---|
| `src-tauri/src/lib.rs:319` | 函數定義（本次修改主體） | **改** |
| `src-tauri/src/lib.rs:1652` | invoke_handler 註冊（`fetch_get`） | 不動（名稱不變） |
| `src/lib/api.js:15` | `invoke('fetch_get', { url })` 封裝 `fetchGet` | 不動（簽名/回傳語意不變） |
| `src/pages/tools.js:3` | `import { fetchGet, ... }` | 不動 |
| `src/pages/tools.js:308` | **消費點**：`await fetchGet(`${baseUrl}/api/tags`)` — baseUrl 預設 `http://localhost:11434`（:300） | 不動（白名單放行 localhost ✓；使用者自訂遠端 → 需 https，符合安全目標） |
| `src/pages/browser.js:11` | `import { fetchGet, ... }` | 不動 |
| `src/pages/browser.js:959`/`:1086` | **消費點 ×2**：`fetchGet(`${baseUrl}/api/tags`)` — baseUrl 預設 localhost（:958/:1085 讀 llmUrl 輸入框；:1169/:1188 讀 store.state.ollamaUrl） | 不動（同上；:1086 為第 1 輪 #2 C2-1 補列） |
| `src/pages/deck-browser.js:5` | `import { fetchGet, ... }` | 不動 |
| `src/pages/deck-browser.js:645`/`:1002` | 消費點：`fetchGet(`${baseUrl}/api/tags`)` — baseUrl 預設 localhost（:644/:1001 讀 llmUrl 輸入框；:1536/:1555 讀 store.state.ollamaUrl） | 不動（同上） |

### 形態二：字面 `fetch_llm`／`fetchLLM`

`grep -rn 'fetch_llm\|fetchLLM' src/ src-tauri/src/ --include='*.js' --include='*.rs'`

| 位置 | 型態 | 處理 |
|---|---|---|
| `src-tauri/src/lib.rs:274` | 函數定義（本次修改主體） | **改** |
| `src-tauri/src/lib.rs:1652` | invoke_handler 註冊（`fetch_llm`） | 不動 |
| `src/lib/api.js:12` | `invoke('fetch_llm', { url, model, prompt, apiFormat })` 封裝 `fetchLLM` | 不動 |
| `src/pages/tools.js:446`/`:658`/`:720`/`:822`/`:863`/`:908` | 消費點：`fetchLLM(`${baseUrl}/api/generate`, ...)` — baseUrl 預設 `http://localhost:11434`（:300） | 不動（fetch_llm 不套白名單 — 維持既有 http/https 前置檢查 :288，Ollama localhost http 合法；遠端自訂 https 亦合法） |
| `src/pages/browser.js:962`/`:1091`/`:1097`/`:1103`/`:1171`/`:1190` | 消費點：`fetchLLM(`${baseUrl}/api/generate`, ...)` — baseUrl 預設 localhost | 不動 |
| `src/pages/deck-browser.js:650`/`:656`/`:662`/`:1007`/`:1011`/`:1015`/`:1538`/`:1557` | 消費點：`fetchLLM(`${baseUrl}/api/generate`, ...)` | 不動 |
| `src-tauri/src/drive_sync.rs:298` | 註解提及「比照 fetch_llm 典範」 | 不動（純註解） |
| `dist/assets/index-DzHAt3X_.js` | build 產物（打包後 invoke 字串） | 不動（src 未改） |

附註：形態二之 import 行（tools.js:3、browser.js:11、deck-browser.js:5）與形態一相同三行 — 該三行同時 import `fetchGet` 與 `fetchLLM`，形態一已列，此處不重複（第 3 輪 #2 C3-A 落地，兩形態對稱）。

### 形態三：`Command::new("curl")`（確認 curl 依賴收斂）

`grep -rn 'Command::new("curl")' src-tauri/src/`

| 位置 | 型態 | 處理 |
|---|---|---|
| `src-tauri/src/lib.rs:250` | scrape_quizlet 內 | 不動（非授權區段；既有出貨、desktop 可用 — Android 版 quizlet 匯入為已知別案） |
| `src-tauri/src/lib.rs:290` | fetch_llm 內 | **改**（ureq） |
| `src-tauri/src/lib.rs:322` | fetch_get 內 | **改**（ureq） |
| `src-tauri/src/lib.rs:456`/`:464` | piper 模型下載 | 不動（非授權區段） |

**結論**：F8 影響面完全收斂於 `lib.rs:273-331`（fetch_llm＋fetch_get 兩函數＋新增 `check_fetch_get_url`）與 `Cargo.toml`；JS 端零修改且消費語意相容（**fetchGet 全部消費點** baseUrl 預設 localhost http，白名單放行；遠端 https 亦放行。附註：browser.js:1169/:1188、deck-browser.js:1536/:1555 之 fetchLLM baseUrl 取自 `store.state.ollamaUrl` 可為使用者自訂值 — fetchLLM 不套白名單故無安全/相容影響，第 1 輪 #2 C3-2 措辭精確化採納）。另 tools.js:153 有 `<input id="llmUrl" value="http://localhost:11434/api/generate">` UI 預設值（HTML attribute 形態，非消費點；第 1 輪 #2 C3-1 註記防未來 grep baseUrl 漏改）。

---

## 5. 驗證項目（憲法第 4 條 ✅ 附實測）

1. **`cargo check --locked`**（src-tauri）：新增 `url` 直接依賴宣告正確（lock 不變）、`check_fetch_get_url` 型別正確（`url::Url::parse` → `&Url`、`scheme()` → `&str`、`host()` → `Option<Host<&str>>` 含 Domain/Ipv4/Ipv6 三 arm）、fetch_get async 化＋`spawn_blocking` closure 捕獲、AgentBuilder timeout/timeout_connect API、ureq POST/GET builder API 正確。
2. **`cargo test fetch_tests`（1 測試函數 11 斷言）**：白名單全情境（https 2 例、http 本機 4 例含 ::1 長寫法、大小寫 1 例、http 遠端 2 例、ftp 1 例、偽 scheme 1 例）。
3. **行為驗證**：測試即行為驗證（純函數無網路）；404 行為差異（Ok(body)→Err）以 code 審查＋§3.2 語意對照表如實記載為憑，實機確認於測試環境可作時執行。
4. **JS 側回歸**：`node --check src/lib/api.js`（不改，確認無語法問題）。
5. **回歸**：`cargo check` 全 crate 通過即證明 fetch_llm/fetch_get 既有 invoke 路徑不受影響；`cargo test` 全量（container_tests 2＋fetch_tests 1；sim_tests 為既有環境依賴已知失敗，stash 對照確認非本次引入）。
6. **QA 預期**：LLM/Ollama 錯誤 toast 文字由「curl error: …」變「HTTP error: …」為預期視覺差異 — 錯誤訊息文字非相容性合約（全 src/ 無程式碼比對錯誤訊息字串，第 1 輪 #2 C3-3/#1 C3-2 採納）。

---

## 6. 風險評估

| 風險 | 等級 | 緩解 |
|---|---|---|
| `url::Url::parse` 對邊緣 URL 的解析行為差異 | 低 | 解析失敗 → `Err("URL 解析失敗")` 明確錯誤；偽 scheme（如 `localhost:11434` → scheme=`"localhost"` 為合法 RFC 3986 scheme）→ parse 成功但落 `_` 分支 → Err — 皆回 Err，原 `starts_with("https://")` 檢查對同字串本就回 Err，行為一致（第 1 輪 #1 C2-2/#3 C2-3 敘述精確化採納） |
| IPv6 host_str 含方括號（字串比對會誤擋 `[::1]`） | 低（已修） | 改 `parsed.host()` 型別化比對（`Host::Ipv6(ip) == Ipv6Addr::LOCALHOST`）— url 2.5.8 源碼實錘 host_str() 切片含括號；測試用例 4/5 斷言實錘（第 1 輪 #1 C1-1 採納） |
| fetch_get sync→async 轉換 | 低 | invoke_handler 註冊名不變、JS invoke 簽名不變；tauri async command 為一等公民（fetch_llm/lookup_cambridge 已為 async 出貨） |
| **404 行為改變**：curl 無 `-f` → 404 exit 0 → Ok(body)；ureq → Err(Status) | 低（實為改善） | fetch_get 404 由 Ok(body)→Err（JS 端 parse 失敗進 catch → 直接 Err 進 catch，路徑不同但最終皆進 catch）；fetch_llm 404 兩版皆 Err（舊 body parse 失敗 vs 新直接 Err）僅訊息不同；全 src/ 無比對錯誤訊息字串（第 1 輪 #1 C2-1/#3 C1-2 如實記載採納） |
| ureq 預設 read timeout 為 None（無上限）— 掛死/慢回應伺服器無限等待（原 curl 有 `--max-time` 保護） | 低（已修） | AgentBuilder 顯式 `timeout(60s)`（fetch_llm）／`timeout(15s)`（fetch_get）對齊原 curl --max-time；外層 tokio timeout(90s/20s) 為保險層（第 2 輪 #1 C2-1 修正：非「30s 早掐斷」— ureq 2.12.1 實錘 timeout_read 預設 None；數字補註第 3 輪 #1 C3 採納） |
| 錯誤訊息文字全面改變（curl error/fail → HTTP error/body error/task failed） | 低 | api.js 僅傳遞 Err 字串不 parse；全 src/ 無比對錯誤訊息（第 1 輪 #1 C3-2/#2 C3-3 採納，§5.6 QA 預期） |
| 其他 curl 使用點（scrape_quizlet/piper）未換 | 低 | 屬授權範圍外；Android 版此二功能為已知既有限制（backlog），本 bug 只修 fetch 區段 |

---

## 7. 審查歷程

| 輪次 | 日期 | 委員 | 裁決 | 發現／採納 |
|---|---|---|---|---|
| 1 | 2026-08-15 | #1（Rust/編譯） | ⚠️ 條件通過 | **C1-1（必改・bug）**：`host_str()` 對 `[::1]` 回含方括號的 `"[::1]"`（url 2.5.8 源碼 lib.rs:1162-1167 切片實錘＋獨立專案實測）→ 原 `matches!(host, ... "::1")` 誤擋 IPv6 本機 Ollama、§3.4 測試照抄必紅 → 改 `parsed.host()` 型別化比對（Host::Domain/Ipv4/Ipv6，Ipv6Addr::LOCALHOST 歸一長寫法），實測 10 斷言全綠（v1.0 測試 10 例；v1.1 採納偽 scheme 用例後為 11 例，見 §5.2；第 3 輪 #3 C2-1 落地）；**C2-1（應改）**：404 語意對照不實（curl 無 -f → 404 exit 0 → Ok(body)，非 Err）→ 如實記載（§3.2 對照表）；**C2-2（應改）**：`localhost:11434` 為偽 scheme（parse 成功非失敗）→ 敘述精確化（§6）；C3：錯誤訊息文字變化註記（§5.6/§6 採納）、大小寫不敏感註記（§3.4 採納）。全數採納 |
| 1 | 2026-08-15 | #2（JS/使用點） | ⚠️ 條件通過 | **C2-1（應改）**：形態一漏列 browser.js:1086 第二個 fetchGet 消費點（:959/:1086 皆 src==='llm' 分支 `/api/tags` 探測）→ §4 補列（結論不變）；C3-1：tools.js:153 UI 預設值註記（§4 結論採納）；C3-2：結論句精確化「fetchGet 全部消費點」（ollamaUrl 可自訂 4 處 fetchLLM 不適用該敘述，§4 採納）；C3-3：toast 錯誤文字變更 QA 預期（§5.6 採納）。其餘全數實錘屬實（settings.js/src/lib/cli.mjs/.html/.vue 零引用、curl 5 處收斂、dist 不動合理）。全數採納 |
| 1 | 2026-08-15 | #3（語意/流程） | ⚠️ 條件通過 | **C1-2（必改・文件矛盾）**：§3.2 對照表 :139 稱「curl 404 → Err」與 §6 :269 自己寫「exit code 0」自相矛盾 → 如實記載 404 由 Ok(body)→Err（行為改變實為改善，§3.2/§6 採納）；**C2-1（應改）**：timeout 推導錯誤 — curl --max-time 15 為整體上限（含 connect）非可疊加，20s 為放寬非保守 → 改 agent timeout(15s) 對齊（§3.2/§3.1 採納）；**C2-2（應改）**：ureq 全域預設 read timeout ~30s 比 curl 60s 早掐斷未記載 → AgentBuilder 顯式 timeout 對齊（§3.1 採納）；**C2-3（應改）**：偽 scheme 敘述（同 #1 C2-2，§6 採納）；C3：UA 差異對照表補列（§3.2 採納）。v3 三要素全覆蓋、§2.2 事實落差聲明誠實且必要、流程八節齊備、憲法第 4 條符合 — 實錘確認。全數採納 |
| 2 | 2026-08-15 | #1（Rust/編譯） | ⚠️ 條件通過（v1.2 修正後成立） | 獨立專案 /tmp/f8-review1b 逐字複製 v1.1 code：cargo check 通過＋cargo test 6/6 全綠（f8-review1b 專案內 6 測試；含 §3.4 逐字 11 斷言）；實錘 Host::Ipv6 對 [::1] 與長寫法皆 == Ipv6Addr::LOCALHOST、host_str() 含方括號（v1.0 C1-1 結論成立）、AgentBuilder timeout()=整體上限（agent.rs:490 doc＋行為實驗）、404 語意（curl -s 無 -f → exit 0 + body 實機實錘）與 §3.2 對照表一致；**C2-1（應改・記載不實）**：v1.1 稱「ureq 預設 read timeout 約 30s」實錘為 **None 無上限**（agent.rs:256-259 Config Default；CHANGELOG「Read and write timeouts continue to be unset by default」）→ 真正風險是掛死伺服器無限等待（非早掐斷），修法結論不變 → v1.2 修正（§3.1/§6）；C3：host_str 切片描述精確化（正規化重寫後字串）、eq_ignore_ascii_case 為雙保險、timeout 優先序（不含 timeout_connect）、ureq 預設 connect 30s 註記（§3.2 對照表採納）。全數採納，v1.2 後條件成立 |
| 2 | 2026-08-15 | #2（JS/使用點） | ✅ 通過 | 五項指定驗證全數實錘：browser.js:959/:1086 兩消費點屬實（皆 src==='llm' 分支）、tools.js:153 input value 屬實、ollamaUrl 4 處（browser:1169/:1188、deck:1536/:1555）全中且與 llmUrl 輸入框來源確實不同、三形態 grep 全套重跑無新漏列、§5.6 QA 預期合理（grep curl error|HTTP error 於 src/ = 0 matches）；本輪無 C1/C2，僅 C3-1（browser.js 行括號兩來源併列易誤導 → v1.2 區分 llmUrl/ollamaUrl 註記採納）＋C3-2（形態二未列 import 行，純格式對稱註記）。v1.1 四項採納（C2-1/C3-1/C3-2/C3-3）全數實錘 |
| 2 | 2026-08-15 | #3（語意/流程） | ✅ 通過 | 全文通讀：C1-2 404 矛盾已消除（§3.2 vs §6 一致）、timeout 三處自洽（60s/90s、15s/20s 關係正確）、v3 三要素＋fetch_llm 落差四項全覆蓋、§7 第 1 輪記錄與正文 12 處採納註記交叉引用全對得上；**C2-1（應改・輕度）**：§7 第 1 輪 #1 行「10 斷言」vs §5.2「11 斷言」數字不一致（v1.0 送審為 10 例、v1.1 加偽 scheme 用例後 11 例）→ v1.3 §7 補註版本演進（第 3 輪 C2-1 落地）；C3-1：§8 執行狀態仍寫 v1.0 → v1.2 升版；C3-2：§6 read timeout 行未區分 fetch_get 情境（v1.2 已改寫涵蓋兩函數）。v1.1 達可動工標準 ✅ |
| 3 | 2026-08-15 | #1（Rust/編譯） | ✅ 通過 | 最終複核：C2-1 修正完全準確（ureq 2.12.1 agent.rs:256-259 實錘 timeout_read: None；CHANGELOG:242-243 逐字命中；timeout_read doc「may block forever by default」方向正確）；三處 timeout 敘述自洽（60s/90s、15s/20s、None 預設）；code 版本未變（git diff 對 lib.rs/Cargo.toml/Cargo.lock 全空、lib.rs:273-331 與「修改前」逐字一致、§3.4 11 斷言與 §5.2 對齊）；無 C1/C2；C3：§6 風險表「外層 tokio timeout 為保險層」補數字（90s/20s）→ v1.3 採納 |
| 3 | 2026-08-15 | #2（JS/使用點） | ✅ 通過 | 最終複核：v1.2 括號來源註記 8 行號全數實錘（browser :958/:1085 llmUrl 輸入框、:1169/:1188 ollamaUrl；deck :644/:1001 llmUrl、:1536/:1555 ollamaUrl）；三形態 grep 全套重跑無新漏列（形態一 10 行、形態二 25 行、形態三 5 處）；§5 六項完整（錯誤訊息字串 grep 0 matches、container_tests 模組實存）；無 C1/C2；C3-1（形態二補 import 行格式對稱）、C3-2（§8 審查通過勾選）→ 格式層級，v1.3 採納 |
| 3 | 2026-08-15 | #3（語意/流程） | ⚠️→✅（v1.3 修正後成立） | 最終複核發現第 2 輪 C2-1（§7 :295 斷言數字補註）宣告採納但**未實際落地**（:5/:300/:306 三處聲稱已修 vs 實際未修 → 文件自我矛盾）→ v1.3 於 §7 第 1 輪 #1 行落地「（v1.0 測試 10 例；v1.1 採納偽 scheme 用例後為 11 例，見 §5.2）」；C3-1：標題列第 2 輪裁決簡寫 ✅/✅/✅ 易誤導 → 改「#1 ⚠️ 條件通過＋#2/#3 ✅（等效 3/3）」（v1.3 採納）；C3-2：「6/6 全綠」組成未說明 → 補「（f8-review1b 專案內）」（v1.3 採納）；C3-3：C2-1 撞號註記（v1.3 採納）。其餘指定檢查全數到位（§8 升版、§6 兩函數、歷程完整、11 斷言內部一致）。修正後等效 3/3 ✅ 定案 |

---

## 8. 執行狀態

- [x] 計畫書完成（v1.3 定稿；第 1 輪 3 委員 ⚠️ 全數採納、第 2 輪 #1 ⚠️ 條件通過＋#2/#3 ✅、第 3 輪 #1/#2 ✅＋#3 ⚠️→✅（§7 補註落地）、第 4 輪 #1/#2/#3 全 ✅ → 等效 3/3 ✅ 定案）
- [x] 審查通過（4 輪，3 委員等效 3/3 ✅）
- [x] 動工（Cargo.toml + lib.rs fetch 區段）
- [x] 實測驗證（cargo check --locked 通過；cargo test fetch_tests 1/1＋container_tests 2/2＋drive_sync 全綠；sim_tests 3 失敗為既有環境依賴 /tmp/sim-req-*.json 缺失，D9 stash 對照實錘非本次引入；node --check api.js 通過；grep 複核 fetch 區段 curl 0 處、check_fetch_get_url 就位、invoke_handler 註冊不變；Cargo.lock 僅 +1 行 url 直接依賴宣告、版本 2.5.8 未變）
- [x] 一 bug 一 commit（message 標 F8；commit 僅含 Cargo.toml + Cargo.lock + lib.rs + 本計畫書）
