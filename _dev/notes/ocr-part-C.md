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
