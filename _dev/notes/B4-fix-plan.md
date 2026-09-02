# B4 — recordExam 死碼＋word 欄位語意統一（v1.2 — 定案 ✅ 已實作）

狀態：**第 2 輪 3/3 ✅ 定案；實作完成、驗證全綠（憲法第 4 條 ✅ 附實測）**
關聯：v3 定案 ⚠️→✅（批次 6，與 E2 同批；E2 已獨立出貨，B4 單顆收尾）
負責人：首相 A（學習核心序列：fsrs.js / session-v4.js / store.js / session-utils×3 / verify 工具）

## 一、Bug 定義（v3 定案 + 實錘現況）

1. **recordExam 死碼**：`store.js:1638` `async recordExam(results)` 定義存在，但**全專案零呼叫**（grep 實錘）→ `exam_history` 永遠只有 CLI 寫入、測驗歷史整條斷線（bug-audit B4 🔴）。
2. **word 欄位語意不一致**：`exam_history.word` 在 app 端（store.js:1643 db 寫入用 `wordObj.id`）與 CLI 端（cli.mjs:1072 存 `wd.word` **文字**）不一致；且 `db.js:290` 刪字本 `DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck=$1)` 是 **word_id 語意**（join words.id）— CLI 寫文字使該 DELETE 語意失效（孤立殘留）。M4（BUGS.md）：存文字 → 改名後考試歷史孤立。
3. v3 定案三項：① store.js 簽名改 `recordExam({ mode, entries })`＋三頁完成路徑（正常+恢復）補呼叫；② examined_at 補寫（**E2 已修 db.js:493-494，本 bug 不動 db.js**）；③ `word` 欄位語意統一為 word_id（cli.mjs:1072 改 `wd.id`，與 E2 同批）。

## 二、Root Cause

- 測驗三頁（exam-flip / exam-mc / exam-spell）完成時只做 `renderInPlace` 進結果頁，從未呼叫 `recordExam` — 功能寫好但接線斷掉（死碼）。
- CLI 的 exam-run 直接以 `wd.word` 寫入，未對齊 app 端 word_id 語意；讀側 `cmdExam list`（cli.mjs:1003-1005）直接印 `r.word`，兩者互相矛盾。

## 三、修法（檔名:行號）

### 修法 1 — src/lib/store.js recordExam 簽名＋語意（:1637-1652）

```js
/** 將一次考試的結果寫入 exam_history（v3 B4：簽名 { mode, entries }；word 欄位語意統一為 word_id） */
async recordExam({ mode, entries }) {
  const now = new Date().toISOString();
  const ids = new Set(state.words.map(w => w.id));   // v1.1: 循環前快照 — 消除跨 await 讀取（LOW-5 採納）
  for (const r of entries ?? []) {                   // v1.1: entries 非陣列防護（LOW-6 採納）
    if (!r || r.wordId == null || !ids.has(r.wordId)) continue;   // 語意統一：只收 word_id，不驗文字
    try {
      await db.addExamEntry({ word: r.wordId, correct: !!r.correct, questionType: r.questionType || mode || null, examinedAt: now });
      // v1.1: push 移入 try 內 — db 成功才 push（LOW-2/LOW-3 採納）；questionType 用 ||（'' 降級 mode，與 db.js:494 正規化一致）
      state.examHistory.push({
        word: r.wordId,   // B4/M4: 統一 word_id（存文字改名後孤立）
        correct: r.correct ? 1 : 0,
        question_type: r.questionType || mode || null,
        examined_at: now,
      });
    } catch (e) { console.warn('[store] recordExam addExamEntry error:', e); }
  }
  notify();
}
```

要點：
- 簽名 `results` → `{ mode, entries }`；entries 每筆 `{ wordId, correct, questionType? }`（v2 草案的 durationMs 不採 — 三頁無 per-word duration 資料，只有 totalTime）。
- **移除文字 fallback**（舊 `w.id === r.wordId || w.word === r.wordId`）：零呼叫無相容包袱；語意統一即只收 word_id，由 `ids.has` 驗證存在。v1.1 簡化：idSet 驗證後直接存 `r.wordId`（= wordObj.id），不需再 find wordObj。
- `question_type` 語意定為 **mode 字串**（'flip'|'mc'|'spell'）— app 與 CLI（cli.mjs:1072 已存 mode）統一；舊 `r.type || null` 無任何實際資料（零呼叫），無包袱。v1.1：`||` 取代 `??`（空字串降級 mode，與 db.js:494 `|| null` 正規化一致）。
- `examinedAt: now` 保留 E2 的 ISO 寫法（db.js 不動）。
- notify() 保留無條件（與既有行為一致）。

