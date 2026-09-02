# A1-fix-plan — greaterThanLast 三態（含鏈式下限）

> 版本：v1.3（R3 審查後升版 — 定案）
> 範圍：組一「學習核心」— src/core/fsrs.js、src/engine/session-v4.js、src/lib/store.js、tools/verify-undo-cycle.mjs、tools/cli.mjs（補丁 1 處）、tools/verify-next-after-undo.mjs（補丁 1 處）
> 依據：fix-plan-critical-v3.md 批次 3（A1 → A2 同批同 fuzz 點；本計畫為 A1 部分，A2 另案）
> 狀態：R3 送審 3/3 ✅（附條件，全為文件/測試規格層級）→ v1.3 處置條件後定案，准予動工

---

## 1. Bug 定義

複習（review 狀態）卡片評分時，Anki 的 **greaterThanLast** 語意要求：

1. 該 rating 的 fuzz 後間隔必須 **嚴格大於卡片上一間隔**（prevIvl）；
2. 四個按鈕間隔必須 **嚴格遞增**：hard < good < easy（fuzz 後）。

> R3 補註：branch3（shrunk，間隔縮水，FSRS 參數變動/早複習所致）為 Anki parity 例外，允許 HARD ≤ prevIvl（見 §3.1a）；§1 的「嚴格大於」指 branch1/2 情境與 rating 間鏈式。

現況 **兩項都不保證**：

- `src/core/fsrs.js` 的 `review()`（:325-339 尾部 fuzz block）對 review 卡評 HARD/GOOD/EASY 一律以 `min=1` 做普通 fuzz，**沒有 prevIvl 下限、沒有 rating 間鏈式**；
- 呼叫端散落多處各自硬改 `result.dueDays`，且**邏輯不一致**（有的有鏈式、有的沒有）：
  - `store.js:611-614`（rateCard）：只有「> prevIvl」單層，**無鏈式**；
  - `session-v4.js:339-344`（computeIntervals）：有「> prevIvl」+「> lastPassing」鏈式；
  - `store.js:1494-1497`（runMatureSimulation）：只有「> prevIvl」單層；
  - `tools/cli.mjs:2489-2491`（build 模擬）、`tools/verify-next-after-undo.mjs:79-81`、`tools/verify-undo-cycle.mjs:49-52,79-82`：同型補丁。
- 補丁是 **fuzz 之後硬改**，會製造 fuzz 範圍外的值（破壞 fuzz 機率分布、與按鈕預覽不一致）。

**具體故障**：同一張卡在 rateCard（實際寫入）與 computeIntervals（按鈕預覽）看到的 good/easy 間隔不同；good 可能 ≤ hard；easy 可能 ≤ good。

## 2. Root Cause

`fsrs.js` 的 `review()` 是唯一排程計算點，但對 review 卡評分未實作 greaterThanLast 三態；且 fuzz 點不唯一（補丁繞過 fuzz 在呼叫端硬改），導致各呼叫端各自為政。

## 3. 修法

### 3.1 `src/core/fsrs.js`（核心）

**a) 新增 module 級函數**（放在 `constrainedFuzzBounds` 之後、`withReviewFuzz` 之前）：

```js
/**
 * Anki greaterThanLast：回傳該 rating 的 fuzz 下限（min）。
 * branch 1：raw 四捨五入後已大於 prevIvl → 下限 = prevIvl+1（fuzz 可下偏，強制至少 +1）
 * branch 2：prevIvl 落在 fuzz 範圍內 → 下限 = prevIvl+1
 *           （R1 修正：v3 原為 prevIvl，但 fuzz=0 等值點與短間隔退化區間會產出
 *             == prevIvl，違反「嚴格大於」；Anki 原文 branch2 為 prevIvl（允許等值），
 *             本計畫刻意採 +1 以滿足 §1 嚴格大於 — 計畫語意下 H/G/E 永不 == prevIvl）
 * branch 3（shrunk）：prevIvl 超出 fuzz 範圍（間隔縮水，FSRS 參數變動/早複習所致）→ 0（不設下限）
 */
function minReviewFuzzInterval(raw, prevIvl, maxIvl) {
  const rounded = Math.round(raw);
  if (rounded > prevIvl) return prevIvl + 1;
  const [, upper] = constrainedFuzzBounds(raw, 1, maxIvl);
  if (prevIvl <= upper) return prevIvl + 1;
  return 0;
}
```

