# F2 修復計畫書 — TTS 事件遮蔽（utteranceId 契約化）— v1.1（過審版）

> 組三「Android/TTS」波次 1 · 負責人：首相 C（orchestrator）
> 基準：HEAD=cb76cbf（main；v1.0 誤寫 02618a5，委員 #1/#2/#3 皆確認兩 commit 間 TtsPlugin.kt/tts.js 零變動，行號全有效）
> v3 定案來源：`_dev/notes/fix-plan-critical-v3.md` 批次 2 F2
> 依賴：本計畫書同時定義 **F2 ↔ F3 共用事件契約**（先定契約）；F3 計畫書引用本契約。
> 狀態：**✅ 三委員過審（v1.1）→ 動工 → 實測 → commit**

---

## 1. Bug 定義

Android TTS 的事件回傳有「遮蔽」問題：多個 speak 交錯時，舊 utterance 的完成/錯誤事件會誤觸當前語音的 promise；停止語音被當成「完成」；JS 側對事件零過濾、零超時保護。

具體現象：
1. **事件無 utteranceId 辨識**：Kotlin emit payload 不帶 utteranceId（TtsPlugin.kt:276、:286、:299、:314、:326），JS 側 `listen('tts://speech:done')` 無條件觸發全域 `_speechResolve`（tts.js:42-47）。舊語音的 done 事件可誤 resolve 新語音的 promise。
2. **stop() 誤發 done**：Kotlin `stop()` 呼叫後 emit `tts://speech:done`（TtsPlugin.kt:169）→ JS 把「被使用者停止」當成「正常完成」。語意錯。
3. **雙重 emit 風險**：`tts.stop()`（:165）後部分引擎仍會回調 `onDone`/`onError`（:270/:280/:292）→ done 與 stopped 可能重複 emit；且 `onError(deprecated)` 與 `onError(int)` 兩者可能都呼叫 → 雙重 error。
4. **JS 無 timeout**：Android TTS 卡住時 promise 永不 settle（tts.js 無任何 timeout）。
5. **id→text 無對應表**：emit 的 text 欄位多為空字串 `""`，payload 無從查回原文。

## 2. Root cause

- Kotlin 側：`utteranceId` 是 `speak()` 的 local 變數（TtsPlugin.kt:126），只在 `setupListener(expectedId)` 的閉包中傳遞，沒有提升為 plugin 狀態；所有 emit 點手寫 payload 且漏帶 id；`stop()` 用 done 事件表達停止語意。
- JS 側：`_speechResolve`/`_speechReject` 是裸函數（tts.js:22-23），listen callback 不檢查事件來源；無 timeout 機制；`stopSpeech()` 預先清空槽（:97-98），即使 Kotlin 改發 stopped 事件也無從配對。

## 3. 事件契約（先定 — F2 ↔ F3 共用）

**Kotlin emit（統一帶 utteranceId + reason）：**

| 事件 | reason | 語意 |
|---|---|---|
| `tts://speech:start` | （不傳，JS 不檢查）| 開始播放，payload 帶 utteranceId + text（id 傳遞通道，契約擴充）|
| `tts://speech:done` | `finish` | 自然播完 |
| `tts://speech:error` | `error` | 播放失敗，payload 帶 error 訊息 |
| `tts://speech:stopped` | `user` ｜ `pause` | user=使用者/程式主動停止；pause=app 背景化中斷 |

**JS 語意：**
- `done(finish)` → resolve 完成
- `error` → reject
- `stopped(user)` → **resolve cancelled**（promise 以「被取消」語意結束；**不推進**）
- `stopped(pause)` → **標記 paused**（模組級 `_pausedUtterance` 記錄；**不 resolve、不 reject、不推進**；槽保留至 timeout 或下次 speak 覆蓋）

**責任指派（委員 #1-F6 / #2-M2 採納）**：`stopped(pause)` 的 **Kotlin emit 由 F3 實作**（onPause/onStop lifecycle）；**F2 落地 JS 消費端**（stopped 監聽 + pause 分岔，以 mock 驗證）。F2 commit 中該分岔為前瞻相容（契約對稱、F3 即時啟用）。

⚠️ 硬性：JS 與 Kotlin 同版本部署（單 commit 同時改兩側 — 見 §6 commit 檢查項）。

