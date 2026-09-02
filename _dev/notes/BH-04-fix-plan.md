# BH-04 fix plan — tools.js custom-select 對 document 累積 click listener 無 guard

> 任務書：PM-BH-FIX-MISSION.md / BUGHUNT-TODO.md#BH-04
> 檔：`src/pages/tools.js`（頁面專屬低風險，GOV-BRIEF 允許降席 1 委員審查：單檔/非共享/低風險/<20行）
> 動工前 HEAD：`0b6dcaa`（v5.8.15）

## 1. Bug 定義
`src/pages/tools.js` 自實作 CustomSelect（.cs/.cs-t/.cs-o，非 lib/custom-select.js），`_initCustomSelects()`（:349-364）每次 onMount / renderPage 都對 `document` 加一條常駐 click listener（:350），無任何 module 級去重 flag → 連續進出工具頁 N 次累積 N 條相同 listener，點擊時 `document.querySelectorAll('.cs.o')` 各跑一遍，O(N×DOM) 效能劣化＋潛在多次 toggle 競態。renderPage 只支援 `window.__pageCleanup`，tools onMount 未設清理。

## 2. Root cause
tools 頁自訂 select 漏了 `lib/custom-select.js:12-13` 那套 G5 module 級 `_globalDocBound` 去重模式。每次註冊常駐 document listener 永不清理。

## 3. 影響
🟡 低。多次進出工具頁後點擊委派重複執行、全域掃描成本累加。屬 G5/G11「listener 累積」家族在 tools 頁的漏網（audit G11 列 tools.js:332 但未覆蓋 :350 自訂 select）。不崩潰、無資料遺失。

## 4. 修法（tools.js，仿 G5 模式）
於 `_initCustomSelects` 前加 module 級 flag + guard（:349 上方）：
```js
// BH-04: module 級 flag 擋重複綁定常駐 document click（仿 lib/custom-select.js G5 _globalDocBound）
let _toolsCsBound = false;
function _initCustomSelects() {
  if (_toolsCsBound) return; _toolsCsBound = true;
  document.addEventListener('click', e => { /* 原邏輯 */ });
}
```
最小幅：+2 行（flag 宣告 + guard）。

## 5. 驗證方式
`tools/verify-bh04.mjs`（源碼契約釘＋jsdom 語意重放）：
- 源碼釘：讀真實 tools.js，斷言 `_toolsCsBound` flag 宣告存在於 `_initCustomSelects` 前、且 `addEventListener('click'` 在 guard 邏輯之後。未修必 FAIL。
- jsdom 語意重放：jsdom（devDeps 已有）建 document，模擬 `_initCustomSelects` 語意（flag guard pattern）呼叫 N 次 → 斷言 document click listener 恆註冊 1 次；負控制剝除 flag → N 次 call 註冊 N 條（bug 態）。
- git stash 負控制：stash tools.js → 源碼釘必 FAIL。

## 6. 風險
極低。只加 flag 擋重複綁定，不影響首次綁定的 click 邏輯。register 後 listener 行為不變。

## 7. 範圍外
- 其他頁面/listener 累積（lib/custom-select.js 已有 G5 guard，不屬本顆）。
- `window.__pageCleanup` 生terative（tools onMount 未用，本顆不引入）。

## 版本
`v5.8.16`（`./tools/version.sh 5.8.16` + Cargo.lock 同步；commit 前驗證四檔）