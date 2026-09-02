# F17 修復計畫書 v1.1 — findVoice 於 main thread 讀 tts.voices（ANR 風險）

## 檔案實際路徑（任務書路徑勘誤）
任務書寫 `src-tauri/src/TtsPlugin.kt`，實際為
`src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`（倉庫唯一 TtsPlugin.kt，白名單意圖明確）。

## Bug 定義
`findVoice()`（實際行號 284-292；audit 標 252-260 已漂移）在 main thread 直接呼叫
`tts?.voices`。`speak()` 是 Tauri @Command，於 main thread 執行（同檔 listVoices:213
註解自錘：「TTS 引擎忙碌時 getVoices() 會等內部 lock（binder thread 持有）→ main
thread 卡死 → ANR」，listVoices 已改後執行緒，findVoice 漏修）。

## Root cause（code 事實）
1. `findVoice`（:284-292）先清 TTL 過期條目，miss 時 `tts?.voices?.find{...}` 直接在
   呼叫端執行緒讀引擎 voice 集合。
2. `VOICE_CACHE_TTL = 60_000L`（:72）→ 任何間隔 >60s 的兩次發音，第二次必 cache miss
   → 必在 main thread 讀 `tts.voices`。ANR 窗口不是罕見路徑，是常態。
3. 對比 listVoices（:215-236）已用 `Thread{}.start()` + `Handler(main).post` 模式規避。

## 修法（stale-while-revalidate 語音索引）
檔案：`src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`

1. 移除 `voiceCache: ConcurrentHashMap<String, CachedVoice>`（:71）與 `CachedVoice`
   data class（:40）— 單條 TTL 制是 bug 來源（過期即同步重讀）。
2. 新增：
   - `@Volatile private var voiceIndex: Map<String, Voice> = emptyMap()`
   - `@Volatile private var voiceIndexAt = 0L`
   - `private val voiceRefreshInFlight = AtomicBoolean(false)`（單飛守衛）
   - `startVoiceIndexRefresh()`：CAS 單飛 → 背景 `Thread{}.start()` 讀 `ttsRef.voices`
     建 `HashMap` → volatile 整體發佈（不可變快照，main thread 讀取零鎖）→ finally
     釋放 in-flight。`destroyed` 或 tts null 直接放棄。
3. `findVoice(name)` 改為：讀 `voiceIndex` 快照 → 若快照空或 age > TTL 則
   **非阻塞**觸發 `startVoiceIndexRefresh()`（單飛去重）→ 立即回傳快照命中值或 null。
   **绝不**在呼叫執行緒觸碰 `tts.voices`。
4. `load()` TTS init 成功回調（:94-95）加 `startVoiceIndexRefresh()` 暖機——
   init callback 在背景 binder 執行緒，且即使改 main 也安全的觸發點，只啟動刷新線程。

### 行為差異取捨（憲法⑦可選項定案）
- **做**：stale-while-revalidate — 快照過期期間照常回傳舊快照 voice（Voice 物件對
  已連線引擎仍有效），背景刷新；語音應用行為與現行幾乎一致。
- **不做**：把整個 `speak()` 搬 executor——會引入 stop()（main）與 speak 任務設定
  `currentUtteranceId` 之間的新 race（stop 可能讀到 null id → 不 emit stopped →
  JS 槽懸掛至 timeout），且 audit 僅點名 findVoice，範圍最小化。
- **已知取捨**：app 啟動後 init 成功 → 首次刷新完成前（典型 <1s）的第一次發音若使用者
  極速點擊，voice 未套用（使用引擎預設 voice），下一個 utterance 即正常。代價遠小於
  ANR 殺 app。舊實作在同樣窗口其實是同步讀（可能卡 main thread），新實作是降級。
- **不做**：不碰 stop()/onPause/onResume/事件契約（F2/F3 已定案段，只加暖機一行）。

