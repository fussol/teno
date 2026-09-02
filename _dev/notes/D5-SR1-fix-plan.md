# D5-SR1 修復計畫書 — backupDb 未先 WAL checkpoint → 備份缺最近複習

- **Bug ID**: D5-SR1
- **規格來源**: scope-requests.md D5-SR1（PM3 登案，2026-08-28）
- **任務書**: PM-SR1-MISSION §佇列1
- **基線**: HEAD `12e9978` (v5.7.0)
- **首相**: SR1（資料層）

## 1. Bug 定義
`src/lib/api.js:72` `backupDb` 直接 `invoke('backup_db')`，未先 WAL checkpoint。
Rust 端 `backup_db` 的 fs::copy 若 DB 開在 WAL journal 模式（tauri-plugin-sql 預設），
備份檔不含 WAL 內尚未合併回主檔的最新交易 → **備份缺最近複習**。

> **v1.1 勘誤（採納審查委員 R1 發現#1，誠實修訂）**：HEAD 基線上實際 4 呼叫點
> （backup-scheduler.js:33、settings.js:538/608/1032）**均已各有相鄰 checkpoint**，
> scope-requests「唯 :551 有」對 HEAD 樹不實。故真正缺陷不是「呼叫方漏做」，
> 而是：(a) 「backup 前必 checkpoint」為不變量僅靠各呼叫方自覺（API 契約缺口，防未來
> 回歸的重要立足點）；(b) backup-scheduler 的「checkpoint→getDbMtime→backupDb」
> 之間存在 TOCTOU 殘窗。本修法收斂為 API 邊界 contract，兩者一併關閉。修復本身正確且必要。

## 2. Root cause
- `api.js:72`：`export const backupDb = () => invoke('backup_db')`
- 缺少 `await checkpoint()`（PRAGMA wal_checkpoint(TRUNCATE)）在 invoke 前。
- `checkpoint()` 已存在 `src/lib/db.js:122-126`，且 settings.js:537/605（實錘覆核行號，非任務書 484/551/928——行號已漂）已有「checkpoint → backupDb」先例。
- backupDb 呼叫點（grep 實錘）：backup-scheduler.js:33、settings.js:538/608/1032，共 4 點全部 call backupDb → **單點封頂**成立。

## 3. 修法（單點封頂，已裁示）
檔：`src/lib/api.js`
1. 頂部加 `import { checkpoint } from './db.js'`（api.js 目前無此 import，實錘：api.js:1 僅 `import { invoke } from '@tauri-apps/api/core'`）。
2. `backupDb` 改為：
   ```js
   export const backupDb = async () => {
     await checkpoint();
     return invoke('backup_db')
   }
   ```
Checkpoint 是 async、已 catch（db.js 內 try/catch），不會因 checkpoint 失敗中斷備份。唯一 choke point 涵蓋全 4 呼叫點。呼叫方均 await，語意不變。

## 4. 驗證（雙態）
- `tools/verify-d5-checkpoint.mjs`（新建，task書指定）。負控制：剝除 `await checkpoint()` 後 bug 精準重現（harness 用 fake invoke 捕獲呼叫順序，斷言 backupDb 執行時 checkpoint 先於 invoke 且被 await）。
  - 正向（修後）：backupDb 呼叫拉出 check point order = [checkpoint, invoke]，且 harness 能捕獲 checkpoint 曾執行（透過 fake db module 注入）。
  - 負控制：跑一個 source-transform 版本（移除 await checkpoint 那行）→ order = [invoke]，碼斷言 checkpoint 未執行 → RED。證明 harness 真能抓此 bug。

## 5. 風險
- 低。checkpoint 每次備份多一次 PRAGMA，TRUNCATE 空 WAL 無成本；db 未連線時 checkpoint() no-op（db.js:123 `if(db)`）。
- import 週期：api.js → db.js，db.js 無反向 import api.js，無循環。

## 6. 範圍外
- Rust `backup_db`/`lib.rs`（PM3 禁區，不碰）。
- settings.js 內既有 checkpoint 呼叫（雙重 checkpoint 無害，不動）。
- store.js（他軌）。

## 7. 可選項
- 直接改 Rust backup_db 內部跑 PRAGMA → **不做**（詳 scope-requests D5-SR1 三路實錘封閉：plugin 2.4.0 未 re-export sqlx，純 lib.rs 零依賴無法執行 PRAGMA；前端素材已齊，單點封頂最穩）。

## 8. 過審後動工 checklist
- [x] 頂部加 checkpoint import
- [x] backupDb 改 async + await checkpoint() 在前
- [x] node --check api.js
- [x] verify-d5-checkpoint.mjs 正向全綠
- [x] verify-d5-checkpoint.mjs 負控制（剝除修法）紅

## 版本
5.8.1（v1.1 勘誤：HEAD 樹已 5.8.0，D5 首顆結案升 5.8.1；首顆補丁）
- v1.0（送審）：初版。
- v1.1（審查採納，R1）：§1 受害敘述勘誤（4 呼叫點實皆有意義相鄰 checkpoint，真正缺陷=API 契約缺口＋TOCTOU 殘窗）；版本欄位更正（樹 5.8.0 → 結案 5.8.1）。