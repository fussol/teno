# Teno 修復方案 — 🔴 高嚴重度 22 條（2026-08-13）

> 此文件是「修復方案」，不是修復本身。每條含：改哪個檔、哪個位置、具體怎麼改（code 層級）、風險。
> 審查流程：主 agent 撰寫 → subagent 審查 → 不同意重作 → 反覆。

---

## A1. fsrs.review() 缺 greaterThanLast 約束（early review 266/500 違反）

**位置**：`src/core/fsrs.js:314-323`（review() 的 STATE_REVIEW 分支）+ `src/lib/store.js:614-617` + `src/engine/session-v4.js:339-344`

**問題**：core 的 review() 對 Review 卡 Hard/Good/Easy 直接 `next_interval(stability)`，fuzz 下限固定 1；Anki 要求 interval ≥ scheduledDays+1（greaterThanLast）。補丁散在三處且語意不一致。

**修法**（把約束收進 core，呼叫端移除重複補丁）：
1. `fsrs.js` 的 `review()` 需要知道上次 interval。目前 card 物件有 `scheduledDays`。在 STATE_REVIEW 分支：
   ```js
   // Review 狀態：greaterThanLast（Anki review_複習狀態機.rs）
   const prevIvl = card.scheduledDays ?? 0;
   ...
   // rating >= HARD 時
   let minIvl = Math.max(1, prevIvl + 1);
   // fuzz 時下限用 minIvl 而非 1
   if (this.enableFuzzing && fuzzFactor != null && rawIvl >= 3) {
     const [lower, upper] = constrainedFuzzBounds(rawIvl, minIvl, this.maximumInterval);
     ...
   }
   ```
   - 注意 `constrainedFuzzBounds` 已支援 minimum 參數 — 傳 `max(1, prevIvl+1)` 即可
   - 沒有 fuzz 時（fuzzFactor==null）：`interval = Math.max(minIvl, round(clamp(ivl)))` — 但 Anki 三態語意：raw 縮水時允許縮短 → 這裡只對「raw >= prevIvl」時保證 minIvl，raw < prevIvl 時保持 raw（配合 A3 的語意修正）
2. `store.js:614-617` 移除（core 已處理）
3. `session-v4.js:339-344` 的 computeIntervals 保留 sequential 補丁（那是預覽 4 個 rating 的 hard<good<easy 順序，core 的單一 rating 無法做）但移除 prevIvl 重複補丁

**風險**：改 core 後所有呼叫端（store/session/CLI）行為一致；需跑現有 fsrs-verify 測試確認無 regression。

---

## A2. EASY 畢業間隔缺 min=good+1

**位置**：`src/core/fsrs.js:292-294, 310-313`

**問題**：New/Learning/Relearning 的 EASY 直接 next_interval，Anki 要求 easy ≥ good+1。

**修法**：在 EASY 分支（New 和 Learning/Relearning 兩處）：
```js
} else {  // EASY
  // Anki learning.rs: easy interval >= good + 1
  // 需要先算 GOOD 的 interval 當下限
  const goodMem = step(this.w, delta_t, GOOD, { stability: stability ?? 0, difficulty: difficulty ?? 5 }, nth);
  const goodIvl = next_interval(this.w, goodMem.stability, this.desiredRetention);
  const easyIvl = next_interval(this.w, mem.stability, this.desiredRetention);
  newState = STATE_REVIEW; newStep = 0;
  interval = Math.max(Math.round(easyIvl), Math.round(goodIvl) + 1);
}
```
**風險**：多一次 step 計算（純函數，無副作用）；EASY 畢業間隔會比現在大 1 天以上 — 屬 Anki 對齊的預期改變。

---

## A11. store leech tag 用錯公式

**位置**：`src/lib/store.js:675`

**問題**：`if (rating === AGAIN && result.lapses >= threshold)` — 只在 lapses=8 觸發一次，Anki 在 8/12/16/20 各觸發。