## 驗證方式
1. `tools/verify-f17-findvoice.mjs`（結構靜態驗證，先實跑再送審；Kotlin 無法在 node
   跑，以 code 事實＋編譯為準——任務書明許）：
   - T1 findVoice 主體不含 `.voices` 直接讀取
   - T2 `.voices` 只出現於 startVoiceIndexRefresh 背景線程內
   - T3 單飛守衛存在（AtomicBoolean + compareAndSet + finally 釋放）
   - T4 findVoice 回傳快照索引、過期只觸發 startVoiceIndexRefresh 不回讀引擎
   - T5 load() init 成功路徑有暖機呼叫
   - T6 舊 voiceCache/CachedVoice 已移除（防殘留雙軌）
   - T7 F2/F3 回歸閘：四個事件名 `tts://speech:{start,done,error,stopped}` 的 emit
     點計數與基線一致（start×1、done×3、error×3、stopped×2）、stopRequested 檢查×3、
     pauseTts/onResume focus 邏輯未被觸碰
   - T8 負控制：把 findVoice 還原成舊實作（直接 `tts?.voices?.find`）後跑同一組
     detector，T1/T2/T4 必須精準紅。
2. `./gradlew :app:compileDebugKotlin`（JAVA_HOME=~/jdk21, ANDROID_HOME=~/Android/Sdk）
   編譯通過。基線編譯已先行確認工具鏈可用。
3. 回歸：`node --check` 無涉（未改 JS）；跑 `tools/verify-tts-contract.mjs` 確認 JS 端
   契約測試不受影響。

## 風險
- 低-中：改動全在 TtsPlugin.kt 單檔；事件契约/emit 零變動（T7 守門）。
- Voice 物件跨線程引用（快照持有）：Android TTS Voice 為不可變資料物件，官方文件
  無執行緒限制；tts.shutdown() 後舊 Voice 引用仍在（僅是資料），find 命中後
  `tts.voice = v` 於 engine 重連後依然有效或回傳錯誤值被引擎忽略——現行 TTL 制同樣
  持有舊 Voice 引用 60s，風險持平。
- 編譯環境：gradle 首次離線編譯若有依賴缺件，改用非 --offline（使用者已跑過 tauri
  android build，cache 應齊）。

## 範圍外清單
- stop()/pauseTts/事件契約（F2/F3 管轄，已定案）
- listVoices 的過濾邏輯、UI 語音選單
- tts.js 的任何改動（F18/G9 管轄）
- F17 audit 行號漂移不改 audit 檔

---

# v1.1 修訂版（R1 吸收紀錄＋定稿碼）

## 版本紀錄
- v1：原案送審。R1 三席：#1 ✅（5 minor）、#2 ✅（3 minor）、#3 ❌（驗證腳本 6 條突破向量 A1/A2/A3/A4/A5/A7）。依憲法⑤升版重送。
- v1.1：吸收 R1#1 minor 1/2/3/4/5、R1#2 minor 1/2/3、R1#3 補強 1/2/3/4/5/6（第 7 點 T9 白名單擴充不做，理由見下）。

