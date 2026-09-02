# OCR 優化合理化設計計劃書（OCR-OPTIMIZE-plan）

> 任務：PM-OCR2（計劃書專員）｜範圍：`src/pages/ocr.js`、`src/lib/store.js`、`src/lib/ocr-blacklist.js`
> 性質：**純計劃書**，不動 code。此文件為 docs，可 commit（不升版）或待總統審後再動工。
> 基線：`~/teno` main branch（HEAD 依實際 `git log`，行號為動工前實錘）。審查與動工前提：本計劃書送總統審核，不留委外跳過。
> 三痛點（2026-08 最高層口述）：①螢光筆模式無實質區別 ②手機框選難用 ③黑灰名單重疊字無可見控制權。

---

## 0. 調查摘要與實錘更正

### 0.1 讀過的檔案
| 檔案 | 關鍵段落 | 實錘行號 |
|---|---|---|
| `src/pages/ocr.js` | render 模式按鈕 | :66-70 |
| `src/pages/ocr.js` | 模式切換＋持久化 | :221-238（:222 `_mode`、:236 `setSetting('ocrMode')`） |
| `src/pages/ocr.js` | 切割 pointer 拖曳 | :245-290 |
| `src/pages/ocr.js` | 辨識＋highlight 過濾 | :334-441（:367-371 highlight 信心閾值） |
| `src/pages/ocr.js` | 候選 render + 入庫 | :429-433、:449-479 |
| `src/lib/store.js` | ocrMode 持久化還原 | :435 |
| `src/lib/store.js` | isBlacklisted / isGraylisted | :1232-1235、:1255-1258 |
| `src/lib/store.js` | importWords 黑灰過濾 | :1362（`_bl`/`_gl` 擋 + `blacklisted++`） |
| `src/lib/store.js` | importOcrText blSet 剔除 | :1440-1449 |
| `src/lib/store.js` | addToGraylist | :1261-1268 |
| `src/lib/ocr-blacklist.js` | DEFAULT_BLACKLIST / normalizeBlackWord | :57-61、:64-65 |

### 0.2 【重要】任務書與實際 code 的偏差（實錘更正）
任務書 §3 描述「重疊字在候選 render 被過濾，完全不顯示」。**實錘結果：此描述不準確。**

- `ocr.js:429-433` render 端對 `finalTokens` **全部**顯示，**完全沒有**呼叫 `isBlacklisted` / `isGraylisted`、沒有黑灰過濾。
- 真正的剔除在**入庫層**：
  1. `store.js:1440-1449` `importOcrText` 用 `blSet = blacklist ∪ graylist`，把與黑灰名單重疊的字 `blacklisted++; continue`（根本不送進 result）。
  2. `store.js:1362` `importWords` 再擋一次 `state.blacklist.includes(w) || state.graylist.includes(w)`。
- **UI 行為**（`ocr.js:450-473`）：重疊字**會在候選清單顯示**，勾選後送 `importOcrText(picked)`，但入庫時被靜默剔除；`res.blacklisted` 沒被 render，使用者看到「已加入 X 字」卻不知道哪些被擋、也無強制加入途徑。

→ 使用者痛點的真實癥結：**重疊字雖顯示，但入庫被靜默剔除＋無 override 途徑，等於喪失控制權、勾了等於沒勾、連被擋多少都不知道**。故本計劃書按「重疊字仍可見（維持現狀）＋標示遮蔽狀態＋可強制加入 override」設計，而非「顯示被擋」。（若總統確認要改 render 端也隱藏重疊字，見 §C 範圍外 ③。）

---

## A. 痛點① — 螢光筆模式無實質區別（已改寫為「實體螢光筆顏色過濾」）

### A.0 總統裁示（2026-08-30，取代原 A-1）
使用者親述需求（開源社群兩路線，採**路線一**）：**「只辨識被（實體）螢光筆劃線標記的文字，其餘背景/內文忽略」**。
- **不是**「螢幕用螢光筆視覺標記去篩選 OCR 結果」——那是無先例的過度設計（原本 A-1 全砍）。
- **是**「拍照 → 用 OpenCV 式 HSV 顏色過濾找出螢光筆（黃/綠/粉）色彩 mask → 裁剪出螢光區域 → 只把那些區域丟給 OCR 引擎辨識」。
- 對照組：MakeACopy（PaddleOCR+Tesseract）、OpenOCR——皆離線、內建螢光筆區域偵測＋裁切。

### A.1 現況（實錘）
- `ocr.js` 辨識 pipeline（現況「螢光筆」只是信心閾值，功能等於沒有）：
  - 模式切換：`:66-70`（scan=全掃描 / highlight=螢光筆），持久化 `ocrMode`（:222/:236，store.js:435）。
  - 取圖→切割：`:245-290`，`cropToFile` 裁切（:304）。
  - 辨識：`:348-350` `getActiveEngine()` → `engine.recognize(cropFile)`。
  - highlight 過濾：`:367-371` 只有 `confidence>=50`，過濾空還回退 → **等同無過濾**。
