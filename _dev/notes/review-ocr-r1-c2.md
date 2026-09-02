# OCR 計畫書審查 — 委員#2（波及風險與窮舉消費者）

- 審查對象：`_dev/notes/OCR-plan.md`（v1.0，三階段合成稿）
- 審查日期：2026-08-28
- 審查方式：唯讀 grep 窮舉消費者，未動任何 src/ 代碼
- 判定：**❌ 需修訂後複審**（4 項大缺失 + 3 項計畫書內部矛盾）

---

## 總判定

| # | 審查面向 | 判定 |
|---|---------|------|
| 1 | 波及風險章節 vs 實際消費者清單 | ❌ 覆蓋率過低（見 L1–L4） |
| 2 | capabilities 權限 / Android permissions | ❌ 加錯權限 + 無視 build 前提 + Android 端全漏 |
| 3 | OCR 入庫路徑與 import.js/browser.js 一致性 | ❌ 計畫書內三處路徑互相矛盾（L5） |
| 4 | APK 體積/記憶體/模型檔放置 | ❌ 量級大致合理但 CSP 硬阻擋、放置位置未定（L7–L8） |

---

## 任務1：函式/檔案消費者窮舉 vs 計畫書「波及風險」章節

計畫書第4章「波及風險評估」**只宣稱了 tools.js DOM ID 隔離一項**，第6章各檔案僅附一句「無影響/可回退」。以下為 grep 窮舉結果與缺口。

### L1（严重）第6章檔案清單**漏了 tools.js 本體**
- 第4章花整章寫 HTML 插入與互動狀態機（要改 `src/pages/tools.js` 的 `render()` 與 `onMount()`），但第6章「逐檔案修改清單」只有：`api.js`、`store.js`、`capabilities/default.json`。`tools.js` 完全不在清單 → 誰綁定 `#ocrCaptureBtn`/`#ocrConfirmBtn` 事件、OCR worker 呼叫鏈由谁觸發，無檔案歸屬。
- 證據：`src/pages/tools.js:5 export function render(s)`、`:237 export function onMount(s)`、`:987 document.querySelectorAll('button[onclick]').forEach(...)`（onMount 尾端的 onclick 轉換迴圈存在，OCR 按鈕採 id+addEventListener 不受其影響 ✅ 此點計畫書宣稱屬實）。

### L2 `store.addWord` 全部消費者（計畫書未列）
grep `addWord`：
- `src/pages/browser.js:909`（手動新增，前有 `:899` 空字檢查、`:907` 重複比對→合併 modal）
- `src/pages/deck-browser.js:566`（**計畫書通篇未提此消費點**）
- `src/lib/store.js:1180`（本體）
計畫書第4章卻寫「呼叫 `s.actions.addWord(...)` 批次寫入」— addWord **本身無任何去重**（見 L5）。

### L3 `db.saveWord` / `saveWordsInTx` 全部消費者（計畫書未列）
grep：
- `saveWord`：store.js `:786`(leech tag)、`:928`(undo)、`:1201`(addWord)、`:1272`(importWords)、`:1290`(editWord)、`:1533`(updateDeck)、`:1584`(mergeDeck)
- `saveWordsInTx`：store.js `:1324`(removeTagFromAll)、`:1371`(updateTag)、`:1398`(deleteTag)；db.js `:205` 本體
計畫書第5章提「批次呼叫 `db.saveWordsInTx(words)`」作為選項 — **直接呼叫會繞過 `state.words.push` / `refreshDerived()` / `notify()`**（對照 store.js:1259-1266, 1202-1203），造成 UI 與 DB 分裂、派生統計過期。且 `nextWordId()`（store.js:26，timestamp+random，非序列）在 store 層外產生 ID 的寫法未定義。

