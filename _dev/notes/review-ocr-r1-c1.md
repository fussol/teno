# OCR 計畫書審查報告 — 委員 #1（修法正確性）

- 審查對象：`_dev/notes/OCR-plan.md`（v1.0，427 行）
- 審查方式：逐字元 diff 比對實碼 + `node --check` / `python3 json` 語法校验（全部實際執行，非目測）
- 審查基準：行級可貼、原文錨點一字不差、可貼代碼語法正確、偽代碼須標明、窮舉消費者
- **總判定：❌（5 Major / 6 Minor）— 不可原樣照貼，需修訂後覆審**

---

## 一、原文錨點逐字元比對結果

### ✅ PASS-A1：ch4-5「修改前原文前後錨點」（Generate Forms → Cambridge）
- 計畫書 L174-190 vs `src/pages/tools.js:190-204`：**逐位元組完全一致**（diff 空輸出，含 `${icon('sparkle')}`、`onclick="window.__genFormsLLM()"`、`id="formsResult"`）。
- ch4-5「完整插入代碼」（L196-235）的 Generate Forms 段與 Cambridge 區塊頭亦與實碼 190-200 / 202-204 逐字元相同 → 掛載點宣稱（Generate Forms 後、Cambridge 前）**位置正確、錨點真實**。

### ✅ PASS-A2：ch6-1 api.js 錨點（結尾 FSRS 段）
- 計畫書 L304-307 vs `src/lib/api.js:138-141`：**文字內容一字不差**（含 `─── 官方 FSRS 模擬器 (fsrs-rs 6.6.1, 對齊 Anki 26.08) ───` 全形框線字元、`invoke('simulate_fsrs', { req })`）。
- 唯一差異：計畫書在 Markdown 清單內縮排 +2 空格（見 m1）。

### ⚠️ PASS-A3（附註）：ch6-2 store.js 錨點（importWords 結尾）
- 計畫書 L322-327 vs `src/lib/store.js:1280-1285`：文字內容一致（`return { added, skipped, decksCreated };` / `/** Edit a word */`），但縮排 +2（見 m1）。

### ⚠️ PASS-A4（附註）：ch6-3 capabilities 錨點
- 計畫書 L352-364 vs `src-tauri/capabilities/default.json:5-17`：**JSON 語義完全相同**（11 項權限逐一相符），但每行縮排 +2（見 m1）。

### ❌ FAIL-A5：ch4-1 `#issuesResult` 引用非逐字
- 計畫書 L95 引 `src/pages/tools.js`：`<div class=\"section\"><div class=\"section-title\">${icon('search')} 尋找重複</div>`。
- 實碼 `tools.js:93-94` 是**兩行**（`<div class="section">` ↵ `      <div class="section-title">…`），計畫書壓成一字串；且該引用標稱 `#issuesResult` 卻**不含** `issuesResult`（實碼在 `tools.js:97`）。→ 見 m2。

### ✅ PASS-A6：ch4-1 其餘結構引用
- `<div class="card card-interactive" id="toolsGoSimulator" style="cursor:pointer">` ≡ `tools.js:37` 逐字元一致。
- `<div class="section" id="bgTaskSection">` ≡ `tools.js:61` 逐字元一致。
- `document.querySelectorAll('button[onclick]').forEach(btn => { ... })` ≡ `tools.js:987-998`（省略號已標明，可接受）。

---

## 二、可貼代碼語法校验（全部實際跑過校验器）

| 計畫書區塊 | 校验方式 | 結果 |
|---|---|---|
| ch4-2 / ch4-5 HTML 骨架（含 `${icon(...)}` 模板插值） | 包進 template literal 後 `node --check` | ✅ 通過（須貼入 render(s) 模板字串內，計畫書 ch4-5 以 javascript fence 呈現，語境正確） |
| ch4-4 `handleOcrCapture()` | `node --check` | ✅ 語法通過（但見 M5/m5） |
| ch6-1 api.js export | 補 `invoke` stub 後 `node --check` | ✅ 語法通過（但見 M2） |
| ch6-2 `importOcrText` | 包 object literal 後 `node --check` | ✅ 僅在 actions 物件內可解析（片段非自足檔案，見 m6） |
| ch6-3 capabilities JSON（修訂前/後） | `python3 json.loads` | ✅ 皆為合法 JSON（片段，需取代原陣列；但見 M1） |

