# OCR 辨識字功能實施計畫書 v1.0

> PM-OCR 產出（Gemini flash-lite 三階段，本地 qwen3-ocr64k A 軌並行覆核中）
> 調研證據包：_dev/notes/ocr-research-pack.md（curl 官方 repo 一手資料）
> 引擎結論：電腦 Tesseract.js ／ 手機 ML Kit Text Recognition v2

### 第1章 需求與操作流程

#### 電腦端流程
1. **觸發入口**：使用者於工具介面（Tools UI）點擊「OCR 辨識字」按鈕。
2. **影像匯入**：彈出選擇視窗，支援「本地檔案上傳（PNG / JPEG）」或「剪貼簿貼上（Ctrl+V）」。
3. **前處理與辨識**：前端呼叫 Web Worker 執行 OCR 引擎，載入英文字型訓練包（`eng`）。
4. **結果解析與分支**：
   - **成功且高置信度（>0.8）**：自動切出文字行（Element），列出單字候選清單供使用者勾選。
   - **多候選 / 模糊辨識**：標記黃色警告，顯示 Bounding Box 裁切預覽圖，讓使用者手動點擊修正或編輯文字。
   - **辨識失敗（置信度低或無文字）**：跳出提示「未偵測到有效單字，請重新截圖或手動輸入」，提供手動補全輸入框。
5. **入庫確認**：使用者確認單字及解析定義後，寫入 Teno SQLite 本地資料庫完成字卡建立。

#### 手機端（Android）流程
1. **觸發入口**：於 Tauri WebView 工具介面點擊「相機辨識」或「相册選圖」。
2. **硬體調用**：
   - 拍照：透過 Android Native Bridge 喚起手機相機拍下外文招牌/書本。
   - 選圖：開啟系統相簿選取截圖。
3. **引擎辨識**：影像傳入裝置端原生 OCR 引擎進行分析。
4. **分支處理**：
   - **正常辨識**：即時回傳辨識結果與文字座標。
   - **辨識失敗 / 低置信度**：於手機畫面上疊加提示框，允許使用者手動框選文字區域（Region of Interest）或切換相機補光。
5. **入庫確認**：檢視完整單字卡（詞性、定義、例句等），一鍵確認寫入本地 SQLite。

---

### 第2章 開源方案調研（≥4 案）

