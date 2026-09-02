# G13 修法計畫書 v1.0

## Bug 定義
`src/lib/custom-select.js` 的客製下拉（trigger 為 `<button>`、選項為 `<div class="cs-option">`）**完全無鍵盤支援**：grep 全檔無 keydown/aria/focus 處理。audit G13：「無鍵盤支援/aria」。影響：鍵盤使用者（或無滑鼠）無法操作下拉；螢幕閱讀器無 aria 語意。
（註：audit 另一項「CSS.escape 特殊字元選擇器會壞」— 查證 :65 已用 CSS.escape(select.value)，此半已修，不重複。）

## Root Cause
build() 只加滑鼠 click，未實作鍵盤導航。選項 div 非 focusable、trigger 無 aria-haspopup/expanded、menu 無 active-descendant 關聯。

## 修法（src/lib/custom-select.js）
1. **trigger 加鍵盤**：`aria-haspopup="listbox"`、`aria-expanded`（切換時更新）、開啟時 focus 移到第一選項、Esc 關閉、Focus 交接。
2. **選項加鍵盤導航**：各 `.cs-option` 設 `tabindex=-1`、`role=option`、`aria-selected`；menu 設 `role=listbox`。trigger keydown 處理：`ArrowDown/ArrowUp` 在選項間移動 focus，`Enter/Space` 選中，`Esc` 關閉，`Home/End` 首尾。
3. **事件累積**：維持既有 document capture click（G5 另案），本顆只加鍵盤，不動既有 click 結構（避免與 G5 重疊範圍）。

## 消費者清單（憲法②）
`initCustomSelects` 呼叫端：src/pages/tools.js:331（_initCustomSelects）、src/main.js:306（每頁 render 後）。三者皆 bind 到 `.cs-trigger`/`.cs-option` 結構，鍵盤處理在 build() 內即自動涵蓋全部使用端。

## 驗證
- T1 模擬 ArrowDown 聚焦下一選項（DOM 事件）
- T2 Enter 選中、dispatch change、關閉 menu
- T3 Esc 關閉 menu 不選
- T4 aria-expanded 在開/關時正確切換 true/false
- T5 選項獲 focus 時 class 高亮
- T6 負控制：不加鍵盤處理前，keydown 不改變 active 選項（bug 重現）

## 風險
- 中低：新增 keydown handler 需小心不與既有 click 衝突；不影響滑鼠行為。
- aria 屬性為新增標記，無行為回歸。

## 範圍外
- document capture click 累積（G5）— 另開案。
- CSS.escape 特殊字元 — 查證已修（:65），本顆不重做。
- optgroup disabled 選項處理 — 功能增強，範圍外。

## 審查委員數
單檔、非共享、中等複雜（需 DOM 事件驗證）→ 依法①：非「<20行低風險」簡單，採 1 名委員審查（總統實測雙向證據）。