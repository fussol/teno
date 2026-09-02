# R3 複審報告 — 審查委員 #B（v1.2 新增內容幻覺偵測）

> 審查對象：`_dev/notes/OCR-plan-v1.2.md`（僅 diff 新增/修改段，對照 `OCR-plan-v1.1.md`）
> 方法：實碼 grep、npm registry 查詢、`npm pack` 拆包查 tesseract.js 實檔、`node --check` 語法校验
> 審查日期：2026-08-28

## 總評：❌ 有條件退回（3 項 ❌ + 多項 ⚠️，均為定點可修）

新增的「雙 Adapter 架構」主體方向可行，vite/svg/store/ch4 代碼片段語法全數通過校验；
但存在 **1 個版本號幻覺、1 個掛載點自我矛盾（設定頁 vs tools 頁）、1 個宣稱與內容不符（diff 級修復缺失）**，
以及離線資產檔名清單不完整。

---

## 1. 新引用識別符逐一查證

| 引用 | 查證結果 | 判定 |
| :--- | :--- | :--- |
| `lucide-static/icons/camera.svg?raw`（§6-1 新增 import 行） | `node_modules/lucide-static/icons/camera.svg` 存在（lucide-static ^1.28.0）；import 模式與 svg.js:8-38 現行 30+ 行完全一致；`S()` 存在 svg.js:91，`check: () => S(checkRaw)` svg.js:107 同格式佐證；svg.js 中 `camera` 鍵目前不存在（確為待新增，非宣稱已有） | ✅ |
| `import { isTauri } from '../lib/platform.js'`（§4 新增） | `src/lib/platform.js:5: export const isTauri = typeof window.__TAURI__?.core === 'object';` — 路徑、匯出名、M5 宣稱的偵測式**逐字吻合** | ✅（⚠️ 引入了但片段內未使用，死 import） |
| `store.js:1269-1277`（§0-L4/F3 新增引用） | 實碼 1269-1277 為 `if (newWords.length) { BEGIN…COMMIT…catch{ ROLLBACK(1275); console.warn } }` 區塊，行號**精準**；「ROLLBACK 後回傳 added>0」行為屬實（`return { added, ... }` 在 1282，catch 內僅 warn 不重置 added）。次要注記：return 行在引用範圍外 3 行 | ✅ |
| `importWords`（§5 依賴） | `store.js:1214: async importWords(words, onProgress)` 存在；片段用 `this.importWords` 與 actions 物件內 `this.createDeck`（1232）慣例一致 | ✅ |
| DOM id：`ocrCaptureBtn/ocrEngineSelect/ocrFileInput/ocrResultArea/ocrLoading/ocrCandidatesContainer/ocrCandidatesList/ocrSelectAllBtn/ocrConfirmBtn` | 全庫 grep 零命中 → 無衝突新 id | ✅ |
| CSS 類 `config-select`（§4 select 上新增） | **`src/` 全庫零命中**（CSS 無定義、任何 HTML 無使用）。同族原生 select 慣例是 `class="form-input"`（settings.js:1280,1341） | ❌ 幽靈 CSS 類 |
| 設定鍵（引擎持久化） | 計畫宣稱「設定頁選單無痛切換」（§3/§8-P2），但**未定義任何設定鍵**，也未列入 settings.js 修改項。專案慣例為 `db.getSetting/setSetting`（tools.js:975 exampleDisplayMax 前例） | ❌ 持久化機制幽靈 |
| npm `tesseract.js: ^5.1.0`（§6-4） | **npm registry 實查：latest = 7.0.0**（dist-tags.latest=7.0.0；6.x 末版 6.0.1；5.x 末版 5.1.1）。^5.1.0 落後**兩個 majors**。即便意圖锁定 v5，也應顯式註明並同步 §6-6 的 v5 專屬檔名規範；否則至少標 `^6`/`^7` 並重驗資產檔名 | ❌ 版本標記過時 |
| npm「相關 Adapter 依賴」（§6-4 新增措辭） | 未給 paddle 側套件名。查證：PP-OCRv6 為真（PaddleOCR main README 同時提及 PP-OCRv5/v6 ✅）；但第2章宣稱的「**官方**瀏覽器推理 SDK (`PaddleOCR.js`)」**查無此官方套件**——npm `paddleocr@1.2.0` 為第三方包裝、無 `paddlejs-core`（404），PaddlePaddle 官方 web 推理線是 Paddle.js 而非「PaddleOCR.js」。以 [一手資料實證] 標註屬過度宣稱 | ⚠️ P2 範圍，第2章出處需降標或補正名 |
| 插入點「Generate Forms 與 Cambridge 之間」（§4） | tools.js:190 `<!-- Generate Forms -->`、tools.js:202 `<!-- Cambridge Dictionary -->` 均存在 | ✅ |
| CSP 基底字串（§6-5） | 與 tauri.conf.json:27 現行值逐字比對，唯一差異是新增 `'wasm-unsafe-eval'`，屬真實最小 diff | ✅ |
| `vite.config.js` `optimizeDeps.exclude`（§6-6） | 現行 vite.config.js **已有** `optimizeDeps.exclude: ['onnxruntime-web','@huggingface/transformers']`；新增內容只是追加 `'tesseract.js'`。片段以「擴充」呈现可接受，但屬「修改既有區塊」非「新增區塊」，实施時若整段貼上會重複鍵 | ✅（註記） |

