# PM5 任務書 — Android / TTS 域

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src-tauri/src/TtsPlugin.kt`、`src-tauri/src/IconPlugin.kt`、`src-tauri/gen/android/app/src/main/AndroidManifest.xml`、`src-tauri/gen/android/app/build.gradle.kts`
- `src/lib/tts.js`
- `_dev/notes/`、`tools/verify-*.mjs`
- **不碰** `src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src-tauri/src/MainActivity.kt`

## Bug 佇列（依序；行號 2026-08-13 僅供參考，動工前實錘）
1. **F17** TtsPlugin.kt:252-260 — findVoice 仍 main thread 讀 tts.voices（ANR 風險）
2. **F18** tts.js:41-54,63-74 — Android TTS promise 無 timeout 兜底 → 事件遺失時永久 pending
3. **G9** tts.js:77-92 — native 失敗後 30 秒靜默無聲；_enVoice/pick 死碼；ttsAvailable 誤報
4. **F4** IconPlugin.kt:231-257 — alarm requestCode 0 無 cancel、finish 在 try 外、停用 running alias 的 disabled-package race
5. **F5** IconPlugin.kt:93-160 — resolve=ResolverActivity 時清理不執行、getCurrentIcon fallback 對 DEFAULT 誤判
6. **F6** AndroidManifest.xml:5 + gradle — MANAGE_EXTERNAL_STORAGE 上架風險；release cleartext block localhost LLM；無 backup 排除（DB 被雲端還原）
7. **G10** tts.js:143 — .card-panel-body 整段可點發音（含中文）

注意：tts.js 是 TTS 三檔之一（與 lib.rs 的 curl 呼叫無關，F8 已修）。F17 修完要驗不會 regression F2/F3（emit 事件）。G9 的 ttsAvailable 誤報要一起修。Kotlin 驗證：改動檔用 `kotlinc` 語法檢查或 gradle `./gradlew compileDebugKotlin`（若有）；JS 用 node --check + vite build。Android 真機驗證不可行時，寫純 JS harness 驗證 tts.js 邏輯（Kotlin 部分以 code 事實＋編譯為準）。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。