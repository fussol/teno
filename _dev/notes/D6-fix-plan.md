# D6 修復計畫書 v1.1

## Bug 定義
設定頁「匯入備份」（`runImportDb`）在 plugin-sql 連線仍然開啟時覆寫 `teno.db`：
`backupDb() → importDbDialog()（覆寫）→ closeDB() → closeAppLog()`。
closeDB 在覆寫**之後**才跑，覆寫瞬間 SQLite 連線（含 WAL）還活著：
- `write_db_container` 先 remove teno.db-wal/-shm 再 tmp+rename 換主檔：存活連線的髒頁可
  能被後續 checkpoint/close 刷回，或 page cache 對上已替換的檔案 → reload 前讀到混合態
- 第二缺陷（同函式）：`backup_db`（Rust）為單檔 io::copy，未 checkpoint 時 WAL 最新交易
  不進備份 →「安全網」本身漏資料

## Root cause（實錘 2026-08-29，行號＝當日 HEAD 實測）
- `src/pages/settings.js:481-495` `runImportDb`：backupDb(483) → importDbDialog(484) →
  closeDB(486) → closeAppLog(487)，close 全在覆寫後
- `src/lib/api.js:94` `importDbDialog` → Rust `import_db_dialog`（`src-tauri/src/lib.rs:646-673`）：
  選檔取消在 `unpack_db_container`/`write_db_container` 之前 throw「使用者取消」（:655），
  **取消不會覆寫**；覆寫用 `write_db_container`（:622-635）同時寫 teno.db + app-log.db
  並先刪 `-wal/-shm` → closeAppLog 也必須在覆寫前
- `src-tauri/src/lib.rs:1347-1370` `backup_db` = 單檔 io::copy（無 checkpoint、不含 -wal）
- 同檔 `restoreBackup`（settings.js:541-564）與 drive 下載（:925-936）已是正確同構範本：
  checkpoint → backupDb → closeDB+closeAppLog → 覆寫 → reload，catch 內 initDB(2) 復活
- 勘誤（v1 不實處，R1#1 逮）：v1 稱「無漂移」錯誤——settings.js 宣告行實際 :481（非 480）、
  函式體至 :495；Rust 端 import_db_dialog 實際 :646-673（v1 寫 595-622，漂移 ~52 行）、
  backup_db 實際 :1347-1370（v1 寫 1239-1250）。語意全部屬實，行號以本節為準。

## 修法（settings.js `runImportDb`，唯一改動檔＝白名單內）
改成與 `restoreBackup` 同構＋R1#2 備註A 強化：
1. `await checkpoint()`（WAL 合併 → 備份完整）
2. `await backupDb()`（安全網，此時檔案已含全部資料）
3. `await checkpointAppLog()`（既有匯出，app-log.js:27：flush 排空記憶體佇列 + WAL 合併。
   R1#2 備註A：import 獨有 write_db_container 覆寫 app-log.db（restore/drive 不覆寫），
   選檔對話框等待期間 console 觸發 logToDb→2s flush→getDb() 重開舊 app-log 連線的縮影
   race，用 flush-先行壓到近零）
4. `await closeDB()` + `await closeAppLog()`（連線全關）
5. `await importDbDialog()`（覆寫 teno.db + app-log.db，無連線干擾）
6. toast + reload
7. catch：先 `initDB(2)` 重開連線（取消/失敗時 DB 已關，避免半死狀態，與 restoreBackup
   catch 同構；app-log 由 getDb() 惰性重連，restoreBackup 上線先例已驗證），再照舊
   「使用者取消」靜默、其他錯誤報錯

預計改動 ~14 行，僅 `src/pages/settings.js`。動態 import 改宣告式取 checkpoint/closeDB/
checkpointAppLog/closeAppLog（照 restoreBackup 寫法）。

## 驗證方式
`tools/verify-d6-import-order.mjs` **v2**（R1#3 ❌ 後結構重做，v1 有五重言式假綠實錘）：
- 模式自判：BUG 態（源碼未修）→ T0 bug 確認 + POST 腿 N/A、**EXIT=1 必紅**（消 v1
  「常量重言式洗白」，R1#3 A2b 實錘）；FIXED 態 → 全斷言直接打真實源碼；結構漂移 → EXIT=2
- 掃描前**位置保持遮罩**（// 、/* */、'..'、".."、`` 內容→空格）＋行首錨定括號計數器擷取
  （沿用 F14 maskEngine 思路；消 A4 模板字串截斷、A5 註解 decoy 首匹配、A7 註解內 initDB 騙 T1.6）
- T1 順序閘 P1-P9（含 P9 checkpointAppLog<closeAppLog 新腿）、T2 WAL 語義實測（node:sqlite
  真 DB，R1#3 認證決定性 5/5）、T4 負控制（FIXED 態對真實源碼等長剝除必紅／BUG 態對常量
  bug 版——常量與真實源碼正規化全等由模式判定強制，消常量過期自圓）、T5 遮罩/擷取自證
