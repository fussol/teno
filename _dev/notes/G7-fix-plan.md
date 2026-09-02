# G7 修復計畫書 v1 — 每評一張卡的全表掃描＋多餘 DB round-trip

## Bug 定義
使用者 32 項清單 #7（audit 檔 bug-audit-2026-08-13.md:G7，🟠）：每評一張卡，UI 卡頓明顯；千詞以上詞庫可感知延遲。

## Root cause（實碼定位，2026-08-28 逐行確認）
一次 `rateCard()` 的隱藏成本（store.js:636-820）：

| # | 成本 | 位置 | 每評分次數 |
|---|---|---|---|
| 1 | **3 次串行 DB round-trip**：`getNewRatedToday('flip'/'mc'/'spell')` 各打一條 COUNT | store.js:482-484 → db.js:530-540 | 3（Tauri IPC 橋上每趟 ~5-30ms） |
| 2 | **3 次全表掃描 + 陣列分配**：`getDueCards` ×3，每張 due 卡做 `{...word}` 展開 — 但 mc/spell **只要 count 不要清單** | store.js:486-503 → scheduler.js:116-182 | 3 遍 × N 詞 |
| 3 | **第 4 次全表掃描**：`computeCombinedStats` | store.js:429-474 | 1 遍 × N 詞（可接受，但同輪） |
| 4 | **`computeRetention` 全 log 掃描**：18k 條 × `new Date()` parse，每評一卡重掃全部 | scheduler.js:407-416 | O(log) |
| 5 | review/relearn 卡評分多一次 `computeFutureDueCounts` 90 天掃描 | store.js:715 | **演算法必需**（fsrs.review fuzz 輸入，Anki 同語意）→ 不動 |

主打 1/2/4（純浪費，零語意變更）；3 保留（單遍 scan 成本線性且結果必須全局精確）。

## 修法（3 檔）

### A. `src/lib/db.js`（新增 :541 後）
`getNewRatedTodayAll(todayStart, dayCutoff, tzOffset)`：單條
`SELECT mode, COUNT(*) AS count FROM review_log WHERE card_state = 0 AND reviewed_at >= $1 GROUP BY mode`
回傳 `{flip, mc, spell}`（缺 mode 組→0；**NULL mode 孤群被 out[undefined] 丟棄＝與原三條 `mode=$1` 等值**，語意對齊 db.js:536 現行三查詢）。boundaryUtc 計算原樣複製（E2 完整 ISO 字串教訓保留）。原 `getNewRatedToday` 保留（CLI/其他消費者）。

### B. `src/core/scheduler.js`
1. `getDueCards(...)` 尾增第 11 參數 `countsOnly = false`：三隊列筛選/cap 路徑**原代碼不動**，僅 countsOnly 時以**同款迴圈**數 new 採納數（非新公式，逐字複製 break 迴圈防邊界發散）後回傳 `{ due: null, count, newCount }`，跳過全部 `{...word}` 展開。
2. `computeRetention`：反掃描＋早停 — reviewLog 載入序 `ORDER BY reviewed_at, id`（db.js:493）＋ rateCard push 尾插 ⇒ 時序單調保證；由尾向前，`reviewed_at` 缺失跳過（同原 filter 排除），`t <= cutoff` 即 break。複雜度 O(30 天視窗)。

### C. `src/lib/store.js` refreshDerived()（:476-509）
- 三條 `getNewRatedToday` → 一條 `getNewRatedTodayAll`（3 round-trip → 1）
- mc/spell `getDueCards` 呼叫尾帶 `true`（countsOnly），改讀 `.count`；flip 保留全清單（dashboard/session 消费者不動）
- 回傳欄位賦值名稱不變（`state.dueCountMc = dueMc.count`），零消費者波及

## 消費者窮舉（憲法②）
- `getDueCards`：grep 全 src+tools — refreshDerived ×3、其他 import 點走舊 10 參（第 11 預設 false，零行為變動）✅ 驗證腳本釘死
- `getNewRatedToday`：保留原函式，舊呼叫者不動
- `computeRetention`：僅 refreshDerived 消費；輸出欄位 `{rate,total,correct}` 不變
- `state.newRatedToday(Mc/Spell)` 語意：原=各 mode COUNT 純讀 → 新=同 SQL 同 boundary 的 GROUP BY 版，數值恒等

## 計算模型（憲法③）
純計數/掃描重排，無任何浮點或排程數值變更。fsrs.review 輸入（futureCounts、fuzz、steps）零觸碰。

## 驗證（tools/verify-g7-perf.mjs，雙態＋負控制）
- **層1 等值金標**：FakeDatabase（照 c1 harness 體例）＋ 5k 詞隨機分佈 fixture，200 次隨機評分序列；每次評分後**增量後臺全量重算對拍** — `dueCount/dueCountMc/dueCountSpell/newRatedToday*/stats/retention` 欄位逐一嚴格相等（POST 綠）。
- **層2 countsOnly 釘**：同 fixture 下 `getDueCards(...countsOnly=true).count === getDueCards(...).due.length` ×三模式×隨機 seed（含 maxReviewsPerDay、ratedNewToday 溢出、newPerDay=0/NaN/null 邊界）。
- **層3 retention 等值**：18k 條 log（含亂序注入防呆測試反例——非單調序列時反掃描行為＝由尾向首首個跨界即停，測試以正序數據為準，亂序僅記錄不釘）對比原前掃描實作輸出全等；30 天視窗邊界±1ms 對齊。
- **層4 性能實測**：10k 詞 × 3k log，rateCard ×50 總時間 PRE/POST 對拍，要求 **POST ≤ 60% PRE**（附實測數字）。
- **負控制**：(a) 還原 countsOnly 缺失 mc count → 層2 紅；(b) getNewRatedTodayAll 丟 GROUP BY（mode 全算 flip）→ 層1 紅。
- 回歸：verify-c1（同 store 路徑）、verify-a10、verify-c3、npm run build、node --check。

## 風險
- 反掃描依賴時序單調：loadReviewLog ORDER BY 釘死（db.js:493）＋尾插；外部直寫 DB（CLI）若塞亂序 log → 僅 retention 視窗近似少算，下次 load 自動糾正。誠實登記，不防衛。
- `{ due: null }`：countsOnly 呼叫者誤讀 .due 會炸 → 驗證層2 釘死三呼叫點靜態檢查（grep 斷言 mc/spell 只用 .count）。

## 範圍外（憲法⑦）
- computeCombinedStats 增量計數器（發散風險>收益，觀摩後再議）
- sidebar innerHTML 重建 → renderInPlace 化（UI 軌）
- main.js subscribe key stringify（微觀，非本次痛點）
- SQLite 索引審查（review_log.reviewed_at 是否有索引 → D19 系另案）
