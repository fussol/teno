# A2-fix-plan — EASY ≥ good+1（Anki min=good+1 下限）

> 版本：v1.2（R3 三審全 ✅ 定案 — 准予動工）
> 範圍：組一「學習核心」— 僅 src/core/fsrs.js（唯一排程計算點）；呼叫端零改動
> 依據：fix-plan-critical-v3.md 批次 3（A1 → A2 同批同 fuzz 點；本計畫為 A2 部分，A1 已於 48be9e6 落地）
> 狀態：**R3 3/3 ✅（R1：✅/❌/❌；R2：✅/❌/✅；R3：✅/✅/✅）→ v1.2 定案**

---

## 1. Bug 定義

複習（review）或畢業（new/learning/relearning → review）時，v3 定案語意要求：

> **EASY 的（fuzz 後）間隔必須 ≥ round(GOOD interval) + 1**（goodRaw = GOOD 的 **raw** interval）。

> R1 註記（MED-4 處置）：此為 **v3 定案語意，強化於 Anki** — Anki rslib 原文僅保證 fuzz 後比較（`fuzz_interval` 的 `fuzzed.max(prev+1)`、`passing_fsrs_review_intervals` 的 `intervals[i].max(intervals[i-1]+1)`，即 EASY ≥ GOOD_fuzzed+1）；A1 已達 Anki parity，A2 依 v3 定案採 **raw** 比較（EASY ≥ round(goodRaw)+1），比 Anki 更嚴格。實作以 v3 定案為準，非 Anki 原文。

現況 **不保證**，分兩機制：

- **(a) 非 init 卡（Review 卡 / 已有 stability 的 Learning/Relearning 卡）評 EASY**：
  - Review 卡（A1 鏈式迴圈 `fsrs.js:375`）目前只保證 `EASY > GOOD(fuzz 後) + 1`（`prevFuzzed + 1`），**未保證 `EASY ≥ round(goodRaw) + 1`**。fuzz 下偏（fuzzFactor=0/0.001）時，fuzz 後 GOOD 可遠小於 raw GOOD → EASY 可能 **≤ round(raw GOOD)**（R1 實測：w[16]=0.1、prevIvl=10、fuzz=0 → 現況 EASY=29 < round(goodRaw)+1=33；30 組掃描 5 組破）。
  - New/Learning/Relearning 卡評 EASY 畢業（`fsrs.js:328-331`、`:346-349`）：`interval = next_interval(easyStability)`（raw），但尾部 block else 分支（`fsrs.js:380-394`）只做 **min=1 普通 fuzz** — **完全沒有 EASY ≥ good+1 下限**（R1 實測：Learning step0/step1 w[16]=0.1 → EASY raw=2.807 < 連按 GOOD raw=7.315）。
- **(b) init 卡（New 卡首次評分，走 `init_stability(w, rating) = w[rating]`）**：`w[3] ≤ w[2]`（EASY init stability ≤ GOOD init stability）時等值 — R1 實測 `w[2]=w[3]=2.0` 完整復現 bug-audit「**GOOD=2, EASY=2**」。

> R1 修正（F2 處置）：v1.0 把兩機制混為「w[16] 縮小 init_stability」是錯的 — `w[16]`（easy_bonus）只作用於 `stability_after_success`（非 init 路徑），不影響 init；init 卡等值靠 `w[3] ≤ w[2]`。兩機制分述如上。

**具體故障（bug-audit 實錘 🔬）**：自訂 weights 下實測 **GOOD=2, EASY=2** — 兩鍵等值，違反「EASY 嚴格大於 GOOD」語意。

## 2. Root Cause

`fsrs.js` 的 `review()` 是唯一排程計算點，但：

1. A1 鏈式迴圈的 EASY 下限只用了「fuzz 後 GOOD + 1」，漏了「raw GOOD + 1」；
2. 非 review 卡畢業的 EASY 分支（New/Learning/Relearning）完全沒接 A2 下限 — else 分支硬編碼 `min=1`。