- **引擎抽象（關鍵，讓路線一好落地）**：`src/lib/ocr/engine.js` 是可插拔 `OcrEngine` 介面——`recognize(file, opts)` 吃 `File|Blob` 回 OcrResult；registry 現有 `tesseract`（`tesseract-adapter.js`，離線 WASM）、`paddle`。→ 螢光筆前處理可在 **`cropFile` 餵給 `recognize` 前**做，對任何引擎都通用。

### A.2 痛點
1. 現在「螢光筆模式」＝信心閾值，使用者感受不到「只抓畫線的部分」，等於沒有這個功能。
2. `confidence>=50` 黑箱、不可調、「過濾空回退」＝有時根本沒過濾。
3. 使用者真實需求是「**實體螢光筆畫過的字才辨識**」——現況完全做不到。

### A.3 候選方案＋取捨（實體螢光筆偵測，開源兩路線）
| 方案 | 描述 | 優點 | 缺點 | 取捨 |
|---|---|---|---|---|
| **A-1′ HSV 顏色過濾前處理（路線一，裁示定案）** | 辨識前對圖做 HSV（或 HSL）顏色過濾：定義螢光黃/綠/粉的色相範圍 → 建 mask → 找 `findContours`/boundingRect → 裁螢光區域 ROI → 把 ROI 併成新圖（或逐 ROI 餵引擎）→ 只辨識畫線文字 | 完全對應使用者需求；開源主流做法；離線、無外部依賴 | 需在 web 端實作色彩過濾（canvas 像素級）；顏色範圍要可調（不同螢光筆色差） | ✅ 正是使用者要的「只辨識螢光標記」 |
| A-2 亮度/飽和度門檻 | 只用飽和度/亮度過濾找出「明顯染色」區域 | 實作更簡 | 誤判率高（泛黃紙張、陰影） | ❌ 會被背景干擾 |
| A-3 直接套現成 App（MakeACopy/OpenOCR 嵌入） | 改用/嵌入現成開源掃描 App | 功能現成 | 換核心、非離線整合進 Tauri 骨架；侵入大 | ❌ 不符合「輕量、離線、夠用」偏好 |

**定案：A-1′（HSV 顏色過濾，路線一）。**

### A.4 建議方案詳細設計（A-1′）
**核心**：新增一個「螢光筆前處理」層，放在 `cropFile` 產生後、`engine.recognize()` 前。highlight 模式才觸發；scan 模式原樣整張。

1. **前處理函式（新增 `tools/` 或 `src/lib/ocr/` 純函式）** `filterHighlighter(imgData/image, colorRange) → {roi: File, count: number, boxes}`：
   - 讀圖 → draw 到 `<canvas>` → `getImageData` 逐像素轉 HSV（JS 內建換算）。
   - 建 mask：色相落在螢光黃(20-35)/綠/粉 ± 範圍 + 飽和度/明度門檻 → 像素保留。
   - `findContours`／連通域＝網頁端可用 `getImageData` 的 bbox 掃描（做水平/垂直投影找連續區塊，免 OpenCV WASM——保持輕量離線）。
   - 裁每個 ROI（原圖裁切，含螢光底下的字），組合成一張並排新 canvas → `canvas.toBlob('image/png')` → 當 File 餵引擎。
2. **顏色 UI**：highlight 模式顯示「螢光筆顏色」選擇（黃/綠/粉，各色相範圍可微調）＋「啟用」開關。範圍存 setting（`ocrHighlightColor`），可調以適不同筆。
3. **落點**：`ocr.js` :350 `engine.recognize(cropFile)` 前，`if (_mode === 'highlight') cropFile = await filterHighlighter(cropFile, color)`。
4. **整合問題（實錘）**：`cropToFile` 已裁使用者的切割框（:304）；若「先切割再過濾」，只掃切割框內螢光區 → 合理（使用者先框選，再只認框內畫線字）。
5. **不變式**：mask 全空 → 保留原圖（提示「未偵測到螢光區域」），避免誤吞整張。

### A.5 驗證方式
- **harness（`tools/verify-ocr2-highlightfilter.mjs`）**：
  - 純函式測 HSV 轉換＋mask：給一張含「I said yes 螢光黃高亮 + 其餘黑白」的合成 canvas → filterHighlighter 回 count>0、ROI 限定在黃色區。
  - 純函式測顏色範圍：黃色像素在範圍內 (mask=1)、灰色/白背景像素在範圍外 (mask=0)。
  - **負控制**：把色相範圍設成完全不匹配（例如色相 300 紫但圖只有黃）→ mask=0 → filter 回原圖 → 精準重現「沒過濾＝整張辨識」原狀。
  - 端到端 mock engine.recognize 收到 clipFile 是「過濾後」的（非原圖 size）。
- **browser 實跑**：畫一張黃色螢光筆標記的圖 → highlight 模式 → 只辨識出畫線的字；scan 模式辨識全圖。手機實測螢光筆拍圖。

