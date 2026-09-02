# A6 Fix Plan — dashboard 預覽順序 vs 實際 session 順序不一致

## 1. Bug 事實

**位置**：src/core/scheduler.js:127-130（getDueCards）、src/engine/session-v4.js:79/:106（buildQueue/intradayLearning）

**問題**：dashboard 預覽（getDueCards）learning 卡排序用 `lastReview`（oldest first），session（buildQueue）用 `due`（earliest first）→ 預覽順序 ≠ 實際學習順序。

**Anki 官方**：sort_learning = cmp_by_reps_then_due（reps 小→大，再 due 早→晚；rslib `b.reps.cmp(&a.reps).then_with(|| a.due.cmp(&b.due))`）。

## 2. 根因

兩端各用不同 comparator；且 session-v4 :106 intradayLearning re-sort 的舊 comparator（`reps===0 → 排最後`）會覆蓋 :79 排序 — reps≥1 時 stable sort 恰好保留（bug 潛伏），reps=0 的 learning 卡（legacy 資料）實際順序仍錯。

## 3. 修法

- scheduler.js 新增 export `cmpByRepsThenDue(a, b)`（null 防護：reps 缺省 0、due 缺省/畸形視為 0）
- getDueCards learnQueue.sort 改用同一 comparator（含 relearning 卡）
- session-v4.js buildQueue learnQueue.sort + intradayLearning.sort 同一 comparator（:106 是關鍵 — 不修它 :79 的排序會被覆蓋，測試必掛）

## 4. 消費者清單

| # | 位置 | 影響 |
|---|---|---|
| 1 | scheduler.js getDueCards | 預覽順序（dashboard/統計） |
| 2 | session-v4.js buildQueue | 實際學習順序 |
| 3 | session-v4.js intradayLearning | 學習佇列消費（含 requeue） |

review 卡排序（due 早→晚）與 new 卡 shuffle 不受影響。

## 5. 驗證

tools/verify-a6-sort.mjs 19/19（4 learning 卡 reps/due/lastReview 三方向矛盾 → 兩端一字不差 [wD,wC,wA,wB]；review 卡不受影響；new shuffle 仍生效；cap 一致；負控制 stash 舊碼必紅）。node --check 兩檔、vite build 807ms。

## 6. 範圍外

- new 卡每日順序重洗（A7 另案）
- reviewMix/intersperse 不變
