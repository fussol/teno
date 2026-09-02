# E6 計畫書 v1.2 — cmdStudy 不寫 review_log → optimize/audit 看不到 CLI 複習
（v1.1=送審前 §5 驗證設計與實跑版對齊；v1.2=R1 三委員✅後採納項＋斷言強度登記，見 §8）

## 1. Bug 定義（audit 2026-08-13 E6，行號已漂移 → 實錘 2026-08-27）
`tools/cli.mjs` cmdStudy（現 :3289-3430）互動式學習：逐題 `fsrs.review` 演進
`cardMap`、結束時整批 upsert `cards`（:3421-3425），**全程零 review_log 寫入**。
後果：
- `cli optimize`（cmdOptimize :1482+ → tools/fsrs-optimize.py `WHERE COALESCE(mode,
  'flip')=?` per-mode 過濾）看不到 CLI 複習 → 官方優化器訓練資料缺口。
- `cli audit`（review_log replay vs cards）對 CLI 學習**零知覺**：audit 說 0 差異
  不能證明 cards 可信——CLI study 寫的 cards 無對應 log，replay 直接跳過該卡
  （`for (const [wid, entries] of byWord)` 無 log 不進迴圈）。
- E4 已修 cmdRate 同類缺口，study 是最後一個會寫 cards 卻不寫 log 的入口。

## 2. Root cause 實錘（2026-08-27）
- 存檔段（:3419-3428）只有 cards upsert＋`log('WRITE', ...)` 文字日誌。
- 連帶缺陷（同函式、修法必須一併處置，理由見 §3）：
  a. **FSRS 構造脫軌**（:3299-3306）：自建 `new F(weights, ankiCfg.desiredRetention,
     true, maxIvl)` — retention **未 clamp(0.7,0.99)**（store:651-655 有）、steps 走
     split-map 無 A4 parseStepsStr 防線。E5 已把 rate/sim/audit replay 統一 fsrsCtx；
     study 是寫路徑卻仍自構 → 若只補 log 不統一構造，CLI study 寫的 stability/
     difficulty 與 audit replay（fsrsCtx 構造）漂移 → **E6 目標（audit 看得見且零假
     差異）直接破功**，重演 E5 真兇模式。
  b. **elapsed 陳舊**（:3390-3391 `card?.elapsedDays ?? 0`）：fsrs 輸入 delta_t 用
     DB 存的舊值（甚至 `elapsedDays ?? scheduledDays` 混語意，:3345 preview 路徑），
     與 E4 修前 cmdRate 同病 → 寫進 log 的 elapsed_days 與排程輸入皆髒。
- 對照權威：store.js rateCard — elapsed :684-687（normTs→toLocalDateStr→daysBetween，
  dayCutoff/tz-aware）；FSRS 構造 :650-655；steps :711-712；futureCounts :714-716；
  log 11 欄 :792-803（duration=durationMs、elapsed=** currentState.elapsedDays 覆習前**、
  scheduled=**Math.round(result.dueDays) 無條件**、stability/difficulty=複習後、
  state=複習前、newState=複習後）。

## 3. 修法（全在 `tools/cli.mjs` cmdStudy）
### 3a. FSRS 構造改 fsrsCtx(mode)（:3299-3306 退役）
```js
const { fsrs, learnSteps, relearnSteps } = fsrsCtx(mode);
```
（mode 化 ankiSettings key 讀取語意與現行手寫 baseCfg/mc/spell 分支**等價**——fsrsCtx
:138 同一映射；retention 補 clamp、steps 補 parseStepsStr 防線＝對齊 store。）
現行 :3293-3301 手載 ankiCfg 保留（仍需 timezoneOffset/leechThreshold? 無—僅 tz 與
dayCutoff 用途：tz 改由 fsrsCtx 不需——**保留 ankiCfg 讀取**，因 dayCutoff/tz 於
elapsed/queue 使用）。零引用殘留：F import、weights IIFE、split-map steps 刪。