共同根因：**EASY 下限沒有統一以 `round(goodRaw)+1` 表達**（goodRaw 依情境不同：Review 卡 = 一次 GOOD 的 raw interval；學習卡 = 連按 GOOD 走完剩餘 steps 的畢業 interval）。

## 3. 修法（僅 src/core/fsrs.js）

### 3.1 Review 卡 EASY（A1 鏈式迴圈內，`fsrs.js:375`）

現況：
```js
if (r === EASY) min = Math.max(min, prevFuzzed + 1);
```
改為：
```js
if (r === EASY) min = Math.max(min, prevFuzzed + 1, Math.round(goodRaw) + 1);   // A2: EASY ≥ round(goodRaw)+1
```
> `goodRaw` 已在迴圈內 `r === GOOD` 時賦值（`fsrs.js:372`，A1 預留），Review 卡無 steps，「一次 GOOD」即 `next_interval(goodStability)`。

### 3.2 非 review 卡 EASY 畢業（尾部 block else 分支，`fsrs.js:380-394`）

現況 else 分支對所有畢業（GOOD 末步 / EASY）一律 min=1 普通 fuzz。

改為（EASY 時以「連按 GOOD 走完剩餘 steps 的畢業 interval」為 goodRaw；**整體改用 A1 既有 `fuzzInterval` 統一唯一 fuzz 點**）：

```js
} else {
  // 非 review 卡（new/learning/relearning 畢業）
  let minIvl = 1;
  if (rating === EASY) {
    // A2: EASY ≥ round(goodRaw)+1；goodRaw = 連按 GOOD 走完剩餘 steps 的畢業 interval（raw）
    const gsteps = state === STATE_RELEARNING ? actualRelearnSteps : actualLearnSteps;
    let gs = stability ?? 0, gd = difficulty ?? 5;
    let gi = stepIdx ?? 0;
    // 連按 GOOD：非最後一步不畢業，只推進 step（delta_t=0 短間隔語意）
    while (gi < gsteps.length - 1) {
      const gm = step(this.w, 0, GOOD, { stability: gs, difficulty: gd }, nth);
      gs = gm.stability; gd = gm.difficulty;
      gi++;
    }
    // 最後一步 GOOD → 畢業（與頂部 mem 同 delta_t 基準）
    const gm = step(this.w, delta_t, GOOD, { stability: gs, difficulty: gd }, nth);
    const goodRaw = next_interval(this.w, gm.stability, this.desiredRetention);
    minIvl = Math.round(goodRaw) + 1;
  }
  // A1 fuzzInterval：唯一 fuzz 點（LB 前先 clamp、fuzz-off 尊重 min）
  interval = fuzzInterval(interval, minIvl, fuzzFactor, futureCounts,
    this.maximumInterval, this.enableFuzzing);
}
```