## 2. `node --check` 語法校验結果

| 代碼區塊 | 方式 | 結果 |
| :--- | :--- | :--- |
| vite 配置（現行檔 + 計畫 diff 合併後） | `node --check`（.mjs） | ✅ VITE_MERGE_OK |
| 第4章 `handleOcrCapture` 片段 | `node --check` | ✅ CH4_OK |
| 第6章 `importOcrText` 片段（包裹於物件字面量） | `node --check` | ✅ STOREFRAG_OK；回傳結構 `{added,skipped,decksCreated}` 與 importWords:1282 一致 |
| 第6章 svg.js import 片段 | `node --check` | ✅ SVGFRAG_OK |
| 第3章 `OcrEngine = { id, recognize(imageFile, opts) → { text, blocks[], confidence }, available() }` | `node --check` | ❌ SyntaxError（`→` 與裸宣告非 JS）。屬介面速寫可諒解，但建議改 TS 介面或註明 pseudocode |

## 3. 選單插入 vs custom-select 渲染體系相容性（G13/G14 前例）

**實碼鏈路**：main.js:303-306 每頁渲染順序為 `render → onMount → initCustomSelects(container)`。
`src/lib/custom-select.js:3` 對 root 下**所有原生 `<select>`** 無條件轉換（`.cs-wrap` 體系），原 select 僅 `display:none` 不離 DOM；
選取時 `select.value = …`（:204）並 **re-dispatch `change` + `input` bubbling 事件**（:211-212）。

結論：
- ✅ **功能面相容**：`#ocrEngineSelect` 若如 §6-3 所述用 `addEventListener('change')` + 讀 `.value`，被 global 轉換後仍工作；onMount 先於轉換執行、監聽器掛在同一 DOM 節點，不會被 G14 型「重渲染後converter丟失」問題命中（tools.js OCR 區塊只在 render() 出現一次）。
- ⚠️ **一致性警示**：tools.js 頁內兄弟控件（posMethod/exampleMethod/pronMethod/cambridgeDict）全走頁內私有的 `_selHtml` div 體系（tools.js:9，id 為 `<name>Cs`、值藏 `.cs-t` data-value，讀值用 `_getMethod()` tools.js:327）。混用原生 select 會被 lib 轉換成另一套 `.cs-wrap` 視覺。**若實作者照抄 `_getMethod('ocrEngineSelect')` 慣例將取不到值（回 fallback）**——計畫未明示讀值方式，屬實現陷阱，應在 §6-3 明写「用 `#ocrEngineSelect.value` + change 事件，勿用 _getMethod」。
- 兩套體系 class 命名空間（`.cs/.cs-t/.cs-o` vs `.cs-wrap/.cs-trigger/.cs-option`）不相交，tools.js:331 私聽無 `.cs` 命中即 return，實查無事件衝突。✅
- ❌ **掛載點自我矛盾（本輪最重）**：§3「系統**設定頁**增加 OCR 引擎核心選單」+ §8-P2「**設定頁**可無痛切換」，但第4章 HTML 與第6章六檔清單中引擎選單**只存在於 tools.js**，settings.js 完全不在修改清單。两处宣稱第三处沒兜住——幽靈掛載點。
- ❌ **持久化缺失**：無設定鍵、無 setSetting 寫入項 → 「切換」僅存活於當次 DOM，與「無痛切換」宣稱不符。

## 4. tesseract.js v5 離線資產實檔核對（`npm pack tesseract.js@5.1.1` / `tesseract.js-core@5` 拆包實查）

