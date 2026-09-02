# F3 修復計畫書 — onPause/onStop（app 背景化中斷 TTS）— v1.1（過審版）

> 組三「Android/TTS」波次 1 · 負責人：首相 C（orchestrator）
> 基準：HEAD=cb76cbf（main；v1.0 誤寫 02618a5，委員 #1/#2/#3 抓出 — 見審查歷程）
> v3 定案來源：`_dev/notes/fix-plan-critical-v3.md` 批次 2 F3
> 依賴：**F2 事件契約（`_dev/notes/F2-fix-plan.md` §3）+ F2 Kotlin 實作**（emitSpeechEvent/currentUtteranceId/stopRequested/utteranceTexts 符號與 JS 消費端 — **F2 commit 為本 bug 動工硬性前置**，委員 #1-F2/#2-發現1/#3-發現1 一致裁決）
> 狀態：**✅ 三委員過審（v1.1）→ 動工（F2 commit 後）→ 實測全過 → 已 commit（d94cbe3）**

---

## 1. Bug 定義

app 進入背景（home 鍵／切換 app）時，Android TTS 繼續播放：背景語音持續、audio focus 未釋放（其他 app 音訊被壓抑）、回到前台時 focus 未重新請求、且背景中斷不會通知 JS。

現況：`TtsPlugin.onPause()/onResume()` 是空實作（TtsPlugin.kt:376-378），`onStop` 未 override。

## 2. Root cause

1. 無 lifecycle 停止路徑：plugin 未實作 onPause/onStop/onResume。
2. **更根本（本輪實錘，v3 盲點）**：即使實作，`TtsPlugin.onPause()/onStop()` **目前不會被呼叫** —
   - 唯一呼叫 `PluginManager.onPause()/onStop()/onResume()` 的地方是 `TauriLifecycleObserver`（`generated/TauriActivity.kt:17-32`，由官方 android-codegen 模板產生）；
   - 但**全專案無任何 `addObserver(TauriLifecycleObserver)` 註冊點**（grep 實錘：`src-tauri/gen/android/app/src` 內 addObserver 僅 `WryActivity.kt:117` 一處，註冊的是 WryLifecycleObserver；TauriLifecycleObserver 僅 :17 定義）；
   - `WryActivity.onPause()`（WryActivity.kt:132-137）只呼叫 `mWebView.onPause()`；`WryLifecycleObserver`（WryActivity.kt:23-46）只呼叫 `Rust.pause()/Rust.stop()/Rust.resume()`（native runtime 通知，與 plugin lifecycle 無關）；
   - tauri Rust 側 `src/plugin/mobile.rs` 對 Kotlin 只呼叫 `PluginManager.load()`（:244-251 區），從不呼叫 onPause/onStop（grep 零命中）；
   - tauri-2.11.3 官方模板 `mobile/android-codegen/TauriActivity.kt` 與 teno 產物逐行一致：observer 只定義、未註冊（`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.11.3/mobile/android-codegen/TauriActivity.kt` 實錘）。
   - 另：`app.tauri.plugin.Plugin` 基底確實有 `open fun onStop()`（Plugin.kt:93）、`onPause()`（:68）、`onResume()`（:73）— v3 此部分正確；`PluginManager.kt` onPause(:95)/onResume(:101)/onStop(:113) 遍歷 plugins 呼叫 instance 同名校法（實錘）。
   - 對照組：TauriActivity 的 activity 層級 hook（onActivityCreate/onNewIntent/onRestart/onDestroy/onConfigurationChanged）**已接通**（現況 TtsPlugin.onDestroy:381 確實會被呼叫）— 唯 lifecycle 三事件斷路（委員 #3 實錘，佐證 root cause 精準）。

## 3. 事件契約（引用 F2 §3）

`tts://speech:stopped`（reason=`pause`）→ JS 標記 paused（不 resolve、不 reject、不推進）。本 bug 只新增 Kotlin 側 pause 路徑（**producer**）；JS 消費端（**consumer**）已在 F2 落地。

## 4. 修法（檔名:行號；行號以 F2 commit 落地後現況為準，動工時重核）