> 註：prevIvl === maxIvl 時 prevIvl+1 超界，constrainedFuzzBounds 會 clamp 回 maxIvl → 三鍵全 == maxIvl，屬不可避免的 cap 語意（測試豁免，見 §5-5）。

**b) `review()` 的 review 分支改回傳 raw**（:314-323 的 `else` 分支）：

現況 HARD/GOOD/EASY 直接 `interval = next_interval(...)`（即 raw）。**維持**：interval 放 raw（未 round），由尾部唯一 fuzz 點處理。AGAIN 分支不變（relearning）。

**c) 尾部 fuzz block（:325-339）「取代」為唯一 fuzz 點**（注意是取代不是插入，避免二次 fuzz）：

```js
if (newState === STATE_REVIEW) {
  if (state === STATE_REVIEW && rating >= HARD) {
    // review 卡三態鏈式：依 rating 依序算 HARD → GOOD → EASY，前一 rating 用 fuzz 後值
    const prevIvl = Math.round(card.scheduledDays ?? card.interval ?? 0);
    let prevFuzzed = 0;   // 前一 rating 的 fuzz 後值
    let goodRaw = 0;      // GOOD raw（A2 使用；A1 先備妥）
    for (const r of [HARD, GOOD, EASY]) {
      const m = step(this.w, delta_t, r,
        { stability: stability ?? 0, difficulty: difficulty ?? 5 }, nth);  // R1: 與頂部正規化一致
      const raw = next_interval(this.w, m.stability, this.desiredRetention);
      if (r === GOOD) goodRaw = raw;
      let min = Math.max(1, minReviewFuzzInterval(raw, prevIvl, this.maximumInterval));
      if (r === GOOD) min = Math.max(min, prevFuzzed + 1);
      if (r === EASY) min = Math.max(min, prevFuzzed + 1);   // A2 另加 round(goodRaw)+1
      prevFuzzed = fuzzInterval(raw, min, fuzzFactor, futureCounts,
        this.maximumInterval, this.enableFuzzing);
      if (r === rating) { interval = prevFuzzed; break; }
    }
  } else {
    // 非 review 卡（new/learning/relearning 畢業）：維持普通 fuzz（min=1）
    let rawIvl = clamp(Math.round(interval), 1, this.maximumInterval);
    if (this.enableFuzzing && fuzzFactor != null && rawIvl >= 3) {
      const [lower, upper] = constrainedFuzzBounds(rawIvl, 1, this.maximumInterval);
      if (futureCounts && futureCounts.length > rawIvl) {
        rawIvl = selectIntervalWithLoadBalancing(rawIvl, [lower, upper], futureCounts, fuzzFactor);
      } else {
        rawIvl = withReviewFuzz(fuzzFactor, rawIvl, 1, this.maximumInterval);
      }
    }
    interval = rawIvl;
  }
}
```

新增 module 級 helper `fuzzInterval`（**不依賴 this**，R1 修正）：

```js
/**
 * 唯一 fuzz 執行點（供鏈式迴圈使用）。結果保證 ≥ min 且為整數。
 * fuzz 停用（enableFuzzing=false 或 fuzzFactor==null）時走 clamp 路徑但仍尊重 min（鏈式保留）。
 */
function fuzzInterval(raw, min, fuzzFactor, futureCounts, maxIvl, enableFuzzing) {
  if (!enableFuzzing || fuzzFactor == null) {
    // R2 修正：min 先 clamp 到 maxIvl，避免 min > maxIvl 時產出 maxIvl+1..+3（破 cap）
    const m = Math.min(min, maxIvl);
    return Math.round(Math.max(m, Math.min(maxIvl, raw)));
  }
  const [lower, upper] = constrainedFuzzBounds(raw, min, maxIvl);
  if (futureCounts && futureCounts.length > Math.round(raw)) {
    // R1 修正：先整數化再進 load balancing（避免早退回傳未 round 的浮點 raw）
    const day = Math.max(lower, Math.min(upper, Math.round(raw)));
    return selectIntervalWithLoadBalancing(day, [lower, upper], futureCounts, fuzzFactor);
  }
  return withReviewFuzz(fuzzFactor, raw, min, maxIvl);
}
```

> ⚠️ `selectIntervalWithLoadBalancing`（:195-213）**本身不改**（其早退 `return interval` 在 fuzzInterval 內已被「先 round 再傳」擋住；既有呼叫端皆傳已 round 值，早退現況為死碼）。
> ⚠️ 舊 fuzz block（:328-337 的 fuzz 邏輯）被上述 `else` 分支的「非 review 卡」版本取代（原內容即該邏輯，等價搬移）。

