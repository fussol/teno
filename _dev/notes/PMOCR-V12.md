# PM-OCR 任務：v1.1 → v1.2 補正（最後一輪，範圍僅限下列 6 點）

你是文件的編輯。對計畫書 v1.1 做**定點補正**，不動其他章節。產出完整 v1.2 全文（含未變動章節原樣輸出）。

## 補正清單（R2 兩席共同裁決，只做這 6 點）
1. **F1**：§6.1 svg.js 項補真實 import 行：`import cameraRaw from 'lucide-static/icons/camera.svg?raw';`（比對 svg.js 現行 `import xxxRaw from 'lucide-static/icons/xxx.svg?raw'` 模式，放 import 區錨點註明）
2. **F2**：§6 新增第 6 項 `vite.config.js`：Tesseract.js 離線化打包規範 — workerPath/corePath/langPath 指向本地資產（寫出具體 vite 配置代碼 + 模型檔放 `public/` 的路徑規劃），並把 §0 表 M4/L6/L7 的宣稱改為與正文一致
3. **F3**：第7章負控制 B 前提修正：實碼 store.js:1269-1277 `added++` 先於交易、失敗僅 warn → 「DB 失敗回傳 added>0」才是現行實態。負控制 B 改為「驗證本次 importOcrText 統一化後，DB 失敗路徑如實回報」，並在 §6 store.js 項補上該 bug 的修復行（diff 級）
4. **L11 復活**：R1 c3 的 L11（剪貼簿貼上/bbox 高亮/置信度閾值三功能無 §6 歸屬無 §7 測試）——裁決：**移入範圍外**，在第9章「範圍外」明列並註「P3 候選」
5. **正則一致性**：統一 token 白名單正則兩處（定義 vs 落地）的 /i flag；off-by-one 修正：2–30 字元寫成 `{1,29}` 或改宣稱，選一個並全篇一致
6. **殘渣清理**：刪除兩處 session_id 殘渣行（L198/L213 附近，`session_id:` 開頭）＋第9章「R2 複審確認仍適用」占位語改為「v1.2 併入」
7. **【元首新指示】引擎可插拔架構**：第3章推薦結論改為「介面抽象＋雙_adapter_設計」——定義統一 OCR 引擎介面（如 `OcrEngine = { id, recognize(imageFile, opts) → { text, blocks[], confidence } , available() }`），Tesseract.js 與 PaddleOCR（或 ML Kit）各實作一個 adapter，放 `src/lib/ocr/` 下；設定頁加引擎選單可**無痛切換核心**，A/B 實測體驗後再定預設值。第5章資料流（token 切分/入庫）只吃介面回傳格式，不綁任何引擎特有事務。第6章修改清單、第8章分期（P1=Tesseract adapter 先行、P2=第二引擎 adapter＋切換 UI）同步對應修正。切引擎時語言包下載/快取策略要寫明。

## 格式
- 標題：`# PM-OCR 計畫書 v1.2（R2 補正版，待 R3）`
- §0 修訂對照表更新：加一欄 R2 發現（F1-F5/L11）→ v1.2 處理
- 其他章節原樣保留
- 全文輸出，不要摘要

## 鐵律
- 引用實碼前 grep 確認；lucide-static 依賴已在 package.json（R2 證實）
- 不得宣稱任何未經證實的通過/完成
