# OCR-plan v1.2 R3 複審 — 委員#A（閉合驗證）

- 審查對象：`_dev/notes/OCR-plan-v1.2.md`（235 行，全文實讀）
- 閉合基準：R2 兩席報告（review-ocr-r2-a.md 逐條表 + 補正最低清單；review-ocr-r2-b.md F1~F6）+ 元首「引擎可插拔」新指示（F7）
- 實碼證據：`src/lib/svg.js`、`src/lib/store.js`、`vite.config.js`、`src/pages/settings.js`、`node_modules/lucide-static/icons/` 皆終端/grep 實測。**全程唯讀，未改任何 src/ 或計畫檔案；本報告為唯一產出。**
- 行號均为 v1.2 實測行號。

## 總判定：❌ 不完全閉合 — 3✅ / 4🟡 / 1❌（阻擋 1 項：F3 的 §6「diff 級修復」仍是假宣稱）

v1.2 相較 v1.1 有實質进步（svg.js import 行落地、§6 真有 vite.config.js 節、負控制 B 的 added=0 錯誤斷言移除、session_id 殘渣清零、三功能入第9章 P3、正則全篇統一）。但 **§0/頁首宣稱與正文仍有兩處不符**（F3 的 diff 級修復、F2 的 assetsInclude/langPath），其中 F3 屬 R2-A「不得保留與正文不符的宣稱」紅線同款違規。

---

## 一、R2 六點閉合判定

### F1 — cameraRaw import 行 ✅
- v1.2 L152（§6.1）：`import cameraRaw from 'lucide-static/icons/camera.svg?raw';` 真實存在，L154：`camera: () => S(cameraRaw),`。
- 實碼模式核對：svg.js:8-60 全為 `import xRaw from 'lucide-static/icons/x.svg?raw';`（如 :8 homeRaw、:17 checkRaw），helpers `const S = (raw) =>`（svg.js:91）、icons 條目模式 `check: () => S(checkRaw),`（svg.js:107，R2-B 已證）— **逐字符合同一模式**。
- 來源資產實存：`node_modules/lucide-static/icons/camera.svg` 實測存在（且 package.json:23 已有 lucide-static，無需新增依賴）。§0 L13 宣稱與正文一致。
- 小註（不阻擋）：未給插入錨點建議（R2-B 建議 svg.js:17 checkRaw 之後），純锦上添花。

### F2 — vite.config.js 項 🟡（半閉合：節有了，但「可貼的 workerPath/corePath/langPath 配置」仍缺一半，且殘留一處小假宣稱）
- ✅ 真改進：§6 第 6 項（L186-195）**確實存在**。L191-193 的 `optimizeDeps.exclude: ['onnxruntime-web', '@huggingface/transformers', 'tesseract.js']` 可貼：與實碼 vite.config.js:15-17 現行值 diff 僅增量 `'tesseract.js'`，先例真實、非幻覺。public/ 路徑有規劃：L187「模型檔（eng.traineddata 等）納入 `public/assets/ocr/`」＋第3章 L86 同口徑。§0 L14「新增第6項 vite.config.js」這半部與正文一致（R2 的「§6 根本沒有 vite 節」假宣稱已修復）。
- ❌ 仍缺：workerPath/corePath/langPath **無任何可貼配置程式碼** — 僅 L194 一句註解「必須設定指向 /assets/ocr/」；langPath 在 §6 正文完全缺席（僅 §0 L14 與 §3 L86 的宣稱句出現）。§0 L14 宣稱「明列 optimizeDeps.exclude / **assetsInclude** 規範」— `assetsInclude` 全文僅出現 1 次（L14 表格本身），§6 正文零處理 → 與正文不符的宣稱残留（同 R2-M4 假宣稱同構，惟幅度小得多）。
- 判定：節的存在性閉合，配置的落地度未閉合 → 🟡。補正量：貼出一個 `tesseract.createWorker(... { workerPath:'/assets/ocr/worker.min.js', corePath:'/assets/ocr/core', langPath:'/assets/ocr/lang' })` 級具體物件 + public/assets/ocr/ 檔案清單，並將 assetsInclude 或寫進正文或從 §0 刪宣稱。

