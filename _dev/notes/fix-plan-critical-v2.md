# Teno 修復方案 v2 — 🔴 高嚴重度 22 條（三審查員修正版）

> v1 經 3 位審查員（技術正確性 / Anki 對齊 / 副作用）逐條驗證後修正。
> 每條標註 ✅（已定案）或 ⚠️（有已知限制）。未修改任何 code。

---

## A. 學習核心

### A1. greaterThanLast — ✅ 修正版（三態語意）

**審查結論**：v1 的「無條件 max」和「raw<prevIvl 保持 raw」都偏離 Anki。Anki `fuzz.rs minimum_review_fuzz_interval` 是**三態**：
```rust
if rounded > previous_interval { previous_interval + 1 }  // 增長
else if previous_interval <= upper { previous_interval }  // 持平 → 下限 prevIvl（非 +1）
else { 0 }                                                 // 縮水超 fuzz range → 允許縮短
```
且 good/easy 下限是**鏈式用 fuzz 後的前一 rating + 1**。

**最終修法**（收進 `fsrs.js`，新增 helper）：
```js
// fsrs.js — Anki fuzz.rs minimum_review_fuzz_interval 三態
function minReviewFuzzInterval(raw, prevIvl) {
  const rounded = Math.round(raw);
  if (rounded > prevIvl) return prevIvl + 1;
  // 需要 upper：由 constrainedFuzzBounds(rounded, 1, max) 取得
  const [, upper] = constrainedFuzzBounds(rounded, 1, this.maximumInterval);
  if (prevIvl <= upper) return prevIvl;
  return 0;
}
```
- `review()` 的 Review 分支：`hard: minIvl = max(1, minReviewFuzzInterval(hardRaw, prevIvl))`、`good: minIvl = max(hardFuzzed + 1, minReviewFuzzInterval(goodRaw, prevIvl))`、`easy: minIvl = max(goodFuzzed + 1, ...)` — 依 rating 鏈式，前一 rating 用 **fuzz 後**值
- 全部經 `constrainedFuzzBounds(raw, minIvl, maxIvl)` 帶入 fuzz
- **移除** store.js:614-617 與 session-v4.js:339-344 的補丁（core 已做）；computeIntervals 的 4-rating 預覽邏輯自然由 review() 提供
- ⚠️ core 改動影響 CLI/模擬器/fsrs-verify 預期值 → 改完跑 `fsrs-verify.mjs` + 用官方 fsrs-rs 6.6.1 對照
- **與 A3 綁定**（A3 的「只增不減」語意由本三態取代）

### A2. EASY ≥ good+1 — ✅ 修正版（fuzz 順序）

**審查結論**：位置正確（New/Learning/Relearning 三處同一邏輯），但 good 要先 fuzz 才當下限、easy 要在 [good+1, max] 內 fuzz。

**最終修法**：
```js
// EASY 分支（三處共用 helper）
function easyGraduateInterval(fsrs, state, delta_t, nth, fuzzFactor) {
  const goodMem = step(fsrs.w, delta_t, GOOD, state, nth);
  const goodIvl = next_interval(fsrs.w, goodMem.stability, fsrs.desiredRetention);
  const goodFuzzed = fsrs.enableFuzzing && fuzzFactor != null
    ? withReviewFuzz(fuzzFactor, Math.round(clamp(goodIvl, 1, fsrs.maximumInterval)), 1, fsrs.maximumInterval)
    : Math.round(clamp(goodIvl, 1, fsrs.maximumInterval));
  const easyIvl = next_interval(fsrs.w, mem.stability, fsrs.desiredRetention);
  const min = goodFuzzed + 1;
  return fsrs.enableFuzzing && fuzzFactor != null
    ? withReviewFuzz(fuzzFactor, Math.round(clamp(easyIvl, min, fsrs.maximumInterval)), min, fsrs.maximumInterval)
    : Math.round(clamp(easyIvl, min, fsrs.maximumInterval));
}
```
- ⚠️ 多步 learning（預設 1,10）時 GOOD 未畢業 → goodIvl 用「連按 GOOD 走完剩餘 steps」的畢業 interval（模擬 step 迴圈），非單次 step
- 畢業後掉進 review() 尾部 fuzz 區塊時，該區塊下限也要用 min（避免 fuzz 跌破 good+1）— 用 `constrainedFuzzBounds(raw, min, max)` 取代寫死的 1

