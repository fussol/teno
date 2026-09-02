# G9 計畫書 v1 — native TTS 失敗後 30 秒靜默／_enVoice·pick 死碼／ttsAvailable 誤報

PRE 基線 pin：`ed00132`（動工前 HEAD，本 bug 態存在）。
行號實錘（HEAD ed00132 之 src/lib/tts.js，audit 行 77-92 已漂移）：
- 靜默窗：`_nativeFailTime` 冷卻閘 :127（`_hasNative !== false || (failTime>0 && now-failTime>30000)`
  為假時 **整個 speakAsync 無聲 resolve**——無發音、無 toast、無 console）。
- 死碼：`_enVoice` :17 賦值後全檔零讀取；`pick`/`speechSynthesis.onvoiceschanged` :40-52。
- 誤報：`ttsAvailable` :155-158 `return _hasNative !== false || typeof speechSynthesis !== 'undefined'`
  ——native 已死時，只要瀏覽器有 speechSynthesis 就回 true，但**發音路徑從不走
  speechSynthesis**（speakAsync 只呼 nativeSpeak）→ 誤報。

## 1. Bug 定義（audit bug-audit-2026-08-13.md:136）
G9｜tts.js:77-92｜🟠｜native 失敗後 30 秒靜默無聲；_enVoice/pick 死碼；ttsAvailable 誤報｜📖

## 2. Root cause
1. **靜默窗**：冷卻設計把「避免重試失敗 call 開銷」放對，但實現成「失敗後 30s 內
   speak() 直接靜默 return」——使用者點發音得到零反饋（無聲無 toast），比失敗更糟。
   且自動發音（session-utils:244 等）踩進窗口時連 console 都無。
2. **死碼**：桌面發音唯一路徑是 native plugin（nativeSpeak），Web Speech 从未用於發音；
   pick/_enVoice 是早期「speechSynthesis fallback」殘留，fallback 被移除後殘骸未清。
   getVoices/onvoiceschanged 每事件週期白跑。
3. **誤報**：ttsAvailable 的 `speechSynthesis !== 'undefined'` 分支假設了已不存在之
   fallback。消費者窮舉（憲法②）：**ttsAvailable 于 src/ 零消費者**（僅匯出面），
   改語意無現有呼叫端破壞風險；未來消費者得到誠實值。

## 3. 修法（全在 src/lib/tts.js，預估 ±35 行）
1. **刪死碼**：:17 `_enVoice`、:40-52 整個 `if (typeof speechSynthesis !== 'undefined')` 塊。
2. **拆冷卻靜默**（speakAsync :126-143）：每次 speak 皆重試 native（刪 `_nativeFailTime`
   閘），失敗仍標 `_hasNative=false`＋toast，但 **toast 節流 30s 一次**（新增
   `_lastFailToast`，Date.now 比較）——語意從「30s 靜默」改為「30s 只警告一次、每次都試」。
   同步刪 `!isAndroid` 死守衛（speak():99 Android 已提前 return，speakAsync 僅桌面可達）。
3. **ttsAvailable 誠實化**：Android→true（Kotlin TTS 恆在，F17 降級路徑仍發音）；
   桌面→`_hasNative !== false`（首次呼叫前樂觀 true、連續失敗後 false）。
   刪 `|| speechSynthesis` 分支。
4. 可選項定案（憲法⑦）：
   - `stopSpeech` 桌面分支 `speechSynthesis.cancel()` **保留**——現態為 no-op 防呆
     （萬一未來有非經 speak 的 utterance 入列），零成本；audit 死碼旗僅點 _enVoice/pick。
   - toast 節流 30s 非 0/非永久：**採 30s**——0＝自動發音每卡洗屏；永久＝使用者手動重試
     時無反饋。節流只壓 toast，不壓重試。
   - `_hasNative` 首次樂觀 true 非 null→false 保守：**採樂觀**——消費者（如設定頁
     依可用性隱顯發音钮）誤隱藏成本 > 誤顯示（點了無聲→POST 必 toast）。
   - 不引入 speechSynthesis 真 fallback：範圍外，另案產品決策。

## 4. 驗證方式（tools/verify-g9-tts-fallback.mjs，先行實跑）
- 雙態：PRE＝`git show ed00132:src/lib/tts.js` 至 /tmp 以 desktop stub 實跑（失敗後第二次
  call：native 呼叫數不增＝靜默重現＋ttsAvailable 誤報 true 重現）；POST＝工作區真碼。