> **R1 HIGH-1 修正（v1.1 核心變更）**：v1.0 原案沿用 else 分支舊結構（`rawIvl >= 3` 才 fuzz + 直接 `selectIntervalWithLoadBalancing`），實測在 **EASY 畢業 × futureCounts × raw < minIvl** 情境觸發 LB 早退（`return interval` 原值）**擊穿 A2 下限**（EASY=5 < min=9，fuzz=0/0.5/0.999 全破）；且 **生產可達**（store.js:606 對 RELEARNING 狀態也傳 futureCounts）。改用 `fuzzInterval`（A1 已實作）後：LB 前先 `day = clamp(round(raw), lower, upper)`（`fuzzInterval:191`）、fuzz-off 走 min-clamp 路徑（`:183-187`）、對短間隔 raw<3 亦尊重 min — 一併消滅 LB 早退、fuzz-off 遺漏、v3「傳 raw」nit（fuzzInterval 內部 `constrainedFuzzBounds(raw, min, maxIvl)` 傳 raw 非 rounded）。R1 實測 fixed 版 fuzz=0/0.5/0.999 全守（輸出 9/10/11）。
>
> 註 1：GOOD 末步畢業（rating !== EASY）走 `minIvl = 1`。**R2 修正**：`fuzzInterval(raw, 1, ...)` 與現況 else 分支**值域等價** — 同 [1, maxIvl] 且差 ≤ 1 天；現況先 `Math.round(interval)` 再 fuzz（`fsrs.js:382`），修後傳 **raw 浮點**進 `constrainedFuzzBounds`（v3 定案「傳 raw 非 rounded」，fix-plan-critical-v3.md:86），raw 尾數跨 round 邊界時 fuzzBounds 差 1（實測 2394 組 574 組差 1 天；例 RELEARNING s=5 dt=3 f=0.5 → 現況 13 vs 修後 14）。此為**預期行為變更**（對齊 v3 raw 語意），非 bug；測試斷言以 ±1 容差處理（§5-3），changelog 註明。
> 註 2：`nth` 中間步沿用卡的 nth — `step()` 的 init 條件為 `nth===0 && state.stability===0`，連按後 stability 非 0 不會誤 init（R1 實測確認）。
> 註 3：連按迴圈 delta_t 選擇（中間步 0、畢業步卡的 delta_t）對 goodRaw 影響顯著（R1 實測 dt=3 差異 8.4 天），**測試複算須與實作完全一致**（見 §5-3）。
> 註 4：else 分支整體改由 fuzzInterval 處理後，原本 `rawIvl >= 3` 才 fuzz 的門檻由 fuzzInterval 內部 `withReviewFuzz`（interval<2.5 時 fuzzDelta=0）自然承接，行為連續（R1 實測 F 區短間隔同構）。

### 3.3 不修改

- `nextStates()`（`fsrs.js:267-282`）：src/ 零呼叫端（僅 `_dev/tests/fsrs-verify.mjs` 測試用、`_dev/legacy-engine/session-v3.js:107` 死檔除外 — R1 註記）
- `src/lib/chart.js`、`src/styles/base.css`（任務禁令）
- store.js 快照/undo（C1/C2 範圍）、session-v4.js（A1 補丁已移除，無殘留）
- `src/core/simulator.js`：有**獨立複製**的 `next_interval`（非 import），A2 不涉；simulator.js 無 `step` 複製（R1 grep 確認，使用 FSRS 實例）
- `src/core/fsrs-optimizer.js`：`step`/`next_interval` 自有複製（R2 補註），A2 不涉

## 4. 使用點窮舉（grep 三形態）

### 4.1 `fsrs.review(` 呼叫端（grep 形態一）— A2 呼叫端**零改動**（行號為 R1 實查現況，A1 落地後已偏移）

| 檔案:行號 | 用途 | A2 處置 |
|---|---|---|
| `src/lib/store.js:609` | rateCard 實際排程 | 不改（沿用 dueDays） |
| `src/lib/store.js:1489` | runMatureSimulation 模擬 | 不改 |
| `src/lib/store.js:1557` | previewIntervals 預覽 | 不改 |
| `src/engine/session-v4.js:337` | computeIntervals 按鈕預覽 | 不改 |
| `tools/cli.mjs:2482` | build 模擬評分 | 不改 |
| `tools/cli.mjs:1203,1250` | session 佇列 | 不改 |
| `tools/cli.mjs:1477` | replay 狀態重建 | 不改 |
| `tools/cli.mjs:1598` | 重算比對 | 不改 |
| `tools/cli.mjs:1683` | whatif | 不改 |
| `tools/cli.mjs:2142,2145` | FSRS self-check（fuzzFactor=null） | 不改 |
| `tools/cli.mjs:3238,3252` | queue 預覽 | 不改（R1 行號修正：v1.0 誤寫 3242/3256） |
| `tools/cli.mjs:3299` | 互動評分 | 不改（R1 行號修正：v1.0 誤寫 3303） |
| `tools/verify-undo-cycle.mjs:47,73` | 驗證工具（enableFuzzing=false） | 不改（fuzz-off 路徑自動涵蓋）（R1 行號修正：v1.0 誤寫 77） |
| `tools/verify-next-after-undo.mjs:77` | 驗證工具（enableFuzzing=false） | 不改 |
| `src/lib/deprecated/sim-engine.js:195` | 死檔 | 不改 |

