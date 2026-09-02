# Teno 剩餘 12 bug 三組分配方案（v1）— 技術官僚產出

> 日期：2026-08-14 ｜ 基準：HEAD=02618a5（E2 已修）＋工作樹未 commit：`src/lib/chart.js`、`src/styles/base.css`（**任何首相不准碰**）
> 剩餘 12 bug：F2, F3（可實作）；A1, A2, B2, B3, B4, C1, C2, D9, F1, F8（修正後可實作）
> 每組 4 bugs × 3 組。組間零重疊無法完全達成（見 §4 串行點），已依 v3 依賴圖標明必須串行的 2 個檔案觸碰點。

---

## §0 檔案指紋總表（grep 實證）

| Bug | 會動到的檔案 | 實證位置 |
|---|---|---|
| F2 | `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`、`src/lib/tts.js` | TtsPlugin.kt:126（utteranceId 為 speak() local，未提升為欄位）、tts.js:22-48（_speechResolve 無 utteranceId 比對、無 reason 語意） |
| F3 | `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt` | :376-378 `onPause() {}` / `onResume() {}` 空實作（abandonAudioFocus/stopPolling 均已存在可呼叫） |
| A1 | `src/core/fsrs.js`、`src/engine/session-v4.js`、`src/lib/store.js` | store.js:611-614 補丁仍在、session-v4.js:339-344 補丁仍在、store.js:1423 runMatureSimulation（第 3 份補丁）、fsrs.js（新增 module 級 minReviewFuzzInterval） |
| A2 | `src/core/fsrs.js`、`src/engine/session-v4.js` | fsrs.js:32 next_interval、session-v4.js review() 尾部 fuzz block（唯一 fuzz 點） |
| C1 | `src/lib/store.js`、`src/engine/session-utils.js`、`src/engine/session-mc-utils.js`、`src/engine/session-spell-utils.js`、`tools/verify-undo-cycle.mjs` | store.js:555-571 單一 _undoSnapshot（需改 _undoSnapshots[mode]）、session-utils 三份（undoLastRating(mode) 傳參＋計數器各存各 mode）、verify-undo-cycle.mjs（mode 寫死 flip，需擴充） |
| C2 | `src/lib/store.js` | :565-566 快照 `mode !== 'flip'` guard 仍在、:727 undo `if (mode !== 'flip')` guard 仍在、:737-744 restore 分支存在但 flip 走不到 |
| B2 | `src/pages/exam-flip.js`、`src/pages/exam-mc.js`、`src/pages/exam-spell.js` | 三頁均無 pendingScore；exam-flip.js:223/250-252/260-264（B1 已建 e.results 平行陣列＋'old' sentinel，B2 建立其上）；buildSession 已序列化 results（exam-session.js:61，B1 完成） |
| B3 | `src/pages/exam-mc.js` | resumeSession 尾端（renderInPlace 前）缺 pendingNext；_picked===-1 未作答分支 |
| B4 | `src/lib/store.js`、`src/pages/exam-flip.js`、`src/pages/exam-mc.js`、`src/pages/exam-spell.js`、`tools/cli.mjs` | store.js:1583 recordExam(results) 存在但全專案零呼叫（需改 {mode,entries} 簽名＋三頁完成路徑補呼叫）；cli.mjs:1072 INSERT 的 word 仍存 wd.word（需改 wd.id）；**db.js:462 examined_at 已被 E2 補好 → B4 不需動 db.js** |
| D9 | `src-tauri/src/drive_sync.rs`、`src-tauri/Cargo.toml` | drive_sync.rs:235-238 `loop { sleep(100ms) }` 無限迴圈無 timeout；Cargo.toml:30 tokio features=["rt","sync"] 缺 "time" |
| F1 | `src-tauri/src/lib.rs`、`src-tauri/gen/android/app/src/main/java/com/teno/app/MainActivity.kt`、`src/main.js` | main.js:425-433 __handleAndroidBack 用 getCurrentWindow().close()（Android 無效）；MainActivity.kt:34-38 fallbackExit 無 isFinishing 防重；lib.rs 需加 finish_app command＋invoke_handler 註冊 |
| F8 | `src-tauri/src/lib.rs`、`src-tauri/Cargo.toml` | lib.rs:318-331 fetch_get 硬擋 http＋用 curl；Cargo.toml 無 `url` dep（ureq 已在 :31，零成本） |

