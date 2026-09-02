# D7 修復計畫書 v1.1（2026-08-28，首相2／PM2 域）

## 1. Bug 定義
CLI 覆寫 `DB` 主檔前不刪 `-wal`/`-shm` 旁檔：舊 WAL 混入新主檔後，SQLite
讀取行為未定義（stale 頁复活／malformed／checkpoint 覆寫還原內容）。
佇列指認 `cmdRestore`（cli.mjs:1476-1483，行號實錘相符）：裸 `copyFileSync`。

## 2. Root cause＋類缺陷穷举（憲法：修類不修點）
CLI **四條**「覆寫 DB」destructive 路徑（v1.0 漏報 drive download，R1#1 委員
逮到——Rust 鏡像 `drive_sync.rs:360-364` 對同款操作明確 remove wal/shm＋
tmp→rename，註解標「D2 同源」，CLI 移植時抄漏），三條有缺陷：
| 路徑 | 覆寫前備份 | rmWal | 備註 |
|---|---|---|---|
| `cmdRestore` :1480（`restore <檔>`） | ✗ 缺 | ✗ 缺 | 佇列主因 |
| `cmdBackups` restore 分支 :3244 | ✓ | ✗ **缺** | **Discord bot /restore 實際路徑**（bot.py:192 `run_cli("backups","restore")` 實錘） |
| `cmdDrive` download 分支 :3218 | ✓（`.bak-sync`） | ✗ **缺** | R1#1 補列；Rust 鏡像正面教材 |
| `cmdImportDb` :2205-2218 | ✓ | ✓（本地 rmWal :2212） | 正面教材，本地定義頂層化 |
其餘寫點全清（R1#1 独立穷举：其他 copyFileSync/writeFileSync 非 DB 目標；
backupDb 寫新 dst 非覆寫；sim DB 獨立檔；Rust 側 lib.rs 三處全正面；
renameSync/moveFileSync 對 DB 零命中）。bot 呼叫鏈：三個 run_cli 呼叫點
`backup`(:139)/`dash`(:171 唯讀)/`backups restore`(:192)，無其他寫 DB 途徑
（v1.0「僅三命令」措辭已按 #2 委員更正）。

## 3. 修法（tools/cli.mjs，單檔）
### 3.1 頂層 helper（放 `backupDb` 旁，**本體逐字含 per-file try/catch**，R1#2 警示：
`force:true` 只吞 ENOENT，EACCES/EPERM 會 throw， snippet 不得簡化）
```js
// D7: 覆寫 DB 主檔前清掉舊 WAL/SHM，避免 SQLite 讀到舊狀態
const rmWal = (p) => { for (const s of ['-wal', '-shm']) { try { rmSync(p + s, { force: true }); } catch {} } };
```
### 3.2-3.5 四處呼叫點（**契約字面量凍結**——縮排逐字、triple 內禁插任何文字／
重排順序，否則驗證腳本 T1 掛＋T5 誤診鏈，R1#3 P2）：
- FIX_RESTORE（cmdRestore，`copyFileSync(file, DB);` 前）：
  `  backupDb();` + `  rmWal(DB);`（即 triple：backupDb→rmWal→copyFileSync）
- FIX_BKRS（cmdBackups restore，現 `backupDb();` 與 `copyFileSync(...)` 之間插）：
  `    rmWal(DB);`（4 空格縮排）
- FIX_DRIVE（cmdDrive download，`copyFileSync(DB, \`${DB}.bak-sync\`);` 與
  `writeFileSync(DB, buf);` 之間插）：`    rmWal(DB);`
- FIX_IMPORT（cmdImportDb）：刪本地 `const rmWal = ...` 行，呼叫不改。
契約五字面量（FIX_RESTORE/FIX_BKRS/FIX_DRIVE/TOP_DEF/BAK_RE）以驗證腳本頭部
常數為唯一權威，動工前已凍結。

### 可選項定案（憲法⑦）
- **restore 補 backupDb()：做**。restore 為破壞性覆寫，全庫 27 寫入路徑慣例
  覆寫前備份，唯 restore 漏網（import-db/drive/backups restore 皆有）；使用者
  明文「動手前先備份」。
- drive download 改 tmp→rename 對齊 Rust：不做（本單只補 rmWal 消同類缺陷；
  tmp→rename 涉及網路分支重構，登範圍外跟進）。
- app-log.db 的 wal：不做（restore/backups/drive 均不觸 app-log）。
- `DB` 主檔不存在 edge：R1#2 實測 CLI 在頂層 :27 即 crash（到不了 cmdRestore），
  現存共享 edge，不動 backupDb 語意，登範圍外。

## 4. 驗證方式（tools/verify-d7-restore-wal.mjs，tmp DB＋假 HOME，嚴禁碰真檔）
- T1a-f 靜態：頂層定義在場／全檔唯一定義（const+function 兩式計數，防 #3 P5
  雙定義規避）／四呼叫點契約字面量。
