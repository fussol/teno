# E5 R1 審查委員 #2 — 消費者完整性／回歸掃描（2026-08-27）

被審物件：工作區未 commit `tools/cli.mjs`（HEAD + E5，49+/13-）。全程唯讀；
實測＝node --check、verify-e5（15/15 獨立重跑 ALL PASS）、verify-e4（24/24 獨立重跑 ALL PASS）、
性能 microbench、sqlite3 -readonly 查真 DB。

## 焦点 2（疑似 HIGH 候選）— 單位一致性：**不成立 HIGH，✅ 通過**
- fsrs.js:29-30 `parseStepsStr` 回傳 **天數**（`parseFloat/1440`，A4 濾 NaN/負/0）。
- fsrs.review 預期天數：fsrs.js:310-313 預設 `[1/1440,10/1440]`、:365 直接餵 step  delay。
- 修前 cmdAudit split-map `parseFloat(x)/1440` 亦天數；store.js:711-712 傳 parseStepsStr 結果。
- **三方同單位（天）**。E5 換 parseStepsStr 只增 A4 防線＋預設值語意，單位零變化。
- 差異僅：修前 audit 對 `learnSteps='0'` 会产生 0 步（保留），修後丟棄（=app 語意）→ 更對齊，非回歸。

## 焦点 1 — fsrs.review/write 呼叫點窮舉（cli.mjs 全檔 3651 行）
寫入路徑（落庫 cards/review_log）：
| 位置 | 命令 | 權重 | fuzz | LB | 判定 |
|---|---|---|---|---|---|
| :1260 | cmdRate | fsrsCtx ✅ | seeded ✅ | ✅ | E5 已修 |
| :3373 | **cmdStudy** | 讀 settings（但無 clamp） | seeded ✅ | **null** | **MED-1** |
| :2556 | cmdSimulate | 讀 settings | 種子 mulberry32（可重現） | null | 隔離 sim DB，公道豁免 ✅ |

讀取/預測路徑：cmdSim(:1323，log READ 不落庫，mkSession 僅 queue 模型)、cmdFsrsReport(:1550)、
cmdAudit(:1672)、cmdWhatif(:1757)、cmdSelfTest(:2215 fuzz off 斷言)、session-v4:349(僅 computeIntervals 預覽)。
非 FSRS 寫入（確認不誤傷）：cmdExamRun（exam_history+tags，Math.random 屬 mock 評判）、
cmdFix（raw UPDATE 不經 FSRS）、cmdImportCsv/cmdImportDb、cmdResetCard、cmdStray。
makeSession 其他使用者（cmdStray:1354、cmdFix reset-stray:1416）僅用 queue 模型產 due 佇列，
預設 FSRS 不影響其 raw 寫入欄位 → 計畫書 §7 豁免公道。

### MED-1 計畫書 §2「唯 rate/sim 兩個寫入路徑」不实 — cmdStudy 是第三個寫入路徑
cmdStudy(:3266) 結尾 INSERT/UPDATE cards 落庫（:3391-3400），且與 E5 同類偏差未修：
1. futureCounts=null（REVIEW 卡無 LB → 與 app/rate 排程 due 偏差，E5 親手立的新標準下屬同類脫軌）
2. `ankiCfg.desiredRetention` 無 clamp（fsrs.js constructor 預設 0.9 僅救 undefined，越界值 0.5 照收；app clamp 0.7-0.99）
3. due 走 `Date.now()+dueDays`，未用 computeDueIso 日界線錨定（A10 違規，既有）
4. steps split-map 無 A4 防線
非代碼回歸（既有、E5 未使其變壞；LB 不影響 audit 五欄 → 不會假 mismatch），
但 §7 僅登記 cmdStudy 的 E6(review_log 缺寫)/E7(容器污染)/fuzz key，上述 4 項未列 →
憲法⑥範圍外追蹤缺口。修法：計畫書 v1.1 §7 補登記（建議併 E6/E7 或另立 E8）。

### MED-2 計畫書 §6 性能宣稱低估 2-3 個數量級（實測）
microbench（本機實跑）：computeFutureDueCounts 單次 — 2k 卡 1.5ms／20k 卡 14.8ms／50k 卡 39ms。
cmdSim 每迭代重算 → §3c/§6「O(n)×50000 worst ~秒級」**不實**：50k 卡×50k 迭代 ≈ 1950s（32 分鐘）。
現實緩衝：迭代數實際受 ANKI maxReviewsPerDay=1000 壓著（非 50k），1.6k 卡（使用者現況）≈2s 可接受。
修法：§6 改正確量級＋（可選）review 卡 due 變動才重算或每 k 迭代快取。不阻塞（read-only 工具、可 Ctrl-C）。

