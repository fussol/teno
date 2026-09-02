# PM-SR2 檢查點（2026-08-30）— 3/5 顆完成，F15/F13 交接

## 執行者
SR2 首相（Teno 離線波次，CLI/Drive/Rust 域）。

## 已 commit 清單（3 顆完整循環）
| Bug | Commit | 版本 | 審查 | 驗證 |
|---|---|---|---|---|
| D10-SR1/SR2（CLI 雙鏡像 find_db_file 盲取）| 3bdedd6 | 5.8.9 | 5 輪多席（v1→v5, 行為級替代結構）| verify-d10 POST 72/0 |
| F14-SR1（teno doublefire 預設路徑失效）| 11d218f | 5.8.10 | 2 輪（v1 路徑誤判→v2 share）| verify-f14 49/0＋端到端 doublefire 150/6 |
| F11-SR1（build.rs rerun）| deca6b9 | 5.8.11 | 3 輪（v1 證偽非bug→v2 假pin→v3 真pin）| verify-f11 35/35 |

## 剩餘佇列（runner/下 session 續跑）

### F15-SR1 — report/compare HTML 模板 CDN 無 SRI（中等）
- **設定**：4 實例 `tools/cli.mjs:2031`(cmdCompare)、`:2821`(cmdReport)＋`_dev/cli/cli.mjs:1804`、`:2590`——chart.js CDN 無 SRI＋內嵌執行塊。供應鏈面（R1#3）。
- **修法要點**：①chart.js 釘版本＋integrity 或改本地資產；②生成期可算內嵌 script 塊 sha256 寫 `<meta>` CSP（CSP3 准 hash 禁 nonce）；③新增字串欄位必 `\u003c` 轉義；④兩鏡像同步。
- **驗證**：`tools/verify-f15-report-surface.mjs`（回歸 18/18）＋新增 SRI/hash 斷言。
- **注意**：動工前實錘 4 實例現行行號（任務書 2031/2821/1804/2590 可能漂移）；白名單含 verify-f15-report-surface.mjs。

### F13-SR2 — cambridge_scraper english.rs 新模板選擇器（較重）
- **設定**：Cambridge 新版 tw-/superentry 模板條目頁（get-rid-of/take-a-shower）零 `.entry-body`（有 def-block×5），`scrape_cambridge_html` 回 WordNotFound。舊 hello 模板路徑仍綠＝非全局壞。
- **修法**：`src-tauri/cambridge_scraper/src/english.rs` 加 `.def-block.ddef_block` 解析路徑（失敗兜底），配合既有 `:56 def_block: Selector::parse(".def-block.ddef_block")` 已存在——實錘為何仍 WordNotFound，補選擇器/解析邏輯。
- **驗證**：`tools/verify-f13-url-encode.mjs`（回歸 31/31）＋端到端條目頁解析（含新模板片語）。
- **注意**：需實錘 english.rs 現行 `:56` def_block 定義與 `scrape_cambridge_html` 取 `entry-body` 處行號（漂移風險）；scraper 為 Rust，回歸用 cargo test＋verify-f13。

## 遺留事項
- **F14 A1（交總統裁示）**：`_dev/notes/scope-requests.md:18` 仍寫 v1 錯路徑 `.local/state`＋舊命名；共享檔不 add，建議翻正「teno doublefire 預設改 ~/.local/share/com.teno.app/logs/teno-monitor.log」。
- **F11 Cargo.lock** 自身版本欄滯後（5.2.10→5.8.10 漂移）：隨下顆 Rust 側 commit 帶走。
- **F13 屬 scraper 解析域**（task 改派 SR2 承接）。

## 途中教訓（供續跑）
- **端點 429 頻繁**：glm-5.3-free 每分鐘 8 req，審查並行易觸發；起審查前 sleep≥60s，或單一批次降並行。
- **重新審查嚴謹**：v1-v3 每輪委員都抓到真縫（靜態掃描器本質防不了語意→行為級替代結構是最好的解）。
- **無 429 時**：verify-f15 先實跑 PRE 態紅（bug 在場）再送審，負控制證據先行（法律④）。

## 基線
HEAD 現為 deca6b9（v5.8.11）。續跑每顆結案後 `./tools/version.sh patch` 逐顆升版＋三指紋 staged。共享檔 `scope-requests.md` 絕不 add。