# A7 Fix Plan — new 卡每日順序不重洗（固定 seed，Anki 每天 salt re-hash）

## 1. Bug 事實

**位置**：src/engine/session-v4.js:34（constructor `_rng = mulberry32(hashCode(this.mode))`）、:82-85（shuffle）

**問題**：new 卡 shuffle seed 固定（mode hash）→ 每天順序一樣。Anki 每天用新 salt re-hash → 每天不同。

## 2. Session 生命週期（實讀確認）

`ensureSession`（session-utils.js:28 / mc:30 / spell:29）是 module-level singleton：每頁 load 只建一次 Session。但 `ensureQueue` 每次（重進/完成重開/切 filter）呼叫 `session.start()` → reset + buildQueue，且 Session 常駐可跨午夜 → seed 必須在 buildQueue 層決定（constructor 層無法處理跨午夜）。

## 3. 修法

buildQueue 內（:83-86）改：
```js
const rng = mulberry32(hashCode(this.mode + '_' + today));  // today = buildQueue 自己算的當天日期
```
- **每天不同**：日期字串進 seed → 跨天換新順序（Anki salt re-hash 對應）
- **同天穩定**：mulberry32 有狀態 — 若 seed 只在 constructor 設一次，同天第二次 build 沿用已推進狀態 → 順序亂跳（負控制實錘）。每次 build 用同天 key 重新 seed → 同天每次 build 完全相同 shuffle 序列（重進 session 不亂跳）
- mode 含在 seed → 三 mode 各自獨立

## 4. 消費者清單

| # | 位置 | 影響 |
|---|---|---|
| 1 | session-v4.js constructor :34 | 刪 _rng（改 buildQueue 建立） |
| 2 | session-v4.js buildQueue :82-85 | shuffle 用新 rng |
| 3 | A6 cmpByRepsThenDue | learning/review 排序不碰（測試鎖住） |

## 5. 驗證

tools/verify-a7-daily-shuffle.mjs 120/120（同天兩次 build 順序相同、不同天順序不同、三 mode 獨立、learning/review 不受影響、負控制 stash 舊碼大量 FAIL 證明測試敏感）。A6 19/19 回歸、node --check、vite build 763ms。

## 6. 範圍外

- scheduler.js getDueCards（不 shuffle new，A7 純 Session 端）
- reviewMix/intersperse 不變