### API 簽名核對
| 計畫書引用 | 實碼 | 判定 |
|---|---|---|
| `addWord(wordData)`（ch5，含 `word.word.toLowerCase().trim()`） | `store.js:1180-1205`（1183 行 toLowerCase().trim()）| ✅ 一致（節錄以 `...` 標明，可接受） |
| `importWords(words, onProgress)` → `{added, skipped, decksCreated}` | `store.js:1214-1283`（1282 return） | ✅ 一致；`db.executeSQL('BEGIN TRANSACTION')` 宣稱 ≡ `store.js:1270`（`executeSQL` 定義於 `db.js:643`）✅ |
| `db.saveWordsInTx(words)`（ch5 全文節錄） | `db.js:205-215` | ✅ **逐字元一致**（含 ROLLBACK try/catch） |
| 重複比對 `existing.has(w)` 節錄 | `store.js:1216 / 1229` | ⚠️ 1216 逐字一致；1229 實際為 `if (existing.has(w)) { skipped++; if (onProgress) onProgress({...}); continue; }`，計畫書**未標省略即刪節 onProgress 呼叫** → m3 |
| `icon()` | `svg.js:177-181` | ✅ 存在；但 `icon('camera')` **不在 icons 表** → **M3** |
| `startBackgroundTask(id, label, total)` | `store.js:1153` | ✅ 存在；計畫書正文未誤用（僅 ch4 背景任務區塊描述引用） |
| `lookupCambridge`（ch8 P3） | `api.js:18` | ✅ 存在 |
| `this.importWords`（importOcrText 內） | actions 為物件字面衝（`store.js:548`），倉庫已有 `this.createDeck` 先例（`store.js:1235`） | ✅ 呼叫慣例一致（`s.actions.xxx(...)` 呼叫端 `import.js:550`、`deck-browser.js:566`） |

---

## 三、發現清單

### Major

**M1｜ch6-3 capabilities 貼上後建置必失敗：fs 外掛未安裝未註冊**
- 計畫書章節：第6章 §3。實碼證據：`src-tauri/Cargo.toml:26-36`（僅 log/sql/dialog/opener，**無 tauri-plugin-fs**）；`src-tauri/src/lib.rs:1770-1779`（plugin 註冊清單**無** `tauri_plugin_fs::init()`，invoke_handler `lib.rs:1782` 亦無）；`src-tauri/gen/schemas/{desktop,android,mobile,linux}-schema.json` 中 `fs:default`/`fs:allow-read-file` 出現次數 = **0**（即本專案建置中不存在這兩個權限識別符）。
- 後果：Tauri v2 建置時權限驗證找不到 fs 插件權限集 → **compile-time 失敗**。計畫書「回退方式」聲稱僅刪兩行還原，掩蓋了需同步新增 Cargo 依賴 + `lib.rs` 註冊的前置工序（檔案清單完全未列）。
- 修法：改為 (a) 列 out `tauri-plugin-fs` 依賴 + `lib.rs` init + 完整 schema 重生成步驟，或 (b) P1 走 `<input type=file>` + FileReader（純 WebView，零新權限），刪除本節。

**M2｜ch6-1 `recognize_image` 是幽靈命令：Rust 端不存在，且檔案清單未列 lib.rs**
- 計畫書章節：第6章 §1。證據：`src-tauri/src/` 全目錄 grep `recognize_image` = 0 筆；`lib.rs:1782` invoke_handler 清單無此命令。
- 後果：`invoke('recognize_image', …)` 一旦被呼叫必然 runtime 拋 "command not found"。計畫書自稱「預留橋樑」卻未列對應 Rust 命令的修改項（第6章只列 3 個檔案），違反「窮舉消費者」。且與 ch1/ch3 電腦端結論矛盾：電腦端走 Tesseract.js（純前端 Worker），**根本不需要此 IPC**。
- 修法：刪除或標記為 P2 佔位偽代碼並補上 lib.rs 修改項。

**M3｜`icon('camera')` 圖示不存在 → UI 無聲渲染空白**
- 計畫書章節：ch4-2 HTML 骨架、ch4-5 插入代碼（`${icon('camera')}` ×2）。證據：`src/lib/svg.js:94-170` icons 表**無 `camera` 鍵**（grep `camera` = 0 筆）；`svg.js:179` `if (!fn) return '';` → 不報錯、靜默輸空字串。
- 後果：區塊標題與按鈕圖示消失（使用者-visible bug），且第6章修改清單**未列 svg.js**（需新增 camera import + 圖示鍵）。
- 修法：svg.js 增加 `camera`（lucide-static 有 `camera.svg`）或改用既有 `image`（`svg.js:145`）。

**M4｜第6章「逐檔案修改清單」嚴重不全（違反窮舉要求）**
- 未列：① `src/pages/tools.js` 本體修改（HTML 插入 + `onMount` 內綁定 `#ocrCaptureBtn`/`#ocrFileInput`/`#ocrSelectAllBtn`/`#ocrConfirmBtn` 事件——ch4 明確要求事件綁定，ch6 卻無 tools.js 項）；② Tesseract.js 依賴引入（npm/worker 檔案/eng traineddata 擺放位置）；③ OCR Web Worker 檔案；④ svg.js（見 M3）；⑤ src-tauri/lib.rs（見 M2）。
- 證據：計畫書 L298-385 僅 3 個檔案；對照 ch4/ch7/ch8 的交付物敘事（`importOcrText`、Tesseract.js、事件綁定）明顯缺口。