---

## §1 組一「學習核心（FSRS＋undo）」

**Bugs（4，依 v3 順序）**：A1 → A2（批次 3，唯一 fuzz 點）→ C1 → C2（批次 4，同一段 store.js 快照/undo）

**檔案清單（7）**：
- `src/core/fsrs.js`
- `src/engine/session-v4.js`
- `src/lib/store.js`（⚠️ 跨組串行點，見 §4）
- `src/engine/session-utils.js`
- `src/engine/session-mc-utils.js`
- `src/engine/session-spell-utils.js`
- `tools/verify-undo-cycle.mjs`

**執行順序建議**：A1（先建 module 級 minReviewFuzzInterval＋constrainedFuzzBounds 傳 raw；刪 store.js:611-614、session-v4.js:339-344、runMatureSimulation 三處補丁）→ A2（easyRaw/goodRaw 回 raw＋easyMem 補定義＋多步 learning 畢業 interval）→ 跑 500 案例 audit 對照 Anki（🔬 驗證）→ C1（_undoSnapshots[mode] 選槽＋計數器語意定死＋verify-undo-cycle.mjs 擴充交叉測試）→ C2（去快照/undo 兩處 mode guard＋SELECT EXISTS 防分歧）。C1/C2 同段 code，首相需一次理解再動手。

**風險註記**：
1. `store.js` 已被已修 commit A11/A12/E2 改過 — A12 的「undo 對調防假進度」與 C1/C2 同區段，**務必先讀懂 A12 的 undo 對調邏輯再重構快照**，不得回退 A12 成果。
2. C2 restore 卡（state=0＋due=now）與已修 A12 交互：會突然進 queue — changelog 註明（v3 已要求）。
3. A1 語意陷阱：傳 raw 非 rounded（Anki fuzz.rs 也傳 raw）；前一 rating 用 fuzz 後值做鏈式下限。
4. 組內 C1 的 DB DELETE 語句（`DELETE FROM review_log WHERE id > ? AND COALESCE(mode,'flip') = ?`）與 C2 的 SELECT EXISTS 都只在 store.js 內，不碰 db.js。

---

## §2 組二「測驗資料鏈＋Drive OAuth」

**Bugs（4，依 v3 順序）**：B2 → B3（批次 5，共用 e.results/pendingScore 設計）→ B4（批次 6）→ D9（批次 7）

**檔案清單（7）**：
- `src/pages/exam-flip.js`
- `src/pages/exam-mc.js`
- `src/pages/exam-spell.js`
- `src/lib/store.js`（⚠️ 跨組串行點，見 §4）
- `tools/cli.mjs`
- `src-tauri/src/drive_sync.rs`
- `src-tauri/Cargo.toml`（⚠️ 跨組串行點，見 §4）

**執行順序建議**：B2（三頁 answer 端改 pendingScore＋nextWord flush＋雙清 timer）→ B3（exam-mc resumeSession 尾端 pendingNext；_picked===-1 當未作答不計分）→ 跑 audit 的 exam 模擬（🔬 11 題 > 10 單字、卡死重現）→ B4（store.js recordExam 改 {mode,entries}＋三頁完成路徑補呼叫＋cli.mjs:1072 word→wd.id）→ D9（OAuth 加 tokio::time::timeout(180s) 或 mpsc recv_timeout＋spawn_blocking 包 blocking loop＋error query param＋關 listener）。