### 4.1 `src-tauri/gen/android/app/src/main/java/com/teno/app/MainActivity.kt` — 啟用 lifecycle 橋（v3 盲點修正）

`onCreate`（:11-40）內、`super.onCreate` 之後加（TauriLifecycleObserver 同 package 免 import；ProcessLifecycleOwner 需 import）：
- 註冊時機理由：`super.onCreate` 鏈（TauriActivity.onCreate → PluginManager.onActivityCreate）已跑完、PluginManager 已初始化，無 race；ProcessLifecycleOwner 當下狀態 CREATED，addObserver 只快進觸發 onCreate 回呼（TauriLifecycleObserver 無 override → 無操作），不會立即 onResume。
- 與 WryActivity.kt:117 的 WryLifecycleObserver 不衝突：兩 observer 同掛 ProcessLifecycleOwner、各自獨立（Wry→Rust native 通知；Tauri→PluginManager 遍歷 plugins），無互相依賴。
- 替代方案對比（委員 #3-3a 實錘）：MainActivity override onPause/onStop 直接呼叫 `getPluginManager().onPause()` 為劣選 — 與官方機制重複（模板日後自註冊會雙重呼叫，PluginManager.onPause 非冪等）、繞過模板設計意圖。MainActivity 註冊為唯一最小正確點（無自訂 Application；WryActivity 為 generated 不可改）。

```kotlin
import androidx.lifecycle.ProcessLifecycleOwner   // 新增 import（:6 區）
// onCreate 內：
ProcessLifecycleOwner.get().lifecycle.addObserver(TauriLifecycleObserver)
```

### 4.2 `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt` — lifecycle 實作

1. **新欄位**（:60 區）：`private var focusNeedsRestore = false`（委員 #1-F3 採納 — 條件化 focus 恢復）
2. **`pauseTts()` private helper**（onPause/onStop 共用，冪等）：
   ```kotlin
   private fun pauseTts() {
       val id = currentUtteranceId
       if (id == null && !isSpeaking) return          // 無進行中 → no-op（防 onPause/onStop 雙觸發重複 emit）
       stopRequested = true                            // 在 tts?.stop() 之前設（引擎回調必在 stop 之後 → F2 listener 的 stopRequested 檢查防雙重 emit，無 race）
       tts?.stop()
       isSpeaking = false
       abandonAudioFocus()
       stopPolling()
       if (id != null) {
           emitSpeechEvent("tts://speech:stopped", id, "pause", utteranceTexts.remove(id))
           currentUtteranceId = null
           focusNeedsRestore = true
       }
   }
   ```
3. **`override fun onPause()`**（:376）：`Log.d(TAG, "onPause()"); pauseTts()`
4. **`override fun onStop()`**（新增）：`Log.d(TAG, "onStop()"); pauseTts()`（第二次進入時 id 已 null → no-op）
5. **`override fun onResume()`**（:378）：**不自動 resume**（v3 定案）；**條件化 focus 恢復**（委員 #1-F3/#3-發現2 採納 — 避免無條件 requestAudioFocus 在每次回前台/冷啟動佔用 focus 壓制其他 app 音訊；且用戶重播時 speak() 自身已會 request）：
   ```kotlin
   Log.d(TAG, "onResume()")
   if (focusNeedsRestore) { requestAudioFocus(); focusNeedsRestore = false }
   ```

### 4.3 不改

- `src/lib/tts.js`：F2 已含 stopped(pause) 消費（標記 paused）→ F3 commit 不動 JS（委員 #2 確認欄位一致）。
- `generated/TauriActivity.kt`、`generated/WryActivity.kt`（模板產物，不改 — 避免與 tauri 重產衝突）。

## 5. 使用點窮舉（委員 #3 複核修正版）

