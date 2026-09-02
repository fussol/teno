# G5 修法計畫書 v1.0

## Bug 定義
`src/lib/custom-select.js` 的 `build()` 每個 select 都 `document.addEventListener('click', ..., {capture:true})` 且**永不移除**。`initCustomSelects`（main.js:306 每頁 render、tools.js:331:_initCustomSelects）每次 build 一個 select 就累積一個 document-level capture click listener → 切頁多次後成堆 listener。audit G5：「document capture click listener 每頁每次 mount 累積」。

## Root Cause
把 document-level 監聽綁在 build() 內，每建一個下拉就註冊一次，沒有去重。

## 修法（custom-select.js）
- module 級 `ensureGlobalDocListener()` + `_globalDocBound` flag — document listener **只註冊一次**
- module 級 `_csOpenWraps` Set 追蹤開啟中的 wrap
- `build()` 呼叫該 listener（不自己註冊）；trigger click/setOpen/addOption-close/closeAll 都同步 `_csOpenWraps`

document listener 掃 _csOpenWraps，點外空白一次全關（原語意保留）。

## 消費者清單（憲法②）
`initCustomSelects`：main.js:306（每頁 render 後）、tools.js:331/985。`build()` module 私有。

## 驗證
tools/verify-g5-doclistener.mjs（jsdom）：
- T1 _globalDocBound 單次綁定 / T2 僅一處 document.addEventListener / T3 build 內無 / T4 initCustomSelects 呼叫 helper / T5 _csOpenWraps 存在 / T6 G5 marker
- git stash 負控制：未修 T1/T4/T5/T6 全 FAIL（4 核心牙）已實測
- G13 回歸 ALL PASS（同檔鍵盤不破壞）+ vite build

## 風險
- 中低：document listener 改為 module 單例 + _csOpenWraps 追蹤。語意等價（點外關閉所有 open）。需確保所有 open/close 路徑同步 _csOpenWraps（setOpen/addOption/closeAll 已處理）。

## 範圍外
- G13（鍵盤/aria）— 已修 f522bf6，本顆不改鍵盤邏輯。
- CSS.escape 特殊字元 — 已存在(:65)，不動。