#### 1. AnkiDroid
- **做法**：開源 Android 應用，透過 Java/Kotlin 呼叫原生 Android 剪貼簿監聽、分享 Intent（Intent Filter），允許外部字典 app 直接拋送文字或圖片建立筆記。
- **引擎**：依賴 Android 系統原生 API 或 ML Kit（視版本而定）。
- **優缺點**：生態極度成熟、零額外打包體積負擔；但高度依賴行動作業系統原生支援。
- **可借鑑點**：Teno 可借鑑其「Share Intent / 外部 App 分享圖片至 Teno 辨識」的流暢體驗。
- **URL**：[GitHub - AnkiDroid](https://github.com/ankidroid/Anki-Android)

#### 2. Image Occlusion Enhanced for Anki
- **做法**：基於 Python 與 Anki Add-on 生态的影像遮罩外掛，讓使用者框選圖片特定區域轉為填空題。
- **引擎**：無內建 OCR，採純人工視覺遮罩。
- **優缺點**：互動直覺、針對圖形記憶極強；完全無法自動抓取文字。
- **可借鑑點**：其 UI 互動中的「圖片 Bounding Box 裁切與標記框選」邏輯，極適合移植到 Teno 的 OCR 介面中。
- **URL**：[GitHub - Image Occlusion Enhanced](https://github.com/glutanimate/image-occlusion-enhanced)

#### 3. Tesseract.js (WebAssembly) [待驗證]
- **做法**：將 C++ Tesseract 引擎透過 Emscripten 編譯為 WebAssembly，運行於瀏覽器 Web Worker 內，支援純 JS/TS 專案。
- **引擎**：Tesseract OCR Engine (LSTM)。
- **優缺點**：跨平台能力極強（電腦與手機 WebView 皆可跑），完全離線；但首載需下載 WASM 與語言包（體積較大），手機端效能受限於 JavaScript 執行緒。
- **可借鑑點**：Tauri v2 電腦端的首選離線方案，完全不需依賴 Rust 原生綁定。
- **URL**：[GitHub - Tesseract.js](https://github.com/naptha/tesseract.js)

#### 4. PaddleOCR / PP-OCRv6 [待驗證]
- **做法**：百度開源的超輕量級 OCR 系統，提供多種體積模型（Tiny / Small / Medium）以及最新 PaddleOCR-VL。
- **引擎**：PP-OCRv6 / PP-StructureV3。
- **優缺點**：中文與英文印刷體辨識率業界頂尖，支援多語言統一模型；但模型體積較大，直接嵌入 Tauri 移動端體積會顯著膨脹。
- **可借鑑點**：可作為未來若需雲端或伺服器端高效辨識時的對照基準引擎。
- **URL**：[GitHub - PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

---

### 第3章 OCR 引擎評估矩陣與推薦

| 評估維度 | Tesseract.js | ML Kit Text Recognition v2 | PaddleOCR (PP-OCRv6) | Cloud OCR API (對照組) |
| :--- | :--- | :--- | :--- | :--- |
| **離線與否** | 完备離線 (WASM) | 完备離線 (Android Native) | 可離線 (需 C++/Python 執行環境) | 線上 (Cloud REST API) |
| **中英準確率 (印刷體)** | 中等 (英文佳、中文一般) | 高 (Google 經年優化) | 頂尖 (SOTA 級別) | 頂尖 |
| **模型與 APK 體積增量** | 中等 (~5-15MB 語言包) | 小 (系統內建或微幅增加) | 大 (>30MB 模型檔) | 零 (無本地負擔) |
| **手機記憶體峰值** | 估計，待驗證 (~100-200MB) | 估計，待驗證 (~50-80MB) | 估計，待驗證 (>300MB) | 極低 (僅網路傳輸) |
| **延遲** | 中等 (~1-3s 依硬體) | 低 (<0.5s 設備加速) | 中等 (依模型大小) | 依網路狀況 (0.5-2s) |
| **授權條款** | Apache 2.0 | Google APIs Terms / Apache 2.0 | Apache 2.0 | 商業授權 / 按量計費 |
| **Tauri v2 整合方式** | WebView JS (Worker) | Android Native Bridge / Rust Plugin | Rust Native Plugin / Python Sidecar | WebView Fetch / Axios |
| **維護活躍度** | 高 (Maintained) | 高 (Google 官方維護) | 極高 (鼎盛開源社群) | 持續維護 |

#### 最終推薦結論
- **電腦端推薦**：**Tesseract.js**。一句話理由：純 JS/WASM 架構完美契合 Tauri v2 SPA 架構，開發成本最低且無須編譯複雜的 Rust/C++ 原生模組。
- **手機端推薦**：**ML Kit Text Recognition v2**。一句話理由：依賴 Android 裝置原生效能與極佳的準確率，APK 體積增量最小且離線反應速度最快。

session_id: 20260828_153526_dd5097

---

Oliver 正在幫你解析 Teno 專案的 PM-OCR 階段 B 任務需求，以下為你整理的 UI 掛載與互動設計。

---

### 第4章 UI 掛載設計

#### 1. tools.js 現有結構摘要
- **現有工具卡片與區塊**：
  - 學習分析 (`#toolsGoSimulator`, `#toolsGoAppLog`，引用自 `src/pages/tools.js` 的 `render(s)` 函式中：`<div class="card card-interactive" id="toolsGoSimulator" style="cursor:pointer">`)
  - 背景任務 (`#bgTaskSection`，引用自 `src/pages/tools.js`：`<div class="section" id="bgTaskSection">`)
  - 尋找重複 (`#issuesResult`，引用自 `src/pages/tools.js`：`<div class="section"><div class="section-title">${icon('search')} 尋找重複</div>`)
  - 拼字檢查、自動產生詞性、自動產生例句、自動抓取發音、自動產生相關詞、自動產生詞形變化、Cambridge 字典查詢。
- **渲染模式**：使用函式回傳 HTML 字串 (`render(s)`)，透過 `onMount(s)` 進行 DOM 事件綁定與狀態監聽。
- **事件綁定慣例**：全面採用 `addEventListener` 進行事件監聽（針對 WebKitGTK 相容性，在 `onMount` 結尾會自動將舊式的 `onclick` 轉換並移除屬性，引用自 `src/pages/tools.js` 底部：`document.querySelectorAll('button[onclick]').forEach(btn => { ... })`）。

#### 2. 新 OCR 工具的 HTML 骨架
請在 `src/pages/tools.js` 的適當區塊（例如 Cambridge 字典查詢上方或下方）插入以下 HTML：

```html
    <!-- OCR Recognize -->
    <div class="section">
      <div class="section-title">${icon('camera')} OCR 辨識字卡</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          透過相機或上傳影像辨識單字，並直接加入字本
        </div>
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2);flex-wrap:wrap">
          <button class="btn" id="ocrCaptureBtn">${icon('camera')} 拍照 / 選取影像</button>
          <input type="file" id="ocrFileInput" accept="image/*" capture="environment" style="display:none">
        </div>
        <!-- 辨識中狀態 / 預覽區 -->
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

#### 3. 互動狀態機 (State Machine)
- **`idle` (閒置)**：
  - DOM 變化：`#ocrResultArea` 隱藏 (`display: none`)。按鈕可用。
- **`capture` (擷取/上傳)**：
  - DOM 變化：點擊 `#ocrCaptureBtn` 觸發底層 `<input type="file" id="ocrFileInput">` 或 Tauri プラグイン 呼叫相機。
- **`recognizing` (辨識中)**：
  - DOM 變化：`#ocrResultArea` 顯示，內部 `#ocrLoading` 顯示 (`display: block`)，`#ocrCandidatesContainer` 隱藏。按鈕 Disable。
- **`candidates` (候選列表)**：
  - DOM 變化：`#ocrLoading` 隱藏，`#ocrCandidatesContainer` 顯示。將辨識結果動態渲染至 `#ocrCandidatesList`，每筆帶有 checkbox、單字文字與置信度（Confidence）。
- **`confirm` (確認送入)**：
  - DOM 變化：使用者勾選後點擊 `#ocrConfirmBtn`，呼叫 `s.actions.addWord(...)` 批次寫入字本，彈出 Toast 提示，並重置回 `idle` 狀態。
- **`error` (錯誤處理)**：
  - DOM 變化：若辨識失敗或無文字，`#ocrLoading` 隱藏，於 `#ocrResultArea` 顯示錯誤訊息（如「無法辨識影像文字」）。

#### 4. 電腦端 vs 手機端輸入來源差異
由於 Teno 同時運行於電腦端（Tauri / WebKitGTK）與手機端（Android / Tauri App），需透過能力偵測 (Capability Detection) 進行分支處理：

```javascript
// 能力偵測與來源分支
async function handleOcrCapture() {
  // 檢查是否為 Tauri 環境並可調用原生相機外掛
  const isTauri = window.__TAURI__ !== undefined;
  if (isTauri && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      // 路線 A：手機端透過 Tauri plugin 調用原生相機/相簿
      // const { scanImage } = await import('../lib/tauri-ocr.js');
      // const imagePath = await scanImage();
      // runOcrEngine(imagePath);
      document.getElementById('ocrFileInput').click(); // 暫時 fallback 至 file input 介面或原生外掛
    } catch (e) {
      console.warn('[OCR] Native camera failed, fallback to file input', e);
      document.getElementById('ocrFileInput').click();
    }
  } else {
    // 路線 B：電腦端直接開啟檔案選擇器 (<input type=file accept="image/*">)
    document.getElementById('ocrFileInput').click();
  }
}
```

#### 5. 掛載點：tools.js 插入位置與程式碼

- **修改前原文前後錨點**（位於 `src/pages/tools.js` 中 Cambridge 字典查詢區塊的上方）：
```javascript
    <!-- Generate Forms -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生詞形變化</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 為缺少詞形變化（過去式、-ing、-ed、派生名詞等）的單字自動生成
        </div>
        <button class="btn" onclick="window.__genFormsLLM()">${icon('sparkle')} 開始產生</button>
        <div class="tool-output" id="formsResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Cambridge Dictionary -->
    <div class="section">
      <div class="section-title">${icon('book')} Cambridge 字典查詢</div>
```

- **完整插入代碼**：
將 OCR 工具 HTML 插入在 **Generate Forms** 區塊之後、**Cambridge Dictionary** 區塊之前：

```javascript
    <!-- Generate Forms -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生詞形變化</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 為缺少詞形變化（過去式、-ing、-ed、派生名詞等）的單字自動生成
        </div>
        <button class="btn" onclick="window.__genFormsLLM()">${icon('sparkle')} 開始產生</button>
        <div class="tool-output" id="formsResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- OCR Recognize -->
    <div class="section">
      <div class="section-title">${icon('camera')} OCR 辨識字卡</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          透過相機或上傳影像辨識單字，並直接加入字本
        </div>
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2);flex-wrap:wrap">
          <button class="btn" id="ocrCaptureBtn">${icon('camera')} 拍照 / 選取影像</button>
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

    <!-- Cambridge Dictionary -->
    <div class="section">
      <div class="section-title">${icon('book')} Cambridge 字典查詢</div>
```

- **波及風險評估**：
  - 由於採用獨立的 DOM ID (`#ocrCaptureBtn`, `#ocrFileInput`, `#ocrResultArea` 等)，與現有的工具卡片完全隔離，**不會影響** `tools.js` 中現有的背景任務、拼字檢查、詞性/例句產生等任何既有函式或事件委派。

session_id: 20260828_151044_7c0b6a

---

### 第5章 資料流與整合

1. **辨識文字流向與單字候選**：
   - 透過 Tesseract.js（電腦端 P1）或行動端 OCR 引擎取得原始辨識出的字串（Raw Text）。
   - 經前端處理層進行 Tokenizer / Line splitter 切割出獨立候選單字清單（Candidates）。
   - 對每一個候選單字自動去空白、轉小寫（對齊現有 `addWord` 行為 `word.word.toLowerCase().trim()`）。

2. **送入現有新增單字路徑**：
   - 根據 `src/lib/store.js` 內的程式碼節錄：
     ```javascript
     async addWord(wordData) {
       const word = {
         id: nextWordId(),
         word: wordData.word.toLowerCase().trim(),
         ...
         createdAt: new Date().toISOString(),
       };
       state.words.push(word);
       try { await db.saveWord(word); } catch (e) { console.warn('[store] addWord saveWord error:', e); }
       await refreshDerived();
       notify();
       return word;
     }
     ```
   - 評定最正確入口為 **`store.importWords(words, onProgress)`** 或批次呼叫 **`db.saveWordsInTx(words)`**。理由：OCR 掃描常一次產出數十個候選單字，使用 `importWords` 既能自動檢查重複（`existing.has(w)`）、自動建立遺失的 Deck（`deckByName`），又能在底層使用單一 Transaction 批次寫入（`db.executeSQL('BEGIN TRANSACTION')`），大幅減少 IPC 呼叫與 SQLite 鎖定開銷。

3. **重複單字處理（對齊現狀）**：
   - 比對現有 `importWords` 邏輯：
     ```javascript
     const existing = new Set(state.words.map(w => w.word.toLowerCase()));
     if (existing.has(w)) { skipped++; continue; }
     ```
   - 辨識出的單字若已存在於全域 `state.words`，直接判定為重複並略過（`skipped++`），不重複插入。

4. **批量新增與交易考量**：
   - 參考 `src/lib/db.js` 的 `saveWordsInTx(words)`：
     ```javascript
     export async function saveWordsInTx(words) {
       const d = requireDB();
       await d.execute('BEGIN TRANSACTION');
       try {
         for (const w of words) await saveWord(w);
         await d.execute('COMMIT');
       } catch (e) {
         try { await d.execute('ROLLBACK'); } catch (_) {}
         throw e;
       }
     }
     ```
   - 採用 Transaction 包裹整批 OCR 候選字，確保中途若因記憶體或欄位例外崩潰時可完整 Rollback，維持 DB 一致性。

---

### 第6章 逐檔案修改清單

#### 1. 檔案：`src/lib/api.js`
- **函式**：新增 OCR 相關 IPC 介面（預留 Android / Tauri 端調用橋樑）
- **原文錨點**（結尾處）：
  ```javascript
  // ─── 官方 FSRS 模擬器 (fsrs-rs 6.6.1, 對齊 Anki 26.08) ───
  // mode: 'simulate' | 'workload' | 'optimal'
  export const simulateFsrs = (req) =>
    invoke('simulate_fsrs', { req })
  ```
- **完整可貼代碼**：
  ```javascript
  // ─── OCR 辨識支援 ──────────────────────────────────────────
  export const recognizeImage = (imagePath) =>
    invoke('recognize_image', { imagePath })
  ```
- **後果**：現有呼叫端無影響（新增獨立介面）。
- **回退方式**：直接刪除該段 export。

#### 2. 檔案：`src/lib/store.js`
- **函式**：擴充 store 引入 `importOcrText`
- **原文錨點**（`importWords` 函式結尾處）：
  ```javascript
        await refreshDerived();
        notify();
        return { added, skipped, decksCreated };
      },

      /** Edit a word */
  ```
- **完整可貼代碼**：
  ```javascript
      /**
       * Import OCR recognized words text array
       * @param {string[]} rawWords
       * @param {string} [deckName]
       */
      async importOcrText(rawWords, deckName = 'OCR Inbox') {
        const parsed = rawWords.map(w => ({
          word: w,
          definition: '',
          deck: deckName
        }));
        return await this.importWords(parsed);
      },
  ```
- **後果**：掛載於 store 狀態管理層供 UI 呼叫，現有 store 邏輯不受影響。
- **回退方式**：直接移除 `importOcrText` 函式。

#### 3. 檔案：`src-tauri/capabilities/default.json`
- **權限調整**：允許讀取本機檔案與相機（供 OCR 讀圖）
- **原文錨點**：
  ```json
    "permissions": [
      "core:default",
      "core:window:allow-set-fullscreen",
      "core:window:allow-is-fullscreen",
      "sql:default",
      "sql:allow-execute",
      "log:default",
      "dialog:default",
      "dialog:allow-save",
      "dialog:allow-open",
      "opener:default",
      "opener:allow-open-url"
    ]
  ```
- **完整可貼代碼**：
  ```json
    "permissions": [
      "core:default",
      "core:window:allow-set-fullscreen",
      "core:window:allow-is-fullscreen",
      "sql:default",
      "sql:allow-execute",
      "log:default",
      "dialog:default",
      "dialog:allow-save",
      "dialog:allow-open",
      "opener:default",
      "opener:allow-open-url",
      "fs:default",
      "fs:allow-read-file"
    ]
  ```
- **後果**：擴大 Tauri 檔案讀取權限，使前端能處理圖像檔案。
- **回退方式**：移除 `fs:default` 與 `fs:allow-read-file`。

---

### 第7章 驗證計畫

| 測試項目 | 測試步驟 | 預期結果 | 負控制（Negative Control） |
| :--- | :--- | :--- | :--- |
| **電腦端 (P1)** | 1. 於 UI 匯入清晰英文單字圖片<br>2. 執行 Tesseract.js 辨識<br>3. 呼叫 `importOcrText` | 成功產出候選單字並正確寫入 DB，UI 列表即時更新。 | 故意餵食全黑圖片或噪點圖。預期：回傳空集合或 0 added，不拋出未捕捉例外。 |
| **手機端 (P2)** | 1. 開啟 Android 相機拍攝外文招牌<br>2. 觸發原生 OCR 引擎辨識<br>3. 批量寫入預設 Deck | 順利轉入 `OCR Inbox`，重複單字正確略過（Skipped）。 | 餵食無文字的空白截圖。預期：跳出提示「未偵測到有效文字」，不中斷主流程。 |

---

### 第8章 分期實施

- **P1 最小可用（電腦端 Tesseract.js 全鏈路）**
  - **交付物**：前端整合 Tesseract.js、`store.importOcrText`、API 與 Capabilities 調整。
  - **工作量估計**：2 個工作天。
  - **可獨立驗證的驗收標準**：桌面版拖入英文截圖，系統可在 3 秒內完成辨識並整批落入 `teno.db` 的 `words` 表中。

- **P2 手機端引擎整合**
  - **交付物**：Android 原生 OCR 模組對接、相機/相册選取介面。
  - **工作量估計**：3 個工作天。
  - **可獨立驗證的驗收標準**：Android 實機（Samsung A55）點擊拍照可直接抓取文字並入庫。

- **P3 增值功能（多字分割、自動查詞）**
  - **交付物**：自動斷詞過濾、串接劍橋字典自動補全定義（`lookupCambridge`）。
  - **工作量估計**：2 個工作天。
  - **可獨立驗證的驗收標準**：OCR 辨識段落後，自動拆解並為每個單字背景補全定義與詞性。

---

### 第9章 風險與範圍外

1. **APK 體積與記憶體**：
   - 引入完整本地 OCR 模型（如 Tesseract traineddata）將大幅增加安裝包體積與運行記憶體消耗。
2. **辨識準確率預期管理**：
   - 手寫體、花體字或低畫質截圖辨識率低，使用者需有手動校正候選單字的心理準備。
3. **本次明確不做的事（範圍外）**：
   - 不支援即時影片串流 OCR（Live Camera Stream OCR）。
   - 不包含雲端付費 OCR API 串流（全走端側離線辨識）。

session_id: 20260828_151129_bebb30
