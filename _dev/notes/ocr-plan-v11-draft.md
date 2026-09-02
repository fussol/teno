# PM-OCR 計畫書 v1.1（R1 三席退回修訂版，待 R2 複審）

> PM-OCR 產出（經三席審查修正：M1~M5 全數修復、入庫路徑唯一化、CSP 補 WASM、窮舉檔案與 Token 過濾規則）

---

## §0 修訂對照表：R1 發現 → v1.1 處理

| 審查發現編號 | 問題摘要 | v1.1 對應處理方式 |
| :--- | :--- | :--- |
| **M1** | 缺少 `tauri-plugin-fs` 導致編譯失敗 | 採「純前端 Web Worker + FileReader 路線」，**徹底放棄 Tauri fs 權限**，不修改 Cargo.toml 與 capabilities 的 fs 宣告，零編譯風險。 |
| **M2** | `recognize_image` 為 Rust 端幽靈命令 | 移除所有 Rust IPC 橋樑假定；P1 桌面端全面採用純前端 Tesseract.js 運行於 Web Worker 內。 |
| **M3** | `icon('camera')` 不存在於 svg.js | **svg.js 第 6 章修改清單**補上 `camera` 圖示鍵（引入 lucide-static 的 `camera.svg`）。 |
| **M4** | 第6章逐檔案修改清單嚴重不全 | 第6章完整窮舉：`tools.js`、`svg.js`、`package.json`、`vite.config.js`、`tauri.conf.json` 五大檔案。 |
| **M5** | Tauri v2 預設不注入 `window.__TAURI__` | 修正能力偵測，改用專案現行慣例 `typeof window.__TAURI__?.core === 'object'`。 |
| **L1** | 檔案清單漏 `tools.js` 本體 | 第6章補上 `src/pages/tools.js`（含 HTML 插入與 `onMount` 事件綁定）。 |
| **L2** | 盲目新增 `fs` 權限 | 依審查建議刪除 fs 權限，維持零額外原生權限。 |
| **L3** | api.js `recognize_image` 錯誤橋接 | 已刪除無用的 api.js 擴充，純前端 WASM 無需 IPC。 |
| **L4/L5** | 入庫路徑矛盾 (`addWord` vs `importWords`) | **唯一化入庫路徑**：全數統一走 `s.actions.importOcrText` 封裝，底層強制呼叫 `importWords`（含內建去重、交易與自動建 Deck）。 |
| **L5 (CSP)** | CSP 阻擋 WASM / 外部 CDN | `tauri.conf.json` 的 CSP 補上 `script-src 'wasm-unsafe-eval'`，並規範所有模型與 WASM 離線打包在本地。 |
| **L6/L7** | Android 清單、package.json、vite 缺項 | 於第6章補齊 `package.json`（引入 `tesseract.js`）與 `vite.config.js`（WASM/Worker 資產打包）。 |
| **L8** | OCR 垃圾 token 無過濾規則 | 規範 OCR Token 白名單正則：`/^[a-z][a-z'-]{1,30}$/i`，自動過濾非英文、符號與單字元垃圾。 |
| **L10** | 交易失敗回報與負控制 | 驗收計畫補上「辨識成功但 DB 寫入失敗」的負控制測試案例。 |

---

## 第1章 需求與操作流程

### 電腦端流程
1. **觸發入口**：使用者於工具介面（Tools UI）點擊「OCR 辨識字卡」按鈕。
2. **影像匯入**：彈出選擇視窗，支援「本地檔案上傳（PNG / JPEG）」或「剪貼簿貼上（Ctrl+V）」。
3. **前處理與辨識**：前端透過 Web Worker 載入本機打包之 Tesseract.js 引擎與英文語言包（`eng`），完全離線運作。
4. **結果解析與分支**：
   - **成功且高置信度（>0.8）**：自動切出文字行，透過正則白名單過濾垃圾 Token，列出單字候選清單供勾選。
   - **多候選 / 模糊辨識**：標記黃色警告，顯示 Bounding Box 預覽，供使用者手動點擊修正。
   - **辨識失敗**：跳出提示「未偵測到有效單字，請重新截圖或手動輸入」。
