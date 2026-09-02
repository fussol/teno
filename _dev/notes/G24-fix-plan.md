# G24 修法計畫書 v1.0

## Bug 定義
`render(s)`（src/pages/export.js:39-51）在 :43 用到 `words.length`（`<div class="page-subtitle">…共 ${words.length} 詞</div>`），但 `render` function 的 scope 內**沒有 `words` 變數**。`words` 只在 `renderContent(s)`（:14）內 `const { words } = s.state` 解構。`render` 呼叫 `renderContent`（:40、:47）但自身未解構 `words` → 執行 `render` 時 `words` 是 ReferenceError（Uncaught ReferenceError: words is not defined）。

## Root Cause
`renderContent` 抽出重構後，`render` 內殘留的 subtitle 用了只在 `renderContent` scope 存在的 `words`，抽離時漏補 `render` 自己的解構。audit 原文：「export.js:39-51 render 引用未定義 words → ReferenceError（目前無入口）」— dead page 但只要被 loadPage 呼叫即炸。

## 修法
`src/pages/export.js:39-43`，`render` 開頭補解構 `words`：
```js
export function render(s) {
  const { words } = s.state;
  const content = renderContent(s);
  ...
```
與 `renderContent`（:14）解構方式一致（從 s.state 取 words）。最小修法、不改任何輸出。

## 消費者清單（憲法②）
- `render` 呼叫端：main.js:302-303 `loadPage(page)` → `mod.render(store)` — 動態 import `./pages/export.js` 後呼叫。目前 export 未在 navItems/bottomItems 註冊（grep 實錘無 nav 入口），但 `loadPage('export')` 機制存在（main.js:68-73），任何 page 字串 'export' 導航到即觸發。
- `renderContent` 呼叫端：`render`(:40,:47) 內部 + `renderInPlace`（透過 render → onMount 重渲染）。
- `words` 來源：`s.state.words`（store 全域詞表）。
三形態：此為 JS scope bug（非 template/inline-style/CSS）— 第 1 形態。

## 驗證
- 靜態：grep 確認 `render` 補上 `words` 解構後無未定義引用（`words.length` 於 :43 有定義）。
- 動態 harness（tools/verify-g24-export-render.mjs）：
  - T1 載入 export.js（mock main.js/svg/api/platform/import 依賴）→ 呼叫 `render({ state: { words: [...], decks: [] } })` → 不回 throw、回傳字串含 '共 N 詞'
  - T2 負控制：模擬修法前（render 無解構）→ 斷言會 ReferenceError（bug 精準重現）
  - T3 decks 為空陣列正常、_deckFilter null 正常
- 回歸：此檔無其他入口，node --check + vite build。

## 風險
- 極低：export 頁面無 UI 入口，純防「未來導航即崩」。修法為純補解構，不影響邏輯輸出。

## 範圍外
- export 頁面無 UI 入口（navItems/bottomItems 未註冊 'export'）— 是否要加匯出入口屬功能需求，非 G24 bug 範疇，另開設計。
- `exportCsvDialog`/`exportCsvData`（api.js）的 F16 dead command 關聯 — 另開案。

## 審查委員數
簡單 bug（單檔 export.js、非共享、低風險、<15 行改動）→ 依法①降 1 名委員。