> R2 註記：`_dev/` 下備份複本（`_dev/cli/cli.mjs` 11 處 `fsrs.review(`）與 `src/lib/deprecated/` 同為死檔慣例，排除不列（與 A1 §4.1 一致）；實作時 grep 請以 src/ + tools/ 活檔為準。

### 4.2 間隔下限殘留（grep 形態二：`dueDays <=` / `lastPassing` / `prevIvl`）

- A1 已全數清除活檔（store.js / session-v4.js / cli.mjs / 兩 verify 工具），`session-v4.js:336` 死變數已刪
- `lastPassing` 活檔零殘留（R1 grep 實查）
- **例外（死檔）**：`src/lib/deprecated/sim-engine.js:198` 仍有 `if (res.dueDays <= p) res.dueDays = p + 1;`（R1/R2 grep 實查，單行 :198）— 死檔不處理，與 A1 §4.2 排除註記同風格
- A2 不新增任何呼叫端補丁 — 全部收斂於 fsrs.js

### 4.3 字串形態（grep 形態三）

- `EASY` 使用點：store.js:8（import）、session-v4.js:1,336（import + 預覽迴圈）、verify-undo-cycle.mjs:8（import）、fsrs.js 內部、cli.mjs:1680（names 字串）/3208（import）、fsrs-optimizer.js:41,81-82（**自有定義**，獨立複製公式）、simulator.js:1,19（import + 自有）、src/core/scheduler.js:13（註解）— 皆常數引用/自有定義，無散落補丁邏輯
- `next_interval(`：fsrs.js 內部 + `src/core/simulator.js:11,307`（**獨立複製**，非 import，不改）
- `step(`：僅 fsrs.js 內部（simulator.js 無 step 複製；`fsrs-optimizer.js:67` 自有複製除外 — R2 補註）— A2 新增的連按迴圈只用 fsrs.js 內 `step`

## 5. 驗證項目（實測證據）

fsrs.js 為純 ES module 可直接 node 測試；store.js 因 import @tauri-apps/api/core 無法 node import → 以複刻呼叫形狀驗證。

1. **A2 核心斷言（review 卡）**：Review 卡（prevIvl∈{1,2,3,10,30,100,365}，準時卡 stability≈prevIvl）評 EASY，斷言 `dueDays ≥ round(goodRaw)+1`（goodRaw 由測試內複算：**複製 next_interval 公式**（未 export，同 A1 §5-3 取用註記）＋ `step()` class 方法，同參數 `next_interval(step(w,dt,GOOD,...))`）。**fuzzFactor ∈ {0, 0.001, 0.5, 0.999} 各跑；R1 MED-5 註記：fuzz=0/0.001（下偏）為關鍵對抗斷言（唯一可捕捉現況 bug 的值），0.5/0.999 為自然成立回歸**。**R2 LOW-3 處置：101 點 fuzzFactor 全域掃描（0~1 步進 0.01）升為必測**（R2 實測 707 點成本 <1s、現況 236 破 vs 修後 0 破，鑑別力最強）。
2. **bug-audit 復現（兩機制分述）**：
   - **(a) init 機制**：`w[2]=w[3]=2.0`（其餘沿用），**New 單步卡（learnSteps=[10/1440]，R2 LOW-1 明訂：2 步時 New 評 GOOD 不畢業，斷言 vacuous）** 評 EASY 畢業 → 修前斷言 `EASY == GOOD`（復現「GOOD=2/EASY=2」）；修後斷言 `EASY ≥ round(goodRaw)+1` 嚴格成立（R1 實測：修後 EASY=3）。
   - **(b) 非 init 機制**：`w[16]=0.1`（easy_bonus 縮小），**卡用 Review 卡（state=2, stability=prevIvl∈{1,2,3}, scheduledDays=prevIvl, delta_t=21）**（R1 F3 修正：w[16] 不影響 init 路徑，New 卡無法復現此機制）→ 修前斷言 fuzz=0 時 `EASY < round(goodRaw)+1`（對抗性，R1/R2 實測 prevIvl=1/2/3 → 現況 13/20/24 < min 16/23/28）；修後斷言 fuzz on/off 皆 `≥ round(goodRaw)+1`。
