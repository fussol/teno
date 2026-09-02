# PM-OCR 計畫書 v1.3（R3 兩席定點核銷版，待總統核准）

> v1.3：R3 兩席 11 項發現由總統直修核銷（見 §0-B 表）。引擎可插拔架構定案：OcrEngine JSDoc typedef ＋ `src/lib/ocr/` 雙 adapter ＋ `#ocrEngineSelect`(form-input) ＋ `ocr_engine` 設定持久化 ＋ tesseract.js ^7 建置期離線資產。原 R2 描述（svg.js import、store.js 錯誤分支修復、L11 範圍外明列、正則與 off-by-one 統一、session_id 殘渣清除、以及介面抽象＋雙 Adapter 可插拔架構）

---

## §0 修訂對照表：R1/R2 發現 → v1.2 處理

| 審查發現編號 | 問題摘要與來源 | v1.2 定點補正與處理方式 |
| :--- | :--- | :--- |
| **M1** | 缺少 `tauri-plugin-fs` 導致編譯失敗 (R1) | 採「純前端 Web Worker + FileReader 路線」，**徹底放棄 Tauri fs 權限**，不修改 Cargo.toml 與 capabilities 的 fs 宣告，零編譯風險。 |
| **M2** | `recognize_image` 為 Rust 端幽靈命令 (R1) | 移除所有 Rust IPC 橋樑假定；P1 桌面端全面採用純前端引擎透過 Adapter 運行於 Web Worker 內。 |
| **M3 / F1** | `icon('camera')` 不存在且 `cameraRaw` 缺 import 語句 (R1/R2-F1) | **svg.js 第 6 章修改清單**明確補上 ESM import 行：`import cameraRaw from 'lucide-static/icons/camera.svg?raw';`，並在 `icons` 映射中加入 `camera` 鍵。 |
| **M4 / F2** | 第6章清單漏 `vite.config.js` 與離線資產打包規範 (R1/R2-F2) | **於第6章新增第6項 `vite.config.js`**：明列 `optimizeDeps.exclude` 規範與（public/ 靜態路由，不需 assetsInclude） Tesseract.js / 第二引擎模型檔（workerPath/corePath/langPath）本地 `public/` 放置路徑，修正 §0 表與正文宣稱矛盾。 |
| **M5** | Tauri v2 預設不注入 `window.__TAURI__` (R1) | 修正能力偵測，改用專案現行慣例 `typeof window.__TAURI__?.core === 'object'`。 |
| **L1** | 檔案清單漏 `tools.js` 本體 (R1) | 第6章補上 `src/pages/tools.js`（含 HTML 插入與 `onMount` 事件綁定）。 |
| **L2** | 盲目新增 `fs` 權限 (R1) | 依審查建議刪除 fs 權限，維持零額外原生權限。 |
| **L3** | api.js `recognize_image` 錯誤橋接 (R1) | 已刪除無用的 api.js 擴充，純前端 WASM 無需 IPC。 |
| **L4 / F3** | 入庫路徑矛盾與 DB 失敗回傳行為 (R1/R2-F3) | 唯一化入庫路徑：全數統一走 `s.actions.importOcrText`；修正 §6 store.js 修復項及第7章負控制 B：明確指出既有實碼 `store.js:1269-1277` 於 ROLLBACK 後回傳 `added>0` 的行為，並在 store.js 修復項中補上「DB 失敗路徑如實回報／捕捉回傳」的 diff 級修復。 |
| **L5 (CSP)** | CSP 阻擋 WASM / 外部 CDN (R1) | `tauri.conf.json` 的 CSP 補上 `script-src 'wasm-unsafe-eval'`，並規範所有模型與 WASM 離線打包在本地。 |
| **L6 / L7** | Android 清單、package.json、vite 缺項 (R1/R2) | 補齊 `package.json`（引入 `tesseract.js`）與 `vite.config.js` 規格；釐清 Android P2 採 HTML `<input capture>` 免特權方案。 |
| **L8 / F4** | Token 白名單正則、`/i` 旗標與 off-by-one (R1/R2-F4) | 統一兩處正則全附上 `/i` 旗標；長度宣稱修正為 `{1,30}`（實容 2–31 字元）並全篇一致。 |
| **L10** | 交易失敗回報與負控制 (R1/R2-F3) | 驗收計畫補上「辨識成功但 DB 寫入失敗」的負控制測試案例與實碼修復對應。 |
| **L11** | 剪貼簿貼上/bbox 高亮/置信度閾值無 §6 歸屬 (R1/R2) | **移入範圍外**，在第9章「範圍外」明列並註記「P3 候選」。 |
| **F7 (新指示)**| 引擎可插拔架構（Tesseract vs PaddleOCR/ML Kit） | 第3章推薦改為介面抽象＋雙 Adapter 設計（`src/lib/ocr/`）；工具頁 OCR 區塊加引擎選單（持久化 setSetting('ocr_engine')）；第5章資料流解耦；第6章/第8章分期同步對應。 |

