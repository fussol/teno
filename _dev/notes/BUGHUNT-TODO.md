# Teno BUGHUNT — 待修 bug 清單（2026-08-30 離線波次）

> 任務書：`_dev/notes/PM-BUGHUNT-MISSION.md`。本波為「純調查＋清單寫作」，不動 code、不改 source、不 commit。
> 掃描者：BUGHUNT 一次性（bug 獵人）。對照 `scope-requests.md`（避免重報）＋ `bug-audit-2026-08-13.md`（大量已由 fetch/query/平滑 波次修復）。
> 委派說明：原計畫 6 平行唯讀掃描員全數卡在免費端點 `z-ai/glm-5.3-free` 的 429 限流（8 req/min），零產出。改由獵人本體親自逐檔 `read_file` 掃描補足覆蓋，以下每條皆獵人親讀實際行號、非代傳。
> 嚴重度：🔴高 / 🟠中 / 🟡低。每一條含「可重現 → 現況碼 → root cause → 影響 → 建議 → 驗證」，可直接派單。

---

## 清單總表

| ID | 檔:行號 | Bug 描述（一句） | 影響 | 型態 | 建議 |
|---|---|---|---|---|---|
| BH-01 | src/lib/store.js:1740-1766 | `deleteDeck` 清理 buried/suspended 家族時漏掉 `suspendedMc`/`suspendedSpell`（memory＋DB） | 🟠 | 資料/狀態 bug | deleteDeck 補過濾＋setSetting 兩 Set |
| BH-02 | src/lib/store.js:1697-1705 | `deleteWord` 只清 words/cards/cardsMc/cardsSpell，memory 端 reviewLog/examHistory/buried/suspended/examples/buriedAt 全殘留；DB 端已清 → memory/DB 分歧 | 🟠 | 資料/狀態 bug | deleteWord 同步清 state 各集合 |
| BH-03 | src/lib/store.js:1740 + db.js:365-378 | `deleteDeck→deleteWordsByDeck` 清 DB review_log/exam_history，但 store 端 `state.reviewLog`/`state.examHistory` 不刪 → dashboard retention/測驗歷史顯示已刪字，直到重載 | 🟡 | 資料/狀態 bug | deleteDeck 依 wordIds 過濾 state.reviewLog/examHistory |
| BH-04 | src/pages/tools.js:1004 + 349-364 | `_initCustomSelects()` 每次 onMount 對 `document` 累積 click listener 無 guard（custom-select.js:13 已有 G5 guard 可比） | 🟡 | UI/UX·listener 累積 | module 級 flag 擋重複綁定 |

---

## 詳細條目

### BH-01 — deleteDeck 漏清 suspendedMc / suspendedSpell

**檔:行號**：`src/lib/store.js:1740-1766`（重點 :1750-1764）

**重現步驟**
1. 任一字本任意字，在「多選」或「拼字」模式 suspend 一張卡（`store.actions.suspend(id,'mc')` 走 `:998`）。
2. 到設定/字本管理刪除整個該字本（`store.actions.deleteDeck(id)`）。
3. 檢查 `state.suspendedMc`／`state.suspendedSpell`→ 該字本的 wordId 仍殘留；DB `settings.suspendedMc`／`suspendedSpell` 也未清理。

**現況碼片段**
```js
// store.js:1750-1762
state.buried    = new Set([...state.buried].filter(id => !wordIds.has(id)));
state.suspended = new Set([...state.suspended].filter(id => !wordIds.has(id)));
state.buriedMc  = new Set([...state.buriedMc].filter(id => !wordIds.has(id)));
state.buriedSpell = new Set([...state.buriedSpell].filter(id => !wordIds.has(id)));
// ↑ 缺 state.suspendedMc / state.suspendedSpell 兩行
...
try { await db.setSetting('buried', [...state.buried]); } ...
try { await db.setSetting('suspended', [...state.suspended]); } ...
try { await db.setSetting('buriedMc', [...state.buriedMc]); } ...
try { await db.setSetting('buriedSpell', [...state.buriedSpell]); } ...
// ↑ 缺 suspendedMc / suspendedSpell 的 setSetting
```

