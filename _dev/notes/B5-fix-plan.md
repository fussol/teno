# B5 Fix Plan — startExam 不重置 e.id → 新測驗覆蓋已存 session

## 1. Bug 事實

**位置**：src/pages/exam-flip.js / exam-mc.js / exam-spell.js 的 startExam（三頁同構）

**問題**：`e.id` 唯一寫入點是 resumeSession（`e.id = session.id`）。startExam 不重置 → resume 過的舊 id 殘留 → buildSession（src/core/exam-session.js:50 `id: e.id || 'exam_${mode}_${Date.now()}'`）沿用舊 id → saveExamSession（store.js:1660 `filter(s => s.id !== session.id)`）用同 id 替換 → **新測驗覆蓋已存 session**。

## 2. 根因

e.id 同時服務「resume 語意」與「新場辨識」，startExam 沒有切斷舊 id。

## 3. 修法（最小）

三頁 startExam 開頭（examRecorded 重置旁）加 `e.id = undefined`。buildSession 在 e.id falsy 時自行產新 id（`exam_${mode}_${Date.now()}`）— 無需動 buildSession/store.js。

## 4. 驗證

tools/verify-b5-exam-id.mjs 51/51：
- T0 真實 buildSession 契約（e.id 空→新 id；有值→沿用）
- T1-T3 三頁「場1 退出存 session1 → resume → 場2 startExam → 退出存 session2」→ 兩筆並存、舊 session 未被覆寫
- T4 負控制：剝除重置行 → bug 再現（覆蓋實錘）
- 可控 Date.now counter 消除同毫秒碰撞

node --check 三頁、vite build 799ms。

## 5. 範圍外

- B6（完成不刪除，另案）
- B2/B3/B4 既有修法不動
