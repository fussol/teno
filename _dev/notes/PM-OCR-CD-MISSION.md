# PM-OCR-CD 任務書 — OCR 優化 C（黑灰 override）+ D′（入庫自動填欄位）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`、**`_dev/notes/OCR-OPTIMIZE-plan.md`**（完整計劃書 v1.1，你的範圍=C 段 + D′ 段）。工作目錄 `~/teno`，branch main。基線 HEAD=`$(git rev-parse HEAD)`（讀檔時現值，約 v5.9.1+）。

## 任務性質
執行 OCR 優化計劃書的 **C 段（黑灰名單重疊字可強制加入 override）+ D′ 段（入庫自動填滿欄位）**，兩顆獨立 commit（C 一顆、D′ 一顆）。

## 範圍（動 store.js — 這是共享檔，BH-FIX 首相已釋放）
- **`src/lib/store.js`**（此檔務必謹慎，BH-FIX 剛離開）：
  - C：`importOcrText` / `importWords` 加 `options.override`（兩層都傳，避免半路被吃回）
  - D′：`enrichOcrWords` 加 overwrite＋多 sense 合併＋await 同步（UI 看到填好的卡）
- `src/pages/ocr.js`（C：候選 badge 🔒黑/灰名單 + checkbox 強制加入；D′：入庫後等待 enrich 完成再 render）
- `tools/verify-ocr2-override.mjs`、`tools/verify-ocr2-enrich.mjs`（新增 harness）
- `_dev/notes/`（subagent-log/）

## 關鍵技術裁示（plan 對應段，動工前必讀）
1. **C 的雙層 override 漏傳風險（plan C.6 高風險）**：`importOcrText` 加 override，**必須同步傳到 `importWords`**（:1362 那層），否則字被第二道擋、bug 半解。harness 負控制要專門測 importWords 層。
2. **override 是一次性授權**：不永久改黑名單/灰名單（plan C.4 §4）。
3. **D′ 的 fire-and-forget 問題（plan D′.1）**：改 await enrich 完成＋多 sense 合併＋UI 同步，讓使用者看到填好的卡不是空白。
4. **未勾選淘汰字→灰名單**：scan 模式現有邏輯（ocr.js:458-462）不能因 C 而壞，保留。

## 禁區（跟並行首相協調）
- **CRITICAL：BH-FIX 首相剛 commit 完 store.js（BH-01~04）**。動工前先 `git status` 確認 store.js working tree 乾淨（BH-FIX 已全 commit）再碰。若 spot 有未 commit 殘留 → **不要覆蓋**，回報總統。
- 不碰 `src-tauri/`（SR2-CONT）、不碰 A/B′/E′/F′（別的首相）。
- **禁 `git add -A`**；commit 前完整 `git status` 揪別人 staged（ALIGN 教訓）。

## 版本（並行衝突對策）
- 每顆 commit 前 `./tools/version.sh <完整版號>`，**從 5.9.2 起**（接 + 錯開）。若三檔漂移 → 用更高完整版號。

## 鐵律（GOV-BRIEF）
- 一顆一 commit：先 harness（PRE 紅負控制）→ 動工 → `node --check`＋OCR 既有 harness＋`vite build` → 審查 → commit。
- **store.js 是共享核心 → 一律 3 席審查，不可降席**。
- C/D′ 是你（使用者）實際需求的關鍵（override 控制權 + 自動填欄位）→ 別跳審查。
- 429 退避：審查盡量串行，起審前 sleep≥60s。

## 交付
- C 一顆、D′ 一顆，各 commit + harness。
- 回報：各 commit hash、審查輪數人次、驗證 N/N、override 雙層有沒有確實過 harness。
- 用繁體中文。