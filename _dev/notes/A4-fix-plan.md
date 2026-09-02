# A4 — 空/畸形 learnSteps 造成 learning 迴圈＋due=NaN 崩潰（v1.1 — 送 opencode）

狀態：**v1.1 凍結（3 delegate 全席 ✅ + 修正，送 opencode 2 席）**
關聯：bug-audit-2026-08-13.md A4（🟠）
負責人：總統 Oliver

## 一、Bug 定義

**兩層 bug，同一個 root：learnSteps/relearnSteps 的 parse 與空值處理不合 Anki。**

### 層 1：空陣列 → learning 迴圈／interval=0（audit 記載 + 委員實錘更嚴重）
- `fsrs.js:314` `againDelay(steps) { return steps[0] ?? (1/1440); }` — `steps` 為空陣列 `[]` 時 `steps[0]`=undefined → `??` 硬填 **1 分鐘**
- `fsrs.js:307` `hardDelay` `if (steps.length === 0) return 0;` — 空陣列回 **interval=0**（due=now，比 AGAIN 的 1 分鐘更嚴重，R3 實錘）
- 新卡 rating=AGAIN → `newState=STATE_LEARNING, step=0, interval=1min` → requeue 1 分鐘後又 learning → **無限 learning 迴圈**
- **Anki 官方（rslib/states/learning.rs 實錘）**：`LearningSteps::new(&[])` 合法，`is_empty()=true`；`:239` 測試 `again_with_no_steps_graduates_to_review` — **空 steps 時 AGAIN 直接畢業 Review**；`:291-309` `hard_with_no_steps_graduates_to_review`；`steps.rs:34` `again_delay_secs_learn() -> Option<u32>` 空時回 **None**（呼叫端判 None → 畢業）

### 層 2：畸形輸入 → due=NaN → 評分 throw（比 audit 記載更嚴重）
- parse 端：`store.js:610` `learnStepsStr.split(',').map(s => parseFloat(s.trim()) / 1440)`
- 輸入 `','` → `['','']` → `parseFloat('')`=**NaN** → steps=`[NaN, NaN]`
- `fsrs.js:314` `NaN ?? 1/1440` → **NaN**（`??` 只擋 null/undefined，不擋 NaN！）
- `store.js:622` `new Date(Date.now() + Math.max(60000, Math.round(result.dueDays * 86400000)))` → `Math.max(60000, NaN)`=NaN → `new Date(NaN).toISOString()` → **RangeError: Invalid time value throw**
- 結果：**每次評分都 throw** → session-utils catch → toast「儲存失敗」→ 卡永遠無法評分（使用者設錯 learnSteps 後 app 學習功能全壞）

## 二、Root Cause

1. `fsrs.js` 的 `againDelay`/`hardDelay` 沒有空陣列語意（Anki 是 Option<u32> None → 畢業）
2. 全 repo 5 個 parse 點（store.js:610/611、1495/1496、1614/1615、session-v4.js:332/333）都是 `split(',').map(parseFloat)` — **無 NaN filter**，畸形輸入直接進核心
3. GUI（settings.js:966-967）有 `|| '1,10'` 兜底但只擋**完全空**，擋不住 `','`/`'1,,10'`/`'abc'`

## 三、修法（雙層防護）

### 修法 1 — src/core/fsrs.js（核心層，主修）

`againDelay`/`hardDelay` 改為回 `null` 表示「無步驟 → 畢業」：

```js
// :313 附近 — Anki again_delay_secs_learn(): Option — 空/無效 steps 回 null
function againDelay(steps) {
  const first = steps?.[0];
  if (first == null || !Number.isFinite(first) || first <= 0) return null;   // M-1: <= 0 擋 interval=0
  return first;
}
// :306 附近 — Anki hard_delay_secs(): Option — 空/無效回 null
function hardDelay(steps, stp) {
  if (!steps || steps.length === 0) return null;
  const v = (steps.length === 1) ? steps[0] * 1.5
    : (stp === 0 && steps.length >= 2) ? (steps[0] + steps[1]) / 2
    : (steps[stp] ?? steps[0] ?? 0);
  return (v == null || !Number.isFinite(v) || v <= 0) ? null : v;             // M-1: <= 0
}
```

消費端（:316-359）判 null → 畢業（Anki 語意，**interval 用各自 rating 的 mem** — R1/R3 定案：fsrs.js 是 FSRS-only 實作，對齊 Anki FSRS path 的 states.{rating}.interval，非 SM-2 的 graduating_interval_good）：

```js
// STATE_NEW rating=AGAIN
const d = againDelay(actualLearnSteps);
if (d == null) { newState = STATE_REVIEW; newStep = 0; interval = next_interval(this.w, mem.stability, this.desiredRetention); }
else { newState = STATE_LEARNING; newStep = 0; interval = d; }
// STATE_NEW rating=HARD 同構（hardDelay；判 null 畢業時必須顯式 STATE_REVIEW + step 0 — R1 提醒 :336-337 HARD 原本不改 state/step）
// LEARNING/RELEARNING rating=AGAIN/HARD 同構
// REVIEW lapse rating=AGAIN → 空 relearnSteps 也畢業（不進 relearning），lapses 仍 +1（Anki review.rs lapses 在 failing_review_interval 內先 ++）
```

