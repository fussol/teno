# F12 修復計畫 — curl 殲滅：Android 無 curl 二函數必敗 ＋ 404 中毒鏈根治

狀態: v1.1（本首相重建審查＋返修補全，歷程見 §7）
日期: 2026-08-28
審計來源: bug-audit-2026-08-13.md :115（宣稱 :250,290,322 四處 curl）

## 0. 版本歷程（憲法⑤誠實條款）
- v1.0（前首相 session）：§3 全部＋驗證腳本＋整合測試組裝，R1 審查進行中
  （委員代號見 code 註解 R1#2/#3）預算中斷（runner 429 熔斷實錘 pm3.runner.log）。
- v1.0 的 R1 **不算閉環**：無 subagent-log md（鐵律③無紀錄＝未完成）、
  無 §7 審查紀錄、且 R1#3 返修只做一半——測試 `multibyte_prefix_no_panic`
  的 is_err 拒斥語意**代碼從未被實作**（初跑 19/21，2 FAIL 實錘）。
- v1.1（本首相）：補全 R1#3 守門（§3.4b）＋勘誤測試第 4 斷言（§3.4c）＋
  本 session 重組 3 委員全面審查。

## 1. Bug 定義（行號實錘 ＋ 審計勘誤）
勘誤（憲法①誠實條款）：審計稱四處 curl，實測（grep 2026-08-28）fetch_llm(:290)
與 fetch_get(:344) **早在本波 F8 已 ureq 化**（留 "ponytail: ureq instead of curl"
註解），現存 curl 僅兩函數三呼叫：
- **scrape_quizlet :250-253**：`Command::new("curl") -sL --max-time 15 -A UA`
  ——Android 無 curl 二進制 → `Command::output()` ENOENT → 「curl 執行失敗」
  必敗（Quizlet 匯入 Android 全死）
- **install_piper_model 下載閉包 :501-512**：curl 兩條（onnx 120s / json 30s）
  ——Android 同上必敗；且**桌面端另有中毒鏈**（F9 單實測登記）：curl 無 `-f`
  對 404 **exit 0**，HF 錯誤頁（純文字 `Entry not found`，F9 R1#3 勘正非 HTML）
  被存成假 `{model}.onnx` ＋「安裝成功」假象 → TTS 播放端才炸

## 2. Root cause
1. Android 用戶空間無 curl 可執行檔（倉內既認事實：:290/:344/:370 三處
   ureq 遷移註解皆因此）。ureq（含 tls+gzip feature，Cargo.toml:31 既有 dep）
   為本倉已建模式（fetch_llm/fetch_get/lookup_cambridge/drive_sync 全用）。
2. curl 缺 `-f` → HTTP 狀態語意丢失；`Command.status()` 只知進程退不退，
   不知 404。ureq `.call()` 對 >=400 預設回 Err（ureq-2.12.1 error.rs
   Error::StatusCode）→ 狀態語意天生正確，**中毒鏈根治**。
3. F9 §6 併治兩項（R1 登記移交本單）：parse_piper_url trim 鏈不吃
   `?download=true` 查詢尾（HF「下載檔案」按鈕複製即得，高頻貼法）與大寫網域
   `HTTPS://HF.CO`（大小寫敏感 trim 不中 → 段位移 404）。

## 3. 修法
### 3.1 lib.rs 新增 pub fn download_url_to_file(url, dest, overall_secs)（F12 核心）
ureq Agent（connect 10s ＋ overall Ns，對齊原 curl --max-time）GET →
`.call()`（>=400 即 Err，**先於建檔** → 錯誤頁永不落盤）→ `into_reader()`
＋ `io::copy` 流式寫檔（onnx 達 60MB，不經 String/緩衝整包）；
寫檔中斷（timeout/斷線）→ 刪半成品再報錯（不殘假檔）。
pub 為驗證面（src-tauri/tests/ 整合測試經 teno_lib 呼叫，白名單內新建）。

### 3.2 install_piper_model 下載閉包委派（lib.rs:494-517）
onnx：download_url_to_file(…, 120)，失敗 Err 語意逐字保留（含 remove_file 防殘）
json：download_url_to_file(…, 30)，失敗降級刪除（既有 best-effort 語意零變化）

### 3.3 scrape_quizlet（lib.rs:250-258）
curl → ureq GET：UA 逐字保留、connect 10s/overall 15s 對齊原 --max-time 15、
https-only 前置檢查（:249）不動、-L 等價性＝ureq 預設 follow 10 跳。
into_string 取代 from_utf8_lossy（ureq 內部 lossy 等價）。
刮取本體 quizlet_scraper::scrape_quizlet_html 零碰觸。