### A.6 風險
- 色彩範圍因螢光筆廠牌色差 → 用可調色相範圍 + 提供 3 種常見色預設；掃描影像白平衡會影響 → 用相對範圍（飽和度高 + 色相窄）降低誤判。
- Web 端 HSV 逐像素處理大量像素 → 用 canvas getImageData 單次取、一次迴圈，避免頻繁繪圖；限制在切割框內大小（通常已縮小）。
- 螢光底下的字對比度 → ROI 裁到原圖（非 mask），讓 OCR 讀到筆上壓的字。

---

## B. 痛點② — 手機框選難用（已重新裁示為「切割按鈕 + 拖四點成型」）

### B.0 總統裁示（2026-08-30，取代原 B-1 信方案）
使用者重設計切割的完整 UX，**取代**原計劃書 B-1「九宮格預設框」：
1. **預覽圖純預覽**：載圖後預覽階段圖就是純瀏覽（可正常向下滑動，不鎖 touch-action），干擾滑動的切割互動**不在預覽圖上做**。
2. **切割按鈕**：新增「切割」按鈕，按下後**才**進入切割介面；未進入前預覽圖不綁任何 pointer 切割事件 → 手機向下滑頁不再被選取區影響。
3. **拖四點成型**：切割介面裡拖曳**四個角點 handle**，四個點連成的形狀＝切割範圍（同時定位置與形狀），不只固定軸向矩形 — 可任意四邊形。
4. 進入切割介面後仍要能退出回預覽（取消/完成）。

### B.1 現況（實錘）
- 切割互動：`ocr.js:245-290`。wrap 上 `pointerdown/move/up/leave`（:266-290），`dispPos`（:247-256）同時處理 touch（`touches[0]`）。
- **明確短板**（實錘 code／註解）：
  - 切割 pointer 事件直接綁在圖 wrap 上、onMount 即生效 → **一進 OCR 頁就鎖 scroll（`touch-action:none` :43）**，手機向下滑動被吃。
  - `:285` 自承「可拖右上角微調（**尚未實作**），直接再拖重畫」——拖完不能微調，準頭差就整個重畫。
  - 現況單一矩形拖曳，無四角 handle、無放大鏡/吸附。
- 目前修復 startover：`clearBtn`（:293-298）清除。

### B.2 痛點
1. 預覽圖直接綁切割 pointer 事件＋`touch-action:none`（:43）→ **進 OCR 頁就鎖 scroll**，手機向下滑頁被吃（使用者親述首要痛點）。
2. 不可預期的切割：一進頁就要切、沒有「我要切了」的明確意圖門檻，誤觸容易。
3. 單一矩形拖曳一次到底、不能微調（:285 自承）；無四角控制。

### B.3 候選方案＋取捨（依總統裁示 B.0，新方案）
| 方案 | 描述 | 優點 | 缺點 | 取捨 |
|---|---|---|---|---|
| **B-1′ 切割按鈕＋拖四點成型（裁示定案）** | 預覽純瀏覽可滑動；按「切割」進切割介面；介面內拖**四角 handle**，四點連線成形（任意四邊形，定位置+形狀） | 直接解「影響滑動」；四點精準；與預覽分離不誤觸 | 需重寫切割 UI＋狀態機（預覽/切割兩態） | ✅ 完全對應總統裁示 |
| B-2 放大鏡＋拖放容錯 | 拖曳時放大鏡，放開可拖四角微調 | 精準 | 放大鏡在 WebKitGTK/blob 限制性能要顧；仍綁預覽圖未解滑動 | ❌ 滑動問題沒解，且成本高 |
| B-3 自訂尺寸輸入 | 直接輸入像素寬高 | 精準 | 手機打字違反直覺 | ❌ |

**定案：B-1′（切割按鈕 + 拖四點成型）。**

### B.4 建議方案詳細設計（B-1′）
**切割兩態狀態機**（`ocr.js` 新增 `_cropMode: 'preview' | 'cutting'`，預設 `preview`）：
1. **預覽態（preview，預設）**：
   - 預覽圖 wrap **不綁任何切割 pointer 事件**；`touch-action` 回歸可捲動（頁面正常向下滑）——手機滑頁不再被吃。
   - 只顯示「切割」按鈕（`ocr-crop-row` 內新增黃/accent 鈕）。
2. **切割態（cutting）**：按「切割」→ 進入。
   - **四角 handle**：overlay 顯示 4 個圓形 handle（左上/右上/右下/左下），各自 `pointerdown/move/up` 只改對應角座標；四點連線（多邊形 fill）即切割範圍。
   - **任意四邊形支援**：四角各自獨立 x/y → 形狀可非軸向矩形（梯形/斜邊），`cropToFile` 需改用四角原圖座標做透視/取最緊貼矩形或實際多邊形裁切（動工時確認 `:304` cropToFile 現行實作是軸向矩形還是 poly）。
   - **退出**：「完成」確認（回 preview 並保留切割）／「取消」回 preview 不保留。