**風險註記**：
1. **B4 的 store.js 改動必須等組一 A1/C1/C2 的 store.js 提交合併後才能動**（同檔串行，§4）。B4 首相可先做三頁呼叫與 cli.mjs 部分，最後才碰 store.js。
2. `cli.mjs` 已被已修 commit E2/E3 大改 — :1072 與 E2 的 examined_at ISO 是同一個 INSERT 行，**只改 word 參數（wd.word→wd.id），保留 E2 的 ISO 時間戳寫法**；全檔以 HEAD 版本為基準。
3. `exam-flip.js` 已被已修 commit B1 重寫（results/old sentinel/lockstep resume/頁 guard）— B2/B3 必須建立在 B1 新架構上，勿回退；B1 的「最後一題延遲窗退出直接結果頁」與 B2 的「最後一題 nextWord flush」要對齊（v3:245 已指明）。
4. D9 的 Cargo.toml 那行（tokio 加 "time"）與組三 F8 的 `url = "2"` 同檔 — 一先一後（§4），**組二若先合併，組三 F8 首相需 rebase**。
5. D9 修法注意：tokio time feature 已被 sqlx 傳遞啟用（compile 不會失敗），真正問題是 async fn 內 blocking sleep 卡 runtime worker — 驗證時要看行為修復（關瀏覽器後按鈕不再永久卡「處理中」），不是看編譯過不過。

---

## §3 組三「Android TTS＋退出＋fetch」

**Bugs（4，依 v3 順序）**：F2 ↔ F3（批次 2，**先定事件契約**）→ F1 → F8（批次 7）

**檔案清單（6）**：
- `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`
- `src/lib/tts.js`
- `src-tauri/src/lib.rs`
- `src-tauri/gen/android/app/src/main/java/com/teno/app/MainActivity.kt`
- `src/main.js`
- `src-tauri/Cargo.toml`（⚠️ 跨組串行點，見 §4）

**執行順序建議**：先定契約（`tts://speech:done`=finish / `error`=error / `stopped(user)`=resolve cancelled / `stopped(pause)`=標記 paused 不推進）→ F2（Kotlin utteranceId 提升欄位＋所有 emit 帶 id+reason＋stop() 改 emit stopped(user)＋stopRequested flag＋id→text 表；JS `_speechResolve={utteranceId,...}`＋listen 比對＋30s timeout 只清自己 id）→ F3（onPause/onStop：tts?.stop()＋abandonAudioFocus()＋stopPolling()＋emit stopped(pause)；onResume 只重新 requestAudioFocus）→ **JS/Kotlin 同版本部署測試**（F2 硬性要求）→ F1（Kotlin @Command finishApp 收 Invoke＋MainActivity isFinishing 防重＋Rust finish_app＋invoke_handler＋main.js 改 invoke('finish_app')）→ F8（lib.rs fetch_get 改 URL.hostname 白名單：localhost/127.0.0.1/[::1] 允許 http，其餘 https-only＋換 ureq＋Cargo.toml 加 url="2"）。

**風險註記**：
1. F2/F3 同在 TtsPlugin.kt — 同組內依序做，無跨組問題；但 F2 的 JS 端（tts.js）與 F3 的 Kotlin 端必須「同版本部署」，組內自測要含 Android 真機。
2. F1 的 Kotlin `@Command` 必須收 `Invoke` 參數（#1/#4 實錘 PluginHandle 反射單參數）— 可參考 IconPlugin.kt 既有 @Command 寫法；lib.rs 的 finish_app 需註冊進 invoke_handler 且走 run_mobile_plugin 模式。
3. `lib.rs` 已被已修 commit D2/E1/E2 改過（restore_backup、dev CLI fallback、DEFAULT 硬化）— F1/F8 動的是不同區段（fetch_get:318-331、run()/invoke_handler:1432+、mobile plugin:1648-1650），但都在同檔，組內依序進行即可。
4. F8 換 ureq 後 Android 不再依賴 curl（fetch_llm 已先例）；Cargo.toml 的 url="2" 與組二 D9 的 tokio "time" 同檔串行（§4）。
5. **本組完全不碰 `src/styles/base.css` 與 `src/lib/chart.js`**（G1 已修、chart.js 無關）— 維持禁令。

---

## §4 跨組串行點（零重疊無法達成的兩個檔案）

結構性事實：`store.js` 同時被 A1/C1/C2（組一）與 B4（組二）觸碰；`Cargo.toml` 同時被 D9（組二）與 F8（組三）觸碰。在「3 組 × 每組 ≤4」的硬限制下（12 bugs 恰好 4/4/4），這兩個檔案必然跨組 — **必須串行**：

