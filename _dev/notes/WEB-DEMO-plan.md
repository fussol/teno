# WEB-DEMO 網頁展示模式（2026-09-08，使用者裁示）

## 問題
`dist/` 被當純靜態頁用瀏覽器開（`python http.server`＋cloudflared 隧道）時，
`window.__TAURI__` 不存在 → `Database.load('sqlite:teno.db')` 三次重試全滅 →
全站空資料。架構限制，非 bug：SQLite 活在 Tauri 後端裡。

## 使用者選擇
clarify 三選一 → 「網頁版內建幾十個假單字，所有頁面都有東西可點可看」。

## 做法（實機零影響）
- 新增 `src/lib/demo-data.js`：36 示範單字（GRE 核心／托福／日常各 12）＋
  36 張卡（8 複習到期／8 全新／20 排未來）＋3 字本＋7 天複習紀錄＋10 筆測驗＋
  streak＋6 筆操作日誌種子。寫入走記憶體（session 內有效，refresh 重置）。
- `src/lib/db.js`：`initDB` 開頭偵測無 `__TAURI__` → `demoMode=true`＋`Demo.seed()`；
  其餘 49 個 exported async fn 第一行 `if (demoMode) return Demo.X(...arguments)`。
  `isReady()` 加 `|| demoMode`。Tauri 內 demoMode 永遠 false。
- `src/lib/app-log.js`：`noBackend()` 分支——寫入進記憶體、查詢回種子、
  prune 回 0（擋掉每 2 秒 flush 重試洗版）。
- `src/lib/tts.js`：`speak()` 無後端時走瀏覽器 speechSynthesis（點單字會唸）。
- `src/main.js`：開機 toast 改展示模式中性提示，不報錯。
- 純展示層：Rust／migrate／SQLite 語意一行未動；Pure SQLite 家規不變
  （demo 不寫 localStorage，純記憶體）。

## 真資料快照（2026-09-08 使用者追問「資料連上嗎」後加）
- `tools/export-web-snapshot.py`：本機 `~/.config/com.teno.app/teno.db`
  → `public/real-data.json`（4921 詞／2052 卡／16 字本／近 3000 筆複習紀錄＋
  streak＋exam 全倒，圖片單張 >200KB 留空，約 6MB）。
- `public/real-data.json` 已進 `.gitignore`：真資料不出本機、不上 GitHub。
- 為何放 public/：vite build 會清空 dist/，直寫 dist 會被洗掉（實測 MISSING）。
  放 public/ 讓 build 自動拷進 dist/，隧道照服。
- `demo-data.js seed()`：優先 `fetch('real-data.json')` → 真資料；
  無快照（fresh clone）→ 回退 36 詞種子。快照是唯讀時間點，
  網頁寫入只改記憶體、不回寫 DB（refresh 重置）。
- 快照更新：本機 DB 變了就重跑一次腳本＋（dist 已重 build 會自動帶入）。

## 不展示的東西（先天缺後端）
- 自動補齊／字典查詢／OCR／匯入匯出（要 Rust 或 key，按鈕照按會 toast 報錯，不炸頁）
- 圖片（IMG1 base64，種子無圖）

## 驗證
- `node tools/verify-webdemo.mjs`：16/16 PASS（形狀＋寫入往返＋guard 引用全存在）
- 回歸：`verify-mw-parse`／`verify-ocr3-auto` ALL PASS；`node --check` 5 檔；
  `vite build` 865ms 綠；dist 含 `abate`＋`isDemoMode`，本地 `:8090` 200。
- 真瀏覽器實跑：待使用者 refresh 隧道連結肉眼驗（harness 要按 Allow 才能代駕）。

## 參考
無外部方法——純內部 circulation（db.js 輸出形狀照抄）。未引用外部做法。