### 修法 2 — 三頁完成路徑補呼叫（正常＋恢復）

**統一 helper（每頁各自一份；helper 為「記錄動作」的唯一入口 — 7 個呼叫點皆轉呼叫 helper；非進入 result 的入口）**：

exam-flip.js（e.results 派生，過濾 undefined/null/'old'）：
```js
async function recordExamResult(s) {
  if (e.phase !== 'result') return;      // v1.1: phase guard（MED-1 採納）— 呼叫點誤放零副作用
  if (e.examRecorded) return;            // B4: 防重（同場只記一次）
  e.examRecorded = true;                 // 同步設旗標（async 前），renderInPlace 不等待
  try {
    const entries = [];
    for (let i = 0; i < e.words.length; i++) {
      const r = e.results && e.results[i];
      if (r !== true && r !== false) continue;   // 未答/舊存檔未知對錯不記錄
      entries.push({ wordId: e.words[i].id, correct: r });
    }
    if (entries.length) await s.actions.recordExam({ mode: 'flip', entries });
  } catch (err) { console.warn('[exam-flip] recordExam error:', err); }   // v1.1: catch 參數改名 err（LOW-4 採納）
}
```

exam-mc.js（同 flip，加 _noScore 過濾 — 與 B3「當未作答不計分」語意一致，損壞題不進歷史）：
```js
const r = e.results && e.results[i];
if (r !== true && r !== false) continue;
if (e.words[i]._noScore) continue;   // B3 損壞題（無 mcData）：不計分也不記錄
entries.push({ wordId: e.words[i].id, correct: r });
// ... mode: 'mc'
```

exam-spell.js（無 e.results — 從 B1 既有 `w._correct` 派生，與 applyTags 同源資料）：
```js
const entries = e.words
  .filter(w => w._correct !== undefined)   // B1 既有 per-word 作答旗標
  .map(w => ({ wordId: w.id, correct: w._correct }));
if (entries.length) await s.actions.recordExam({ mode: 'spell', entries });
```

**呼叫點（進入 result phase 的三個入口，全部補 `recordExamResult(s);` 不 await）**：

> **總則（v1.2 MED-1 修訂 — 必守）**：7 個呼叫點一律**先 `e.phase='result'` 賦值、再呼叫 `recordExamResult(s)`**（不 await，helper 建議放 `renderInPlace` 前 — render 拋錯不致漏記）。helper 的 phase guard 依賴此順序；若照舊字面「賦值前呼叫」→ guard 全擋 → 零記錄（死碼回歸）。

| 頁 | 入口 | 位置 | 改法順序 |
|---|---|---|---|
| flip | nextWord 末題（autoNext timer / 手動下一題共用） | :319-322 | flush（:313 既有）→ `e.phase='result'` → helper → render |
| flip | efNextBtn 手動查看結果 | :418-422 | flush（:419 既有）→ 賦值 → helper → render |
| flip | resumeSession 全部答完直接結果頁（恢復完成） | :268-273 | **不需 flush**（resume 開頭 :233 已重置 pendingScore、exit 前已 flush）→ 賦值 → helper → render |
| mc | nextWord 末題（含 B3 resume armJump 續跳收斂於此） | :322-326 | flush（:319 既有）→ 賦值 → helper → render |
| mc | emNextBtn 手動查看結果 | :413-417 | flush（:414 既有）→ 賦值 → helper → render |
| spell | nextWord 末題（resume 完成路徑必經此） | :280-284 | flush（:276 既有）→ 賦值 → helper → render |
| spell | esNextBtn 手動查看結果 | :373-380 | flush（:377 既有）→ 賦值 → helper → render |

**旗標與欄位初始化**：
- `e.examRecorded = false` 加在三頁的 **startExam 與 resumeSession 開頭**（6 處，皆在 early return 之前）：resume 完成也是一場，記錄一次；exit 不記錄（saveExamSession 存進度）。
- 三頁 e 物件字面量同步加 `examRecorded: false`（v1.1 LOW-3 採納 — 與 pendingScore 同風格明確化）。
- **spell startExam 新增重置循環**（v1.2 LOW-2 措辭修正 — 實錘 spell startExam :207-229 **目前無 for 循環**，需**新增** `for (const w of words) { w._correct = undefined; }`，置 `e.words = words;`（:218）後；對照 mc startExam :215-224 既有 `_options/_answered/_picked/_noScore` 循環。**resumeSession 保留不清** — resume 需舊場 `_correct` 殘留以記錄「整場答過之題」）。

