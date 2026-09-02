# F1 修復計畫書 — Android back/退出（finish_app 三層）— v2.0（定案版）

> 組三「Android/TTS」波次 7 · 負責人：首相 C（orchestrator）
> 基準：HEAD=f99f2c9（main；D9 commit 在頂、F3 d94cbe3 為其 parent）
> 背景橋來源：**b4cc444 引入 MainActivity back callback**（__handleAndroidBack 消費者）；**F3 d94cbe3 只加 TauriLifecycleObserver 註冊**（不含 back 橋）— 委員 #3 實錘 `git log -S handleOnBackPressed`。
> v3 定案來源：`_dev/notes/fix-plan-critical-v3.md` 批次 7 F1（:179-182）
> 狀態：**✅ 三委員過審（v1.1）→ 定案（v2.0）→ 動工**
> 範圍：只碰 5 檔（MainActivity.kt、TtsPlugin.kt、tts_android.rs、lib.rs invoke_handler 行、main.js）。**不准碰** Cargo.toml（首相 B 持有）、src/lib/chart.js、src/styles/base.css、src/engine/*、src/lib/db.js、src/lib/store.js（其他首相進行中）。

---

## 1. Bug 定義

Android 上按系統返回鍵、且 SPA view stack 沒有上一頁可回時，**app 無法真正退出**：
`window.__handleAndroidBack`（main.js:425-433）走 `await getCurrentWindow().close()` — 在 Tauri v2 mobile（Android WebView）環境，此呼叫不具備「結束 Activity」的語意（WebView 內沒有可關閉的 OS window）→ Activity 不會 finishAndRemoveTask → 返回鍵變成無效或行為不可預期（視系統回退行為而定，可能只把 app 移背景）。

現況（grep 實錘）：
- `src/main.js:429`：`await getCurrentWindow().close();`（`__handleAndroidBack` 內，唯一 JS 關窗點）
- `src-tauri/gen/android/app/src/main/java/com/teno/app/MainActivity.kt:26-48`：back callback（b4cc444 引入）已接通 JS；JS 沒上一頁時指望 JS 關窗 → 落空。

## 2. Root cause

1. **JS 關窗語意錯位**：`getCurrentWindow().close()` 是桌面 window 語意；Android 端 Tauri mobile 沒有可關閉的 OS window，JS 層 close 不會觸發 Activity finish。
2. **缺少原生退出路徑**：兩個 Android plugin — TtsPlugin 與 IconPlugin（icon_android.rs:13-24 註冊）— **皆無**任何 finish/exit command（IconPlugin.kt:254 的 `activity.finish()` 為 icon alias 切換重啟的內部流程、非 command、無 JS/Rust 入口，不構成退出路徑）；Rust 側亦無對應 command（src-tauri/src 全域 grep 零 close/exit 用法，無替代退出路徑）。
3. **無防重保護**：MainActivity back callback 無 isFinishing 防重，退出過程中重複 back 可能重入。

v3 定案（4 名委員裁決，⚠️→✅ 簽名修正）：**必須三層打通** —
- Kotlin `@Command fun finishApp(invoke: Invoke)`（**必須收 Invoke** — PluginHandle 反射單參數，#1/#4 實錘）
- Rust `#[tauri::command] fn finish_app`（run_mobile_plugin 模式）+ invoke_handler 註冊
- JS `invoke('finish_app')` 取代 close()
- MainActivity 加 isFinishing 防重

## 3. 修法（檔名:行號；行號以 HEAD=f99f2c9 現況為準）

### 3.1 `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt` — 新增 finishApp command

插入點：`stop()`（:176-191）之後、`listVoices()`（:193）之前：

```kotlin
@Command
fun finishApp(invoke: Invoke) {
    Log.d(TAG, "finishApp() called")
    // F1：防重收斂（雙層之一）— JS invoke 往返期間連按 back 的二次 invoke 在此收斂（冪等）
    if (activity.isFinishing) { invoke.resolve(); return }
    activity.finishAndRemoveTask()
    invoke.resolve()
}
```

- 簽名與既有 5 個 @Command 完全一致（speak:104/stop:176/listVoices:193/saveExportFile:227/copyUriToCache:254 均 `fun xxx(invoke: Invoke)` 單參數）。
- `activity` 為 constructor 參數（:55，non-null）→ 直接 `activity.` 與既有程式碼風格一致（委員 #1 採納，棄 v3 原文 `activity?.` 之冗餘 safe-call；無 allWarningsAsErrors，兩者皆可編譯）。
- Kotlin 端 isFinishing guard：委員 #1/#3 建議強化（防重完整化）— 與 MainActivity guard 構成雙層。
- 反射命令名：Rust 端以 `"finishApp"` 呼叫 → 反射到本方法（與 `"speak"`→speak 等既有映射同機制）。

### 3.2 `src-tauri/src/tts_android.rs` — 新增 finish_app command

插入點：`stop_android()`（:56-66）之後：

```rust
#[tauri::command]
pub async fn finish_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let handle = &app_handle.state::<TtsHandle>().0;
        handle
            .run_mobile_plugin::<serde_json::Value>("finishApp", serde_json::json!({}))
            .map_err(|e| format!("Android finish: {:?}", e))?;
    }
    Ok(())
}
```

- 與 speak_android/stop_android（:32-66）同一 run_mobile_plugin 模式、同 cfg gate（cfg block 在函數體內 → 非 Android 時函數存在、回 Ok(())，desktop 零影響）。
- `use tauri::Manager` 已 import（:1-2）；serde_json 為既有依賴 → **零 Cargo.toml 變更，符合禁區**。

### 3.3 `src-tauri/src/lib.rs:1652` — invoke_handler 註冊

`tts_android::speak_android` 之後加 `tts_android::finish_app`（**只動此一行**）：

```rust
.invoke_handler(tauri::generate_handler![..., tts_android::speak_android, tts_android::finish_app, optimize_fsrs, ...])
```

### 3.4 `src/main.js:425-433` — __handleAndroidBack 改用 invoke

```js
window.__handleAndroidBack = async () => {
  try {
    if (store.actions.goBack()) return;
    await invoke('finish_app');
  } catch (e) {
    console.error('[main] android back:', e);
  }
};
```

- `invoke` 已在 main.js:10 頂層 import（`import { invoke } from '@tauri-apps/api/core'`）— **免新增 import、免動態 import**。
- 移除 `getCurrentWindow()` 動態 import（:428-429）；**保留** :411 的 F11 handler 用之（不相干；移除後 `@tauri-apps/api/window` 僅剩 F11 :411 動態 import，無未使用 import 風險）。
- catch 保留：native 端未註冊 plugin 時 graceful fallback（console.error，不拋 — 混合部署窗口下 back 靜默無效與現況 bug 持平，無 unhandled rejection）。

### 3.5 `src-tauri/gen/android/app/src/main/java/com/teno/app/MainActivity.kt:27` — isFinishing 防重

`handleOnBackPressed()` 開頭（:28 `val wv` 之前）加一行：

```kotlin
override fun handleOnBackPressed() {
  if (isFinishing) return   // F1：exit 流程中（finishAndRemoveTask 已觸發）不再重入 back
  ...
```

- `isFinishing` 為 Activity 屬性，內部匿名類別可直接存取。
- 防退：JS 已呼叫 finish_app → activity 進入 finishing 狀態後，殘留 back 事件不再觸發 evaluateJavascript / fallbackExit。
- 時機正確性：正常單次 back 呼叫前 isFinishing=false（不誤吞）；finishAndRemoveTask 內部呼叫 finish() → isFinishing 立即 true（吞殘留事件）。
- 不更動 callback 其餘邏輯（:26-48 原樣）；不觸及 onCreate 的 TauriLifecycleObserver 註冊（F3，d94cbe3）。

### 3.6 不改

- `src/lib/tts.js`：F1 與 TTS 無關（JS 只動 main.js 一處）。
- `generated/TauriActivity.kt`、`generated/WryActivity.kt`（模板產物）。
- `src-tauri/Cargo.toml`（首相 B 持有 — 本修法零 Cargo 依賴變更）。
- 工作區他人進行中檔案：src/engine/session-*.js、src/lib/db.js、src/lib/store.js、src/lib/chart.js、src/styles/base.css。

## 4. 使用點窮舉（grep 三形態）

| 形態 | grep 範圍 | 結果 |
|---|---|---|
| `getCurrentWindow().close()` | src/ 全域（--include='*.js'） | **main.js:429 唯一 1 處** → 改 invoke('finish_app') |
| `.close()` | src/ 全域（--include='*.js'） | db.js:30、app-log.js:38 — 皆 IndexedDB `db.close()`，無關（不碰） |
| `invoke('finish_app')` | src/ 全域 | 現況 0 處 → 新增 1 處（main.js:427 區） |
| `finish_app` / `finishApp` | src/ + src-tauri/ 全域 | 現況 0 處 → Rust command + invoke_handler + Kotlin method 各 1 處 |
| `getCurrentWindow`（其餘） | src/ 全域 | main.js:411/412（F11 fullscreen）— 保留不動 |
| `__handleAndroidBack` | src/ + gen/android 全域 | 定義 main.js:425；唯一消費者 MainActivity.kt:30-33（evaluateJavascript）— 兩端一致 |
| `onBackPressed` | gen/android 全域 | **MainActivity.kt:26**（addCallback）、**:45**（fallbackExit 內）；**WryActivity.kt:62-74**（基底 callback，:68-70 fallback）因 **TauriActivity.kt:35 handleBackNavigation=false 未註冊**（實錘）→ 實際 active callback 僅 MainActivity 一個；fallbackExit（MainActivity.kt:43-47 private fun，:46 為其 `isEnabled = true` 行）走 Activity 預設 finish — 本次只加 MainActivity isFinishing guard |

註：grep 複核的雜訊來源為 `src-tauri/gen/android/app/build/` 產物（dex/class/zip 等含 onBackPressed 字串）— 複核 onBackPressed 列時限定 `app/src/`（或排除 build/）；src/ 側以 `--include='*.js'` 過濾（委員 #1 發現 5 修正版：`src/teno-5.1.0/teno` 二進位實測不含該字串）。

## 5. 驗證項目

1. **前置檢查**（動工前）：`git status` 確認 F1 範圍 5 檔未被他人改動；`git log --oneline -5` 確認基準（HEAD=f99f2c9）。
2. **Rust 編譯**：`cargo check --locked`（委員 #3 補 — F1 動了 tts_android.rs＋lib.rs；專案慣例 D9/F3 皆有）。
3. **Kotlin 編譯**：`ANDROID_HOME=~/Android/Sdk ./gradlew :app:compileUniversalDebugKotlin`（F3 同款，通過為實錘）。
4. **node --check src/main.js**：語法。
5. **vite build**：前端打包全過（含 main.js 改動）。
6. **grep 複核**：§4 表格三形態重跑（--include='*.js'），確認使用點與計畫書一致、無遺漏。
7. **commit 檢查**：單 commit 僅含 5 檔（MainActivity.kt、TtsPlugin.kt、tts_android.rs、lib.rs、main.js）＋計畫書；message 標 F1 附審查輪數。
8. **混合部署註記**（委員 #2 發現 2）：JS 與 binary 需同步發布；真機驗證用同版本 build，避免 back 靜默失效難以歸因。

## 6. 風險

- **run_mobile_plugin 名稱映射**：Rust `"finishApp"` → Kotlin `fun finishApp`，與既有 speak/stop/saveExportFile/copyUriToCache 映射同一機制 — 風險低；編譯＋真機驗證兜底。
- **invoke_handler 行長**：:1652 實測 **887 chars**（委員 #1/#3 實錘修正）；只插入一個 token，不動其他 — 低風險。
- **finishAndRemoveTask 語意**：直接結束任務並從 recents 移除 — 符合「退出 app」產品語意；與舊行為（可能只移背景）相比是**收斂**，非回歸。
- **isFinishing 時機**：雙層防重 — MainActivity guard（handleOnBackPressed 最前）＋ Kotlin command 內 guard（收斂 JS invoke 往返期間連按 back 的二次 invoke；finishAndRemoveTask 對已 finishing activity 本即冪等 no-op）；正常單次 back 不誤吞。
- **退出瞬間 async 寫入中斷**（委員 #3 發現 7）：finishAndRemoveTask 直接殺 task，若退出當下有未完成 DB 寫入可能遺失；實際風險極低（back 時 app 閒置、SQLite 同步 transaction）— 註記不修。
- **desktop 影響**：`invoke('finish_app')` 在非 Android 回 Ok(())（cfg block 在函數體內模式，與 stop_android 同款）；`__handleAndroidBack` 僅 Android native 呼叫 → desktop 零影響（F11/getCurrentWindow 保留）。
- **JS 關窗語意移除**：main.js:429 改掉後，桌面端若有人手動呼叫 `__handleAndroidBack()` 不再關窗 — 此函數契約為「Android native 專用」（MainActivity 唯一消費者），桌面無消費者，非回歸。
- **他人工作區**：session-*.js/db.js/store.js/chart.js/base.css 有他首相進行中改動 — 動工只 `git add` F1 範圍 5 檔＋計畫書，**絕不 add 禁區檔**。

## 7. 審查歷程

| 輪次 | 委員 | 裁決 | 發現 / 修正 |
|---|---|---|---|
| 1 | #1（Rust/Kotlin 原生）| ✅ 通過（附 2 項必修正文字錯誤）| 發現1（中）§4「基底 TauriActivity:46 fallbackExit」引用錯誤 — fallbackExit 為 MainActivity:43-47 private fun、WryActivity 基底 callback 因 handleBackNavigation=false 未註冊 → 修正 §4；發現2（低）§6 行長 5000→887 chars → 修正；發現3（低）`activity?.` 冗餘 → §3.1 統一 activity.（採納）；發現4（低）Kotlin 端 isFinishing 防重補強 → §3.1 雙層防重（採納）；發現5（低）grep 雜訊（build 產物二進位）→ §4 註＋§5.6 --include='*.js' |
| 1 | #2（JS 使用點/契約）| ⚠️ 條件通過（修法正確，§4 一處錯誤宣稱需修正）| 發現1（低）§4 onBackPressed 行三重錯誤（WryActivity.kt:62-74 基底 callback、TauriActivity.kt:35 handleBackNavigation=false、fallbackExit 為 MainActivity 私有函數）→ 修正 §4；發現2（低）混合部署 back 靜默失效窗口 → §5.8 同步發布註記（採納）；發現3/4（低）desktop 手動呼叫變更、連按 back 雙 invoke 窗口 — §6 已涵蓋（Kotlin 端 guard 採納後收斂） |
| 1 | #3（交叉/盲點）| ⚠️ 條件通過（修法本體零阻塞，計畫書 5 處修正＋1 項驗證）| 發現1（中）§2「唯一的 Android plugin」事實錯誤（另有 IconPlugin）→ 修正 §2；發現2（中）§5 遺漏 Rust 驗證 → §5.2 cargo check --locked（採納）；發現3（低-中）§4 fallbackExit 歸屬 → 修正；發現4（低）§6 行長 887 → 修正；發現5（低）header/§1 back 橋來源（b4cc444 引入、d94cbe3 只加 observer）→ 修正 header＋§1；發現6（低）isFinishing 競態窗 → §3.1 Kotlin 端 guard（採納）；發現7（低）退出瞬間 async 寫入中斷 → §6 註記；發現8（低）desktop no-op 確認 ✅ |
| 2 | 定案 | ✅ 三委員全數過審 | #1 ✅（§4 雜訊來源指涉修正：build/ 產物為實、src/teno-5.1.0/teno 實測不含字串 → §4 註修正；Kotlin guard 直接存取與前置位置恰當、不破壞 v3 語意）；#2 ✅ 無條件（§2 icon_android.rs:13-24 off-by-one、§4 .close() 未重列 main.js:429 — 皆微瑕已吸收；Kotlin guard 對 JS 語意零影響：兩分支皆 resolve 恰一次）；#3 ✅（Kotlin guard 時機論證獨立驗證成立：isFinishing=true 僅三種不可逆結束源、guard resolve 為正確收斂非假退出、雙層無縫覆蓋、主執行緒無 race；§2 補 IconPlugin:254 activity.finish() 界定）→ 定案 v2.0 |

**v2.0 變更摘要**：第 2 輪三委員全數 ✅ → 定案；吸收 3 項低級文書精確化（§2 icon_android.rs:13-24＋IconPlugin:254 界定、§4 雜訊來源改指 build/ 產物）。

**v1.1 變更摘要**（第 1 輪三委員意見全數吸收）：§1/header back 橋來源精確化（b4cc444/d94cbe3）；§2 「唯一 plugin」→「TtsPlugin 與 IconPlugin 皆無 finish command」；§3.1 採納 activity. 風格統一＋Kotlin 端 isFinishing 雙層防重；§4 fallbackExit 歸屬＋handleBackNavigation=false 實錘；§5 新增 cargo check --locked、混合部署註記、grep --include 過濾；§6 行長 887 修正＋退出寫入中斷註記；§7 回填第 1 輪三委員。

**v1.0 變更摘要**：初版（三層修法照 v3 定案落地；使用點窮舉三形態全表；風險 7 項）。