| 形態 | 位置 | 結果 |
|---|---|---|
| `TauriLifecycleObserver` | 僅 `generated/TauriActivity.kt:17`（定義） | 本修法補註冊點（MainActivity.onCreate）|
| `PluginManager.onPause/onStop/onResume` | 僅 `generated/TauriActivity.kt:25/30/20`（observer 內） | 註冊後生效（PluginManager.kt:95/113/101 遍歷 plugins）|
| TtsPlugin onPause/onResume override | TtsPlugin.kt:376/378 | 實作；onStop 新增 override |
| `requestAudioFocus()` 呼叫點 | TtsPlugin.kt:112（speak）、:342-347 定義 | onResume 新增條件呼叫點 |
| `abandonAudioFocus()` 呼叫點 | TtsPlugin.kt:**:167**（stop）、:153（speak 失敗）、:275/:285/:297/:313/:325（listener/polling）、:349-356 定義、:389（onDestroy） | pauseTts 新增 1 呼叫點 |
| stopped(pause) 消費 | `src/lib/tts.js`（F2 新增 listen，reason==='pause' 分岔） | F2 範圍，F3 不重複 |
| IconPlugin lifecycle | IconPlugin.kt 全文無任何 lifecycle override（grep 實錘） | 註冊 observer 後零影響（走 Plugin 基底空實作）|
| 替代註冊點 | manifest 無自訂 Application；WryActivity 為 generated | 無遺漏（委員 #3-3c）|

## 6. 驗證項目

1. **前置 gate**（委員 #2-發現1/#3-發現1）：動工前 `git log --oneline -5` 確認 F2 commit 存在；`grep -n "speech:stopped" src/lib/tts.js` 確認消費端落地。
2. **Kotlin 編譯**：`ANDROID_HOME=~/Android/Sdk ./gradlew :app:compileDebugKotlin`（真機留待後續）。
3. **重跑 F2 驗證工具**：`node tools/verify-tts-contract.mjs` 確認零回歸（F2 §6-1 已含 stopped(pause) 案例）。
4. **vite build**：JS 側無改動，確認無意外影響。
5. **commit 檢查**：單 commit 僅含 `MainActivity.kt` + `TtsPlugin.kt` 兩檔、message 標記 `F3` 並附依賴的 F2 commit hash。
6. **真機行為（後續）**：`input keyevent KEYCODE_HOME` 背景化 → logcat 確認 onPause→onStop 順序且 stopped(pause) 僅 emit 一次（冪等實錘）；回前台確認 onResume 且無自動重播。

## 7. 風險

- **重複觸發**：ProcessLifecycleOwner 的 onPause 與 onStop 都會來（app 進背景：onPause → onStop）→ `pauseTts` 冪等（id==null no-op）保證只 emit 一次 stopped(pause)。
- **語意範圍**：ProcessLifecycleOwner 是「整個 app 無可見 activity 才觸發」— 通知列下拉/系統對話框（activity 層級 pause）不會誤停 TTS；鎖屏（onStop）會停；分屏（仍可見）繼續播。符合「背景化才停」產品語意（委員 #1-f/#3-3b 實錘；teno 為單 activity app，等價 activity 層級）。
- **F2 未先行 ⇒ 死事件**（委員 #2-發現1）：新版 Kotlin stopped(pause) 對舊版 JS 是無消費者死事件 → promise 永久 pending。→ §6-1 前置 gate 硬性防堵。
- **pause × pronAuto 組合**（委員 #2-發現2/3）：背景化時 autoAdvance 的 `await playCardTTS` 掛起 → 回前台後 30s timeout 兜底（.catch 吞掉 → autoAdvance 恢復）；若用戶立即重播 → F2 槽覆蓋強化（見 F2 §4.2.3 修訂：覆蓋時 settle 舊槽 resolve cancelled + clearTimeout）→ autoAdvance 即時恢復。已由 F2 強化 + F2 §4.3 .catch 雙路徑消除，剩餘「30s 停滯窗」列為已知產品行為（v3 定案「不自動 resume」之自然後果）。
- **背景化 emit 延遲**（委員 #3-發現3）：`WryActivity.onPause` 先執行 `mWebView.onPause()` → JS 暫停 → stopped(pause) 延遲至回前台才被 JS 處理（webView.post 走 main looper 不因背景暫停，事件不丟）。行為安全（webview paused 時 JS 本就不推進）；真機驗證時勿誤判「事件未發」。
- **不自動 resume**：回前台不重播（v3 定案；用戶重新觸發即可 — speak() 自身會 requestAudioFocus）。
- **與 F2 交錯**：stopRequested 在 pause 時設 true → 之後任何引擎回調被 F2 的 listener 防重邏輯攔截；下次 speak() 重設 false。
- **generated 檔案**：TauriActivity.kt/WryActivity.kt 不改（只改 MainActivity.kt 與 TtsPlugin.kt，均在波次 1 組三範圍）。
- **R8/ProGuard**：TauriLifecycleObserver 已現於 universalRelease seeds.txt（實錘）→ 無 shrink 風險。
- **tauri 升級**：模板升級可能改變 observer 註冊方式 — 本修法在 MainActivity 註冊官方提供的 observer，語意相容。

