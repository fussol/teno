# G30 修法計畫書 v1.0

## Bug 定義
`src/lib/backup-scheduler.js` 的 `tick()`（:23）是 async，`startAutoBackup`（:8）`timer = setInterval(tick, ...)` — 若前一個 tick 的 `await backupDb()` 未完成而下一個 tick 觸發（interval 撞上慢備份）→ **兩個 tick 併發**，backupDb 可同時執行 → 重複/併發備份。audit G30：「tick 無重入保護 → 併發重複備份」。

## Root Cause
tick 無重入 flag。async 函式在 await 會讓出執行緒，interval 下一次觸發不等前一次完成。

## 修法（backup-scheduler.js）
tick 加 `_ticking` 重入保護（同步前置檢查 + finally 釋放）:
```js
async function tick() {
  if (_ticking) return;
  _ticking = true;
  try { ... } finally { _ticking = false; }
}
```
先 check 後 lock 在同一同步塊 → JS 單執行緒下同 tick 只一次。

## 消費者清單（憲法②）
`tick` 呼叫：startAutoBackup（初始 :10 + interval :11）。`_ticking` 僅本檔私有。

## 驗證
tools/verify-g30-backup-reentrant.mjs：
- T1 開頭 if(_ticking) return / T2 設鎖 / T3 finally 釋放 / T4 宣告初始 false / T5 backupDb 保留 / T6 同步 check→lock 順序
- git stash 負控制：未修版 5 FAIL（無重入）已實測

## 風險
- 極低：只加同步 reentrancy guard，邏輯不變；finally 保證異常也釋放鎖。

## 範圍外
- D18（backup-scheduler lastBackupMtime 初始 0 每次啟動都備份）— 另開案。
- pruneBackups 併發 — 被本 lock 保護。