### 修法 3 — tools/cli.mjs:1072 word 欄位改 word_id

```js
w.prepare('INSERT INTO exam_history (word, correct, question_type, examined_at) VALUES (?,?,?,?)').run(wd.id, isCorrect ? 1 : 0, mode, new Date().toISOString());   // B4: wd.word→wd.id（word_id 語意統一；E2 ISO 保留）
```
- :1073 `results.push({ word: wd.word, ... })` 保留文字 — 純 console 顯示用（:1078 印出）。

### 修法 4 — tools/cli.mjs:1003-1005 cmdExam list 讀側 join（消費端相容）

```js
const rows = db.prepare(
  'SELECT h.*, w.word AS word_text FROM exam_history h LEFT JOIN words w ON w.id = h.word ORDER BY h.id DESC LIMIT 30'
).all();
for (const r of rows) console.log(`  ${r.id} ${r.word_text ?? r.word} ${r.correct ? '✓' : '✗'} ${r.question_type} ${r.examinated_at ?? r.examined_at}`);
```
- LEFT JOIN＋`?? r.word` 降級：B4 前 CLI 舊文字資料（word=文字，join 無命中）仍可顯示；B4 後新資料（word=id）join 顯示現名 → **改名不再孤立（M4 修復）**。委員 #3 sqlite 實測四型態（id 命中／文字無命中／孤兒 id／文字撞 id）確認。

## 四、使用點窮舉（憲法第 2 條 — grep 三形態）

| 形態 | 檔案:行 | 動作 |
|---|---|---|
| recordExam 呼叫 | store.js:1638 定義 | 簽名改（修法 1） |
| recordExam 呼叫 | 三頁 ×7 呼叫點 | 補呼叫（修法 2） |
| recordExam 呼叫 | 其餘全 repo | grep=0（死碼確認） |
| exam_history INSERT | cli.mjs:1072 | wd.word→wd.id（修法 3） |
| exam_history INSERT | db.js:493-494 | **E2 已修，不動** |
| exam_history INSERT | _dev/cli/cli.mjs:1061 | 死碼副本（datetime('now') naive 版），不動 |
| exam_history.word 讀取 | cli.mjs:1003-1005 | join 相容（修法 4） |
| exam_history.word 讀取 | store.js:1644-1649 push | r.wordId（修法 1） |
| exam_history.word join | db.js:290 刪字本 | word_id 語意（B4 後正確生效，不動） |
| exam_history 讀側 | db.js:499 **getAllExamHistory**（v1.1 修正函數名） | 原樣；呼叫端 store.js:158/:208（loadAll）載入 state.examHistory、:239 賦值；**無 UI 消費者（grep 實錘）** |
| exam_history DELETE | db.js:577 clearAll、cli.mjs:1011 | 不動 |

**不動檔案**：src/lib/db.js（E2）、src/core/exam-session.js（buildSession 已序列化 results，B1）、src/lib/chart.js（他首相）、src/styles/base.css（他首相）。

## 五、驗證項目（憲法第 4 條 — 附實測）

1. grep `recordExam`：store.js 定義 1＋三頁 helper 各 1＋helper 內呼叫各 1（5 處以上）；無殘留舊簽名呼叫
2. grep `exam_history` 寫入：cli.mjs:1072 為 `wd.id`、db.js:493（E2）；`wd.word` 0 處（exam_history 相關）
3. `node --check` 五檔：store.js、exam-flip.js、exam-mc.js、exam-spell.js、cli.mjs
4. Node 模擬 recordExam（mock state.words/db.addExamEntry）：entries→addExamEntry 參數正確（word=id、correct、questionType=mode、examinedAt ISO 帶 Z）、state.examHistory push word=id、文字傳入被拒（無 fallback）、db 拋錯不 push（v1.1 try 內）
5. 三頁完成路徑模擬：正常完成（autoNext＋手動）、恢復完成（flip 全部答完直接 result／mc B3 armJump 收斂／**spell resume 續答完成（記錄集合＝舊場 _correct 殘留＋新答）**／**flip 舊存檔（無 results）resume 完成（'old' 過濾、僅記新題）** — v1.1 MED-2 補）、防重旗標（同場二次進 result 零重複）、'old' sentinel 過濾、mc _noScore 過濾、exit 不記錄、**helper phase guard（exam 中段誤觸發零副作用）** — v1.1 MED-1 補、**同字本連續兩場（第二場 startExam 重置後可再記錄）**、**resume 完成後再次 resume 同一 session（重複寫入行為實測記錄）** — v1.2 LOW-3 補
6. cli.mjs exam-run 實跑（副本 DB，--answers 固定）：exam_history.word = words.id；`exam list` join 顯示文字；舊文字資料（手動 INSERT 模擬）顯示降級相容
7. 既有工具回歸（我擁有的）：tools/verify-undo-cycle.mjs、tools/verify-next-after-undo.mjs exit=0（store.js 改動不破壞 undo 鏈）
8. vite build（若環境可行）
9. git status：commit 僅含 B4 檔案（chart.js/base.css 他首相未入）

