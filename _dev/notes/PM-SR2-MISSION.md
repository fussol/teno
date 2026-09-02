# PM-SR2 任務書 — CLI/Drive/Rust 域 SR 修復（D10/F14/F11/F15/F13）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`。工作目錄 `~/teno`，branch main，基線 HEAD=`12e9978`(v5.7.0)。

## 檔案所有權白名單
- `tools/cli.mjs`
- `_dev/cli/cli.mjs`
- `src-tauri/src/drive_sync.rs`
- `src-tauri/build.rs`
- `src-tauri/cambridge_scraper/`（src/*.rs）
- `tools/verify-d10.mjs`、`tools/verify-f14-monitor-log.mjs`、`tools/verify-f13-url-encode.mjs`、`tools/verify-f15-report-surface.mjs`（及其他本次相關 verify-*.mjs）
- `_dev/notes/`（含 subagent-log/）

**不碰**：`src/lib/*.js`（他軌SR1）、`src-tauri/src/lib.rs`（已有主修，SR只動他檔）、`src-tauri/Cargo.*`（他軌）、`src/pages/*.js`（他軌）。`scope-requests.md` 共享檔絕不 add/commit。

## Bug 佇列（依序，每顆完整循環：計畫書→審查→動工→驗證→升版→commit→md log）

### 1. D10-SR1 + D10-SR2 — CLI 雙鏡像 find_db_file 盲取首筆
- Bug：`tools/cli.mjs:3283-3290` 與 `_dev/cli/cli.mjs:3046-3051` 同 D10 主修前缺陷 — `fields=files(id)`＋`files?.[0]?.id` 盲取首筆。Rust 主修（aab047b）已修 `pick_latest_file`（modifiedTime max）；兩處 CLI 鏡像未同步。
- 修法：照 `src-tauri/src/drive_sync.rs` 的 `pick_latest_file` 語意（orderBy=modifiedTime desc＋fields 含 modifiedTime＋顯式迴圈取 max）同步到兩鏡像。D10-SR1 與 D10-SR2 同檔同修法，**可併單 commit**（依法行政法§2 跨鏡像同 bug，同 ID 併修）。
- 驗證：`tools/verify-d10.mjs`（含平手語意、缺 mtime 退回首顆、缺 id 跳過、空非陣列 None）。

### 2. F14-SR1 — cli.mjs `teno logs` 預設路徑失效
- Bug：F14 鏡像檔從 `/tmp/teno-monitor.log` 搬至 `app_log_dir()` 後，`cli.mjs:1476` 與 `_dev/cli/cli.mjs:1292` 的 `teno logs` 預設路徑失效（可傳參覆蓋非斷路）。
- 修法：預設改 `~/.local/state/com.teno.app/logs/teno-monitor.log`（app_log_dir 實際路徑，實錘後寫入）。master + _dev 鏡像同步。
- 驗證：`tools/verify-f14-monitor-log.mjs` 回歸（38/38）；新增或沿用斷言確認 logs 預設路徑正確。

### 3. F11-SR1 — build.rs 缺 rerun-if-env-changed
- Bug：F11 改 `option_env!("TENO_DRIVE_CLIENT_ID/SECRET")` 編譯期注入後，發佈者改 env 值 cargo 不感知（option_env! 不重新求值除非 clean）。
- 修法：`src-tauri/build.rs` 加兩行 `println!("cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_ID");` ＋同 SECRET。
- 驗證：cargo 驗證（touch 或改 env 強制重編證 option_env 嵌入鏈）。回歸 verify-f11（若存在）。

### 4. F15-SR1 — cli.mjs report/compare HTML 模板 CDN 無 SRI（供應鏈面）
- Bug：4 實例 `tools/cli.mjs:2031`（cmdCompare）、`:2821`（cmdReport）＋`_dev/cli/cli.mjs:1804`、`:2590` — chart.js CDN 無 SRI＋內嵌執行塊。
- 修法要點（R1#3）：①chart.js 釘版本＋integrity 或改本地資產；②生成期可算內嵌 script 塊 sha256 寫 `<meta>` CSP（CSP3 准 hash 禁 nonce）；③新增字串欄位必 `\u003c` 轉義；④兩鏡像同步。
- 驗證：`tools/verify-f15-report-surface.mjs`（18/18 回歸）＋新增 SRI/hash 斷言。

### 5. F13-SR2 — cambridge_scraper english.rs 新模板選擇器
- Bug：Cambridge 新版 tw-/superentry 模板條目頁（get-rid-of/take-a-shower）零 `.entry-body`（有 def-block×5），`scrape_cambridge_html` 回 WordNotFound。舊 hello 模板路徑仍綠＝非全局壞。
- 修法：`src-tauri/cambridge_scraper/src/english.rs` 加 `.def-block.ddef_block` 解析路徑（失敗兜底），配合既有 `:56 def_block: Selector::parse(".def-block.ddef_block")` 已存在——實錘為何仍 WordNotFound，補選擇器/解析邏輯。
- 驗證：`tools/verify-f13-url-encode.mjs` 回歸（31/31）＋端到端條目頁解析（含新模板片語）。

## 完成標準
佇列全數有 `fix: D10-SR1 / F14-SR1 / F11-SR1 / F15-SR1 / F13-SR2` commit＋回報五欄摘要。每顆獨立 commit（D10 兩鏡像可併同 ID）、獨立驗證、獨立 md log。

## 版本
每顆 bug 結案 commit → `./tools/version.sh 5.7.x`（逐顆 +1，SR1 首相也在升版，撞到就 git pull/rebase 或波尾總統統一升）。commit 前確認 staged 三檔齊全。共享檔絕不 add。

## 注意
- `tools/cli.mjs` 歷史上是他人軌髒檔（SR-C4）— 動工前確認現行 HEAD 版本 clean，若髒先只動你自己的 hunk。
- subagent/delegate 一律 Hermes，禁 opencode。
- 完成後 md 落盤 `_dev/notes/subagent-log/2026-08-30-SR2-*.md`。