# F18 計畫書 v1 — Android TTS promise 無 timeout 兜底（結論型：已被 F2 吸收，結案登記）

## 0. 結論（先講）
F18 的宣稱（「Android TTS promise 無 timeout 兜底 → 事件遺失時永久 pending」）
**對 HEAD 已不成立**。timeout 兜底由 `b620d46`（fix: F2，2026-08-15，晚於 audit 掃描日
2026-08-13）的槽物件化重構完整引入。本單交付物 = **驗證腳本 + absorbed 登記**，
src 代碼零改動（改動 0 行；加一個假改動只為湊 `fix:` 前綴違反誠實歸責，不做）。

## 1. Bug 定義（audit 原文）
`bug-audit-2026-08-13.md:121`：tts.js:41-54,63-74｜🟠｜Android TTS promise 無 timeout
兜底 → 事件遺失時永久 pending｜驗證旗 📖（書面，未實測）。

## 2. Root cause ＋ 時間線實錘
### 2a. 掃描時點為真（git show dabfea1:src/lib/tts.js，2026-08-12，audit 前一日）
- `speakAndroidTts`：僅 `_speechResolve/_speechReject` 兩欄位，**無任何 timer**。
- 監聽器只有 `done`/`error` 兩個；**連 `tts://speech:stopped` 都沒監聽**。
- 事件遺失／Kotlin 未 emit（使用者 stop 後無事件、原生回調丟失）→ promise 永久 pending，
  `pronAuto` 等 await 呼叫端卡死。audit 行號 41-54（done/error listeners）、63-74
  （speakAndroidTts）與該版逐行吻合——**F18 當時是真 bug，判定無誤**。

### 2b. b620d46（F2，2026-08-15）已吸收
- 槽物件 `{ utteranceId, resolve, reject, timer }`＋`armTimeout`（HEAD tts.js:30-38）：
  30s 到點若槽仍是自己 → 清槽＋清 pause 標記＋`reject('TTS timeout')`。
- speak 建槽即挂 timer（HEAD :115，**先挂再 invoke**，invoke 事件全丟也有兜底）。
- start 回填時重挂（HEAD :63）：長音訊自 start 起算 30s，兼顧兜底與誤殺。
- `stopped(user/pause)` 分岔監聽（HEAD :81-93）補上。
- 契約測試 `tools/verify-tts-contract.mjs` test 5/6/7 已鎖 timeout 三態。

## 3. 窮舉路徑表（憲法②：HEAD 逐事件序列走查，「永久 pending」是否仍存在）
| # | 事件序列 | HEAD 兜底點 | 結果 |
|---|---|---|---|
| P1 | invoke 成功但 start/done/error/stopped 全遺失 | :115 speak 時挂的 timer | 30s reject ✅ |
| P2 | start 到達、done/error 遺失 | :63 重挂 timer | start+30s reject ✅ |
| P3 | invoke reject（api.js catch） | :116-122 即時 reject＋clearTimeout | 即時 settle ✅ |
| P4 | 下一 speak 覆蓋舊槽 | :105-111 覆蓋前 resolve cancelled＋clearTimeout | 舊槽即時 settle ✅ |
| P5 | stopped(user) | :90-92 resolve cancelled | settle ✅ |
| P6 | stopped(pause) 後無任何後續事件 | pause 不 cancel timer（:84-87 僅標記），原 timer 續跑 | timeout reject，不懸掛（contract test 7 鎖定）✅ |
| P7 | 混入異 id 幽靈事件 | 各監聽 id 比對 ignore（:60/:67/:75/:83），timer 不受幽靈 clearTimeout（timer 欄位綁槽） | timer 照常兜底 ✅ |
| P8 | stopSpeech 後 Kotlin 未 emit | 槽保留＋timer 續跑（:147-149 註明依賴事件） | timeout reject ✅ |

無残留永久 pending 路徑。降級態邊界記錄（範圍外，見 §6）：androidSpeak 同步拋出
（非 reject promise）時 executor 直接 reject 但 slot 殘留至 timer——非永久 pending。

F17 已定稿「暖機未完成視窗」語義（F17-fix-plan v1.2）：F18 驗證不得把 Kotlin 端
findVoice 降級路徑（仍 emit start/done）誤判成事件遺失——本腳本全部用事件層模擬，
不觸 Kotlin，天然隔離。