### L4 `lib.rs` command：計畫書**加了前端橋卻無 Rust 端檔案項**
- api.js 新增 `recognizeImage → invoke('recognize_image')`，但 `src-tauri/src/lib.rs:1797` `generate_handler![...]` 完整清單（log_msg…drive_logout，共 40+ 條）**無 `recognize_image`**；`grep recognize src-tauri/` 零命中。P1 若任何代碼誤觸此橋，run-time 直接 "command not found"。
- 另有 `icon_android.rs:27/53/82`、`drive_sync.rs`、`tts_android.rs` 等 Android 專屬 command 模組 — 計畫書未說明 P2 原生 OCR 要併入哪個模組（建議比照 tts_android.rs 開 ocr_android.rs），第6章無 lib.rs/.rs 檔案項。

### 附：tools.js 錨點驗證 ✅
第4章宣稱的插入錨點存在且與原文一致：`tools.js:190 <!-- Generate Forms -->`、`:202 <!-- Cambridge Dictionary -->`。錨點本身可用。
小瑕疵：`icon('camera')` — `src/lib/svg.js:94 icons` 表**無 camera 鍵**（grep camera 僅命中 words.txt），`icon()` 對未知名稱回傳空字串（svg.js:177-180）→ 按鈕無圖示、silent fail。計畫書需加 svg.js 修改項（`icon('check')` 存在 ✅）。

---

## 任務2：capabilities / Android permissions

### L6（严重）`fs:default` + `fs:allow-read-file` 加不出來 — Cargo 無 fs 插件
- `src-tauri/Cargo.toml`（grep plugin）：僅 log、sql、dialog、opener（+fsrs crate）。**無 `tauri-plugin-fs`**。Tauri v2 capability 引未註冊插件的權限 → **編譯期直接報 permission not found**，P1 開工即 build fail。計畫書第6章未列 Cargo.toml 依賴 + lib.rs `.plugin(tauri_plugin_fs::init())`。
- 更根本的問題：**此權限根本不需要**。計畫書自己的 fallback 代碼（第4章）是 `<input type=file>` +（FileReader/blob → tesseract.js 吃 File/base64），全程走 WebView 檔案挑選器，不經過 Tauri fs。加 `fs:allow-read-file` 是無謂擴大 WebView 側檔案讀取面（桌面端可讀使用者任意檔案路径，且 default.json `windows:["main"]` 桌面/Android 共用同一份）。**建議：刪除 fs 權限項；若 P2 原生回傳圖片路徑再論，且必須帶 scope**。

