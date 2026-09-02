# PM-OCR2 checkpoint — T5 雙派碰撞登記（2026-08-28 20:50，PM-OCR2-T5 專軌）

## 事實
- 調度器重複派工 T5：
  - `pocr2c`（20:27 起，任務 T4→T5→T6 接班軌）
  - `pocr2t5`（20:38 起，任務僅 T5 — 本軌）
- 時間線（實證 stat/git log）：
  - 20:40:35 pocr2c 寫 T4 subagent-log；20:4x commit T4（89a76a6）
  - 20:41:51 pocr2c 寫入 store.js importOcrText（照 §6.2b＋String(w) 防呆強化）
  - 20:43:xx 本軌寫好 tools/verify-ocr-import.mjs（自家設計 T0-T7）＋PRE 跑（函式已被對軌實裝→紅基線失效，僅 T5 全垃圾 DB 斷言 1 紅＝本軌腳本自身 bug）
  - 20:45:09 pocr2c 以**同名路徑**覆寫 tools/verify-ocr-import.mjs（其設計）
  - 20:46+ pocr2c 跑 browser OCR confirm 內測，T5 commit 進行中

## 裁決（總統未在时限內裁示，專軌自行裁定）
- 不硬搶 commit（違憲⑨一commit一版本＋互覆寫實錘）、不 kill 他軌（無授權、T6 將孤兒化）。
- 本軌 T5 commit 職權**讓渡給 pocr2c**（其先動工且已至收尾）。
- 本軌轉為**獨立第二軌稽核**：對 pocr2c 之 T5 commit 做雙態重跑（含 PRE 重現＝git show HEAD~1 store.js 快照實跑）＋browser 學習主流程冒煙＋negative control 重跑。
- 稽核證據落 _dev/notes/subagent-log/2026-08-28-OCR-T5-audit.md；發現缺陷即回報總統（不擅自補刀 commit）。

## 稽核結果（2026-08-28 21:05 補記）
- pocr2c 已 commit **2dae766 feat(ocr): importOcrText**（僅 3 檔，邊界合規）。
- 本軌獨立稽核：原腳本 16/16 復跑綠＋audit 18/18 綠（補「事務失敗 added=0」＋「不過濾 NC」
  兩缺口＋HEAD~1 真快照 PRE 重現）＋browser 冒煙（學習主流程 reps/reviewLog 實斷言、
  OCR 活體過濾零洩漏、DB 邊界錯誤與 importWords 逐字元一致、工具頁三控件 in place、console 零 error）。
- 裁定：T5 品質合格，2dae766 維持不动。詳單 _dev/notes/subagent-log/2026-08-28-OCR-T5-audit.md。

## 給調度器的教訓（登記）
- 同檔子任務重複派工前應查 git log／spot log 進行中軌道；pocr2c 任務單含 T5 時不應再發 T5 專軌（或反之）。
- 建議派工指令帶「若 subagent-log/ 已有當日子任務檔即先讀再動」條款。