**Root cause**：`deleteDeck` 的清理清單（:1750-1758）在 A5 波次補齊了三 mode 的 buried/buriedAt，但 **suspended 只補了 flip（:1751），mc/spell 兩 Set 漏補**。state 端與 DB 端都漏。

**影響**：字本刪除後，`settings.suspendedMc`/`suspendedSpell` 殘留死 id；若該 word 日後經其他路徑重新出現在 state（如同 id 的 cards 容器卡恢復、undo 例外路徑），`computeCombinedStats` 的 `hiddenAll`（:458-460）會因 suspendedMc 含該 id 而誤判該卡被隱藏，dashboard 統計失真。屬資料滯留腐化，隨時間累積。非崩潰、無立即資料遺失。

**建議修法**（單點）：在 `:1752` 後補兩行過濾，並在 `:1762` 區塊補兩行 setSetting：
```js
state.suspendedMc   = new Set([...state.suspendedMc].filter(id => !wordIds.has(id)));
state.suspendedSpell= new Set([...state.suspendedSpell].filter(id => !wordIds.has(id)));
// + db.setSetting('suspendedMc', [...state.suspendedMc]) / ('suspendedSpell', ...)
```

**驗證方式**：harness 建假 state（含三 mode suspended Set 各塞一個屬該 deck 的 id）→ 呼叫 deleteDeck → 斷言 suspendedMc/suspendedSpell 已剔除、DB setSetting 以新陣列呼叫；負控制＝移除本修法後該兩 Set 殘留，精準重現。

---

### BH-02 — deleteWord memory 端清理不全（reviewLog/examHistory/buried 等殘留）

**檔:行號**：`src/lib/store.js:1697-1705`；對照 `src/lib/db.js:217-233`

**重現步驟**
1. 學習一張字卡（產生 review_log + 該字進 `state.reviewLog`），並埋/暫停該卡（進 `state.buried`/`suspended`）。
2. 在字本瀏覽器刪除該單字（`store.actions.deleteWord(id)`）。
3. `db.deleteWord`（db.js:217-233）已清 DB 的 review_log（:225）＋ exam_history（:226）＋ cards；但 store 端：
   - `state.reviewLog` 仍含該 wordId 的 rating entries
   - `state.examHistory` 仍含該字
   - `state.buried`/`suspended`/`buriedMc`/`suspendedMc`/`buriedSpell`/`suspendedSpell`/`buriedAt` 等 Set/map 全未剔除
4. dashboard `retention`（`computeRetention` 吃 `state.reviewLog`）→ 已刪單字的作答仍被計入保留率，直到 app 重載才消失。

**現況碼片段**
```js
// store.js:1697-1705
async deleteWord(id) {
  state.words = state.words.filter(w => w.id !== id);
  state.cards.delete(id);
  state.cardsMc.delete(id);
  state.cardsSpell.delete(id);
  try { await db.deleteWord(id); } catch (e) { console.warn('[store] deleteWord deleteWord error:', e); }
  await refreshDerived();
  notify();
}
// ↑ 未清：state.reviewLog / state.examHistory / buried/suspended/buriedMc/buriedSpell/suspendedMc/suspendedSpell / buriedAt/buriedAtMc/buriedAtSpell / examples
```

**Root cause**：`deleteWord` 的三行 delete 只涵蓋 word 本體與三 mode card map，刪漏了其餘掛在 wordId 上的資料結構（reviewLog、examHistory、buried/suspended 三 mode Sets、buriedAt 三 map、examples）。DB 端（D14 已修）是完整的，故形成 memory 持有、DB 已刪的分歧。

**影響**：🟠 中。①dashboard「保留率」把已刪單字的舊作答算進去，直到重載（資料殘留誤導）；②`bug-audit` H2 系統靠 reviewLog 分析也會被臟資料污染；③重複「刪除→重新匯入同字」時 memory 舊 reviewLog 仍疊加。不崩潰、無 DB 層危害（DB 乾淨），但 memory/UI 一致性破壞。

**建議修法**（deleteWord 補齊，與 BH-03 分開依單字主路徑）：
```js
state.reviewLog = state.reviewLog.filter(l => l.wordId !== id);
state.examHistory = state.examHistory.filter(x => x.word !== id);   // exam_history.word 語意已統一為 word_id（B4）
[buried, suspended, buriedMc, suspendedMc, buriedSpell, suspendedSpell].forEach(k => { state[k].delete(id); });
[buriedAt, buriedAtMc, buriedAtSpell].forEach(m => delete m[id]);
state.examples.delete(id);
```

