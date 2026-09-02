# BH-02 fix plan — deleteWord memory 端清理不全（動保留率，特嚴謹）

> 任務書：PM-BH-FIX-MISSION.md / BUGHUNT-TODO.md#BH-02
> 檔：`src/lib/store.js`（共享核心檔 → 3 委員審查，不可降席）
> 動工前 HEAD：`205d565`（v5.8.13）

## 1. Bug 定義
`deleteWord(id)`（store.js:1697-1705）只清 `state.words` + 三 mode cardMap，但**memory 端其他掛在 wordId 的資料結構全殘留**：
- `state.reviewLog`（含該 wordId 的 rating entries）→ **dashboard 保留率 `computeRetention(state.reviewLog)` 把已刪單字的舊作答算入**，直到 app 重載
- `state.examHistory`（word 存 word_id）
- `state.buried/suspended/buriedMc/suspendedMc/buriedSpell/suspendedSpell` 六個 Set
- `state.buriedAt/buriedAtMc/buriedAtSpell` 三個 map（wordId→date）
- `state.examples`（Map）

DB 端（db.js `deleteWord`:217-234）已完整清除（D14 清 review_log/exam_history，D20-SR1 補雙世代）→ 形成 **memory 持有、DB 已刪的分歧**。

## 2. Root cause
deleteWord 的三行 delete 只涵蓋 word 本體與三 mode cardMap，漏刪其餘 wordId 掛載結構。BH-01 修的是 deleteDeck 端、且只補 suspendedMc/Spell；deleteWord 這條單字刪除主路徑的家族清理完全不齊。

## 3. 影響
①保留率把已刪字舊作答算入（30 天窗，`computeRetention` 只數 lookback window 內 reviewLog 的 total/correct）→ **誤導 dashboard**；②bug-audit H2 依賴 reviewLog 的分析被髒資料污染；③重複「刪除→重新匯入同字」時舊 reviewLog 疊加。

## 4. 修法（store.js）
新增 module 級 helper（createStore 內、deleteWord 前），統一「把單字從 memory 端所有掛載結構抹除」，**BH-02 與 BH-03 共用此 helper 避免邏輯漂移**：

```js
/** 把 id 指定單字從 memory 端所有掛載結構抹除（word/reviewLog/examHistory/六Set/三buriedAt/examples） */
function deleteWordFromMemory(id) {
  state.reviewLog = state.reviewLog.filter(l => l.wordId !== id);
  state.examHistory = state.examHistory.filter(x => x.word !== id);   // exam_history.word 語意已統一為 word_id（B4）
  for (const k of ['buried', 'suspended', 'buriedMc', 'suspendedMc', 'buriedSpell', 'suspendedSpell']) state[k].delete(id);
  for (const k of ['buriedAt', 'buriedAtMc', 'buriedAtSpell']) if (state[k]) delete state[k][id];
  state.examples.delete(id);
}
```
`deleteWord` 在現有三行後呼叫 `deleteWordFromMemory(id)`：
```js
state.cardsSpell.delete(id);   // (既有三行)
...
deleteWordFromMemory(id);
```

最小幅、不碰 DB schema / FSRS / OCR。

## 5. 驗證方式（動保留率，特嚴謹）
`tools/verify-bh02.mjs`：
- **源碼釘**（讀真實 store.js deleteWord body）：斷言含 `reviewLog` filter、`examHistory` filter、六 Set `.delete(id)`、三 buriedAt `delete m[id]`、`examples.delete(id)`、且有 `deleteWordFromMemory(` 呼叫。未修必 FAIL。
- **保留率實測**：`import computeRetention`（真實 scheduler.js）。建 reviewLog 含「已刪字」2 筆（1 correct + 1 wrong）＋「存活字」2 筆（皆 correct）→
  - 修後語意（剔除已刪字）→ retention total=2 correct=2 rate=1.0
  - 負控制（保留已刪字，即 bug 態）→ total=4 correct=3 rate=0.75（溢算，rate 被拉低）
  - 斷言兩數不同 → 證明 harness 能抓「保留率吃髒資料」。
- 語意重放：deleteWordFromMemory 對假 state（含 reviewLog/examHistory/六 Set/三 buriedAt/examples 各塞 id）→ 剔除正確、對照存活字不誤傷。
- 負控制：剝除 `deleteWordFromMemory` 呼叫 → 殘留、retention 溢算。
- `git stash` 負控制：stash store.js → harness 源碼釘必 FAIL。
- 回歸：`tools/verify-d20-dual-generations.mjs`（DB 端雙世代不受影響）。

## 6. 風險
低。helper 只針對 deleteWord 的 id，存活字不誤刪（對照組守護）。不碰 schema/FSRS/OCR。清除是孤立記憶體操作，與 DB 已刪狀態對齊。

## 7. 範圍外
- BH-03（deleteDeck 端 reviewLog/examHistory）使用同一 helper，獨立 commit。
- `_undoSnapshots`（undo 快照）非 BUGHUNT 範圍，本顆不動。
- E1（Set 家族 Array.isArray 防禦）、E3（suspend 快照寫回競態）為技術債，追蹤於 subagent-log 不在此顆。

## 版本
`v5.8.14`（`./tools/version.sh 5.8.14` + Cargo.lock 同步）