3. **座標映射**：handle 拖在顯示座標系 → 完成時映射回原圖 px（`Math.round(px * (_imgW/dispW))`，沿用 :264 dimLabel 映射）。
4. **不設放大鏡**（B-2 欄到範圍外⑤）。

### B.5 驗證方式
- **harness（`tools/verify-ocr2-crop.mjs`）**：
  - 純函式測四角座標映射：拖動 handle 後 → 顯示座標→原圖 px 換算正確、四點不越界。
  - 純函式測「預覽態不綁事件」：`_cropMode==='preview'` 時切割 pointer 處理常式不存在（或 guard 拒絕），`touch-action` 非 none → 重現「可正常滑動」。
  - **負控制**：把 `_cropMode` 預設改回 `cutting`（剝離分離）→ 預覽態又鎖 scroll → 精準重現「進 OCR 頁影響滑動」原 bug。
- **browser 實跑**：手機視口載圖 → 預覽態正常向下滑動（不被切割吃事件）→ 按「切割」→ 出現四角 handle、拖曳成形 → 完成回預覽。

### B.6 風險
- 改動切割狀態機較大 → 只 ocr.js 內改；split 純函式（handle 座標計算 / 映射）供 harness。
- 四邊形裁切若 cropToFile 現行只吃軸向矩形 → 需確認是否透視裁切；若維持矩形，四角視為矩形邊界（取 minX/minY/maxX/maxY）——動工時實錘。
- 預覽態可滑動但切割須按鈕二步 → 多一步，但換來不誤觸、不卡滑動，符合裁示。

---

## E′. 新增 Vision AI 引擎（可插拔 registry，desktop-only）

> 使用者（2026-08-30）：「我覺得引擎可以再加一個 vision ai，當然這只有電腦版有。」
> 性質：新功能 engine 新增（非 bug）。利用既有可插拔 `OcrEngine` registry + 既有的本機 Ollama 整合。

### E′.1 現況（實錘，讓它貼合現有架構）
- **可插拔 OCR registry**：`src/lib/ocr/engine.js` 統一 `OcrEngine` 介面 `recognize(file, opts)`；現有 `tesseract`（離線 WASM）、`paddle`。加一個 vision adapter 只需 `registerEngine('vision-ai', factory)`。
- **既有 Ollama 整合**：
  - `fetchLLM(url, model, prompt, apiFormat)`（api.js:12）走 Rust `fetch_llm` — 只吃純文字 prompt，**不帶圖**。
  - `ollamaUrl`（預設 `http://localhost:11434`）、`ollamaModel`（state 預設 qwen2.5-coder:7b）、`api.js` 有 invoke 層。
  - settings.js:443 已題「桌面部屬可設 e.g. **qwen3-ocr64k**」→ 使用者已有 vision OCR 模型的認知。
  - ocr.js :397 `s.state.ollamaUrl` 已在本機 OCR 補強用。
- **關鍵 gap**：現有 `fetch_llm` Rust endpoint 不能帶圖。Vision OCR 需要**把圖片 base64 送給本機 vision model**（ollama `/api/generate` 或 `/api/chat` 的 `images: ["data:image/...;base64,..."]`）。

### E′.2 方案設計
1. **新增 engine adapter `src/lib/ocr/vision-adapter.js`**（desktop UMD，pattern 仿 tesseract-adapter.js）：
   - `available()`：desktop-only 判定 + ollama 可連（`s.state.ollamaUrl` 非空、可 ping）。
   - `recognize(file, opts)`：讀圖 → `FileReader`/canvas → base64 data URL → 呼叫本機 vision model → 回 OcrBlock[]（text/confidence/bbox 可選）。
2. **送圖能力（兩擇一）**：
   - **A. 前端直連 ollama**（最簡、無 Rust 改動）：`fetch(url + '/api/chat', { body: JSON.stringify({ model, messages:[{role:'user', content, images:[b64]}], stream:false }) })`。Tauri CSP 需允許 `connect-src http://localhost:11434`。
   - **B. 擴充 Rust `fetch_llm` 帶 base64 image**（侵入較大，動 lib.rs + 參數）。優先 A 若 CSP 允許。
3. **desktop-only 判定**：`isDesktop`（tauri 環境 vs WebView 手機）— 用 env / platform check；手機仍回 `available()=false`。
4. **引擎選單**（ocr.js :87 engineSelect）：`listEngines()` 自動列出 `vision-ai`；手機上因 `available()` false → 選單可隱藏或標「桌面」。
5. **model 設定**：可沿用 `ollamaModel` 或獨立 `ocrVisionModel` setting（預設 `qwen3-ocr64k`）。

### E′.3 驗證
- harness（`tools/verify-ocr2-vision.mjs`）：mock ollama 回傳 → adapter 回 OcrBlock 結構正確、base64 圖有送達。
- desktop browser：engineSelect 出現 vision-ai、選後可辨識本機模型、base64 正確送出。
- 手機：`available()` false → 選單不顯示或標桌面限定。

