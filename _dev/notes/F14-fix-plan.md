# F14 修復計畫書 v1.4（2026-08-28, PM3；v1.0→v1.4 歷程見 §7）

## 1. Bug 定義（實測徵狀）
`log_msg`（lib.rs:1208-1213）把前端 console 轉發的任意字串 `create(true)
.append(true)` 附加寫入固定路徑 `/tmp/teno-monitor.log`。世界可寫目錄＋
固定檔名：攻擊者預先 `ln -s ~/.bashrc /tmp/teno-monitor.log`，受害者的
Teno 啟動後每一筆 console log 都附加進 `.bashrc`（寫入內容前端可注入＝
arbitrary-append 原語；O_CREAT|O_APPEND 無 O_EXCL 遇 symlink 跟隨）。
Android /tmp 不存在→靜默失敗（現況等於無鏡像）。

## 2. Root cause（源碼實錘 HEAD 776cb5c，行號 1211 吻合 audit）
`std::fs::OpenOptions::new().create(true).append(true).open("/tmp/teno-monitor.log")`
——共享目錄固定路徑、零跟隨防護。

## 3. 修法（唯一改動檔：src-tauri/src/lib.rs）
1. 新純函式 `open_monitor_log(dir: &Path) -> Option<File>`：
   `OpenOptions::create(true).append(true)` ＋
   `cfg(any(target_os="linux", target_os="android"))` 下
   `custom_flags(O_NOFOLLOW)` ＋ `mode(0o600)`（F11/F17 私檔慣例）。
   O_NOFOLLOW 為**原子守門**：目標為 symlink 時 open 直接 ELOOP 失敗回
   None，零「檢查-使用」窗口、不新增 dep。**R1#3-F-1 勘誤（v1.1）**：
   ① `target_os="linux"` 在 Android 為 **false**（android/linux 互斥，
   const assert 實錘）——v1.0 gate 會把守門碼在全部 Android ABI 剔除成
   死碼，v1.1 改 `any(linux, android)`；② O_NOFOLLOW 非跨架構通用值
   （glibc/bionic x86/x86_64=0x20000、arm/arm64=**0x8000**（arm64 上
   0x20000 係 O_LARGEFILE）、riscv64=0x400000），v1.1 用 per-arch
   `cfg!` 常數表（零 dep）；矩陣外架構常數=0→不設 flag，退化僅目錄隔離
   （fail-toward-isolation，不比現況差）。
2. `log_msg` 加 `app_handle: tauri::AppHandle` 參數（tauri 自動注入，前端
   invoke 簽名零變動），改寫 `app_log_dir()/teno-monitor.log`（tauri 開機
   自建該目錄，使用者私有＝ symlink 預植攻擊面根源消除）。失敗靜默跳過
   （除錯鏡像本體 non-critical，與現況語意一致）。
3. O_EXCL 可選項**不做**（憲法⑦）：log 附加語意下每次重啟 O_EXCL 撞 EEXIST
   要疊换名邏輯，收益與 O_NOFOLLOW 重疊，不採。

## 4. 驗證方式（tools/verify-f14-monitor-log.mjs）
- T0 cargo：f14 unit test 計數釘＋cargo check。
- T1 真碼提取向量機（rustc mini crate，開源碼原樣零改動——純 std）：
  正常雙附加順序與內容、symlink 預植→回 None 且受害者檔零增寫、0600、
  目錄不存在→None 不 panic。
- T2 負控制（pin 776cb5c 靜態 hash）：舊 log_msg 開啟語意原樣提取，**僅**
  把字面 "/tmp/teno-monitor.log" 換成 tempdir 路徑（regex 命中恰 1 次斷言，
  D17 變異學），symlink 預植→受害者檔被附加＝徵狀精準重現；判別性釘新舊
  對跑同場景一紅一綠。
- T3 結構釘：log_msg 經 app_log_dir＋open_monitor_log；O_NOFOLLOW 旗標在位；
  lib.rs 零殘留 "/tmp/teno-monitor.log"；前端 main.js:52 簽名零變動；
  CLI 舊預設路徑 SR 已落盤。

## 5. 風險
- 【v1.4 治理註明】T3i 白名單＝**函式名級**登記：同名函式體大改長出新寫
  路徑不等於語意重新背書——白名單更動必須與 diff 同評（R4#2  advisory）。
  T3h CANON_LM 演化指南：改 `log_msg` 必**同 commit** 更新 CANON_LM，
  嚴禁為過燈而繞過釘（先改釘再改碼＝流程倒置，審查應拒）。