## 4. 修法（檔名:行號）

### 4.1 Kotlin — `src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`

1. **欄位化**（:57-61 區）：
   - `@Volatile private var currentUtteranceId: String? = null`（@Volatile：OEM 引擎有 binder thread 回報案例，listener 非主執行緒讀取需可見性 — 委員 #1-F1）
   - `@Volatile private var stopRequested = false`
   - `private val utteranceTexts = ConcurrentHashMap<String, String>()`（id→text 對應表；**各 emit 終態點 remove 防無界成長** — 委員 #1-F2/#3-2）
2. **`speak()`**（:94-160）：
   - `val id = UUID.randomUUID().toString(); currentUtteranceId = id; stopRequested = false; utteranceTexts[id] = text`（用 local id 供下游 :127/:130/:136/:140/:149 沿用，避免 `!!` — 委員 #1-補充1）
   - 成功分支（:146-151）：emit start 改 `emitSpeechEvent("tts://speech:start", id, "", text)`（不傳 reason）
   - 失敗分支（:152-158）：emit error 帶 id + reason=`error` + text + error；**保留 `invoke.reject("TTS speak failed: $result")`**（委員 #2-M1 明示 — 這是 JS 唯一的即時 reject 通道，error 事件因 slot id 未回填必被 ignore）；`invoke.reject` 前清潔：`currentUtteranceId = null; utteranceTexts.remove(id)`（委員 #1-F3，避免對「從未開始的 utterance」空發 stopped）
3. **`setupListener()`**（:262-305）：**改無參，移至 `load()`（:84-92）建立一次**（委員 #1-F7；避免每次 speak replace listener object）；listener 內比對 `utteranceId == currentUtteranceId`；onDone/onError 開頭加 `if (stopRequested) { isSpeaking = false; stopPolling(); return }`（防 stop 後引擎回調雙重 emit）；命中後 `if (currentUtteranceId == utteranceId) currentUtteranceId = null` + `utteranceTexts.remove(utteranceId)`；emit 帶 `utteranceId` + reason（done=`finish`、error=`error`）+ 查表 text
4. **`stop()`**（:162-171）：
   - `stopRequested = true`；`tts?.stop()`；`isSpeaking = false`；`abandonAudioFocus()`；`stopPolling()`
   - 若 `currentUtteranceId != null` → `emitSpeechEvent("tts://speech:stopped", id, "user", utteranceTexts.remove(id))`（remove 先取值再 emit）並 `currentUtteranceId = null`
   - **不再 emit done**；無進行中語音（id null）→ 不 emit、無副作用；二次 stop 冪等
5. **polling fallback**（:307-333）：兩個 emit done 點（:314/:326）改 `emitSpeechEvent("tts://speech:done", utteranceId, "finish", utteranceTexts.remove(utteranceId))`（閉包捕獲參數），emit 後 `if (currentUtteranceId == utteranceId) currentUtteranceId = null`（委員 #1-F4/#3-3 — 防後續 stop() 空發）
6. **emit 統一 helper**（:358 前新增；委員 #1-F5 採納 — reason 預設空字串，start 不傳）：
   ```kotlin
   private fun emitSpeechEvent(event: String, utteranceId: String?, reason: String = "", text: String? = null, error: String? = null) {
       val payload = JSObject().apply {
           put("utteranceId", utteranceId ?: "")
           put("reason", reason)
           if (text != null) put("text", text)
           if (error != null) put("error", error)
       }
       emitJsEvent(event, payload)
   }
   ```
   ⚠️ **禁止改動 `emitJsEvent` 的 webView.post 機制**（:358-372）— §7 FIFO 保證（start 必先於 done/stopped）依賴它（委員 #2-補充1）。
7. **`onDestroy`**（:380-390）：加 `stopRequested = true`、`utteranceTexts.clear()`
8. 註記：失敗分支的 error emit 對 JS 是 dead code（無 start → slot id null 永不命中），保留作除錯用途（委員 #1-F8）。

### 4.2 JS — `src/lib/tts.js`

