# D17 修復計畫 — backup_db 同秒檔名碰撞覆寫

狀態: v1.1（R1#1 ✅ 吸收 M-1 nanos u128 截斷鉗位＋M-2 備份 0600 權限；§5 溢出鏈措辭按委員實證勘誤）
日期: 2026-08-28
審計來源: bug-audit-2026-08-13.md（宣稱 lib.rs:1218-1221，實際行號 2026-08-28 實錘漂移至 :1290-1303，原因＝D16/F12 波在其前插碼）

## 1. Bug 定義（行號實錘）
`backup_db`（lib.rs 修法前 :1291-1303）：
1. **:1296 秒粒度時間戳命名**：`as_secs()` → `teno-<秒>.db`
2. **:1299 fs::copy 覆寫語意**：同秒第二次備份（手動連按／scheduler＋手動交錯／
   CLI+app 雙渠道）目的地同名，`fs::copy` 對已存在檔 **截斷覆寫**——徵狀＝
   「按兩次備份按鈕，備份列表只多一條」，第一快照幽靈消失，零錯誤零回聲。

補充掃描（同族面）：`prune_backups`/`list_backups` 名稱解析皆走
`teno-<u64>.db` strip+parse＋`ts > 1e11 → /1e9` nanos→secs 換算启发式
（源碼註解自供 "old backups used nanoseconds"＝nanos 命名是本系統**原生格式**，
历史上用過、後來降秒粒度時保留了換算分支）。CLI `cmdBackups` 走完全不同格式
（`teno.db.bak-<14位>` 於 app_dir 頂層），零重疊。

## 2. Root cause
檔名唯一性建立在「秒」這個呼叫方無法保證互斥的时间粒度上，且寫入端選了
覆寫語意的 fs::copy。兩渠道（前端 backup-scheduler.js:33 tick 與 settings.js
手動、共 4 呼叫點）間無協調，同秒可達性真實存在（用戶連點、checkpoint 後
快速接連觸發）。

## 3. 修法（lib.rs 兩 hunk）
- **h1 新純函式 `unique_backup_dest(backups_dir, ts_ns)`**（:1290-1307）：
  `File::options().write(true).create_new(true)`（O_EXCL 原子建立）；
  `AlreadyExists` → ts `saturating_add(1_000)`（前进 1µs）重試，上限 10000 次
  （目錄病態時明確 Err 不死迴圈）；回傳 (已建立檔柄, 路徑)——建立與寫入零
  TOCTOU 窗口（O_EXCL 成功那一刻檔名即被本檔獨佔）。
- **h2 `backup_db` 重寫**（:1309-1326）：命名 `as_secs()`→`as_nanos()`（既有
  nanos 原生格式，名稱解析端 list/prune **零改動**）；委派 unique_backup_dest；
  `std::fs::copy` → `std::io::copy(src, &mut 檔柄)`；複製失敗 remove 半成品
  （零 0B 幽靈備份入列表）。
- 新 cargo 單元測 `backup_naming_tests::d17_same_ts_never_overwrites`：同 ts
  三連呼名稱兩兩相異＋首檔 SNAP0 零覆寫＋nanos 名稱過解析契約＋手刻同名檔
  零碰（攻擊面）。

### 3.4 不做（憲法⑦可選項定案）
- **不動 list_backups/prune_backups 解析端**：nanos 是既有原生支援格式，改動
  反而擴大回歸面；換算启发式在位由驗證 T2d/T2e 源碼釘守住。
- **不做「同 ts 覆寫舊 nanos 檔」的語意掙扎**：O_EXCL 語意就是永不覆寫任何
  既有檔（含手刻垃圾檔）——備份域寧可多一個檔不可少一個快照。
- **不順手修 D5（fs::copy 無 WAL checkpoint → 備份缺最近複習）**：同函式不同
  病灶；D5 正解在前端 choke point checkpoint（D5-SR1 已登案待裁示，白名單外），
  本單 nanos+O_EXCL 對 D5 語意零干擾（copy 源仍是 teno.db 本體）。
- **不做 prune 同秒 nanos 檔間排序穩定性**：換算成秒後同值 tie，prune 由
  entries 首端刪起語意在「同秒多檔」下刪哪條皆無損（同秒備份內容近同）。

## 4. 驗證方式（tools/verify-d17-backup-collision.mjs）
- T0 cargo backup_naming 全綠＋計數下限釘＋container 域鄰域回歸
- T1 真碼提取 unique_backup_dest（純 std 零 AppHandle）→ rustc 向量機：同 ts
  五連呼名稱互異＋首檔 S0 留存＋檔數 5＋步進精確 1000ns＋手刻同名檔零碰
- T2 解析契約釘：真實 nanos 名稱餵 list/prune 鏡像解析（±60s 合理秒）＋舊秒
  名稱不劣化＋混存同基準可比＋**兩端換算源碼釘在位**（防順手重構解析端漂移）
- T3 負控制（**pin 靜態 hash 0096e88**＝D16 commit，backup_db 舊命名最後快照，
  免 HEAD 腐化——F9 教訓）：舊語意 rustc 重構（同 ts＋File::create 截斷）→
  SAME_PATH:true＋首檔 S0→S1 覆寫＋FILE_COUNT:1 徵狀精準重現；判別性釘＝新碼
  同 ts 兩檔 S0 留存（新舊對跑非兩邊空轉）
