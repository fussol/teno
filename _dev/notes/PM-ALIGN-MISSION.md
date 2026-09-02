# PM-ALIGN 任務書 — 兩套新增/編輯 modal 對齊 + 直覺化優化（動 code）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`。工作目錄 `~/teno`，branch main。

## 任務性質
動 code 的對齊＋優化任務。把**字本瀏覽器 `src/pages/browser.js`** 的新增/編輯單字 modal，跟**字庫瀏覽器 `src/pages/deck-browser.js`** 的新增/編輯 modal **對齊**，並趁機做合理、直覺化的 UX 優化。一顆任務（對齊＋優化），完成後 commit（可升版）。

## 使用者需求（2026-08 口述）
>「這個 app 裡有兩種瀏覽器、兩種編輯器、兩種新增器。請把字本瀏覽器裡的新增和編輯器，與字庫瀏覽器裡的對齊。可以的話再對它們做一些適當的優化、合理直覺化。」

## 現況實錘（總統已盤點，請覆核再動手）
兩套 modal 各自獨立實作，欄位結構大致對齊，但有以下**功能/UX 不對齊**：

1. **新增單字 modal —「字本」欄位**：
   - `browser.js` openModal(:787-792)：`<select id="fDeck">` **可下拉切換字本**。
   - `deck-browser.js` openAddModal(:403-406)：`<input id="deckAddDeck" readonly>` **鎖死當前字本**，新增時無法選別的字本。
   - → deck-browser 的「新增」無法指定字本，跟 browser 不對齊。

2. **新增單字 modal — 詞性 chips 沒有 selected 樣式**：
   - `browser.js` openModal(:758-761)：`.map(p => { const sel = …; return `…${sel ? 'selected'…}` })` — **有** selected 視覺（雖然新增時通常無值，但結構有）。
   - `deck-browser.js` openAddModal(:376-378)：`.map(p => `<span class="pos-chip" data-pos…>`「無任何 selected 處理」` — **缺** selected class＋顯示邏輯。
   - → 兩邊詞性 chips 呈現不一致。

3. **新增 modal — 點擊 chip 的 stopPropagation**：
   - `browser.js` _tagInput keydown Enter(:834-839)：`…render(); e.stopPropagation();` — **有**。
   - `deck-browser.js` _tagInput keydown Enter(:454-459)：`…render();` — **沒有** stopPropagation。
   - → 卡片點擊/鍵盤事件可能冒泡，deck-browser 少了防護。

## 對齊方向（deck-browser 是基準，browser 已較完整）
以**較完整的一邊**為基準，把另一邊補齊：
- **字本欄位**：deck-browser 新增時應從 readonly 改成 `<select>`（可切換字本，預設當前字本），跟 browser 一致。
- **詞性 chips**：deck-browser 新增 modal 應加上 selected 樣式邏輯（跟 browser/編輯端一致），讓選中的詞性有視覺回饋。
- **鍵盤防護**：deck-browser 新增 `_tagInput` 補 `e.stopPropagation()`，跟 browser 一致。

## 合理直覺化優化（趁對齊一起做，但不要過度設計）
在對齊的同時，對**兩邊都適用的直覺化改善**（可擇優，前提是「合理、直覺」且不打破既有交互）：
- 消除重複的 `_tagInput` 實作？→ 若可行，是否抽共用 helper（先看 src/lib/ 有沒有現成可複用）。**注意**：不要大重構，除非明確降低重複且風險低。若抽共用需確認兩邊行為一致。
- 其他你發現的、直接影響「新增/編輯單字」直覺性的小問題（例如欄位 focus、Enter 送出、必填提示）可加分記載並修。
- **紅線**：不動 OCR、不動 FSRS、不動資料庫 schema、不動兩邊共用的 store actions。只限這兩個檔的新增/編輯 modal 範圍。

## 驗證門（commit 前必須過）
- `node --check` 兩個檔語法過。
- 手動/瀏覽器實跑：字本瀏覽器與字庫瀏覽器的「新增」與「編輯」modal 開啟、欄位一致、字本可切換、詞性 chips 有 selected 樣式、Enter/點擊行為正常。
- dev server 驗證用 curl grep（記憶：Browser browserbase 連不到本機 localhost）。dev server 跑 `npm run dev`（http://localhost:5173/）。
- 完成即 commit（附版本升版或至少清楚 message，依 `_dev/notes/行政法.md` 一結案一版本）。

## 交付
- 對齊＋優化的實際 code 改動（commit）。
- 回報：改了哪幾檔哪幾行、對齊了哪些點、做了哪些直覺化優化、驗證結果。
- 用繁體中文。

## 附註
這兩個檔目前有**未 commit 的髒 diff**（`autoFillOrder` 分隔符統一，4 行，`|`↔`,`）— 是前一波次留下的半成品。你的改動要**疊在 HEAD 之上**，不要遺失那 4 行（除非你判斷它該一併整理）。動手前先看 `git diff src/pages/browser.js src/pages/deck-browser.js` 了解現況，別覆蓋。