- O_NOFOLLOW 硬編碼錯值失敗方向：**R1#3 勘誤——錯值典型後果是 fail-open
  （未定義 flag bit 內核照收靜默不設防），非 v1.0 所稱「ELOOP 誤傷→T1
  紅」**。補牙＝T4 三 target 編譯釘（aarch64/x86_64-linux-android＋
  aarch64-unknown-linux-gnu）＋編譯期 const assert 反 cfg 死碼＋T3c2
  常數表結構釘。
- 鏡像檔搬家＝依賴 `/tmp/teno-monitor.log` 的外部工具斷路：本庫消費者窮舉
  ＝tools/cli.mjs:1476 與 _dev/cli/cli.mjs:1292 預設參數（均可傳參覆蓋）→
  F14-SR1 登案（cli.mjs 他軌在製髒檔禁夾帶）。
- app_log_dir 取得失敗（極端）→靜默無鏡像＝Android 現況語意，可接受。
  Android 淨效果＝嚴格改善（現況 /tmp 不存在必敗→首次可用鏡像；tauri
  plugin-log 開機 create_dir_all LogDir 源碼釘 #3 實證）。
- 殘留面（#1 評估可接受）：O_NOFOLLOW 僅守最終 component，中間目錄
  symlink 化需攻擊者已有家目錄寫權＝已越信任邊界；私有 dir 內預植 fifo
  可令 open 阻塞（同樣需私有目錄寫權，兩產品 OS 非問題）——登記知悉不修。

## 6. 範圍外
- `/tmp/sim-req-*.json` 讀取路徑（lib.rs:1960-1994）：同共享目錄問題但屬
  **讀**面＋除錯 CLI 鏈在製品（PM2 cli 域）——觀察項登記，非 F14 徵狀。
- tools/cli.mjs 預設路徑更新（F14-SR1）。
- logrotate/鏡像大小上限（預存問題，非本單）。

## 7. 審查紀錄
### R1（2026-08-28，3 委員並行 leaf：✅/❌/❌ → 不過審，升版 v1.1）
- #1（修法正確性）✅ 有條件：O_NOFOLLOW 最終 component 語意實測矩陣
  （regular OK/symlink ELOOP/目錄 EISDIR/不存在創 0600）；附（a）cfg gate
  與 Android 陳述需修（與 #3 F-1 同源）（b）§5 風險方向補正——v1.1 全辦；
  nit：T2c 保真缺位→T3c3 補釘、測資固定名→pid 後綴，皆辦。
- #2（變異牙檢）❌：11 變體 10 撓 1 逃逸——**V8 全綠逃逸**（log_msg 繞道
  裸 OpenOptions＋註解藏 needle 騙 T3b 純字串釘）；T3c 註解騙綠（V5/V9）、
  T3a 拆字騙綠（V10）、T3c 無 mode 牙（V3）——**v1.1 補牙**：結構釘全部
  stripComments 後比對＋T3b2 負向釘（log_msg 體禁 OpenOptions/create）＋
  T3c 加 mode/any(os) needle＋T3c2 常數表釘＋T3a 拆字則釘。#2 正面認定
  提取向量機設計（行為面 V1/V4/V7 多牙重殺）。
- #3（跨平台）❌ **F-1 阻斷**：cfg(target_os="linux") 在 Android＝false
  （const assert E0080 雙 ABI 實錘）→守門碼在 Android 產物全死碼；且
  0x20000 在 arm64＝O_LARGEFILE（O_NOFOLLOW arm 系＝0x8000，libc-0.2.189
  源碼釘）——**v1.1 修**：any(linux,android)＋per-arch 常數表＋三 target
  編譯釘＋編譯期 assert。次要：sim_tests 3 紅＝預存外部測資缺口非 F14 帳；
  消費者窮舉/F14-SR1 落盤/回歸母體全過。
- v1.0→v1.1 代碼變更：僅 open_monitor_log gate＋常數表＋測試 pid 後綴
  （行為在 x86_64 host 零變化）；驗證腳本 T3 重寫＋T4 三 target 釘。
  驗證 v1.1 **27/27 ALL PASS**。