### 3.4 parse_piper_url 兩項 F9 移交（lib.rs:460-484）
- 開頭 `split(['?','#']).next()` 去 query/fragment 尾
- host 前綴鏈改 `eq_ignore_ascii_case` 逐一比對（字節安全：eq_ignore_ascii_case
  成立 ⇒ 該段全 ASCII（非 ASCII 字節永不等於 ASCII 字節），邊界切割合法）
- 正規小寫向量與舊 trim 鏈**逐字等價**（F9 釘 13 條零改全過）

### 3.4b 【v1.1 補全】混入文字粘貼法拒絕守門（R1#3 返修落地）
v1.0 只把裸切片改 `.get()`（不 panic）但未實作測試宣稱的 is_err——lenient
路徑會把「帮我安装 https://hf.co/rhasspy/…」拼出含 tree/main 的垃圾相對路徑，
到下載端才 404。v1.1 守門：trim＋去尾後**非空且非 ASCII 起頭 → Err**
「網址混入了額外文字，請只貼網址本身」。
- 零誤殺論證：合法向量無論有無 scheme（F9 釘 `hf_co_bare_host` 支援裸
  `hf.co/...`）皆 ASCII 起頭；空字串不經本閘（留段數守門給含範例網址的錯字，
  `empty_and_garbage_rejected` 釘語意不變）
- 誤殺覆核：`non_hf_host_lenient_pinning`（evil.example.com）ASCII 起頭不受影響；
  F9 世代 13 釘全為 ASCII 起頭，零觸及

### 3.4c 【v1.1 勘誤】測試第 4 斷言改寫（誠實釘真實行為）
v1.0 註解宣稱「trim 不剥 U+3000」**不實**——本首相 rustc 獨立實錘
`"　https://hf.co/a/b".trim() == "https://hf.co/a/b"`（str::trim 依 Unicode
White_Space 屬性，U+3000 在列）。全角空格前後綴＝trim 後的合法網址，斷言由
is_err 改為 is_ok＋值釘（Ryan 正規對）＋錯字誠實登記於測試註解。

### 3.5 不改（范围紀律）
- fetch_llm/fetch_get/lookup_cambridge/drive_sync：已 ureq，零碰
- check_fetch_get_url HTTPS-only 政策（F8）：零碰（結構釘守）
- curl 作 Player 的 aplay/ffplay（speak_piper）：非 HTTP，不屬本單

## 4. 驗證方式
- **cargo unit（piper_url_tests +5）**：?download=true 尾＝正規同解、#fragment、
  大寫網域全家（HTTPS://HUGGINGFACE.CO / HF.CO 混合大小寫）、大寫＋尾斜杠複合
- **src-tauri/tests/f12_download.rs（新建，網絡腿 TENO_NET_TEST=1 閘控**，
  無網路環境跳過不紅——429/斷網教訓）：
  真 HF x_low json（~1KB，走 302→cdn-lfs 重定向）→ Ok ＋ 內容合法；
  不存在模型 → Err ＋ **目標檔零生成**（中毒鏈根治釘）
- **tools/verify-f12-curl-to-ureq.mjs**：
  T0 cargo unit 全綠＋新向量在册
  T1 TENO_NET_TEST=1 cargo test --test f12_download 真網綠
  T2 結構釘：lib.rs `Command::new("curl")` 殲滅；scrape https-only/UA/ureq 在位；
    check_fetch_get_url 政策函數原樣；parse 去尾＋大小寫鏈在位；
    下載閉包委派＋remove_file 防殘語意保留
  T3 負控制（**無 git ref 面**，免腐化）：裸 curl（舊碼同款旗標 `-sL` 無 -f）
    打 404 URL → exit 0 ＋ 垃圾落盤 "Entry not found" ＝ bug 徵狀精準重現；
    對照 T1 ureq 腿同 URL → Err ＋ 零落盤
  T4 回歸：verify-f9（parse 改後 18/18）＋ verify-e8（fetch_get 政策域）
- 真機 Android：需用戶終端驗證（登 §6）