3. **A2 核心斷言（畢業卡，多步/單步）**：New 卡（learnSteps=[1min,10min]）評 EASY 畢業、Learning 卡 step0/step1 評 EASY 畢業、Relearning 卡評 EASY 畢業 — 斷言 `dueDays ≥ round(連按 GOOD 畢業 interval)+1`。**R1 MED-3 處置**：測試內複算的 delta_t 選擇**必須與 3.2 實作完全一致**（中間步 0、畢業步卡的 delta_t）。**R2 LOW-1 處置（固定錨點數值，R2 委員#3 手算實測全中）**：
   - New/2步（default weights，卡：`{state:0, stability:0, difficulty:5, step:0, elapsedDays:0, scheduledDays:0}`，learnSteps=[1/1440, 10/1440]）：連按 GOOD 畢業 stability=**2.3065**（含 `stability_short_term` 的 `Math.max(sinc,1)` floor，fsrs.js:88 — R2 LOW-3 註記）、goodRaw=**2.3065**、minIvl=**3**、EASY raw=**8.2956**、修後 dueDays f=0→**6** / f=0.5→**8** / f=0.999→**10**；
   - Learning step1（dt=2, s=5, **d=5**，卡：`{state:1, stability:5, difficulty:5, step:1, elapsedDays:2, scheduledDays:2}`，learnSteps=[1/1440, 10/1440]）：goodRaw=**11.025184** → min=**12** → f=0→**14**；
   - Relearning（dt=3, s=5, **d=5**，卡：`{state:3, stability:5, difficulty:5, step:0, elapsedDays:3, scheduledDays:3}`，relearnSteps=[10/1440]）：goodRaw=**13.404752** → min=**14** → f=0→**18**（且 w16=0.1 時 easyRaw=**5.8404752 ≈ 5.84 < min=14**，錨點具鑑別力；斷言用 `< min` 或容差 ≥1e-3，勿用 1e-4）。
   **R1 MED-2 處置**：加 **futureCounts 變體**（fc 長度 > rawIvl，含 Relearning 卡 raw < minIvl 情境 — 即 HIGH-1 擊穿點），斷言 `dueDays ≥ round(goodRaw)+1` 恆成立（R2 實測 fixed 版 2020/2020 守）。**R2 MED-1 處置（GOOD 對照組斷言修正）**：加 **GOOD 末步畢業對照組**（LEARN step1 / RELEARN，rating=GOOD）斷言改為 **`修後 dueDays ∈ [1, maxIvl] 且 |修後 − 修前| ≤ 1`**（現況 round 後 fuzz vs 修後 raw fuzz 差 ≤1 天，R2 實測 2394 組 574 組差 1 — 註 1 已說明）；另附 1 個**等價錨點卡**（實測 Learning step1 s=5 dt=2 現況==修後）防 flaky。