**修法**：
```js
import { isLeech } from '../core/scheduler.js';  // 已存在正確公式
...
if (rating === AGAIN && isLeech(result.lapses, threshold)) {
  // 維持 push tag + saveWord；但每次觸發都要重新標記（Anki 會重複警告）
}
```
- 移除 `!word.tags.includes(leechTag)` 的擋重複？Anki 是「每次觸發都彈警告」— 但 teno 的機制是 tag，重複 push 無意義（Set 語意）。**建議**：維持 includes 保護（tag 只需存在一次），但要改用 isLeech 公式讓觸發時機正確（12/16/20 也進入判斷，若 tag 被使用者移除可重新標上）。同時可加 toast 提示水蛭。

**風險**：低。行為變化：lapses=12 時若 tag 被手動移除會重新標上。

---

## A12. buildQueue state=0 with due 被 new cap 擋

**位置**：`src/engine/session-v4.js:64-67`

**問題**：state=0 且有 due 的卡一律進 newCards（受 newPerDay cap）。Anki 對有 due 的卡放 learning queue。

**修法**（對齊 skill 中已驗證的修法）：
```js
if (card.state === STATE_NEW) {
  if (!card.due) { newCards.push({ word: w, card, type: 'new' }); continue; }
  const dueLocal = toLocalDateStr(new Date(card.due), this.timezoneOffset, this.dayCutoff);
  if (dueLocal === 'Invalid Date' || dueLocal > today) continue;
  learnQueue.push({ word: w, card, type: 'learning' });
  continue;
}
```
- 同時 `scheduler.js:111-113` 的 getDueCards 也要同步（state=0 with due → learnQueue）維持兩邊一致
- 真實 DB 那 9 張異常卡（due 12 天前）會因此被撈進 learning queue → 正常出現

**風險**：行為改變（9 張卡會開始出現）；無資料損壞風險。

---

## B1. exam-flip applyTags 誤標

**位置**：`src/pages/exam-flip.js:273-296`

**問題**：`wc = e.words.slice(0, correct+wrong)` + `i < correct` 位置推斷對錯。

**修法**：逐題記錄對錯。在 `answerCorrect/answerWrong`（或 nextWord）時把結果存到每題：
```js
// answerCorrect(s) 內：
const w = e.words[e.idx];
if (w) w._efCorrect = true;
// answerWrong(s) 內：
const w = e.words[e.idx];
if (w) w._efCorrect = false;
```
applyTags 改：
```js
for (const w of e.words) {
  if (w._efCorrect === undefined) continue;  // 未作答跳過（對齊 exam-spell 的防護）
  const tag = w._efCorrect ? tc : tw;
  ...
  delete w._efCorrect;  // 用完清掉，避免污染 state.words
}
```
**風險**：低。注意 `_efCorrect` 會短暫存在 word 物件上（同 B8 的污染模式），用完刪除。

---

## B2. exam autoNext 延遲窗退出 → 恢復重複計分

**位置**：`exam-flip.js:243-259`、`exam-spell.js:245-266`、`exam-mc.js`（同型）

**問題**：`answerCorrect/answerWrong` 立即 `correct++/wrong++` 但 `idx++` 延後到 setTimeout → 延遲窗內退出存檔 idx 未前進、計分已含該題 → 恢復後同題重答。

**修法**（兩案取一）：
- **方案 A（最小）**：`nextWord` 前先記錄「已計分但未推進」狀態。退出時（`saveExamSession` 前）若 pending timeout 存在，先清掉並把計分回滾：
  ```js
  // 全域記 pending
  let _pendingNext = null;
  // autoNext 分支：_pendingNext = setTimeout(...)
  // exit handler：if (_pendingNext) { clearTimeout(_pendingNext); _pendingNext = null; }
  // 若已在延遲窗（已計分未推進）→ 不存該題計分？需要 e.lastScored 標記
  ```
