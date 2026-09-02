# D14 修法計畫書 v1.0

## Bug 定義
`src/lib/db.js` 的 `deleteWord(id)`（:155）只刪 cards + words，**未刪 review_log / exam_history 孤兒**。audit D14：「GUI 單字刪除留 review_log/exam_history 孤兒」（D20 是 CLI cmdDeleteDeck 的另一案）。

## Root Cause
deleteWord 的 DELETE 清單漏了 review_log（word_id 關聯）與 exam_history（word 關聯）。同檔 deleteWordsByDeck（:298-303）有完整清理，但單字刪除漏做。

## 修法（db.js deleteWord）
在現有事務內補：
- `DELETE FROM review_log WHERE word_id = $1`
- exam_history.word 存**單字文字**（M4 實錘：recordExamResult store.js:601 `word: w.word`）非 id → 需先 `SELECT word FROM words WHERE id=$1` 取得文字，再 `DELETE FROM exam_history WHERE word = $wordText`

```js
const wr = await d.select('SELECT word FROM words WHERE id = $1', [id]);
const wordText = wr[0]?.word;
await d.execute('DELETE FROM cards WHERE word_id = $1', [id]);
await d.execute('DELETE FROM review_log WHERE word_id = $1', [id]);
if (wordText) await d.execute('DELETE FROM exam_history WHERE word = $1', [wordText]);
await d.execute('DELETE FROM words WHERE id = $1', [id]);
```

## 消費者清單（憲法②）
- `deleteWord` 呼叫端：store.js:1499 actions.deleteWord（browser.js GUI 刪除）。
- 同類 deleteWordsByDeck 已有完整清理（不移動）。

## 驗證
tools/verify-d14-delete-orphans.mjs：FakeDatabase 實測 deleteWord 清三表孤兒。
- H0 初始資料
- T1-T2 words/cards 刪對
- T3 review_log 孤兒清除（剩他詞的）
- T4 exam_history 孤兒清除（剩他詞文字的）
- T5-T6 剩的是 w2/banana（非誤刪）
- git stash 負控制：未修版 T3-T6 全 FAIL（孤兒殘留）已實測 4 FAIL

## 風險
- 中低：exam_history.word 存文字，需先取文字再刪；若無該 word（id 不存在）wordText undefined → 跳過 exam_history 刪除（安全）。review_log 用 word_id 直接刪。
- 事務保證：全部在單一 BEGIN/COMMIT，失敗 rollback。

## 範圍外
- M4（recordExamResult 存文字 vs id 不一致）— 另開案修正 schema 語意。
- D20 CLI cmdDeleteDeck 孤兒 — 另開案。