4. **單步 learning 畢業**：learnSteps=[10min]（單步）評 EASY 畢業 → 連按迴圈零迭代，goodRaw = 一次 GOOD 畢業，斷言下限成立。
5. **A1 回歸（三態鏈式不破）**：Review 卡 HARD/GOOD/EASY 斷言 `GOOD > HARD && EASY > GOOD`（fuzz 後）仍嚴格成立（R1/R2 實測 7×4 組全過）；AGAIN → relearning 不受影響。
6. **整數不變量**：所有 EASY 畢業 dueDays 為整數（含 fuzz on/off、cap 情境、fc 路徑）。
7. **cap 豁免**：`round(goodRaw)+1 > maximumInterval` 時 clamp 回 maxIvl（fuzzInterval 內部 min-clamp + constrainedFuzzBounds 的 `minimum = Math.min(minimum, maximum)`）；斷言 dueDays ∈ [1, maxIvl]（R1/R2 實測 cap 無溢位，min>maxIvl 情境 raw=40000→36500）。
8. **fuzz-off 一致性**：`new FSRS(w, 0.9, false)` 下 **Review 卡與 New/Learning/Relearning 畢業卡** EASY 下限皆成立（3.2 fuzzInterval fuzz-off 分支 min-clamp 為新承接路徑）；`tools/verify-undo-cycle.mjs`、`tools/verify-next-after-undo.mjs`（皆 enableFuzzing=false）實跑通過。
9. **跨呼叫端一致（三端複刻）**：fsrs.review 直呼 vs rateCard 複刻 vs computeIntervals 複刻 — **三端傳相同 learnSteps/relearnSteps**（R1 LOW-3 處置：連按迴圈依賴 actualLearnSteps，來源不同會假失敗），同卡同 fuzzFactor 輸出相同 dueDays，且各自斷言 EASY ≥ round(goodRaw)+1。
10. **語法與既有測試**：`node --check` fsrs.js；`_dev/tests/fsrs-verify.mjs` 實跑（58 斷言，僅覆蓋 step/next_interval/nextStates 核心基線 — R1 LOW-4 措辭限縮：A2 review() 改動靠測試 1-9 攔截）。
11. **冒煙測試**：各狀態（NEW/LEARNING/REVIEW/RELEARNING）× 各 rating 不拋異常；**必含「fuzz 開啟 + rawIvl≥3 的 EASY 畢業卡」**（R1 LOW-5：A1 R2 MED-4 教訓 — 運行時錯誤只在 fuzz+rawIvl≥3 的 else 分支觸發）。

## 6. 風險與緩解

| 風險 | 緩解 |
|---|---|
| EASY 間隔值變大（預期行為改變，v3 定案語意） | commit message/changelog 註明；測試 1-4 斷言值域 |
| 學習卡 EASY 畢業 interval 較舊值增大（下限生效） | 屬 bug 修復本意；測試 3-4 覆蓋 |
| 連按 GOOD 模擬的 delta_t 選擇與 Anki 精確值有微差 | 短間隔（分鐘級）下 s_recall≈last_s、s_short 差異極微（R1 實測 sinc≈1.004）；畢業步與頂部 mem 同基準保證 easy/good 可比；測試 3 固定錨點鎖定 |
| **LB 早退擊穿下限（R1 HIGH-1）** | 改用 fuzzInterval（LB 前 clamp）— 修法本身消除；測試 3 fc 變體永久攔截 |
| fuzz-off 下 EASY 下限改變驗證工具預期值 | 兩 verify 工具只跑 cycle 一致性（無硬編碼 EASY 值），實跑確認 |
| GOOD 末步畢業誤入 A2 下限 | 3.2 以 `rating === EASY` 守衛；測試 3 GOOD 對照組反證 |
| A1 鏈式與 A2 下限交互（兩者取 max） | 測試 5 回歸 A1 三態 + 測試 1 A2 下限並存 |
| else 分支改 fuzzInterval 引入回歸（GOOD 路徑） | 測試 3 GOOD 等價對照組（±1 容差，R2 MED-1）+ 測試 8 fuzz-off 實跑 |
| GOOD 末步 dueDays 與現況差 ≤1 天（raw-vs-round fuzz，R2 註 1） | 預期行為變更（對齊 v3 raw 語意）；測試 3 斷言 ±1；changelog 註明 |

## 7. 審查歷程

