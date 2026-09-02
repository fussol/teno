# Teno 修復方案 v3 — 🔴 高嚴重度 22 條（4 名獨立委員最終裁決版）

> 歷程：v1（主 agent）→ 3 審查員 → v2 → 複審 → **4 名獨立委員**（#1 Rust/Kotlin、#2 JS、#3 Anki/資料、#4 交叉裁決）。
> 裁決：✅12 可實作 / ⚠️7 小修後可實作 / ❌1 重作（C2）/ ⚠️1 需先定語意（C1）。
> 未修改任何 code。

---

## 執行順序（依賴圖）

```text
批次 1（獨立，無前置）：A11, A12, D1, D2, D3, E1, E3, G1
批次 2（事件契約先定）：F2 ↔ F3（同批，定義 stopped 事件 reason 欄位）
批次 3（core fuzz 唯一點）：A1 → A2（同批，定義唯一 fuzz 點在 review() 尾部 block）
批次 4（undo 同段 code）：C1 → C2（同批，同一段 store.js 快照/undo）
批次 5（測驗三頁同批）：B1 → B2 → B3（共用 e.results/pendingScore 設計）
批次 6（共用 cli.mjs:1061）：B4 + E2（合併提交）
批次 7：D9, F1, F8
```

---

## ✅ 批次 1（獨立可實作）

### A11. leech 公式
- `store.js:674-676`：`rating === AGAIN && isLeech(result.lapses, threshold)`（isLeech 在 scheduler.js:165，從 requireScheduler 解構；保留 includes 冪等保護）
- 裁決：✅（4/4 委員無異議）

### A12. state=0 with due → 資料修復
- **實查 9 張全是容器卡**（mc_data 有真實 MC 學習痕跡 stability 7.3-9.5、無 last_review、due 2026-08-01）
- 修法：一次性 CLI/migration — **清 due 優先**（容器卡不該有 due）；補 state=1 只在確認要合併 mcData 進 flip 時做。**列清單給使用者確認，不自動刪**
- buildQueue/getDueCards 維持純 state 路由（現況已是，零 code 變更）
- 裁決：✅（#3 實查確認）

### D1. related/forms round-trip
- `src/core/import.js:196-197`：`parseList`（JSON.parse try → 失敗才 split(',')）只套 **related/forms/tags**；examples 保留 `;` → {en,zh} special-case
- 裁決：✅（無跨條依賴）

### D2. restore/download 順序反轉
- **順序：先 `closeDB()`（db.js:28 已存在）+ `closeAppLog()`（app-log.js:36）→ invoke restore_backup / drive_download → reload**
- `restore_backup`（lib.rs:1328）改 tmp+rename，**保留 WAL/SHM 刪除**（rename 後 sidecar 殘留會誤 recovery）
- restoreBackup handler 補 `btn.disabled=true`（現況沒有）
- 裁決：✅（#1/#4 實錘）

### D3. drive_upload checkpoint
- settings.js driveUpload 前 `await checkpoint()`（db.js:56）；補 busy_timeout（plugin-sql 無設定）
- 裁決：✅

### E1. dev CLI 舊版
- `lib.rs:97-121` fallback 改 `~/teno/tools/cli.mjs`（一行）；_dev copy 變死碼
- 裁決：✅

### E3. CLI dayCutoff
- dayCutoff 讀 settings 頂層 key；timezoneOffset 從 ankiSettings JSON blob 解析（fallback 系統本地，對齊 app「null=系統本地」）；**top-level today 改 lazy**（`const dayToday = () => getToday(...)`）；fallback 用 app 預設 **0**（非 480）；cmdStats/cmdDash 混用統一走 ANKI 物件
- 裁決：✅（#3 實錘所有宣稱）

### G1. accent-on 對比
- `generateAccentVars` 加第 6 參數 `accentHex`（applyTheme:210 已有 ACCENTS[accentName]）；hexToRgb + YIQ luminance；`luminance > 0.45 → '#160e2b' : '#ffffff'`
- 裁決：✅（#2 要求加參數 — 已採納）

