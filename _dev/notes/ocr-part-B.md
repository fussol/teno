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
