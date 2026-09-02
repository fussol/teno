# G25 修法計畫書 v1.0

## Bug 定義
`src/lib/app-log.js` 的 `resetAttempted`（:13）在首次 DB 損壞重建後「永久設 true」（:85）→ 之後若 DB 再次損壞，`!resetAttempted` 為 false → **不再重建**，且 flush 每 2 秒無限重試（:90）。audit G25：「resetAttempted 永久 true → 二次損壞不再重建、flush 無限重試」。

## Root Cause
用一次性布林 resetAttempted 記錄「已重建過」，但沒重設 → 二次損壞失去重建能力。

## 修法（app-log.js）
把布林 `resetAttempted` 改為計數 `resetCount`（上限 3）：
- `let resetCount = 0`
- 損壞時 `if (resetCount < 3 && /malformed|code: 11/...) { resetCount++; resetAndReload(); }`
二次/三次損壞仍能重建；達上限 3 停止重建（防死循環：損壞→重建→又損壞無限刪檔）。

## 消費者清單（憲法②）
`resetAttempted`/`resetCount` 僅 app-log.js 內部使用（module-private）。resetAndReload ✅ 呼叫 resetAppLogDb（api.js）。

## 驗證
tools/verify-g25-applog-reset.mjs：
- T1 無 let resetAttempted = false（改用 resetCount）
- T2 用 resetCount + 上限 3（<3 觸發、++）
- T3 malformed/code:11 監測保留
- T4 resetCount 每次損壞觸發（<3）
- git stash 負控制：未修版 T1/T2/T4 全 FAIL（布林永真）已實測 3 FAIL

## 風險
- 中低：resetCount 上限 3 通權—二次損壞仍重建（修 bug），但防無限刪檔。上限值 3 為保守安全邊界。

## 範圍外
- app-log flush 無限重試（:90）本身 — 與 G25 相連；reset 後 queue 仍會重試，但現在能重建不卡死。若仍每 2 秒重試需另評估（retry 上限）。
- resetAndReload 失敗（catch 空）— 另開案。