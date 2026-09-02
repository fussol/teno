# B7 Fix Plan — mc applyTags 未作答標答錯（已由 B3 覆蓋，僅加防回歸測試）

## 1. Bug 事實

**位置**：src/pages/exam-mc.js applyTags

**問題**：audit 記錄 mc applyTags 把未作答題（_picked=-1）標成答錯（spell 有防護）。

## 2. 結論：B3（3a4de3f）已完整覆蓋

實際 code 核對 — 三條資料路徑全部封死：

1. **startExam（:236）**：`e.results = new Array(n).fill(undefined)` — 未答題 results[i] 恆為 undefined，且 `_picked=-1 / _answered=false`
2. **pickOption（:307）**：results 僅在作答時寫入（`w._answered=true` 先行）— 未答題永遠不會被寫成 false
3. **resumeSession（:272, :274）**：有效 results 走 per-word guard `words[i]?._answered ? r : undefined`；fallback 顯式 `w._picked >= 0` 檢查
4. **applyTags（:362）**：`if (r !== true && r !== false) continue;` — undefined/null 一律跳過不貼標籤

## 3. 處置

- **不重複改碼**（B3 已修）
- 新增 tools/verify-b7-mc-tags.mjs 防回歸測試鎖住行為

## 4. 驗證

tools/verify-b7-mc-tags.mjs 34/34（T1 交錯作答 [錯,對,未答,對] → 未答零標籤且 editWord 零呼叫；T2 resume 殘留 false/null → guard 擋下；T3 resume fallback _picked>=0；T4 _noScore 題零標籤；T5 對照組全答 B1 語意保持；T6 負控制剝除 B3 guard → bug 精準再現）。verify-b5 51/51 回歸、vite build 760ms。

## 5. 範圍外

- B1（交錯作答誤標 — 已修）
- spell/flip applyTags 不動
