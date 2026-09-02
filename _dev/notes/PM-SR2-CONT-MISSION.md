# PM-SR2-CONT 任務書 — 續跑 SR2 遺留兩顆（F15-SR1、F13-SR2）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`、**`_dev/notes/PM-SR2-checkpoint.md`**。工作目錄 `~/teno`，branch main。基線 HEAD=`$(git rev-parse HEAD)`（讀檔時現值，為 v5.8.12，**比 checkpoint 的 deca6b9 新**，需以實際為準）。

## 任務性質
承接前一位 SR2 首相留的檢查點，把**剩餘兩顆跨域尾巴收完**：F15-SR1、F13-SR2。檢查點已含現況分析、修法要點、驗證工具、途中教訓 — **直接照它續跑，不需重新調查**（除非行號已漂移需重實錘）。

## 剩餘佇列（照 checkpoint 第 13-25 行）
1. **F15-SR1** — report/compare HTML 模板 CDN 無 SRI（4 實例：tools/cli.mjs:2031/:2821＋_dev/cli/cli.mjs:1804/:2590，行號可能漂移）。修法：chart.js 釘版本+integrity 或本地資產；生成期內嵌 script 塊 sha256 寫 meta CSP；字串欄位 `\u003c` 轉義；兩鏡像同步。驗證 verify-f15-report-surface.mjs（回歸 18/18＋新增 SRI/hash 斷言）。
2. **F13-SR2** — cambridge_scraper english.rs 新模板選擇器（較重）。Cambridge 新版 superentry 條目頁無 `.entry-body`（有 def-block×5）→ scrape_cambridge_html 回 WordNotFound。補 def-block 解析路徑＋失敗兜底；實錘 :56 def_block 為何仍失敗、補選擇器/解析。驗證 verify-f13-url-encode.mjs（回歸 31/31）＋端到端條目頁解析。

## 鐵律（GOV-BRIEF，務必）
- 一顆 bug 一任務循環：實錘現行行號 → PRE 態紅優先證（負控制）→ 修 → POST 綠 → 審查（一般 3 委員／簡單降 1）→ commit → md log 落 `_dev/notes/subagent-log/`。
- **禁 `git add -A`**，commit 前完整 `git status` 揪預 staged 外來檔（ALIGN 教訓：別人預 staged 的 src/lib.rs 等別誤掃）。
- 只碰白名單檔（api check：F15→tools/cli.mjs、_dev/cli/cli.mjs、verify-f15-report-surface.mjs；F13→src-tauri/cambridge_scraper/src/english.rs、verify-f13-url-encode.mjs、src-tauri/Cargo.lock）。
- **禁碰共享髒檔**：scope-requests.md、Cargo.lock（若非版本同步必要）。
- 升版逐顆 `./tools/version.sh <完整版號>`（繞過 patch 分支 read 汙染 bug），三指紋同步。
- 429 退避：審查並行易觸發 glm-5.3-free 8req/min 限流，起審查前 sleep≥60s、降並行。

## 交付
- 兩顆都完成或完整交接（若 F13 太重做不完，寫明做到哪、剩什麼）。
- 回報：各顆 commit hash、審查輪數人次、驗證 N/N、計畫書路徑。
- 用繁體中文。