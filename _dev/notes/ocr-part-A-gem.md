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