- POST 斷言：失敗後立即重試（native 呼叫數++）、toast 節流（30s 內 1 次、跨窗再報）、
  成功路徑零 toast、ttsAvailable 三態（樂觀 true→失敗 false→成功 true）、stopSpeech
  cancel 保留、Android 分支 `if (isAndroid) return true` 靜態釘。
- 死碼靜態釘：HEAD 檔無 `_enVoice|getVoices|onvoiceschanged`；ttsAvailable 體內無
  `speechSynthesis`；speakAsync 無 `_nativeFailTime`。
- 負控制：NC1 工作區碼拼回「靜默閘」→ 重試斷言紅；NC2 拼回 speechSynthesis 分支 →
  誤報斷言紅。
- loader：verify-tts-contract-loader.mjs 平台 stub 改讀 `globalThis.__ttsPlatformIsAndroid`
  （預設 true，契約測試零行為變動），G9 腳本設 false。
- 回归：tts-contract 10＋f11 29＋d19 32＋b6 72＋build。

## 5. 風險
- 中低：speakAsync 語意變更（重試策略）——消費者 8 處全 fire-and-forget 或 .catch
  （browser.js:505/715、deck-browser.js:288/1421、exam-spell:487、session-utils:244、
  session-spell-utils:100、settings:736、bindSpeakClick 委派），Promise 簽名不變。
- desktop 使用者在 native 永久死環境會每次呼叫吃一次 invoke 失敗（毫秒級 reject）——
  換取「永不靜默」。節流後 toast 不洗屏。
- Android 路徑零觸碰（speak :99 提前 return 之後的代碼）。

## 6. 範圍外清單
- speechSynthesis 真 fallback 實作（產品決策）。
- Android TtsPlugin.kt 失敗事件面（F2/F17 域）。
- settings.js 依 ttsAvailable 隱顯按鈕的未來消費者（本單只修語意）。
- toast 元件本身樣式/佇列策略。
- nativeSpeak（api.js/lib.rs）層重試。

## 版本紀錄
- v1（本檔）：首版送審。凍結。
- 升版動能登記：憲法版本規範第1條 fix commit 一律升版，但 aec329a 之後本波全部 PM 軌
  fix commit（D10/OCR-IMP/F17/G10）慣例未升版（package.json 白名單外＋多首相並發升版
  必然衝突）→ 依鐵律7登案 scope-requests.md 不逕改，留總統波尾裁示。
- v1.1（R1 結果 ✅❌✅ → 必修項修畢）：
  - 【R1#1 ❌→修】F1 幽靈信道：`window.__toast` 全 repo 零賦值端（真信道 main.js:434
    `window.toast`；CSS 無 .toast-warn）——PRE 真 app 態實為**每次失敗皆雙重靜默**
    （audit 低估），舊 harness 自供幽靈全域掩蓋之。修法：改讀 `window.toast`＋
    `typeof === 'function'` 守衛＋type 改 'toast-error'（CSS 存在類）；驗證 stub 改
    真信道形態；新增 T7b 成對靜態釘（讀取端↔main.js 賦值端，改名必紅）；T0 如實登記
    PRE 雙重靜默。
  - 【R1#1 S1/S2 採納】`_lastFailToast` 初始 `-Infinity`（epoch 未同步鐘首報誤壓）＋
    catch 內時鐘後跳 clamp——T9 實測兩邊界。
  - 【R1#2 強烈建議① 採納】T7 加節流機制釘（Date.now＋_lastFailToast）封死換制偽裝
    通道；after() 加 mock.timers.reset() 兜底。
  - 【R1#3 採納】commit 嚴禁夾帶他軌髒檔；升版登案不逕改；共享 loader 增量改動留痕。
  - 驗證腳本 11→13 斷言全綠；回歸 contract 10/f18 11/f11 29/d19 32/b6 72/build 全綠。
  - R1#1 明示「修畢本席轉✅」→ 依 F17 判例 1 席複核（僅驗處方落實，代碼不再動）。
- 威脅模型邊界登記（R1#1）：信道形態不一致屬「驗證有效性缺口」非對抗漏洞——教訓：
  **harness 嚴禁供給被驗證的信道本身**。
