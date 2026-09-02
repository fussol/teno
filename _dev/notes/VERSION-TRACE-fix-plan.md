# VERSION-TRACE 修法計畫書 v1.0（DB 版本指紋）

## Bug / 需求定義
DB 檔完全沒有「哪個 app 版本寫的」痕跡 — audit_log 無版本欄、settings 無 version 鍵、無 `PRAGMA user_version`。實際危害：修復分界要靠 reviewed_at 的 Z/無Z 格式猜（本次分析 E2 就是這樣猜的）；版本混用/降級無法從 DB 看出。要求：每份 DB 有明顯版本指紋。

## 修法（最佳方案：SQLite 原生 PRAGMA user_version）
SQLite 內建 `PRAGMA user_version`（int，永續存於 DB 檔頭、不佔表、強制單一值）是標準做法。此外在 settings 同時寫字串版本（可讀性），並在 audit_log 記首次寫入。

1. `src/lib/db.js` initDB/migrate 完：`PRAGMA user_version = <version_int>`
   - version_int 從 package.json 讀：major*1000000 + minor*1000 + patch（5.1.18 → 5*1e6+1*1e3+18 = 5,001,018）
   - 相容：只升不降（讀取現值，若新 > 現值才寫）
2. settings 寫 `db_from_version` = "5.1.18"（字串，人讀）
3. 建立 `check_version` helper 供 CLI/tools 讀取

## 消費者清單（憲法②）
- 寫入點：db.js initDB（單點）
- 讀取點：新增 `getDbVersion()`（CLI `teno db-version`、分析工具）
- 版本來源：`import pkg from '../../package.json'`（db.js 需確認可 import，或注入）

## 版本制定規範（法案，寫入法典）
1. 每個 release 必須 package.json + tauri.conf.json 同步版本號
2. 版本號語意：major.minor.patch（major 破壞相容、minor 功能、patch 修 bug）
3. 每次 build/打包 → DB 開機自動寫入 user_version
4. 分析 DB 一律先查 PRAGMA user_version 定版本
5. 修改 DB schema → minor 或 major 升版（patch 只改邏輯不建議升 schema 但也可反映）

## 驗證
- T1 開機後 PRAGMA user_version = 5,001,018（對應 5.1.18）
- T2 settings.db_from_version = "5.1.18"
- T3 已存在 DB（無指紋）→ 首次開啟補寫，不重寫已更高版本
- T4 負控制：無版本機制時 user_version=0（bug 重現 = 看不出版本）

## 風險
- 中低：PRAGMA user_version 是 SQLite 標準、無副作用；版本解析失敗 fallback 0（不 crash）。

## 範圍外
- TENOC 容器 header 是否也 embed 版本 — 另案（本顆聚焦 SQLite 內）
- 歷史 DB 回填（既有的無法得知實際版本）— 註明「legacy/未知」