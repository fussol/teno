# E5 計畫書 v1.2 — CLI rate/sim 非確定性 fuzz＋不套 greaterThanLast＋FSRS 構造脫離 settings

> v1.0 送審 R1（3 委員）：#1 ✅（附 T6 flaky MED＋T7 競態 LOW＋cmdSim reps LOW）、
> #2 ✅（附死碼 LOW）、#3 ❌（T6 flaky ~24% ＋ T6 無牙：Math.random 負控制 0/6 仍綠）。
> v1.1 修訂見 §10（凍結歷程：v1.0 本體 §1-§9 不動，僅 §4 常數決策反轉＋§9 補 v1.1 實跑）。
> R2（#3 複審，C6 先例單席）：flaky 根治 ✅（0/15）、沙箱/digest/T7/e4/無污染 ✅；
> 但 ❌ 殘留——「digest 必漂移」宣稱不實：T6 測資純新卡走不到 REVIEW（fuzz 不進
> interval），負控制轉紅係非 json 管線洩 CMD 牆鐘行的巧合。v1.2 見 §11。

## 1. Bug 定義（audit 2026-08-13 E5，行號已漂移）
- `tools/cli.mjs` cmdRate（現 :1233）與 cmdSim（現 :1288）呼叫
  `fsrs.review(..., Math.random(), ...)` — app 端是確定性 seed
  `generateFuzzFactor(wordId+'_'+mode, reps)`（store.js:709）。CLI 每次 rate 的
  fuzz 落點隨機 → due 不可重現、與 whatif/fsrs-report/未來 replay 全部不一致。
- 兩處均不傳第 6 參數 futureCounts → REVIEW/RELEARNING 卡不套 Anki greaterThanLast
  load-balancing（fsrs.js:192-206 fuzzInterval → selectIntervalWithLoadBalancing）。
- 歸因修正（實錘推理，誠實列）：audit 原報「→ audit 報 mismatch」歸因 fuzz 屬誤判 —
  fuzz 只影響 interval/dueDays，不影響 stability/difficulty/state/reps/lapses 鏈
  （fsrs.js:297-447 memory 鏈與 fuzz 無關；cmdAudit diffs 只比這五項、不比 due）。
  audit mismatch 的**真兇**是 cmdRate 經 `makeSession → new FSRS()` 用**預設權重**
  （cli.mjs:133），而 cmdAudit replay 用 `ankiSettings.fsrsWeights`（:1610）。
  使用者已跑過官方優化（DB 有激進 fsrsWeights）→ 每次 CLI rate 寫入的
  stability/difficulty 與 replay 必然漂移 → audit 假 mismatch。本 plan 一併治本。

## 2. Root cause 實錘（2026-08-27）
- app 端權威（store.js rateCard）：
  - FSRS 構造 :650-655：weights=JSON.parse(ankiCfg.fsrsWeights)、
    retention=clamp(0.7,0.99,desiredRetention??0.9)、fuzz on、maxIvl=max(1,maxIvl??365)
  - steps :711-712：`parseStepsStr(ankiCfg.learnSteps,'1,10')`（A4 共享防線，NaN/負值/0 丟棄）
  - fuzz :709：`generateFuzzFactor(wordId + '_' + mode, currentState.reps)`（reps=複習前）
  - futureCounts :714-716：僅 `state===REVIEW||RELEARNING` 時
    `computeFutureDueCounts(cardMap, 90, state.dayCutoff, ankiCfg?.timezoneOffset)`，否則 null
- CLI 端：LEARN_STEPS/RELEARN_STEPS 硬編碼（:141-142，settings 改了無視）；
  FSRS 預設權重；fuzz=Math.random()；futureCounts 未傳（undefined→fuzzInterval 內
  `futureCounts &&` falsy 跳過 load-balancing）。
- 對照組：cmdWhatif（:1702-1706）與 cmdAudit replay（:1610-1612）都已讀 settings＋
  seeded fuzz——唯 rate/sim 兩個**寫入路徑**脫軌。