- **方案 B（較完整）**：計分也延後 — `answerCorrect` 只記「這題答對」，真正 `correct++` 在 `nextWord` 內執行。恢復時 idx 與計分永遠一致。
- **推薦 B**：`answerCorrect/answerWrong` 改為記錄 `e.pendingScore = 'correct'|'wrong'`，`nextWord()` 開頭 `if (e.pendingScore) { e[e.pendingScore === 'correct' ? 'correct' : 'wrong']++; e.pendingScore = null; }`。退出存檔時 pendingScore 不寫入（該題未完成）。
- 同時 B11（退出後 setTimeout 仍執行切到結果頁）一起修：exit handler 清 `_pendingNext`。

**風險**：中 — 動到測驗核心流程，需真機/瀏覽器測全流程（答題/退出/恢復/完成）。

---

## B3. exam-mc 恢復卡死

**位置**：`exam-mc.js:236-249, 155-157, 264-266`

**問題**：恢復時當前題 `_answered=true` 且 autoNext=true → 走已作答分支但 `emNextBtn` 只在 !autoNext 渲染、resumeSession 沒排 setTimeout → 卡死。

**修法**：resumeSession 後若當前題 `_answered`：
```js
// resumeSession 尾端
if (w && w._answered) {
  if (e.settings.autoNext) {
    e.pendingNext = setTimeout(() => nextWord(s), (e.settings.delay || 1.5) * 1000);
  }
}
```
- 同時 renderExam 的已作答分支在 autoNext 時顯示「即將跳下一題…」進度（已有 hint 文案，只是 timer 沒排）
- 若 `_picked === -1`（舊版 session 無 mcData）→ 當作未作答重渲染選項

**風險**：中 — 需測恢復舊 session 情境。

---

## B4. recordExam 死碼 → exam_history 永不寫入

**位置**：`store.js:1603-1619`（recordExam 定義無呼叫）

**修法**：三頁結果頁完成時呼叫：
```js
// exam-flip.js / exam-mc.js / exam-spell.js 的 renderResult 或完成路徑
s.actions.recordExam({ mode: 'flip', words: e.words.slice(0, e.idx + 1), results: [...評分記錄] });
```
- 先修 store.recordExam 本身的欄位不一致：`state.examHistory` push 用 `wordId`、db 寫入用 `wordObj.id` — 統一。`examined_at` 用 ISO 或 datetime('now') 統一。
- 需確認 db.addExamEntry / getAllExamHistory 的 schema 對照（db.js:455-463）
- 暫不接 UI 顯示（dashboard 沒 examHistory 區塊）— 先讓資料有寫入

**風險**：低（純新增呼叫）。需注意測驗完成路徑有「正常完成」跟「恢復完成」兩種。

---

## C1. store 單一 _undoSnapshot 跨模式污染

**位置**：`src/lib/store.js:558`

**問題**：store 層只有一個 `_undoSnapshot`，最後一次評分（不分模式）覆寫。mc session 按 undo 會還原到 flip 的卡、誤刪另一模式 log。

**修法**：快照改 mode 分槽：
```js
state._undoSnapshots = state._undoSnapshots || {};  // { flip: {...}, mc: {...}, spell: {...} }
// rateCard 內：
state._undoSnapshots[mode] = { ...snapshot... };
// undoLastRating 內：
const snap = state._undoSnapshots[mode];
if (!snap) return;
state._undoSnapshots[mode] = null;
```
- 三份 session-utils 的 undoRating 也要各自傳 mode（已有 mode 參數？確認 — session-mc-utils 用 'mc'）— 讓 store.undoLastRating 收到正確 mode
- undo 時 `deleteReviewLogsAfter(snap.logId)` 只刪該模式 log？**不行** — logId 是全域遞增，deleteReviewLogsAfter 會刪所有 id > logId 的 log（跨模式）→ **需改 db.deleteReviewLogsAfter 支援 mode 過濾**：`DELETE FROM review_log WHERE id > ? AND COALESCE(mode,'flip') = ?`

**風險**：中 — undo 三層機制（store/session/UI）都要對齊。需跑 skill 的 teno-store-itest（31 斷言）確認。

---

## C2. flip undo deleteCard 刪整列（mcData 遺失）

**位置**：`store.js:671, 769-774`