| 計畫宣稱 | 拆包實碼現實 | 判定 |
| :--- | :--- | :--- |
| `workerPath` 指向 `/assets/ocr/` | v5 預期檔為 **`dist/worker.min.js`**（worker/browser/defaultOptions.js:9 預設 CDN `tesseract.js@v…/dist/worker.min.js`）→ 必須把 worker.min.js 複製進 public/assets/ocr/ | ⚠️ 檔名清單未列 |
| `corePath` 指向 `/assets/ocr/` | v5 getCore.js:22-30 依 SIMD 偵測載入 `{corePath}/tesseract-core-simd-lstm.wasm.js`／`tesseract-core-simd.wasm.js`／`-lstm`／裸版四選一，來自**另一套件 `tesseract.js-core`**（v5 的 npm 相依，會自動裝但計畫從未提其檔需複製）；core@5 tarball 實含 `tesseract-core-simd-lstm.wasm.js` + `.wasm` 等 | ⚠️/❌ 核心檔需求完全未列 |
| `langPath` 指向 `/assets/ocr/`、模型檔「`eng.traineddata` 等」 | v5 worker-script/index.js:140 fetch URL 為 `{langPath}/eng.traineddata**.gz**`（gzip 預設 true）→ 放裸 `eng.traineddata` 會 404，需 `eng.traineddata.gz` 或關 gzip | ❌ 檔名附註不符 |
| `public/assets/ocr/` 目錄 | 現行 `public/` 無 assets/ 目錄（僅 words.txt.gz、icons/…）→ 屬將建目錄，非宣稱已存在，可接受 | ✅（註記） |
| §3「快取缺失則連線下載」 | §6-5 CSP `connect-src` 未含任何 CDN 來源 → 缺檔回退下載會被自家 CSP 擋死，§3 與 §6-5 互相矛盾 | ⚠️ |
| `optimizeDeps.exclude: ['tesseract.js']` | tesseract.js 含 Node-only 分支與 worker 腳本，exclude 是常見正確做法；語法合併無誤 | ✅ |

## 5. 其餘 diff 新增段查證摘要

- L8/F4 正則收斂：兩處皆 `/^[a-z][a-z'-]{1,30}$/i`（§5、§6-2 片段一致），「實容 2–31 字元」數學正確 ✅（v1.1 缺 `/i` 與 2–30 錯誤已確實修復）。
- 負控制 B 從 v1.1「回傳 added=0」（與實碼矛盾）改為「如實回報既有行為」→ 與實碼 1269-1277 行為接軌 ✅；但 ⚠️ §0-F3 宣稱 store.js 修復項「補上 diff 級修復」，**§6-2 片段實際只把 `return await` 拆成 `const res` 兩行，catch 內 added 重置/上拋的修復一字未寫**——宣稱與內容不符 ❌（第 3 個 ❌）。另 ROLLBACK 後 `state.words` 已 push 造成的記憶體/DB 分岔未提及。
- 「擴充 `importOcrText`」措辭：該函式全庫不存在（grep 零命中），是**新建**非擴充 ⚠️ 微措辭。
- §0-F2 宣稱 §6-6「明列 optimizeDeps.exclude / **assetsInclude** 規範」：片段只有 optimizeDeps，assetsInclude 零字 ⚠️（public/ 靜態路由本不需 assetsInclude，但宣稱與內容不符）。

---

## 判定彙總

| # | 項 | 判定 |
| :- | :--- | :-: |
| 1 | svg.js camera import 行 | ✅ |
| 2 | platform.js isTauri / M5 慣例 | ✅ |
| 3 | store.js:1269-1277 行號與行為 | ✅ |
| 4 | `config-select` CSS 類 | ❌ 幽靈類 |
| 5 | tesseract.js ^5.1.0（latest=7.0.0） | ❌ 過時 majors×2 |
| 6 | 「設定頁」引擎選單宣稱 vs §6 無 settings.js | ❌ 幽靈掛載點 |
| 7 | 引擎切換設定鍵/持久化 | ❌ 未定義 |
| 8 | §0-F3「diff 級修復」宣稱 vs §6-2 內容 | ❌ 宣稱與內容不符 |
| 9 | v5 離線資產清單（worker.min.js / tesseract-core-*.wasm.js / eng.traineddata**.gz**） | ❌ 不完整+檔名不符 |
| 10 | §3 連線下載回退 vs CSP connect-src | ⚠️ 自我矛盾 |
| 11 | 「PaddleOCR.js 官方 SDK」[一手資料實證] | ⚠️ 查無官方同名 SDK（PP-OCRv6 本身屬實） |
| 12 | 四段可執行代碼 node --check | ✅ 全過（介面速寫除外） |
| 13 | custom-select 相容性（功能面） | ✅（附實現陷阱警示） |
| 14 | 正則/長度/負控制 B/CSP diff/DOM id | ✅ |

**結論：退回定點補正。** 必修：#4~#9（六項 ❌）；建議修：#10~#11。修復後無需第四輪全面复审，書面核銷即可。