**驗證方式**：harness：建 state.words/cards/reviewLog/examHistory/buried 含該 id → deleteWord → 斷言各集合均剔除；負控制＝剝除修法的 baseline 該 id 殘留、retention 計入。跑 tools/verify-d14 系列確認 DB 端不受影響。

---

### BH-03 — deleteDeck 不清 memory 端 reviewLog / examHistory（DB 已清，UI 殘留）

**檔:行號**：`src/lib/store.js:1740-1766`；DB 端 `src/lib/db.js:365-378`

**重現步驟**
1. 學某字本的字（寫入 review_log），進字本管理刪整個字本。
2. `deleteWordsByDeck`（db.js:365-378）清 DB 的 review_log（:369）＋ exam_history（:370）；但 store 端 `state.reviewLog`/`state.examHistory` 完全不動（1745-1757 只 filter words/cards/各 Set）。
3. dashboard retention 仍含已刪字本的作答，直到重載；側欄/統計失真。

**現況碼片段**
```js
// store.js:1744-1758
if (deck) {
  const wordIds = new Set(state.words.filter(w => w.deck === deck.name).map(w => w.id));
  state.words = state.words.filter(w => !wordIds.has(w.id));
  state.cards = new Map([...state.cards].filter(([wordId]) => !wordIds.has(wordId)));
  // cardsMc/cardsSpell 同
  // Set 清理（BH-01 已述）
  // ↑ 全程無 state.reviewLog / state.examHistory 過濾
```
而 `db.js:365-378` 已刪 DB：
```js
await d.execute('DELETE FROM review_log WHERE word_id IN (SELECT id FROM words WHERE deck = $1)', [deckName]);   // :369
await d.execute('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = $1)', [deckName]);     // :370
```

**Root cause**：BH-02 的整字本版本。DB 端完整、memory 端缺 filter。與 BH-02 同根因，但觸發點（整字本刪除／多字一次）與檔案位置（deleteWordsByDeck 對應）不同，建議分顆處理（或由總統合併在同一「刪除清理」計畫書內一次覆蓋 BH-02+03）。

**影響**：🟡 低。同 BH-02 的 retention/測驗歷史失真，但整字本刪除較單字刪除少發生；仍屬同一 memory/DB 一致性問題，且是 BH-02 修法的對稱補全。

**建議修法**：deleteDeck 在 wordIds 算出後，前置過濾 memory 端（與 BH-02 共用一個 helper，避免邏輯漂移）：
```js
state.reviewLog = state.reviewLog.filter(l => !wordIds.has(l.wordId));
state.examHistory = state.examHistory.filter(x => !wordIds.has(x.word));
```

**驗證方式**：harness：建含多字 reviewLog/examHistory 的假 state → deleteDeck → 斷言該 deck 所有 wordId 全剔；負控制：移除過濾 → 殘留、retention 溢算。

---

### BH-04 — tools.js 自實作 custom-select 對 document 累積 click listener（無 guard）

**檔:行號**：`src/pages/tools.js:1004`（呼叫）+ `:349-364`（定義）；對照 `src/lib/custom-select.js:12-13`（有 G5 guard）

**重現步驟**
1. 開啟工具頁（`src/pages/tools.js` onMount :254 → 行尾 :1004 `_initCustomSelects()`）。
2. 連續進入/離開工具頁 N 次（每次 renderPage 重建 container 後重跑 onMount）。
3. `document.addEventListener('click', ...)`（:350）每次 addEventListener 都新增一條 → N 個相同 document click listener 並存。
4. 在頁面任一點擊 → N 個 listener 依序執行（`document.querySelectorAll('.cs.o')` 各跑一遍，O(N×DOM)），效能劣化＋潛在多次 toggle 競態。