---

## ✅ 批次 2（F2 ↔ F3 同批 — 先定事件契約）

### 事件契約（先定）
- Kotlin emit 統一帶 **utteranceId + reason**：`tts://speech:done`（reason=finish）、`tts://speech:error`（reason=error）、`tts://speech:stopped`（reason=**user**｜**pause**）
- JS 語意：done→resolve 完成；error→reject；stopped(user)→resolve cancelled（不推進）；stopped(pause)→標記 paused（**不 resolve 完成、不推進**）

### F2. TTS 事件遮蔽
- Kotlin：utteranceId 提升為欄位（現為 speak() local）；所有 emit 帶 id+reason；stop() 改 emit stopped(user)（不再 emit done）；`stopRequested` flag 防 Android onError/onDone 雙重 emit；id→text 對應表
- JS：`_speechResolve = { utteranceId, resolve, reject, timer }`；listen 比對 utteranceId；30s timeout 只清自己的 id
- ⚠️ JS/Kotlin 同版本部署
- 裁決：✅（#1/#2/#4 一致；utteranceId 優於 text 比對）

### F3. onPause/onStop
- **onStop 存在已實錘**（tauri Plugin.kt 基底 `open fun onStop()`，TauriActivity 會呼叫）— 直接用
- onPause/onStop：`tts?.stop()` + `abandonAudioFocus()`（無參 wrapper）+ `stopPolling()` + emit stopped(**pause**)
- onResume：不自動 resume；重新 requestAudioFocus()
- 裁決：✅（#1/#4 實錘）

---

## ✅ 批次 3（A1 → A2 同批 — 唯一 fuzz 點）

### 唯一 fuzz 點定義
**fuzz 只在 review() 尾部 block 執行一次**；A1/A2 的 helper 全部回 **raw interval**，min 透過 `constrainedFuzzBounds(raw, minIvl, maxIvl)` 帶入尾部 block。⚠️ 傳 **raw** 非 rounded（#3 nit，Anki fuzz.rs 也傳 raw）。

### A1. greaterThanLast 三態（含鏈式下限）
- `minReviewFuzzInterval(raw, prevIvl)`：module 級函數（**不依賴 this**，參數傳 maxIvl）：
  ```js
  function minReviewFuzzInterval(raw, prevIvl, maxIvl) {
    const rounded = Math.round(raw);
    if (rounded > prevIvl) return prevIvl + 1;
    const [, upper] = constrainedFuzzBounds(raw, 1, maxIvl);
    if (prevIvl <= upper) return prevIvl;
    return 0;
  }
  ```
- Review 分支依 rating 分岔：hard min = `max(1, minRFI(hardRaw, prevIvl))`；good min = `max(hardFuzzed+1, minRFI(goodRaw, prevIvl))`；easy min = `max(goodFuzzed+1, ...)`（前一 rating 用 **fuzz 後**值）
- **移除補丁清單（3 處）**：store.js:614-617、session-v4.js:339-344、**store.js:1509-1517（runMatureSimulation — #2/#4 抓到的第 3 份）**
- 對照目標 = **Anki rslib fuzz.rs + review.rs**（不是 fsrs-rs crate — #4 實錘 fsrs-rs 的 next_states 沒有 fuzz）
- 刪除 v2 殘留的「與 A3 綁定」引用（v2 無 A3 條目 — 語意已併入三態）
- 裁決：⚠️→✅（修正後）

### A2. EASY ≥ good+1
- helper 回 **raw**（不自己 fuzz）：`easyRaw = next_interval(easyStability)`、`goodRaw = next_interval(goodStability)`；`min = round(goodRaw)+1`；easy 尾部落入尾部 block 以 `constrainedFuzzBounds(easyRaw, min, maxIvl)` fuzz
- **mem 定義補上**（v2 snippet 漏）：easyMem = step(w, delta_t, EASY, state, nth)
- 多步 learning：goodRaw 用「連按 GOOD 走完剩餘 steps」的畢業 interval（5-10 行 step 迴圈）
- 裁決：⚠️→✅（修正後）

