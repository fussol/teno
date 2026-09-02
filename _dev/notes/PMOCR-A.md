# PM-OCR 階段A任務 v2：調研與引擎評估（資料包模式）

你是 Teno 專案的 PM-OCR。Teno 是 Tauri v2 + 純 JS SPA 的單字學習 app（電腦 + Android 雙端）。
計畫新增功能：**OCR 辨識字 — 透過相機/影像辨識單字並加入字卡**，掛在工具介面。

注意：網路搜尋後端目前故障，本任務以文末「一手資料包」為主要證據來源（已 curl 自官方 repo/官網）。資料包沒覆蓋的你可試 web_search（若仍 422 就標記『待驗證』憑既有知識寫，並註明不確定性）。引用時附原始 URL。

## 交付（你的最終回覆，直接輸出 markdown）

### 第1章 需求與操作流程
電腦端、手機端分述：從「按相機/選圖」到「單字入庫」的完整步驟（含辨識失敗、多候選、置信度低等分支）。

### 第2章 開源方案調研（≥4 案）
從資料包分析 AnkiDroid、Image Occlusion Enhanced 的做法與可借鑑點；再補至少兩案（憑知識+標記待驗證）。每案：做法、引擎、優缺點、可借鑑點、URL。

### 第3章 OCR 引擎評估矩陣與推薦
評估：Tesseract.js（資料包有 README+API）、ML Kit Text Recognition v2、PaddleOCR、tesseract 原生 Android binding、Cloud OCR API（對照組）。
矩陣維度：離線與否／中英準確率（印刷體單字）／模型與APK體積增量／手機記憶體峰值／延遲／授權條款／Tauri v2 整合方式（WebView JS / Rust plugin / Android native bridge）／維護活躍度。
數字沒有證據就寫「估計，待驗證」，不許編造精確數字。
**結論：電腦端推薦 + 手機端推薦 + 一句話理由。**