**現況碼片段**
```js
// tools.js:349-364 — 無任何 module 級 flag / 綁定去重
function _initCustomSelects() {
  document.addEventListener('click', e => {   // ← 每次 onMount 都加一條
    const t = e.target.closest('.cs-t');
    document.querySelectorAll('.cs.o').forEach(c => { if (c !== t?.closest('.cs')) c.classList.remove('o'); });
    ...
  });
}
// :1004
_initCustomSelects();
```
對照已修的 `custom-select.js:12-13`：
```js
let _globalDocBound = false;
function ensureGlobalDocListener() { if (_globalDocBound) return; _globalDocBound = true; document.addEventListener(...); }
```

**Root cause**：tools 頁有自己的 CustomSelect 實作（.cs/.cs-t/.cs-o，非 lib/custom-select.js），但漏了 G5 那套 module 級 `_globalDocBound` 去重。每次 onMount 重複註冊常駐 document listener，永不清理（renderPage 只支援 `window.__pageCleanup`，tools onMount 未設）。

**影響**：🟡 低。常駐 document listener 累積 → 多次進出後點擊委派重複執行；`querySelectorAll('.cs.o')` 全域掃描在 list 頁累加成本；屬 G5/G11「listener 累積」家族在 tools 頁的漏網（audit G11 列了 tools.js:332 但未覆蓋 :350 這段自訂 select）。

**建議修法**（同 custom-select G5 模式，module 級 flag）：
```js
let _toolsCsBound = false;
function _initCustomSelects() {
  if (_toolsCsBound) return; _toolsCsBound = true;
  document.addEventListener('click', e => { /* 原邏輯 */ });
}
```

**驗證方式**：browser 實跑：進出工具頁 3 次 → `getEventListeners` 或 console 計數確認 document click listener 恆為 1；負控制＝無修法時每次進入 +1。附 node 靜態釘：grep tools.js 內 `addEventListener('click'` 於 `_initCustomSelects` 外層有無 flag guard。

---

## 掃描覆蓋與侷限（誠實登記）

- **已親讀（獵人本體 read_file）**：db.js 全檔、store.js 全檔、api.js、ocr-blacklist.js、scheduler.js、session-v4.js、session-utils.js、tts.js、app-log.js、ocr/engine.js、custom-select.js、dashboard.js（前段）、browser.js 編輯區、settings.js 備份/匯入區、tools.js 自訂 select、exam-mc.js resume/計分區、export.js、main.js 路由、lib.rs 網址解析區。以上多為歷波次反覆打磨的核心，**乾淨度很高**。
- **委派失敗**：6 平行唯讀掃描員全數因免費端點 429 限流（z-ai/glm-5.3-free，8 req/min）退回，無法平行覆蓋全部 53 js + 5 rs + 3913 行 cli.mjs。本清單主打「核心資料層＋頁面層」中**實錘、非已登記**的 bug。
- **未逐行親讀、但值得後續補掃者**（本波未實錘，不列 entry）：`tools/cli.mjs`（3913 行）全檔、`src-tauri/src/drive_sync.rs` 全檔、`src/core/filterEngine.js`/`simulator.js`、`src/pages/browser.js` 後半、`deck-browser.js` 大半、`tag-manager.js`、`src/core/fsrs.js`（FSRS 對齊官方，低風險）、`_dev/cli/cli.mjs` 鏡像。**建議**：另行 spawn 單一 CLI 掃描員（避開 429 併發）或下波補掃。
- **已避免（不屬本波新 bug）**：`exportCsvData` 死 wrapper（api.js:111，F16-SR1 已登記）、`export.js:8` 死 import（F16-SR1）、`deleteWordsByDeck` 雙世代 exam_history id/text（D20-SR1 已登記）、`lib.rs:488 unwrap`（有 len≥6 前置檢查，安全）、`store.js simParamsMc?.`（有 simParams fallback，安全）、settings.js 的 D5/D6 順序（已修）。

## 建議派單優先序
1. **BH-01**（中，資料腐化，單點、易修易驗）— 首顆。
2. **BH-02**（中，單字刪除主路徑 memory 分歧，涉及 retention 正確性）。
3. **BH-03**（低，可與 BH-02 併計畫書一次覆蓋「刪除清理全補」）。
4. **BH-04**（低，listener 累積簡單修，可排後）。

全部 4 條皆不在 `scope-requests.md` 已登記清單、也不在 `bug-audit-2026-08-13` 已修範圍，屬**新發現未登記 bug**。