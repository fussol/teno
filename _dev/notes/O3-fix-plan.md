# O3 修復計畫書 — TtsPlugin saveExportFile API29 斷裂

- 首相：SR3（Android/TTS 域）
- 基線：`73e3a7f`（O3 動工前實錘 HEAD；前兩顆 F10/F6 已 commit）
- 狀態：v1（送審）
- 審查：1 名委員（單一檔案、非共享、低風險、改動<20 行 — GOV-BRIEF 簡單 bug 可降 1 名）

## 1. Bug 定義
`TtsPlugin.saveExportFile`（TtsPlugin.kt:247-272）全程使用 `MediaStore.Downloads`（巢狀靜態欄位類，**API 29 才加入**）。minSdk=24 表示 API24-28（Android 7.0-9.0）裝置運行匯出時，解析 `MediaStore.Downloads.EXTERNAL_CONTENT_URI` 等靜態欄位 → **NoClassDefFoundError 直接崩潰**，匯出必斷。

實錘（platform.js:16-21／33-38）：Android 端 `downloadBlob`/`downloadBlobFromArray` → `invoke('save_export_file')` → saveExportFile。TtsPlugin.kt 現碼用 `MediaStore.Downloads.DISPLAY_NAME/MIME_TYPE/RELATIVE_PATH/EXTERNAL_CONTENT_URI`。

## 2. Root cause
`saveExportFile` 寫死 API29+ 的 MediaStore.Downloads 類而無版本分支。API24-28 上方法內走引用該類 → Art 載入類失敗 → NoClassDefFoundError。舊裝置非僅「匯出功能壞」而是 app 層面對話框瞬間崩（錯誤訊息未優雅呈現）。

## 3. 修法（TtsPlugin.kt，動工前已實錘現況）
`saveExportFile`（現 line 247-272）加版本分支：

```kotlin
@Command
fun saveExportFile(invoke: Invoke) {
    val args = invoke.parseArgs(SaveExportFileArgs::class.java)
    val filename = args.filename
    val base64 = args.data
    val mime = args.mime
    try {
        val data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
        if (Build.VERSION.SDK_INT >= 29) {
            // 現行 MediaStore.Downloads（API29+）路徑 — 不變
            val resolver = activity.contentResolver
            val contentValues = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, filename)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Teno")
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
                ?: throw Exception("Failed to create MediaStore entry")
            resolver.openOutputStream(uri)?.use { it.write(data) }
                ?: throw Exception("Failed to open output stream")
            Log.d(TAG, "saveExportFile: $filename saved to Downloads/Teno")
        } else {
            // legacy API24-28：舊路徑（getExternalStoragePublicDirectory + FileOutputStream）
            // 全限定 java.io.File/FileOutputStream（現檔無 import，line 294 以全限定寫——風格一致）
            val dir = java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Teno")
            if (!dir.exists()) dir.mkdirs()
            val outFile = java.io.File(dir, filename)
            java.io.FileOutputStream(outFile).use { s -> s.write(data) }
            Log.d(TAG, "saveExportFile(legacy): $filename saved to Downloads/Teno")
        }
        invoke.resolve()
    } catch (e: Exception) {
        Log.e(TAG, "saveExportFile error", e)
        invoke.reject("儲存失敗: ${e.message}")
    }
}
```

關鍵：`Build.VERSION.SDK_INT >= 29` 分支確保 API24-28 **永遠不執行 MediaStore.Downloads 引用**（該類只在 >=29 分支載入），NoClassDefFoundError 消除。

> **權限注意（範圍外誠實）**：legacy 分支寫公共 Downloads 需 WRITE_EXTERNAL_STORAGE，manifest 已宣告 maxSdk=28（F6 保留）。但 API23+ 的 WRITE_EXTERNAL_STORAGE 屬 runtime dangerous permission，需 `requestPermissions` — 現 app 無權限 request 機制。故 API24-28 若用戶未授權，legacy 分支會 SecurityException → reject（**優雅錯誤，不再崩潰**）。此為 O3 主 bug（NoClassDefFoundError 崩潰）的根治；完整 legacy 權限流屬另一顆（見 §6）。

## 4. 驗證方式
- Kotlin 編譯閘：`compileArmDebugKotlin` BUILD SUCCESSFUL（AAPT/Art 編譯級）。
- **版本分支 harness** `tools/verify-o3-api29.mjs`（新增，靜態釘）：
  - T0 PRE：git 基準 73e3a7f 的 saveExportFile 無 `SDK_INT >= 29` 分支、直接引用 MediaStore.Downloads（bug 事實）。
  - T1：函式含 `Build.VERSION.SDK_INT >= 29` 版本分支；`>=29` 分支保留 MediaStore.Downloads 現行邏輯。
  - T2：legacy（else）分支用 `getExternalStoragePublicDirectory` ＋ `FileOutputStream`，零 MediaStore 引用。
  - T3：**負控制**：把分支換回無條件 MediaStore → T1 偵測面必紅（bug 重現）。
  - T4：compileSdk≥29（MediaStore.Downloads 需 API29+ 編譯支援）前提釘（實錘 compileSdk=36 ✅）。
- 既有回歸：verify-f6-manifest（13/13，AM 的 WRITE maxSdk=28 保 T2）、verify-f10（30/30）。

## 5. 風險
- 低。單一函式分支，>=29 裝置行為零變更（現行邏輯原封）。<29 裝置從必崩 → 優雅（可期待權限流後完整）。
- 不影響桌面端（TtsPlugin 僅 Android gen；桌面匯出走 WebKit download）。
- F2/F17 事件契約未動（saveExportFile 無 emit）。

## 6. 範圍外清單（憲法①⑥）
- **不實作 WRITE_EXTERNAL_STORAGE runtime 權限 request 流**：現 app 無權限機制，屬新功能（AndroidManifest/MainActivity 文化）；O3 主 bug＝NoClassDefFoundError 崩潰已根治，權限流另顆（scope-requests 登記）。
- 不碰 `src/lib/*.js`、`src/pages/*.js`（他軌；platform.js 只是呼叫端，不動）。
- 不動 lib.rs、Cargo.*（他軌）。
- 不動 F6 的 WRITE_EXTERNAL_STORAGE(maxSdk=28) 保留（O3 修正後成真消費者，T2 現行 8/8 邏輯仍對）。

## 7. 可選項（憲法⑦）
- **版本分支**（本案）：最小 delta、minSdk=24 現況馬上不生崩潰。✅
- **方法泛化**（ContentResolver 統一）：API24-28 也走 MediaStore.Files，但舊版 MediaStore 無 RELATIVE_PATH，寫公共目錄同需權限，工程大且不減權限依賴 → 不採。❌
- **legacy 權限 request 流**：功能補全但非 bug 根治必要，另顆。❌（本顆）