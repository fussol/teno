# PM-SR3 任務書 — Android/TTS 域 SR 修復（F10/F6/O3）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`。工作目錄 `~/teno`，branch main，基線 HEAD=`12e9978`(v5.7.0)。

## 檔案所有權白名單
- `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`
- `src-tauri/gen/android/app/src/main/java/com/teno/app/MainActivity.kt`
- `src-tauri/gen/android/app/src/main/res/xml/`（data_extraction_rules.xml 新檔）
- `src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- `src-tauri/src/lib.rs`（僅 F10 之 `import_piper_model_dialog` 改裝段，限指定 hunk）
- `tools/verify-f10-piper-import.mjs`、`tools/verify-f6-manifest.mjs`（及其他本次相關 verify-*.mjs）
- `_dev/notes/`（含 subagent-log/）

**不碰**：`src/lib/*.js`、`src/pages/*.js`（他軌）、`src-tauri/Cargo.*`（他軌）、`src-tauri/src/lib.rs` 除 F10 指定 hunk 外。`scope-requests.md` 共享檔絕不 add/commit。

## Bug 佇列（依序，每顆完整循環）

### 1. F10-SR1 — import_piper_model_dialog Android 必敗（含 F10-pending.patch 併入）
- Bug：Rust `import_piper_model_dialog`（FilePath::Url→as_path()=None，file_path.rs:42-47 源碼釘）＋下游 Kotlin `copyUriToCache`（TtsPlugin.kt:272）落地檔名硬編碼 `"import.db"` — piper 鏈需要真實 `.onnx` 檔名（collect_piper_voices 以檔名建語音目錄），落地改 import.db 則 piper 匯入仍 100% 失敗（僅錯誤訊息換臉）。
- 修法（兩檔）：
  ① **Kotlin TtsPlugin.kt:272 copyUriToCache**：改 `ContentResolver.query(OpenableColumns.DISPLAY_NAME)` 取真實檔名（失敗兜底＋sanitize）；import_db 鏈零影響（.db 檔 DISPLAY_NAME 照樣 .db）。
  ② **lib.rs import_piper_model_dialog**：用已封存 patch `_dev/notes/F10-pending.patch`（配套 `_dev/notes/F10-pending-verify.mjs` 曾 23/23 綠）。
- **附帶地雷**：import.db 固定名與 db 匯入共用 cacheDir，交錯匯入互相覆寫 — 併此單治。
- 驗證：`tools/verify-f10-piper-import.mjs`（或復跑 F10-pending-verify.mjs 23/23）＋Kotlin DISPLAY_NAME 斷言。

### 2. F6-SR1 — Android D2D 傳輸堵漏（data_extraction_rules）
- Bug：`allowBackup=false`（已由 F6 主修 8a35026 加）**官方不保證 targetSdk31+ D2D 傳輸停止**（Samsung Smart Switch 真實暴露面：官方原文 doesn't disable device-to-device transfers）。
- 修法：新增 `res/xml/data_extraction_rules.xml`（空 section vs exclude 根域，需一手查證後定 recipes）＋`AndroidManifest.xml` 加 `dataExtractionRules` 屬性。屬性引用與 res/xml 檔**原子同 commit**（AAPT link 約束）。
- 驗證：`tools/verify-f6-manifest.mjs`（8/8 回歸）＋AAPT2 processArmDebugMainManifest 閘。

### 3. O3 — TtsPlugin saveExportFile API29 斷裂
- Bug：`saveExportFile` 用 `MediaStore$Downloads`（API29+ 類），API24-28 裝置匯出先 NoClassDefFoundError 必斷。
- 修法：版本分支（Build.VERSION.SDK_INT < 29 用 ContentResolver/舊路徑）或方法泛化。承接 PM5 白名單內 TtsPlugin.kt。
- 驗證：Kotlin 編譯閘（gradle compileArmDebugKotlin）＋版本分支斷言 harness。

## 完成標準
佇列全數有 `fix: F10-SR1 / F6-SR1 / O3` commit＋回報五欄摘要。每顆獨立 commit、獨立驗證、獨立 md log。

## 版本
每顆 bug 結案 commit → `./tools/version.sh 5.7.x`（逐顆 +1；SR1/SR2 也在升，撞到 git pull/rebase 或波尾總統統一升）。commit 前確認 staged 三檔齊全。共享檔絕不 add。

## 注意
- `src-tauri/src/lib.rs` 是共享檔（多軌）— F10 只動 `import_piper_model_dialog` 指定 hunk，動工前 `git status` 確認無他軌殘留，只 add 你改的檔。
- gen/android 產物編譯慢，Kotlin 改動需 `compileArmDebugKotlin` 真編譯驗證。
- subagent/delegate 一律 Hermes，禁 opencode。
- 完成後 md 落盤 `_dev/notes/subagent-log/2026-08-30-SR3-*.md`。