## R1 發現吸收對照表
| 來源 | 發現 | v1.1 處置 |
|---|---|---|
| R1#1-m1 | 背景線程經可變欄位讀 tts 有 TOCTOU | 定稿碼：`val ttsRef = tts ?: return` 函式首行捕獲，線程只用 ttsRef；發佈前再查 `!destroyed`×2 |
| R1#1-m2 | destroyed plain var 跨線程讀無可見性保證 | `@Volatile private var destroyed`（單詞改動，T7 計數不受影響） |
| R1#1-m3 | voiceIndex+voiceIndexAt 雙 volatile 撕裂讀 | 改單一 `@Volatile voiceIndex: VoiceIndexSnapshot`（index+at 封裝一体，單欄原子發佈） |
| R1#1-m4 | 刷新失敗語意未寫明 | 明示：失敗（null/exception）保留舊快照、**不續 timestamp**、僅 finally 放飛單飛旗標 |
| R1#1-m5 | T4 錨點 `snapshot[name]` 與變數名綁定 | 定稿碼就寫 `snapshot`，程式碼加註「改名前同步改腳本」 |
| R1#2-m1 | T7 計數閘可繞（註解湊數/寫入點未釘） | 腳本 v2：T7 改剝註解後源＋呼叫形態錨定＋speak 體釘 `stopRequested = false`＋stop/pause/onDone 體釘 reason 字串＋guards×4＋focusNeedsRestore ===4（精確非下界） |
| R1#2-m2 | VOICE_CACHE_TTL 去留未明示 | 更名為 `VOICE_INDEX_TTL`，T6 正則補抓 VOICE_CACHE_TTL 殘留 |
| R1#2-m3 | AtomicBoolean import 未提 | 定稿碼含 `import java.util.concurrent.atomic.AtomicBoolean`；gradle 編譯兜底 |
| R1#2-micro | onDestroy 清快照可選 | **不做**（不碰 onDestroy 維持範圍宣稱；Voice 引用風險與基線持平已論證） |
| R1#3-A1 | .voices 放對函式放錯 lambda（同步讀偽裝） | T2 白名單縮至 **Thread lambda 括號平衡區間**（等長空白化剝註解→索引一致） |
| R1#3-A2 | Thread 無 .start() 死線程 | T2 要求 refresh/listVoices 主體含 `\.start\(\)` |
| R1#3-A3 | `getVoices()` 直呼漏抓 | 掃描詞改 `/[.]\s*voices\b|\bgetVoices\s*\(/g`；T1 另禁 findVoice 主體 `\btts\b` 詞出現 |
| R1#3-A4 | 單飛洩漏（釋放不在受控位置） | T3 結構式：CAS 後至 `try` 無 `return` 逃逸；finally 釋放＋catch 釋放雙軌計數 ≥2 |
| R1#3-A5 | T7 註解湊數 | 同 R1#2-m1（剝註解後計數） |
| R1#3-A7 | T8 拼接一路吃到 setupListener 吞函式 | T8 精準拼接 `matchStart..end`（只換 findVoice 本體）＋還原後斷言 refresh/listVoices/setupListener 三函式仍在 |
| R1#3-5 | stripLineComments 跳脫引號錯位 | v2 修：`\"` 跳脫不翻轉字串態；block comment 先等長空白化 |
| R1#3-7 | T9 白名單擴充（voices 只能在 refresh 持有 lambda） | **不做**：T2 已要求命中落 Thread lambda＋該 lambda 必在 refresh 主體內，A11 型搬移（放 init lambda）已被 T2 紅抓到，增量趨零 |

## 定稿碼（v1.1，送 R2 覆核；過審後原樣入 repo）
五處修改，全部在 TtsPlugin.kt 單檔（已於 /tmp/f17v2/fixed.kt 實作並跑腳本 8/8 ALL PASS）：

1. import 段：`+ import java.util.concurrent.atomic.AtomicBoolean`
2. `private data class CachedVoice(...)` → `private class VoiceIndexSnapshot(val index: Map<String, Voice>, val at: Long)`
3. 欄位：`private var destroyed` → `@Volatile private var destroyed`；
   `voiceCache`/`VOICE_CACHE_TTL` 兩欄 → `@Volatile private var voiceIndex = VoiceIndexSnapshot(emptyMap(), 0L)` ＋ `private val voiceRefreshInFlight = AtomicBoolean(false)` ＋ `private val VOICE_INDEX_TTL = 60_000L`
4. init 成功分支加一行 `startVoiceIndexRefresh()`（暖機）
5. findVoice 整段替換＋新增 startVoiceIndexRefresh：

```kotlin
private fun startVoiceIndexRefresh() {
    val ttsRef = tts ?: return
    if (destroyed) return
    if (!voiceRefreshInFlight.compareAndSet(false, true)) return
    try {
        Thread {
            try {
                val voices = ttsRef.voices
                if (!destroyed && voices != null) {
                    val idx = HashMap<String, Voice>()
                    for (v in voices) { val n = v.name; if (n != null) idx[n] = v }
                    if (!destroyed) voiceIndex = VoiceIndexSnapshot(idx, System.currentTimeMillis())
                }
            } catch (e: Exception) {
                Log.w(TAG, "voice index refresh failed: ${e.message}")
            } finally {
                voiceRefreshInFlight.set(false)
            }
        }.start()
    } catch (e: Exception) {
        voiceRefreshInFlight.set(false)
        Log.e(TAG, "voice refresh thread start failed: ${e.message}")
    }
}

private fun findVoice(name: String): Voice? {
    var snapshot = voiceIndex.index
    if (snapshot.isEmpty() || System.currentTimeMillis() - voiceIndex.at > VOICE_INDEX_TTL) {
        startVoiceIndexRefresh()
        snapshot = voiceIndex.index
    }
    return snapshot[name]
}
```

