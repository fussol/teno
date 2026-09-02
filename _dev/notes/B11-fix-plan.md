# B11 Fix Plan — autoNext timer 與「退出」競態（已由 B2 覆蓋，僅加防回歸測試）

## 1. Bug 事實

**位置**：三頁 exam-flip.js / exam-mc.js / exam-spell.js 的 autoNext setTimeout

**問題**：audit 記錄「autoNext setTimeout 與退出競態」— 退出後 timer 若仍 fire 會跳題/重複計分。audit 標注「已確認，列出供參考」— 與 B2 同源。

## 2. 結論：B2（cb76cbf）已完整封死

實際 code 核對 — 四道防線全部就位：

1. **exit 按鈕**：clearTimeout + flushPendingScore + phase='config'（三頁）
2. **startExam / resumeSession / saveOnLeave（B10）**：清殘留 timer
3. **nextWord phase guard**：`e.phase !== 'exam' → return`（三頁）— 最後防線：即使 timer 在 exit 後 fire 也是 no-op，不跳題不計分
4. **timer callback**：`nextWord(s); e.autoNextTimer = null` — fire 後不殘留

## 3. 處置

- 不重複改碼（B2 已修）
- 新增 tools/verify-b11-timer-race.mjs 防回歸測試鎖住四道防線

## 4. 驗證

tools/verify-b11-timer-race.mjs 21/21（三頁 × 7 斷言：exit clearTimeout / nextWord phase guard / startExam clearTimeout / resumeSession clearTimeout / exit flush / timer callback 清 null / saveOnLeave clearTimeout）。

## 5. 範圍外

- B2 的延遲窗計分本身（已修）
- B10 的 sidebar 存檔（已修）