## 4. 修法（本案＝結案動作）
1. `tools/verify-f18-timeout.mjs`（新增，白名單內）：
   - **T0 雙態 PRE 紅基線**：`git show dabfea1:src/lib/tts.js` 抽到 /tmp，同 loader 載入，
     重现「事件全遺失 → tick 31s 仍 pending」＝F18 宣稱在掃描時點精準重現。
   - **T1-T6 POST 綠**：P1/P2/P3/P4/P6/P7 逐路徑斷言（真 mock timers，零連網）。
   - **靜態釘**：TTS_TIMEOUT_MS 常數存在；`speakAndroidTts` 體內含 armTimeout 呼叫；
     start 監聽器體內含 armTimeout 呼叫（防日後重構無聲拆掉兜底）。
   - **負控制**：/tmp 變體剝除 speak 路徑 armTimeout → P1 場景永久 pending 精準重現；
     剝除 start 路徑 armTimeout → 長音訊 30s 誤殺重現。
   - 威脅模型定文（比照 F17 v4）：本腳本防「無意回歸＋偷工」，不抵禦蓄意偽裝对抗。
2. `_dev/notes/absorbed.txt` 追加 `F18=F2`（比照 A3=A1 先例，dispatcher v4.1 done_pm
   查覆蓋 commit b620d46）。
3. commit 前綴採 `test:`（A3 收尾先例：`test: A3 收尾登記 — ...`）。
   **可選項定案（憲法⑦）**：
   - 採 `test:` 非 `fix:`——理由：src 代碼 diff 為零，`fix:` 前綴會虛構不存在的代碼修復，
     破壞 git log 誠實性與 done_pm 反查語意；absorbed 機制（b1e1399 dispatcher v4.1）
     正是為此類「他 commit 涵蓋」設定的收尾通道。**請委員會裁決此點**。
   - 不加「縮短 30s／pause 槽免 timeout／invoke 同步拋出防護」——理由：pause 至
     timeout  reject 已被 contract test 7 明文鎖定為契約；其餘為低機率邊界，範圍外登記。

## 5. 驗證方式
- `node --test tools/verify-f18-timeout.mjs` 全綠（PRE 紅態以斷言「舊版確實 pending」形式綠）。
- 回歸：`node --test tools/verify-tts-contract.mjs`（10 斷言）＋ f11 ＋ d19 ＋ b6；
  `npm run build`；改動檔 `node --check`。

## 6. 範圍外清單
- G9（native 失敗 30s 靜默／_enVoice·pick 死碼／ttsAvailable 誤報）——佇列下一顆，勿混。
- desktop（非 Android）路徑無 timeout——speakAsync 為 await native invoke，
  事件模型不同，audit 原文限定 Android。
- androidSpeak 同步拋出之 slot 殘留（非永久 pending，見 §3 末）。
- 幽靈 start 搶佔 id 回填（slot.utteranceId 未定時偽 id 搶先回填 → 真 id done 被 ignore →
  30s timeout 誤殺；非永久 pending，R1#1 A2 實測）——需偽造/重複 start 事件，降級態記錄不修。
- TtsPlugin.kt 端 timer（JS 兜底已足，雙端雙 timer 反增 stop race）。
- Kotlin 真機事件丟失注入測試（真機驗證不可行，任務書准以 code 事實＋JS harness 為準）。

## 7. 風險
- 零代碼改動 → 回歸風險≈0；唯一風險是「已修」判定誤報 → 由 3 席獨立重跑
  （T0 PRE 重現＋路徑表獨立查證）把關。

## 版本紀錄
- v1（本檔）：首版送審。凍結。
- v1.1（R1 全綠 ✅✅✅ 後執行項，依憲法⑤記錄、結論不變免重送）：
  - 採納 R1#2 必須項（掛死防護）：驗證腳本 11 test 全加 `{ timeout: 8000 }`（陽奉陰違
    「timer 永不 reject」回歸在裸 `node --test` 下會無限掛死而非報紅）＋ `after()` 加
    `mock.timers.reset()` 兜底防連鎖 ERR_INVALID_STATE。
  - 採納 R1#1 建議：PRE 正宗釘擴字面集 `setInterval|requestAnimationFrame|queueMicrotask|
    Worker|Atomics`（堵 interval/rAF/polling 隱形兜底的低成本一半；另一半需 forge blob
    ＝蓄意偽裝，定文排除面外）。
  - 採納 R1#1#2：§6 範圍外補「幽靈 start 搶佔 id 回填」降級態一行（R1#1 A2 實測：
    30s timeout 誤殺、非永久 pending）。
  - 採納 R1#1#1：absorbed.txt 追加行帶實證引用（比照 A3=A1 體例）。
  - 採納 R1#3 必須項：absorbed 行與 test: commit 同 commit 原子入庫（单軌自足，嚴於先例）。
  - 威脅模型定文三席一致接受。