### E′.4 風險
- 送圖走 front-end fetch → 需 CSP connect-src；若被擋，改擴充 Rust fetch_llm。
- qwen3-ocr64k 是否 install 在本機 → available() 需偵測 model 存在。
- vision model 回傳格式（純文字 vs JSON）→ adapter 解析。

---

## D′. 入庫自動填欄位（總統裁示新增：放入字庫時自動填滿）
> 使用者親述：「放入字庫中時，那些字都要被自動填入。」搭配「測驗/學習背面要完整單字卡」既有需求 → OCR 入庫的每個字要自動填齊欄位，且 UI 同步反映。

### D′.1 現況（實錘）
- **已有 `enrichOcrWords`**（store.js:1307-1336）：OCR 入庫後 fire-and-forget（:1478）背景查 Cambridge 填 **pos/pron/definition/examples/example**。
- **三個致命瑕疵**讓使用者「看不到在填」：
  1. **fire-and-forget＋不刷新**：入庫 UI 不同步，使用者當場看到空白卡；關掉/換頁後才補上 → 名存實亡的「自動填」。
  2. **只填空欄**：`if (!w.definition …)`（:1321）——除非欄位空，否則不覆寫；OCR 殘缺值沿用。
  3. **只取 senses[0]**：單一 sense，欄位不完整。

### D′.2 建議方案
1. **UI 同步**：入庫後 `await` enrich 完成（或在入庫流程加「補齊中」狀態/最後統一 notify 刷新），讓使用者看到的是填好的卡，不是空白。
2. **覆寫策略**：`enrichOcrWords` 加參數 `overwrite`（預設填齊定義/examples；pos/pron 保守不覆寫已有）。目標：入庫的字**定義/例句/發音/詞性盡量都齊**（配合完整單字卡需求）。
3. **多 sense 合併**：不只 senses[0]，把各 sense 的 definition/examples 匯總（或至少取到填滿），definition 多義用逗號/分號併。
4. **失敗回報**：enrich 失敗的字留待可重試，不入庫就空白；UI 可提示「N 字補充完成/失敗」。

### D′.3 驗證
- harness（`tools/verify-ocr2-enrich.mjs`）：mock lookupCambridge 回傳多 sense → 斷言 pos/pron/definition/examples/example 全填、覆寫策略正確。
- **負控制**：把 overwrite 參數移除 → 填空欄行為重現（殘缺值不覆寫）。
- browser：OCR 入庫 → 卡即顯示完整欄位。

---

## F′. 匯入來源擴充：匯入檔案（多圖 / PDF / 文字檔，文字檔 fast-path 跳過 OCR）

> 使用者（2026-08-30）：「匯入圖片改成匯入檔案，可以匯入複數個圖片、或是 pdf、或是任何文字檔。如果是文字檔就不走 OCR 直接去到下一步抓取單字、篩選。」

### F′.1 現況（實錘）
- **取圖介面現在只吃單張 image**：
  - `ocrCameraInput`（ocr.js:81）`accept="image/*" capture=environment`
  - `ocrImportInput`（ocr.js:82）`accept="image/*"`
  - 兩者 change handler（:242-243）都只取 `files?.[0]` → **單張**。
- **文字檔 fast-path 已通**：`importOcrText(rawWords)`（store.js:1436）吃「原始文字 token array」，做 whitelist 過濾→黑灰→重複→Cambridge→入庫。**只要文字檔能抽成 tokens，就能直接走這條，完全跳過 OCR**（現成，不用重寫）。

### F′.2 方案設計
1. **匯入輸入改多檔**：`ocrImportInput` 改 `accept="image/*,.pdf,.txt,text/*"` + `multiple`；change handler 改迴圈處理 `files` 每一檔。相機（`capture=environment`）保留單張，屬「現在拍」。
2. **每檔分派**（`runFile(file)` 依 type 分流）：
   - **圖片**（`image/*` / `application/pdf` 多張）→ 原 OCR pipeline（A 螢光筆過濾開關 → cropToFile → 辨識）。
   - **PDF 多頁**：pdf.js 或瀏覽器原生 PDF 渲染 → 每頁 render 成圖 → 逐頁走 OCR。桌面 WebKitGTK 有無 pdf.js 整合需實錘（動工時確認：webview 可否 img 顯示 pdf、或用 pdf.js 解析 → canvas）。
   - **純文字**（`text/plain`、`text/markdown`、`.txt`、`.md`、`.csv`、`.srt`…）→ **不走 OCR**：讀 `file.text()` → 抽 token → `importOcrText(tokens)` → 直接到「候選/篩選/入庫」下一步。
3. **文字抽 token**：`/^[a-z][a-z'-]{1,30}$/i`（沿用 importOcrText 的 whitelist regex）+ 去重 + 去掉 Noise（數字、網址、標點）→ 進 importOcrText。可複用現有 `normalizeBlackWord`/token 邏輯。
4. **文字檔多檔合併**：複數文字檔 → 全部 token 併集（去重）→ 一次 importOcrText。
5. **UI**：OCR 頁頂「匯入」按鈕文字「匯入圖片」→「匯入檔案」；支援格式提示（image/pdf/txt）。

