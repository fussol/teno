# F6 修復計畫 v1（凍結送審）

## 1. Bug 定義（audit 2026-08-13）
> F6 AndroidManifest.xml:5 + gradle — MANAGE_EXTERNAL_STORAGE 上架風險；
> release cleartext block localhost LLM；無 backup 排除（DB 被雲端還原）

## 2. 實錘（基線＝F5 commit ee93ffa；行號以現檔為準）
檔案：`src-tauri/gen/android/app/src/main/AndroidManifest.xml`（:5 MANAGE 行）、
`src-tauri/gen/android/app/build.gradle.kts`（:27/:46 cleartext placeholder）。

| # | 宣稱 | 實錘 | 證據 |
|---|---|---|---|
| ① | MANAGE_EXTERNAL_STORAGE 上架風險 | **真（零消費者）**：全 repo grep（kt/rs/js/gradle/capabilities）零處 isExternalStorageManager／ALL_FILES／raw File 外部路徑存取。声明未用＝Play All Files Access 政策違規面＋攻擊面扩大 | grep 全倉無命中；TtsPlugin 外部寫入僅 MediaStore.Downloads（:258-266，不需此權）|
| ①b | （挖出）WRITE_EXTERNAL_STORAGE maxSdk=28 可否同刪 | **不刪（v1.1 E1 終態）**：原論據「API24-28 MediaStore 需 WRITE」經 R1#1 勘誤不實——`MediaStore$Downloads` 為 API29+ 類，24-28 上 saveExportFile 先 NoClassDefFoundError（該缺陷屬 TTS 域 O3 另單）。保留裁決改採零風險保守論據：maxSdk=28 聲明無攻擊面（≤28 才有語意）、O3 修復後 MediaStore 即回真消費者、一併刪除屬一刀切 | TtsPlugin.kt:258-266＋R1#1 報告（api-versions.xml since="29"）|
| ② | release cleartext 擋 localhost LLM | **不實（任何版本皆不成立）**：LLM 鏈＝api.js:15 `invoke('fetch_get')` → lib.rs:343 **ureq**（Rust raw socket；舊版為 curl binary spawn，F12 :250）——Android cleartext 政策（usesCleartextTraffic/NetworkSecurityConfig）只約束 Java/WebView 網路棧（HttpURLConnection/okhttp/WebView），Rust socket 與外部 binary 均不在管轄。WebView 產線走 tauri:// 自訂 scheme，JS 直連 fetch 僅 store.js:595 相對路徑（same-origin）。CSP connect-src http://localhost:11434 無 JS 消費者（預留位）| lib.rs:329-353、api.js:15、tauri.conf.json CSP |
| ③ | 無 backup 排除（DB 被雲端還原） | **真**：manifest application 無 allowBackup → 官方默認 true、targetSdk23+ 自動 Auto Backup；官方「the system backs up almost all app data」（除 no_backup/cache 目錄外幾乎全部 app data），teno.db 與 Drive OAuth token 位於 app_config_dir（R1#2 一手：Tauri PathPlugin.kt getConfigDir→activity.dataDir，非排除集）。新裝置恢復＝舊 DB 覆蓋＋token 漂移，與 Drive sync 官方備份通道（D10/D11 last-write-wins）雙通道打架 | 官方 autobackup 文檔實查：「The default value is true」「If there are no rules for a particular backup mode... that mode is fully enabled」|
| ③b | （挖出）allowBackup=false 殘洞 | **官方實查原文**：targetSdk31+ 於部分廠商裝置 allowBackup=false 只停雲端備份、**不停 D2D 傳輸**（「doesn't disable device-to-device transfers for the app」）。本機 Samsung A55＋Smart Switch＝D2D 真實暴露面。完全堵需 `android:dataExtractionRules` → **res/xml/data_extraction_rules.xml＝白名單外**，且 manifest 屬性引用缺失資源＝AAPT link 失敗（屬性＋檔必須同一隻手原子入庫）→ 依鐵律⑦ F6-SR1 登記改派 | developer.android.com/guide/topics/data/autobackup（一手 curl 實查 2026-08-28）|
| ③c | （旁知識登記） | 官方：runtime component enabled 狀態（IconPlugin alias 切換）**不被** Auto Backup 保存/恢復——F4/F5 的 alias 態天然不受備份污染，零動作 | 同上文檔 |

## 3. 修法
**AndroidManifest.xml**：
1. 刪 `<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />`（治①）。
2. `<application>` 加 `android:allowBackup="false"`＋註解（治③主面：雲端備份；含官方 D2D 殘洞備註＋SR 指向）。
3. WRITE_EXTERNAL_STORAGE 保留不動（①b）。
**build.gradle.kts**：**零改動**（②不實：cleartext 政策不影響 LLM 鏈）。可選項裁示（憲法⑦）：
- **不做** network_security_config localhost 例外——當前零 WebView 明文消費者，加了即純死碼；
  未來若 WebView 直連 LLM，正解是 NC localhost 例外**而非**全域 true（範圍外追蹤登案）。
- **不做** 本輪 dataExtractionRules（白名單外，F6-SR1 改派；非「可選」是「無權」，區分登记）。