| 輪次 | 委員 | 裁決 | 意見摘要 | 處置 |
|---|---|---|---|---|
| R1 | #1 | ✅ 附條件 | 28 斷言實測全綠（bug 復現 GOOD=2/EASY=2、review 卡 fuzz 下偏、連按迴圈、A1 回歸、cap、掃描 94 組）；MED-1 §4.1 行號偏移 4 行（cli 3238/3252/3299、verify-undo 73）；MED-2 §1/§5-2 機制歸因混淆（w[16] 不影響 init）；LOW-3 fuzz-off review 卡 A2 增量無鑑別力（A1 鏈式承載）；LOW-4 §4.3 漏 fsrs-optimizer/simulator；LOW-5 §3.2 round 後 fuzz vs v3 raw 微差；LOW-6 nextStates legacy 註記 | v1.1：行號全改現況（§4.1）；§1 拆 (a)(b) 兩機制；§5-2 拆兩機制復現；§5-1 註記 fuzz 極端值鑑別力；§4.3 補列；§3.2 改 fuzzInterval（順帶解決 round vs raw）；§3.3 補 legacy 註記 |
| R1 | #2 | ❌ | 核心修法語意實測全數成立（連按迴圈、GOOD 末步 40 組等價、cap、fsrs-verify 58/58）；F1 MED §4.1 行號偏移 4 行；F2 MED §4.2「全庫無 dueDays<=」不實（sim-engine.js:198 死檔）；F3 MED 測試 2 復現前置缺失（New 卡 w[16] 無法復現）；F4 LOW→MED 缺 GOOD 路徑等價專項；F5 LOW §4.3 simulator 無 step 複製；F6 LOW EASY 使用點漏列；F7 LOW 測試 1 next_interval 取用方式；F8 LOW §3.2 round vs raw | v1.1：行號修正；§4.2 補死檔註記；§5-2 改 Review 卡構造＋修前對抗斷言；測試 3 加 GOOD 對照組；§4.3 補列＋simulator step 更正；§5-1 取用註記；§3.2 改 fuzzInterval（F8 一併解決） |
| R1 | #3 | ❌ | **HIGH-1 3.2 LB 早退擊穿下限**（Learning step1 EASY raw=5 < min=9，fuzz 三值全破；生產可達 — store.js:606 對 RELEARNING 傳 fc，實測修前 EASY=8 < 14）；MED-1 §5-2 復現未指定卡狀態 vacuous；MED-2 §5 無 fc×EASY 交叉測試；MED-3 測試 3 複算 self-consistency 空轉＋delta_t 敏感（差 8.4 天）；MED-4 §1「Anki 原文」事實錯誤（Anki 僅 fuzz 後比較，A2 為強化語意）；MED-5 fuzz 僅 0 具對抗性；LOW-1 round vs raw；LOW-2 §5-8 未明說畢業卡 fuzz-off；LOW-3 三端 learnSteps 來源；LOW-4 fsrs-verify 不含 review()；LOW-5 冒煙卡構造 | v1.1：3.2 整體改 fuzzInterval（LB clamp、fuzz-off min、raw 傳入 — HIGH-1/LOW-1 一併消除）；§1 改「v3 定案語意（強化於 Anki）」；§5-2 明訂卡狀態＋修前對抗斷言；測試 3 加 fc 變體（HIGH-1 擊穿點）＋固定錨點；§5-1 註記 fuzz=0 對抗性＋101 點掃描；§5-8 明列畢業卡 fuzz-off；§5-9 固定 learnSteps；§5-10 措辭限縮；§5-11 冒煙卡構造 |
| R2 | #1 | ✅ 附條件 | 900+ 斷言實測全綠：HIGH-1 擊穿場景現況 12/12 全破（dt=7 現況=2 vs min=10）→ 修後全守；全域掃描 7 prevIvl×101 fuzz 現況 236/707 破 → 修後 0/707；兩機制復現（GOOD=2/EASY=2、42<47）；GOOD 末步 92 組等價＋短間隔承接；A1 三態 28 組；錨點手算吻合；cap；fuzz-off。MED-1 GOOD 對照組「== 修前」斷言不嚴謹（round 邊界附近輸出差 ≤1 — 現況 round 後 fuzz vs 修後 raw fuzz）；LOW-1 §5-2(a) 未明寫單步 learnSteps；LOW-2 §4.3 scheduler.js 缺全路徑；LOW-3 101 點掃描升必測；INFO sim-engine 實為 :198 | v1.2：註 1 改「值域等價 ±1」；測試 3 GOOD 斷言改 `|修後−修前| ≤ 1`＋等價錨點卡；§5-2(a) 明寫 learnSteps=[10/1440]；§4.3 補 src/core/scheduler.js 全路徑；§5-1 掃描升必測；§4.2 行號 :198 |
| R2 | #2 | ❌ | 行號/變數/結構全對齊（read_file 逐一核對）；fuzzInterval 六參吻合；§4.1-4.3 grep 實查全中。MED-1 §3.2 註 1「等價」聲稱不實（96 組 20 組差 ±1，raw 非整數卡 10/16 差 ±1 — v1.1 改 fuzzInterval 後新引入，R1 40 組為取樣盲點）；LOW-1 §4.3 step( 漏 fsrs-optimizer.js:67 自有複製；LOW-2 §4.1 未註明排除 _dev/cli/cli.mjs；LOW-3 錨點手算須納 sinc floor（stability>1.659 連按後不變，正確錨點連按 stability=2.3065/goodRaw=2.3065/min=3/EASY 6/8/10） | v1.2：註 1 改「值域等價 ±1」（含根因說明）；測試 3 GOOD 斷言改 ±1 容差；§3.3 補 fsrs-optimizer.js 自有複製；§4.1 補 _dev 排除註記；§5-3 錨點附數值＋sinc floor 註記 |
| R2 | #3 | ✅ 附條件 | HIGH-1 真消除（雙重復刻 sanity 504 組等價；Relearning 擊穿點現況 4/4 破 → 修後 4/4 守 14/14/15/16）；5 卡×4 fc×101 fuzz 2020/2020 守；cap/fuzz-off/短間隔全守；連按迴圈語意 9/9；Review 卡 8484/8484 守 A2＋A1 三態。MED-1 測試 3 GOOD 對照組「== 修前」必假紅（2394 組 574 組差 1 — 現況 round 後 fuzz vs 修後 raw fuzz，v3 定案「傳 raw」之故）；MED-2 註 1「等價」聲稱不實；LOW-1 錨點未附數值（已手算：New/2步 stability=2.3065/goodRaw=2.3065/min=3/f=0→6,0.5→8,0.999→10；Learning step1 dt=2 s=5 goodRaw=11.025184/min=12/f=0→14；Relearning dt=3 s=5 goodRaw=13.404752/min=14/f=0→18） | v1.2：測試 3 GOOD 斷言改 `∈[1,maxIvl] 且 \|差\|≤1`＋等價錨點卡；註 1 改值域等價＋實測數據；§5-3 附錨點數值＋鑑別力說明 |
| R3 | #1 | ✅ | v1.2 已處置 R2 全數意見；21/21 斷言全綠：GOOD 對照組 ±1（288 組全過、64 組差 1 實錘 ±1 為必要修正）、等價錨點卡 4/4 全等、§5-3 錨點獨立手算全中（2.3065/11.025184/13.404752）、HIGH-1 生產可達性實錘（store.js:606 RELEARNING 傳 fc）。INFO：easyRaw=5.84 精確值 5.8404752（斷言用 <min 或容差 ≥1e-3）；等價錨點卡參數勿更動 | v1.2 已含（斷言方式註記）；實作測試比照 |
| R3 | #2 | ✅ | R2 四項處置 4/4 到位；行號全對齊零偏移（fsrs.js 內部 + §4.1 15 處 + §4.2/4.3 全中）；修前對抗復現（13/20/24<min、101 掃描修前 235 破→修後 0 破）；錨點逐位一致；冒煙 32 組不拋異常；fsrs-verify 58/58 ALL PASS。INFO：修前 101 掃描 235 vs 236 差 1 為卡構造細節，鑑別力結論不變；Learning/Relearning AGAIN/HARD/GOOD 分鐘級 dueDays 為既有行為非 A2 範圍 | 已含（§5-6 限定 EASY 畢業卡） |
| R3 | #3 | ✅ | HIGH-1 擊穿點修後 4/4 守（14/14/15/16，與 R2 逐值復現）、現況 4/4 破；三錨點與 R2 手算一致；全域掃描修後 0/404 破（現況 202/404）；MED-1 規格 606 組全過；註 1 實例逐值吻合；cap/fuzz-off/整數全守。LOW-a 錨點卡 difficulty=5 未明文化（d 不同 goodRaw 即變）；LOW-b 縮排風格 nit | v1.2 已併入 LOW-a（錨點卡 JSON 明文化）；LOW-b 純風格不處理 |

**R3 3/3 ✅ → v1.2 定案，准予動工。**