- T2 `restore` 實跑：垃圾 wal/shm 必刪＋`.bak-YYYY-MM-DDHHMM` 生成（BAK_RE
  對齊 backupDb 實際 stamp 分鐘粒度，R1#2/#3 P1）＋bak 內容＝覆寫前舊值（時序釘）。
- T3 `backups restore` 實跑（bot 路徑，假 HOME）。
- T4 `import-db` 回歸釘：頂層化零行為變化。
- T5 負控制：反剝三 FIX → 殭屍 wal 存活＋無 bak 精準重現；T5a 反空洞條款
  （buggy!==src 實剝證明，R1#3 P3）。
- **斷言強度登記（R1#3 P4）**：T2b/T3b/T4b 為「存廢斷言非時序斷言」——單進程
  內先 copy 後 rmWal 終態等價，崩潰窗口不可測（§4 前提：不賭 SQLite 未定義
  行為）；rmWal 時序的唯一 enforcement ＝ T1c/d/f 契約字面量，故契約逐字不可動。

## 5. 風險
- restore 新增備份檔 → 磁碟多檔（prune 機兼容：mtime 最新必入保留窗；bot
  list_backups glob 可見）。
- backupDb stamp **分鐘粒度**（ISO slice(0,14) 砍秒）：同分鐘兩次 destructive
  操作 → bak 靜默互覆。既存語意（27 呼叫點同款），如實登記非新引入。
- 平面拷貝備份在 app WAL 併發下可能漏未 checkpoint 頁／撕裂：既存共享語意
  （import-db 現行同序），修法未引入未惡化；正解範例＝export-db 的
  `wal_checkpoint(TRUNCATE)`（:2163），登跟進單。
- rmWal 時 app 活躍持有 WAL：POSIX unlink 後 app 續寫殭屍 fd——import-db/Rust
  路徑既存接受面，同登 §6。
- cli.mjs 為 PM2 獨有檔；SR-C4 hunk commit 前反剝（既定程序）。bot 零改動。

## 6. 範圍外清單（憲法⑥）
- backupDb 改 checkpoint 快照（跟進單，引用 export-db :2163 範例）。
- drive download tmp→rename 對齊 Rust drive_sync.rs:360-364。
- DB 主檔不存在頂層 crash edge（:27，既存）。
- 殭屍 wal 毒理／SQLite 未定義行為斷言。
- cmdBackups 自列 filter 同款死正則 `\d{14}$`（:3230，靠 `/^teno\.db\.bak/`
  逃生枝免爆——R1#2/#3 旁證，既存，另案）。
- api.db 匯入式呼叫共用過期 ro handle（#2 委員旁證，bot 走 subprocess 不受影響）。
- TENOC magic 驗證（D19 獨立單）。

## 7. 審查紀錄
### R1（3 委員）：#1 ❌ / #2 ✅有條件 / #3 ❌
- #1：逮第四條路徑 drive download（Rust 鏡像同源鐵證）→ v1.1 §2/§3 補列＋T1f
  靜態釘；bot 鏈路措辭修正；backupDb 時機正確判定＋撕裂屬既存語意判定採納。
- #2：五面全 ✅ 但阻斷級發現 bak regex `\d{14}$` 對真實分鐘戳永不到達（T2c/T2d
  永紅、T5c 虛斷言）→ BAK_RE 修正；rmWal snippet 漏 per-file try/catch → §3.1
  凍結本體；假 HOME 生效性／ro handle 零妨礙（實測）／prune 兼容全部背書。
- #3：變異矩陣 A–E：mutA（漏 backups）T1d+T3b 雙牙、mutC（漏 backupDb）三牙、
  mutD（backupDb 放 copy 後）T2d 獨紅時序牙實錘、mutE（漏 -shm）三連紅；
  mutB（rmWal 錯序）runtime 無牙但契約字面量擋死→P4 登記；P1 regex／P2 契約
  凍結進計畫／P3 T5a 反空洞／P5 T1b 防 function 式全採納。
### R2（#1、#3 兩席複審）：全 ✅ 放行
- #1：drive download 補列三處閉環（§2 表格/FIX_DRIVE 契約/T1f 靜態釘）實測
  到位；driveBody 切片範圍含目標兩行＋錨點唯一性實錘；R1 全部發現逐條落地。
  非阻斷登記：T2/T4 假 HOME 未覆寫但所有寫點收斂 tmp（實測零真檔寫入）；
  drive 無 runtime 牙（需網路）唯一 enforcement＝契約，§4 已承認自洽。
- #3：fixclean 重造（四步逐字）×v1.1 腳本 → **18/18 ALL PASS 零摩擦**（契約
  凍結有效性實證）；mutF（drive 漏修）恰紅 T1f 獨牙；mutB2/B3 錯序由契約精準
  攔截＋T2d 意外實牙（錯序備到新值）；T5a 反空洞在契約相容域內真實發火、
  錯序域由 T1 兜底無假綠逃逸；BAK_RE 對真 stamp `bak-2026-08-271918` 匹配
  實錘（舊 `\d{14}$` 永否）。