### Android 端 permissions：計畫書全漏
- `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 現況僅 INTERNET、WRITE_EXTERNAL_STORAGE(≤28)、MANAGE_EXTERNAL_STORAGE；**無 CAMERA、無 camera uses-feature**。計畫書通篇未提 AndroidManifest。
  - 若 P2 走 `<input capture>`（系統相機 Intent）：不需要 CAMERA 權限，計畫書可明文此點以免實作者亂加；
  - 若 P2 走 ML Kit + 自建取像（P2 交付物「相機辨識」明確要做）：`build.gradle.kts` 需加 ML Kit 依賴（現僅 webkit/appcompat/material/lifecycle，`grep implementation` 4 條全列）＋依取像方式評估 `<uses-permission android:name="android.permission.CAMERA">` 與 `<uses-feature camera required=false>`（required=true 會被 Play 過濾無相機裝置）。計畫書第6章無 gradle/manifest 檔案項 → P2 清單不完整。
  - 現況已有 MANAGE_EXTERNAL_STORAGE（既有安全面大洞，非本計畫引入，但再加 fs:allow-read-file 是疊加面，審查建議 OCR 完全不用它）。
- 正面確認：capabilities 目錄僅 `default.json` 一份，改它即全覆蓋，無多餘 capability 檔 ✅；`FileProvider` 已在 manifest（:268）供相機拍照落檔 ✅（計畫書未引用，可補）。

---

## 任務3：入庫路徑一致性（髒資料風險）

### L5（严重）計畫書內部三處入庫路徑互相矛盾
1. 第4章狀態機 confirm 態：「呼叫 `s.actions.addWord(...)` 批次寫入」→ **addWord 無去重**（store.js:1180-1205 直接 push+saveWord），瀏覽器端手動新增是靠呼叫端 browser.js:907 自己查重複才有保護。OCR 若照第4章直接批次 addWord → **重複單字直接入庫**（同一張圖多次辨識、跨圖重複皆中）。
2. 第5章：建議 `importWords`（有去重 `:1216/:1229`、空字跳過 `:1228`、自動建 Deck `:1233-1237`、單交易 `:1270-1277`）✅ 與 import.js:550 批量路徑完全等價。
3. 第5章又同時提「或批次呼叫 `db.saveWordsInTx(words)`」→ 繞 state（見 L3）。
**裁定：第4/5章必須統一為 importWords（經 importOcrText 包裝），刪除 addWord/saveWordsInTx 直連字樣。**

### 校驗等價性明細
| 校驗 | browser.js 手動 | import.js 批量 | OCR 經 importOcrText→importWords |
|---|---|---|---|
| 空字擋 | :899 toast | store :1228 skip | ✅ 同 import.js |
| lower+trim | :900 | :1227 | ✅ |
| 重複→提示/略過 | :907 合併 modal | :1229 靜默略過 | ✅ 靜默略過（可接受，UI 會顯示 skipped） |
| 字元/詞形合法性 | ❌無 | ❌無 | ❌無 — **OCR 專有垃圾 token（`1n`、`re;`、含數字/標點）三條路都不擋**。計畫書第5章只說 toLowerCase/trim，未定義 tokenizer 過濾規則 → 建議明確定義白名單（如 `/^[a-z][a-z'-]*$/`）＋長度上限，否則 OCR 必產髒資料（此為新增需求，非既有不等價）。 |

### 附帶發現（既有 bug，OCR 放大其影響）
- store.js:1270-1277：importWords 交易失敗時 ROLLBACK 後僅 `console.warn`，**仍回傳已累計的 added 數** → OCR 動輒數十詞、失敗機率比 import.js 高（大 blob 期間 DB busy），使用者看到「已新增 N」但實際 0 入庫、重啟後消失。計畫書驗證計畫未測「辨識成功+DB 寫入失敗」分支。
- `importOcrText` 用 `this.importWords`（物件方法呼叫）— 僅在 `s.actions.importOcrText(...)` 形式呼叫時 `this` 正確；若被解構傳遞（`const { importOcrText } = s.actions`）即炸。計畫書未註明呼叫慣例。

---

## 任務4：APK 體積 / 記憶體 / 模型檔放置

### 量級評估：大致合理
- 現況 APK（universal，雙 ABI，內含 onnxruntime 等）：`app-universal-release-signed.apk` = **83.3MB**。Tesseract.js 增量 ~5-15MB（tesseract-core-simd.wasm ~4-5MB + eng.traineddata.gz ~4MB 級）→ +6~18%，與計畫書矩陣「中等」一致；ML Kit 走 unbundled 時 APK 增量≈0 亦屬實。記憶體峰值 100-200MB 為「估計，待驗證」，計畫書已自我標註，可接受但 P1 驗收標準（第8章只驗「3 秒內入庫」）應加裝記憶體峰值量測。

### L7（严重）CSP 會硬擋 tesseract.js，計畫書未提
`src-tauri/tauri.conf.json:27`：
```
script-src 'self' 'unsafe-inline'   ← 無 wasm-unsafe-eval → WASM 實例化被拒
connect-src 'self' localhost:11434 dictionaryapi tatoeba ← CDN 全擋
```
- tesseract.js 預設從 cdn.jsdelivr.net 拉 worker/core/wasm → connect/script-src 擋死（違背計畫書「完全離線」宣稱的同时也無法 run）。
- 即便改本地打包，**WASM 執行仍需 `script-src 'wasm-unsafe-eval'`**，現 CSP 沒有 → 桌面 WebKitGTK 與 Android WebView 皆掛。計畫書第6章無 tauri.conf.json 檔案項。

### L8 模型檔放置：計畫書未指定，且打包工具鏈缺項
- 離線要求 ⇒ `eng.traineddata(.gz)`、`tesseract-core-simd.wasm`、worker js 必須进 bundle（`public/` 或 assets，由 `workerPath/corePath/langPath` 指本地），計畫書未寫 → 依預設行為會變 CDN 依賴（離線宣稱破產 + 首載失敗於離網環境）。
- `package.json` 無 tesseract.js 依賴，第6章無 package.json 項；`vite.config.js` 現有 `exclude: ['onnxruntime-web', '@huggingface/transformers']`（:16）處理先例 — tesseract.js 的 worker/wasm 是否需類似 exclude/assetsInclude 處理未評估（onnxruntime 的先例證明此坑真實存在）。

---

## 遺漏清單（彙整，可直接開工單）

| # | 等級 | 項目 | 證據 |
|---|------|------|------|
| L1 | 严重 | 第6章檔案清單漏 tools.js（render+onMount 都要改） | tools.js:5,237,987 |
| L2 | 严重 | fs 權限：Cargo 無 tauri-plugin-fs（build fail）且 input+FileReader 路線根本不需要；fs:allow-read-file 無谓擴大讀檔面 | Cargo.toml:25-37；計畫書第4章 fallback 代碼 |
| L3 | 严重 | api.js `recognize_image` 橋對齊無 Rust command；lib.rs/ocr_android.rs 無檔案項 | lib.rs:1797 generate_handler 全清單 |
| L4 | 严重 | 入庫路徑三處矛盾（addWord 批次＝無去重直連）；定稿應唯一化 importWords | store.js:1180 vs :1216/1229；計畫書第4/5章 |
| L5 | 严重 | CSP 缺 `wasm-unsafe-eval`、connect-src 擋本地下載以外的全部來源；tauri.conf.json 不在修改清單 | tauri.conf.json:27 |
| L6 | 中 | Android：AndroidManifest 無 CAMERA/camera-feature、gradle 無 ML Kit 依賴，第6章無 P2 安卓檔案項（input capture 免權限此點也應明文） | AndroidManifest.xml:3-5；build.gradle.kts:79-83 |
| L7 | 中 | package.json（tesseract.js）、vite.config.js（wasm/worker 打包）不在修改清單；模型檔放置位置未定 | package.json:18-26；vite.config.js:16 |
| L8 | 中 | OCR 垃圾 token 無過濾規則定義（三條入庫路徑皆不驗字元集） | store.js:1227-1229；browser.js:899-907 |
| L9 | 輕 | `icon('camera')` 不存在 → silent 空圖示；需列 svg.js 修改項 | svg.js:94-176 無 camera 鍵 |
| L10 | 輕 | importWords 交易失敗仍回報 added（OCR 大批量放大）；驗證計畫缺「辨識成功但 DB 寫入失敗」負控制 | store.js:1270-1277 |
| L11 | 輕 | 波及風險章節未涵蓋 deck-browser.js:566 addWord 消費點、refreshDerived 批次成本、「OCR Inbox」新 Deck 對清單/統計頁的呈現 | deck-browser.js:566 |

## 正面確認（計畫書做對的部分）
- tools.js 插入錨點（Generate Forms / Cambridge 之間）與現行代碼逐字相符。
- 獨立 DOM ID + addEventListener 符合 tools.js 慣例，不與 :987 onclick 自動轉換迴圈衝突。
- `store.importWords` 作為 OCR 批量入庫主入口的判斷正確（去重/建 Deck/單交易三利真成立），importOcrText 薄包裝方向可接受。
- 「不直接改 addWord/db 底層」的最低侵入原則正確 — 問題只在第4/5章文字又留了 addWord/saveWordsInTx 直連的口子。
- APK/記憶體增量量級與現況 83.3MB APK 對照合理；範圍外（雲端 API、直播串流）切割清楚。

## 複審放行條件
1. 第6章補齊：tools.js、svg.js、package.json、vite.config.js、tauri.conf.json(CSP)、lib.rs（+ Cargo.toml 若保留任何插件）、P2 的 gradle/manifest 項。
2. 刪除 fs 權限項（或補 Cargo 依賴+init+scope 的完整三件套與必要性論證）。
3. 入庫路徑唯一化 importWords；定義 OCR token 白名單規則與長度上限；補「DB 寫入失敗」負控制測試。
4. P1 驗收加 WASM 內存量測與離網啟動首次辨識測試。