**問題**：先 mc 後 flip 評同字（flip 視為新卡 hadBaseCard=false）→ undo → `deleteCard` 把含 mc_data 的整列刪掉。

**修法**：undo flip 分支的 delete 改為「保留 mcData/spellData」：
```js
// undoLastRating 的 flip 分支（hadCard=false 時）
const base = state.cards.get(wordId);
const mcData = state.cardsMc.get(wordId);
const spellData = state.cardsSpell.get(wordId);
if (mcData || spellData) {
  const restore = {
    due: new Date().toISOString(), stability: 0, difficulty: 5,
    elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0,
    step: 0, lastReview: null, buried: false, suspended: false, interval: 0,
    mcData: mcData || undefined, spellData: spellData || undefined,
  };
  await db.saveCard(wordId, restore);
} else {
  await db.deleteCard(wordId);
}
```
- 注意：rateCard 的 `hadBaseCard` 判斷也要看 DB 是否真有列（目前只看 `state.cards.has` — 記憶體可能漏）→ 改用快照的 `hadBaseCard`（快照已有 `hadBaseCard` 欄位）

**風險**：中 — 需測三模式交叉 undo 情境（skill 有 undo-snapshot-test 可跑）。

---

## D1. import.js related/forms round-trip 破壞

**位置**：`src/core/import.js:196-197`（mapWords 的 related/forms 解析）

**問題**：匯出 JSON.stringify 陣列 → 匯入 `split(',')` 拆成垃圾。

**修法**：related/forms 比照 tags/examples 的 JSON.parse try/catch：
```js
function parseList(val) {
  if (val == null || val === '') return [];
  const t = String(val).trim();
  try { const p = JSON.parse(t); if (Array.isArray(p)) return p; } catch {}
  return t.split(',').map(x => x.trim()).filter(Boolean);
}
// mapWords 內：
related: parseList(row.related),
forms: parseList(row.forms),
tags: parseList(row.tags),
examples: parseList(row.examples),
```
- 同時 buildCSV（匯出）對所有陣列欄統一 JSON.stringify（現況 tags/examples 已有，related/forms 也走同一路徑 — 確認）

**風險**：低。需測 round-trip：`["desert","forsake"]` → 匯出 → 匯入 → 原陣列。

---

## D2. restore/download 後無 closeDB()

**位置**：`settings.js:540-550`（restoreBackup）、`settings.js:904-911`（driveDownload）

**問題**：import 流程有 closeDB()+closeAppLog()，restore/download 沒有 → plugin-sql 舊連線殘留。

**修法**：restore/download 的 swap 前後比照 runImportDb：
```js
// 呼叫 Rust restore_backup / drive_download 之後、location.reload() 之前：
const { closeDB, closeAppLog } = await import('../lib/db.js');  // 確認 export 名稱
closeDB();
closeAppLog();
```
- db.js 是否有 closeDB？Rust 端有 `close` command（plugin-sql）— 確認 JS 端有沒有包（api.js 或 db.js）
- 沒有就新增：`export async function closeDB() { try { await db.close(); } catch {} db = null; }`
- reload 前關閉 → 舊連線無法 checkpoint 寫入新檔

**風險**：低-中。reload 後 db.js 的 init 會重建連線（確認 initDB 冪等）。

---

## D3. drive_upload 無 WAL checkpoint

**位置**：`src-tauri/src/drive_sync.rs:265-272`

**問題**：`fs::read(teno.db)` 直接讀主檔，WAL 未合併時缺最近資料。

**修法**（Rust 端 upload 前 checkpoint）：
```rust
// 用 rusqlite 開唯讀連線執行 wal_checkpoint(TRUNCATE)
use rusqlite::Connection;
fn checkpoint_db(path: &Path) {
    if let Ok(conn) = Connection::open(path) {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
}
```
- 在 read 前呼叫；失敗不阻擋（best-effort）
- 或對齊 backup-scheduler.js 的方式：JS 端 upload 前先呼叫 db checkpoint（plugin-sql 有 checkpoint？確認）— **JS 端較簡單**：settings.js 的 drive upload 前加 `checkpoint()`

