# OCR-V2 design plan — 灰名單 + 模式切換 + 本地還原

狀態: 已實作 ✅（2026-08-29） · 版本 v1.0 · 2026-08-29
範圍: src/lib/store.js, src/lib/dictionary.js, src/pages/ocr.js, src/pages/settings.js, tools/verify-*.mjs

## 需求（用戶逐字整理）

1. **OCR 兩種模式可切換** — 螢光筆模式 vs 現有(相機/相簿)模式。
2. **Cambridge 篩選模式** — OCR 候選字過 Cambridge 查證(現有 ocrCambridgeVerify 已存在, 提升為明確模式)。
3. **本地 AI 還原** — OCR 不穩定, 把辨識失敗/亂碼字丟本機模型試還原; 還原不了刪掉。
4. **灰名單(graylist)** — OCR 使用者「取消勾選淘汰」的字進灰名單:
   - 功能同黑名單(不進一般學習序、OCR 錄入自動排除)
   - 接受使用者自訂(黑名單=系統預設鎖死)
   - 可 CSV 匯入
   - **要 devMode 才能查看/新增/刪除**(整個 OCR 黑名單區塊 devMode 才顯示)

## 現況(已核實)

- **黑名單**: `state.blacklist`, settings key `blacklist`, 含 DEFAULT_BLACKLIST 預設。
  - store.js:423-426 `MergeInitBlacklist`(DEFAULT ∪ db), :1228-1242 addToBlacklist/removeFromBlacklist(寫 setSetting 'blacklist')。
  - 檢查點: :1225 isBlacklisted, :1311/:1395 OCR 入庫擋。
  - settings.js:452-458 黑名單 UI, :838 增刪 **未 devMode gate**(現狀直接顯示)。
- **devMode**: store.js:293/422/1640-1641, settings:437 顯示, :812 連點版本10下開啟, :440 關閉按鈕。
- **OCR 模式**: ocr.js 目前僅「相機/相簿雙源 + 圈選/整張」, 無模式切換。
- **入庫**: ocr.js:364 `importOcrText(picked)` 只取勾選字; 未勾選字**丟棄**(灰名單切入點)。
- **本地模型**: ollama 有 `qwen3-ocr64k`(64K 衍生,Qwen MoE) — OCR 還原主力。記憶: 大 prompt 需分段、num_ctx 64K 衍生模型已建。

## 設計

### 1. 灰名單 — 鏡射黑名單 (store.js)

- `state.graylist: []` 初始, settings key `graylist`。
- 載入: `graylist` 併入 state(:294/422 擴充)。
- API(鏡射 blacklist):
  - `addToGraylist(w)` / `removeFromGraylist(w)`(寫 setSetting 'graylist', normalizeBlackWord 同款正規化)
  - `isGraylisted(w)` — 檢查
  - `importGraylistCsv(text)` — CSV(純單字/逗號/換行)解析 → 併入並 setSetting
- 檢查點: OCR 入庫 :1311/:1395 改為 `blacklist.includes(w) || graylist.includes(w)` 雙排除。
- OCR 頁「未勾選字」→ 入 db 灰名單: ocr.js :364 入庫時, candL 全部候選 - 勾選 = 未勾選, 對每個未勾選且非黑名單的字 addToGraylist。

### 2. OCR 模式切換 (ocr.js)

- 頁頂加模式切換 tab(樣式用 .study-mode-tabs 同款):
  - `螢光筆`(新) / `相機拍照`(現有原生相機) / `匯入照片`(現有)
- **螢光筆模式**: 選圖後, 過濾出「螢光筆標記區」辨識。實作待評估:
  - 方案A: 色彩空間偵測(高飽和螢光黃/粉/綠 mask → 取該區域裁切辨識)
  - 方案B: 整體辨識 + 只保留高 confidence 字(螢光筆標記常是重點字)
  - 待定: 先做 B(可靠), A 列後續。需用戶確認。
- 模式持久化: settings key `ocr_mode`(鏡射現有 ocr_engine)。

### 3. Cambridge 篩選模式 (ocr.js)

- 現有 ocrCambridgeVerify(settings) 已經是開關。UI 上改為模式 tab 旁標示(或維持開關)。
- 維持現狀即符合需求(查得到才入庫)。

### 4. 本地 AI 還原 (ocr.js + ollama)

- Tesseract 辨識候選字, 對 confidence 低(< 閾值 如 60) 或 token 不在 Cambridge 查到的字:
  - 丟 `qwen3-ocr64k` 本機還原:「Given OCR text fragments: [...] / correct likely intended English word(s)」
  - 回傳還原侯選, 替代原候選; 還原不出 → 標記淘汰(進灰名單)。