### MED-3 fsrsWeights bracket 剝殼只修一半（既有脆弱面，§7 未登記）
fsrsCtx/store 用 `replace(/^\[|\]$/g,'')` 兩格式兼容；但 cmdWhatif:1739、cmdFsrsReport:1528、
cmdSimulate:2355 仍 `'['+w+']'` 直拼 → 使用者在設定 textarea 貼 **帶 bracket** 權重（settings.js:965
僅 `.trim()` 直存）→ `'[[..]]'` JSON.parse 成功得嵌套陣列 → `w[20]=undefined` → NaN 無聲擴散，
audit diffs `Math.abs(NaN-x)>0.05` 恆 false → **無聲假通過**。實測現 DB 為 bare 格式（'0.3306, 5.2642…'）
未觸發 → 非 live bug。修法：§7 補登記「讀路徑 fsrsWeights 統一走 fsrsCtx/剝殼」列重構。

## 焦点 3 — cmdWhatif/cmdFsrsReport 舊構造不動的論證：**大致公道，一處論證錯置**
- report/audit：replay 論證成立（歷史 futureCounts 不可重建、diffs 不比 due → 傳 null 無假陽性，
  fsrs.js fuzzInterval 僅影響 interval/due，不觸 stability/difficulty 鏈 — 已核 fsrs.js:192-206 源碼）。
- **whatif 例外（LOW-3）**：whatif 是**前瞻預測**非 replay——futureCounts 完全可即時計算（cardMap 在手），
  §4 免責論證對其**不適用**；且 session-v4:343 computeIntervals 預覽**有** LB → whatif 預測與
  App 實際排程/預覽按鈕差 ±fuzz 日。既有問題，修法＝§7 補一行登記即可。

## 焦点 4 — import/殘留：**✅ 乾净**
- cmdRate 全文（:1221-1291）零 `session` 殘留引用（實讀驗證）。
- FSRS import 仍被 :133/:148 用、Session 仍被 :133/:2521 用、computeFutureDueCounts 被 1259/1322 用
  → 無 import 炸。node --check 通過。
- cmdAudit:1635 `const anki` 改後成死變數（且無 try 的 JSON.parse 為既有炸點）→ LOW-4 順手清。

## 焦点 5 — loadState 欄位形狀：**✅ 實錘**
loadState SELECT(:102-104) 含 `last_review,state,reps,elapsed_days,scheduled_days,step,due,stability,difficulty`
→ cmdRate 讀 card.lastReview（E4 elapsed）、card.state/reps（fuzz+LB 條件）、review_log 讀 card.state
全部在場。新卡合成物件補齊同形欄位。

## 焦点 6 — LEARN_STEPS/RELEARN_STEPS 頂層常數：**死碼確認（LOW-2）**
全檔引用：:42-43 定義、:2356-57 cmdSimulate 內同名 local、:2556 唯一使用點在 cmdSimulate 作用域
→ 被 local shadow，頂層常數 E5 後**零引用**。計畫書「grep 實證後如零引用則留檔無害」兌現，
建議後續波直接刪（防未來誤用舊硬編碼）。

## 焦点 7 — 見 MED-2（已實測）。

## 其餘驗證
- fuzz seed 式逐字對齊：rate `w.id+'_flip'`、sim `wid+'_flip'`、study/report/whatif `wid+'_'+mode`
  == store.js:709 `wordId+'_'+mode`；reps 皆取**複習前** ✅。
- LB 條件（state 2/3、新卡 null、快照於複習前 cardMap）與 store.js:714-716 同構 ✅
  （scheduler 版與 session._computeFutureCounts 是 app 內兩套平行實作，CLI 對齊 store 端＝權威寫入端，正確）。
- fsrsCtx SQL 用參數綁定（計畫書展示的字串插值已改善）✅。
- 獨立重跑：verify-e5 **15/15 ALL PASS**、verify-e4（§8 適配版）**24/24 ALL PASS**、node --check OK。
- dashboard.js 工作區改動未碰未評（屬另一首相）。

## LOW 彙整
- LOW-1 fsrsCtx：settings 值='null' 時 JSON.parse 成功得 null，try 外 `cfg.fsrsWeights` TypeError
  （DB 損壞場景）。修法 `if (v) cfg = JSON.parse(v) ?? {}`。
- LOW-2 頂層 LEARN/RELEARN_STEPS 死碼（見焦点 6）。
- LOW-3 whatif LB 缺席＋§4 論證錯置（見焦点 3）。
- LOW-4 cmdAudit 死變數 `anki`。

## 结论
代碼改動本身正確：單位三方一致（HIGH 嫌疑排除）、seed/LB/構造同構實錘、無回歸、驗證獨立復跑全過。
問題集中於**計畫書完整性**：§2「唯二寫入路徑」事實錯誤（MED-1）、§6 性能宣稱與實測差 2-3 個
數量級（MED-2）、§7 登記缺兩（MED-3、LOW-3）——皆屬憲法②⑥⑧精神下的送審文件硬傷，非代碼缺陷。

裁決: ❌（代碼零修改即可複審；計畫書升 v1.1：§2 改「rate/sim/study 三寫入路徑，study 偏差四項如實登記 §7」、
§6 以實測數字改寫性能量級、§7 補「讀路徑 fsrsWeights bracket 剝殼統一」＋「whatif 前瞻無 LB」兩條）