### A11. leech 公式 — ✅ 定案（v1 即正確）

- `store.js:675` 改 `isLeech(result.lapses, threshold)`（import 從 scheduler.js，或放 requireScheduler 解構避免破壞載入模式）
- 保留 `includes` 保護（= Anki Set 冪等語意：12/16/20 命中時若 tag 被移除會重標）
- 補充（完整對齊選項）：card 上同步記 `leeched` 旗標（Anki ReviewState.leeched）— 可後續加

### A12. state=0 with due — ⚠️ 改為資料修復策略（非 Anki 特判）

**審查結論**：Anki 分類看 **queue** 欄位不看 state；queue=0（new）完全不看 due。方案的特判是 corrupt-data 修復，不是 Anki 行為。

**最終修法**（兩步）：
1. **一次性資料修復**（CLI 或 migration）：那 9 張 `state=0 AND due IS NOT NULL` 的卡 → 補回合理 state（視資料：無 last_review → 維持 0 但清 due；有學習痕跡 → 補 state=1 + scheduledDays）— 先列清單給使用者確認，**不自動刪**
2. buildQueue/getDueCards **回歸純 state 路由**（不做永續特判）：state=0 → new（受 cap），維持現況 + 修好資料後不再有異常卡
- ⚠️ 需與使用者確認 9 張卡怎麼處理（清 due / 補 state / 保留當 new）

---

## B. 測驗

### B1. exam-flip applyTags — ✅ 改平行陣列（零污染）

**審查結論**：`_efCorrect` 污染 word 物件；改平行陣列更簡且無殘留問題。

**最終修法**：
```js
// startExam 時：e.results = new Array(words.length).fill(undefined)
// answerCorrect: e.results[e.idx] = true
// answerWrong:   e.results[e.idx] = false
// applyTags:
for (let i = 0; i < e.words.length; i++) {
  const w = e.words[i];
  if (e.results[i] === undefined) continue;  // 未作答跳過（對齊 spell 防護）
  const tag = e.results[i] ? tc : tw;
  ...
}
```
- 天然處理退出/恢復（results 隨 e.words 存檔恢復）

### B2. autoNext 延遲窗 — ✅ 修正版（三頁機制分開 + 雙清 timer）

**審查結論**：spell 是 submitSpelling 立即計分（機制不同）；startExam 也必須清 timer。

**最終修法**：
- 三頁統一：`e.pendingScore`（'correct'|'wrong'|null）+ `nextWord()` 開頭 flush（`if (e.pendingScore) { e[e.pendingScore]==='correct'?'correct':'wrong']++; e.pendingScore = null; }`）
- **spell**：submitSpelling 內計分也改走 pendingScore（不要立即累加）
- **雙清 timer**：`exit handler` 與 `startExam` 都 `clearTimeout(e.pendingNext)`；pendingScore 不寫入 saved session
- 手動下一題（efNextBtn/emNextBtn）與最後一題 → result 轉換**都走 nextWord** 以 flush
- B11（退出後 setTimeout 切到 result）由 exit handler 清 timer 一併解決

### B3. exam-mc 恢復卡死 — ✅ 修正版（加計分校正）

**審查結論**：`_picked === -1` 重渲染會 double count（session.correct/wrong 已含）。

**最終修法**：
- resumeSession 尾端：`if (w && w._answered) { if (autoNext) e.pendingNext = setTimeout(() => nextWord(s), delay*1000); }`
- `_picked === -1`（舊 session）→ 當未作答重渲染**且校正計分**：從 mcData/作答記錄重建該題計分（或扣回），避免重答後 double count
- timer 在 `renderInPlace(s)` **之前**排入（resumeSession 尾端）

### B4. recordExam 死碼 — ✅ 修正版（簽名寫死 + revlog 語意）

**審查結論**：v1 snippet 簽名與現有 `recordExam(results)` 不符；Anki 無 quiz 歷史，最接近是 revlog。

