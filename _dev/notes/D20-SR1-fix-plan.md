# D20-SR1 修復計畫書 — deleteWordsByDeck/deleteWord 漏 exam_history 兩世代孤兒

- **Bug ID**: D20-SR1
- **規格來源**: scope-requests.md D20-SR1（PM2 登案，2026-08-28）
- **任務書**: PM-SR1-MISSION §佇列2
- **基線**: HEAD `bb1a0d8`(5.8.1)；交件時再確認最新 HEAD
- **首相**: SR1（資料層）

## 1. Bug 定義
GUI 刪字/刪牌組路徑漏清某世代 `exam_history` 孤兒：
- `deleteWordsByDeck`(db.js:365-378) line 370：`DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck=$1)` —— 只蓋 **B4 後 id 世代**（exam_history.word 存 word_id），**B4 前 legacy 文字世代孤兒留**。
- `deleteWord`(db.js:217-233) line 226：`DELETE FROM exam_history WHERE word = $1 [wordText]` —— 只蓋 **legacy 文字世代**，**B4 後 id 世代孤兒留**。

兩函式各漏一族 → 刪字主路徑/刪牌組路徑都會留孤兒測驗紀錄（真資料汙染，長期累積）。

## 2. Root cause
`exam_history.word` 欄位**雙世代混存**（實錘）：
- B4（e53a3ce）前一世代：存單字文字（db.js:226 deleteWord 用 wordText 清的＝此世代）。
- B4 後一世代：存 word_id（store.js:1987 `addExamEntry({ word: r.wordId ...})` 實錘 → 此世代存的是 id）。
照 B4 後當下 commit，store.js 改寫入 word_id，但**既有列仍是文字**，且 B4 後 SQL imports 也混存（cli.mjs:780 用雙族 OR 清）。
`deleteWordsByDeck:370` 用 `(SELECT id ...)`，`deleteWord:226` 用 wordText 各只命中一族 → 另一族成孤兒。

> 任務書原描述「deleteWordsByDeck:370 只刪 id 族 / deleteWord:221-226 只刪 text 族」與實錘完全吻合。行號：任務書 370/221-226 vs 實錘 370/226（僅 deleteWord 行號微差，函式範圍一致）。

## 3. 修法（採「兩條 DELETE 各蓋一族」，評定最穩）
對齊 CLI 已驗證語意（tools/cli.mjs:780 `cmdDeleteDeck` 單句 OR 雙比，verify-d20 T9c 源碼釘）：
- **兩條各蓋一族**（不採 JOIN 統一）：因 `exam_history.word` 混存，經由 `words` 的 `IN (SELECT id)` 與 `IN (SELECT word)` 各命中一族。若用 JOIN 統一語意仍須兩邊各比，反不如雙 DELETE 直接。ID 值可直接撞文字值（如 word_id="7" 與單字文字 "7"）但雙 DELETE OR 各蓋即可，無誤刪風險（都是同 deck 範圍）。

### db.js deleteWordsByDeck line 370 改為：
```js
// D20-SR1: exam_history.word 雙世代（B4 前 legacy 文字／B4 後 word_id）兩族皆刪（對齊 CLI cmdDeleteDeck）
await d.execute('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = $1)', [deckName]);   // B4 後 id 世代
await d.execute('DELETE FROM exam_history WHERE word IN (SELECT word FROM words WHERE deck = $1)', [deckName]);  // B4 前 legacy 文字世代
```

> **v1.1 論證修正（審查採納）**：碰撞風險（word_id 字面值撞他單字文字）在「兩條 DELETE」與「JOIN 統一」間**等價**——兩方案皆刪兩族聯集。真正的優勢是：每行可掛世代註解、與 CLI 已驗證版（cli.mjs:780）語意對齊、與 GUI 既有多語句風格一致。判定成立。

### db.js deleteWord line 226 補 id 世代：
```js
await d.execute('DELETE FROM exam_history WHERE word = $1', [String(id)]);  // D20-SR1: B4 後 id 世代
if (wordText) await d.execute('DELETE FROM exam_history WHERE word = $1', [wordText]);  // D14: legacy 文字世代
```

注意：`DELETE FROM exam_history` 兩條都在 `DELETE FROM words` 之前（子查詢依賴 words 在場），現有順序已符合（review→exam→cards→words）。

## 4. 驗證（雙態）
`tools/verify-d20-dual-generations.mjs`（新建，task書指定）：
- 沙箱 tmp SQLite（node:sqlite DatabaseSync）建真 DDL（words/cards/review_log/exam_history/decks），測資含：
  - legacy 文字世代：exam_history.word 存 'apple'（文字）
  - B4 後 id 世代：exam_history.word 存 'w1'（id）
  - review_log/cards 以 word_id
- 重放修後語意（OR 雙併 DELETE from exam_history）：兩世代皆清 → 驗證主路徑。
- 負控制：只跑單一代（剝除另一族 DELETE）→ 該世代孤兒留存 → RED。證明 harness 能抓 bug。
- 另 source-level 斷言：db.js 內 deleteWordsByDeck 需同時含 `(SELECT id` 與 `(SELECT word` 兩條 exam DELETE；deleteWord 需同時含 wordText 與 id 兩條 exam DELETE。
- 既有回歸：`tools/verify-d20-delete-deck.mjs`（CLI 域 T9c 源碼釘，不應受 db.js 影響）＋`tools/verify-d14-delete-orphans.mjs`（D14 舊測，只測 text，不應退化）。

## 5. 風險
- 低。純補一條/改一條 DELETE，SQL 語意與 CLI 已驗證版一致。
- deleteWord 補 String(id) 避免 Tauri sql plugin 傳非字串 id 失敗（word_id 存字串）。

## 6. 範圍外
- store.js 的 addExamEntry（他軌，不動；B4 後寫 word_id 為既有行為）。
- DB migration 統一 exam_history.word 欄位語意（跨域大改，非本 bug 需求）；改欄語意為清一色 word_id 可消除未來雙世代，但屬資料遷移，登記追蹤。

## 7. 可選項
- JOIN 統一語意 → **不做**（需兩邊各比，雙 DELETE 更直接；CLI 已用雙 DELETE OR 先例）。
- migration 統一欄位語意 → **不做**（另行追蹤，避免本 bug 範圍爆炸）。

## 8. 過審後動工 checklist
- [x] db.js deleteWordsByDeck line 370 補 legacy 文字世代 DELETE（兩條 DELETE）
- [x] db.js deleteWord line 226 補 B4 後 id 世代 DELETE（String(id)）
- [x] node --check db.js → SYNTAX-OK
- [x] verify-d20-dual-generations.mjs 正向 → 10/10 ALL PASS
- [x] verify-d20-dual-generations.mjs 負控制（剝除 single 族）→ 孤兒留、source 釘翻紅
- [x] 回歸 verify-d20-delete-deck（T8 為 cli.mjs 既有失敗，經 stash + 結構證明隔離非本次引入）+ verify-d14（--experimental-test-module-mocks，7/7 ALL PASS）+ g24/g30/d6

## 版本
待結案時確認 HEAD 現值（D5 已升 5.8.2），D20 結案升下一版。

## 版本紀錄
- v1.0（送審）：初版。
- v1.1（審查採納，R1 3 委員）：①§8 checklist 補勾；②§3 論證修正——碰撞風險在兩方案等價，真正優勢是「每行可掛世代註解＋與 CLI 已驗證版對齊＋GUI 既有多語句風格一致」；③回歸回報補註 d14 需 `--experimental-test-module-mocks` flag（node:test mock.module 需實驗 flag）。程式碼零變動。