## 3. 修法（全在 `tools/cli.mjs`）
### 3a. 頂層新增共享構造器（fsrs.js import 擴充 generateFuzzFactor/parseStepsStr；scheduler import 擴充 computeFutureDueCounts）
```js
// E5: 與 store.rateCard:650-655/711-716 同構 — FSRS 權重/steps 從 ankiSettings(mode 化) 讀
function fsrsCtx(mode = 'flip') {
  const key = mode === 'mc' ? 'ankiSettingsMc' : mode === 'spell' ? 'ankiSettingsSpell' : 'ankiSettings';
  let cfg = {};
  try { cfg = JSON.parse(db.prepare(`SELECT value FROM settings WHERE key='${key}'`).get()?.value || (mode === 'flip' ? '{}' : null) || '{}'); } catch { cfg = {}; }
  const weights = cfg.fsrsWeights ? (() => { try { return JSON.parse('[' + String(cfg.fsrsWeights).replace(/^\[|\]$/g, '').trim() + ']'); } catch { return null; } })() : null;
  return {
    fsrs: new FSRS(weights, Math.max(0.7, Math.min(0.99, cfg.desiredRetention ?? 0.9)), true, Math.max(1, cfg.maxIvl ?? 365)),
    learnSteps: parseStepsStr(cfg.learnSteps, '1,10'),
    relearnSteps: parseStepsStr(cfg.relearnSteps, '10'),
  };
}
```
（weights 剝殼式與 store.js:651 逐字同構；mode 化 key 讀取比照 cmdWhatif:1698-1701。）

### 3b. cmdRate
- 棄用 `session.fsrs`（session 仅剩 cards 來源，cards 直接用 `s.cards`，
  makeSession 呼叫刪除——rate 從不需 queue 模型）。
- `const { fsrs: F2, learnSteps, relearnSteps } = fsrsCtx('flip');`
- currentState 化（比照 app）：`const repsBefore = card.reps ?? 0;`
- `const fuzz = generateFuzzFactor(w.id + '_flip', repsBefore);`
- `const futureCounts = (!isNew && (card.state === 2 || card.state === 3)) ? computeFutureDueCounts(s.cards, 90, DAY_CUTOFF, TZ_OFFSET) : null;`
- `const res = F2.review({ ...card, elapsedDays: elapsed }, rating, fuzz, learnSteps, relearnSteps, futureCounts);`
- LEARN_STEPS/RELEARN_STEPS 常數在 cmdRate 內退役。

### 3c. cmdSim
- 保留 session（queue 模型是本命令目的），FSRS 改用 `fsrsCtx('flip')` 構造實例。
- fuzz：`generateFuzzFactor(wid + '_flip', card.reps ?? 0)`。
- futureCounts：與 app 同條件——`card.state === 2 || card.state === 3` 時每次迭代重算
  `computeFutureDueCounts(session.cards, 90, DAY_CUTOFF, TZ_OFFSET)`（session.cards 隨
  模擬進化，快照須即時；O(n)×50000 worst ~秒級，可接受），否則 null。
- rating 的 `[0,1,2,2,3][Math.random()*5]` **保留**（§4）。

## 4. 可選項定案（憲法⑦）
- sim rating 亂數：**保留**。sim 定位是 queue 壓力測試（找 stray 卡），評分布亂數是
  測試設計本體；`--ratings` 已是確定性入徑。fuzz 必須 seed 是因為它冒充「真實评分
  排程行為」，rating 亂數不冒充。
- cmdAudit/cmdFsrsReport replay 傳 futureCounts：**不做**。replay 無法重建歷史時刻的
  future due 快照（需逐筆回放 cards 演化），且 audit diffs 不比 due → 傳 null 現狀
  不會假陽性；代價（replay dueDays 與真 due 可能差 ±fuzz 區間）在 audit 提示行已有
  「正常漂移」免責。列範圍外。
- cmdAudit 本地 split-map steps 換 parseStepsStr：**不做**（E5 是寫入路徑；讀取路徑
  統一屬重構，範圍外登記）。