**d) `nextStates()`（:231-244）不修改**（A1 範圍外；全庫零呼叫端）。

### 3.2 移除散落補丁（7 處）+ 死變數（1 處）

| 位置 | 現況 | 處置 |
|---|---|---|
| `src/lib/store.js:611-614`（rateCard） | 單層「> prevIvl」 | **整段移除** |
| `src/engine/session-v4.js:339-344`（computeIntervals） | prevIvl + lastPassing 鏈式 | **整段移除** |
| `src/engine/session-v4.js:336` | `let lastPassing = 0;` | **一併刪除**（R1 F6：成為死變數） |
| `src/lib/store.js:1494-1497`（runMatureSimulation） | 單層「> prevIvl」 | **整段移除** |
| `tools/cli.mjs:2488-2491`（build 模擬評分循環） | 單層「> prevIvl」 | **整段移除含守衛行**（R1 F3a：活工具，模擬 rateCard，須同步） |
| `tools/verify-next-after-undo.mjs:78-81`（rate() helper） | 單層「> prevIvl」 | **整段移除含守衛行**（R1 F3b） |
| `tools/verify-undo-cycle.mjs:49-52, 79-82` | 單層「> prevIvl」×2 | **整段移除** |
| `src/lib/deprecated/sim-engine.js:196-199` | 同型補丁 | **不動**（全庫無引用死檔；計畫書註明排除理由） |
| `_dev/cli/cli.mjs:2435-2439` | 同型補丁 | **不動**（R3：凍結死檔 — git 追蹤但 E1 已改 lib.rs fallback 至 tools/cli.mjs，全庫無執行路徑） |

移除後呼叫端直接用 `result.dueDays`（fsrs 已輸出最終 fuzz 值）。

### 3.3 不修改

- `src/lib/chart.js`、`src/styles/base.css`（任務禁令）
- `src/core/fsrs.js` 的 `nextStates()`、`withReviewFuzz`、`constrainedFuzzBounds`、`selectIntervalWithLoadBalancing` 既有語意
- store.js 快照/undo（C1/C2 範圍）

## 4. 使用點窮舉

### 4.1 `fsrs.review(` 呼叫端（grep 形態一）— 全庫 19 處（18 列）

| 檔案:行號 | 用途 | 改動 |
|---|---|---|
| `src/lib/store.js:609` | rateCard 實際排程 | 補丁 :611-614 移除 |
| `src/lib/store.js:1493` | runMatureSimulation 模擬 | 補丁 :1494-1497 移除 |
| `src/lib/store.js:1565`（previewIntervals） | 單卡預覽（無補丁） | 不改，沿用 dueDays |
| `src/engine/session-v4.js:338` | computeIntervals 按鈕預覽 | 補丁 :339-344 + :336 移除 |
| `tools/verify-undo-cycle.mjs:47,77` | 驗證工具 | 補丁 :49-52、:79-82 移除 |
| `tools/verify-next-after-undo.mjs:77` | 驗證工具 | 補丁 :79-81 移除 |
| `tools/cli.mjs:2482` | build 模擬評分 | 補丁 :2488-2491 移除（含守衛行） |
| `tools/cli.mjs:1203,1250` | session 佇列（無補丁） | 不改 |
| `tools/cli.mjs:1477` | replay 狀態重建（無補丁） | 不改 |
| `tools/cli.mjs:1598` | 重算比對（無補丁） | 不改 |
| `tools/cli.mjs:1683` | whatif（無補丁） | 不改 |
| `tools/cli.mjs:3242,3256` | queue 預覽（無補丁） | 不改 |
| `tools/cli.mjs:3303` | 互動評分（模擬 rateCard，無補丁） | 不改（沿用 dueDays，自動一致） |
| `tools/cli.mjs:2142,2145` | FSRS self-check（fuzzFactor=null） | 不改（null-gate clamp 路徑，結果與現況同） |
| `src/lib/deprecated/sim-engine.js:195` | 死檔 | 不改 |

> R2 修正：§4.1 標題計數改 **19 處**（上表 18 列 + verify-undo-cycle 1 列含 2 點）。
> R3 註記：self-check 兩處以 `f.review` 呼叫（變數名 `f`，fuzzFactor=null）；`_dev/cli/cli.mjs` 另 9 處呼叫端為凍結死檔不計入（見 §3.2 排除註記）。

