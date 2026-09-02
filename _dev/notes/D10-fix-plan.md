# D10 修復計畫書 v1 — find_db_file 同名多檔 random first()

## Bug 定義
`src-tauri/src/drive_sync.rs:256-267 find_db_file`：查詢 `name='teno.db' and trashed=false` 後直接 `.first()` 取 id。Drive files.list 無 orderBy 時返回順序未定義，且 `fields=files(id)` 連 modifiedTime 都不取——同名多檔（手機/桌面各自 create_db_file 過、或歷史殘留）時：
- download 可能永遠下到**舊檔**（本機被更舊資料覆蓋，D11 守門攔得住垃圾但攔不住「有效但舊」）
- upload 更新哪顆未定義 → 上傳到 A 卻從 B 下載，同步語意碎裂

## Root cause
`:258` URL 無 orderBy 參數＋fields 未含 modifiedTime；`:265` `.first()` 無時間比較。
佇列行號 :155-166 為 2026-08-13 audit 快照，已漂移（D9/F11/D11 修復後實際 :256-267，鐵律⑥實錘）。
代碼事實查證（2026-08-28）：`fn find_db_file` 於 :256、`fields=files(id)` 於 :258、`.first()` 於 :265；消費者 `drive_upload` :353、`drive_download` :388 兩處，型別簽名 `Result<Option<String>, String>` 不變。

## 修法（drive_sync.rs 單檔）
1. 新增純函式 `pick_latest_file(files: &serde_json::Value) -> Option<String>`：
   - 掃陣列取 `modifiedTime`（RFC3339 UTC，Google 恆返 `...T..Z` 定格式）字串最大者的 `id`（字典序＝時間序）
   - 條目缺 id 跳過；**全數缺 modifiedTime 時退回 first()**（防御性降級：fields 未來被改/ API 回退化時不退化於現況）
   - 空陣列/非陣列 → None（語意同現況 → upload 走 create、download 報「遠端尚未有備份」）
2. `find_db_file`：
   - URL 加 `&orderBy=` + `urlencode("modifiedTime desc")`（既有 :115 urlencode 產 `%20`）＋ `fields=files(id,modifiedTime)`
   - `.first()` 改委派 `pick_latest_file(&v["files"])`（雙保險：API 端排序＋客戶端獨立比較）
3. 消費者零改動：upload/download 同呼 find_db_file → 自動收斂「讀寫同一顆最新檔」。

## 消費者穷举（憲法②）
- Rust：`drive_sync.rs:353`（drive_upload）、`:388`（drive_download）——唯一兩處，簽名不變零改動。
- `tools/cli.mjs:3283-3290`：同 bug 鏡像（`fields=files(id)`＋取首筆），**白名單外** → 登 `scope-requests.md` **D10-SR1** 待總統改派，本 commit 不碰。
- cron/Discord bot：零 Drive files.list 呼叫（F11 波 #2 委員已穷举過 drive 面，本次復核無新增）。

## 驗證方式（tools/verify-d10.mjs，送審前實跑；嚴禁連 Google——全程離線零 API）
雙態自適應：偵測源碼 `orderBy` 在場與否自動選 PRE（bug 在場釘）/ POST（全綠集）。
- T1 源碼靜態釘（POST）：URL 含 `orderBy=`、fields 含 `modifiedTime`、`pick_latest_file` 定義＋委派在場、`v["files"].as_array()` 後 `.first()` 盲取殲滅；PRE 態斷言其反面（bug 在場釘）。
- T2 倉內單元牙：`cargo test --offline drive_sync` 輸出必含新測試 `d10_pick_latest_file_forms` 全綠（新者勝／反序陣列新者勝／modifiedTime 全缺退回 first／空陣列 None／單檔／缺 id 條目跳過）；PRE 態斷言其缺席。
- T3 真碼提取行為級：從源碼錨點切出 `pick_latest_file` 真碼 → 組裝 /tmp 獨立 crate（serde_json 走 ~/.cargo registry cache，`--offline`、獨立 CARGO_TARGET_DIR 不碰 repo target）rustc 編譯實跑 6 向量（同 T2 形態＋跨月跨日真實 RFC3339 格式）。
- T4 負控制：同一 harness 把真碼換成 `first()` 直通版 → 「反序陣列新者勝」腿**必紅**（證測試有牙非永綠）＋ `ncImpl !== implFixed` 反換釘。
- T5 基線釘 pin `792264e`（D11 commit，drive_sync.rs 現行最後快照，F9 負控制腐化教訓——commit 落地後恆常有效）：`git show` 取基線內容跑 T1 同一掃描器 → 斷言精準紅集（orderBy 缺席、modifiedTime 缺席、first() 在場）。
- 不做微編譯以外腿定案（憲法⑦）：見可選項。
- 回歸義務：`cargo test --offline drive_sync`（4+3→全綠）＋ `npx vite build` ＋ 既有驗證抽 3：`verify-d11.mjs`、`verify-f11.mjs`、`verify-d19-import-magic.mjs`（同檔/同域）。