1. **槽物件化**（:22-23）：
   ```js
   let _speechResolve = null; // { utteranceId, resolve, reject, timer }
   let _pausedUtterance = null; // 契約：stopped(pause) 標記，不 resolve 不推進（目前無消費端，純契約標記 + 未來 resume 用）
   ```
2. **listen 區**（:40-55）：done/error callback 加 `payload` 參數與 id 比對 `slot.utteranceId === e.payload?.utteranceId`；比對失敗（含槽 null）→ ignore；命中 → 清槽 + clearTimeout + settle + `if (_pausedUtterance === slot.utteranceId) _pausedUtterance = null`（委員 #2-L2 清潔）。
   - **新增 `listen('tts://speech:start')`**：`if (!slot || slot.utteranceId != null) return; slot.utteranceId = payload.utteranceId`（**`!= null` 判定** — 防空字串 falsy 誤回填，委員 #2-L5）；**回填時重設 timeout**（先 clearTimeout 再以 30s 重設 — 委員 #3-6：長音訊 >30s 不被誤殺，timeout 自 start 起算）
   - **新增 `listen('tts://speech:stopped')`**：id 比對命中後分岔 — `reason === 'pause'` → `_pausedUtterance = slot.utteranceId`（不 resolve 不 reject）；其餘（user/未知）→ 清槽 + clearTimeout + `slot.resolve({ cancelled: true })`
3. **`speakAndroidTts()`**（:63-74）：
   ```js
   function speakAndroidTts(text, speed, voice, pitch) {
     return new Promise((resolve, reject) => {
       if (_speechResolve) {
         // 強化（F3 委員 #2-發現2 提案採納）：覆蓋前 settle 舊槽 + clearTimeout —
         // 防止 pause 槽被覆蓋後舊 promise 永久 pending（pronAuto await 停滯）
         const prev = _speechResolve;
         clearTimeout(prev.timer);
         prev.resolve({ cancelled: true });
         stopAndroid().catch(() => {});
       }
       _pausedUtterance = null;
       const slot = { utteranceId: null, resolve, reject, timer: null };
       _speechResolve = slot;
       armTimeout(slot);
       androidSpeak(text, { speed, voice }).catch(e => {
         if (_speechResolve === slot) {
           _speechResolve = null;
           clearTimeout(slot.timer);
           reject(e);
         }
       });
     });
   }
   ```
   （timeout 邏輯抽為模組級 `armTimeout(slot)`：clearTimeout 舊 timer 再設 30s；回調內 `_speechResolve !== slot` → no-op（只清自己的槽）；命中 → 清槽 + 清 `_pausedUtterance`（若同 id，F3 委員 #2-發現4 採納）+ `reject(new Error('TTS timeout'))`）
   ⚠️ id 由 Kotlin 的 start 事件回填（JS 無法自產，Android utteranceId 綁定 `KEY_PARAM_UTTERANCE_ID`）；id 未回填（null）時收到的 stopped 必為前一個 utterance 的（FIFO 保證 start 先於本槽可達的 stopped；連播時 stopped(A) 的 post 先於 start(B)）→ ignore 正確。
   
5. 移除 `_speechReject` 裸變數（併入槽物件；:45/:51/:67/:70/:98 五個舊引用點全落在改寫區內）；`speechSynthesis`（非 Android）路徑完全不動。

### 4.3 連帶修改（委員 #3-發現1 採納 — 修正 v1.0「零呼叫端需改」之誤）

`browser.js:491` 與 `deck-browser.js:1407`（`scheduleNext` 內 `st.pronAuto` 分支）是 `await playCardTTS(...)`（→ `return speak(...)`）的**真實 promise 消費者**：F2 新增的 30s timeout reject（及既有 error reject）會在此 throw → `scheduleNext` 提早退出 → **autoAdvance 自動播放中斷 + unhandled rejection**。

- `src/pages/browser.js:491`：`if (w.pron) await playCardTTS(_cardState.s, w.word).catch(() => {});`
- `src/pages/deck-browser.js:1407`：同上改法
- 語音錯誤/超時不再中斷自動播放（順帶修復現況 error-reject 中斷）；其餘 6 個呼叫點純 fire-and-forget，無需改。

## 5. 使用點窮舉

**grep 三形態（委員 #3 獨立複核，除發現1 語意修正外全數吻合）：**