## 5. 風險
- ureq 重定向策略 vs curl -L：【勘誤 v1.1，R1#1#2#3 三席同抓】ureq-2.12.1 預設
  跟 **5** 跳（agent.rs:262 redirects:5，非 v1.0 所稱 10 跳；HF/Quizlet 鏈 ≤2 跳
  餘量仍足，碼註解 lib.rs:251-252 寫 5 是對的、v1.0 計畫書錯）。
  【勘誤二】v1.0 宣稱「不跟 https→http 降級（比 curl 嚴）」**不實**——R1#3 源碼
  實錘 https_only 預設 false（agent.rs:260），實測 httpbingo redirect-to http 照跟。
  舊 curl -L 同樣跟降級＝**零新風險面**，但安全敘事誠實撤回；加 .https_only(true)
  行爲決策登 §6 另案（起點恆 https＋TLS 驗證，非緊急）。
- into_string 對非 UTF-8 Quizlet 頁 lossy（舊碼 from_utf8_lossy 同語意，ureq
  response.rs:480 源碼釘）；【R1#2 次要#2】into_string 有 10MB 硬上限（舊 curl 無）
  ——Quizlet 頁實務遠小於此，登記不修
- gzip feature：ureq 自動 Accept-Encoding＋解壓（curl 版無 --compressed 收 identity）
  ——寬容性增強
- download_url_to_file pub 面積：純函數無狀態；【R1#3 nit】dest 不自淨，
  調用端須傳淨檔名（現行唯一調用端 name 經段切＋`-` 拼接永不含 `/`，穿越不可達）

## 6. 範圍外（登案）
- 下載無 sha256 校驗／斷點續傳（F9 §6 既呈總統）
- Android 真機 Quizlet/piper 匯入端到端（需用戶終端）
- speak_piper 的 aplay/ffplay 播放器鏈（非 HTTP）
- cli/bot 域 fetch 消費者（已 ureq 域，零碰）
- 【R1#2 次要#1】守門不對稱：ASCII 起頭＋空格粘貼（"install https://…"）繞過
  非 ASCII 閘→段位移垃圾→下載端 404（F12 後 404=Err＋零落盤，危害已閉）；
  正確修法『rest 內含 https?:// 子串即拒或抽取』屬行為決策另案（同
  non_hf_host_lenient 寬容哲學家族）
- 【R1#3 次要#2】parse_piper_url 不拒 `..` 段（dest 不可達＝name 永無 `/`；
  URL 側 url crate 正規化困於 host 內終究 404）——純除雷段守門另案
- 【R1#3】.https_only(true) 硬降級封堵（§5 勘誤後的安全增強選項，行為決策另案）
- 【R1#3 nit】`https://https://…` 雙前綴新舊鏈不等價（殊途同歸 404，釘未 coverage）
- ureq host 白名單（F9 §6 既呈）

## 7. 審查紀錄
### R1（本波，3 委員，2026-08-28）
- 前情：v1.0 前首相 session 已進行過一輪部分審查（code 註解現 R1#2/#3 痕跡）但
  **未閉環**——無 md 落盤、無 §7、R1#3 返修只做一半（測試釘在、守門碼缺席，
  首相接手初跑 19/21 紅實錘）。本 session 補全後**重組全量三席審查**。
- 委員 #1（負控制／驗證完整性）：✅。獨立跑 21/21＋rustc 實錘 U+3000 trim＋
  T3 徵狀親重現＋EVIL1/1'/2/3/4 五變體注入模擬：僅 EVIL4（scrape 吞錯）半開
  → 採納補 T2 錯誤傳播釘；次要#2 中斷半成品無行為腿 → 採納 f12_download.rs
  truncated_body（本地迴環免網閘）；nit：T0 計數下限（採納）、§5 10 跳勘誤（採納）。
- 委員 #2（消費者穷举＋等價性）：✅。curl 全庫歸零穷举；scrape/install 兩呼叫鏈
  唯一消費者＋零錯誤文案字串分支；21/21＋自建 24 向量探針零誤殺；混合粘貼 UX
  裁決合理；node --check＋vite build 綠。次要#1（守門不對稱）#2（10MB 上限）登 §6。
- 委員 #3（安全／純函數／純度）：✅。路徑穿越不可達實錘（name 永無 `/`）；
  SSRF 零新增面（install 硬編 HF base 重建 URL）；BOM/U+200B/NBSP/全形冒號邊界
  全實測登記；U+3000 勘誤獨立裁決正確；T4d 反轉與 T3a pin-hash 正交不腐化；
  commit 純度清單（cli.mjs SR-C4＋scope-requests 勿夾帶）。次要#1 §5 降級宣稱
  不實（採納勘誤）；次要#2 `..` 段守門（登 §6）。
- 全席 ✅ 過審。吸收項：EVIL4 釘、truncated 行為腿、T0 計數下限、§5 雙勘誤、
  註解 20→21、檔案 mode 644。吸收後全量復跑（見 commit 訊息實測數）。