## 4. 驗證
`tools/verify-f6-manifest.mjs`（SRC env 可指向預後樣本；錨點 fail-loud）：
- T0 PRE 正宗釘（HEAD）：MANAGE 行在位＋allowBackup 屬性缺失（bug 事實）。
- T1 MANAGE 絕跡＋全倉零消費者守門釘（防順手「加權修 bug」）。
- T2 WRITE_EXTERNAL 保留（maxSdk=28 在位）＋TtsPlugin MediaStore 消費者成對釘
  （防一刀切把兩個 permissions 都刪）。
- T3 allowBackup="false" 顯式且唯一（官方「explicitly setting」建議形）。
- T4 cleartext 登記釘：gradle defaultConfig placeholder=false 保留＋debug true 保留
  （防未來有人拿「release 沒 LLM」當理由開全域 true——正解見 §3）。
- T5  placeholder 注入鏈完整：manifest `${usesCleartextTraffic}` 佔位仍在（gradle↔manifest 成對）。
- NC1/NC2 真突變：POST 樣本還原 MANAGE 行 → T1 紅；刪 allowBackup → T3 紅。
- 雙態先行（法律④）：PRE＝git HEAD 紅釘命中；POST＝計畫預後樣本 /tmp 實跑全綠後才送審。
- 編譯閘：`gradle :app:processArmDebugMainManifest --offline`（AAPT2 manifest merge＝XML 合法性權威驗證）
  ＋ `:app:compileArmDebugKotlin --offline`（連帶）。
- 回歸：verify-f4、verify-f5、tts-contract、npm run build。

## 5. 風險
- allowBackup=false＝放棄 Google One 雲端恢復本 app——Drive sync（TENOC）已是官方備份通道，
  語意一致；用戶手動備份路徑（sqlite3 -readonly／TENOC 匯入）不受影響。
- 刪 MANAGE：若 grep 遺漏未知 raw-File 外部存取路徑 → API30+ 該路徑 EACCES。消費者窮舉
  （kt/rs/js/gradle/capabilities 五面）零命中；最壞後果＝匯出斷（可恢復、非資料損失）。
- 官方「部分廠商」措辭＝allowBackup=false 對雲端備份的絕對性亦裝置相關？原文限定：雲端
  backup 停用是確定的，vary 的是 D2D——誠實照錄原文於 §2 ③b。

## 6. 範圍外清單
- **F6-SR1**（scope-requests.md）：dataExtractionRules 堵 D2D（res/xml 新檔＋manifest 屬性，白名單外）。
- NC localhost 例外（未來 WebView 直連 LLM 時的正解，範圍外追蹤）。
- Drive OAuth token 本機明文（F11 域已登）。
- activities/aliases 區塊（F4/F5 域）；gradle signing/minify（零缺陷發現）。

## 版本紀錄
- v1（本檔）：首版送審。凍結。
- v1.1（R1 三席 ✅✅❌ → #3 兩必須項＋#1 一勘誤當輪修畢）：
  - 【R1#3-S1 必須·採納·腳本】守門 grep 自爆釘：pathspec 含 tools/ 且本腳本含字面
    `isExternalStorageManager`→F6 合併同 commit 起 T1 恒紅（#3 clone 模擬提交實測 rc=0）。
    修＝needle 拆串（CONSUMER_SYMBOL 拼接）＋pathspec `:(exclude)` 排除自身雙保險；
    clone 合併態模擬復測 8/8 綠。
  - 【R1#3-D1 必須·採納·腳本】T3 錯置雙盲：allowBackup 錯置 `<activity>` 時靜態釘綠＋
    AAPT2 亦綠（屬性有效但無效，#3 merged 產物實證）。修＝ALLOW_BACKUP_RE 錨定
    `<application\b[^>]*`（negated class 跨換行不跨標籤終止符）；錯置攻擊復測 T3 單點紅。
  - 【R1#1-E1 必須·採納·文字】①b 論證勘誤：`MediaStore$Downloads` 為 API29+ 類
    （SDK api-versions.xml since="29"），API24-28 上 saveExportFile 先 NoClassDefFoundError
    ——「24-28 需 WRITE」對現行碼不實。保留 maxSdk=28 裁決不變，論據改採「零風險保守＋
    O3 修復後即回真消費者」；T2 斷言訊息同步改寫。**API24-28 匯出必斷＝TTS 域真缺陷
    O3 登記另單**（非 F6 範圍：manifest 層無法修，需 TtsPlugin 分支）。
  - 【R1#2 採納·文字】§2③「十項內」措辭改正（「除 no_backup/cache 外幾乎全部 app data」）；
    fetch_llm 無 localhost 白名單（#2 發現，範圍外登記——lib.rs 域）；
    usesCleartextTraffic targetSdk 38 deprecation 預警登記（範圍外）。
  - 【R1#2 全席官方一手復核】D2D 殘洞引文兩頁逐字存在（autobackup＋behavior-changes-12）
    →F6-SR1 改派恰當非過度防衛；Play AFA 政策「不需要就必刪」；cleartext 管轄清單
    （HTTP/FTP 棧、DownloadManager、MediaPlayer、NetworkSecurityPolicy Java API）確不含
    native socket；Tauri PathPlugin.kt getConfigDir→activity.dataDir（非排除集）——
    ③覆蓋推定升級一手佐證。
  - R1#3 ❌ 未明示逕判 ✅→單席複核（F4/F5 判例：複核僅驗處方落實＋攻擊重現）。