> 對齊 Anki：空 steps = 沒有 learning 階段，任何 rating 直接畢業 Review（rating-specific interval）。fsrs.js GOOD 分支已正確（:324-327 length>1 才 learning，否則畢業），本修法補 AGAIN/HARD。
> 範圍註明（R3 M-2）：Anki main 的 FSRS short-term scheduling（空 steps + interval<0.5 + allow_short_term 時留 learning）teno 無此概念（正常 steps 也不走），本案畢業語意對齊 Anki legacy/SM-2 path 與 interval≥0.5 的 FSRS path；不引進 short-term。

### 修法 2 — parse 端 NaN filter（防根源，4 位置 8 行共用 — R2 實錘）

共享 helper **放 fsrs.js 頂層 export**（fsrs.js 零 import = dependency leaf，無 circular import；store.js:8/session-v4.js:1 已 import fsrs.js）：

```js
// 轉分鐘字串 → 天數陣列；NaN/負值/空段丟棄；全丟 → []（fsrs.js 判 [] 畢業）
export function parseStepsStr(str, fallback) {
  const src = (str == null || String(str).trim() === '') ? (fallback ?? '') : String(str);
  const out = src.split(',').map(s => parseFloat(s.trim()) / 1440)
    .filter(v => Number.isFinite(v) && v > 0);   // R1 M-1: > 0 丟 0
  return out;
}
```

套用點（R2 實錘，4 位置 × 2 行 = 8 個 parse 呼叫）：
- store.js:610-611（rateCard → fsrs.review :618）
- store.js:1495-1496（runMatureSimulation → fsrs.review :1557）— 計畫書 v1.0 誤標 computeIntervals
- store.js:1614-1615（previewIntervals → fsrs.review :1625）— 計畫書 v1.0 誤標 simulate
- session-v4.js:332-333（Session.preview → this.fsrs.review :338）

> 語意：`''` → fallback（GUI 行為不變）；`','`/`'abc'` → `[]` → fsrs.js 判空 → 畢業（Anki 行為）；正常 `'1,10'` → `[1/1440, 10/1440]` 不變。空陣列不再是「硬填 1 分鐘」而是「沒有 learning 階段」。

## 三之一、消費者清單（憲法② 窮舉）

`againDelay`/`hardDelay`：fsrs.js 內部（:318/:320/:335/:337/:354）— 5 處消費，全部在 review() 內。
`parseStepsStr`（新 helper）消費點 = 4 位置 8 行：
- store.js:610-611（rateCard）、1495-1496（runMatureSimulation）、1614-1615（previewIntervals）
- session-v4.js:332-333（Session.preview）
- `src/lib/deprecated/sim-engine.js`（舊 JS simulator — **已隔離 deprecated，不動**）

## 三之二、範圍外清單（憲法⑥）

1. **A8**（hard delay 缺 min(1.5x, x+1day)+round）— 不同 bug，本修法不碰 hardDelay 正常值計算，只加 null 語意
2. **A10**（due 錨定作答時刻非日界線）— 不同 bug
3. **deprecated/sim-engine.js** — 已隔離，不修
4. **GUI 輸入驗證**（settings.js 即時錯誤提示）— 非必要，parse 層已擋；不做範圍蔓延

## 四、驗證（✅ 附實測證據）

1. **fsrs.js 空陣列**：`review({state:NEW}, AGAIN, undefined, [], [])` → state=REVIEW、interval>0（畢業，非 1min）；HARD 同（非 interval=0）
2. **fsrs.js NaN 陣列**：`review({state:NEW}, AGAIN, undefined, [NaN], [NaN])` → 不 throw、state=REVIEW
3. **parse helper 邊界**（R2 實測 25/25）：`''`→fallback、`','`→[]、`'1,,10'`→[1/1440,10/1440]、`'abc'`→[]、`'0,5'`→[5/1440]、`'1.5,10'`→正常、`null/undefined`→fallback/[]、`'-5,10'`→[10/1440]
4. **store.js 全路徑**：畸形 learnSteps 存 DB → rateCard 實跑不 throw、due 正常 ISO（4 位置 8 行全套）
5. **回歸**：正常 `'1,10'`/`'10'` 行為與修法前一致（對比 fsrs-verify 58 斷言）
6. **Anki 對齊**：AGAIN/HARD 空 steps 畢業 interval = **各自 rating 的 next_interval**（states.{rating}.interval 語意 — R1/R3 定案；非 SM-2 的 graduating_interval_good，v1.0 措辭已修正）
7. node --check 全部改動檔 + vite build

## 五、風險

- 中低：fsrs.js 核心 5 消費點 + 8 parse 行改動；共享 helper 在 fsrs.js 頂層 export（零 import，無 circular — R2 實錘）
- 行為變化：**設空 learnSteps 的卡從「迴圈/interval=0」變「直接畢業」** — 這是 Anki 正確行為，非破壞
- short-term scheduling 不引進（R3 M-2 範圍註明）
- 與 L1（learnAheadLimit clamp）獨立，可拆 commit
