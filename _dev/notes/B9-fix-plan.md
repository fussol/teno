# B9 Fix Plan — 測驗進度條以 idx 為準 → 永遠到不了 100%、答題後落後一題

## 1. Bug 事實

**位置**：三頁 renderExam pct 計算（flip :133 / mc :131 / spell :131）

**問題**：`Math.round((e.idx / total) * 100)` — idx 是**當前題號**：
1. 最後一題 idx=total-1 → pct=(total-1)/total 永遠不到 100%（10 題封頂 90%）
2. 答完才 nextWord(idx++) → 進度條落後一題

## 2. 語意決策：已答題數（非 (idx+1)/total）

- **(idx+1)/total 只是把落後往前挪一題** — 第一題還沒答就顯示 10%、答完第 9 題顯示 100%（實際只答 9 題），語意仍是「當前位置」不是「完成度」
- **已答題數直接解決兩條根因**：進度 = 完成的題數，作答當下（results/_correct 即時寫）就 +1 → 不落後；答完最後一題 → total/total = 100%
- **resume 自洽**：前場已答題（flip 'old'/true/false、mc results、spell spellData 還原）自然計入

## 3. 修法（每頁 1 行）

- flip :133：`answered = (e.results||[]).reduce((n,r)=>n+(r!==undefined?1:0),0)`
- mc :131：同上（results 即時寫 B3 語意）
- spell :131：`answered = e.words.reduce((n,w)=>n+(w._correct!==undefined?1:0),0)`（spell 無 e.results，與 B1/B4/applyTags 同源）
- 結果頁 renderResult pct（correct/(correct+wrong)）**正確**，未動

## 4. 驗證

tools/verify-b9-progress.mjs 59/59：T1 三頁 10 題已答 n → n×10%（0%→100%，答完 10 題仍在 exam phase 即 100%）；T2 resume 前場已答計入；T3 結果頁 pct 不變（6 對 4 錯→60%）；T4 三頁 pct 序列一致；T5 負控制剝除 → 舊 bug 再現（答完第 1 題仍 0%、10 題只到 90%）。回歸 B5-B8/B10/B11 全過。vite build 754ms。

## 5. 範圍外

- 結果頁 renderResult（分數制，正確）
- 測驗邏輯本身（作答/計分/timer）
