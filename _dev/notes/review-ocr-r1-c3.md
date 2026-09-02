# OCR-plan 審查報告 — 委員#3（引擎評估與驗證計畫）

- 審查對象：`_dev/notes/OCR-plan.md` 第1–3章（調研+引擎矩陣）、第7–8章（驗證+分期）
- 證據基準：`_dev/notes/ocr-research-pack.md`（一手資料包；web_search 後端 422 故障，僅以本地包為實證來源）
- 審查日期：2026-08-28
- 判定總覽：**1 ❌（部分合規）｜2 ✅（有保留）｜3 ❌｜4 ✅（有保留）**

---

## 逐項核對

### 1. 技術宣稱出處標注 — ❌ 部分合規

**做對的部分：**
- 第2章 Tesseract.js 與 PaddleOCR 小節標題帶 `[待驗證]` ✅
- 第3章矩陣「手機記憶體峰值」整列帶「估計，待驗證」✅（三家皆是憑記憶數字，標記正確）
- 「引擎結論」與調研证据包引用關係在文件頭如實聲明 ✅

**一手資料包可實證（免標記，查證通過）：**
| 宣稱 | 包內出處 | 結果 |
|---|---|---|
| Tesseract.js = C++ Tesseract 的 WASM 移植、跑 Web Worker | tesseract-readme.md（Project Scope 段） | ✅ |
| Tesseract.js 授權 Apache 2.0 | readme License badge | ✅ |
| Tesseract.js 維護活躍 | readme "Maintained? yes" badge | ✅ |
| PaddleOCR 授權 Apache 2.0、社群極大（70k+ stars） | paddleocr.md badges/簡介 | ✅ |
| PP-OCRv6 單一模型 50 語言、tiny/small/medium 三檔 | paddleocr.md 3.7.0 release 段 | ✅ |
| AnkiDroid 支援外部 App Intent 分享建卡 | ankidroid.md「Add cards by intent from other applications」 | ✅ |
| Image Occlusion 無內建 OCR | io-enhanced.md 全文無 OCR | ✅（消極實證） |
| ML Kit「Text recognition v2」產品存在 | mlkit-v2.txt 頁面標題 | ✅ |
| 第7章負控制預期「無文字不拋例外」 | tesseract-api.md recognize NOTE：「No exception is thrown」 | ✅ 與引擎實際行為精確吻合，加分 |

**❌ 缺「待驗證」標記的記憶型宣稱清單（矩陣除記憶體列外幾乎全數未標）：**
1. **Tesseract.js 語言包 ~5-15MB**（矩陣體積列）— 包內只有 v5 相對縮減數據（英文小 54%、中文小 73%），無絕對 MB 值。缺標記。
2. **Tesseract.js 延遲 ~1-3s**（矩陣延遲列）— 包內無任何 Tesseract.js 延遲實測。缺標記。⚠️ 連鎖風險：第8章 P1 驗收標準「3 秒內完成辨識」直接建立在這個未驗證數字上。
3. **Tesseract.js 中英準確率「中等」**（定性）— 無出處。缺標記（低嚴重度）。
4. **ML Kit 準確率「高（Google 經年優化）」** — mlkit-v2.txt 僅導航文字，無準確率數據。缺標記。
5. **ML Kit 體積「小（系統內建或微幅增加）」** — 包內僅見「Reduce Android app package size」「Model installation paths」章節標題，無數字內容（文檔被截斷）。且「系統內建」措辭不精確：ML Kit v2 有 bundled（增量約 MB 級）與 unbundled（經 Google Play 下載）兩條モデル分发路徑，非一律內建。缺標記+措辭需修正。
6. **ML Kit 延遲 <0.5s（設備加速）** — 無出處。缺標記。
7. **PaddleOCR 體積 >30MB** — 包內數據：tiny 1.5M / small 7.7M / medium 34.5M 參數，且官方定位 tiny/small 供 edge/mobile。>30MB 至多適用於 medium 檔，**與包內 tiny 檔證據衝突，也與本計畫第2章自己寫的「超輕量級、Tiny/Small/Medium 多檔」自相矛盾**。缺標記+數據需修正。
8. **PaddleOCR 延遲「中等（依模型大小）」** — 包內僅有 A100/M4 桌面數據（0.13s、5.2×、6.1×），無手機端數據。缺標記。
9. **ML Kit 授權「Google APIs Terms / Apache 2.0」** — 包內無授權資訊。缺標記。
10. **雲端 OCR 0.5-2s** — 無出處（對照組，低嚴重度）。缺標記。
11. **第2章 AnkiDroid「引擎：ML Kit（視版本而定）」** — 包內 AnkiDroid README 完全未提 ML Kit/OCR；AnkiDroid 本身無內建 OCR 流程，此宣稱記憶痕跡明顯且存疑。缺標記。