| 形態 | 位置 | 結果 |
|---|---|---|
| import | session-spell-utils.js:86、session-utils.js:228、study-mc.js:4、study-spell.js:4、study-v4.js:3、settings.js:8、browser.js:8、deck-browser.js:4、exam-flip.js:4、exam-mc.js:4、exam-spell.js:4/423 | 無需改（tts.js 匯出面不變）|
| speak( 呼叫 | **await 消費者（2）**：browser.js:491（scheduleNext/pronAuto）、deck-browser.js:1407（同）→ §4.3 加 .catch｜**fire-and-forget（6）**：settings.js:734、browser.js:715、deck-browser.js:288、session-utils.js:229、session-spell-utils.js:94、exam-spell.js:424（動態 import + .catch）｜tts.js 內 bindSpeakClick 委派（:155） | §4.3 兩處改 |
| stopSpeech 呼叫 | browser.js:483、deck-browser.js:1399（頁面離開/換卡停止） | 無需改 |
| 事件監聽 | 僅 tts.js:42/48（done/error）；stopped/start 為新增 | 無第三方監聽者 |
| Kotlin emit 點 | TtsPlugin.kt:151(start)、:154(error)、:169(stop→done)、:276(onDone)、:286/:299(onError)、:314/:326(polling done) | 全部改走 emitSpeechEvent 帶 id+reason |

## 6. 驗證項目

1. **JS 行為測試（node）**：新增 `tools/verify-tts-contract.mjs` — node v26 `module.register` loader 攔截 `./api.js`、`./platform.js`、`@tauri-apps/api/event` 三模組（stub；api.js 內部 import '@tauri-apps/api/core' 會被真實解析失敗 → loader 須完全替代三模組 — 委員 #3 確認可行），`node:test` + mock timers：
   - speak→start(id)→done(id) ⇒ resolve
   - speak→done(舊 id) ⇒ ignore（promise 仍 pending）
   - speak→start(id)→stopped(id,user) ⇒ resolve(cancelled) 且「不推進」無副作用
   - speak→start(id)→stopped(id,pause) ⇒ 不 resolve 不 reject（標記 paused）
   - timeout 30s ⇒ reject('TTS timeout')；換槽後舊槽 timeout 不誤殺新槽；pause→timeout 不誤殺後續新槽
   - **start 回填重設 timeout**：start 後 35s 才 done ⇒ 仍 resolve（長音訊不被誤殺）
   - **連播順序**：speak A→speak B，事件序 start(A)→stopped(A)→start(B)（A 的 start 晚到、slot B id 未定）⇒ **B 不誤 resolve**（委員 #2-L1 用例）
   - **speak 失敗**：androidSpeak invoke reject ⇒ 恰一次 reject、error 事件零命中、無 pending 槽殘留（委員 #1-補充2）
   - stopSpeech() ⇒ stopped(user) 自然 resolve
2. **vite build**：語法 + 打包全過。
3. **Kotlin 編譯**：`ANDROID_HOME=~/Android/Sdk ./gradlew :app:compileDebugKotlin`（真機留待後續）。
4. **commit 檢查（同版本部署硬性落地 — 委員 #3-發現7）**：單 commit 同時含 `TtsPlugin.kt` + `tts.js` + `tools/verify-tts-contract.mjs`（+ §4.3 兩檔案）；commit message 標記 `F2`。
5. **cargo check**：本 bug 不動 lib.rs，確認無意外影響。

## 7. 風險

- **事件順序**：`webView.post` FIFO（:362-370）→ start 必先於 done/stopped 到達；start 回填 id 後事件才可能命中。**此機制禁止改動**。
- **版本混搭**：新版 Kotlin emit 帶 id、舊版 JS 不比對 → done 仍無條件 resolve（舊行為）；新版 JS 比對 id、舊版 Kotlin 不帶 id → 永不命中（語音卡死至 timeout）。→ 硬性同版本部署（§6-4 檢查項）。
- **start 回填污染 race**（委員 #2-L1）：程式化連發（同 JS task 內 speak A→B）時事件序 start(A)→stopped(A)→start(B) 可能把 A 的 id 回填進 slot B → B 被誤 resolve(cancelled)。影響僅 console 層級（Kotlin 播放不受 JS 槽影響、呼叫端全 fire-and-forget）；人類點擊節奏下機率極低。verify tool 加順序測試鎖定。
- **listen 註冊競態**（委員 #3-發現5）：模組載入早期 speak → start 事件遺失 → id 永不回填 → 30s timeout 兜底 reject。現況同窗口更糟（done 遺失 → 永不 settle）；列為已知限制（timeout 兜底）。
- **引擎雙重回調**：stopRequested 旗標 + 槽命中後清空（第二事件無槽可配）雙保險。
- **polling 與 listener 雙通道**：都帶 id，JS 只認第一個命中（resolve 後槽清）。
- **stop 無進行中語音**：Kotlin 不 emit（currentUtteranceId null；polling/listener 命中後已清欄位），JS 槽不存在 → 無副作用。
- **paused 槽保留至 timeout**：30s 後 timeout reject（fire-and-forget 下僅 console 雜訊；重播時舊槽覆蓋、timeout 同一性不誤殺）。
- **timeout reject 於 await 消費點**：browser.js:491 / deck-browser.js:1407 已加 `.catch(() => {})`（§4.3）→ autoAdvance 不中斷；其餘 fire-and-forget 點無 throw 影響。
- **IPC 順序**：`stopAndroid()` 不 await（連播時 stop 先於 speak invoke）— Tauri invoke 單通道 FIFO 下成立。
- **unhandledrejection 雜訊**：fire-and-forget 呼叫點的 reject 會產生 webview console 雜訊（非致命，現況 error reject 已有同行為）。

## 8. 審查歷程

| 輪次 | 委員 | 裁決 | 發現 / 修正 |
|---|---|---|---|
| 1 | #1（Kotlin/Android）| ✅ 可動工 | F-1 @Volatile currentUtteranceId；F-2 utteranceTexts 只增不減（各 emit 終態 remove）；F-3 speak 失敗分支清欄位；F-4 polling done 後清欄位；F-5 helper reason 預設值；F-6 stopped(pause) 無 Kotlin 落地點（→ 契約指派 F3）；F-7 setupListener 無參 + load() 建一次；F-8 失敗 error emit 為 dead code 註記；F-9 基準 HEAD → 全部採納 |
| 1 | #2（JS 狀態機）| ✅ 可動工 | M1 失敗分支明示保留 invoke.reject → 採納（§4.1.2）；M2 stopped(pause) emit 責任指派 → 採納（§3）；L1 start 回填污染 race → §7 + 測試；L2 _pausedUtterance 清潔 → 採納（§4.2.2）；L3 unhandledrejection 雜訊 → §7 註記；L4 基準漂移 → 修正；L5 start guard 改 `!= null` → 採納 |
| 1 | #3（契約/交叉）| ❌ → 修正後 ✅ | 發現1 **browser.js:491 / deck-browser.js:1407 為 await 消費者（pronAuto）**，v1.0「零呼叫端需改」不實 → §4.3 加 .catch + §5 修正宣稱（**本次最重大盲點**）；發現2 utteranceTexts 無界 → 採納；發現3 polling 清欄位 → 採納；發現4 基準漂移 → 修正；發現5 listen 註冊競態 → §7；發現6 長音訊 >30s 誤殺 → start 回填重設 timeout；發現7 同版本部署落地為 §6-4 檢查項 → 採納；發現8 細節三則 → 覆蓋時 clearTimeout、stopAndroid IPC FIFO 註記、_pausedUtterance 無消費端註記 |
| 2 | 定案 | ✅ | v1.1 全數吸收（3 委員 + F3 委員 #2 後續提案：覆蓋槽 settle + clearTimeout、timeout 清 _pausedUtterance → 已併入 §4.2.3），無委員再異議 → 動工 |

**v1.1 變更摘要**：基準 HEAD 修正；§3 契約責任指派；§4.1 補 @Volatile/remove/清欄位/invoke.reject 保留/helper 預設；§4.2 補 start 重設 timeout、`!= null` guard、_pausedUtterance 清潔、armTimeout 結構；**新增 §4.3 連帶修改（browser.js/deck-browser.js .catch）**；§5 修正消費者分類；§6 加 4 個測試用例 + commit 檢查項；§7 補 5 項風險。