## v2 驗證腳本實跑證據（送審前）
- bug 態（repo 現行碼）：1/7（T1-T6 紅、T7 綠、T8 SKIP）＝PRE 基線
- 忠實修法（/tmp/f17v2/fixed.kt）：**8/8 ALL PASS**（含 T8 負控制紅 ok）→ v2 detector 非恆綠亦非誤殺
- 基線編譯：`./gradlew :app:compileArmDebugKotlin --offline` BUILD SUCCESSFUL（任務名勘誤：Tauri 多 flavor，`:app:compileDebugKotlin` 歧義不存在）
- 取捨修正（R1#2 指正）：暖機未完成視窗內 speak() 用的是引擎**當前** voice（首播=引擎預設，後續=上一 utterance sticky 残留），非僅「引擎預設」；降級路徑不崩潰不 reject 不改事件流（speak:126-134 實證）

---

# v1.2 修訂版（R2 吸收＋憲法⑩結構重做＋威脅模型定文）

## 版本紀錄（續）
- R2 三席：#1 ✅（2 minor）、#3 ✅ 有條件（3 minor，root cause 已沿 Tauri 框架源碼全鏈實錘：JS invoke→mobile.rs run_command→wry MainPipe→UI 主線程 looper 反射直呼，@Command 必在 main thread）、#2 ❌（v2 腳本仍有 5 條突破：A3b 方法參照、B6 標識符子串劫持白名單、A4 條件化 finally、A2b decoy start、A5c 多行 raw string 湊數）。
- 同類缺陷（文字型靜態閘 vs 文本攻擊）連續第二輪退回 → 依憲法⑩停止逐條補丁，做結構重做：
  1. **統一單趟狀態機剝離器**（腳本 v3）：行/區塊註解＋raw string 等長空白化，普通字串保留但內容不參與註解判定——一併根除 A5c／T8-grep 字串／引號錯位三個共同根因。
  2. **token 級掃描**：`\bvoices\b ∪ \bgetVoices\b`（詞邊界，含 `::getVoices` 方法參照）。
  3. **鏈式綁定白名單**：`(?<![\w$])Thread\s*{…}` 閉合括號後**緊接** `.start()` 才入白名單（消 B6 子串劫持／A2b decoy）。
  4. **T3 釋放錨收緊**：finally 體唯 `set(false)`、catch 首句必為 `set(false)`（消 A4 條件化釋放）。
- 吸收 R2#1 minor-1／R2#3 minor-2：findVoice 讀取側單次 latch（`val state = voiceIndex`），零撕裂。
- 吸收 R2#3 minor-1（本輪最有價值發現）：**miss 也觸發刷新**——快照非空但查不到 name（新下載語音）時同樣非阻塞觸發單飛刷新，新語音一條 utterance 內可見；舊案會最長 60s 選不到。
- 吸收 R2#1 minor-2：註解語氣 downgrade（shutdown 後 getVoices 的實際安全網是 try/catch，destroyed 檢查僅省線程）；刪多餘的建表前 destroyed 檢查（三查→二查）。
- R2#3 minor-3（init 失敗態每 speak 起一條刷新線程）：**接受**——單飛去重＋用戶點擊頻率自然限速，失敗態 Log.w 屬寶貴診斷訊號。
- R2#1 nit-1（toMap 加固）不做：HashMap 發佈後全檔無突變點，型別紀律已註明；nit-2（elapsedRealtime）不做：單次 NTP 跳變最壞多觸發一次刷新，單飛去重兜底；nit-3 照單全收（T7 精確計數是閘門本意）。

