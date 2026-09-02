# G4 修法計畫書 v1.1（審查後採納委員 4 項補強）

## Bug 定義
`checkAchievement`（easter-eggs.js:46-55）讀 `localStorage._totalRated`，但全專案**沒有任何地方寫入 `_totalRated`**（grep 實錘：僅 easter-eggs.js:49 唯獨取）→ 成就永久停在 0，`first_review`/`speed_demon`/`persistent` 永不觸發。G4 audit 原文：「_totalRated 無人寫入 → 成就永不觸發」。

## Root Cause
評分計數缺乏持久化累加點。三模式評分各自呼叫 `store.actions.incrementGoal()`（session-utils.js:105 flip / session-mc-utils.js:119 / session-spell-utils.js:116），但 incrementGoal 只算「今日連續天數」，從不累加總數，也從不寫 `_totalRated`。

## 修法（單一入口，審查後定案）
檔案：`src/lib/store.js`，函式 `incrementGoal`（:1096）
在 `await this.updateGoalStreak(...)`（:1108，_第一個 await 之前_，此段同步執行）前插入。含委員建議：JSON 編碼對齊、Number.isFinite 防 NaN、try/catch 隔離：
```js
// G4: 累加生涯總評分數（成就系統讀取；JSON 編碼與讀端對齊、isFinite 防污染、try/catch 隔離無 localStorage）
try {
  const raw = localStorage.getItem('_totalRated') || '0';
  const rated = Number.parseInt(raw, 10);
  const next = Number.isFinite(rated) ? rated + 1 : 1;
  localStorage.setItem('_totalRated', JSON.stringify(next));
} catch { /* 無 localStorage（node harness）→ 忽略計數 */ }
```
由於插點在 incrementGoal 首個 await 之前 → 同步執行，即使呼叫端 fire-and-forget（`.catch()`）寫入也在當下完成，無競態。

## 消費者清單（憲法②）
- `_totalRated` 寫入：本修法 store.js incrementGoal（新增唯一寫入點）
- `_totalRated` 讀取：easter-eggs.js:49 checkAchievement（現存唯一消費者，三模式共用）
- 間接：main.js/設定頁未直接引用；成就 toast 由 checkAchievement 觸發
三形態：此為 JS 數值邏輯（非 template/inline-style/CSS）— 適用第 1 形態。

## 驗證（法①審查委員 1 席 ✅，以下 harness/T 對齊烤 """
- T1 初值 '0' 一次評分 → '1'（JSON）
- T2 三模式各一次 → '3'
- T3 既有 '17' → '18'（累加非覆寫）
- T4 streak 既有行為不變（dates.flip 含 today）
- T5 無 localStorage（delete global.localStorage）→ incrementGoal 不 throw（try/catch 負向測試）
- T6 NaN 污染：storage='abc' → 得 '1'（Number.isFinite 防護）
- 負控制：未修 store.js 跑 harness → T1/T2/T3 全 FAIL（已實測 3 FAIL 確認 harness 有效）

## 風險
- localStorage 在 node harness 不存在 → try/catch 隔離，不影響 store 核心
- 極低：成就解鎖為純展示（toast），無副作用
- 已知非阻塞：undo 走 restoreGoal 不 call incrementGoal → undo 後重評會再 +1，_totalRated 輕微高估。純 toast 展示可接受（列範圍外）。

## 範圍外
- checkStudyMessages/checkMilestone memory-only「重啟重來」— 另開案。
- `_lastMsgAt`/`_milestonesShown` 重啟歸零 — 另開案。
- undo 重評計數高估 — 已知，接受。

## 審查委員數
簡單 bug（單檔 store.js、非共享、低風險、<20 行）→ 依法①降 1 名委員。第 1 席 ✅ 於 v1.1 併入其 4 項補強建議定案。