### 3b. elapsed 改 dayCutoff-aware（評分回調內，鏡像 cmdRate E4）
```js
const atMs = Date.now();                                   // 作答時刻（逐題時間戳）
const tzM = ankiCfg.timezoneOffset ?? TZ_OFFSET;
const revToday = getToday(dayCutoff, tzM, atMs);
const lastTs = card?.lastReview ? new Date(normTs(card.lastReview)).getTime() : null;
const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), tzM, dayCutoff) : null;
const elapsed = lastDay != null ? Math.max(0, daysBetween(lastDay, revToday)) : 0;  // E4 夾零同構
```
`currentState.elapsedDays = elapsed`（原 `card?.elapsedDays ?? 0`）；`newCard.elapsedDays
= elapsed`（cards 寫回新鮮值，存檔 SQL 欄位既有、自動生效）。

### 3c. futureCounts 補上（與 store:714-716/cmdRate E5 同條件）
```js
const futureCounts = (currentState.state === 2 || currentState.state === 3)
  ? computeFutureDueCounts(cardMap, 90, dayCutoff, tzM) : null;
```
論證：E5 §4 已登記「cmdStudy futureCounts=null → 登 E6/E7 域」；audit diffs 五欄
（stability/difficulty/state/reps/lapses）不含 due/scheduled → 加與不加皆不影響
replay 比對；加＝寫入路徑與 app 完全同構（scheduled_days 落 LB 後日，貼近真機）。

### 3d. 逐題記錄＋結束同一交易寫 review_log
- 題面渲染後 `shownAt = Date.now()`（`rl.question` 前一行）；有效 rating 時
  `durationMs = Math.min(60000, Math.round(Date.now() - shownAt))`（A9 cap 60s 同構；
  無效鍵遞迴重渲染自然重置 shownAt，不計廢時）。
- 评分回調尾端 `reviews.push({ wid: item.wid, rating, durationMs, elapsed,
  prev: cardStateBefore, post: result, atMs })`（`const reviews = []` 於 askNext 前）。