**風險**：低。需注意 checkpoint 會把 WAL 併入主檔（正常 SQLite 行為）。

---

## D9. OAuth 無限迴圈無 timeout

**位置**：`drive_sync.rs:235-238`

**問題**：`loop { sleep(100ms) }` 永遠等 code；error 參數/關瀏覽器不退出。

**修法**：加 timeout + error 處理：
```rust
let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180); // 3 分鐘
loop {
    if let Some(code) = received_code.lock().unwrap().take() { ... return Ok(...); }
    if let Some(err) = received_error.lock().unwrap().take() { return Err(err); }
    if deadline.elapsed() > Duration::from_secs(180) { return Err("OAuth 逾時（3 分鐘）".into()); }
    tokio::time::sleep(Duration::from_millis(100)).await;
}
```
- listener thread 收到 `error` query param 或 `/` 非 code 請求 → 寫入 error channel 並回應網頁「授權失敗，可關閉此頁」
- UI 端（settings.js:897-900）finally 確保解除「處理中」狀態（現在 finally 已存在，只要 Rust 回傳 error 就會到）

**風險**：低。

---

## E1. app devMode 執行的是舊版 _dev/cli/cli.mjs

**位置**：`src-tauri/src/lib.rs:97-121`（resolve_cli_path fallback）+ `_dev/cli/cli.mjs`

**問題**：dev 環境 fallback 到 `~/teno/_dev/cli/cli.mjs`（舊版，optimize 用自寫 JS optimizer，違反官方政策、三模式共用權重）。

**修法**（兩案）：
- **方案 A（推薦）**：`_dev/cli/cli.mjs` 直接同步成 `tools/cli.mjs`（差 97 行；使用者偏好 tools/ 為正式）：
  ```bash
  cp tools/cli.mjs _dev/cli/cli.mjs
  ```
  但要改 import 路徑（`_dev/cli/` 是 `../../src/`，tools/ 是 `../src/`）。**注意**：兩份 import 路徑不同（cli.mjs 用相對 import），不能直接 cp — 需 diff 後手動同步 optimize 段落（把 _dev 版的 `fsrs-optimizer.js optimizeWeights` 換成官方 `fsrs-optimize.py` spawn 段落 + per-mode 迴圈）。
- **方案 B**：改 Rust fallback 優先指向 `~/teno/tools/cli.mjs`（使用者正式版），_dev 留著當隔離。
- **推薦 A**（讓兩份一致，符合「權重優化一律官方」政策）— 同步後 `diff -q` 只剩 import 路徑差異。

**風險**：低（改 dev 工具）。

---

## E2. CLI fix 系列 datetime('now') 無 Z

**位置**：`tools/cli.mjs:1319, 1327, 1344`

**問題**：`due=datetime('now')` 存 `'YYYY-MM-DD HH:MM:SS'`（無 Z）→ app `new Date()` 當本地時間 → 提前一天。

**修法**：改用 ISO 帶 Z 格式（跟 app 一致）：
```js
// 取代 datetime('now')
const isoNow = new Date().toISOString();
w.prepare(`UPDATE cards SET ..., due=? ...`).run(isoNow);
```
- 全部 fix 子指令（reset-card/graduate/rewind/reset-stray）統一
- 注意 CLI 其他路徑若有 `datetime('now')` 也要一起查（grep 全檔）

**風險**：低。改完可用 `node cli.mjs fix rewind <id>` 實測 due 格式。

---

## E3. CLI 硬編碼 dayCutoff=360（實際 480）

**位置**：`tools/cli.mjs:26-32` 等（ANKI.dayCutoff 硬編碼）

**問題**：CLI 的 today/localDue 用 360，DB 是 480 → 06:00-08:00 到期卡判定不同天。

