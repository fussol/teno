# PM-F13-E16 任務書 — F13-SR2 english.rs 收尾 ＋ E16-SR2 測試釘

## 身份
你是 Teno 離線波次首相 **F13-E16**（兩顆小收尾，連續做，各自獨立 commit）。以繁體中文回報。

## 目標 A：F13-SR2 english.rs（先做）
- 規格：`_dev/notes/F13-SR2-fix-plan.md`（先讀）
- 現況：`src-tauri/cambridge_scraper/src/english.rs` 有前首相留下的 **151 行未 commit 改動**（+127/-24）。URL 層（F13-SR1）已在 773cb5c commit；`.entry-body` 新模板選擇器 = 本體。
- 動作：覆核 diff（git diff 該檔）→ 確認與 fix-plan 一致 → cargo build/test 驗證（cambridge_scraper crate）→ 若有既有測試就跑過 → 補靜態釘 harness（如 fix-plan 有定義）→ 審查 1 席 → commit
- 版本：`./tools/version.sh 5.9.9`，commit 註明 (5.9.9)

## 目標 B：E16-SR2 verify-e16 測試釘（後做）
- 規格：`_dev/notes/E16-fix-plan.md` 的 E16-SR2 段（先讀）
- 現況：E16-SR1 已修（orphan 刪除已落地）。`tools/verify-e16-orphan-deletion.mjs` 的 **T5a 釘「sim-behavior 本波必須仍在」** —— 但 sim-behavior 已刪，這釘註定翻紅。這是測試工具的釘沒更新，非 product bug。
- 動作：改 T5a 釘為「已刪」態（負向釘：確認已不存在）→ 跑 `node tools/verify-e16-orphan-deletion.mjs` ALL PASS → commit
- 版本：`./tools/version.sh 5.9.10`，commit 註明 (5.9.10)

## 檔案所有權（嚴格）
- 目標 A 只可改：`src-tauri/cambridge_scraper/src/english.rs`（+ 新 harness 檔在 tools/）
- 目標 B 只可改：`tools/verify-e16-orphan-deletion.mjs`
- **禁碰**：`src/pages/ocr.js`、`src/lib/ocr/`、`src/store.js`、`tools/verify-ocr2-*`（並行首相 OCR-F 在用）

## 驗證門
- A：cargo build + cargo test（該 crate）；harness（如有）ALL PASS
- B：verify-e16-orphan-deletion.mjs ALL PASS
- 證據落 `_dev/notes/subagent-log/<日期>-F13-E16.md`

## 審查（限時協議：1 席）
- 兩顆各自審 1 席：唯讀、獨立重跑
- FAIL → 修 → 再審；>2 輪退 → 停下寫報告

## Commit（git 分離鐵律）
- 一 bug 一 commit：A、B 分開兩個 commit
- 只 add 明確檔名，**禁 git add -A**
- 版本用 version.sh 指定號（5.9.9 / 5.9.10），不搶號

## 收工
兩 commit 都落後回報：`git log --oneline -2` + 兩 harness 輸出 tail。