## 風險
- R1 orderBy 為 Drive v3 files.list 標準參數；即使 API 端異常或忽略，客戶端 pick_latest_file 獨立正確（orderBy 僅縮小窗口），雙保險無單點。
- R2 modifiedTime 精度毫秒、UTC 恆 `Z` 結尾定格式，字典序安全（ISO 8601 性質）。若 Google 未來改格式（+00:00 偏移混入），比較退化为「多數情況正確」——登紀錄不防衛（v3 承諾 RFC3339 UTC，10 年穩定）。
- R3 舊檔殘留 Drive 端不清理：本修法只保證「永遠對準最新」，上傳一律寫同一顆最新檔；清理屬使用者手動（刪除使用者資料絕不做）。
- R4 「本機較新時下載仍覆蓋本機」不在本修法範圍（需雙端 time 比較＋UI 協作）→ 範圍外登案。

## 可選項定案（憲法⑦）
- orderBy＋客戶端比較**都做**：成本高到低、互為保險，无理由只做一半。
- modifiedTime 全缺退回 first()：**做**。理由：strict-None 會讓 fields 意外被修剪時 upload 對既有檔「看不見」→ create 第二顆同名檔，比現況更糟。
- 真碼 rustc 微編譯用 serde_json 型別提取替代（簡化 struct）：**不做**。改用 /tmp 獨立 crate＋registry cache serde_json（後備方案），成本秒級且測的是 byte-identical 真碼。
- 多檔合併/去重上傳：**不做**。語意=對準最新，複雜度不成比例。
- download 前「本機比遠端新」提示：**不做**。需雙端 time 比較＋UI 協作（PM6 域），暫不申請 scope。
- 清理 Drive 端舊同名檔：**不做**。刪除使用者資料風險。

## 範圍外清單（憲法⑥自動進追蹤）
- `tools/cli.mjs` 同款 first() 鏡像（D10-SR1，白名單外，登 scope-requests 待改派）
- Drive 端舊同名檔清理策略（使用者手動）
- 「本機較新勿覆蓋」防護 → 產品決策交總統
- settings.js Drive 區塊顯示同步時間/檔案選擇資訊 → PM6 域
- secret 輪換（F11 既登，非本檔職責）

## 版本紀錄
- v0（2026-08-28 前 session）：兩版草稿（詳簡往復），因 Gemini 429 中斷**從未送審**，憲法⑤凍結點未觸發。
- v1（2026-08-28 定稿送審）：併回草稿全部要點＋消費者穷举＋行號實錘（:256/:258/:265/:353/:388）＋驗證五腿（含基線釘 pin 792264e）＋可選項六項定案＋cli.mjs 鏡像 D10-SR1 登記。
- v1.1（2026-08-28 審查後，R1 三人次全✅）：
  - 採納 R1#1-3：`max_by` std 語意取平手末顆，與 orderBy desc「首顆最新」意向相反 → 改顯式迴圈嚴格大於才替換（平手留首見），倉內測試 l9＋微編譯 L10 平手牙各補一條。
  - 採納 R1#3-1/2/3（鑑識強化，verify 腳本層）：掃描/提取前剝 block comment（殲滅註解 decoy 假函式）；T1 URL 三釘縮圈 find_db_file 體內（殲滅「死碼＋註解散佈魔法字串」騙綠）；pick_latest_file 唯一定義釘 T1h。強化後 POST 19→20/20 全綠。
  - 勘誤 R1#1-1/#2-4（文獻面）：v1 稱「urlencode 產 %20」有誤——:118 實為空格→`+`（form-urlencoded 慣例，Google query 解析還原為空格，同檔 `q` 參數生產實證路徑，運行時正確）。代碼不動。
  - 採納 R1#2-1：穷举補登第二鏡像 `_dev/cli/cli.mjs:3046-3051`（git 追蹤中）→ D10-SR2 連同 D10-SR1 已追加 scope-requests.md（共享檔髒於他軌，比照 F11 先例僅追加不入本 commit）。
  - 紀錄不防衛（R1#2-5 nit）：未取 nextPageToken（fields 亦未 request），orderBy 生效時第一頁首筆即全域最新、頁內取 max 恆正確；唯「orderBy 被 API 忽略且同名檔 >10」極低機率殘洞，雙保險下仍嚴格優於修復前，不加 pageSize。
  - 審查 R1 三席全✅（#1 Rust 正確性／#2 消費者穷举／#3 驗證鑑識），零升版重送。紀錄 `_dev/notes/subagent-log/2026-08-28-D10.md`。