**修法**：啟動時從 DB 讀設定（已有讀 settings 的地方）：
```js
// cli.mjs 初始化處（connectDb 之後）
const row = db.prepare("SELECT value FROM settings WHERE key='dayCutoff'").get();
if (row && row.value != null) ANKI.dayCutoff = Number(row.value);
const tzRow = db.prepare("SELECT value FROM settings WHERE key='timezoneOffset'").get();
if (tzRow && tzRow.value != null) ANKI.timezoneOffset = Number(tzRow.value);
```
- 若 DB 無該 key（全新 DB）→ 保留預設 360/480？**建議預設改 480**（跟現行 DB 一致）或讀不到就 fallback 到 app 的預設
- cmdDash 內混用兩套 cutoff 的也要統一走 ANKI 物件

**風險**：低。實測 `node cli.mjs due` 對 06:00-08:00 到期卡。

---

## F1. Android back close() 無效

**位置**：`src/main.js:425-433` + `src-tauri/gen/android/.../MainActivity.kt:17-39`

**問題**：無上一頁時 `getCurrentWindow().close()` — wry Android 沒實作 close（只移除 Rust 端 webview 不 finish Activity）→ back 被吞。

**修法**：MainActivity 的 fallback 直接 finish：
```kotlin
// MainActivity.kt OnBackPressedCallback
private fun fallbackExit() {
  isEnabled = false
  this@MainActivity.onBackPressed()   // 現有
  // 或直接 finishAndRemoveTask()
}
```
- **重點**：JS 端 `__handleAndroidBack` 的 close() 改為通知原生層退出：
  ```js
  // main.js — 用 invoke 或 evaluate 讓原生 finish
  // 方案：MainActivity 在 evaluateJavascript 的結果判斷 — 但 async 無法同步拿
  // 更簡單：JS 端呼叫 window.__tauriAndroidFinish?.()（由 MainActivity 注入）或
  // 直接讓 MainActivity 的 callback fallback：先 evaluateJavascript 檢查
  // "__handleAndroidBack 存在?"，回 true 就呼叫它；但 JS 內部 close 無效 → 
  // 改：JS 的 __handleAndroidBack 在 goBack() 失敗時 evaluateJavascript 回傳
  // 特殊值 "__FINISH__"，MainActivity 收到後 finish()。
  ```
- **具體實作（推薦）**：
  1. MainActivity callback：`evaluateJavascript("window.__handleAndroidBack ? window.__handleAndroidBack() : '__NO_HANDLER__'") { res -> if (res == '"__NO_HANDLER__"') finish() }`
  2. JS `__handleAndroidBack`：`if (store.actions.goBack()) return; window.__finishApp?.();` — 其中 `__finishApp` 由 MainActivity 注入（`webView.addJavascriptInterface` 或 evaluate 定義）— 但 Tauri 不建議 JS bridge…
  3. **最簡單可靠**：JS 端不 close，改為 invoke 一個新 Rust command `exit_app`（`std::process::exit(0)` 或透過 activity finish — Rust 端拿 activity 需要 plugin）— **替代**：MainActivity 加一個 `@Command fun finishApp()` 在 IconPlugin 或獨立 plugin，JS invoke 它 → Kotlin `activity.finishAndRemoveTask()`。
- **推薦**：新增 Kotlin command `finish_app`（掛在現有 plugin），JS 端 `getCurrentWindow().close()` 換成 `invoke('finish_app')`。

**風險**：中 — 需真機測 back 流程（root 頁 back 退出、子頁 back 返回、快速連按）。

---

## F2. TTS stop/onDone 事件遮蔽、promise 誤 resolve

**位置**：`TtsPlugin.kt:162-171, 270-302` + `src/lib/tts.js:41-54, 63-74`

**問題**：stop 與 onDone/onError 都 emit `tts://speech:done`、payload 空、JS 無 utteranceId 追蹤 → 連發 speak 舊 promise 被誤 resolve。

**修法**：
1. **Kotlin**：onDone/onError/stop 的 emit 帶 `text`（該 utterance 的原文）：
   ```kotlin
   // onDone: emit("tts://speech:done", mapOf("text" to text))
   // onError: emit("tts://speech:error", mapOf("text" to text))
   // stop(): emit("tts://speech:stopped", mapOf("text" to text))
   ```