### R2（2026-08-28，原 ❌ 兩席覆核：❌/❌ → v1.2）
- 兩席一致：**產品代碼 F-1 實質閉合**（#3 獨立三路源碼釘復證常數表＋六
  target 實編譯選值全對，含 armv7/i686；#2 確認 R1 五逃逸 V8/V5/V9/V10/V3
  全閉合多牙連坐）；但 v1.1 驗證腳本新牙再被抓三假牙：
- 【#2-N3 阻斷】stripComments 的 `//` 正則被字符串內 `https://` 吞行→同行
  繞道代碼隱形，arbitrary-append 全綠復活。
- 【#2-N1】includes 針無字符串感知：死字串 satisfies 正向針＋`File::options()`
  繞過 T3b2 黑名單。
- 【#2-N2/#3-F2 同源】T4 編譯期釘恆真（對 target 而非 gate 求值）——反
  cfg 死碼宣稱不實；值互換（arm↔x86 常數對調）全腳本盲。
- v1.2 全收（處方即兩席所提）：①stripNonCode 四狀態字符態機（剝註解＋
  字符串整段消音雙模式）＋自簽釘；②T3a 改 scope 釘（兩函式體留字面值零
  /tmp 子串，堵 V10B）；③T3b2 併 File::options/create/open/fs::write/.open(
  全禁；④T4 改抽 block gate **原文**＋常數表**原文鏡像**進隔離 crate，
  per-target GUARD-DEAD 探針（android/linux 各一）＋EXPECTED 選值釘×6
  target（含 armv7/i686）；⑤gate/常數表抽取 MISS 即 abort。
- 層級教訓（v1.2 註）：cfg!/cfg[] 的(predicate 字符串)屬「代碼的字面值」，
  identifier 級消音會誤刪——needle 分層：代碼層（fnCode 全消）vs 字面值層
  （fnLit 留串），用錯層即假紅（自試兩顆當場逮）。
- 驗證 v1.2：**30/30 ALL PASS**。
### R3（2026-08-28，R2 ❌ 兩席覆核 v1.2：❌/✅ → v1.3）
- #3（跨平台）✅：T4 經兩獨立變異體實測證明有牙（值互換 4 紅、gate 死碼
  GUARD-DEAD 探針 5 紅）；常數表獲 libc-0.2.189 源碼逐 ABI 復證（arm64
  0x20000=O_LARGEFILE 再確認）；app_log_dir Android＝getConfigDir()/logs
  （tauri-2.11.3 path/android.rs:156）＋plugin-log 開機 create_dir_all
  源碼釘；前端契約零變動；消費者窮舉閉合。
- #2（變異牙檢）❌：三條「產品有漏洞而腳本全綠」逃逸實錘——
  **M1** 新 tauri command 用 `fs::write` 直寫 /tmp：scanWriters 模式集只認
  OpenOptions/File::options 兩模式，閉包釘又被 T3h 凍死成 {log_msg,
  open_monitor_log} 空轉，白名單「恰好 2 員」永遠綠；
  **M2** 裸 OpenOptions 新寫源＋首行 `let _guard = "}";`：scanWriters/extract
  括號計數對字符串無感知，體邊界提前斷氣、真寫源隱形（runtime 攻擊已證，
  arbitrary-append 原地復活）；
  **M3** T4 鏡像劫持：常數表抽取取**首顆**匹配——block 外預植正確值 decoy＋
  內層 shadow 常數（arm→0＝不設 flag），鏡像的是 decoy 全綠而產品主力
  arm64 守門死碼。
  附錄 advisory：A5 屬性注入面（#[tauri::command] 前插入面）、riscv64 註解
  僅 bionic 值（glibc=0x20000）勘誤、計畫書 30/30→34/34 文書漂移。
- **憲法⑩登記**：R1/R2/R3 連續三輪同類缺陷（靜態掃描器字符串無感知→假綠），
  v1.3 停止打補丁，掃描層**結構重做**（非增量補釘）：
  ①刪除式 stripper →「抹除式」**位置保持遮罩** maskAll/maskLits（註解與
  字符串內容原位抹為空格、換行保留、輸出逐 byte 等長）；extract/
  scanWriters/findGuardGates 全部結構掃描改跑遮罩文——`"}"` 毒彈從根消失
  （M2 根因封堵，非個例釘）；等長契約破產即 abort。
  ②寫源登記冊模式集與閉包釘對齊（八模式：OpenOptions/File::options/
  File::create/File::open/fs::write/fs::copy/fs::rename/\.open\s*\(）＋
  **逐函式誠實白名單×10**（HEAD 現況盤點：backup_db/download_url_to_file/
  export_backup_dialog/export_csv_dialog/export_db_dialog/
  import_piper_model_dialog/open_monitor_log/restore_backup/
  unique_backup_dest/write_db_container）＋模組作用域孤兒上報＋
  #[cfg(test)] 豁免（M1 堵：新寫源函式必上冊現形）；自簽 probe 擴至毒彈
  sneaky_c/sneaky_d。
  ③T4 鏡像**綁定使用點**：const O_NOFOLLOW 宣告恰 1＋宣告偏移必落守門
  cfg block 區間內＋custom_flags(O_NOFOLLOW) 恰 1＋let/static/mut 遮蔽零
  （decoy 斃於區間釘、shadow 斃於唯一性釘）（M3 堵）。
  ④advisory 採納：T3j #[tauri::command]↔fn log_msg 緊鄰釘；lib.rs riscv64
  註解勘誤（bionic 0x400000／glibc 0x20000）。
  **威脅模型成文**（F17 先例）：靜態牙防無意回歸＋已知對抗偽裝（毒彈/
  decoy/shadow/搬遷）；不抵禦惡意 proc-macro crate 注入級攻擊（需引入外部
  惡意依賴，超出本單邊界，登記知悉）。
- **v1.3 自證**：驗證 **38/38 ALL PASS**（34→38：T3i-b/c/d＋T3j）；
  M1/M2/M3 三變異重放對 v1.3 全 RED（M1：登記冊現形＋T3j；M2：毒彈消音後
  sneaky_diag 上冊雙釘紅；M3：宣告非唯一 abort）＋正宗基線 GREEN（防全紅
  假封鎖）。自簽釘自身一 bug 誠實登記：`names.size`（Set API 誤用於陣列）
  令自簽永 abort，首跑即自爆自修。
- v1.1→v1.3 產品碼變更：僅 doc 註解勘誤一行（riscv64 glibc 值），守門邏輯
  零變動（R2/R3 兩席一致認定產品碼自 v1.1 起實質閉合）。
### R4（2026-08-28，v1.3 覆核：❌(單項)/✅ → v1.4）
- #3（假紅探針席）✅：五向合法演化探針（前插函式/加註解/純讀函式/test 內
  OpenOptions/WL 體字串改 /tmp）零誤傷＋第五向確認 T3i-d 單點有牙；riscv64
  勘誤行零行為影響；git diff 純度合規（他軌髒檔零觸碰）。
- #2（變異牙檢席）❌ 唯一阻斷 **A1**：maskEngine raw string 分支無視
  `blankStrings`——maskLits 把 raw string 內容整段抹除，違背自身
  「字面值層留字符串」契約；守門 fn 內 `open(r#"/tmp/…"#)` 后门對 T3a/T3i-d
  全失明（38/38 綠＋實寫 LEAK 四次實錘）。其餘七新向量六堵（串內 `/*`
  反向毒彈、撇號/lifetime、decoy gate 字符串騙、macro 單行 fn 藏寫源→孤兒
  釘逮、註解偽裝宣告等）；白名單×10 逐員目視誠實（app 私有目錄或使用者
  對話框中介，無殭屍）；P4 區間膨脹列 advisory（值維度有四重兜底）。
- **v1.4 修法（#2 處方逐字照辦）**：①raw string 分支改 `blankStrings ?
  消音 : 逐字保留` ②分層契約自簽釘補顆（maskLits 內 raw string `/tmp` 必
  存活＋maskAll 必消音，違約 exit 2）。首相自簽釘連環兩錯誠實登記：
  `names.size`（Set API 誤用於陣列）、契約釘閉合引號內多空格（首版釘自身
  失明）——皆首跑自爆自修。
- **v1.4 自證**：主腳本 38/38；A1 重放 RED（T3a＋T3i-d 雙紅）；M1/M2/M3
  重放仍全 RED；正宗基線 GREEN。產品碼 v1.3→v1.4 零變動。
- advisory 採納（治理面，入 §5）：白名單＝函式名級登記，函式體大改≠語意
  重新背書——白名單更動須與 diff 同評；CANON_LM 演化須同 commit 更新
  （寫入下方演化指南）。P4（fnLit 字符串膨脹 gate 區間）不修：值維度由
  nofM 原文鏡像＋EXPECTED×6＋GUARD-DEAD＋T1 runtime 四重兜底，#2 認定
  「死值無處遁」。
### R5（#2 單席複核 v1.4）


