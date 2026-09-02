# PM-RENDER 任務書 — 學習卡片間歇性渲染不出來（root cause 調查，動 code 待確認後）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`、`_dev/notes/USER-BUG-LEARN-RENDER.md`（此 bug 的完整調查書）。工作目錄 `~/teno`，branch main。

## 任務性質
調查 + 修復的深度調查任務。使用者回報：學習時卡片**間歇性（有時候）**渲染不出來，但字可反白選取、看不到。你要**重現 → 定位 root cause → 修復 → 驗證**。

## 核心線索（來自使用者，關鍵）
- 「**有時候**」＝間歇性，非 100% ⚠️ → 排除固定 CSS 錯誤（文字色=背景色會每次漆黑）。
- 「字能反白」＝元素在 DOM、有 glyph 佈局 → **有 layout，但沒 paint（compositing/paint 層沒刷新）**。
- 特徵最像：**WebKitGTK/WebView 合成層偶發不刷新**，或**載入競態/動畫卡 opacity**。

## 調查步驟（照 USER-BUG-LEARN-RENDER.md，先讀 study*.js、exam*.js、css、字體載入）
1. **重現**：dev server (localhost:5173) 跑學習 — 連續快速切換卡片、縮放、resize 視窗、結束再進。記錄觸發條件。
2. **定位**：若能重現，檢查卡片 computed style（`color`/`opacity`/`visibility`/`transform`）＋是否字體未載入（選取那片字，DevTools 看 computed font-family 是否 fallback）。用 `document.elementFromPoint` 確認元素存在。
3. **判斷層**：
   - 若文字色=背景色（但為何間歇？）→ 看 theme 切換/變數載入時序。
   - 若動畫卡 opacity → 看 study/exam 的 transition/結束狀態復原。
   - 若是合成層 → 看卡片是否被強迫成獨立 paint layer（`will-change`、`transform: translateZ`、`backface-visibility`），或 GPU 合成在低記憶時被棄。
   - 手機 (SM-A5560) 才出現 → WebView compositing。
4. **修復**：最小幅、針對性地修（補 `force repaint`、移除錯誤的 opacity/visibility、修正字體 fallback、確保重繪觸發）。**不要大重構**。
5. **驗證**：反覆操作確認不再間歇性消失。desktop + 手機（若可連）。

## 紅線
- 不動 OCR、不動 FSRS、不動資料庫 schema。
- 若 root cause 在既存 study/exam 框架複雜處，先報告、談修法再動，或在 commit 前講清楚改動。
- 只排間歇性渲染這一個 bug，不要順手修別的。

## 交付
- root cause 分析（寫進/更新 USER-BUG-LEARN-RENDER.md）。
- 修復 commit（若需）。
- 回報：觸發條件、root cause、修了哪、驗證結果。
- 用繁體中文。