- cmdStudy mc/spell mode 化 fuzz key（現行 `wid+'_'+mode` 已正確 seeded）：不動。
- LEARN_STEPS/RELEARN_STEPS 常數刪除：~~不做~~ **v1.1 做**（R1 #2 實測頂層 :42-43 修後
  零引用——cmdSimulate :2356 為本地遮蔽宣告，非消費者——原「或仍有引用」理由不實，
  如實反轉決策：刪除死碼）。

## 5. 驗證方式（tools/verify-e5-seeded-fuzz.mjs，送審前實跑）
- 環境：同 E4（tmp DB＋TENO_DB＋TENO_NO_BACKUP，TZ=UTC）。
- T1 確定性：同卡同 --date 同 rating 跑兩次（每次新建 DB 副本）→ cards.due 一字不差；
  Math.random 版會漂移（負控制）。
- T2 seed 對齊 app：rate 後讀 DB due，獨立重算 `generateFuzzFactor(id+'_flip', reps)`
  餵官方 fsrs.review 得同 due（端到端同構證明）。
- T3 fsrsWeights 生效：settings 寫入自訂權重（如預設 21 欄 +10 偏移）→ rate 後
  cards.stability ≠ 預設權重結果、= 權重重算值；audit replay 同值（mismatch 消失實測：
  rate 後跑 `cli audit` → 0 issues）。
- T4 greaterThanLast：構造 futureCounts 全 0 與某天擁擠的兩張 DB，同 fuzz seed 下
  比較 due 是否被 load-balancing 移位（選最低負載日）；非 REVIEW 卡不受影響。
- T5 learnSteps from settings：settings.learnSteps='5,20' → rate 新卡 step 間隔
  5/20 分鐘（due 差可測）；畸形 `','` → parseStepsStr 丟棄畢業 REVIEW 不崩（A4 防線）。
- T6 sim 確定性：同 DB 副本跑 `sim --ratings 2,2,2` 兩次輸出一致（stray/計數同）。
- T7 負控制：剝除（Math.random fuzz＋預設 FSRS＋null futureCounts）→ T1 漂移重現、
  T3 audit mismatch 重現。

## 6. 風險
- rate 排程行為變更：用 fsrsWeights 的用戶，CLI rate 結果將改變（從「錯的預設權重」
  變成「對的 settings 權重」）——這是修復目標本身，但屬行為變更，明示。
- fsrsCtx 讀不存在的 ankiSettings key → {} → 預設權重（與現狀同，無回歸）。
- sim 每迭代重算 futureCounts 的效能：O(cards)×迭代數，50k 上限下 worst 秒級。
- 官方優化政策紅線：不觸碰隔離 optimizer；fsrsCtx 只讀 settings。

## 7. 範圍外清單（憲法⑥）
- cmdStudy review_log 缺寫（E6）、mc/spell base card 污染（E7）。
- cmdAudit/cmdFsrsReport/whatif 本地 split-map steps 未用 parseStepsStr（讀路徑重構）。
- replay 無法重建歷史 futureCounts（本 plan §4 論證不需要）。
- makeSession 其他命令仍用預設 FSRS（dashboard 預覽類讀路徑，錯權重影響預測非持久化；
  若要統一應另立重構案）。

## 8. 連帶維護（本 plan 直接造成的既有驗證腳本適配）
- `tools/verify-e4-rate-log.mjs` T6 負控制 strip 第 1 對原本剝除
  `session.fsrs.review({ ...card, elapsedDays: elapsed }, rating` — 本修法把 cmdRate
  呼叫端改為 `fsrs.review(`（fsrsCtx 構造），字串不再命中 → 負控制 throws。
  strip 字串適配為 `fsrs.review({ ...card, elapsedDays: elapsed }, rating` →
  `fsrs.review(card, rating`（**剝除語意逐字不變**：去掉 elapsedDays 注入餵 stale card），
  斷言零改動。適配後實跑 **24/24 ALL PASS**（含 T6 負控制 4 斷言精準重現）。
- 驗證腳本白名單歸 PM2 所有，此屬 E5 修法必要連帶，非範圍膨脹。