## 8. 審查歷程

| 輪次 | 委員 | 裁決 | 發現 / 修正 |
|---|---|---|---|
| 1 | #1（Kotlin/lifecycle）| ✅ 可動工 | F-1 基準 HEAD 過時（02618a5→cb76cbf）→ 修正；F-2 F2 commit 為前置未明示 → §6-1 gate；F-3 onResume 無條件 requestAudioFocus 搶焦副作用 → focusNeedsRestore 條件化採納；F-4 focus loss listener 空實作 → backlog 註記（範圍外）；F-5 v3 差異為合理強化 → 無需改 |
| 1 | #2（JS 契約消費端）| ❌ → 修正後 ✅ | 發現1（高）「F2 已含消費端」目前為假（F2 未 commit）→ §6-1 前置 gate + §7 風險；發現2（中高）pause 槽覆蓋不 settle 舊 promise → autoAdvance 永久停滯 → **提案 F2 槽覆蓋強化（F2 §4.2.3 修訂採納：覆蓋時 settle 舊槽 + clearTimeout）**；發現3（中）不自動 resume × pronAuto 停滯 30s → §7 已知行為；發現4（低）F2 timeout 清 _pausedUtterance → 轉 F2 動工採納；發現5（低）generated/ 路徑前綴 → 修正 |
| 1 | #3（交叉/盲點）| ❌ → 修正後 ✅ | 發現1（阻塞）F2 符號未落地（4 符號 + JS 消費端）→ §6-1 gate；發現2（中）onResume 無條件 requestAudioFocus 空 focus 佔用 → 條件化採納；發現3（低中）背景化 emit 延遲未揭露 → §7 註記；發現4（低）§5 行號失準（補 :167、:284→:285）→ 修正；發現5（低）基準 → 修正；另實錘對照組（activity hook 已接通、PluginManager 遍歷、IconPlugin 零影響） |
| 2 | 定案 | ✅ | v1.1 全數吸收，無委員再異議 → 動工（F2 commit 後）|
| 3 | 動工（首相 C）| ✅ commit `d94cbe3` | 依 §4.1/§4.2 落地：MainActivity.kt onCreate 註冊 `ProcessLifecycleOwner.addObserver(TauriLifecycleObserver)`（同 package 免 import；super.onCreate 後註冊，PluginManager 已初始化無 race）；TtsPlugin.kt 新增 focusNeedsRestore 欄位＋pauseTts() 冪等 helper＋onPause/onStop 實作＋onResume 條件化 focus 恢復。實測全過：`:app:compileUniversalDebugKotlin` 通過（產物 class 實錘）、`node tools/verify-tts-contract.mjs` 10/10、`vite build` 679ms 成功。commit 僅含兩 Kotlin 檔（chart.js/base.css 舊改動與計畫書未入）。前置 gate（F2 `b620d46` 存在＋tts.js:81 消費端）通過 |

**v1.1 變更摘要**：§2 補對照組實錘；§4.2 採納 focusNeedsRestore 條件化 focus 恢復（onResume）；§6 新增前置 gate 與 commit 檢查項；§7 補 F2 未先行死事件、pause×pronAuto 組合、背景化 emit 延遲、R8 四項風險；§5 行號修正（:167、:285）；§8 回填三委員結果與採納清單。
