# PM-BUGHUNT 任務書 — App Bug 獵人（純調查＋撰寫待修清單，不動 code）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`。工作目錄 `~/teno`，branch main。

## 任務性質
這是**調查＋清單寫作任務**：你在整個 Teno 程式碼庫掃描，找出**尚未被登記**的 app bug，產出 `/home/jupiter/teno/_dev/notes/BUGHUNT-TODO.md`（待修 bug 清單）。**不 commit code、不改 source**。清單落盤等總統審核後併入主清單（scope-requests.md，由總統操作，你不要碰那個檔）。

## 你的目標
不是修 bug，是**找 bug ＋ 寫清楚待修清單**。讓總統一審核就能直接派單。每個 bug 要可被他人重現、有明確檔案:行號實錘。

## 掃描範圍（先讀現況再找，不要憑印象）
- `src/`（前端核心）：pages/、lib/、layout/ —— 看 UI 邏輯、狀態管理、資料流。
- `src-tauri/src/`（Rust 後端）：api、db、ocr、tts、module 處理。
- `tools/`（CLI / harness / 腳本）。
- 已知重點（務必實錘行號）：
  - `src/lib/api.js`、`src/lib/db.js`、`src/lib/store.js`、`src/lib/ocr-blacklist.js`
  - `src/pages/*.js`（每個頁面的 mount / render / 事件綁定）
  - `src-tauri/src/*.rs`
  - `tools/cli.mjs`

## 找什麼（常見 bug 型態）
1. **資料 / 狀態 bug**：錯的初始化、未復原的 UI 狀態、切換頁面後殘留、localStorage/SQLite 讀寫不一致、null/undefined 沒防。
2. **邏輯 bug**：錯誤比較、off-by-one、錯誤的 filter、死程式碼分支、race condition。
3. **UI/UX bug**：點擊無回應、欄位沒驗證、畫面錯位、icon/文字錯誤、空狀態沒處理。
4. **後端/Rust bug**：unwrap 會 panic 的地方、未處理錯誤、資源未釋放（TTS/相機）、權限檢查漏洞。
5. **跨平台 bug**：手機（Android WebKitGTK）/桌面行為差異、blob: vs data: URL、touch 事件。
6. **死檔/遺留**：零引用的 deprecated 模組、死 import、殘留 debug 程式碼。

## 不要報告什麼（已知道 / 不屬 bug）
- `src/lib/deprecated/` 內「已標示 deprecated」的（可能仍是死檔，但有已知性，可列但標「已知」）。
- 已修過/已登記的（對照 scope-requests.md 內容，避免重複；scope-requests.md 你可以**讀**，只是不能寫）。
- 純 styling 喜好、未定規格的 UX 改進（那屬 OCR2 計劃書議題）。

## 提交格式（BUGHUNT-TODO.md）
用表格＋詳細 section，每個 bug 一個 entry：
```
| ID | 檔:行號 | Bug 描述（一句） | 影響 | 型態 | 建議 |
| BH-01 | src/pages/xxx.js:120 | ... | 手機端崩潰 | 邏輯bug | 修... |
```
每個 entry 後附詳細說明：**重現步驟 → 現況碼片段（讀取實際行號內容）→ root cause 分析 → 影響範圍 → 建議修法 → 驗證方式**。

## 交付
- `_dev/notes/BUGHUNT-TODO.md`（完整待修清單，可直接派單）。
- 回報：找到幾個新 bug、每個的 ID + 檔:行號 + 一句描述、哪些列為高優先。
- 用繁體中文。
- 不動 code、不 commit source 改動。清單落盤即可（不需 commit，總統統一處理）。