## 9. 驗證實跑記錄（送審前，2026-08-27）
- `node tools/verify-e5-seeded-fuzz.mjs` → **15/15 ALL PASS**（T1 確定性、T2 e2e replay
  同構、T3 兩儲存格式權重生效＋audit 0 差異、T4 LB 擠開＋learning 不受影響、
  T5 steps from settings＋畸形畢業、T6 sim 確定性、T7 負控制隨機漂移＋audit mismatch 重現）
- 回歸：verify-e4 24/24、verify-a10 ALL PASS、verify-a9 ALL PASS、verify-c3 ALL PASS
  （a10/a9/c3 須 `node --experimental-test-module-mocks --test` 啟動，腳本內記載之既有用法）、
  verify-a3 7/7；`node --check tools/cli.mjs` 通過；`npm run build` 694ms 通過。
  ⚠️ v1.1 追查：v1.0 此節「15/15」在 T6 上**不可穩定重現**（R1 #3 連跑 29 次僅 22 次
  15/15），如實登記，v1.1 修因後重測見 §10。

## 10. v1.1 修訂（R1 審查後，2026-08-27）

### 10a. R1 裁決
- #1 修法正確性 ✅：六點同構逐字核對全過（FSRS 構造/steps/fuzz seed reps/futureCounts
  型別 Map/新卡 stability NOP 論證 fsrs.js:301 nth 忽略/s.cards≡session.cards 同參考）；
  附 MED：verify T6 flaky；LOW：T7 固定檔名落 repo、cmdSim card.reps 恆 0。
- #2 消費者完整性 ✅：makeSession 消費者窮舉（cmdSim/cmdStray/cmdFix，唯 cmdSim 涉
  FSRS 且已收斂；stray/fix 直接 SQL 非 FSRS 值寫路徑）；cmdStudy 係寫路徑但已自讀
  settings 權重＋seeded fuzz（缺口 futureCounts/review_log/base 污染＝E6/E7 範疇正確）；
  audit 非 flip log 不 replay（WHERE mode flip）；base stability 2.5→0 為**修復**非風險
  （fsrs.js:119 init 分支 nth=0&&stability=0 才觸發，舊 2.5 跳過 init 反致首筆假陽性）；
  附 LOW：LEARN_STEPS 頂層死碼、cmdAudit anki/F 未用變數。
- #3 測試區分力 ❌：T6 flaky（~24%，實測 29 跑 7 敗）＋**無牙**（cmdSim fuzz 剝回
  Math.random 後雙副本比較 0/6 仍綠——計數行對 fuzz 不敏感，真變因是 :1324 牆鐘）；
  T7/E4 適配/其餘 13 斷言品質確認有牙（T2 真獨立 replay、T3 雙格式雙向、T7 兩 strip
  精準命中）。

### 10b. v1.1 修訂項（全部對應 R1 發現，無新增範圍）
1. **cmdSim `--now <ISO>` 時鐘沙箱**（cli.mjs cmdSim 頭）：SandboxDate 完整替換
   globalThis.Date（無參構造錨定 nowMs＋static now()），根除 :1324/新卡 :1317 牆鐘
   敏感。只覆 Date.now 不足（cmdRate 模式抓不住 new Date() 無參構造），故用完整
   Date 替換＋setTimeout(0) 還原；迴圈純同步無 await，沙箱無異步逃逸。無效時間
   → 明確報錯返回。
2. **cmdSim digest 行**：最終卡狀態（id/state/step/reps/interval×1e6/due 排序串）
   sha256 前 16 hex，`console.log('digest=…')`＋READ log。確定性驗證錨點——fuzz
   任何非確定性必翻 digest（補 T6 牙）。需 import node:crypto。
3. **cmdSim reps 推進**：`card.reps = res.reps ?? (card.reps??0)+1`（R1 #1 LOW；貼齊
   app 每複習 reps+1 → fuzz seed 逐次變異＋queue cmpByRepsThenDue 排序正確；修前
   reps 恆 0 同卡 seed 恆定）。
4. **死碼清理**（R1 #2 LOW）：頂層 LEARN_STEPS/RELEARN_STEPS 刪除；cmdAudit 未用
   `as`/`anki`/`FSRS: F` 移除（SN/generateFuzzFactor 留）。
