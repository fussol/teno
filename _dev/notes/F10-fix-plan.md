# F10 修復計畫 — import_piper_model_dialog Android 必敗（SAFE URI 未處理）

狀態: **v1.2 SKIP-PENDING-SR**（R1 委員鑿出阻斷：正修需改 gen/android/TtsPlugin.kt（白名單外）→
鐵律⑦登 F10-SR1 跳過改派；lib.rs 半成品补丁封存 `_dev/notes/F10-pending.patch`，
改派者併 SR 一次修完整。v1.1 曾自驗 23/23 綠但被 R1 證偽——見 §7）
日期: 2026-08-28
審計來源: bug-audit-2026-08-13.md :113（行號漂移：audit :397-398 → 實 :415-449）

## 1. Bug 定義（行號實錘）
Android 上 `import_piper_model_dialog`（lib.rs:414-449）選檔後直接
`file.as_path()...ok_or("無效路徑")`（HEAD 版抽取段）。Android 檔案挑選器
（SAF）回的是 `FilePath::Url(content://…)`，`as_path()` 對 Url 變體
**恆 None**（tauri-plugin-fs-2.5.1 file_path.rs:42-47，源碼實錘），
`ok_or` 直接 Err("無效路徑") ——Android 使用者 100% 失敗。
本倉庫同檔 `import_db_dialog`（:614）早有正確模式（cfg 分支＋
copy_uri_to_cache），F10 是该慣例的遺漏點。

## 2. Root cause
`FilePath::Url → as_path() → None`（tauri-plugin-fs file_path.rs:42-47）。
輔助實錘（本單新釘 cargo 測）：content:// 走 `into_path()` 亦 Err
（內部 Url::to_file_path 非 file scheme 必敗）——常規轉換全封死，
唯一活路是 copy_uri_to_cache（Kotlin openInputStream 讀 content://）。
源碼級 + 真 crate 運行級雙重實證（import_piper_path_tests 3 條）。

## 3. 修法（鏡同檔 import_db_dialog :614-625 既有模式，逐字同構）
- 函式改 async（dialog 改 oneshot + `.pick_file()` 非阻塞，與 import_db_dialog
  逐字同構——同檔既有慣例優先於自創 blocking 模式）
- `#[cfg(target_os = "android")]` 分支：
  `match file { FilePath::Path(p) => p, FilePath::Url(u) => PathBuf::from(copy_uri_to_cache(app_handle.clone(), u.to_string()).await?) }`
- `#[cfg(not(target_os = "android"))]` 分支：`file.into_path()`（桌面 file:// 也吃得住）
- 副加守門：`src.file_name()` + `.onnx` 檔名驗證（防呆）；複製錯帶 e 上下文
- copy_uri_to_cache 委派不改本體；回呼單次 send（oneshot 雙發 panic 防範）

## 4. 驗證方式
- **cargo unit test ×3（`import_piper_path_tests`，真 crate 非 replica）**：
  - `url_variant_as_path_is_always_none`：SAF content:// URL 構造的 FilePath::Url
    → as_path() 恆 None（= bug 機制本體）
  - `content_uri_into_path_also_fails`：into_path() 同封死（佐證分支設計）
  - `path_variant_exposes_path`：Path 變體對照組
