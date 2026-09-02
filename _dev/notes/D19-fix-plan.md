# D19 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.0 送審 R1 後升版，§7 審查紀錄）

## 1. Bug 定義
`cmdImportDb`（tools/cli.mjs:2210-2223，行號實錘 2026-08-28）對來源檔案
**零驗證**：`readFileSync(src)` → `unpackContainer(data)` → 直接
`rmWal + writeFileSync(DB, tenoBytes)` 覆寫主 DB。三條災難路徑：
1. **垃圾檔直入**：CSV/文字/任意檔傳入 → 主 DB 瞬間被垃圾覆寫（app 直接起不來，
   需手動 /restore）。
2. **截斷容器最毒**：`unpackContainer`:2190-2191 在 TENOC header 對但
   `l1` 超過檔長時 **fallback 把整個檔案（含 TENOC header）當 raw teno 回傳**
   → 连容器格式破損的半成品也會被整份寫進 DB。
3. **log 段損壞**：容器 teno 段真、log 段垃圾 → app-log.db 同樣被覆寫。
4. （R1#1 連帶發現）**空檔直入**：0 字節檔 → DB 資料全消失（`length>=100`
   守門天然涵蓋）。
5. （R1#1/#2 同根既存蟲，本單順修）**空 log 段 truthy**：`export-db --no-log`
   產物 l2=0 → `unpackContainer`:2196 回傳**空 Buffer（truthy 非 null）** →
   現行 `if (logBytes)` 誤判 → **app-log.db 被覆寫成 0 字節**（R1#2 實測
   20B→0B）。Rust 參考實作 `write_db_container`（lib.rs:576）用
   `if !log.is_empty()`——CLI 漂移實錘，合約註解 lib.rs:519「len=0 表示無 log」。

## 2. Root cause
import 入口把 `unpackContainer` 的宽松 fallback（兼容 raw DB 檔的**功能**）
當成「資料已可信」的訊號，從不驗 SQLite magic header。

## 3. 修法（tools/cli.mjs 單檔，guard 入口，零改 unpackContainer）
`cmdImportDb` 於 unpack 之後、`backupDb()` 之前加 magic 守門：
```
const isSqlite = (b) => Buffer.isBuffer(b) && b.length >= 100
  && b.subarray(0, 16).toString('latin1') === 'SQLite format 3\0';
if (!isSqlite(tenoBytes)) {
  console.log(`❌ 拒絕匯入: teno 段不是 SQLite 資料庫（magic 不符）— 來源 ${src}`);
  log('ERROR', `import-db rejected: not SQLite magic ${src}`);
  process.exitCode = 1; return;
}
if (logBytes?.length && !isSqlite(logBytes)) {
  console.log(`❌ 拒絕匯入: 操作日誌段不是 SQLite 資料庫 — 來源 ${src}`);
  log('ERROR', `import-db rejected: log segment not SQLite ${src}`);
  process.exitCode = 1; return;
}
```
**v1.1 關鍵修正（R1#1 P0／R1#2 阻斷級實測）**：log 條用
`logBytes?.length && ...`——`l2=0` 空段＝無 log（合約 lib.rs:519），**不驗不拒**；
v1.0 字面 `logBytes &&` 會被空 Buffer（truthy）誤觸發 → 誤拒
`export-db --no-log` 自家正品＋app 端匯出（Rust `pack_db_container` 同產 l2=0）
走 CLI import 永被拒。同步把落地條 `if (logBytes)` 改 `if (logBytes?.length)`
——向 Rust `if !log.is_empty()` 對齊，**順手殲滅災難⑤**（空段清零 app-log 蟲）。
- 標記註解 `// D19: magic 守門`（驗證 fixed 判針＋順序釘錨點，須在 `backupDb()`
  之前——R1#3 mutC）。
- 凍結字面量（R1#3 mutE）：兩條拒絕 console 訊息均以 `❌ 拒絕匯入` 起頭，
  驗證腳本釘此精確字串＋exit 1；log('ERROR') 通道不得作為唯一載體。
- magic 純 ASCII（含尾 \0），latin1/utf8 判定全域相同（R1#3 mutD 等價變異
  實錘，免後續重复审疑）。
- 拒絕時不碰 backupDb/rmWal/writeFileSync/audit（守門在全部寫入副作用之前）。

自然封堵論證：路徑②的 raw-fallback 整檔以 `TENOC`(0x54 0x45 0x4E 0x4F 0x43)
開頭 ≠ magic → 守門自然擋下，unpackContainer 無需動（最小改動＋它被 selftest
:2262 共用，改它有連帶風險）。

