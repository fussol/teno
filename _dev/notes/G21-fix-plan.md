# G21 修復計畫書 v1（2026-08-27，PM7）

## Bug 定義
匯入功能對 `tags` / `examples` 兩欄支援不完整：
1. `CANONICAL_FIELDS` 缺 `'tags'`、`'examples'` → 欄位對應下拉選單（pages/import.js:87 optionList）無法手動選這兩欄；且英文標頭自動偵測成功時，下拉框因無匹配 option 而**顯示「- 略過 -」**（visual mismatch，使用者會以為沒對應而手動改壞）。
2. `FIELD_MAP` 缺中文標記 → `resolveField('標記')`、`resolveField('描述')`、`resolveField('例句們')` 全回 null → Era 系中文標頭 CSV 的標記/描述/例句欄**整欄靜默丟失**。

## 實錘（2026-08-27，行號以實際源碼為準）
- `src/core/import.js:114-118`：`CANONICAL_FIELDS = [word, definition, pos, pron, example, synonym, antonym, derivative, deck, image, description, related, forms]` — 無 tags/examples。
- `src/core/import.js:87-111`：`FIELD_MAP` 有英文 `tags/examples/description`，無任何 tags/examples 的中文鍵（中文區只有 單字/意義/發音/詞性/例句/衍生物/相似的/反義詞/影像/字本/相似詞/詞形變化/相關詞）。
- `FIELD_LABELS`（:121-127）**已含** `examples: '例句們', tags: '標記'` → 證明本就被設計要支援，CANONICAL_FIELDS 屬漏列。
- `mapWords`（:190-193）已正確解析 tags（JSON.parse → split',' fallback）與 examples（JSON.parse → split';' fallback）→ core 下游無需改。
- 即時再現（node import 真源碼）：`resolveField('標記')=null`、`resolveField('描述')=null`、`resolveField('例句們')=null`；`CANONICAL_FIELDS.includes('tags')=false`。

## 消費者窮舉（憲法②，全 repo grep）
- `CANONICAL_FIELDS`：僅 `src/pages/import.js:7,87`（optionList）。
- `FIELD_MAP`：僅 `src/core/import.js` 內 `resolveField`（:139,144,148）。
- `resolveField`：`src/pages/import.js:105（建議標籤）、488（TSV 自動）、499（CSV 自動）`。
- `FIELD_LABELS`：僅 `src/pages/import.js:107`，已含 tags/examples 標籤 → 擴充 optionList 不會出 undefined label。
- `core/import.js` 其他 import 者：`store.js:596`（只用 parseCSV）、`pages/export.js:7`（只用 buildCSV）、`tools/cli.mjs` 零引用。
→ 改動只影響 resolveField 解析結果與下拉 option 清單，無其他隱性消費者。

## 修法（單一檔案 src/core/import.js，共 +6 行）
1. `CANONICAL_FIELDS`（:114-118）：補 `'tags'`、`'examples'`。位置放 `'description'` 之後、`'related'` 之前（與 FIELD_LABELS 陳列序一致，下拉順序自然）。
2. `FIELD_MAP` 中文區（:97-107 內）補鍵：
   - `'標記': 'tags'`、`'標籤': 'tags'`
   - `'描述': 'description'`
   - `'例句們': 'examples'`、`'範例': 'examples'`
   （鍵名取自 FIELD_LABELS 的正式標籤 + 常見變體；不加英文鍵——英文已全。）

## 驗證方式（tools/verify-g21-import-fields.mjs）
- 直接 `import()` 真源碼（core/import.js 為純模組，零 DOM/DB 依賴）。
- T1 resolveField：標記/標籤/描述/例句們/範例 解析正確；英文 tags/examples/description 不回歸；單字(POS) 括號路徑不回歸；未知欄位仍 null。
- T2 CANONICAL_FIELDS：含 tags/examples，且原有 13 欄不遺失、無重複。
- T3 FIELD_LABELS 覆蓋：CANONICAL_FIELDS 每欄都有 label（防下拉 undefined）。
- T4 round-trip（tmp CSV，遵 D1 教訓）：含 標記/描述/例句們 中文標頭 → parseCSV → tags 為陣列、description 保留、examples 為陣列。
- T5 buildCSV→parseCSV 英文 round-trip：tags JSON 陣列、examples JSON 陣列完整回還。
- T6 負控制：讀源碼剝除本次新增行 → 寫 tmp mjs → 動靜態 import → bug 精準重現（resolveField 回 null、CANONICAL 缺欄）。

## 風險
- 極低：純新增常數項目，不改任何控制流。唯一行為變化 = 原本 null 的中文標頭現在會解析、下拉多兩個 option。
- 潜在疑慮：「例句們」在 FIELD_LABELS 是 examples 的標籤、'例句' 仍映射 singular example — 維持現狀不動（二者是不同欄位，core 都有）。

## 可選項裁決（憲法⑦）
- 加英文變體鍵（'tag' 單數、'example_s' 等）：**不做** — FIELD_MAP 現況無任何單數變體先例，scope creep。
- 修下拉框 visual mismatch 的渲染邏輯：**不做** — CANONICAL_FIELDS 補齊後 mismatch 自然消失，無需動 pages（也非本首相白名單）。
- mapAnkiRows 死碼（D12）：**範圍外**，佇列自有獨立循環。

## 範圍外清單（憲法⑥）
- `src/pages/import.js`（白名單外，且本修法不需要）
- D12 mapAnkiRows、G28 重入保護 — 各自佇列
- Quizlet 匯入路徑（computeMappedQuizlet）不經 FIELD_MAP，不受影響

## 審查
- _SIMPLE_CHECK 判定：單一檔案／非共享 hot 檔（僅 pages/import.js 消費）／低風險（常數新增）／改動 <20 行 → **1 名委員**（依 GOV-BRIEF 委員協議簡化條款）。

## 版本歷程
- v1：初版送審。