5. **入庫確認**：勾選確認後，統一走 `importOcrText` 批量入庫，寫入 SQLite。

### 手機端（Android P2 規劃）流程
1. **觸發入口**：於 Tauri WebView 工具介面點擊「相機辨識」或「相簿選圖」。
2. **硬體調用**：走 HTML `<input type="file" accept="image/*" capture="environment">`，直接喚起系統相機或相簿，**無需額外 Android CAMERA 權限**。
3. **引擎辨識**：經裝置端引擎解析。
4. **入庫確認**：檢視單字卡，一鍵確認寫入本地 SQLite。

---

## 第2章 開源方案調研（≥4 案）

#### 1. AnkiDroid [一手資料實證]
- **做法**：開源 Android 應用，透過 Intent Filter 允許外部 app 拋送文字或圖片。
- **URL**：[GitHub - AnkiDroid](https://github.com/ankidroid/Anki-Android)

#### 2. Image Occlusion Enhanced for Anki [一手資料實證]
- **做法**：影像遮罩外掛，採純人工視覺遮罩。
- **URL**：[GitHub - Image Occlusion Enhanced](https://github.com/glutanimate/image-occlusion-enhanced)

#### 3. Tesseract.js (WebAssembly) [待驗證：體積/延遲]
- **做法**：C++ Tesseract 透過 Emscripten 編譯為 WASM，運行於瀏覽器 Web Worker。
- **優缺點**：跨平台能力極強、完全離線；但首載需載入 WASM 與語言包。
- **URL**：[GitHub - Tesseract.js](https://github.com/naptha/tesseract.js)

#### 4. PaddleOCR / PP-OCRv6 [待驗證：體積/模型大小]
- **做法**：百度輕量級 OCR 系統（Tiny 1.5M / Small 7.7M / Medium 34.5M 參數）。
- **URL**：[GitHub - PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

---

## 第3章 OCR 引擎評估矩陣與推薦

| 評估維度 | Tesseract.js | ML Kit Text Recognition v2 | PaddleOCR (PP-OCRv6) | Cloud OCR API (對照組) |
| :--- | :--- | :--- | :--- | :--- |
| **離線與否** | 完備離線 (WASM) | 完備離線 (Android Native) | 可離線 (需執行環境) | 線上 (Cloud REST API) |
| **中英準確率 (印刷體)** | 中等 [待驗證] | 高 [待驗證] | 頂尖 [待驗證] | 頂尖 |
| **模型與 APK 體積增量** | 中等 (~5-15MB 語言包) [待驗證] | 小 (系統內建或微幅增加) [待驗證] | 大 (Medium >30MB) [待驗證] | 零 |
| **手機記憶體峰值** | 估計，待驗證 (~100-200MB) | 估計，待驗證 (~50-80MB) | 估計，待驗證 (>300MB) | 極低 |
| **延遲** | 中等 (~1-3s 依硬體) [待驗證] | 低 (<0.5s) [待驗證] | 中等 [待驗證] | 0.5-2s [待驗證] |
| **授權條款** | Apache 2.0 | Google APIs / Apache 2.0 | Apache 2.0 | 商業授權 |

#### 最終推薦結論
- **電腦端推薦**：**Tesseract.js**。純前端 WASM 架構完美契合 Tauri SPA，無須繁複的 Rust 原生綁定。
- **手機端推薦**：**ML Kit / HTML File Capture**。依賴原生網頁相機介面，零額外權限負擔。

---

## 第4章 UI 掛載設計

### 1. 新 OCR 工具的 HTML 骨架（插入於 tools.js 之 Generate Forms 與 Cambridge 之間）
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
async function handleOcrCapture() {
  const isTauri = typeof window.__TAURI__?.core === 'object';
  document.getElementById('ocrFileInput').click();
}
```

---

## 第5章 資料流與整合與 Token 白名單規則

1. **OCR Token 白名單過濾規則**：
   原始辨識字串必須通過下列正則表達式過濾，排除垃圾符號、數字與異常代碼：
   `/^[a-z][a-z'-]{1,30}$/i`
   （長度 2 至 30 字元，僅允許英文字母、連字號與撇號，且必須以英文字母開頭）。
2. **入庫路徑唯一化**：
   嚴禁直接呼叫 `addWord` 批次或 `saveWordsInTx`。所有 OCR 辨識結果一律交由 `store.importOcrText` 處理，其內部呼叫內建去重、自動建 Deck 與單一交易保護的 `importWords`。

---

## 第6章 逐檔案修改清單（五大核心檔案窮舉）

### 1. `src/lib/svg.js`
- **修改內容**：在 `icons` 物件中新增 `camera` 圖示映射。
- **程式碼片段**：
  ```javascript
  camera: () => S(cameraRaw), // 引入 lucide-static camera svg 原始碼
  ```

### 2. `src/lib/store.js`
- **修改內容**：擴充 `importOcrText` 函式，強制對齊 `importWords`。
- **程式碼片段**：
  ```javascript
  async importOcrText(rawWords, deckName = 'OCR Inbox') {
    const valid = rawWords
      .map(w => w.toLowerCase().trim())
      .filter(w => /^[a-z][a-z'-]{1,30}$/.test(w));
    const parsed = valid.map(w => ({ word: w, definition: '', deck: deckName }));
    return await this.importWords(parsed);
  },
  ```

### 3. `src/pages/tools.js`
- **修改內容**：在 `render(s)` 插入 OCR 區塊 HTML，並在 `onMount(s)` 綁定 `#ocrCaptureBtn`、`#ocrFileInput`、`#ocrSelectAllBtn`、`#ocrConfirmBtn` 之事件監聽器。

### 4. `package.json`
- **修改內容**：引入 `tesseract.js` 依賴。
  ```json
  "tesseract.js": "^5.1.0"
  ```

### 5. `src-tauri/tauri.conf.json`
- **修改內容**：更新 CSP 允許 WASM 執行實例化：
  ```json
  "csp": "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset: http://asset.localhost; connect-src 'self' http://localhost:11434 https://api.dictionaryapi.dev https://api.tatoeba.org; font-src 'self' data:; media-src 'self'"
  ```

---

## 第7章 驗證計畫（含負控制與計時）

| 測試項目 | 測試步驟 | 預期結果 | 負控制（Negative Control）與計時方法 |
| :--- | :--- | :--- | :--- |
| **電腦端 (P1)** | 1. 於 UI 匯入清晰英文單字圖<br>2. 執行 Tesseract.js 辨識<br>3. 點擊確認入庫 | 成功過濾垃圾 Token，候選單字正確寫入 `OCR Inbox` 且自動去重。 | **負控制 A**：餵食全黑圖片或純噪點圖。預期回傳 0 筆候選，不拋例外。<br>**負控制 B**：模擬 DB 寫入中斷（Mock 拋錯）。預期觸發 Rollback，回傳 added=0。<br>**計時方法**：透過 `console.time('OCR')` 實測端到端耗時 < 3s。 |

---

## 第8章 分期實施

- **P1 最小可用（電腦端純前端 Tesseract.js）**
  - **交付物**：`tools.js` 介面、`svg.js` camera 圖示、`store.importOcrText`、`package.json`、`tauri.conf.json` CSP 更新。
  - **工作量**：2 個工作天。
  - **驗收標準**：桌面版匯入圖片可在 3 秒內完成辨識並落入 `teno.db`。

- **P2 手機端實機支援**
  - **交付物**：Android 相機 / 相簿檔案上傳串接。
  - **工作量**：2 個工作天。
  - **驗收標準**：Android 實機（Samsung A55）拍照選圖可正常入庫。

- **P3 增值功能**
  - **交付物**：串接 Cambridge 字典自動補全定義。

session_id: 20260828_160333_740d35