---

## ⚠️ 批次 4（C1 → C2 同批 — 同一段 code）

### C1. undo 快照 — 語意定死
- **選槽規則**：`undoLastRating(mode)` 帶 mode 參數（三個 session-utils 各傳自己的 mode）；`state._undoSnapshots[mode]`
- **計數器語意**（#2/#4 指出 v2 矛盾 → 定死）：每 slot **只存/只還原自己 mode 的計數器**（flip slot 存 newRatedToday、mc 存 newRatedTodayMc、spell 存 newRatedTodaySpell）；goalStreak 只還原 `dates[mode]` 子陣列 + 重算 current/best
- log 刪除：DB `DELETE FROM review_log WHERE id > ? AND COALESCE(mode,'flip') = ?`（mode 欄位 NOT NULL DEFAULT 'flip'，#3 確認 COALESCE 安全）；memory pop 改「從尾端移除 mode 相符 entry 至該模式 baseline」
- **驗證工具**：teno-store-itest 不存在 → 改用 tools/verify-undo-cycle.mjs（但其 mode 寫死 flip，需擴充或新增交叉 undo 測試）
- 裁決：⚠️（語意定死後可實作）

### C2. flip undo 誤刪 mcData — ❌ 重作
- **#4 實錘 v2 錯誤**：restore 分支（store.js:756-762）包在 `if (mode !== 'flip')`（:733）內，flip undo 走不到；v2 稱「769-774 分支即生效」是錯的（769-774 是 delete 區）
- **修法（兩處同時）**：
  1. 快照（:566-567）：去掉 `mode !== 'flip'` 條件 — 任何模式都捕獲 `state.cardsMc.get(wordId)` / `state.cardsSpell.get(wordId)`
  2. undo 端（:733）：放寬 mode guard — flip undo 在 `!hadCard && prevBaseCardMcData/SpellData` 時也走 restore 分支（建 restore 物件，不 deleteCard）
- 補充：undo delete 前 `SELECT EXISTS` 查 DB（防 saveCard 失敗的 memory/DB 分歧）
- ⚠️ restore 卡（state=0 + due=now）與 A12 交互：會突然進 queue — changelog 註明
- 裁決：❌→✅（重作後）

---

## ✅ 批次 5（B1 → B2 → B3 同批 — 共用設計）

### B1. exam-flip applyTags 平行陣列
- `e.results = new Array(words.length).fill(undefined)`；answerCorrect/Wrong 設 `e.results[e.idx]`
- applyTags：`e.results[i] === undefined → skip`；true→tc / false→tw
- **buildSession 明確序列化 results**（v2 說「隨 e.words 存檔」不成立 — e.words 沒序列化；需把 results 加進 session 物件 + resumeSession 還原）
- 裁決：✅（+buildSession 補強）

### B2. autoNext 延遲窗
- `e.pendingScore`（'correct'|'wrong'|null）；**flush 語法**：`if (e.pendingScore) { e[e.pendingScore]++; e.pendingScore = null; }`（v2 語法錯，修正）
- 三頁：flip answerCorrect/Wrong、mc pickOption、spell **submitSpelling（:245）** 都改 pendingScore；最後一題走 nextWord flush（spell 目前直接 setTimeout→result）
- 雙清 timer：exit handler + startExam 都 clearTimeout
- ⚠️ 延遲窗退出：pendingScore 不落 session → 該題計分遺失但 B1 results 已記答案 → 建議 exit 前 flush 或結果頁計數由 results 派生
- 裁決：⚠️→✅（語法修正後）

