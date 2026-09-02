# PM2 檢查點 — 佇列清空（2026-08-28，首相2）

## 狀態：PM2 佇列 17 顆全數有 commit，波次完成

| 佇列 | commit | 波次 |
|---|---|---|
| E4–E8, D7 | 更早波次（見 git log） | PM2 前半 |
| E9 | cbac8ed | 本日 |
| E10 | 91da5e3 | 本日 |
| E11 | 7e934e1 | 本日 |
| E12 | 27f79a5 | 本日 |
| D8 | e05292a | 本日 |
| D19 | 47227de | 本日 |
| D20 | ea5d615 | 本日 |
| E13 | 319087a | 本 session |
| E14 | 39e6f91 | 本 session |
| E15 | bb3168a | 本 session |
| E16 | 835a2d1 | 本 session |

（佇列反查法：git log --grep 逐 ID 實錘，非憑記憶。）

## 待總統事項（非佇列，殘留於工作區/登記）
1. **E16-SR1**：deprecated/sim-behavior.js（連帶孤兒，唯一引用者已刪）准否刪
   → 准則 deprecated/ 目錄可整消。
2. **D20-SR1**：exam_history 雙世代 GUI 側修法（白名單外，PM1/派員）。
3. scope-requests.md 工作區含 PM1/SR 多筆未 commit（共享檔，憲法⑨不夾帶）。
4. tools/cli.mjs 工作區殘 SR-C4 makeSession hunk（別案產物，勿誤 commit）。
5. a9/a10 需 `--experimental-test-module-mocks` flag 跑（Node v26 既存體例）。

## 環境基線（交接用）
- 回归集全綠：e16(29) e15(15) e14(41) e13(26) e12 e11 e10 e9 e8 e7 e6 e5 e4
  d20 d19 d8 d7 c3 c5 vite 0
- 驗證體例：TENO_DB=tmp＋TENO_NO_BACKUP=1；SR-C4 反剝→commit→還原循環。