### 4.2 間隔下限殘留（grep 形態二：`dueDays <=` / `lastPassing` / `prevIvl`）

- `session-v4.js:340-343`（lastPassing 鏈式）→ 隨補丁移除；`:336` 死變數一併刪
- `store.js:612-613`、`store.js:1495-1496` → 隨補丁移除
- `cli.mjs:2490-2491`、`verify-next-after-undo.mjs:80-81`、`verify-undo-cycle.mjs:50-51,80-81` → 隨補丁移除
- `src/lib/deprecated/sim-engine.js:197-198` → 死檔不動
- `store.js:621,629`：`Math.round(result.dueDays)` — fsrs 回傳已是整數（fuzzInterval 全路徑產整數），round 冪等，**不需改**（learning 分數步走 ternary 不加 round，既有語意保留）

### 4.3 字串形態（grep 形態三）

- `dueDays <=`、`prevIvl + 1`、`lastPassing`：全部為上述補丁（4.2 表），移除後全庫無殘留（deprecated 除外）
- `generateFuzzFactor(wordId + '_' + mode,`：store.js:597、session-v4.js:330、previewIntervals:1549 — 三端同源同參，鏈式跨呼叫端一致（確認，不需改）

## 5. 驗證項目（實測證據）

R1 委員建議的必加測試全數納入。fsrs.js 為純 ES module 可直接 node 測試；store.js 因 import @tauri-apps/api/core 無法 node import → 以「複刻呼叫形狀」驗證（node 模擬 rateCard 的參數組裝與 fsrs.review 呼叫）。

1. **三態鏈式單元測試**（node 直測 fsrs.js）：review 卡（prevIvl∈{1,2,3,10,30,100,365}、含剛畢業卡 stability=0.8；**準時卡構造：stability ≈ prevIvl，實測 raw_HARD≈2.3×prevIvl、raw_GOOD≈3.2×prevIvl，三鍵皆落 branch1/2**）斷言 **GOOD > HARD、EASY > GOOD** 嚴格成立，fuzzFactor ∈ {0, 0.001, 0.5, 0.999}（fuzz=0/0.999 是 generateFuzzFactor 實測可達的極端值 — 掃描確認存在輸入使 f==0 與 f≥0.999）。**「HARD > prevIvl」僅於 minRFI branch1/2 情境斷言**（branch3 shrunk 允許縮水，Anki parity，見 §3.1a）；branch3 只斷言鏈式 + 整數。
2. **futureCounts 路徑**：同卡帶 fc（zeros + 有負載圖案）斷言 **GOOD > HARD、EASY > GOOD** + `Number.isInteger(dueDays)`，必含 raw<min 情境（raw∈[prevIvl+0.5, prevIvl+1) 的 GOOD/EASY — 此時 HARD 已 shrink 屬預期，不要求 HARD > prevIvl）。
3. **minRFI 邊界**：raw = prevIvl / +0.5 / +1（prevIvl∈{1,2,3,10,100}），斷言 minRFI 回傳值與最終 fuzz 結果（f=0、0.999 各一）嚴格 > prevIvl。⚠️ 取用方式：測試副本對 fsrs.js 追加 export 或經 review() 間接驗證。
4. **fuzz 停用路徑**：`new FSRS(w, 0.9, false)` 同卡三態仍成立（clamp 帶 min 鏈式）+ `tools/verify-undo-cycle.mjs`（enableFuzzing:false）跑通、主循環與「對照」一致。
5. **cap 豁免**：prevIvl == maximumInterval **且 raw_HARD ≥ maxIvl**（準時/延後卡，stability ≈ maxIvl）→ 三鍵全 == max 屬預期；shrunk-at-cap（raw_HARD < maxIvl）→ 鏈式 + cap 仍成立但非全 == max（branch3 語意）；f=0.999 或 fuzz-off 且**三鍵 raw 皆 > max** → 全 == max（僅 GOOD/EASY raw > max 時 → GOOD/EASY == max、HARD < max）；f=0 時 constrainedFuzzBounds 既有語意允許下偏（結果 ≤ max 且鏈式仍成立，非全 == max）— 測試註明。**全域斷言：dueDays ∈ [1, maxIvl] 且為整數（fuzz on/off 各跑）**。
6. **整數不變量**：所有 review 評分 dueDays 為整數（round 前），含 cap 情境。
7. **跨呼叫端一致（四端）**：fsrs.review 直呼 vs rateCard 複刻 vs computeIntervals 複刻 vs previewIntervals 複刻 — **固定餵相同 fc 陣列**（生產端 rateCard 用 computeFutureDueCounts、session 用 _computeFutureCounts，來源可不同為既有行為），同卡同 fuzzFactor 輸出相同 dueDays，且各自斷言鏈式。
8. **學習卡回歸**：state=1/3 畢業（min=1 路徑）fuzz∈{0,0.999} 下 interval ≥ 1、不走鏈式（不要求 > prevIvl）；review 卡評 AGAIN → relearning 不受 fuzz 影響（interval = againDelay）。
9. **非整數 raw 回歸**：raw=10.4/10.5/10.6 三態成立（「raw 不 round」設計承諾）。⚠️ 需調 stability 使 raw 精準落於目標值，或直接以測試副本 export 的內部函數驗證。
10. **generateFuzzFactor 極端值可達性**：掃描存在 f==0 與 f≥0.999 的輸入（證明測試確實覆蓋）。
11. **runMatureSimulation**：補丁移除後 node 模擬（複刻呼叫形狀）跑通不炸。
12. **語法與 build**：`node --check` 全改動檔案；`npm run build` 若環境可行（註明結果）。**另加運行時冒煙測試**（node 直呼 fsrs.review 各狀態各 rating 不拋異常 — 語法檢查攔不到 const 重賦值類運行時錯誤）。⚠️ 冒煙卡須含 learning 末步畢業卡或 NEW 1-step 卡、fuzzFactor 帶 0.5（const 重賦值錯誤只在 fuzz 開啟 + rawIvl≥3 的 else 分支觸發，fuzz-off 會漏網）。