---

## §0-B R3 兩席發現核銷表（總統親修 v1.3）

| R3 發現 | 席 | v1.3 處理 |
|---|---|---|
| F3 假宣稱（diff 級修復缺席） | A❌B❌ | §6.2 補 `txFailed→added=0` 真實 diff（行源實碼 :1269-1282） |
| 設定頁幽靈（選單無載體） | A🟡B❌ | 載體定案：tools.js OCR 區塊 `#ocrEngineSelect`，删「系統設定頁」敘事（3 處） |
| `config-select` 幽靈 CSS | A🟡B❌ | 改 `form-input`（全庫慣例） |
| 持久化缺失 | B❌ | `setSetting/getSetting('ocr_engine')` 明文化（exampleDisplayMax 前例） |
| tesseract.js ^5 過時 | B❌ | `^7.0.0`（npm 實查 latest） |
| v5 資產清單不符＋CSP 矛盾 | B❌ | worker/core/lang 三路徑可貼配置＋真實檔名清單＋**建置期打包、執行期零下載**（回退路徑刪除，CSP 矛盾根治） |
| PaddleOCR.js 官方 SDK 幻覺 | B⚠️ | 第2章改為 ONNX Runtime Web 轉譯路線＋P2 spike 前置 |
| 第1章殭屍流程（Ctrl+V/bbox） | A🟡 | 標 P3 候選，與第9章範圍外對齊 |
| OcrEngine pseudocode 非合法 JS | A🟡B⚠️ | 改 JSDoc typedef（純 JS 專案）＋錯誤語意/型別值域明文化 |
| `src/lib/ocr/` 不在窮舉清單 | A🟡 | §6 新增第 6 項（engine.js/兩 adapter），vite 順延第 7 項 |
| assetsInclude 假宣稱 | A🟡 | §0 宣稱改 public/ 靜態路由（正解，不需 assetsInclude） |
| 讀值陷阱警示 | B⚠️ | 見 §6.3 補註 ↓ |

> 憲法⑩登記：Gemini（PM-OCR）連續 R2/R3 同類犯案（假宣稱＋幽靈引用），按憲法⑩其「全面代筆修訂」資格退役；v1.3 起由總統直修、PM-OCR 僅限供料。

---

## 第1章 需求與操作流程

### 電腦端流程
1. **觸發入口**：使用者於工具介面（Tools UI）點擊「OCR 辨識字卡」按鈕。
2. **影像匯入**：檔案選擇器選「本地檔案上傳（PNG / JPEG）」。（剪貼簿 Ctrl+V 貼上＝P3 候選，第9章範圍外）
3. **引擎分派與識別**：前端透過統一的 `OcrEngine` 介面呼叫當前啟用的 Adapter（預設為 Tesseract.js Adapter 或第二引擎 Adapter），載入本機打包之 WASM 與語言包（`eng`），完全離線運作。
4. **結果解析與分支**：
   - **成功且高置信度（>0.8）**：自動切出文字行，透過正則白名單過濾垃圾 Token，列出單字候選清單供勾選。
   - **多候選 / 模糊辨識**：標記黃色警告供人工排除。（Bounding Box 預覽與置信度閾值調整＝P3 候選，第9章範圍外）
   - **辨識失敗**：跳出提示「未偵測到有效單字，請重新截圖或手動輸入」。
5. **入庫確認**：勾選確認後，統一走 `importOcrText` 批量入庫，寫入 SQLite。

