# F6-SR1 修復計畫書 — Android D2D 傳輸堵漏（data_extraction_rules）

- 首相：SR3（Android/TTS 域）
- 基線：`504049e`（F6-SR1 動工前實錘 HEAD；原任務書 12e9978 已被並行推進）
- 狀態：v1.1（審查 3 委員全過，吸收修法）

## 1. Bug 定義
`allowBackup=false`（F6 主修 8a35026 已加）在 **targetSdk31+ 部分廠商裝置**（Samsung Smart Switch 真實暴露面）**不保證停止 D2D（device-to-device）傳輸**。teno 的 `teno.db`（全部單字/複習資料）與 Drive OAuth token 位於 app_config_dir，若 D2D 傳輸執行，換機時舊 DB＋token 直接搬移 → 新裝置舊 DB 覆蓋現行 DB＋token 漂移，與 Drive sync（TENOC）官方通道打架，且 **SQLite+token 屬敏感資料不應透過 D2D 外洩**。

## 2. Root cause（一手查證，官方 developer.android.com）
- **權威確認 1**（autobackup 指南）：「On devices from some device manufacturers, specifying android:allowBackup="false" disables cloud-based backup and restore (such as Google Drive backups) **but doesn't disable device-to-device transfers** for the app.」
- **權威確認 2**（behavior-changes-12）：「The [allowBackup=false] configuration mechanism doesn't affect D2D transfers... **To specify rules for D2D transfers, you must use the new configuration** [dataExtractionRules]。」
- **權威確認 3（決定 recipes 的關鍵）**：官方原文「**If there are no rules for a particular backup mode, such as if the <device-transfer> section is missing, that mode is fully enabled for all content except for no-backup and cache directories**。」
  - → **空 `<device-transfer>` section 或缺失 = 該 mode 全內容啟用**，堵不住！
  - → recipes 不能用空 section，必須 **exclude 根域**（<exclude domain="..." path="."/>）或明確 include 空集。

## 3. 修法（檔案:行號，動工前一手查證）
### ① 新增 `res/xml/data_extraction_rules.xml`
`<data-extraction-rules>` 下同時宣告 `<cloud-backup>` 與 `<device-transfer>` 兩 section，**各自對官方 schema 全部 9 個 domain 全部 exclude 根域**（面全資料且近乎 zero-D2D 曝露面，符合僅透過 Drive sync 官方通道遷移的治理語意）：

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="file" path="."/>
    <exclude domain="database" path="."/>
    <exclude domain="device_file" path="."/>
    <exclude domain="device_database" path="."/>
    <exclude domain="device_sharedpref" path="."/>
    <exclude domain="device_root" path="."/>
    <exclude domain="sharedpref" path="."/>
    <exclude domain="external" path="."/>
    <exclude domain="root" path="."/>
  </cloud-backup>
  <device-transfer>
    ...（與 cloud-backup 同 9 domain）...
  </device-transfer>
