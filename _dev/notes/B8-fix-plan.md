# B8 修復計畫 — 測驗暫存 _ 欄位污染 state.words 活參考

## Bug 事實（audit 確認）
- `src/pages/exam-mc.js:216-225` startExam 直接對 pool 的 word 物件加 `_options/_correctIdx/_answered/_picked/_noScore`
- `src/pages/exam-mc.js:250-265` resumeSession 從 mcData 還原同上欄位
- `src/pages/exam-spell.js:265` submitSpelling 寫 `w._correct = isCorrect`
- 這些 word 來自 `s.state.words`（wordPool/wordMap 回傳活參考）→ 測驗結束後 state.words 帶殘留；
  且 store.editWord 的 `state.words[idx] = {...old, ...updates}` spread 會把 _ 欄位保留進新物件。
- exam-flip.js 檢查結論：**零 _ 寫入**（作答記錄在 module 層 e.results）→ 不需改。

## 修法決策：深拷貝（startExam + resumeSession），spell 輔以 spellData 序列化
理由：
1. 深拷貝在兩個 e.words 賦值入口（startExam/resumeSession）做一次，即可封死全部污染路徑
   （作答/exit/saveOnLeave/applyTags/recordExamResult 皆操作 e.words）。
2. 清理方案不可行：spell 的 B4「整場答過之題」依賴 exit→resume 間 `_correct` 活參考殘留
   （spell session 無 per-word 資料）；且 bottom-nav 離開（B1/B2 不存檔、phase 留 exam）期間
   殘留仍在 → 清理方案無法根除跨頁污染。
3. spell 的殘留傳遞改為序列化：exit/saveOnLeave 收集 `spellData={wordId: _correct}` 進 session，
   resumeSession 從 spellData 還原到副本 → B4 語意完全保持（記錄集合＝spellData 舊場＋新答）。

## 改動
- `src/pages/exam-mc.js` :214 startExam、:249 resumeSession → `pool.map(w => ({...w}))`
- `src/pages/exam-spell.js` :217 startExam、:241 resumeSession（＋spellData 還原）、
  :286 collectSpellData() helper、:302 saveOnLeave、:446 exit handler 帶 spellData
- `tools/verify-b7-mc-tags.mjs` :93 editWord stub 對齊真實 store（write-back by id）—
  深拷貝後 applyTags 的 tags 寫回改經 editWord（B7 斷言語意不變：未答題零標籤＋editWord 零呼叫仍鎖）
- `tools/verify-b8-temp-fields.mjs`（新增防回歸，7 情境 44 斷言，含負控制）

## 驗證
- verify-b8 44/44（T1 mc 全新 / T2 mc resume+saveOnLeave / T3 spell 全新+exit /
  T4 spell resume B4 語意 / T5 applyTags 回歸 / T6 flip 對照 / T7 負控制剝除拷貝→污染再現）
- 回歸：B5 51/51、B6 72/72、B7 34/34、B10 73/73、B11 21/21、A5（--experimental-test-module-mocks）全過
- node --check 3 檔 + vite build 814ms
- 不 commit（parent 負責）；chart.js/base.css 未動