### B3. exam-mc 恢復卡死
- resumeSession 尾端（renderInPlace **前**）：`if (w?._answered && autoNext) e.pendingNext = setTimeout(...)`
- `_picked === -1`（無 mcData）：**當未作答重渲染 + 不計分**（v2 的「重建或扣回」定死為「不計分」；且 applyTags 因 results[i]===undefined skip → 不會錯標 wrong — #4 抓到的額外 bug）
- 裁決：⚠️→✅

---

## ✅ 批次 6（B4 + E2 合併 — 共用 cli.mjs:1061）

### B4. recordExam 死碼
- store.js:1604 簽名改 `recordExam({ mode, entries })`；三頁完成路徑（正常+恢復）補呼叫
- db.js:456 INSERT **補 examined_at**（現漏寫，靠 DEFAULT datetime('now') 無 Z — #3/#4 發現）
- examined_at 語意仿 revlog = **ms 時間戳**（Date.now()）
- `word` 欄位語意統一為 word_id（CLI cli.mjs:1061 改 `wd.id` — 與 E2 同批）
- 裁決：⚠️→✅（與 E2 合併）

### E2. CLI fix datetime('now')
- 4 處改 ISO 帶 Z：reset-card（:1319）、graduate（:1323 `Date.now()+86400000`）、rewind（:1327）、reset-stray（:1344）
- 一次性校正：`UPDATE cards SET due = replace(replace(due,' ','T'), ...) WHERE due NOT LIKE '%Z' AND due LIKE '____-__-__ __:__:__'`（只命中 CLI 寫的資料，安全 — #3 確認）
- 裁決：✅（與 B4 合併）

---

## ✅ 批次 7（D9、F1、F8）

### D9. OAuth timeout
- **理由修正**（#1/#4 實錘）：tokio `time` feature 已被 sqlx 統一啟用（lib.rs:313 已用 tokio::time::timeout 出貨）→ compile 不會失敗；真正問題是 async fn 內 `std::thread::sleep(100ms)` busy-wait 卡 runtime worker
- 修法：Cargo.toml 加 `tokio features=["time"]`（顯式宣告）+ `tokio::time::timeout(180s, ...)` 或 mpsc recv_timeout；建議 spawn_blocking 包 blocking loop
- listener 收 error query param → error channel；timeout/error 關 listener（dummy-connect 喚醒 accept）
- 裁決：⚠️→✅（理由修正）

### F1. Android back
- 三層：Kotlin `@Command fun finishApp(invoke: Invoke) { activity?.finishAndRemoveTask(); invoke.resolve() }`（**必須收 Invoke — #1/#4 實錘 PluginHandle 反射單參數**）+ Rust `#[tauri::command] fn finish_app`（run_mobile_plugin 模式）+ invoke_handler 註冊 + JS `invoke('finish_app')` 取代 close()
- MainActivity 加 isFinishing 防重
- 裁決：⚠️→✅（簽名修正）

### F8. fetch_get HTTPS
- lib.rs:321：URL.hostname 白名單（localhost/127.0.0.1/[::1] 的 http 允許，其餘 https-only）
- **一併換 ureq**（#4：Android 無 curl，fetch_llm 已改 ureq，fetch_get 是同問題 — F8 是修復既有功能不是硬化）
- Cargo.toml 加 `url = "2"`（已在 Cargo.lock 為傳遞依賴，零成本）
- 裁決：⚠️→✅（+ureq）

---

## 最終狀態

| 狀態 | 條目 |
|---|---|
| ✅ 可實作（12） | A11, A12, B1, D1, D2, D3, E1, E2, E3, F2, F3, G1 |
| ✅ 修正後可實作（9） | A1, A2, B2, B3, B4, C1, C2, D9, F1, F8 |
| ❌ 重作後通過 | C2（v2 論證錯誤 → v3 重作） |

**22/22 全部定案**。執行順序見上方依賴圖。全程未修改任何 code。
