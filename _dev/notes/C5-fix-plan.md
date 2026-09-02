# C5 Fix Plan v1.0 — maxReviewsPerDay cap 語意不一致：dashboard 少報、session 多發

## Bug 定義
- **現象**: 同一設定 `simParams.maxReviewsPerDay`（UI「每日最大複習」），session 端只 cap review 卡，dashboard 端（scheduler.getDueCards）cap 在 review+new **總和**上。設定 50、实际有 60 review + 20 新卡時：dashboard 顯示待複習 50（總和被砍），session 實際發 60 review + 新卡額度 → 「dashboard 50 vs 實際 70」（audit 語）。
- **影響面**: dashboard 待複習計數（dueCount×3 mode）與實際 session 可學卡不一致；使用者依假數字決策。排程正確性無虞（存檔不經此路徑）。

## Root cause（2026-08-27 實錘行號）
- `src/engine/session-v4.js:97-98`（權威端，使用者實際經歷）：
  `if (this.maxReviewsPerDay > 0 && reviewQueue.length > this.maxReviewsPerDay) reviewQueue.length = this.maxReviewsPerDay;` — cap **僅 reviewQueue**；learning/intraday 不 cap（刻意，與 Anki「已 intro 學習卡必發」一致）、new 卡走各自 newPerDay 額度。
- `src/core/scheduler.js:158-168`：先把 review+new 組 `combined`，再 `combined.length = maxReviewsPerDay` — cap 打在**總和**上，且註解謊稱 "matches session buildQueue"（實為矛盾）。new 卡會排擠 review 額度、learning 又在 cap 外，三重語意分裂。
- 消費者窮舉（getDueCards）：僅 `store.js:486/493/499`（refreshDerived → dueCards/dueCount/dueCountMc/dueCountSpell → dashboard）；`computeCombinedStats` 另走自己路徑（C6 範圍）。session 端不走 getDueCards。

## 修法（scheduler.js 單檔，~8 行）
把 cap 從 combined 移到 reviewQueue（排序後、組合前），與 session buildQueue:97 逐字同語意：
```js
  // C5: cap 僅套 review 卡 — 與 session buildQueue（session-v4.js:97-98）同語意。
  // learning 不 cap（已 intro 必發）、new 走各自 cardsPerDay 額度，不排擠 review 預算。
  if (maxReviewsPerDay > 0 && reviewQueue.length > maxReviewsPerDay) {
    reviewQueue.length = maxReviewsPerDay;
  }
  const due = [];
  for (const { word } of learnQueue) due.push({ ...word });
  const combined = [];
  for (const { word } of reviewQueue) combined.push({ ...word });
  // （移除原 combined.length = maxReviewsPerDay 區塊）
```
選 session 端為基準的理由：(a) session 是使用者實際經歷的權威行為，dashboard 是預告；(b) 「每日最大複習」字面語意＝cap 複習卡，new 卡已有独立「每日新卡片」設定，讓 new 消耗 review 預算違反設定分軌語意；(c) Anki 的 maximum reviews/day 雖含 learning 卡計入，但 teno session 刻意不 cap learning（模擬器/日槽模型同步假設），改 session 端會連動 intraday/requeue 語意 → 風險大一個量級，非本 bug 範圍。

## 可選項定案
- 順手修 "matches session buildQueue" 假註解 → 改為如實描述。✅ 做（就是本體）。
- Anki 語意「learning 計入 review limit」→ ❌ 不做（上選理由 c，另案）。
- scheduler cap 後再插 new（維持現顺序 combined=review→new）→ ✅ 自然成立（cap 已在 review 段完成）。

## 範圍外清單
- C6：dashboard 同頁三種「待複習」數字矛盾（computeCombinedStats/deck grid）— 佇列下一顆之後的獨立 bug。
- session 端 learning cap、Anki review-limit 含 learning 語意 — 另案。
- simParamsMc/Spell fallback 邏輯（store.js:496/502）— 正確不動。

## 驗證方式
`tools/verify-c5-review-cap.mjs`（純函式，無需 DB mock；Session 直接構造）：
- 固定 fixture：maxReviewsPerDay=5、newPerDay=3、ratedNewToday=0；8 review（due 錯開）+ 2 learning + 2 relearning + 5 new。
- T1 一致性主斷言：getDueCards 的 due id 集合 = Session（真實 buildQueue）intraday∪mainQueue id 集合；長度 4+5+3=12。
- T2 cap 語意：review 取最早 due 5 張（兩端同 5 張同集合）；new 兩端同 3 張；learning 4 張全入。
- T3 cap=0（不限）：兩端全量一致（17）。
- T4 ratedNewToday=2：newSlots=1 兩端一致。
- T5 dashboard 計數 = session 可學數（dueCount 語意 due.length 直接比對）。
- T6 負控制（--expect-legacy flag + /tmp 還原舊碼副本實跑）：舊 combined cap 語意 → scheduler 9 ≠ session 12、review 被 new 排擠 — bug 精準再現。
- 回歸：verify-a6-sort（同檔 comparator）、verify-a10、verify-c4、vite build、node --check。

## 風險
- 低。getDueCards 唯一消費者是 dashboard 計數；改後計數 = 實際可學數（這正是目的）。
- 行為變化：maxReviewsPerDay>0 時 dashboard 數字**變大**（review 不再被 new 擠掉）→ 與 session 實際一致。cap=0/無限場景零變化。

## 審查等級
- 單檔 <20 行但 scheduler 為共享檔（store/session-v4/cli 皆 import）→ 不合降級條件，3 名委員。

## 狀態
- [x] 根因查證（行號實錘 + 消費者窮舉）
- [x] 驗證腳本實跑（修法 96/96 + 負控制 23/23，含審查後補 T7/T8/T9 邊角）
- [x] 送審（R1：3 委員）
- [x] 過審（3/3 全 ✅）→ commit

## 審查紀錄（R1，3/3 PASS）
- #1 修法正確性：/tmp HEAD 還原舊碼獨立負控制 sch=9≠ses=12 實錘；三點語意逐行對齊
- #2 消費者完整性：getDueCards 消費者窮舉無隱藏依賴；simulator.js 舊語意反而與新碼收斂；Anki「learning 計入 review limit」偏差已誠實登記範圍外
- #3 測試設計：fixture 區分力實測（舊碼必紅）、四邊角親跑一致；MED/LOW 建議 → T7（cap<learning 含 new）/T8（cap==review 邊界）/T9（ratedNew 超額）已補
- 範圍外新增登記：混偏移 due 排序器不一致（scheduler localeCompare vs session timestamp，生產 canonical Z 不可達）、session Invalid Date 死碼 — 登 bug-audit 後續