## 六、風險

- **recordExam async 不等待**：結果頁渲染不被 db 寫入阻塞；helper 內 try/catch＋store.js 內 per-entry try/catch — 雙層防護。
- **'old' sentinel 不記錄**：B1 舊存檔（無 results）已答題對錯未知 → 正確降級（不寫假資料）；續答的新題正常記錄。
- **mc _noScore 不記錄**：與 B3「當未作答＋不計分」語意一致。**損壞題重答：標籤會標（applyTags 不看 _noScore，B3 已出貨行為）但歷史不記** — 記錄集合 ⊊ 標籤集合，明示預期（v1.1 LOW-5 補註）。
- **spell 用 `w._correct` 派生**：與 applyTags 同源（B1 既有）— 記錄集合 = 會標籤的集合；resume 後舊場 `_correct` 殘留於共享 word 物件（既有行為），記錄語意 =「整場測驗答過之題」。依賴「進入 result 前必答完」隱含不變量（v1.1：startExam 已重置 `_correct`、resumeSession 保留殘留 — 不變量成立且未來跳題功能不會錯記）。
- **既有 exam_history 資料**：可能混有 CLI 舊寫入的文字 word → join 顯示 NULL → `?? r.word` 降級顯示原文；**文字恰撞 id 格式者誤 join 顯示他字（機率極低：id 為 seed_N/w_<ts> 生成格式，不處理，v1.1 補註）**；不主動遷移（一次性校正 SQL 可選，不在本 bug 範圍）。
- **db.js:290 刪字本**：B4 後新資料 word=id → 刪字本正確連帶刪除；舊文字殘留不刪（資料遷移另案）。
- **三頁 7 個呼叫點**：漏一處即部分路徑斷線 — 驗證項目 5 逐一覆蓋（委員 #2 實錘 7 處 = `phase='result'` 賦值點全量，零遺漏零誤加）。
- **e.examRecorded 旗標**：startExam/resumeSession 6 處遺漏重置 → 同場 resume 再完成不記錄（漏記）— 驗證項目 5 覆蓋。**db 寫入失敗仍設旗標不重試**（helper 同步設旗標先於 await；store 層 per-entry catch 吞錯 → 該場不重試，僅 console.warn 留痕 — v3 雙層 try/catch 刻意取捨，LOW-A 記載）。
- **重複 resume 同一已完成 session**：完成不刪 session（既有 UX）→ 再次 resume 同一場並完成會**重複寫入 exam_history**（同題目再記一筆，examined_at 不同）— 既有行為延伸，明示預期；另案可「完成即刪 session」。
- **LEFT JOIN 效能**：exam_history.word 無 index → 全表掃描後 LIMIT 30；資料量小可接受，index 另案（委員 #3 LOW-3 註記）。

## 七、審查歷程

