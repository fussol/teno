# G14 修法計畫書 v1.0

## Bug 定義
`src/pages/settings.js` 的 `renderInPlace`（:1429）內部重渲染後只 `onMount(s)`，**未重新 initCustomSelects** → custom-select 轉換在重渲染後遺失（原 select 變回原生）。audit G14：「renderInPlace 後 custom-select 轉換遺失」。

## Root Cause
main.js 每頁 render 後會 initCustomSelects（:306），但 settings.js 的 renderInPlace 走自己的 innerHTML+onMount，繞過 main.js 的 initCustomSelects → 重渲染的 select 不是 custom。

## 修法（settings.js）
- import `initCustomSelects`（../lib/custom-select.js）
- renderInPlace 在 onMount 後補 `initCustomSelects(container)`

custom-select module 我 G13/G5 修過（鍵盤+單例 listener），這裡直接復用。

## 消費者清單（憲法②）
renderInPlace 呼叫端多處（settings.js:788/794/951/1119/1148/1149/1240 等）。initCustomSelects 復用 main.js/tools.js 同款。

## 驗證
tools/verify-g14-settings-customselect.mjs：
- T1 renderInPlace 呼叫 initCustomSelects(container) / T1b 在 onMount 之後
- T2 import 存在
- T3 G14 marker
- git stash 負控制：未修 4 FAIL 已實測
- vite build

## 風險
- 極低：補一次 initCustomSelects（module 單例 listener，重複呼叫安全 — G5 已防累積）。
- 無行為變更，僅補回轉換。

## 範圍外
- settings.js 其他頁內建 select — 本顆統一由 renderInPlace 補，無其他特殊路徑。
- 非 settings 頁的 renderInPlace（export.js/import.js 自己的）— 各頁專責。