**最終修法**：
- **簽名**：改 `recordExam({ mode, entries })`（entries 陣列，每筆 `{ wordId, correct, durationMs }`）— 或維持陣列簽名，二選一寫死並更新呼叫端
- **欄位語意**：`exam_history` 仿 revlog：`examined_at` 改 ms 時間戳（`Date.now()`，不依賴 DB default datetime('now')）→ 避免 ISO 帶 Z 與無 Z 混排；`word` 欄位語意統一為 word_id（**CLI cli.mjs:1061 一併改**，目前 CLI 寫 word 文字、db.js:259 刪除用 id）
- 三頁結果頁完成路徑呼叫（正常完成 + 恢復完成都呼叫，防重：id 或 (wordId, examined_at) unique）

---

## C. undo

### C1. 快照分槽 — ✅ 修正版（session-utils 不需改）

**審查結論**：session-utils 的 undoRating **不需傳 mode**（mode 在快照內 `snap.mode`）；全域計數快照語意要保留。

**最終修法**：
- `state._undoSnapshots = { flip: null, mc: null, spell: null }`；rateCard 寫 `[mode]`、undoLastRating 讀 `[snap.mode]`
- `db.deleteReviewLogsAfter(id, mode)` 加 mode 過濾（`AND COALESCE(mode,'flip') = ?`）；memory 端 pop 也要 mode 過濾（不能全域 pop — 避免跨模式 memory/DB 分歧）
- ⚠️ `newRatedToday*/goalStreakBefore` 維持「評分前全域值」語意（勿改 mode 局部）
- 跑 teno-store-itest（31 斷言）+ 三模式交叉 undo 手測

### C2. flip undo 誤刪 mcData — ✅ 修正版（根因在快照捕獲）

**審查結論**：store.js:769-774 **已有** restore 分支；真正根因是 rateCard 快照 `prevBaseCardMcData: mode !== 'flip' && ...` — flip 評分時快照永遠不捕獲 mcData/spellData。

**最終修法**：
- `store.js:566-567` 快照去掉 `mode !== 'flip'` 條件 → 任何模式都捕獲 `state.cardsMc.get(wordId)` / `state.cardsSpell.get(wordId)`（現有 769-774 分支即生效）
- **廢棄** v1 的「改用快照 hadBaseCard」建議（hadBaseCard 也是記憶體判斷，解決不了問題）
- 補充：undo 的 delete 分支前 `SELECT EXISTS` 查 DB（防 saveCard 失敗造成的記憶體/DB 分歧）
- ⚠️ restore 卡（state=0 + due=now）與 A12 交互：修復後會突然進 queue — 屬預期，changelog 註明
- 跑 undo-snapshot-test

---

## D. 匯入/備份/同步

### D1. related/forms round-trip — ✅ 修正版（examples 排除）

**審查結論**：parseList 套 examples 會壞（examples 是 `;` 分割的 {en,zh} 物件）。

**最終修法**：
- `parseList` 只套 **related/forms/tags**（JSON.parse try → 失敗才 split(','))
- **examples 保留現有 special-case**（`;` 分割 → {en,zh}）

### D2. restore/download 無 closeDB — ✅ 修正版（順序反轉）

**審查結論**：**closeDB 已存在**（db.js:28）；且 restore 是 `fs::copy` in-place 覆蓋 — close 若在 restore 後會把舊 WAL 髒頁寫進新檔。

**最終修法**：
- **順序：先 `closeDB()` + `closeAppLog()` → 再 invoke `restore_backup` / `drive_download` → 再 reload**
- `restore_backup`（lib.rs:1328-1348）改 tmp+rename（對齊 drive_download）— 避免 in-place 覆蓋 open inode
- import_db_dialog 路徑一併檢查（現有「先 import 後 close」同隱患）
- close 後 reload 前的 1.5s 窗口遮蔽 UI（disable 按鈕）

### D3. drive_upload checkpoint — ✅ 定案（JS 端）