### F′.3 驗證
- harness（`tools/verify-ocr2-importfile.mjs`）：文字檔 token 抽取（含 markdown/csv/srt 格式）→ importOcrText 收到正確 words；圖片檔走原路徑不抽 token。
- browser：匯入 .txt → 直接出候選清單（無 OCR 階段）；匯入多張圖 → 逐張辨識；PDF → 逐頁（若實錘可）。
- 手機：相機保留、匯入支援多檔。

### F′.4 風險
- PDF 解析依賴 WebKitGTK/webview 能力 → 動工前實錘；若 PDF 難，先做「圖片複數 + 文字檔」，PDF 列後續。
- 文字檔 noise → 用既有 whitelist regex 已擋大部分；不另開 NLP。

---

## C. 痛點③ — 黑灰名單重疊字可見性＋強制加入

### C.1 現況（實錘，見 §0.2 更正）
- **render 端不擋**：`ocr.js:429-433` 顯示所有 `finalTokens`，未呼叫 `isBlacklisted/isGraylisted`。
- **入庫雙層擋**：
  - `importOcrText` `store.js:1440-1449`：`blSet = blacklist ∪ graylist`，重疊字 `blacklisted++; continue`。
  - `importWords` `store.js:1362`：`blacklist.includes(w) || graylist.includes(w)` → `blacklisted++; continue`。
- **無 override 途徑**：勾選重疊字 → 入庫被靜默剔除；`res.blacklisted` 未被渲染（`ocr.js:466-472` 只顯示 added/skipped）。
- 對比：scan 模式未勾選字會自動加灰名單（`ocr.js:458-462`），但「已存在黑灰名單的字」無法被強制拿回來。

### C.2 痛點
1. 重疊字雖然顯示在候選清單，但**勾了也不能入庫**，且 UI 不提示「這個字被黑灰名單擋住」——使用者以為勾了就會加，實際被靜默丟掉。
2. **無強制加入（override）途徑**——想恢復某個被黑名單攔下的字（可能誤判、或使用者就是想背）完全無法。
3. **模糊統計**：`res.blacklisted` 存在但不 render，使用者不知道自己哪些字被擋掉多少。

### C.3 候選方案＋取捨（資料流/UI 雙層，明確誰改）
| 方案 | UI 層（ocr.js） | 資料流層（store.js） | 取捨 |
|---|---|---|---|
| **C-1 重疊字仍顯示＋標示遮蔽＋勾選＝強制加入（建議）** | 候選 render 時對每個字打 `s.actions.isBlacklisted/isGraylisted` 標記，顯示 badge「🔒 黑名單」「🔒 灰名單」；default **不勾**（遮蔽語意），但**可勾選**，勾選表示 override | `importOcrText`/`importWords` 接受一個 `options.override` Set：被列於 override 的字跳過黑灰剔除，正常入庫 | ✅ 雙層一次解：可見＋可 override；實錘目前完全不 show 遮蔽狀態 |
| C-2 重疊字隱藏＋另列「被遮蔽清單」 | render 端把重疊字從主清單移出，底下列「N 個被黑灰名單遮蔽：…」連結 | 同上 override | 多一步，使用者要先看到「被遮蔽」再決定；但 C-1 直觀 |
| C-3 純禁入庫＋提示 | 照樣擋，但入庫後 toast 顯示「N 個字因黑灰名單未加入」 | 不改 store | 只給告知不給控制，使用者仍無法恢復 | 

**定案：C-1。**（C-2 可視為 C-1 的簡化版，不改數據流，純 render 分組——保留作後續優化，見範圍外 ⑥。）

### C.4 建議方案詳細設計（C-1）
**邊界**：UI 標記在 `ocr.js`；override 透傳與過濾在 `store.js`。

1. **UI 標記（ocr.js:429-433）**：
   - render 每個候選時看「是否遮蔽」：`const black = s.actions.isBlacklisted?.(t); const grey = s.actions.isGraylisted?.(t);`
   - 遮蔽字：`<span>` 後接 badge `🔒 黑名單`／`🔒 灰名單`（可用現有 `--text-tertiary` + 小字），checkbox **default unchecked**。
   - 開頭加一個類別摘要列：`掃描到 N 字（其中 M 個受黑灰名單遮蔽，可勾選強制加入）`。

2. **override 透傳（store.js）**：
   - `importOcrText(rawWords, deckName, options)`：options 內 `override: Set<string>`。
   - `:1446` 改：`if (!(override?.has(w)) && blSet.has(w)) { blacklisted++; continue; }`
   - **但 override 的叠層要在 `:1450` Cambridge 查證之後**也保住：被 override 的字走查證＋入庫，才算真正「強制加入」。故 override 字在 ok 陣列內照常進查證/入庫。
   - **關鍵**：`importWords`（:1362）是第二道也不可漏——因為 scan 未勾選→灰名單的字若下次又出現，仍在 blSet。override 必須從 `importOcrText` **傳到 `importWords`**（`importWords(parsed, onProgress, { override })`），override 字在 `:1362` 也跳過黑灰擋。否則 override 傳到半路仍被 importWords 吃回去。
   - override 字擋邏輯示意（:1362）：
     ```js
     const isOverride = options?.override?.has(w);
     if (!isOverride && (state.blacklist.includes(w) || state.graylist.includes(w))) { blacklisted++; continue; }
     ```