### F3 — 負控制 B 前提 + store.js diff 級修復 ❌（前提改了 ✅，但宣稱的「diff 級修復」正文不存在 = 假宣稱）
- ✅ 前提閉合：§7 L203 負控制 B 已改寫為「回傳合規結構（實碼 store.js 既有行為如實回報或捕捉處理）」，v1.1 的错误斷言「回傳 added=0」已滅。§0 L19 明文點名「既有實碼 store.js:1269-1277 於 ROLLBACK 後回傳 added>0」— **實碼核對屬實**：store.js:1270 BEGIN / :1274-1277 catch 僅 `ROLLBACK + console.warn` / :1262 `added++` 在交易前遞增 / :1282 照樣 `return { added, ... }`，且 :1259 state.words.push 不回滾。行號引用真實。
- ❌ 修復缺失：§0 L19 宣稱「並在 store.js 修復項中補上『DB 失敗路徑如實回報／捕捉回傳』的 **diff 級修復**」、頁首 L3 宣稱「store.js 錯誤分支修復」完成 — **§6.2（L157-169）實查只有 importOcrText 委派代碼（L161-168：filter→map→`this.importWords(parsed)`→`return res` 原樣透傳），對 importWords:1269-1282 錯誤分支零 diff**（無 txOk、無 try/catch 捕捉、無 state 回滾）。照 v1.2 字面施工，負控制 B 依旧會拿到 added>0 + 記憶體態污染，R2-B F3 的「驗收標準 vs 被複用函式真實語意」死鎖未解。
- 小註：L203「如實回報**或**捕捉處理」二選一未定案，負控制缺乏單一可判定的預期值。
- 判定：前提面 🟡+、修復面 ❌，且屬宣稱與正文不符 → **F3 整體 ❌（本輪唯一阻擋項）**。

### L11 — 三功能入第9章範圍外 P3 🟡（字面閉合，兩處尾巴）
- ✅：第9章 L230-231 確有「剪貼簿貼上 (Ctrl+V) / Bounding Box 視覺高亮 / 置信度閾值控制：暫列為範圍外，列入 P3 候選」，與 §0 L24 宣稱一致；此舉同時順帶收口 R2-B F6 的功能-清單縫隙（bbox/paste 不再需 §6 歸屬）。
- 🟡 尾巴一：**第1章流程未同步瘦身** — L33 仍寫「支援…剪貼簿貼上（Ctrl+V）」、L36-37 仍寫「高置信度（>0.8）…顯示 Bounding Box 預覽，供手動點擊修正」，與第9章「範圍外」直接矛盾（v1.1 原文 :31/:34-35 的殭屍敘事只刪了 §6 歸屬，沒刪流程宣稱）。
- 🟡 尾巴二：**§0 對 L11 的編號挪用了** — R2-A L29 記載的 c2-L11 原始三點（deck-browser.js:566 addWord 消費點波及、refreshDerived 批量成本、「OCR Inbox」新 Deck 對清單/統計頁呈現）在 v1.2 全文 grep `deck-browser|refreshDerived|波及` **零痕跡**，等于用「三功能移入 P3」頂掉了真正的 L11 波及風險清單，且未論證不採納理由（R2-A 補正最低清單第3條要求至少一段波及風險敘述或明文論證）。

### L8/F4 — 正則 /i 與 off-by-one 全篇一致 ✅
- 全文正則恰兩處：第5章 L139 `/^[a-z][a-z'-]{1,30}$/i`、§6.2 L164 `/^[a-z][a-z'-]{1,30}$/i.test(w)` — **兩處皆帶 /i**（R2-B F4 的 §6 缺 /i 已修）。
- 長度描述：L140「長度 2 至 31 字元」、§0 L22「實容 2–31 字元」— off-by-one 已按實態改正，全篇一致，無第三處宣稱 2-30 殘留（grep 驗證）。

### 殘渣清零 ✅
- `session_id`：全文僅存於頁首 L3 的「session_id 殘渣清除」**宣稱句**本身，兩行髒字（v1.1 :198/:213）已滅。
- 第9章「R2 複審確認仍適用」占位語（R2-B 登記項）已滅。`recognize_image` 僅存於 §0 表的歷史問題描述（L12/L18），正文零幽靈代碼。
- 小註：§0 表仍無 L9 行（寄生 M3/F1 行）、L4/F3 與 L10 同指 F3，編號一一映射仍不完美 — 編輯性，不阻擋。

---

## 二、新指示（F7 引擎可插拔）閉合驗證

### OcrEngine 介面定義具體性 🟡
- L83：`OcrEngine = { id, recognize(imageFile, opts) → { text, blocks[], confidence }, available() }` — 欄位名與頂層回傳形狀有給（id/text/blocks/confidence），第1章 L34、§5 L142 有引用。
- 但「具體」不足：`opts` 無形狀、`blocks[]` 元素型別未定義、`confidence` 未定義值域（0-1? per-token or per-page?）、`available()` 回傳型別/同步性未寫、無錯誤語義（辨識失敗 throw 還是回傳空結構——負控制 A 要求「不拋例外」但介面層未綁定此契約）、無引擎註冊/取得機制（registry/getEngine）。屬可辨識的介面**草圖**，非可照抄的欄位級定義。