2. **JS**：track 目前播放的 text：
   ```js
   let _currentText = null;
   let _speechResolve = null;
   function speakAndroidTts(text, ...) {
     stopAndroid();  // 先停舊的
     _currentText = text;
     return new Promise((resolve, reject) => {
       _speechResolve = { text, resolve, reject };
       const t = setTimeout(() => { if (_speechResolve?.text === text) { _speechResolve = null; resolve(); } }, 30000);
       // 事件處理：done → if (_speechResolve?.text === text) resolve
       // stopped → 若 _speechResolve?.text === text 且是「主動 stop」→ 不 resolve（或 resolve）
     });
   }
   ```
3. `_speechResolve` 單槽 → 改多槽或帶 text 比對（最簡單：只比 text，因為連發時舊 promise 已被新 speak 的 stopAndroid 取消 — 確認 Kotlin stop 後 done 不再 emit）

**風險**：中 — 需真機連續發音測試。

---

## F3. TtsPlugin onPause/onStop 空 → 背景繼續唸

**位置**：`TtsPlugin.kt:376-390`

**修法**：
```kotlin
override fun onPause() {
  // 背景化 → 停止發音 + 釋放 audio focus（避免背景繼續唸）
  try { tts?.stop(); } catch (_: Exception) {}
  tts?.abandonAudioFocus(null)
  // 不 emit done？或 emit stopped（JS 可標記 paused）
}
override fun onResume() {
  // 不自動 resume（避免背景被打斷後回來突然講話）
  // 重新 requestAudioFocus 讓下次 speak 正常
  requestAudioFocus()
}
```
- `onStop` 也 override（TauriActivity 有 onStop lifecycle）→ 同 onPause

**風險**：低-中。需真機測「播放中按 Home → 停止」「回 app → 不自動 resume」。

---

## F8. fetch_get 只准 HTTPS，LLM 預設 http 全壞

**位置**：`src-tauri/src/lib.rs:320-321`

**問題**：`fetch_get` 檢查 `!url.starts_with("https://")` 拒絕，但呼叫端預設 `http://localhost:11434`。

**修法**：
```rust
// 允許 localhost / 127.0.0.1 的 http（Ollama 預設）
if !(url.starts_with("https://") 
    || url.starts_with("http://localhost")
    || url.starts_with("http://127.0.0.1")) {
    return Err("僅允許 HTTPS 或 localhost 連線".into());
}
```
- 或由 JS 端傳 allowHttp flag（呼叫端控制）
- 建議：白名單 `localhost` / `127.0.0.1` 的 http，其餘一律 https

**風險**：低。實測 fetchGet('http://localhost:11434/api/tags') 通過。

---

## G1. theme.js --accent-on 白字不可讀

**位置**：`src/lib/theme.js:189` + `base.css:1398`

**問題**：深色模式 accent 亮度 78-92% 時 --accent-on 仍 #fff → 對比 1.16:1。

**修法**：--accent-on 依 accent 亮度動態決定：
```js
// theme.js generateAccentVars：算 accent 的相對亮度（YIQ 或 WCAG 對比）
// 當 accent L > ~65%（或對比 < 3:1）→ 用深色文字 #160e2b（base.css 原本的值）
// 否則白字
const useDark = luminance(accent) > 0.45;  // 或 relativeLuminance > 0.35
`--accent-on: ${useDark ? '#160e2b' : '#ffffff'};`
```
- 實作 luminance：`0.299*r + 0.587*g + 0.114*b`（YIQ）即可
- 同時修正 base.css:1398 `.btn-primary` 若 gradient 也參考 accent 亮度調整

**風險**：低。node 實算對比 > 4.5:1 驗證。

---

## 其餘 🔴（B11 併入 B2；F2/F3 已列）

審查重點：以上 22 條方案是否（1）技術正確（2）覆蓋問題根因（3）有副作用/遺漏（4）有更簡潔做法。不同意就標明原因 + 重作方案。