3. **ocr.js 入庫串接（:463）**：
   - 組 `picked`（勾選）與 `overrideWords`（勾選的遮蔽字集合）。
   - `s.actions.importOcrText(picked, 'OCR Inbox', { override: overrideWords })`。
   - 渲染結果時多顯示：`res.blacklisted ? `（另有 ${res.blacklisted} 個未加入：黑灰名單/勾選缺失）` : ''`——讓使用者知道被擋了多少（修 :466-472 盲區）。

4. **override 是否順便從黑名單移除？**：**否**。override 是一次性「允許這次入庫」，不永久改黑名單（避免誤判字汙染詞表）。被 override 入庫的字直接進字本，跟正常字一樣可學；使用者之後若想，可用既有 devMode 黑名單管理（`store.js:1238-1252 removeBlacklistWord`）永久移除。

### C.5 驗證方式
- **harness（`tools/verify-ocr2-override.mjs`，送審前實跑）**：
  - mock state.blacklist=['cat']、graylist=['dog'], 已有 'baseline' 字。呼叫 `importOcrText(['cat','dog','apple'], 'OCR Inbox', { override: new Set(['cat']) })`：
    - assert：`cat` 被 override → **入庫成功**；`dog` 未被 override → 仍擋（blacklisted=1）；`apple` 正常加入。
    - assert：override 空集時，`cat`、`dog` 皆被擋（現況重現）。
  - **負控制**：剝除 override 參數（undefined）→ `cat` 又被擋回 → 精準重現「重疊字無法強制加入」原 bug。
  - 純函式測 UI badge：mock isBlacklisted/isGraylisted → 遮蔽字帶 badge、default unchecked。
- **browser 實跑**：OCR 掃到含黑名單字（如 is/cat）的圖 → 候選清單該字顯示🔒badge 且預設不勾；手動勾上 → 加入後確實出現在 OCR Inbox；toast 顯示被擋數。

### C.6 風險
- **不變式風險**：override 字若真的加入後，再次 OCR 同字 → 因已在 state.words（`existing`），`importOcrText:1447` 會 `dupSkipped`，不會重複入 → 安全。
- **黑名單語意弱化**：override 讓黑名單字得以入庫 → 但這是**使用者明確勾選**的授權，非自動，語意保留。
- **雙層 override 漏傳**：若只改 importOcrText 漏改 importWords → 字被第二道擋，bug 半解。harness 負控制必須測 importWords 層（override 字 verify 通過後确实入庫）。

---

## D. 跨層改動邊界總表（動工時的確認清單）

| 檔 | 改動 | 涉及 | 是否共享檔 |
|---|---|---|---|
| `src/pages/ocr.js` + `src/lib/ocr/`（前處理＋adapter＋micro） | highlight 前處理 filterHighlighter（HSV 過濾螢光區）＋顏色 UI（A）；切割兩態＋四角 handle＋預覽態可滑動（B′）；候選 badge＋override 分組＋結果顯示 bl 數（C）；入庫後 UI 同步 enrich（D′）；新增 `vision-adapter.js`（E′）；匯入來源改多檔＋文字檔 fast-path（F′） | 單檔為主＋新增 lib/ocr 前處理/adapter | 否 |
| `src/lib/ocr/engine.js` | registerEngine('vision-ai', factory)（E′）；(可選) 引擎選單 desktop 限定標示 | 單檔 | 否 |
| `src/store.js` | `importOcrText` 加 options.override（C）；`importWords` 加 options.override 透傳（C）；`enrichOcrWords` 加 overwrite＋多 sense＋await 同步（D′）；文字檔 token 抽取複用（F′） | 我與其他首相共用資料層 | **是**（動工前查看 scope-requests；若並行首相在碰 importWords/enrichOcrWords，優先串行或登記） |
| `src-tauri`（僅 E′ 若走 B 案） | 擴充 `fetch_llm` 帶 base64 image（E′ 選項 B，若前端直連被 CSP 擋才動） | Rust | **是** |
| `src/lib/ocr-blacklist.js` | 僅當總統要求新增輔助函式才動；DEFAULT_BLACKLIST 不變 | 單檔 | 否 |
| `tools/verify-ocr2-*.mjs` ×6 | 新增 harness（highlightfilter/crop/override/enrich/vision/importfile） | 工具 | 否（`tools/` 歸 CLI/首相共用，動工時確認） |