- T4 結構釘×4（委派/as_secs 殲滅/fs::copy 殲滅/半成品清理）＋cargo check host
- 首相實跑：**27/27 ALL PASS**

## 5. 風險
- 名稱值域（**v1.1 勘誤，R1#1 鏡像實證推翻原措辭**）：nanos 2554-01-01 越 u64
  後，溢出源 `as_nanos() as u64`（u128→u64 截斷 wrap）**不會**如 v1 所稱被
  `parse().ok()?` 跳過——wrap 值仍是純數字→`<1e11` 直通秒分支→新檔被當 1970
  年→prune 首端**新備份優先被刪**（排序錯亂非顯示降級）。v1.1 已修：
  `.min(u64::MAX as u128)` 鉗位，溢出場景退化為連撞 Err（響亮失敗）。
  混存（秒檔＋nanos 檔）經換算同基準，實證正確（#1 鏡像 M1/M2 PASS）。
- 第三方消費者：Discord bot 無 backups 域代碼（grep 零）；CLI cmdBackups 走
  不同目錄不同格式零重疊；還原/刪除/匯出皆透傳檔名字串零解析假設。
- O_EXCL 在 rare 檔案系統（網路盤）不保證原子：app_config_dir 是本機
  XDG 目錄（Android 為 app 私有區），非 NFS 場景，可接受。
- 複製失敗路徑多一次 remove_file：刪的是自己剛 create_new 的半成品，語意安全。

## 6. 範圍外（登案）
- D5 WAL checkpoint（同函式不同病灶，前端正解 D5-SR1 已登案待裁示）
- prune 換算 `>1e11` 對「未來 5138 年秒名」的遠端启发式脆弱性（併 nanos 溢出
  一條登案，非近端）
- backup_db 失敗重試退避（現有呼叫端 catch toast 呈現，屬 UX 另案）
- CLI cmdBackups `bak-<14位分鐘>` 同分鐘碰撞（同族病灶不同域，D7 已登記其
  死正則條目，擴充此域需 CLI 白名單）

## 7. 審查紀錄
### R1（2026-08-28，3 委員 sequential leaf delegate，全 ✅）
- #1（修法正確性＋邊界攻擊）✅：三 hunk 與 §3 一致、nanos 启发式源碼在位、
  解析端 byte 級零改；重跑 27/27＋cargo 1/1；自建 8 攻擊向量（u64::MAX 連撞
  Err@12ms 終止、10000 上限實觸發、mode-000 檔 EEXIST 走換名非 Err、目錄不可寫
  EACCES 立 Err）全過。**M-1（採納）**：§5 溢出鏈原措辭不實——`as u64` 截斷
  wrap 非 parse 跳過，真鏈＝1970 排位 prune 首端新檔先刪→v1.1 `.min(u64::MAX
  as u128)` 鉗位＋§5 勘誤；**M-2（採納）**：fs::copy 保權限位元→create_new 0644
  世界可讀隱私回歸→`.mode(0o600)`（F11 同課）＋cargo 0600 斷言；nit 行號×3。
- #2（Android/跨平台＋回归母）✅：aarch64/x86_64-linux-android 純 std 隔離
  crate cargo check 雙綠（整包 check 掛 NDK clang 缺席＝環境限制非代碼，ring/
  oboe build script，老實登記）；tauri-2.11.3 源碼鏈實查 app_config_dir→
  PathPlugin.kt dataDir=/data/user/0/com.teno.app（內部儲存 ext4/f2fs 沙箱，
  非 FUSE）→0600 生效；FUSE 假設情境＝與舊碼持平非回歸；前端 4 呼叫點回傳全
  丟棄零假設、列表用 b.timestamp 非檔名（19 位數透明）；還原鏈 file_name()
  消毒鏡像＋穿越攻擊仍安全；混存 prune 鏡像（自寫雙軌）正確；ts=0/時鐘回撥三
  情境實測安全。Info×2（同秒 prune tie、Windows cfg 備註）。
- #3（變異牙檢）✅：11 變體矩陣 10 撓 1 逃逸——M-c create覆寫復活 9 腿紅、
  M-e token 假在位（add-sub 淨零）行為層戳破、M-j2 恆真鉗位結構釘獨立紅、
  M-h 內聯死碼恰 T4a 紅、M-i 浮動 pin 恰 T3a 紅；**F-1（採納）**：無上限
  loop{} 變體 29/29 全綠逃逸（腳本無終止性探針）→v1.1 補 T1-6/7 飽和連撞
  timeout 探針（無上限變體非零退出即紅）；**F-2（採納）**：T4f 被註解 token
  騙過→緊釘改 `.create_new(true).mode(0o600)` 鏈式形；**F-3（採納）**：harness
  panic 混 stdout 致 BigInt SyntaxError 崩腳本失後段情報→T1-z 輸出乾淨釘前移
  爆紅。產物 /home/jupiter/tmp/d17/（變體樹+矩陣日誌）。
- v1.1 吸收清單：M-1 鉗位＋§5 勘誤・M-2 0600＋cargo 權限斷言・F-1 終止性探針
  ・F-2 鏈式緊釘・F-3 韌性釘。驗證 v1.0 27/27→v1.1 **32/32 ALL PASS**。
- 首相誠實登記：T1 harness 初版 `let ts = args3()` 於 fn 宣告前——Rust 嵌套 fn
  合法未觸錯；误發一次 PLACEHOLDER patch 為 fuzzy no-op（diff 覆核無損）。