### 可選項定案（憲法⑦）
- **log 段壞：全拒 vs 跳 log 只入 teno**：全拒。容器屬單一出品物，破損意義
  不明時不容「半套匯入」（使用者可能有理由相信 log 完整性）；重導出成本極低。
- **magic 長度門檻 100 bytes**：SQLite 標準 header 恰好 100 bytes（含 page
  size/encoding 欄），只驗 16 bytes magic 會放過「16 位 magic＋截斷」偽檔。
- **process.exitCode = 1**：做。新拒絕路徑應如實回報失敗；既有消費者零 exit code
  解析（D8 R1#2 下游盤點實錘 bot 只 parse stdout 前綴），回歸風險零。
- **修 unpackContainer truncated fallback**：不做（見上，守門已封堵＋selftest
  共用連帶風險）。
- **backupDb() 位置**：守門移到 `backupDb()` **之前**——拒絕時不覆寫故無需備份，
  避免每次誤傳垃圾都製造一個無意義 bak（backupDb 既有 TENO_NO_BACKUP 語意不動）。

## 4. 驗證方式（tools/verify-d19-import-magic.mjs，全 tmp DB，嚴禁碰真檔）
- T1 raw 真 SQLite → 匯入成功（回归釘：兼容 raw 是功能不是 bug）＋marker 覆蓋釘
  ＋T1b 成功後 audit_log 有記錄（雙向綠對稱迴歸釘，與拒絕路徑零記錄反例對稱；
  非「修後才綠」判別釘——R1#2 勘誤）。字節等式因成功路徑尾端 audit 寫入天然
  不成立（R1#2），內容以 marker 釘為準。
- T2 自組合法 TENOC 容器（真 SQLite ×2）→ 成功＋DB＝teno 段＋app-log 落地。
- T3-T6 拒絕路徑（凍結字面量 `❌ 拒絕匯入`＋exit 1）：
  T3 垃圾文字檔／T4 截斷容器（封堵 raw-fallback 整檔）／T5 容器結構完整 teno 段
  垃圾／T6 teno 真＋log 垃圾全拒——每條：DB 逐字節不變＋零 audit＋無 app-log 副作用。
- T7 回歸釘：檔案不存在提示不變；真實手機備份（raw，存在才跑否則 SKIPPED）匯入成功。
- T9（R1#1/#2 阻斷洞釘）`l2=0` 容器（逐字對齊 packContainer(includeLog=false)）
  → 匯入成功＋exit 0＋app-log.db 零觸及（不建立不清零）。
- T10（R1#3 mutB）真 magic＋截斷 32B/99B 偽檔 → 拒絕＋DB 不變（>=100 門檻釘）。
- T8 負控制：舊版 cmdImportDb 逐字反換（ORIGINAL_BLOCK 與 git HEAD byte-identical，
  R1#1/#3 雙席獨立比對實錘）→ 垃圾直入 DB＝垃圾字節＋照樣宣稱成功；
  T8d 順序釘（fixed 條件）：`// D19: magic 守門` 索引在 `backupDb()` 之前。

## 5. 風險
- 純攔截守門：合法輸入路徑（raw/container）行為逐字不動（T1/T2/T7 釘）。
- backupDb 移到守門後＝拒絶時不備份——拒絕本無覆寫，無損失（可選項定案）。
- cli.mjs 為 PM2 獨有檔；SR-C4 hunk 反剝既定程序。

## 6. 範圍外清單（憲法⑥）
- unpackContainer truncated fallback 本體語意（selftest 共用，另單）。
- import 前備份「來源檔」副本（新功能）。
- cmdRestore/cmdBackups/cmdDrive 的來源驗證（D7 已處 wal 面；magic 面各檔由
  app 出品信任鏈不同，本單只封 import-db 這個使用者手動入口）。
- CLI 全域 exit code 系統化（僅本路徑加）。
- **救援路徑（R1#1/#2 補登）**：目標 DB 已損壞/不存在時 CLI 頂層 :28/:30
  （readonly open＋settings 查詢）於 dispatch 前即 `file is not a database`
  crash——修前既存實測（垃圾目標、半壞目標、不存在三種全 crash），守門不改變
  此行為（零惡化）；「用好檔救壞 DB」需頂層 lazy open，另單。救援現行走
  cmdRestore/cmdBackups restore（bot /restore 路徑）。
- **l2 欄截斷靜默丟 log（R1#1 補登）**：`data.length < pos+4` 時 log=null 靜默
  成功「無操作日誌」——非破壞性但與全拒一致性相悖，另單。
- **100B magic＋垃圾的偽檔**：過守門（magic 級防護宣稱內），後果可 /restore
  回滾；page-size sanity 進階檢查非本單。