- **注意**: 依記憶, 需走 64K 衍生模型避 num_ctx 截斷幻覺; 大輸入分段。開關: settings `ocr_ai_restore`(devMode 可關)。
- UI: 候選清單顯示還原前/後; 還原來源標注「AI」。

### 5. settings.js — OCR 黑名單區塊 (devMode gate)

- 整個 OCR 過濾區塊(目前 :444-458)**包進 devMode 條件**才渲染(現狀未 gate → 改)。
- 黑名單: **改為系統預設不可改** — 移除/隱藏個別字移除按鈕 + 加入 input; 只顯示唯讀清單(或顯示「系統預設, 不可修改」)。
- 灰名單: 同清單區塊, 可新增/移除 + **CSV 匯入**按鈕(file input 或貼上)。
- 入口標題: 「OCR 黑名單」(平常隱藏, devMode 顯示)。

## 變更清單

| 檔案 | 變更 |
|---|---|
| src/lib/store.js | graylist 初始/載入/API/檢查點; ocr_mode? |
| src/pages/ocr.js | 模式切換 UI; 未勾選→灰名單; 本地 AI 還原 |
| src/pages/settings.js | OCR 區塊 devMode gate; 黑鎖死; 灰增刪+CSV |
| tools/cli.mjs | (選) graylist 指令 + 本地還原 |

## 待確認事項

1. 螢光筆模式實作: A(色彩偵測) vs B(高confidence保留) — 建議先 B。
2. 灰名單 CSV 格式: 純單字一行一個? 或 `word,note` 雙欄?
3. 本地 AI 還原觸發: 全部候選都過 AI, 還是指 confidence 低才過? — 建議後者(省資源)。

## 驗證

- store graylist: harness（tools/verify-ocr-graylist.mjs ALL PASS）✅
- dictionary 離線還原: tools/verify-restore-dict.mjs ALL PASS ✅
- ocr.js 整合釘: tools/verify-ocr-v2-integration.mjs 12/12 PASS ✅
- vite build + node --check 全過 ✅

## 實作決策紀錄（2026-08-29）

### 還原層定案：混合（離線優先 → qwen 補強 → 刪）
- **初始測試綁架**：用戶提議 Needle 2（cactus-compute/needle，14MB/28MB/45M 參數）。
- **實測結果：Needle 2 對 OCR 還原完全無效**（0/8 + 6/6 把亂碼 `joumey`/`restaurent` 標 valid=True）。
  它無字典知識、不做 generation——是「工具呼叫/結構化抽取」模型，哲學是「only values evidenced by
  input, not guessed」。45M 參數記不住 English vocabulary。
- **改用混合層**（用戶拍板「兩個都用」）：
  1. **離線 words.txt Damerau edit-distance**（通用基準，手機/桌面都可跑）——`dictionary.js
     restoreFromDictionary()`，長單字亂碼還原極準（monntain→mountain/restaurent→restaurant 全中），
     「嚴格唯一」守門處理歧義。實測 7/11 精準。
  2. **qwen3-ocr64k 補強**（桌面部屬 A55 跑不動 18GB 就自動跳過）——離線找不到的 token 才丟 ollama。
     實測 `monntain→mountain` 26.4 tok/s。設定 `ocrRestoreModel` 預設 qwen3-ocr64k。
  3. **仍還原不出（歧義/非英文字）→ 淘汰**（不進候選＝「還原不了就刪」）。

### 設定介面
- OCR 過濾區塊先前已在 `${s.state.devMode ? ...}` 內（隱藏達成）。
- **黑名單改唯讀鎖死**（移除新增輸入＋個別移除；顯示「系統預設，無法修改」）。
- **灰名單新增**：input 增刪＋CSV 匯入（file input，\n/逗號/分號/tab 全吃）+ 個別移除。
- 引擎 `graylist` API 鏡射 blacklist：isGraylisted/addToGraylist/removeFromGraylist/importGraylistCsv，
  檢查點 importWords/importOcrText 雙排除。

### OCR 模式切換
- 頁頂 tab：相機拍照 / 匯入照片 / 螢光筆。持久化 settings `ocrMode`。
- 螢光筆（方案 B）：整張辨識＋只留 confidence ≥ 50 的高信心 token（螢光筆標記重點字信心較高）。

### OCR 未勾選 → 灰名單
- 入庫 handler 計算「全部候選 − 勾選」= 淘汰字，對每個非灰名單字 addToGraylist，呼應「使用者 OCR 淘汰的
  字進灰名單、不進一般學習序」。

### 驗證 harness
- verify-ocr-graylist.mjs（T0-T6，含 CSV/持久/雙排除）
- verify-restore-dict.mjs（damerau 核心 11 斷言）
- verify-ocr-v2-integration.mjs（ocr.js 12 項輪廓釘）