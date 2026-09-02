# D16 修復計畫 — TENOC 容器 version byte 未驗證＋trailing garbage 不報錯

狀態: v1.1（R1 三委員 ✅ 後吸收案：錯誤訊息教學化／驗證腳本 T3 加 v0 向量＋T3b2 內容級釘＋前綴匹配防漂移／cargo 測試補訊息斷言）
日期: 2026-08-28
審計來源: bug-audit-2026-08-13.md（宣稱 lib.rs:518-540，實際行號 2026-08-28 實錘漂移至 :580-611，原因＝F9/F12 在其前插入 download_url_to_file 等碼）

## 1. Bug 定義（行號實錘）
`unpack_db_container`（lib.rs:580-611）三處寬容缺陷：
1. **:593 version byte 讀而不断**：magic 檢查僅 `data.len() < 6`，`data[5]`
   （version）從未比對——`TENOC\xFF` 開頭照收。pack 端（:571）恆寫 `1u8`，
   未來 v2 容器或位元翻轉檔會被按 v1 語意硬解析。
2. **:609 回傳前不查 pos==len**：log 段之後多餘位元組（trailing garbage，
   下載中斷拼接/磁碟損壞/手改檔）靜默丟棄回 Ok。
3. **【本首相掃描補登，同族第三病灶】:603 log 長度欄缺位靜默降級**：
   `if let Some(log_len)`——容器在 teno 段後直接結束（少了 log 長度欄）時
   靜默視為無 log 回 Ok。pack 端恆寫 log 欄（含 len=0），缺欄必為截斷損壞。

## 2. Root cause
防寫時寬容解析（Postel's law）用在資料覆寫入口＝偽損壞接受面：
容器是「解包後直接覆寫 teno.db＋app-log.db」的入口（write_db_bytes :629／
import_db_dialog :659），靜默容錯＝半壞資料以健康姿態覆寫好 DB，零回聲。
同波次族譜：D19（CLI import magic 守門，PM2 已修）、F12（404 錯誤頁落盤）
同屬「入口嚴格、拒比收安分」。

## 3. 修法（lib.rs unpack_db_container 內，三 hunk）
- h1 version 守門：magic 段後 `if data[5] != 1 { return Err(format!("容器版本不支援: v{}（本版 Teno 僅支援 v1，請升級）", data[5])) }`
- h2 trailing 守門：log 段解析後（含 SQLite raw 分支不動）
  `if pos != data.len() { return Err("容器損壞: 尾部有多餘資料") }`
- h3 log 欄缺位改拒：`match read_u32(pos) { Some(l)=>{...}, None => return Err("容器損壞: 缺少 app-log 長度欄位") }`
  （注意順序：h3 使 teno 段後必需要 log 欄；现有測試 `TENOC\x01\x10...ABCDEF`
  等截斷向量早已在 teno 段就 Err，不經 h3）

### 3.4 不做（憲法⑦可選項定案）
- 不做版本白名單陣列（只收 v1，未來 v2 出現時再擴，避免幽靈版本碼）
- 不動 raw-SQLite fallback 分支（D19 已 Magic 守門＋E10 已契約立法
  「CLI 端容錯＝正確分層」，向後相容釘 :1787 不動）
- 不動 pack 端（寫端本来就精確）
- drive_sync.rs:375 註解「unpack 靜默忽略 trailing——此處無害」將於修法後
  過時：行為只變嚴不變鬆（合法容器零影響），註解過時屬 PM4 檔 → 範圍外登案

## 4. 驗證方式（tools/verify-d16-container-strict.mjs）
- T0 cargo test --lib container 全綠（既有釘 round-trip×2/raw fallback/截斷×3
  零改全過＝零誤殺主證）＋新向量在册（version=0/2/255 拒、trailing 位元組拒、
  log 欄缺位拒、正確 round-trip 仍 Ok）
- T1 真碼提取：unpack_db_container 純函數（&[u8] 進出，零 fs 依賴）節點提取→
  rustc 獨立編譯→向量機（新舊行為矩陣）
- T2 格式互通釘：真碼提取 cli.mjs packContainer（JS 端）輸出位元組 → Rust
  unpack 必 Ok（CLI 生產的容器零誤殺，CLI↔Rust 雙端契約）
- T3 負控制（**pin 靜態 hash `81125ff`**，F12 commit＝unpack 現狀最後快照，
  免 HEAD 腐化——F9 教訓）：git show 81125ff:src-tauri/src/lib.rs 提取舊
  unpack_db_container → rustc 編譯 → version=255＋trailing 檔 **Ok**（bug
  徵狀精準重現）