## 7. 審查紀錄
### R1（v1.0，3 委員）
- **#1 ✅ 有條件**：三災難路徑 tmp 實跑實錘（＋第四災難空檔直入）；latin1 magic
  逐字節、100B 門檻零誤殺（真 SQLite 最小 1 page 512B）；封堵論證結構閉合
  （TENOC 0x54≠magic 0x53，magic@0 合法與 teno 段≠整檔兩條件互斥）；exitCode
  下游獨立 grep 全盤點（bot.py import_db 是 Python copy2 非 spawn、UI runCli 僅
  sim/report、Rust run_cli 零 import-db、cron 零）。必修兩項（採納）：
  ①log 條 `logBytes?.length`（空 Buffer truthy 誤拒正品實測）＋l2=0 正例釘＋
  順修落地條殲滅災難⑤；②救援路徑 crash edge 登記 §6。
- **#2 ❌（阻斷級實測）**：以 v1.0 逐字修法建 mutant，`packC(真SQLite, null)`
  → 修前 ✅ 已匯入／mutant ❌ 拒絕 exit 1——誤拒 `export-db --no-log` 與 app 端
  匯出（Rust pack_db_container 同產 l2=0，合約 lib.rs:519 len=0＝無 log）；
  同根既存蟲 app-log 清零實測 20B→0B。五點修訂全採納：守門 length 判別、
  落地條 `?.length`、T9 正例釘、§4 T1 措辭（audit 後字節等式不成立）、
  T1b 宣稱改雙向綠。mutant 全釘集 27/27 複跑＋成功路徑 stdout 逐字對比＋
  拒絕零 bak 驗證。
- **#3 ❌（兩洞）**：變異矩陣 mutA/mutE/mutF 殺死✅、負控制 byte-identical✅、
  合規基準 27/27 全綠可達✅。①mutB 阻斷：`>=16` 變異全綠存活（無截斷偽檔測資，
  後果同原 bug 級）→ T10 補 32B/99B 釘；②mutE 阻斷：寬鬆 '拒絕' 匹配可被
  log() 雙通道稀釋（只在 ERROR 行殘留即全綠）→ 凍結 `❌ 拒絕匯入` 字面量；
  ③mutC 登記：守門錯序在 NO_BACKUP 域不可偵測 → T8d 源碼順序釘；
  ④mutD 等價變異（utf8/latin1 對 ASCII magic 全域相同）不列洞、計畫註記。
- v1.1 變更：§1 災難④⑤、§3 守門代碼凍結＋`?.length` 雙修正＋字面量凍結＋
  順序釘錨點、§4 T9/T10/T8d＋T1b 勘誤、§6 補登三筆。

### R2（v1.1 複審，R1 ❌ 兩席 #2/#3）— 全席 ✅ 過審
- **#2 ✅（阻斷級原提人）**：`?.length` 雙修正 diff 實錘、語意對齊 Rust
  lib.rs:519/576；變異牙檢 mut-gate（守門還原 `logBytes &&`）→ T9a 轉紅、
  mut-land（落地還原 `if (logBytes)`）→ 預置 8192B app-log 清零實測＋T9b 轉紅
  （不建立/不清零雙面向皆偵測）；T9 測資與 packContainer(includeLog=false)
  逐字節 equals=true（514B）忠實重現；T7b 真機 raw 檔在場實跑非 SKIPPED；
  R1 五點修訂逐項閉合；SR-C4 hunk 與 D19 段零交互確認。
- **#3 ✅（變異矩陣專席）**：四變異體全殲——mutB(>=16)→T10 雙紅、
  mutDel(刪守門塊)→T3-T6 十六釘全紅、mutC(守門後移)→T8d 紅（且已修 R1 殘留
  全域 indexOf 越函式誤匹，區段限定比對）、mutLit(去 ❌ 匯入)→凍結字面量釘紅
  ＋寬鬆匹配反事實實錘；T8 ORIGINAL_BLOCK 822B 與 git show HEAD 區段
  BYTE-IDENTICAL 獨立比對＋反空洞釘在位；判針純度：拒絕斷言只用
  `❌ 拒絕匯入`＋stdout 通道＋exit 1，寬鬆 '拒絕' 僅存註解；mutD 等價變異
  utf8===latin1 實測 true 數學必然，不列洞成立。非阻斷觀察：T10 未附字面量
  釘（後果「未拒即紅」已由 T3-T6 覆蓋字面量，非漏洞）。
- 裁決：全席 ✅ → 動工。commit 程序：SR-C4 hunk 反剝→回歸→commit→原樣還原。