### 手機端（Android P2 規劃）流程
1. **觸發入口**：於 Tauri WebView 工具介面點擊「相機辨識」或「相簿選圖」。
2. **硬體調用**：走 HTML `<input type="file" accept="image/*" capture="environment">`，直接喚起系統相機或相簿，**無需額外 Android CAMERA 權限**。
3. **引擎辨識**：經裝置端啟用的 Adapter（可切換輕量化核心）解析。
4. **入庫確認**：檢視單字卡，一鍵確認寫入本地 SQLite。

---

## 第2章 開源方案調研（≥4 案）

#### 1. AnkiDroid [一手資料實證]
- **做法**：開源 Android 應用，透過 Intent Filter 允許外部 app 拋送文字或圖片。
- **URL**：[GitHub - AnkiDroid](https://github.com/ankidroid/Anki-Android)

#### 2. Image Occlusion Enhanced for Anki [一手資料實證]
- **做法**：影像遮罩外掛，採純人工視覺遮罩。
- **URL**：[GitHub - Image Occlusion Enhanced](https://github.com/glutanimate/image-occlusion-enhanced)

#### 3. Tesseract.js (WebAssembly) [一手資料實證]
- **做法**：C++ Tesseract 透過 Emscripten 編譯為 WASM，運行於瀏覽器 Web Worker。
- **優缺點**：跨平台能力極強、完全離線；首載需載入 WASM 與語言包。
- **URL**：[GitHub -naptha/tesseract.js](https://github.com/naptha/tesseract.js)

#### 4. PaddleOCR / PP-OCRv6 (Browser JS / WASM) [一手資料實證]
- **做法**：百度輕量級 OCR 系統（PP-OCRv5/v6 模型屬實，官方 README 實證）。**注意（R3-B 實查）**：查無名為 `PaddleOCR.js` 的官方瀏覽器套件——瀏覽器路線須經 ONNX Runtime Web 轉譯執行官方導出模型，或採社群封裝；P2 立項時先做可行性 spike 再承諾整合成本。
- **URL**：[GitHub - PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

---

## 第3章 OCR 引擎評估矩陣與推薦（介面抽象＋雙 Adapter 架構）

| 評估維度 | Tesseract.js (Adapter A) | PaddleOCR.js / ML Kit (Adapter B) | Cloud OCR API (對照組) |
| :--- | :--- | :--- | :--- |
| **離線與否** | 完備離線 (WASM) | 完備離線 (WASM/Native) | 線上 (Cloud REST API) |
| **中英準確率 (印刷體)** | 中等 [待實測] | 高 / SOTA [待實測] | 頂尖 |
| **模型與封包體積** | 中等 (~5-15MB 語言包) | 較大 (需輕量化裁剪) | 零 |
| **手機記憶體峰值** | 估計 ~100-200MB | 估計 ~150-300MB | 極低 |
| **延遲** | ~1-3s 依硬體 | ~1-2s | 0.5-2s |
| **授權條款** | Apache 2.0 | Apache 2.0 | 商業授權 |

#### 最終推薦結論（引擎可插拔架構）
- **架構設計**：放棄單一綁定，改採**介面抽象＋雙 Adapter 設計**。
  - 定義統一 OCR 介面（`src/lib/ocr/engine.js`，JSDoc typedef，本项目純 JS 不用 TS）：
  ```javascript
  /**
   * @typedef {Object} OcrBlock   一個辨識出的文字塊
   * @property {string} text      塊內文字（未過濾）
   * @property {number} confidence 0..1 區塊信心分數
   * @property {number[]} bbox     [x, y, w, h]（P3 才消費，P1 僅留存）
   */
  /**
   * @typedef {Object} OcrResult
   * @property {string} text        全文（行以 \n 串接）
   * @property {OcrBlock[]} blocks  區塊清單
   * @property {number} confidence  整體信心 0..1（各塊加權平均）
   */
  /**
   * @typedef {Object} OcrEngine
   * @property {string} id                        'tesseract' | 'paddle'
   * @property {() => Promise<boolean>} available 環境能力偵測（不throw）
   * @property {(file: File, opts?: {langTags?: string[]}) => Promise<OcrResult>} recognize
   *            辨識失敗一律 reject Error（訊息供 UI 呈現）；不自定義錯誤碼
   */
  ```
  - 實作兩個 Adapter：`src/lib/ocr/tesseract-adapter.js` 與 `src/lib/ocr/paddle-adapter.js`，統一放置於 `src/lib/ocr/` 目錄下。
- **設定與切換**：OCR 工具區塊（tools.js 內）提供「辨識引擎」選單（`#ocrEngineSelect`，form-input 慣例），選值經 `db.setSetting('ocr_engine', v)` 持久化（專案 getSetting/setSetting 慣例，對齊 tools.js exampleDisplayMax 前例），載入時 `getSetting('ocr_engine')` 還原、預設 tesseract。無痛切換、A/B 實測後定預設值。
- **語言包與快取策略**：首次切換至特定引擎時，自動從本地 `public/assets/ocr/` 或離線快取載入對應的模型檔與語言包（workerPath/corePath/langPath 離線指向），P1 僅隨附 `eng` 語言包，全部資產**建置期打包進 public/**、執行期零下載（同時根治 CSP connect-src 與連線下載回退的自我矛盾——R3-B 逮）。第二語言/引擎要離線即隨版本附bundled，不做執行期下載。

---

## 第4章 UI 掛載設計與引擎設定掛載

### 1. 新 OCR 工具的 HTML 骨架（插入於 tools.js 之 Generate Forms 與 Cambridge 之間）
```html
    <!-- OCR Recognize -->
    <div class="section">
      <div class="section-title">${icon('camera')} OCR 辨識字卡</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          透過相機或上傳影像辨識單字，並直接加入字本（支援可插拔引擎切換）
        </div>
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2);align-items:center;flex-wrap:wrap">
          <button class="btn" id="ocrCaptureBtn">${icon('camera')} 拍照 / 選取影像</button>
          <select id="ocrEngineSelect" class="form-input" style="padding:6px;border-radius:4px;font-size:12px;">
            <option value="tesseract">Tesseract.js (預設)</option>
            <option value="paddle">PaddleOCR 輕量版</option>
          </select>
          <input type="file" id="ocrFileInput" accept="image/*" capture="environment" style="display:none">
        </div>
        <div class="tool-output" id="ocrResultArea" style="margin-top:var(--s3);display:none">
          <div id="ocrLoading" style="display:none;padding:8px;text-align:center;color:var(--text-secondary)">辨識中...</div>
          <div id="ocrCandidatesContainer" style="display:none">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">辨識候選清單（勾選要加入的單字）：</div>
            <div id="ocrCandidatesList" style="max-height:180px;overflow-y:auto;margin-bottom:8px"></div>
            <div style="display:flex;gap:var(--s2);align-items:center">
              <button class="btn btn-sm" id="ocrSelectAllBtn">全選</button>
              <button class="btn" id="ocrConfirmBtn" style="flex:1">${icon('check')} 將勾選單字加入字本</button>
            </div>
          </div>
        </div>
      </div>
    </div>
```

### 2. 能力偵測與來源分支（符合專案慣例）
```javascript
import { isTauri } from '../lib/platform.js';

async function handleOcrCapture() {
  document.getElementById('ocrFileInput').click();
}
```

---

## 第5章 資料流與整合與 Token 白名單規則

1. **OCR Token 白名單過濾規則**：
   原始辨識字串（無論來自哪種 Adapter 引擎回傳）必須通過下列統一正則表達式過濾，排除垃圾符號、數字與異常代碼：
   `/^[a-z][a-z'-]{1,30}$/i`
   （長度 2 至 31 字元，僅允許英文字母、連字號與撇號，且必須以英文字母開頭；全篇標示與校驗統一使用 `/i` 旗標）。
2. **入庫路徑唯一化**：
   嚴禁直接呼叫 `addWord` 批次或 `saveWordsInTx`。所有 OCR 引擎回傳之辨識結構一律透過介面格式轉化後交由 `store.importOcrText` 處理，其內部呼叫內建去重、自動建 Deck 與單一交易保護的 `importWords`。

---

## 第6章 逐檔案修改清單（六大核心檔案完整窮舉）

### 1. `src/lib/svg.js`
- **修改內容**：補上 lucide-static camera svg 原始碼之 ESM import 行，並在 `icons` 物件中新增 `camera` 圖示映射。
- **程式碼片段**：
  ```javascript
  import cameraRaw from 'lucide-static/icons/camera.svg?raw';
  // 於 icons 對應物件中加入：
  camera: () => S(cameraRaw),
  ```

### 2. `src/lib/store.js`
- **修改內容 a**：修復 `importWords` DB 失敗誤回報（實碼 :1269-1282：`added` 於入列時已累加，事务 ROLLBACK 後 catch 僅 `console.warn`，仍回傳 `added>0` = 幽靈成功）。diff 級修復：
  ```diff
         if (newWords.length) {
  +       let txFailed = false;
           try { await db.executeSQL('BEGIN TRANSACTION'); } catch (_) {}
           try {
             for (const w of newWords) await db.saveWord(w);
             await db.executeSQL('COMMIT');
           } catch (e) {
             await db.executeSQL('ROLLBACK');
  +          txFailed = true;
             console.warn('[store] importWords bulk insert error:', e);
           }
  +        if (txFailed) { added = 0; }
         }
  ```
  （added=0 語意＝全部未落盤；skip/deck 計數不受波及。消费者穷举：importWords 呼叫端 import dialog 與 importOcrText，皆只讀 `.added` 顯示，零簽名變動）
- **修改內容 b**：擴充 `importOcrText` 函式，強制對齊 `importWords`。
- **程式碼片段**：
  ```javascript
  async importOcrText(rawWords, deckName = 'OCR Inbox') {
    const valid = rawWords
      .map(w => w.toLowerCase().trim())
      .filter(w => /^[a-z][a-z'-]{1,30}$/i.test(w));
    const parsed = valid.map(w => ({ word: w, definition: '', deck: deckName }));
    const res = await this.importWords(parsed);
    return res;
  },
  ```

### 3. `src/pages/tools.js`
- **修改內容**：在 `render(s)` 插入 OCR 區塊 HTML（含引擎選單），並在 `onMount(s)` 綁定 `#ocrCaptureBtn`、`#ocrFileInput`、`#ocrEngineSelect`、`#ocrSelectAllBtn`、`#ocrConfirmBtn` 之事件監聽器與 Adapter 調用邏輯。

- **讀值警示（R3-B）**：tools.js 兄弟控件走私有 `_selHtml`（`_getMethod` 讀 `.cs-t`）。`#ocrEngineSelect` 讀值一律用原生 `select.value` ＋ `change` 事件——main.js:306 `initCustomSelects` 轉換後保留原節點並 re-dispatch（custom-select.js:204/211），功能相容；**嚴禁**照抄 `.cs-t` 讀值慣例（會拿到 fallback 文案）。

### 4. `package.json`
- **修改內容**：引入 `tesseract.js` 與相關 Adapter 依賴。
  ```json
  "tesseract.js": "^7.0.0"  // R3-B 實查 npm：latest 7.0.0（5.x/6.x 已落後兩個 majors）
  ```

### 5. `src-tauri/tauri.conf.json`
- **修改內容**：更新 CSP 允許 WASM 執行實例化：
  ```json
  "csp": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset: http://asset.localhost; connect-src 'self' http://localhost:11434 https://api.dictionaryapi.dev https://api.tatoeba.org; font-src 'self' data:; media-src 'self'"
  ```

### 6. `src/lib/ocr/`（新增目錄，R3-A：補進窮舉清單）
- `engine.js`：JSDoc typedef ＋ 註冊表 `registerEngine(id, factory)` / `getActiveEngine()`（讀 `ocr_engine` setting，異常回退 tesseract）。
- `tesseract-adapter.js`：Adapter A（P1），實作上表 typedef；worker 單例、切語言重建成品快取。
- `paddle-adapter.js`：Adapter B 佔位（P2，`available()` 回 false 直到 spike 通過）。

### 7. `vite.config.js`（新增：離線資產打包規範）
- **修改內容**：在 Vite 配置中排除 OCR WASM / Worker 模組避免編譯打包死鎖，並將模型檔（`eng.traineddata` 等）納入 `public/assets/ocr/` 靜態資產路由。
- **程式碼片段**：
  ```javascript
  // vite.config.js 擴充
  optimizeDeps: {
    exclude: ['onnxruntime-web', '@huggingface/transformers', 'tesseract.js'],
  },
  ```
- **Tesseract adapter 初始化（`src/lib/ocr/tesseract-adapter.js` 內，可貼）**：
  ```javascript
  import { createWorker } from 'tesseract.js';
  const worker = await createWorker(['eng'], 1, {
    workerPath: '/assets/ocr/worker.min.js',                        // tesseract.js/dist/worker.min.js
    corePath:   '/assets/ocr/core',                                 // tesseract-core-simd-lstm.wasm.js（+sse4/avx 變體，建置腳本自 tesseract.js-core 複製）
    langPath:   '/assets/ocr/lang',                                 // eng.traineddata.gz（tessdata_fast，gzip=true 為預設）
    gzip: true,
  });
  ```
- **public/assets/ocr/ 資產清單（R3-B 拆包實查 tesseract.js 7.x 同構）**：
  | 檔 | 來源 |
  |---|---|
  | `worker.min.js` | `node_modules/tesseract.js/dist/worker.min.js` |
  | `core/tesseract-core-simd-lstm.wasm.js` 等變體 | `node_modules/tesseract-core-simd-lstm/`（npm 依賴，postinstall 复制或手動入 public/） |
  | `lang/eng.traineddata.gz` | tessdata_fast eng（gzip 隨附） |
  複製步驟寫入 `package.json` script `"ocr:assets": "node tools/copy-ocr-assets.mjs"`（新檔 15 行 fs.cp）。

---

## 第7章 驗證計畫（含負控制與計時）

| 測試項目 | 測試步驟 | 預期結果 | 負控制（Negative Control）與計時方法 |
| :--- | :--- | :--- | :--- |
| **電腦端 (P1)** | 1. 於 UI 切換 OCR 引擎（Tesseract vs Paddle）<br>2. 匯入清晰英文單字圖<br>3. 執行辨識並點擊確認入庫 | 成功過濾垃圾 Token，候選單字正確寫入 `OCR Inbox` 且自動去重。 | **負控制 A**：餵食全黑圖片或純噪點圖。預期回傳 0 筆候選，不拋例外。<br>**負控制 B**：模擬 DB 寫入中斷（Mock 拋錯）。預期觸發 Rollback，回傳合規結構（實碼 store.js 既有行為如實回報或捕捉處理）。<br>**計時方法**：透過 `console.time('OCR')` 實測端到端耗時 < 3s。 |

---

## 第8章 分期實施

- **P1 最小可用（電腦端雙 Adapter 架構先行：Tesseract.js Adapter）**
  - **交付物**：`src/lib/ocr/` 介面與 Tesseract Adapter、`tools.js` 介面與選單、`svg.js` camera 圖示、`store.importOcrText`、`package.json`、`tauri.conf.json` CSP、`vite.config.js` 離線資產打包。
  - **工作量**：2.5 個工作天。
  - **驗收標準**：桌面版匯入圖片可在 3 秒內透過核心 Adapter 完成辨識並落入 `teno.db`。

- **P2 手機端與第二引擎實機支援**
  - **交付物**：Android 相機 / 相簿檔案上傳串接、PaddleOCR Adapter 接入與切換 UI。
  - **工作量**：2 個工作天。
  - **驗收標準**：Android 實機（Samsung A55）拍照選圖可正常入庫，且 OCR 區塊引擎選單可無痛切換並持久化。

- **P3 增值功能**
  - **交付物**：串接 Cambridge 字典自動補全定義。

---

## 第9章 風險、範圍外與候選清單

1. **APK 體積與記憶體**：
   - 引入完整本地 OCR 模型（如 Tesseract / Paddle 語言包）將大幅增加安裝包體積與運行記憶體消耗。
2. **辨識準確率預期管理**：
   - 手寫體、花體字或低畫質截圖辨識率低，使用者需有手動校正候選單字的心理準備。
3. **範圍外與 P3 候選功能（自 R1/R2 L11 移入）**：
   - **剪貼簿貼上 (Ctrl+V) / Bounding Box 視覺高亮 / 置信度閾值控制**：暫列為範圍外，列入 P3 候選增值功能排程。
   - 不支援即時影片串流 OCR（Live Camera Stream OCR）。
   - 不包含雲端付費 OCR API 串流（全走端側離線辨識）。