共享檔 `store.js`：本計劃書 C/D′/F′ 段動 `importOcrText`/`importWords`/`enrichOcrWords`（資料層核心），動工前必須確認無並行首相在改 `store.js`（GOV-BRIEF §8 串行/scope-requests 原則）。若衝突 → 寫入 `_dev/notes/scope-requests.md` 登記後暫停，等候歸屬調整。

---

## E. 驗證總覽（送審前必須全數實跑，法律④）

### E.1 既有回歸
動工後 commit 前跑：
- `node --check`（所有改動 js：`src/pages/ocr.js`、`src/lib/store.js`）
- 既有 OCR harness：`tools/verify-ocr-graylist.mjs`、`tools/verify-ocr-blacklist.mjs`、`tools/verify-ocr-import.mjs`、`tools/verify-ocr-v2-integration.mjs`、`tools/verify-restore-dict.mjs`
- `npx vite build`

### E.2 新增 harness（本計劃書 6 顆）
| harness | 測 | 負控制 |
|---|---|---|
| `tools/verify-ocr2-highlightfilter.mjs` | HSV 過濾 mask、ROI 限螢光區、負控制色相不匹配回原圖 | 色相範圍設不匹配→mask=0→回原圖→重現「整張辨識」 |
| `tools/verify-ocr2-crop.mjs` | 四角 handle 座標映射、預覽態不綁事件可滑動 | `_cropMode` 預設改回 cutting→鎖 scroll→重現「影響滑動」 |
| `tools/verify-ocr2-override.mjs` | override 字入庫成功、非 override 仍擋、bl 數回報 | 剝離 override參數→重疊字又擋回→重現原 bug |
| `tools/verify-ocr2-enrich.mjs` | enrich 全填 pos/pron/definition/examples/example、多 sense 合併、覆寫策略 | 移除 overwrite→填空欄行為重現 |
| `tools/verify-ocr2-vision.mjs` | vision adapter 回 OcrBlock 結構、base64 圖送達、desktop-only available | mock ollama 不可連→available=false→選單不出現 |
| `tools/verify-ocr2-importfile.mjs` | 文字檔 token 抽取、圖片檔不走 token、多檔併集 | 進 .txt 卻走 OCR 路徑→重現「對文字檔跑 OCR」錯 |

---

## F. 送審與動工流程（照 GOV-BRIEF）
1. 本計劃書（v1.1，含三痛點＋D′ 自動填的現況實錘/候選取捨/詳設/驗證/風險/範圍外）送總統審。
2. 審查通過後，**一痛點一 commit**（A、B′、C、D′ 各自獨立），每顆先寫 harness 並實跑（負控制過）→ 動工 → `node --check`＋回歸＋`vite build` → commit（`fix: OCR2-A <標題> — 詳述`），共享檔 `store.js` 的 C/D′ 顆特別注意並行。
3. 四顆 commit 後升版（`./tools/version.sh`，若總統要求；docs 型或需求不走升版則另行裁示）。
4. 每顆 commit 落 `_dev/notes/subagent-log/`。

---

## G. 風險彙整
| 風險 | 等級 | 緩解 |
|---|---|---|
| highlight 聚焦單卡效率降 | 中 | 螢光筆本就重點字；scan 保留高效批選 |
| store.js 共享檔並行衝突 | 高 | 動工前查 scope-requests；衝突則串行/登記 |
| override 雙層漏傳（importOcrText 漏 importWords） | 高 | harness 負控制專門測 importWords 層 |
| 切割狀態機改動較大（預覽/切割兩態） | 中 | 只 ocr.js；split 純函式供 harness |
| cropToFile 四邊形 vs 現行軸向矩形 | 中 | 動工時實錘；若維持矩形取四角 min/max |
| 預覽態可滑動須二步（按鈕+切割） | 低 | 換來不誤觸、不卡滑動，符合裁示 |
| enrich 網路/查證延遲拖慢入庫 | 中 | await 但加超時/失敗提示，不卡死流程 |

---

## H. 範圍外（明確不做，憲法①⑥追蹤）
1. 不做「重疊字在 render 端隱藏」——現況已顯示，本方案保持顯示＋標示（若總統要改隱藏，另開任務）。
2. 不做「override 永久移除黑名單」——override 僅一次性授權；永久移除走既有 devMode。
3. 不做「highlight 修改黑名單/灰名單 pooling 結果」——避免污染詞表。
4. 不做「多批次同時聚焦」——highlight 單角色，批次需求走 scan。
5. 「拖放時放大鏡」與「切割態進階吸附/網格」列為**後續可選**，本波主案只做切割按鈕＋拖四點成型。
6. 不做「重疊字另列收合清單」（C-2 純 render 分組）——保持 C-1 主案，C-2 作後續優化。
7. 不做「enrich 永久快取 Cambridge 結果」——本波僅入庫即時填欄，不限補快取（另開任務可加）。

---

*本計劃書 v1.1 — 2026-08-30，PM-OCR2（計劃書專員）撰，總統 v1.1 收編 B′ 切割重設計＋D′ 自動填欄位。送總統審查；不動 code。*