# Bug Tracker — Teno v05.01.00.0010

來源：使用者 32 項清單 + 4 項新發現（經源碼逐行驗證，排除 7 項非 bug）

---

## 嚴重 (6)

| ID | 檔案 | 行 | 問題 |
|----|------|----|------|
| C1 | core/fsrs.js | 279-280 | `STATE_NEW + AGAIN` → `againDelay(actualLearnSteps)`，若 `actualLearnSteps` 空陣列則 `interval = undefined` → `dueDays = NaN` |
| C5 | lib/db.js | 241-248 | `deleteWordsByDeck` 只刪 cards+words，未刪 review_log / exam_history → 孤兒記錄累積 |
| C6 | src-tauri/lib.rs | 158-168 | `write_db_bytes` 在 SQLite 活躍連線下直接 `fs::write` 覆寫 db 檔（但 JS 端應先 closeDB），若 WAL 殘留 → 資料損毀 |
| B1 | lib/store.js | 493-496 | MC/Spell undo 快照 `prevBaseCardMcData` 取 `baseCardForSnapshot?.mcData`（上上次評分狀態）非當前 cardMap → 多次 MC 評分後 undo 還原到錯誤版本 |
| H7 | lib/store.js | 569-593 | `hadBaseCard = state.cards.has(wordId)` 在第 571 行 `cardMap.set()` 之後才讀取 → 永遠為 `true`，導致快照時 `hadBaseCard` 誤判 |
| H8 | lib/store.js | 777-782 | `updateGoalStreak(data)` 直接 `{ ...state.goalStreak, ...data }`，若 `data.dates = null` → `JSON.stringify(null)` → DB 存 `null` → `getGoalStreak` 解析 crash |

## 高 (10)

| ID | 檔案 | 行 | 問題 |
|----|------|----|------|
| H2 | core/scheduler.js | 265-282 | `computeBestStreak` 內部 `const prev = new Date(parts[0], parts[1]-1, parts[2]-1)` 未用 `toLocalDateStr` → 換日前後偏移一天 |
| H3 | core/scheduler.js | 290-301 | `countTodayReviews` 對個別 `reviewed_at` 未套用 `dayCutoff` 比較 |
| H14 | lib/tts.js | 49-57 | 原生 TTS 失敗後設 `_hasNative = null`（應設 `false`），下次呼叫 `_hasNative !== false` 仍為 `true` 再試一次，若再失敗設 `null` 造成無限重試 |
| H15 | src/main.js | 326-327 | `applyTheme` 只在 init 後執行一次，切換設定頁後主題不更新（除非 reload） |
| H17 | engine/session-utils.js | 93-100 | leech tag 檢查在 `if (leechTag)` 區塊內無 `return` → 貼標後繼續執行後續邏輯（rate/requeue） |
| H23 | engine/session-utils.js | 94 | `updatedCard = store.state.cards.get(wid)` 只取 flip card，MC/spell 模式下取到 `undefined` → leech 檢查失效、requeue 用 `undefined` |
| H33 | src-tauri/lib.rs | 60-62, 99-101, 121-123 | curl 命令 URL 未加 `--` 終止旗標 → URL 若以 `-` 開頭被視為參數 |
| B2 | engine/session-utils.js | 156 | `undoRating` 檢查 `c.card.state`（評分後狀態）決定回佇列，應檢查評分前狀態 → 學習卡畢業後 undo 進 `mainQueue` 非 `intradayLearning` |
| B3 | engine/session.js | 41 | `toLocalDateStr(new Date(card.due))` 未傳 `dayCutoff` / `timezoneOffset`，但 `today` 用 `getToday(0)` 硬編碼午夜 → 日期比較不一致 |
| B4 | engine/session-utils.js | 183 | Ctrl+Z 檢查 `store.state._undoSnapshot`（store 層級）但 `undoRating()` 用 module-level `_undoSnapshot` → 變數不同步時無法 undo |

## 中 (6)

| ID | 檔案 | 行 | 問題 |
|----|------|----|------|
| M4 | lib/store.js | 1312-1325 | `recordExam` 存 `word: r.wordId`（存文字非 ID）→ 改名後考試歷史孤立 |
| M5 | src/main.js | 249-251 | `mod.render(store)` 回傳 `null` 字串時顯示 `"null"`（非空白） |
| M7 | lib/db.js | 400-412 | `getGoalStreak` 同時處理 array 和 object 兩種 `dates` 格式 → schema 不一致，版本相容但混亂 |
| M9 | lib/tts.js | 67-72 | `speechSynthesis.onend` 有 5 秒 fallback timeout，但部分瀏覽器 `onend` 永不觸發 → fix: `speechSynthesis.resume()` |
| M14 | engine/session-v4.js | 84 | 排序 `learnQueue.sort((a,b) => new Date(a.card.due || 0).getTime() - ...)`，非字串 `due` 比較 → `new Date(0)` 回傳 1970，排序不正確 |
| M15 | pages/exam-flip.js | 286-287 | `systemTags` 若 `undefined` → `.find()` crash |

## 低 (3)

| ID | 檔案 | 行 | 問題 |
|----|------|----|------|
| L1 | core/exam-session.js | 4 | 未來時間戳的日期差異顯示「剛剛」 |
| L2 | lib/store.js | 301 | 未使用的 `computeStats` 解構 |
| L6 | src-tauri/lib.rs | 247 | `prune_backups` 字串排序（`teno-9.db` > `teno-10.db`）非數值排序 |

---

## 合計：25 項 bug（6 嚴重、10 高、6 中、3 低）

### 排除的非 bug（使用者清單中）

| ID | 原因 |
|----|------|
| C2 | `wrapped.mcData = { ...prevCard }` 結構冗餘但功能正確；`saveCard` 以 `JSON.stringify(card.mcData)` 存入，reload 後 `cardsMc` 能正確解析 |
| C3 | `else if (youngFound)` 確保每 word 只計一次 mature 或 young，不重複計算 |
| C4 | `deleteWord` 的 `DELETE FROM cards WHERE word_id = $1` 刪整 row，mc_data/spell_data 為 columns 同屬該 row，一併刪除 |
| H1 | `computeStreak` 的 cursor 從 `today` 出發，用 `toLocalDateStr` 套用 cutoff，行為正確 |
| H4 | `simulator.js` 的 `newPerDay = Math.max(0, newPerDay)` 有適當預設值 |
| H12 | `svg.js` `` ` `` 反引號不是 HTML injection 向量，`esc()` 已處理主要特殊字元 |
| M1 | filter 語法不必強制使用 dayCutoff，現有實作可接受 |