- settings.js driveUpload 前 `await checkpoint()`（db.js:56 已存在；backup-scheduler 先例）
- checkpoint 加 busy_timeout 處理 SQLITE_BUSY；文件註明 best-effort（checkpoint 後到 read 間的新寫入仍可能缺 — 根本解是 sqlite backup API，列為後續）

### D9. OAuth timeout — ✅ 修正版（tokio feature）

**審查結論**：tokio 只有 `["rt","sync"]` 無 `time` → `tokio::time::sleep` compile 失敗。

**最終修法**：
- **方案 (b) 優先**：維持 blocking loop（本函數本質 blocking），用 `std::sync::mpsc::recv_timeout(100ms)` + `Instant` deadline（180s）取代輪詢 sleep — 零依賴
- listener thread 處理 `error` query param → error channel；timeout/error 時關 listener（避免 port 殘留）
- UI finally 確保解除「處理中」

---

## E. CLI

### E1. dev 版 CLI 舊版 — ✅ 採方案 B

**審查結論**：採方案 B（改 fallback 路徑一行）最簡、一勞永逸。

**最終修法**：
- `lib.rs:97-121` dev fallback 改為 `~/teno/tools/cli.mjs`（一行）；_dev/cli/cli.mjs 變死碼（日後刪除）
- 同步時 optimize 會寫 DB → 先備份權重；兩份副本 drift 問題由方案 B 根除
- 改完驗證：`node tools/cli.mjs optimize` 走官方 fsrs-optimize.py

### E2. CLI fix datetime('now') — ✅ 定案 + 既有資料校正

- 4 處（1319 reset-card / 1324-1327 graduate / 1344 reset-stray）改 `new Date().toISOString()`（graduate 用 `new Date(Date.now()+86400000).toISOString()`）
- **加一次性校正指令**：既有被 CLI 修過、due 無 Z 的卡補 Z（避免 DB 混合格式）

### E3. CLI dayCutoff 硬編碼 — ✅ 修正版（key 位置 + lazy today）

**審查結論**：timezoneOffset **不在 settings 頂層**（在 ankiSettings JSON blob）；top-level `today` 是 module 載入時算的（stale）；app 預設 dayCutoff=0（非 480）。

**最終修法**：
- dayCutoff 讀 settings 頂層 key；timezoneOffset 解析 `ankiSettings` JSON（fallback 480 或系統本地 — 對齊 app「null=系統本地」）
- **top-level `today` 改 lazy**（`const dayToday = () => getToday(...)`），所有使用點改呼叫
- 讀不到 → fallback **app 預設 0**（非 480）
- cmdStats/cmdDash 內混用的獨立 `tzOff/dayCutoff` 統一走 ANKI 物件

---

## F. Rust / Android / TTS

### F1. Android back close() 無效 — ✅ 修正版（三層齊備）

**審查結論**：根因經原始碼實錘（tauri-runtime-wry WebviewMessage::Close 只移除 webview、不 finish）；AnkiDroid 行為 = 子頁返回/root 退出（符合）。

**最終修法**（三層）：
1. **Kotlin**：`@Command fun finishApp() { activity?.finishAndRemoveTask() }`（掛現有 plugin 或新 plugin）
2. **Rust**：`#[tauri::command] fn finish_app(app) { run_mobile_plugin(app, "finishApp", ...) }`（比照 icon_android.rs 模式）+ 註冊 invoke_handler
3. **JS**：`main.js` 的 `__handleAndroidBack` fallback 改 `invoke('finish_app')` 取代 `getCurrentWindow().close()`
- 防重：MainActivity 加 `isFinishing` 檢查（快速連按 back）
- 真機測：root back 退出、子頁 back 返回、快速連按

### F2. TTS 事件遮蔽 — ✅ 修正版（utteranceId 方案）

**審查結論**：Kotlin 已有 utteranceId（UUID）；polling fallback 的 emit 也要帶 id；stop 需獨立事件；同 text 連發無法用 text 區分。

