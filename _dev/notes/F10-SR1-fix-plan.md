# F10-SR1 修復計畫書 — import_piper_model_dialog Android 必敗

- 首相：SR3（Android/TTS 域）
- 基線：HEAD `12e9978`（v5.7.0）
- 狀態：v1（送審）
- 審查：3 名委員（跨 Rust＋Kotlin 兩語言＋安全 sanitize，非單一檔低風險）

## 1. Bug 定義
Android 端從檔案挑選器匯入 Piper 語音模型時**自動必然失敗**。兩層病灶疊加：
1. **Rust 層** `import_piper_model_dialog`（lib.rs:403-426）用 `file.as_path()` 抽取路徑——Android SAF 回傳 `FilePath::Url`（content://），`as_path()` 恆 `None` → 立刻 `Err("無效路徑")`。
2. **Kotlin 層** `copyUriToCache`（TtsPlugin.kt:275-290）落地檔名**硬編碼** `import.db`——即便 Rust 層繞過（import_db_dialog 模式已走 copy_uri_to_cache），落地仍是 .db 名，而 piper 鏈 `collect_piper_voices` 以**真實 .onnx 檔名**建語音目錄，固定 import.db 令 piper 匯入仍 100% 敗（僅錯誤訊息換臉）。

## 2. Root cause
- Rust：使用現成 content:// 鏈的正確模式在**同檔** `import_db_dialog`（lib.rs:631-658）已存在（`#[cfg]` match + `copy_uri_to_cache`），piper 版卻漏做，直接 `as_path()` 冒險抽取。
- Kotlin：`copyUriToCache` 是共用落地點（db 匯入與 piper 匯入共用），只為 db 用途寫死 import.db，未顧 piper 需真檔名。
- 附帶地雷：import.db 固定名與 db 匯入共用 cacheDir，**交錯匯入互相覆寫** — 併此單治。

## 3. 修法（檔案:行號，動工前已實錘）
### ① lib.rs（套用已封存 `_dev/notes/F10-pending.patch`，`git apply --3way` 成功）
- `import_piper_model_dialog`（現 line 403-426 → 改裝後 412-438）：
  - `#[cfg(target_os="android")]`：`FilePath::Path(p) => p`；`FilePath::Url(u)` → 委派 `copy_uri_to_cache(app_handle, u)`。
  - `#[cfg(not(android))]`：`file.into_path()`（桌面 file:// 轉 path）。
  - **殲滅** `as_path()` 抽取，改 `file_name()`。
  - `.onnx` 檔名守門（`ends_with(".onnx")`），非 .onnx 直接 Err。
- unit test `mod import_piper_path_tests`（lib.rs:2342+）：釘 `FilePath::Url(content://).as_path()==None`、`into_path()` Err、`FilePath::Path` 正常。

### ② TtsPlugin.kt `copyUriToCache`（現 line 275-290 → 改裝後 275-298）
- 用 `ContentResolver.query(uri, OpenableColumns.DISPLAY_NAME)` 取**真實檔名**。
- sanitize：`/ \` 換 `_`（擋路徑穿越）、控制字元過濾、`. / ..` 與空 → 兜底 `import.db`。
- 落地 `File(cacheDir, name)` 用真實檔名 — piper 得 .onnx，db 匯入 DISPLAY_NAME 照樣 .db，**零影響**。
- 共用 cacheDir 交錯覆寫地雷：真實檔名天然區隔，併治。

### ③ verify 腳本
- 新增 `tools/verify-f10-piper-import.mjs`：T0-T4（lib.rs crate 釘＋結構＋負控制＋鏡像＋雙目標編譯）＋T5-T6（Kotlin DISPLAY_NAME 釘＋固定名負控制）。負控制基準寫死 `12e9978`（防浮動 ref）。

## 4. 驗證方式
- `tools/verify-f10-piper-import.mjs` — 已實跑 **29/29 PASS**（含 cargo test piper 全綠、host＋aarch64-linux-android 交叉 cargo check 綠）。
- 額外：`compileArmDebugKotlin` 真編譯閘（gen/android 產物，暫緩? — SR3 域內另一顆 O3 也要動 TtsPlugin.kt，採同一顆 commit 一起編）。
- 負控制已含：剝除 Rust 改裝 → T1 殲滅釘紅；剝除 Kotlin 真檔名 → T5 紅。

## 5. 風險
- 低。Rust 套用已封存 patch（曾 23/23 綠之 F10-pending-verify 之上再加 6 釘）。Kotlin 改動僅 copyUriToCache 一函式。
- sanitize 用 ASCII 白名單擋穿越，保留 .onnx/.db 等正常檔名。
- 不影響桌面端（cfg 分流）。

## 6. 範圍外清單（憲法①⑥）
- 不碰 `src/lib/*.js`、`src/pages/*.js`、`src-tauri/Cargo.*`（他軌）。
- `src-tauri/src/lib.rs` 僅動 import_piper_model_dialog 指定 hunk＋其 unit test 追加。
- 不修 `collect_piper_voices` 本身（非 bug 病灶，行為正確，以檔名建目錄）。
- 不觸 Android 運行時真機驗證（宿主不可直跑，計畫書 §4 誠實範圍 — 編譯級＋crate 機制釘）。

## 7. 可選項（憲法⑦）
- 採用已完成封存 patch（非重寫）：零工程工期、機制已 23/23 驗證。✅
- 不引入統一 FileChooser 抽象：超出 bug 範圍，無立即價值。❌