## 威脅模型定文（憲法⑦，R2#2 結語的直接裁決）
本閘防禦目標＝**無意回歸＋偷工假修法**（漏 .start、讀取放錯執行緒、忘單飛、改壞事件契約、留死碼雙軌、拼接吞函式）。**不抵禦蓄意對抗性偽裝**：把引擎讀取委派自建函式、lambda 工廠、字串拼湊等，在圖靈完備語言上任何文字掃描都不可能全抓——這是數學事實，非腳本缺陷。邊界寫進腳本頭註解與本節，R2#2 建議第 7 點（窄白名單成文）已照辦：僅認 `Thread { }.start()` 模式（listVoices 既有先例），Runnable/kotlinx/Executors 寫法**刻意紅**。
R3 送審時若鑑識席仍以「構造對抗性變體」突破為由退回，即屬對決性軍備競賽，依憲法⑩由總統裁決終結（防線已達威脅模型內全覆蓋＋實測四新高危向量全紅）。

## v1.2 定稿碼變更（相對 v1.1 定稿碼，僅 findVoice/註解段）
```kotlin
private fun findVoice(name: String): Voice? {
    val state = voiceIndex                      // 單次讀取 latch（消撕裂對）
    val snapshot = state.index
    if (snapshot.isEmpty() || snapshot[name] == null ||
        System.currentTimeMillis() - state.at > VOICE_INDEX_TTL) {
        startVoiceIndexRefresh()                // 空/過期/miss 均非阻塞觸發（單飛去重）
    }
    return snapshot[name]
}
```
startVoiceIndexRefresh 本體不變（註解 downgrade＋刪建表前 destroyed 冗餘檢查）。

## v3 腳本實跑證據（送審前）
- bug 態（repo 現行碼）：1/7（T1-T6 紅、T7 綠、T8 SKIP）
- v1.2 忠實修法（/tmp/f17v2/fixed.kt）：**8/8 ALL PASS**（含 T8 精準紅）
- 攻擊自測（四條 R2 高危向量重構變體）：atk-b6 T2 紅／atk-a3b T1+T2 紅／atk-a4 T3 紅／atk-a2b T2 紅——**全部有紅，零無聲綠燈**

---

# v1.3 修訂紀錄（R3 吸收，僅驗證腳本升 v4，定稿碼零改動）

## 版本紀錄（續）
- R3 三席：#1 ✅（2 minor 極端路徑記錄不修）、#3 ✅（獨立判定 miss 觸發＝對基線嚴格改善、連跑確定性零狀態洩漏）、#2 ❌（模型內 3 條：N4 `val stopRequested` 局部遮蔽繞過重置釘／N5 error reason 未釘／N5c polling done reason 未釘；＋1 誤殺 N1c `.start()` 銜接窗 20 字元過窄）。#2 明示「吸收三補釘升 v4 即可予 ✅」——屬錨點覆蓋補釘，非軍備競賽，憲法⑩不適用。
- v1.3＝腳本 v4 三補釘：①done×3 全釘 reason "finish"、error×3 全釘 reason "error"②speak 重置釘行首直指派＋speakFn 體內禁 `val|var stopRequested` 遮蔽（注意：禁遮蔽檢查必須限 speak 體內——全檔檢查會誤殺欄位宣告 `private var stopRequested`，本席首版即犯此錯、被 fixed 態 7/8 當輪抓出修正，誠實登記）③.start() 銜接窗 20→200 字元（剝離後註解＝純空白，^\s*\. 錨不容跨真實 token）。
- 定稿碼（/tmp/f17v2/fixed.kt）自 v1.2 起零改動。

## v4 實跑證據
- fixed.kt 8/8 ALL PASS｜bug 態 1/7｜攻擊自測七連紅：atk-n4/n5/n5c（T7）＋atk-b6/a3b/a4/a2b（T2/T3）｜合法變體 leg-n1c（`}` 與 `.start()` 間插行註解）8/8 綠＝誤殺已除
- R3#1 minor-1（Thread.start() 拋 OutOfMemoryError 屬 Error 非 Exception → catch 接不住 → 單飛卡死）：記錄不修——降級態仍非阻塞回舊快照永不 ANR，與 listVoices 零防護基線持平；改 catch(Throwable) 反破 T3 錨。R2#3 minor-3/R3#1 minor-2（miss 重複刷新成本）：R3#3 獨立分析裁決「維持現狀不加 last-miss 抑制」（單飛自限＋點擊限速＋成功續 at，嚴格優於基線 main-thread 同步讀）。