- **tools/verify-f10-import-piper-android.mjs**：
  - T0 cargo piper 全集（16 條：F9 13 + F10 3）
  - T1 結構釘 ×10：async/oneshot/pick_file、cfg android、Path/Url match、
    copy_uri_to_cache 委派、cfg(not) into_path、**as_path() 零殘留**、
    .onnx 守門、落地錯上下文、send 單次、add_filter 保留
  - T2 負控制（真舊碼 git HEAD 提取非編造）×4：舊抽取 as_path().ok_or 在位、
    舊碼零 cfg 分支、舊碼零委派、反換回工作檔後殲滅釘回紅
  - T3 鏡像慣例 ×2：import_db_dialog 模式未破壞＋兩函式抽取語意逐字同構
  - T4 編譯釘 ×2：host cargo check ＋ **aarch64-linux-android 交叉 cargo check**
    （NDK 27 env 顯式注入 CC/CXX/AR/LINKER；android 分支唯一宿主級驗證手段）
  - 初跑誠實登記：首版 T1/T3 全紅＝斷言錯載 blocking 版設計（實裝鏡像版），
    修斷言對齊源碼事實，產品碼零改；重跑 **23/23 ALL PASS**
  - 範圍誠實：Android 真機選檔流程宿主不可跑（需 SAF UI）；
    證據鏈＝機制釘(T0)＋結構釘(T1)＋負控制(T2)＋雙目標編譯(T4) 四段閉合，
    終端運行確認留使用者真機（plan §6 登案）

## 5. 風險
- 低：鏡本檔 import_db_dialog 已在生產驗證的既有模式；
  桌面路徑 as_path→into_path 語意等價；cargo test 16 條 piper 全綠
- dialog 非阻塞化：同檔同模式，行為與 import_db_dialog 一致
- ~~copy_uri_to_cache 落地檔名 sanitize 兜底~~ **勘誤（R1）**：本倉庫
  TtsPlugin.kt:272 落地檔名**硬編碼 "import.db"**，零 sanitize/兜底邏輯，
  v1.1 §5 敘述不實（推測了別倉庫實作），特此收回

## 6. 範圍外（登案不動）
- Android piper TTS 全鏈：TtsPlugin.kt 零 onnx 字樣（全文 grep 實證），
  Android 語音走系統 TextToSpeech；本單修 dialog command 正確性，
  不宣稱「接通 Android piper」。前端 importPiperModelBtn 在 Android 被
  settings.js:208 isAndroid gate 隱藏——修後 UI 入口仍隱，
  是否放開屬產品決策，登案總統
- copy_uri_to_cache 落地檔名 UTF-8 lossy（tts_android.rs:121 to_string_lossy）
- piper_models_dir 每調用 readdir（既有）

## 7. 審查紀錄

### R1（1 委員，簡單 bug 席次）：❌ 阻斷 1
- 委員實測：(a) verify 23/23 重跑綠 ✅ (b) cargo 16/16 ✅ (c) 負控制 git HEAD 舊碼
  as_path().ok_or 在位＋file_path.rs:42-47 源碼屬實 ✅ (d) 消費者唯一鏈 ✅
  (e) diff 純度 ✅（48+/5-）
- **阻斷（f 邊界攻擊）**：TtsPlugin.kt:272 `copyUriToCache` 落地檔名硬編碼
  `"import.db"` → Android Url 分支落地 fname="import.db" → `.onnx` 守門必然拒絕
  → SAF 路徑仍 100% 失敗（僅錯誤訊息換臉）。首相 grep 覆核原文屬實。
  驗證鏈抓不到因屬 Kotlin 運行期事實——**跨端委派鏈的下游合約不在本檔驗證面內**，
  「鏡像既有模式」不等於「端到端可用」，此為本單最大教訓（記 skill）
- 委員並抓出首相 v1.1 兩處文書不實：§5「Kotlin sanitize/兜底」為推測他庫實作
  （本倉零此邏輯，已勘誤收回）；§3「函式改 async」（HEAD 本已 async，diff 無此變化）
- 處置：正修需改 gen/android/TtsPlugin.kt（白名單外）→ 鐵律⑦登 **F10-SR1** 跳過。
  lib.rs 改裝回滚（`git checkout`），补丁封存 F10-pending.patch、驗證封存
  F10-pending-verify.mjs（T1 需加釘：Kotlin 落地名不得硬編碼），改派者兩檔一單修完整
- 首相裁決說明：非計畫書寫錯被打回，是 **bug 真身橫跨兩檔**、白名單只給一半——
  半修 commit 等於交付「錯誤訊息較好看的必敗路徑」，違完成標準，故整單掛 SR