## 6. 風險與緩解

| 風險 | 緩解 |
|---|---|
| review 卡間隔值與舊行為不同（預期中的行為改變） | commit message/changelog 註明；三態是 Anki 正確語意 |
| load balancing 與鏈式下限交互 | fuzzInterval 內先 round + clamp 到 [lower,upper] 再進 LB；測試 2 覆蓋 |
| fuzz 停用時三態失效 | fuzzInterval gate 帶 min clamp；測試 4 覆蓋 |
| 學習卡誤入鏈式 | guard `state === STATE_REVIEW && rating >= HARD`；測試 8 覆蓋 |
| 二次 fuzz（舊 block 未取代） | 3.1c 明示「取代」；測試 1 的 dueDays 值域驗證 |
| cli.mjs / verify-next-after-undo.mjs 屬其他組檔案 | 僅移除補丁區塊（各 3 行），不涉其他邏輯；commit diff 檢查 |
| A2 後續改動與本迴圈重疊 | 迴圈預留 goodRaw；A2 只加 easy min 一行 + 多步 learning 分支 |

## 7. 審查歷程

| 輪次 | 委員 | 裁決 | 意見摘要 | 處置 |
|---|---|---|---|---|
| R1 | #1 | ❌ | 核心設計與 Anki fuzz.rs 一致；HIGH-1 fuzzInterval this 崩潰；HIGH-2 LB 早退回傳浮點 raw（小數+違反下限）；MED-1 漏 cli.mjs:2482/2489-2490 與 verify-next-after-undo.mjs:77/79-82 補丁；LOW 行號/死碼註明 | v1.1：fuzzInterval 改帶 maxIvl/enableFuzzing 參數；LB 先 round+clamp；§4.1 補列全部呼叫端；deprecated 註明 |
| R1 | #2 | ❌ | F1 同 this 崩潰；F2 fuzz 停用分支無代碼（兩驗證工具 enableFuzzing=false 會被意外 fuzz 或三態失效）；F3 漏 3 處補丁（cli/verify-next-after-undo 活、sim-engine 死）；F4 minRFI branch2 回 prevIvl 產 ==prevIvl（違反嚴格 >，Anki 為 +1）；F6 lastPassing 死變數 | v1.1：fuzzInterval gate 統一（fuzz-off 也保鏈式）；minRFI branch2 → prevIvl+1；session-v4.js:336 刪除；補丁表擴充 |
| R1 | #3 | ❌ | S1/S2 同；S3 實測 fuzz=0 等值點（20 萬次掃描 f==0 出現 34 次）與短間隔退化區間破「> prevIvl」；S4 三處說法互斥；S5 測試不足（漏 fuzz 極端值/fc 路徑/整數不變量/fuzz-off/cap 豁免）；S6 迴圈 state 正規化不一致；S7 二次 fuzz 陷阱 | v1.1：minRFI branch2 → prevIvl+1；§5 擴充為 12 項（含極端值/fc/整數/fuzz-off/cap/可達性）；迴圈 state `?? 0/?? 5`；「取代」明示 |
| R2 | #1 | ✅ 附條件 | 1788 項實測全綠（含 fuzz=0/0.999 三態嚴格、branch2+1 反事實驗證）；HIGH-1 fuzz-off 分支 min 未 clamp 到 maxIvl → maxIvl+1..+3；§5-1「HARD>prevIvl」範圍過寬（branch3 允許 shrink）；§5-5「raw>max 全==max」事實錯誤（f=0 下偏屬既有語意）；cli.mjs:2142/2145 漏列 | v1.2：fuzzInterval fuzz-off 分支 min 先 clamp；§5-1 限 branch1/2 斷言；§5-5 改 f 分情境；§4.1 補 2142/2145（19 處） |
| R2 | #2 | ✅ | 呼叫端窮舉 17/17 無遺漏、7 處補丁全命中；LOW：§4.1 計數 15→17、cli.mjs 呼叫端 2482 非 2489、補丁範圍含守衛行（cli :2488-2491、verify-next-after-undo :78-81）；verify-undo-cycle let dueDays 可 const（可選）；cli.mjs:2156 dangling import 佐證 | v1.2：§4.1 標題 19 處、行號 2482、§3.2 補守衛行 |
| R2 | #3 | ❌ | HIGH-1 fuzz-off cap 溢位（實測 30→31/32/33，兩驗證工具 enableFuzzing=false 即觸發）；MED-2 §5-5 規格錯誤；MED-3 §5-1/5-2 斷言過強（raw<min 情境 HARD 必然 shrink）；MED-4 3.1c else 分支 const rawIvl 重賦值運行時 TypeError（node --check 攔不到）；LOW-5 缺 cap×fuzz-off 交叉/branch3 專項/f=null×cap/AGAIN 斷言/四端 fc 來源 | v1.2：fuzz-off min clamp；3.1c 改 let；§5-1/5-2 斷言範圍修正；§5-5/5-6/5-7/5-8 擴充；§5-12 加冒煙測試 |
| R3 | #1 | ✅ 附條件 | 1176/1176 主矩陣全綠（含 cap 30/30/30、100/100/100、branch3、學習卡、冒煙 64 組合、舊 block 等價 10000/10000）；LOW-1 §3.1a 註解「Anki 亦為 +1」事實錯誤（Anki branch2 原為 prevIvl）；LOW-2 §5-1 卡構造 ×1.05 vacuous；LOW-3 §5-5 cap 表述過寬（弱卡走 branch3 → H<max，Anki 同）；LOW-4 LB 觸發 `> raw` vs `> Math.round(raw)`；LOW-6 §1 與 branch3 文字矛盾 | v1.3：註解改「刻意偏離」；§5-1 改 stability≈prevIvl 準時卡；§5-5 精修前置；LB 改 `> Math.round(raw)`；§1 補 branch3 例外 |
| R3 | #2 | ✅ 附條件 | §4.1 全 18 列命中、§3.2 七處行號全對、移除後無 dead code；MED-1 `_dev/cli/cli.mjs:2435-2439` 同型補丁未註記（凍結死檔，E1 已改 lib.rs fallback）；LOW nextStates 行號 :231-244、verify-undo let→const 可選、§4.1 計數註記（f.review self-check、_dev 9 處） | v1.3：§3.2 加 `_dev/cli/cli.mjs` 排除註記；nextStates 行號修正；§4.1 加註記 |
| R3 | #3 | ✅ 附條件 | 534 斷言全綠（fuzz 極端值、cap 全域、fuzz-off、branch3、AGAIN、學習卡畢業、冒煙攔截力實證）；MED-1 §5-1 卡構造含混（解讀 A 落 branch3 空轉/誤報）；MED-2 §5-5 cap 前置條件缺 raw_HARD≥maxIvl；LOW §5-12 冒煙卡構造（learning 末步畢業 + fuzzFactor 0.5）、§5-3/5-9 內部函數取用 | v1.3：§5-1 改準時卡構造；§5-5 補前置；§5-12 冒煙卡明示；§5-3/5-9 取用註明 |

**R3 條件全數處置 → v1.3 定案（3/3 ✅），准予動工。**