</data-extraction-rules>
```

官方 schema domain 清單（autobackup 指南 XML 語法段）：`file`/`database`/`sharedpref`/`external`/`root`／`device_file`/`device_database`/`device_sharedpref`/`device_root`（後四域＝device-protected storage，directBoot 場景）。**全 9 域列齊**＝落點無關的保證。

理由：顯式規則取代「無規則＝全啟用」預設；9 domain 全列確保 file/database/sharedpref/external/root 及 device_* 任一位置皆不外洩。**落點對映**：teno.db 由 tauri-plugin-sql 走 SQLiteOpenHelper → `/data/data/<pkg>/databases/`（database domain）；OAuth token 落 app_config_dir（Android 形態為 shared_prefs 或私有根下非標準目錄 → sharedpref/root domain）。9 domain 全列＝落點無關（mapping-agnostic）的保證。

### ② `AndroidManifest.xml` `<application>` 加屬性
在 android:allowBackup="false" 旁（line 15）加 `android:dataExtractionRules="@xml/data_extraction_rules"`。

**AAPT link 約束**：dataExtractionRules 屬性引用與 res/xml/data_extraction_rules.xml 新檔**必須同 commit 原子提交**（AAPT 編譯期 link 兩個檔，任缺 compile 崩）。實務上會用 `processArmDebugMainManifest` 驗證 AAPT 能 link。

> 保留 android:fullBackupContent？官方：dataExtractionRules 指定後，Android12+ 忽略 fullBackupContent（舊格式）。目前未設 fullBackupContent，Android11 或更低走 allowBackup=false（非 dataExtractionRules）——但任務書聚焦 targetSdk31+ 場景，Android11- 由 allowBackup=false 覆蓋（該版本 allowBackup=false 可靠停 D2D），故不另建 legacy rules 檔（範圍外，見 §6）。

### ③ verify 腳本
- 擴充既有 `tools/verify-f6-manifest.mjs`（8/8 現存）→ 加 D2D 新斷言：
  - 正向：`android:dataExtractionRules` 屬性存在；data_extraction_rules.xml 存在且兩 section 皆 9-domain exclude 根域。
  - **負控制（沿既有 NC 模式）**：刪除整個 `<device-transfer>` section（NC3）**與清空為空 section（NC4）** → 斷言必紅（§2 權威確認 3「no rules=fully enabled」的 missing/empty 兩種回歸形態）；T0 PRE 釘：git 基準 504049e 無屬性/無新檔（bug 事實，防斷言天生 POST 才綠）。
  - **compileSdk≥31 前置釘**：`android:dataExtractionRules` 屬性與 `<data-extraction-rules>` 根元素需 SDK31+ 編譯支援。實錘 build.gradle.kts compileSdk=36 ✅（≥31）、minSdk=24。
- 對 `processArmDebugMainManifest`／`compileArmDebugKotlin` 做編譯閘驗證（AAPT link 生效證明）。

## 4. 驗證方式
- `tools/verify-f6-manifest.mjs` 回歸（既有 8/8）＋新增 D2D 斷言。
- AAPT：`processArmDebugMainManifest`（或 compileArmDebugKotlin 連帶）——AAPT2 能 link 新 xml＋manifest 屬性即編譯級證明。
- 一手查證文檔抓取自 developer.android.com（curl 存 /tmp/ab.html、b12.html），證據鏈見 §2。

## 5. 風險
- 低。純新增 XML + manifest 一屬性；不觸 Java/Kotlin/Rust/JS。
- 影響：對 cloud-backup 與 device-transfer 皆停用所有資料備份——治癒也；使用者主動 Export/backup 走 app 內 TENOC 容器（不受 Auto Backup 影響）。
- AAPT link 風險由編譯閘兜底（若屬性名/檔案路徑錯，compile 崩，立即暴露）。
- cacheDir/no_backup 本就排除，本次 exclude 不誤殺。

## 6. 範圍外清單（憲法①⑥）
- 不建 legacy `<full-backup-content>`（backup_rules.xml）：Android11- 單一開關設計，官方機制 allowBackup=false 可靠；且 fullBackupContent 同樣只治理 backup agent 資料集，對 OEM 私有通道（Smart Switch 直讀）無能為力——legacy 檔不增防護，撤案成立。殘餘：minSdk=24 意味 ≤11 裝置（API24-30）與 OEM 私有通道非官方保證（理論曝露面非零，然與 cloud 同級資料集，可接受；根治需移 no_backup 屬後續 hardening）。
- 不碰 `src/lib/*.js`、`src/pages/*.js`、`src-tauri/Cargo.*`、`lib.rs`（他軌）。
- 不更動任何 Java/Kotlin 執行邏輯。
- 不動 allowBackup=false（F6 主修成果，保留）。

## 7. 可選項（憲法⑦）
- 空 section vs exclude 根域：一手查證官方後**決行 exclude 根域**（空 section 官方明示「fully enabled」，不可用）。✅
- cloud-backup 是否也堵：做（五 domain 全列）。理由：allowBackup=false 對 cloud 之保證在部分廠商亦僅「通常」，dataExtractionRules 顯式 exclude 提供雙保險，且語意一致（僅 Drive sync 官方通道遷移）。✅