**最終修法**：
- **Kotlin**：所有 done/error emit 帶 `utteranceId`（onDone 有 id、stop 記當前 id、polling fallback 記 id、tts-null 記 id）；新增獨立 `tts://speech:stopped`（主動 stop 用）；stop 前設 `stopRequested` flag 防 Android onError/onDone 雙重 emit
- **JS**：`_speechResolve = { utteranceId, resolve, reject, timer }`；listen 比對 utteranceId；stopped → 視為 cancelled 不 resolve 完成（或 resolve cancelled 語意）；30s timeout 只清自己的 id
- ⚠️ **JS/Kotlin 同版本部署**（舊 JS 不聽新事件 → 卡 30s）
- 真機連續發音測試

### F3. TtsPlugin onPause/onStop — ✅ 修正版（先驗證介面 + focus 簽名）

**審查結論**：onStop 是否在 TauriPlugin 介面**未驗證**；`abandonAudioFocus(null)` 簽名錯（本 codebase 是無參 wrapper）；F2×F3 交互（背景 stop 誤觸發推進）。

**最終修法**：
- 先 grep TauriPlugin Kotlin 基底確認 onStop 存在；不存在 → 只用 onPause/onResume/onDestroy 組合
- onPause：`tts?.stop()` + `abandonAudioFocus()`（無參）+ `stopPolling()` + emit `tts://speech:stopped`（獨立事件，JS 標記 paused **不推進**）
- onResume：不自動 resume；重新 `requestAudioFocus()`
- ⚠️ 背景 stop 用 stopped 事件 → JS 不 resolve 為「完成」→ 不自動推進下一卡

### F8. fetch_get HTTPS — ✅ 修正版（URL.hostname 白名單）

**審查結論**：`starts_with("http://localhost")` 可被 `http://localhost.evil.com` 繞過。

**最終修法**（lib.rs:321）：
```rust
// 解析 URL，白名單 hostname
let host = url::Url::parse(&url).map_err(|_| "URL 無效".to_string())?.host_str().unwrap_or("").to_string();
let is_local = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
if !(url.starts_with("https://") || (url.starts_with("http://") && is_local)) {
    return Err("僅允許 HTTPS 或 localhost 連線".to_string());
}
```
- 需確認 Cargo.toml 有 url crate（無則用簡單 hostname 解析或加依賴）

### F9-F19（中低）— 待 🟠/🟡 批次處理

---

## G. UI / 主題

### G1. --accent-on 白字 — ✅ 修正版（hexToRgb luminance）

**審查結論**：審查員建議用實際 accent hex → RGB → luminance 決定深/淺字（HSL lightness 跨色相不保證 WCAG 對比）；v2 先前改用 aL 被複審駁回。

**最終修法**（theme.js，`generateAccentVars` 內）：
```js
// 新增 helper（theme.js 內，無外部依賴）
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;  // YIQ 近似，0~1
}
// generateAccentVars 內，用實際 accent hex（ACCENTS[accentName]）：
const accentHex = /* 目前 accent 的 hex（applyTheme 已有） */;
'--accent-on': luminance(accentHex) > 0.45 ? '#160e2b' : '#ffffff',
```
- 取代 v1 的 intensity 三元與 v2 的 aL 閾值；涵蓋 intensity<0.3 分支（低 intensity → 低亮度 → 白字，語意一致）
- btn-primary 共用 `--accent-on` 自動修正，不需另改
- ⚠️ --accent-dim/--accent-deep 若配深字對比差 → 按情境分開（實測後決定）
- **驗證**：node 對 20 顆 accent preset 實算對比 ≥ 4.5:1（深字/白字分別）

---

## 三審查員共識總結

- **技術正確性**：13 同意 / 7 需重作（A2, B4, C2, D9, E3, F2, F3）→ v2 全部重作
- **Anki 對齊**：A1 三態語意（v1 錯）、A2 fuzz 順序（v1 偏）、A12 queue 語意（改資料修復）、B4 revlog 語意 → v2 全部修正
- **副作用**：D2 順序反轉（高優先）、C1/C2/F2 中高、A12 需使用者確認 → v2 全部補緩解
- **新增發現**：closeDB 已存在（D2 簡化）、tokio 缺 time（D9）、store.js 已有 restore 分支（C2 根因不同）、exam_history word 欄位 CLI/JS 語意混亂（B4）、polling fallback emit 無 id（F2）