5. **verify T6 重寫**：`--now 2026-04-01T08:00:00Z` 下同 DB ×3 全輸出**逐字**一致
   （修前 norm 剝时间戳＋跳開始/結束行＝掩蓋牆鐘漂移的元兇之一）＋digest 一致＋
   **負控制**：cmdSim fuzz 剝回 Math.random（凍結條件不變）雙副本 digest 必漂移
   （牙，實測 buggy 兩跑 g1≠g2 通過）。
6. **verify T7/buggy 副本落盤**：固定名 `.e5-buggy-cli.mjs` 落 repo tools/ → 改 tmp
   `dir/bugsub/` ＋ pid 唯一名；cli.mjs 相對 import `../src/…` 需在 tools 同深度——
   tmp 內建 `dir/src` symlink → `../src`（此即 v1.0 落 repo 的真实原因，如實記錄；
   R1 #1 猜的 write→spawn 可見性競態非主因，主因是路徑深度，改後 12/12 跑零再現）。

### 10c. v1.1 實跑記錄
- `node tools/verify-e5-seeded-fuzz.mjs` 連跑 **12 次 0 失敗，17/17 ALL PASS**
  （v1.0 15 斷言 → v1.1 T6 拆 3 斷言：×3 逐字一致／digest 一致／負控制漂移）。
- repo 零污染（tools/ 無 e5-buggy 殘留）。
- 回歸：verify-e4 24/24（負控制 strip 不受影響）、a10/a9/c3 module-mocks 全 fail 0、
  a3 7/7、c5 96/96；`node --check` 過；`npm run build` 766ms。
- 官方模擬器 simulate_fsrs（E5 政策紅線）未觸碰；cmdSimulate（:2356 本地 steps）未動。

## 11. v1.2 修訂（R2 後，2026-08-27）— 僅動驗證腳本 T6，code 零改動

憲法⑩自查：R1/R2 連兩輪同類缺陷（T6 無牙）→ 非盲補丁循環：v1.2 修法＝R2 委員
**本人實測驗證過的處方**（「預置 REVIEW 卡 buggy digest 真漂移」為其親跑數據），
屬證據先行、對症下藥，非重估替代結構時機（沙箱＋digest 機制本體 R2 已判合格）。

### 11a. R2 殘留缺陷根因
1. **測資到不了 REVIEW**：30 純新卡＋ratings 2,2,2,0,2 序列下，sim 迴圈在畢業前
   終止；fuzz 只作用於 REVIEW/RELEARNING 間隔與畢業 interval——digest 對 fuzz 無感。
2. **負控制管線不同構**：v1.1 負控制走裸 spawnSync（非 `--json`）→ CLI 啟動/CMD
   牆鐘行洩入 stdout，g1≠g2 靠時間戳巧合而非 digest——假陽性紅，非牙。

### 11b. v1.2 修法（tools/verify-e5-seeded-fuzz.mjs T6 區塊）
1. 測資加 4 張預置 REVIEW 卡（state=2、due=2026-04-01T02:00Z 當日已到期、
   stability 4/11/18/25、reps 5/8/11/14 各异）→ sim 內必復盤 REVIEW → fuzz 進
   interval/due → digest 敏感。
2. 負控制改走與正控制**同一 `cli()` json 管線**（`cli(db, ARGS, buggyCli)`，bin 參數
   本已存在）→ 輸出僅含確定性內容，g 漂移唯一來源＝fuzz 隨機性。
3. T6 斷言 4 條：×3 逐字一致／digest 在場一致／buggy ×3 digest 落點 >1 種／
   clean digest 偏離 buggy 落點集。總斷言 17→18。
   雙向封死：**回歸偵測**（真 CLI 若改回 Math.random → 正控制 ×3 逐字一致必紅，
   因 digest 已 fuzz 敏感）＋**判別力自證**（負控制同管線下漂移）。

### 11c. v1.2 實跑
- 單跑 18/18 ALL PASS；連跑 **15 次 0 失敗（每次 18/18）**；repo 零污染。
- 回歸 verify-e4 24/24（strip 字串不受 T6 重寫影響）。
- code（tools/cli.mjs）與 v1.1 完全相同——本輪僅驗證腳本。