- v3 定案：⚠️→✅（批次 6，與 E2 合併；E2 已出貨）
- 第 1 輪（v1）：**3/3 ✅ 通過**（無 ❌）
  - #1（store 層）：✅ — 8 LOW 建議：LOW-1 spell startExam 重置 `_correct`（**採納**）、LOW-2 push 移入 try（**採納**）、LOW-3 `|| mode` 取代 `?? mode`（**採納**）、LOW-4 catch 改名 err（**採納**）、LOW-5 idSet 快照（**採納**）、LOW-6 entries ?? []（**採納**）、LOW-7 觀察（記錄）、LOW-8 措辭（**採納**）
  - #2（路徑窮舉）：✅ — MED-1 helper phase guard（**採納**）、MED-2 驗證項目補 2 場景（**採納**）、LOW-1 catch 改名（同 #1 LOW-4）、LOW-2 不需 flush 註記（**採納**）、LOW-3 e 字面量 examRecorded（**採納**）、LOW-4 helper 措辭（**採納**）、LOW-5 標籤/歷史集合差異註記（**採納**）
  - #3（CLI 端）：✅ — MED-1 窮舉表函數名 getAllExamHistory（**採納**）、LOW-1 文字撞 id 誤 join 註記（**採納**）、LOW-2 push 移入 try（同 #1 LOW-2）、LOW-3 index 另案（註記）
  - 全部建議吸收 → v1.1
- 第 2 輪（v1.1）：**3/3 ✅ 通過**
  - #1（store 層複審）：✅ — 建議吸收全部正確（entries ?? []、ids 快照、try 內 push、|| mode、phase guard、catch err、examRecorded 字面量、spell _correct）＋node 模擬 21 項全過；LOW-A db 失敗不重試（記載）
  - #2（路徑時序複審）：✅ — **phase guard × 7 呼叫點時序自洽**（全部可「先賦值後呼叫」；逐點給出精確改法順序）；**MED-1：計畫書表格「（賦值前）」標註字面會全滅 → 採納修訂為「賦值後呼叫」＋總則**；LOW-2 spell startExam 無 for 循環須新增（**採納**）；LOW-3 驗證/風險補「連續兩場」「重複 resume 重複記錄」（**採納**）；LOW-1 helper 統一放 render 前（**採納**）
  - #3（CLI/語意複審）：✅ — 窮舉表函數名 getAllExamHistory 正確、風險補註經 sqlite/原始碼雙重實錘、全文 30+ 行號引用零錯誤；M4 歸因註記（audit 誤植，純註記）
- 第 3 輪：**v1.2 定案 ✅（採納第 2 輪修訂 — MED-1 總則＋表格改法順序、LOW-2 措辭、LOW-3 場景；無 ❌ 不需再送）**

## 八、實作與驗證結果（動工後實測 — 憲法第 4 條）

實作檔（5 code）：store.js（recordExam 新簽名）、exam-flip.js / exam-mc.js / exam-spell.js（helper＋7 呼叫點＋6 重置＋字面量＋spell _correct 重置循環）、cli.mjs（:1072 wd.id＋cmdExam list LEFT JOIN）。db.js / exam-session.js / chart.js / base.css 未動。

| 驗證項目 | 結果 |
|---|---|
| 1. grep recordExam | ✅ store.js:1638 定義＋三頁 helper（flip:316/mc:321/spell:280）＋7 呼叫點（flip:275/341/442、mc:344/437、spell:300/398） |
| 2. grep exam_history 寫入 | ✅ 僅 cli.mjs:1075（wd.id）＋db.js:493（E2）；`wd.word` 於 exam_history 寫入 0 處（:1076 results.push 為 console 顯示保留） |
| 3. node --check 五檔 | ✅ 全過 |
| 4. Node 模擬 recordExam | ✅ 19/19（/tmp/b4-verify-sim.mjs：entries 參數、文字被拒、null/不存在跳過、questionType 優先序＋'' 降級、examinedAt ISO 帶 Z、db 拋錯不 push、entries ?? []、notify） |
| 5. 三頁完成路徑模擬 | ✅ 同檔 19/19 內含：flip undefined/'old' 過濾、防重同場零重複、phase guard 誤觸發零副作用、mc _noScore 不記錄、spell _correct 派生（含舊場殘留）、連續兩場重置後可再記錄 |
| 6. cli.mjs 實跑（副本 DB /tmp/b4-cli-test.db） | ✅ exam-run flip --answers 1,0,1 → exam_history.word=`w_a1/w_b2/w_c3`（=words.id）；`exam list` join 顯示 apple/banana/cherry；混存實測：舊文字 `apple` 降級顯示原文、孤兒 id `w_ghost_xx` 降級顯示 id |
| 7. 既有工具回歸 | ✅ verify-undo-cycle exit=0、verify-next-after-undo exit=0（store.js 改動不破壞 undo 鏈） |
| 8. vite build | ✅ 788ms 成功 |
| 9. commit 隔離 | ✅ 僅 6 檔（5 code＋本計畫書）；chart.js/base.css 他首相未入 |