| 檔案 | 串行順序 | 理由 |
|---|---|---|
| `src/lib/store.js` | 組一（A1→C1→C2）**先** → 組二 B4 **後** | v3 依賴圖：批次 3/4 < 批次 6；B4 的 recordExam 簽名改動不依賴組一，但同檔不可並行。建議組一 store.js 拆 2 個 commit（A1 補丁刪除、C1/C2 undo 重構）讓 B4 首相可早點 merge 主分支 |
| `src-tauri/Cargo.toml` | 組二 D9 **先** → 組三 F8 **後**（或反向，一先一後即可） | v3 批次 7 內 D9 列於 F8 前。兩行都是 dependencies 區小改，後者 rebase 即可 |

其餘所有檔案皆組內獨佔，無其他跨組交集。

---

## §5 與已修 commit（A11/A12/D1/D2/D3/D4/E1/E3/G1/B1/E2）的衝突檢查

| 已修 commit 動過的檔 | 本次會再動的 bug | 判定 |
|---|---|---|
| `src/lib/store.js`（A11/A12/E2） | A1, C1, C2, B4 | ⚠️ 不同區段，但 C1/C2 與 A12 的 undo 對調同區 — **必須保留 A12 成果**；B4 與 E2 的 recordExam examinedAt 同函數 — 保留 ISO 寫法 |
| `tools/cli.mjs`（E2/E3） | B4 | ⚠️ :1072 與 E2 的 examined_at 同行 — 只改 word 參數 |
| `src-tauri/src/lib.rs`（D2/E1/E2） | F1, F8 | ⚠️ 不同區段，無直接重疊 |
| `src-tauri/src/drive_sync.rs`（D4） | D9 | ⚠️ D4 在 download 區（:296-303）、D9 在 OAuth 區（:155-238），無重疊 |
| `src/pages/exam-flip.js`（B1） | B2, B3, B4 | ⚠️ B1 剛重寫 results/resume 架構 — B2/B3/B4 必須以其為基準，勿回退 |
| `src/core/exam-session.js`（B1） | —（B2 序列化已被 B1 完成，本輪不需動） | ✅ 零衝突 |
| `src/lib/db.js`（A12/D3/E2） | —（B4 的 examined_at 已被 E2 補上，**本輪不需動 db.js**） | ✅ 零衝突 |
| `src/styles/base.css`（G1） | —（本輪 12 bug 均不碰） | ✅ 禁令維持：任何首相不准碰 base.css / chart.js |
| `src/core/import.js`、`src/pages/settings.js`、`src/pages/dashboard.js`、`src/pages/app-log.js`、`src/pages/browser.js`、`src/pages/deck-browser.js`、`src/lib/theme.js` | — | ✅ 零交集 |

---

## §6 總結：可並行 vs 必須串行

**可完全並行（零檔案交集，三線同時開工）**：
- 組一全員（A1, A2, C1, C2）↔ 組三全員（F2, F3, F1, F8）：JS 學習核心 vs Android 原生，零交集。
- 組二的前段（B2, B3）↔ 組一、組三：exam 三頁與任何他組檔案零交集。
- 組二的 D9 ↔ 組一的全部、組三的 F1/F2/F3：drive_sync.rs 與他組零交集。
- F2 與 F3 組內同批（TtsPlugin.kt 同檔）；F1 與 F8 組內同檔 lib.rs — 均為組內順序問題，不影響跨組並行。

**必須串行（跨組，依 v3 依賴圖順序）**：
1. **store.js**：組一（A1 → C1 → C2）先 → 組二 B4 後（批次 3/4 < 6）。B4 首相先做三頁呼叫與 cli.mjs，等組一 store.js 合併後再動 store.js。
2. **Cargo.toml**：組二 D9 先 → 組三 F8 後（批次 7 內 D9 在前；後者 rebase 一行即可）。

**實際排程建議（波次）**：
- 波次 1（三組同時開工）：組一 A1→A2→C1→C2；組三 F2↔F3→F1→F8；組二 B2→B3→（B4 非 store.js 部分）→D9。
- 波次 2：組二 B4 的 store.js 段（等組一合併）＋組三 F8 的 Cargo.toml 行（等組二 D9 合併，或反向）。
- 收尾驗證：組一跑 500 案例 audit 對照 Anki＋verify-undo-cycle 交叉測試；組二跑 exam 模擬（重複計分/卡死重現）；組三 Android 真機（TTS 事件、back 退出、Ollama http 探測）。