### 2. 推薦與矩陣自洽性 — ✅ 有保留
- **電腦 Tesseract.js**：矩陣中唯一純 WebView JS 離線方案、授權乾淨、維護活躍 → 推薦與矩陣自洽。準確率「中等」的弱點由第1章手動校正 UI 與第9章風險管理補位，邏輯閉合。
- **手機 ML Kit**：矩陣上準確率最高、體積最小、延遲最低 → 方向自洽，無矩陣數據直接打臉。
- **保留①**：第2/3章均承認 Tesseract.js「手機 WebView 皆可跑」，即存在單引擎方案；推薦手機改 ML Kit 需付出 Android Native Bridge 整合成本（第6章 api.js 預留橋樑），plan 未量化「ML Kit 精度/延遲優勢 vs 維護兩套引擎成本」的取捨——結論合理但論證不足。
- **保留②**：PaddleOCR「體積大」是矩陣中支持排除它的關鍵數據，但該格與包內 tiny(1.5M) 檔證據衝突（見上第7條）。若 tiny 檔實際仅個位 MB，排除 PaddleOCR 的體積論據被削弱（精度與整合複雜度論據仍成立）。
- **保留③**：第1章電腦流程只載 `eng` 包，矩陣卻以「中英準確率」評估——中文支援範圍在 plan 中從未明確收尾。

### 3. 驗證計畫覆蓋度 — ❌
- ✅ P1 主鏈路（匯圖→辨識→importOcrText→入庫）有測試步驟+負控制（黑圖/噪點），且負控制預期與 Tesseract.js API 文檔行為一致。
- ✅ 手機端明確要求真機：第8章 P2 驗收「Android 實機（Samsung A55）」，非模擬器。
- ❌ P1 交付物_vs_測試缺口：
  1. **剪貼簿貼上（Ctrl+V）**：第1章宣稱的輸入路徑，第7章無對應測試。
  2. **低置信度/多候選分支**（黃色警告、bbox 裁切預覽、手動修正）：第1章核心交互，無測試步驟；置信度 >0.8 閾值無驗證方法。
  3. **Capabilities 權限變更**（fs:default / fs:allow-read-file）：P1 交付物，無權限生效/收斂測試。
  4. **api.js `recognize_image` IPC**：列入 P1 交付物但 P1 桌面包用不到（純前端 WASM），無測試且邊界錯置（見第4項）。
  5. **P1 驗收標準「3 秒內」無對應計時測試步驟**，且 3s 恰落在未驗證估算（~1-3s）的邊界上——驗收標準自身不可靠。
- 建議：每條缺口補一行測試+負控制；「3 秒」改為「P1 首日上機實測後修訂的 P50 目標」或先標待驗證。

### 4. P1/P2/P3 分期邊界 — ✅ 有保留
- ✅ 三段各有交付物清單、工作量、可獨立驗收標準；P1（純桌面）→P2（純手機）→P3（增值層）依賴單向、可獨立驗收。
- 保留①：**P1 混入手機預留件**——`recognize_image` IPC 橋與相機相關能力屬 P2 關注點，放進 P1 交付物使 P1「純電腦端」邊界模糊，建議移至 P2。
- 保留②：第7章驗證表只覆蓋 P1/P2，**P3 有驗收標準但無測試步驟與負控制行**（例：斷詞誤切、Cambridge 查無此字的負控制）。
- 保留③：P3 依賴的 `lookupCambridge` 為線上功能，與「主要離線可用」需求的关系未在分期中說明降級行為（建議補負控制：離線時查詞失敗不入庫路徑）。

---

## 結論
| 審查項 | 判定 |
|---|---|
| 1. 宣稱出處標注 | ❌ 矩陣 12 格中僅記憶體列標記；11 條記憶型宣稱缺「待驗證」，其中 PaddleOCR 體積格與一手包數據衝突 |
| 2. 推薦自洽性 | ✅（推薦方向成立；排除 PaddleOCR 的體積論據需修正為「medium 檔 >30MB；tiny 檔可議」） |
| 3. 驗證覆蓋度 | ❌ P1 四項交付物缺測試；真機要求已落實 |
| 4. 分期邊界 | ✅（P1 交付物清單需剔除非桌面項；P3 缺驗證行） |

**必須整改（阻 P1 開工）：** 缺標清單第 1、2、5、7 條補標或修數；P1 驗收「3 秒」與負控制缺口（剪貼簿、低置信度分支、權限）補測試步驟。
**無須修改代碼；本審查僅動本報告檔。**
