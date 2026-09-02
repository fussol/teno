# PM-OCR-B-RESUME 任務書 — 收尾 B′ 切割兩態（code 已寫，補 harness/驗證/commit）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律，含【2026-08-30 審查 1 席限時協議】）、`_dev/notes/OCR-OPTIMIZE-plan.md`（B′ 段）。工作目錄 `~/teno`，branch main。**基線 HEAD=`f58c236`（v5.9.5，A 顆已 commit）**。

## 任務性質
**續跑收尾**。前一位 OCR-AB 首相做完了 B′（切割兩態）的**全部 code，但因 iteration budget 被截斷來不及寫 harness/驗證/commit**。你的工作：
1. 覆核已寫的 B′ code（已在 working tree，未 commit）
2. 補 `tools/verify-ocr2-crop.mjs`（plan B′.5 要求 + 負控制）
3. 驗證（PRE/POST、node --check、vite build、OCR 既有 harness）
4. 審查（**審查 1 席** — GOV-BRIEF 限時協議，別開 3 席併行燒 API）
5. commit（一顆，版本升 5.9.6）

## 已存在、未 commit 的 B′ 產出（不要重寫，覆核即可）
- `src/pages/ocr.js`（含 B′ 切割兩態：`_cropMode preview/cutting`、四角 handle、polygon、切割按鈕 ocrCutStartBtn、preview 態不綁事件）
- `src/lib/ocr/crop.js`（untracked 新檔：`cornersToRect / defaultCorners / moveCorner / untangleCorners` 純函式）
- **缺** `tools/verify-ocr2-crop.mjs` → 你要寫

## 關鍵裁示（plan B′ 段）
1. **preview 態純瀏覽可滑動**（不綁切割 pointer、touch-action 可捲動）→ 解「進 OCR 頁影響下滑」
2. **切割按鈕→進入 cutting 態**，拖四角 handle 成型，完成/取消回 preview
3. crop.js 純函式要能單獨 harness（plan B′.5 負控制：`_cropMode` 預設改回 cutting→鎖 scroll→重現影響滑動）

## 禁區（跟並行首相協調）
- **絕不碰 `src/lib/store.js`** — OCR-CD 首相正在改（D′），store.js 現在是髒的、屬 OCR-CD。你的 B′ 不需要碰 store.js。
- 不碰 `src-tauri/`、不碰 A/E′/F′/C/D′ 其他段。
- **禁 `git add -A`**；commit 前完整 `git status` 揪別人 staged。只 add：`src/pages/ocr.js`、`src/lib/ocr/crop.js`、`tools/verify-ocr2-crop.mjs`（+ 如需 version 三檔）。

## 版本
- commit 前 `./tools/version.sh 5.9.6`（若被佔則用 5.9.7+，commit 標清楚）。

## 鐵律
- 一顆一 commit：harness（PRE 紅負控制）→ 驗證 → **審查 1 席**（GOV-BRIEF 限時協議）→ commit → md log 落 `_dev/notes/subagent-log/`。
- 429 退避：sleep≥60s 前先 PRE 實跑。
- 審查 1 席委要唯讀＋負控制重跑。

## 交付
- 回報：code 覆核結果、harness N/N、審查 1 席結果、commit hash、版本。
- 用繁體中文。
- **誠實**：若發現 B′ code 有未完成的洞（例如 crop.js 有函式沒用到/切割事件沒接好），直接補完別硬 commit。