### 第5章資料流不綁引擎特有 field ✅
- L138「原始辨識字串（無論來自哪種 Adapter 引擎回傳）」、L142「所有 OCR 引擎回傳之辨識結構一律透過介面格式轉化後交由 store.importOcrText」— 第5章零引擎特有欄位（無 data.text/blocks 之類 Tesseract 結構洩漏），store 只吃 `{word, definition, deck}`（L165，與實碼 importWords 讀取的 src.word/definition/deck（store.js:1227/1243/1232）對齊）。解耦成立。

### 第8章 P1/P2 分期對應 🟡
- 分期骨架對應正確：P1（L209-212）= Tesseract Adapter 先行＋介面＋選單＋vite 離線打包；P2（L214-217）= Android ＋ PaddleOCR Adapter 接入；與第3章 L82-85「A/B 實測後定預設值」一致，ML Kit 矛盾（R2-A L6 尾巴）由 ML Kit→Paddle 換名＋P2 化而收口。
- 但有兩道跨章裂縫：
  1. **§6 自稱「六大核心檔案完整窮舉」（L146）卻不含 `src/lib/ocr/` 任何檔案** — 介面檔與 tesseract-adapter.js（§3 L84 點名、§8 P1 交付物 L210 點名）不在修改清單 → R2-B F6「辨識鏈路無歸檔」以新形態復活。
  2. **設定頁 vs 工具頁矛盾**：§3 L85 與 §8 P2 L217 宣稱「（系統）設定頁增加 OCR 引擎核心選單」，但實際 HTML 的 `#ocrEngineSelect` 掛在**工具頁**（第4章 L103，插入 tools.js），§6 檔案清單**無 settings.js 項**，settings.js 亦零提及 → 「設定頁」宣稱無正文載體。
  3. 編輯性：L103 `class="config-select"` 於 src/ 全庫 grep **零命中**（專案 select 慣例是 `form-input`，如 settings.js:1280）— v1.2 新引入的小型幽靈 CSS 類。

---

## 三、判定彙總

| 項 | 判定 | 一句話依據 |
|---|---|---|
| F1 cameraRaw import | ✅ | L152 import 行逐字符合 svg.js:8-60 `?raw` 模式；camera.svg 實存 |
| F2 vite.config.js | 🟡 | §6.6 節與 exclude 可貼、public/assets/ocr/ 有規劃；但 workerPath/corePath/langPath 僅一句註解無可貼配置、langPath 正文缺席、assetsInclude 宣稱無正文（小假宣稱） |
| F3 負控制 B + store.js 修復 | **❌** | 前提已改「現行實態」✅、行號引用屬實 ✅；但 §0 L19/頁首 L3 宣稱的「diff 級修復」在 §6.2 **零 diff** — 假宣稱、驗收死鎖未解 → 阻擋 |
| L11 三功能入第9章 | 🟡 | 第9章 L231 落地 ✅；第1章 L33/36-37 流程殭屍宣稱未同步刪；c2-L11 原波及風險三點仍零痕跡 |
| 正則 /i + off-by-one | ✅ | L139/L164 雙 /i；「2–31」全篇一致 |
| 殘渣清零 | ✅ | session_id／占位語／幽靈符號正文清零 |
| OcrEngine 具體性 | 🟡 | 欄位名與頂層回傳有、型別/值域/錯誤語義/註冊機制無 |
| 第5章引擎中立 | ✅ | 零引擎特有欄位、store 介面結構與實碼對齊 |
| 第8章分期對應 | 🟡 | P1↔Tesseract/P2↔Paddle 對應正確；但 src/lib/ocr/ 不入 §6 窮舉、「設定頁」選單無正文載體（§6 無 settings.js） |

## 四、裁決

**❌ 退回定點補正（僅 F3 阻擋 + 4 項 🟡 建議同輪順帶修，勿再全面返工）。** 最低補正清單：
1. **F3（必修）**：§6.2 補 importWords 錯誤分支的 diff 級修復（例：catch 內設 `txOk=false` 並以回傳值如實反映、或 importOcrText 層捕捉改寫），並將 §7 負控制 B 收斂為單一可判定預期（刪「或」）。否則刪除 §0 L19 與頁首 L3 的「修復」宣稱。
2. F2：§6.6 貼出 workerPath/corePath/langPath 具體配置物件（指 /assets/ocr/）＋ public/assets/ocr/ 檔案清單；assetsInclude 入正文或從 §0 刪宣稱。
3. L11：刪/改第1章 L33、L36-37 殭屍流程敘事（或註記 P3）；補 c2 原 L11 波及風險一段或明文論證不採納。
4. F7：介面定義補型別與錯誤語義；§6 補 `src/lib/ocr/`（介面＋tesseract-adapter）項與（若維持設定頁宣稱）settings.js 項，或把 §3/§8 的「設定頁」改為「工具頁」；L103 改用實存 `form-input` 類。

*審查人：R3 委員#A（閉合驗證）。全程唯讀。*