- T4 結構釘×3＋回歸 verify-d19/d7/e10（容器契約域）

## 5. 風險
- 合法容器零誤殺論證：Rust pack（:563-578）與 CLI packContainer（cli.mjs:2250）
  皆精確寫 magic+1+段+段、無 trailing；既有真機檔（手機備份 TENOC\x01 頭）
  同格式。version 恆 1。
- drive_sync.rs 調用端（PM4 域）只變嚴：合法 v1 容器零影響。
- 歷史髒檔：若使用者手上有「trailing 破損但舊版能吞」的備份，修法後拒收——
  此為目的非副作用（拒收半壞檔正是 D16 目的），錯誤訊息教學版。

## 6. 範圍外（登案）
- drive_sync.rs:375 過時註解更新（PM4 域）
- 容器格式升版機制（version 協定文件化）
- pack 端無 checksum（sha256 併 F9 §6 既呈總統）
- 【R1#1-次要1】段級 magic 殘洞：結構合法但 teno 段為垃圾/零長的容器新碼仍 Ok，
  `write_db_bytes`/`import_db_dialog` 兩入口無 D19 式段級 SQLite magic 守門
  （drive 端 D11 已補）→ 另單：兩入口比照 D19 判別子或 unpack 內補段級 magic
- 【R1#1-次要2】32 位元溢出 panic（pre-existing，新舊碼 i686 對跑同死）：
  `pos + len as usize` 於 armv7/i686 release 可 wrapping 越過截斷檢查→slice panic
  （panic 先於寫盤，無腐壞風險僅 DoS）→ 另單改 checked_add
- 【R1#2 存量掃描】3 檔 0815 手動修復產物（尾部 4092B 全零）將被 trailing 守門
  拒收＝政策預許「拒收半壞檔」；救回路徑已實證（CLI import-db 寬容版吃入→
  export-db 重產嚴格容器）＋Err 訊息已教學化（v1.1）；存量 182 檔掃描其餘零誤殺

## 7. 審查紀錄
### R1（2026-08-28，3 委員 sequential leaf delegate，全 ✅）
- #1（修法正確性）✅：三病灶 HEAD 實碼屬實、三 hunk 與 §3 逐字一致、守門先於
  寫盤逐消費者 trace（write_db_bytes/import_db_dialog/drive_download 皆先
  unpack? 後寫＝拒絕路徑零寫盤）、自構 15 邊界向量零誤殺零漏網（含雙容器拼接拒）、
  負控制 pin 81125ff 與 HEAD unpack byte-identical 屬實、D19/D11/E10/D7 契約零回歸
  （verify-d19 32/32 d7 18/18 e10 9/9 d11 16/16）。次要×2→§6 登案另單。
  nit：§1 行號再漂移（unpack 實際 :580-609，病灶 :588/:601/:608，pack push(1) :572）。
- #2（零誤殺＋存量）✅有條件：消費者 3 呼叫點 UX 後果逐列（toast 可見錯誤零崩潰、
  import 前已 backupDb 拒收時現網 DB 未動）；真機 182 檔 byte-level 掃描僅 3 檔
  手工修復殘留被拒（→§6）；Rust pack vs CLI packContainer 位元組級同構論證＋交叉
  餵實跑；反向相容（pack 零 hunk）成立。次要：Err 訊息非教學式→v1.1 已修。
  事故通報：委員誤用 `export-db` 位置參數覆寫 ~/桌面/teno-backup.db，已即時用
  live DB 重匯出逐位元組一致還原，倉庫零污染（誠實登記）。
- #3（變異牙檢）✅：11 變體（M-a 單守門/M-b `>1` 誤收 v0/M-c 恆假/M-d 缺 pos+=4
  錯位誤殺/M-e 死碼順序/M-f 刪測試/M-g1,g2 pin 浮動/M-h 訊息改詞/M-i 守門錯位/
  M-k 奇偶狡猾版）0 逃逸；行為斷言獨立有牙非文字式；commit 純度 55+/7− 無夾帶。
  次要×2→v1.1 已吸收（T3 加 v0 雙臂＋T3b2 內容級釘）。
- v1.1 吸收清單：trailing/log 欄 Err 訊息教學化（含 CLI 救回指引）、T3e/f 改
  startsWith 防輸出漂移、cargo 測試守門 2/3 補訊息級斷言、本節＋§6 補登。
