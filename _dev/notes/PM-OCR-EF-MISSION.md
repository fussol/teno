# PM-OCR-EF 任務書 — OCR 優化 E′（Vision AI 引擎）+ F′（匯入檔案）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`、**`_dev/notes/OCR-OPTIMIZE-plan.md`**（完整計劃書 v1.1，你的範圍=E′ 段 + F′ 段）。工作目錄 `~/teno`，branch main。基線 HEAD=`$(git rev-parse HEAD)`（讀檔時現值）。

## 任務性質
執行 OCR 優化計劃書的 **E′ 段（新增 Vision AI 引擎，desktop-only）+ F′ 段（匯入來源擴充成多圖/PDF/文字檔）**，兩顆獨立 commit（E′ 一顆、F′ 一顆）。

## 範圍（只動這些，**禁碰 store.js 的資料層核心**）
- E′：`src/lib/ocr/engine.js`（registerEngine('vision-ai')）、新增 `src/lib/ocr/vision-adapter.js`、`src/pages/ocr.js`（引擎選單 desktop 限定標示）
- F′：`src/pages/ocr.js`（匯入 input 改多檔 accept、runFile 依 type 分流、文字檔 fast-path 呼叫 importOcrText）
- `tools/verify-ocr2-vision.mjs`、`tools/verify-ocr2-importfile.mjs`（新增 harness）
- `_dev/notes/`（subagent-log/）

## 關鍵技術裁示（動工前必讀）
1. **E′ 送圖走方案 A（前端直連 ollama）**，不要動 Rust src-tauri（SR2-CONT 在改）。若 Tauri CSP `connect-src` 擋 `http://localhost:11434` → **先回報總統**，不要擅自動 lib.rs。可用既有 `s.state.ollamaUrl`（預設 localhost:11434）。
2. **F′ 文字檔 fast-path**：讀 `file.text()` → 抽 token（沿用 importOcrText 的 whitelist regex `/^[a-z][a-z'-]{1,30}$/i` + 去重 + 去 noise）→ `s.actions.importOcrText(tokens)`。**這條現成已通，不用重寫 OCR**。
3. **F′ PDF**：先實錘 webview 可否 render pdf；若難 → **先做「圖片複數 + 文字檔」**，PDF 列後續（plan F′.4 風險明說）。

## 禁區（跟並行首相協調）
- **絕不碰 `src/lib/store.js` 的 importOcrText/importWords/enrichOcrWords 實作** — BH-FIX 佔用。F′ 只是**呼叫** importOcrText（ocr.js 端組 token 後傳入），不改它的實作。
- 不碰 `src-tauri/`（SR2-CONT）；不碰 A/B′/C/D′ 段（別的首相負責）。
- **禁 `git add -A`**；commit 前完整 `git status` 揪別人的 staged 檔。

## 版本（並行衝突對策）
- 每顆 commit 前 `./tools/version.sh <完整版號>`，**從 5.9.0 起**（跟 OCR-AB 的 5.8.14 序列錯開，避免撞）。若三檔漂移/版本已佔 → 用更高完整版號，commit 標清楚。

## 鐵律（GOV-BRIEF）
- 一顆一 commit：先 harness（PRE 紅負控制）→ 動工 → `node --check`＋OCR 既有 harness＋`vite build` → 審查 → commit。
- 429 退避：審查並行易撞 glm 8req/min，起審前 sleep≥60s。

## 交付
- E′ 一顆、F′ 一顆，各 commit + harness。
- 回報：各 commit hash、審查輪數人次、驗證 N/N、E′ CSP 是否過關／F′ PDF 有無實錘。
- 用繁體中文。