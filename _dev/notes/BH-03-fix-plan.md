# BH-03 fix plan — deleteDeck 不清 memory 端 reviewLog / examHistory

> 任務書：PM-BH-FIX-MISSION.md / BUGHUNT-TODO.md#BH-03
> 檔：`src/lib/store.js`（共享核心檔 → 3 委員審查，不可降席）
> 動工前 HEAD：`634389d`（v5.8.14）

## 1. Bug 定義
`deleteDeck(id)`（store.js:1740-1771）刪整字本時，只 filter words/cards/各 Set/buriedAt/examples，**memory 端 `state.reviewLog`/`state.examHistory` 完全不動** → dashboard 保留率與測驗歷史仍含已刪字本作答，直到重載。DB 端 `db.deleteWordsByDeck`（db.js:366-381）已清 review_log（:370）＋ exam_history 雙世代（:372-373）→ memory/DB 分歧（整字本版，BH-02 的對稱補全）。

## 2. Root cause
deleteDeck 的 memory 過濾清單（:1746-1758）含 Set/buriedAt/examples，但漏了 reviewLog/examHistory 兩個 array。BH-02 修了單字刪除 `deleteWord` 的同一缺口；本顆補整字本版。

## 3. 影響
🟡 低。保留率 `computeRetention(state.reviewLog)`（scheduler.js:419）把已刪字本作答算入；測驗歷史側欄顯示已刪字本資料。整字本刪除較單字少發生，但與 BH-02 同根，屬對稱補全。

## 4. 修法（store.js deleteDeck）
**共用 BH-02 的 helper `deleteWordFromMemory(id)`，零邏輯漂移**：在 wordIds 計算後（:1745）加迴圈，對該字本所有 wordId 呼叫 helper，讓 reviewLog/examHistory（及重複的 Sets/examples）統一清除：

```js
const wordIds = new Set(state.words.filter(w => w.deck === deck.name).map(w => w.id));
for (const id of wordIds) deleteWordFromMemory(id);   // BH-03: 清 memory 端 reviewLog/examHistory（Sets/buriedAt/examples 同 helper 冪等重清無害）
...  // 既有 words/cards/Set 過濾保留
```
helper（BH-02 已建）`deleteWordFromMemory` 清：reviewLog filter(wordId!==id)、examHistory filter(word!==id)、六 Set .delete、(buriedAt 三) delete state[k][id]、examples.delete。

既有 deleteDeck 手寫的 words/cards/cardsMc/cardsSpell Map 過濾保留（helper 不含 cardMap）；Sets/buriedAt/examples 手寫過濾保留（與 helper 重複但結果一致──helper 對 Set 用 .delete 冪等、手寫 filter 重建後結果相同）。最小改動：僅加一行 for 迴圈。

## 5. 驗證方式
`tools/verify-bh03.mjs`（源碼釘＋語意重放＋負控制）：
- 源碼釘：讀真實 store.js deleteDeck，斷言含 `deleteWordFromMemory(id)` 呼叫（且位於 wordIds 計算後）。未修必 FAIL。
- 語意重放：假 state 含多字 reviewLog/examHistory 各含屬於被刪字本的 wordId → 模擬 loop helper → 斷言該 deck 所有 wordId 的 reviewLog/examHistory entry 全剔、對照其他字本不誤傷。
- 保留率關聯：確認「該 deck 字被剔後」computeRetention 不含已刪字本（與 BH-02 相同測法）。
- 負控制：剝除 for 迴圈 → reviewLog/examHistory 殘留（bug 態重現）。
- `git stash` 負控制：stash store.js → 源碼釘必 FAIL。
- 回歸：verify-bh01、verify-bh02（共用 helper 不衝突）。

## 6. 風險
低。helper 對單 id 冪等（repeat 無害），存活字/他字本不誤刪（對照組守護）。不碰 schema/FSRS/OCR。

## 7. 範圍外
- BH-04（tools.js listener）獨立。
- E1/E2（六 Set DB settings 持久化）技術債，本顆不擴張（與 BH-02 同定案）。

## 版本
`v5.8.15`（`./tools/version.sh 5.8.15` + Cargo.lock 同步；commit 前驗證四檔確保未被外部覆蓋）