- 修法呼叫全放 try 外（順序正確但錯誤處理偏離步驟7）屬審查面非順序釘面，N4 判可接受＋本節註記。
- **攻擊重放自證（首相實跑，/tmp/d6-attack-replay.mjs）**：POST✅綠、A6 原假紅案轉綠、
  A2b/A4 漂移守衛 EXIT=2、A2 漏 await 紅 T1.1/T1.2、A5 decoy 落 BUG 態、A7 殭屍復活紅
  T1.6、A3a 偷工紅 T1.4/T1.5/T1.8、**DUP（R2 N2 重複宣告）紅 EXIT=2（M5 釘）**——9/9 收斂
- 威脅模型（成文，R1#3 M4）：防無意順序回歸、典型偷工、decoy 偽裝、殭屍復活；
  不防對抗性混淆（動態構造字串）；不驗 checkpoint 真發 PRAGMA、不驗 closeDB 真斷連線
  ＝靜態順序釘＋T2 語義實測的邊界
- 回歸：node --check settings.js、vite build、≥3 個既有 verify 腳本
- 送審前狀態實跑：BUG 態 11/11 PASS＋9 N/A、EXIT=1（PRE 必紅＝bug 實錘，語意正確）

## 風險
- close→選檔對話框→reload 之間 DB 關閉數秒：期間背景寫入失敗丟棄。此暴露與既有
  `restoreBackup`/drive 下載完全相同（已上線模式，R1#2 独立查證：backup-scheduler tick
  走純 Rust fs＋checkpoint 對 null no-op；app-log flush timer 僅佇列非空時存在、500ms
  reload 掐死 2s timer；addAudit 外側皆 .catch(()=>{})）。.reload 後全部重開，接受。
- checkpoint() 內部吞錯（db.js:122-124 只 warn）：若 SQLITE_BUSY 靜默失敗，backupDb
  安全網可能漏 WAL tail——與 restoreBackup/driveSync 同構既有風險，非本修法引入，白名單
  內無從改善，記錄在案（R1#2 第4點）。
- 使用者取消時已多做一次備份檔：無害（prune 自然回收）。
- initDB(2) 重開會跑 migrate：全部 ALTER 包 try/catch，冪等無害。
- backupDb 拋錯時 catch 的 initDB(2) 對仍開啟 DB 重開第二連線（舊 handle 遺留）：與
  restoreBackup 範本同瑕疵，非本修法引入（R1#1 邊緣①），記錄不修。

## 範圍外清單
1. `import_db_dialog`/`backup_db` Rust 實作（拆對話框與覆寫、backup 改用 SQLite backup
   API、write_db_container 部分失敗＝teno rename 成功 app-log 寫失敗的不 reload 窗口
   ＝R1#1 邊緣②）→ src-tauri 非白名單，記錄不修
2. Android 匯入另路徑：closeDB/checkpointAppLog 為純 JS plugin-sql 路徑零平台分支，
   import_db_dialog 的 content:// 僅選檔拷貝、寫點同 app_config_dir() → 本修法對稱生效
   （R1#2 查證屬實）。措辭勘誤：TENOC 是匯出容器檔案 magic（lib.rs:559 附近），非
   Android 檔案系統路徑（v1 用語不精確，R1#2 備註B）。
3. D6 之外設定頁其他問題

## 渲染驗證
本修復為匯入流程順序邏輯，無視覺變更 → 不需要 vision 驗證（Mission 規定之註明義務，
R1 三席未異議）。

## 版本紀錄
- v1（2026-08-27）：初版送審。
- R1（2026-08-29，三席）：#1 ✅（行號勘誤要求）／#2 ✅（備註A checkpointAppLog 採納、
  備註B TENOC 措辭）／#3 ❌（驗證器重言式假綠 A2b/A2/A5/A4/A7 實錘＋A6 假紅，M1-M4）。
- v1.1（2026-08-29）：行號全面勘誤實測化；採納備註A（步驟3 checkpointAppLog＋驗證腿 P9）；
  TENOC 措辭勘誤；範圍外＋2（write_db_container 部分失敗窗口）；風險節補 R1 邊緣論證；
  驗證器 v2 結構重做（消重言式＋位置保持遮罩＋括號計數器＋容忍式負控制＋威脅模型成文）
  ＋攻擊重放 8/8 收斂自證。v1 凍結。
- 待審：R2。
- R2（2026-08-29，原 ❌ 席單席複核）：M1-M4 全銷帳；新攻擊 N2（首個＝修法＋第二個同名
  宣告＝真 bug 版，ESM hoisting 後者覆蓋 runtime）實錘假綠 → 必須項 M5 重複宣告釘
  （宣告數≠1 → EXIT=2）＋DUP 重放腿。餘 N1/N3/N5a/N5b/N6 全 fail-closed、N4 註記可接受。
- v1.2（2026-08-29）：M5 落檔（驗證器 L98-103）＋DUP 腿重放 EXIT=2 實證，9/9 收斂；
  R2 席預認書面銷帳（「補 M5 一行釘＋重放腿即可升 ✅，不必再開全輪」原文）→ **過審**，
  凍結 v1.2 動工。restoreBackup 行號 ±1 裝飾性漂移（實際 :542）屬 cosmetic，誠實登記。
