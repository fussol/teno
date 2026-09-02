# G10 修法計畫書 v1.0

## Bug 定義
`bindSpeakClick`（src/lib/tts.js:193）的事件委派 selector 含 `.card-panel-body`。該 class 是 browser.js:236 / deck-browser.js:1203 定義的**整張卡片容器**（含 `cursor:pointer`）。`:195` 只擋 `button/input/a/select/textarea` → 使用者點 `.card-panel-body` **任何位置**（含中文定義/例句/空白）都會命中，`el.textContent.trim()` 把**整段含中文**拿去 TTS 朗讀。audit G10 原文：「.card-panel-body 整段可點發音（含中文）」。

## Root Cause
委派 selector 把「容器」誤列為「可點發音元素」。卡片內真正該發音的子元素（.card-panel-word/pron/def/example/desc）個別 class 已各自在 selector 內（:193）→ `.card-panel-body` 是冗餘且有害：它把容器整包變可點，點中文也唸。

## 修法
`src/lib/tts.js:193`，從 selector 移除 `.card-panel-body`：
```js
const el = ev.target.closest('.study-word, .study-example, .chip-accent, .chip-subtle, .tts-click, .word-row-word, .deck-word, .card-panel-word, .card-panel-pron, .card-panel-def, .card-panel-example, .card-panel-desc');
```
一行移除。發音功能完全保留（word/pron/def/example/desc 仍各自可點）。

## 消費者清單（憲法② grep 實錘）
`bindSpeakClick` 呼叫端（全部注入 getSettings、同一函式）：
- src/pages/exam-flip.js:462 / exam-mc.js:465 / exam-spell.js:445
- src/pages/study-mc.js:125 / study-spell.js:124
- src/pages/study-v4.js（import）／其餘頁面巡禮
`.card-panel-body` 定義/使用：browser.js:236,267 / deck-browser.js:1203,1234 — 兩處容器。容器內可發音子元素 .card-panel-word/pron/def/example/desc 均保留在 selector。
三形態：此為 selector 字串（非 CSS，是 JS addEventListener selector）— 第 1 形態（JS code）。

## 驗證
tools/verify-g10-card-body-click.mjs：以真實 bindSpeakClick 邏輯測事件委派命中：
- T1 點 `.card-panel-body` 容器本身（含中文 text）→ **不觸發** speak（修後）
- T2 點 `.card-panel-word`（單字）→ 觸發 speak（word）
- T3 點 `.card-panel-def`（英文定義）→ 觸發 speak
- T4 點 `.card-panel-example` → 觸發 speak
- T5 負控制：模擬舊 selector（含 .card-panel-body）→ T1 會觸發（bug 精準重現）
- T6 `__speakBound` 防重複綁定仍有效

## 風險
- 極低：只移除容器 class 的點擊觸發，子元素發音不變。無其他消費依賴 `.card-panel-body` 整包可點。

## 範圍外
- `.card-panel-example` 未做 extractEnglish（點例句會連中文一起唸）— 與 G10 不同議題，且 study-example 有 extract，card-panel-example 屬卡片預覽，另開案。
- `.card-panel-def` 點中文定義會唸中文 — 同屬卡片規則，範圍外。

## 審查委員數
簡單 bug（單檔 tts.js、非共享、低風險、改動 1 行）→ 依法①降 1 名委員。