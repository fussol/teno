# PM-OCR-F 任務書 — F′ 匯入來源擴充（多圖 / PDF / 文字檔）

## 身份
你是 Teno 離線波次首相 **OCR-F**（F′ 匯入擴充專員）。以繁體中文回報。

## 目標（單一）
實作 OCR-OPTIMIZE-plan §F′：匯入來源擴充。規格以 `_dev/notes/OCR-OPTIMIZE-plan.md` §F′ 為準，先讀它。

## 現況（重要 — 不從零開始）
- harness 已寫好：`tools/verify-ocr2-importfile.mjs`（F0 靜態釘 + F1 extractTextTokens 純函式 + F2 classifyImportFile + F3 負控制 A 等）。**先讀 harness 了解驗收契約，再寫 code。**
- code 完全未寫：`src/pages/ocr.js` 目前無 multiple/webkitdirectory/importFiles —— F0 釘會翻紅，這是預期。
- 規格摘要：
  - 匯入 input 改多檔（`accept` 涵蓋 image/* + .txt/.md/.csv/.srt + .pdf，`multiple`）
  - 文字檔分流：純函式 `extractTextTokens` 抽 token（去重、去 noise：數字/標點/網址/超長）→ 直接走 `s.actions.importOcrText` 快速通道，**不經 OCR 引擎**
  - `classifyImportFile` 純函式：text/image/pdf 三分流
  - PDF：逐頁 render（如環境不許可，列為後續項並在 harness 釘註明，不硬做）
  - 按鈕文案改「匯入檔案」
  - 純函式放 `src/lib/ocr/` 下新檔（模組化，參考 crop.js 模式），DOM 層留在 ocr.js

## 檔案所有權（嚴格）
- 只可改：`src/pages/ocr.js`、`src/lib/ocr/`（新檔）、`tools/verify-ocr2-importfile.mjs`
- **禁碰**：`src/store.js`、`src-tauri/`、任何 english.rs、任何 verify-e16*
- 已 commit 的 B′ 切割（10c6018）在 ocr.js —— 不得破壞其 harness：`node tools/verify-ocr2-crop.mjs` 必須仍 ALL PASS

## 驗證門（法典：靜態→雙態→browser 實跑→證據落 subagent-log）
1. `node tools/verify-ocr2-importfile.mjs` ALL PASS（含負控制）
2. `node tools/verify-ocr2-crop.mjs` 仍 ALL PASS（不回歸）
3. vite 起本地 + browser 實跑：匯入 input DOM 多檔屬性、按鈕文案、文字檔分流路徑（js 注入測試可）
4. 證據寫入 `_dev/notes/subagent-log/<日期>-OCR-F.md`

## 審查（限時協議：1 席）
- 驗證全過後派 1 席審查（delegate_task 或 hermes chat）：唯讀、獨立重跑 harness、檢查純函式邊界
- 審查 FAIL → 修 → 再審；>2 輪同類 edge 退 → 停下寫報告，不硬 commit

## Commit（git 分離鐵律）
- 只 add 你的檔案（明確列檔名，**禁 git add -A / add .**）
- 版本：`./tools/version.sh 5.9.8`（指定號，避免與並行首相搶號）
- commit 訊息格式照 `git log --oneline -5` 既有風格，註明 (5.9.8)

## 收工
commit 後：`git log --oneline -1` + harness 輸出 tail 貼進最終回報。