**M5｜ch4-4 能力偵測在 Tauri v2 預設設定下恆為 false（手機原生路徑是死代碼）**
- 計畫書章節：ch4-4（L152 `window.__TAURI__ !== undefined`）。證據：`src-tauri/tauri.conf.json` **未設 `withGlobalTauri`**（Tauri v2 預設不注入 `window.__TAURI__`）；倉庫慣例是 `src/lib/platform.js:5` `export const isTauri = typeof window.__TAURI__?.core === 'object'`，計畫書未沿用而自行发明輪子。
- 後果：`isTauri` 恆 false → 永遠走 file input；僞代碼性質的原生相機分支（註掉的 `tauri-ocr.js` import）未宣告為偽代碼，以「完整 JS 函式」外殼呈現 → 違反「偽代碼須標明」。所幸兩分支行為相同（皆 `ocrFileInput.click()`），P1 無功能傷害。

### Minor

**m1｜ch6 三處錨點縮排 +2（非一字不差）**：api 錨點（計畫 L304-307）、store 錨點（L322-327）、capabilities 錨點（L352-364）內容逐字正確，但整段多 2 空格縮排（Markdown 巢狀清單副作用）。照貼不會報錯但產生髒 diff；ch4 Generate Forms 錨點則完全零差異（見 PASS-A1），標準應一致。
- 證據：diff 輸出（本審查終端實測）。

**m2｜ch4-1 `#issuesResult` 引用拼接+錯位**：把 `tools.js:93-94` 兩行壓成一行；且引用文字掛 `#issuesResult` 但引的 HTML 無此 ID（實在 `tools.js:97`）。不影響施工，但違反「一字不差」。

**m3｜ch5-3 重複比對節錄未標省略**：實碼 `store.js:1229` 含 `if (onProgress) onProgress({ done: i+1, total, added, skipped });`，計畫書 L275 逕行刪除該段無 ellipsis 標記（同段 1216 行則逐字正確）。

**m4｜ch4-3 與 ch5/ch6 寫入路徑前後矛盾**：ch4 狀態機 `confirm` 狀態寫「呼叫 `s.actions.addWord(...)` 批次寫入」（L141），ch5 卻論證 addWord 非正確入口、評定 `importWords`/`saveWordsInTx`（L269），ch6 落地 `importOcrText→importWords`。addWord 逐字 `refreshDerived()+notify()` 各一次，OCR 幾十鍵即幾十次全量重算——ch5 自己已駁斥此路。文件內部不一致，實施者可能照 ch4 誤用 addWord。

**m5｜ch4-4 殘留日文**：L135「Tauri プラグイン 呼叫相機」（AI 生成痕跡，同段 L159 程式註解為中文）。

**m6｜ch6-2 importOcrText 為片段非自足代碼**：以 `},` 結尾的物件成員，只有在 actions 字面衝內（`store.js:548`，插入點 `1283/1285` 之間）才可解析——計畫書已給前後錨點故可執行，但「完整可貼代碼」標題誇大（`node --check` 單獨跑會失敗，包 object 後通過）。另 `deckName='OCR Inbox'` 精簡物件 `{word, definition, deck}` 餵 `importWords` 兼容（`store.js:1227/1232/1243` 皆有防呆預設）✅。

---

## 四、判定匯總

| 審查項 | 判定 |
|---|---|
| 1. 原文錨點一字不差 | ⚠️ 部分：ch4 主錨點（掛載點）**逐位元組完美**；ch6 三錨點內容真、縮排 +2；ch4-1 一處引用拼接錯位 |
| 2. 可貼代碼語法 + API 簽名 | ⚠️ 全部通過語法校验（條件式）；但引用了**不存在的 `recognize_image` 命令**與**不存在的 `camera` 圖示**；fs 權限在本建置中不存在 |
| 3. 偽代碼標明 / 可貼性 | ❌ ch4-4 原生相機分支屬偽代碼卻以可貼函式外殼呈現；ch6 清單缺 5 類必要檔案 |
| **總判定** | **❌ 不通過 — 退回修訂** |

**修訂優先序**：M1（建置失敗）> M4（清單不全）> M2/M3（幽靈符號）> M5（死代碼/偽代碼未標）> m1-m6。
M1+M4 修好後本計畫可升級為 ⚠️ 有條件通過；ch5 資料流論證（saveWordsInTx 逐字引用、importWords 交易策略、toLowerCase/trim 對齊）是全書最紮實的一章。

*審查人：Reviewer #1（修法正確性）。本審查未修改任何 src/ 檔案；校验於 /tmp/ocr-review 進行。*