- 存檔段 `dbw()` 內 cards 循環後：
```js
const ins = w.prepare(`INSERT INTO review_log (word_id, rating, duration, elapsed_days,
  scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
for (const rv of reviews) ins.run(rv.wid, rv.rating, rv.durationMs, rv.elapsed,
  Math.round(rv.post.dueDays), rv.post.stability, rv.post.difficulty, mode,
  rv.prev, rv.post.state, new Date(rv.atMs).toISOString());
```
  欄位語意逐欄對齊 store:792-803＋cmdRate E4 INSERT（同 11 欄同序）；card_state=
  評分前 currentState.state（新卡=0）、new_state=result.state；reviewed_at 逐題
  時刻（非存檔時刻）保時序。cards＋review_log 同一 `dbw()` 連接順序寫入（無顯式
  交易包框＝與 cmdRate/存檔段既有模式一致；崩潰中間態與 cmdRate 同權衡，不擴充）。
- 中途 `q` 離場：cardMap 已改寫照常存檔（既有語意），reviews 同步寫入——cards 與
  log 一致進出，不产生「有 log 無卡改動」或反之。

## 4. 可選項定案（憲法⑦）
- **duration 實測 vs null**：**實測**（readline 等待即作答時間，Anki 記 answer prompt
  滯留同語意）＋A9 cap 60s。null 保守方案否：study 是真人互動，有真值可用；E4 rate
  選 null 是因為 --date 回填無作答事實。風險（輸入法/挂机膨脹）由 cap 封頂，與 app
  cap_answer_time_to_secs 完全同軌。
- due 錨定 computeDueIso（A10）：**不做**。study 現行 `Date.now()+dueDays` 錨定作答
  時刻——與 store 端 A10 日界線錨定有偏差，但 audit 五欄不比 due → 不擋 E6 目標；
  列範圍外（study 排程錨定另案，與 sim :1324 同款）。
- mc/spell 卡片污染（base 列覆寫 vs mc_data/spell_data 承載）：**不做**＝E7 本體。
  E6 的 log 如實記錄 study「當前行為」的 fsrs 輸入輸出（card_state 取自 base 卡）；
  E7 修承載後 card_state 自然改取自 mode 卡（log 寫入結構零改動）。
- mc/spell log 的 mode 標籤：**寫 mode**（fsrs-optimize.py per-mode WHERE 實錘 :36，
  各模式獨立 ≥10 筆門檻才可優化）。
- 顯式交易包框 cards＋log（BEGIN/COMMIT）：**不做**（與全 CLI 既有寫入模式一致，
  单独给 study 加＝不一致扩充；崩潰窗口既有同權衡）。列範圍外。

## 5. 驗證方式（tools/verify-e6-study-log.mjs，已實跑 22/22 ALL PASS×4 連跑）
環境：同 E4/E5（tmp DB＋TENO_DB＋TENO_NO_BACKUP＋TZ=UTC）；互動用 spawnSync
`input:` 管線餡鍵（readline 對管線逐行工作；尾鍵必為 q 防 EOF 懸掛）。
- T1 存在性＋11 欄：study flip（seeded 到期卡 due=昨日 lastReview=3天前＋2 新卡，
  input `g\n g\n q\n`）→ review_log 恰 2 筆；逐欄：rating=2、duration 整數 0..60000、
  elapsed_days=3、scheduled_days 整數≥0、stability/difficulty 非空、mode='flip'、
  card_state=評分前（到期卡 2／新卡 0）、new_state=評分後（2|3／learning 1）、
  reviewed_at 帶 Z 逐筆非遞減；cards.elapsed_days=3 新鮮＋last_review==log 時刻。
- T2 audit 可見＋零假差異：rate 建史（good@-6d、good@-4d、**again@-2d 尾筆**——
  again learning 分鐘級 due 對任何權重恆到期，規避極端權重 good interval 跳未來）
  → study 復盤該卡 → audit 該卡進 replay（checked=1）且 0 差異（實證 fsrsCtx 統一
  後 study 寫入==replay，含 futureCounts 乾擾不污染五欄之實證）。
- T3 per-mode：study mc 1 筆 → log mode='mc'；flip audit checked=0 免疫；
  fsrs-optimize.py 同款 `WHERE COALESCE(mode,'flip')=?` 直查可視。
- T4 elapsed：cutoff=300 DB＋lastReview=48h 前**同刻**（時刻逐字保留→任何 cutoff
  下 teno 日差恆=2，不受實際執行時刻擺動）→ elapsed_days=2；亂序 lastReview 未來日
  → 夾零 0。（cutoff 邊界界線情形由 cmdRate E4 T3 已釘，study 鏡像同公式；結構上
  dayCutoff 讀 DB＋公式逐字鏡像。）
- T5 無效鍵：input `x\n g\n` → 跳過顯示＋該題僅 1 筆 log。
- T6 q 中斷一致性：答 1 題後 q → cards 該卡 last_review 已更新＋log 恰 1 筆（同進同出）。
- T7 負控制（bugsub/＋symlink src 同 E5 模式，副本落 tmp 不落 repo）：
  (a) 剝 review_log INSERT → log 0 筆但 cards reps+1（原 bug 精準重現）；
  (b) 構造回退 `new FSRS(null,...)`（忽略 settings fsrsWeights 用預設權重寫卡）＋
      DB 帶 21 項自訂權重 → audit（replay 用 settings 權重）**1 有差異**重現——
      E5 cmdRate「預設權重寫、優化權重 replay」假 mismatch 同款。knob 選 weights 而非
      retention/maxIvl：後者只影響 interval，不進 audit 五欄（實錘 diff 欄位清單）。
- 回歸：e4 24/24、e5 18/18、a10/a9/c3/c5/a3、node --check、npm run build。

### §5 修訂歷程（v1.0→v1.1，送審前與實跑版本對齊）
- T2/T7b 前置由「rate good×3 固定日期」改「good×2＋again 尾筆＋相對日期」：
  實跑發現優化級權重下 good interval 把 due 推到未來 → study 0 張、斷言假陽性/前置
  拋錯（v1.0 設計缺陷，非 code bug）。
- T7b knob 由 retention(0.5 未 clamp) 改 weights：實跑證明 retention 漂移不進 audit
  五欄 → 負控制不紅；weights 同時打中 stability/difficulty → 精準重現。
- T4 由「固定 03:00 時刻＋cutoff 跨界」改「48h 前同刻」：原版隨實際執行時刻跨越
  05:00 界線時期望值在 2/3 擺動（flaky），新版恆等。

## 6. 風險
- study 排程結果改變（retention clamp／parseStepsStr／futureCounts 生效）：對既有
  合法 settings 數值範圍內無差異；越界/畸形值從「帶病運行」變「對齊 app」——修復
  目標本身，明示。
- duration 寫入改變優化器輸入分佈（study 的 CLI 作答偏快/鍵入延遲混入）：cap 60s
  ＋與 app 同軌；若使用者反映骯髒可退 null（一行）。
- mc/spell study 仍覆寫 base 卡（E7）：E6 不掩蓋也不加劇——log 記錄當前行為，
  範圍外清單釘死。
- 官方優化政策紅線：不觸碰 optimizer 本體，只寫 log 供其消費。

## 7. 範圍外清單（憲法⑥）
- E7：study mc/spell base 卡污染（下一佇列）。
- study due 錨定 computeDueIso（A10 同款，audit 五欄不受影響）。
- study queue 構造（`due<=Date.now()` 直比、無 getDueCards cap/new 額度語意）——
  queue 模型重構另案。
- preview intervals `elapsedDays ?? scheduledDays` 混語意（:3345）——僅顯示用，
  隨 queue 重構案。
- cards＋log 顯式交易包框（CLI 全域模式統一時再論）。R1#2 複述最低修法
  （cards 迴圈前 BEGIN／w.close 前 COMMIT，約 2 行）備查。
- app undo（store:906 `DELETE log WHERE id>snap.logId AND mode`）與 CLI 寫入交錯：
  E4 已存在的既有類別風險（非 E6 引入），R1#2 判非阻斷，登已知風險。

## 8. 審查紀錄（R1，3 委員，2026-08-27/28）
- **#1 FSRS 同構性 ✅**：五審查面全過。§3a「等價」獨立查證屬實（修前 cmdStudy 即讀
  mode 化 key `ankiSettingsMc/Spell`，fsrsCtx 映射相同）；elapsed/futureCounts/fuzz
  seed/死引用零殘留逐項核證。發現 F1＝工作區混入 SR-C4 makeSession hunk（別案產物，
  見下）。F2＝malformed mode blob 回退語意微調（修後更貼 store，不修）。
- **#2 寫入路徑＋消費者 ✅**：11 欄逐欄對照表全符；消費者窮舉（cmdAudit/optimize/
  Dash/Stats/History/Report/Mature/undo/hydrate）無崩潰無語意錯亂，cmdDash 統計納入
  CLI 複習＝預期的「被看見」。首要建議：cmdStudy 補 `ensureSchema()`（對齊
  cmdRate:1284，防舊 DB 缺 new_state 欄硬失敗）→ **已採納**（commit 內）。
- **#3 驗證牙檢 ✅（變異測試 A–E）**：A 剝 push→紅（T1 精準）；C elapsed 退化→紅
  （T1+T4）；核心防線（原 bug＋構造漂移）實錘能紅。三項斷言強度缺陷如實登記者：
  (a) scheduled 整數 guard 空砲——本 FSRS binding dueDays 恆整數（實測 10/15/18/23），
  round 屬防禦性宣告非突變阻斷；(b) D3 全欄時戳坍縮至存檔時刻→T1 綠（盲區）；
  (c) duration cap 上界不可測（管線作答僅數 ms，A9 套件已釘 cap 本體）。
  建議 strict 遞增斷言堵 D3——**實測駁回**：同 session 兩題 atMs 同 ms 碰撞率
  14/20（tools 探測 /tmp/e6-gap-probe.mjs），strict 必假失敗；D3 盲區由 D1 型變異
  （僅 log 欄改時刻）之跨欄交叉檢查（last_review==reviewed_at）擋住，雙欄同改
  （=同一 bug 的完全退化）殘留失明如實登記。
- **v1.2 採納**：①ensureSchema()（cli cmdStudy save 段）；②T1 lastReview 改 72h 前
  同刻（除 UTC 午夜牆鐘，對齊 E4/E5 確定性標準）；③上述斷言強度三項如實登記（不假
  裝有防）。修後 e6 22/22×4 連跑再全綠。
- **SR-C4 hunk 處置**：makeSession 統一構造改動非 E6 範圍（E5 §範圍外:118 明示
  「dashboard 預覽類讀路徑維持預設，登範圍外」），E5 commit 未含、無人认领。為守
  憲法⑨ git 分離：本 commit 前反向套用該 hunk（cli.mjs 僅含 cmdStudy 改動），
  commit 後原樣還原工作區。歸 E5 範圍外案或 C 系列另案處理。
