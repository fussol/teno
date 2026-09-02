# C4 Fix Plan v1.1 — Preview 預覽 interval 未套用 store maxIvl 上限

## 版本歷程
- v1.0（前次 PM1 session，未送審即中斷）：根因查證 + 工作區改碼先行（違反憲法⑨「過審後動工」程序，本 session 凍結改碼、補程序：驗證先行 → 送審 → 過審才 commit）
- v1.1（本 session）：行號實錘更新（2026-08-27 實測）、消費者清單補齊、`_maxIvl` 死代碼實錘（grep 全庫零消費者）、驗證設計具體化

## Bug 定義
- **現象**: flip/mc/spell 學習頁的 interval 按鈕預覽按 36500 天上限計算，實際作答存檔走 ankiCfg.maxIvl（預設 365 天）上限。高穩定度卡預覽顯示超過使用者上限的 interval（audit 實例：預覽 428d，實際存檔 346d 被 cap）。用戶被誤導排程預期。
- **影響面**: 純預覽層（session 三 utils → Session.computeIntervals）。存檔排程路徑（store.js rateCard）正確無 bug。

## Root cause（2026-08-27 實錘行號）
- `src/engine/session-utils.js:24-26`、`src/engine/session-mc-utils.js:26-28`、`src/engine/session-spell-utils.js:25-27`（v1.0 時無 C4 註解的原始位置）：`makeFSRS()` 呼叫 `new FSRS(weights, retention)` **未傳第 4 參 maximumInterval** → 走 `src/core/fsrs.js:259` 預設 `maximumInterval = 36500`。
- cap 生效點實錘：`fsrs.js review()` → `fuzzInterval(raw, min, fuzzFactor, futureCounts, this.maximumInterval, ...)`（fsrs.js:415/439）與 `constrainedFuzzBounds` clamp 至 maximumInterval → 第 4 參決定預覽上限。
- 實際 scoring `src/lib/store.js:651-657`：`new FSRS(w, clamp(retention), true, Math.max(1, ankiCfg.maxIvl ?? 365))` 正確。
- 預覽消費鏈窮舉：三 utils `ensureQueue/flipCard/rateCard/undoRating` → `session.computeIntervals()`（session-v4.js:324-353）→ `this.fsrs.review(...)` → `intervals` → 學習頁按鈕。store 端 `previewIntervals`（store.js:1714+，字本卡預覽）**本就傳 maxIvl 正確**，不在 bug 範圍。
- 附帶實錘：三 utils 原 `session._maxIvl = ...` 賦值行 grep 全庫（src/ + tools/）零消費者 = 死代碼。

## 修法（3 檔、每檔 2 處，已在工作區、待過審 commit）
1. `makeFSRS(as)` 補第 4 參（三檔同構）：
   ```js
   return new FSRS(parseWeights(as), as?.desiredRetention ?? 0.9, true,
     Math.max(1, as?.maxIvl ?? 365));
   ```
2. `ensureQueue` 內死代碼 `_maxIvl` 賦值行改為 live sync：
   ```js
   session.fsrs.maximumInterval = Math.max(1, storeState.ankiSettings?.maxIvl ?? 365);
   ```
   mc/spell 各讀 ankiSettingsMc/ankiSettingsSpell。
   理由：Session 為 module-level singleton，`ensureSession` 只建一次 FSRS；使用者改 maxIvl 設定後重進學習頁（`ensureQueue(filter, storeState)` 三學習頁皆傳 storeState — study-v4.js:7 / study-mc.js:8 / study-spell.js:8 實錘）即同步生效，與同區塊既有 `newPerDay/ratedNewToday/maxReviewsPerDay` live sync 同模式。

## 可選項定案
- 第 3 參保留顯式 `true`（enableFuzzing）：與 store.js:654 同構，不依賴預設值。✅ 做。
- 不改 fsrs.js 預設 36500：屬 FSRS API contract（Anki 官方出廠值），動它會波及模擬器等刻意全範圍場景。❌ 不做。
- desiredRetention clamp（store clamp [0.7,0.99]，preview 未 clamp）：UI input 已 clamp [0.8,0.97]，無實際偏差路徑 → ❌ 不在本 fix，範圍外追蹤。

## 範圍外清單
- store `previewIntervals` 正確未動。
- `runMatureSimulation`（模擬器）正確未動。
- desiredRetention clamp 不一致（見上）。
- tools/cli.mjs 若另有 FSRS 構造未傳 maxIvl → 白名單外，如有問題登 scope-requests。

## 驗證方式
- 新增 `tools/verify-c4-maxivl-preview.mjs`（mock 環境三件套比照 C3 harness：FakeDatabase/invoke/toast，store+Session+FSRS 全真實）：
  - T0 靜態斷言：三 utils 檔 makeFSRS 含第 4 參、ensureQueue 含 live sync 行。
  - T1 預設 365：flip e2e（真實 store + mature 卡 stability=800）→ `session.fsrs.maximumInterval===365` 且四顆預覽全 ≤365。
  - T2 自訂 100（mc）：maximumInterval===100、預覽 ≤100。
  - T3 live sync：session 建立後改 ankiSettings（365→50、→0→1、→undefined→365）再 ensureQueue → cap 同步。
  - T4 spell e2e 預覽 ≤365。
  - T5 e2e 一致性：answer+rate GOOD 後 DB 卡 scheduledDays ≤ cap（預覽上限=存檔上限）。
  - T6 負控制：同 card state 直構 `new FSRS(w, r, true)`（無第 4 參）→ 預覽 >365 精準重現（並含 mc=100 情境 >100）。
- 回歸：node --check 三 utils 檔、npx vite build、≥3 既有腳本（c3/a6/a9/b9 等）。

## 風險
- 低。純預覽層 cap 對齊；不動存檔/排程/undo。live sync 行只寫 FSRS 實例純屬性。
- 唯一行為變化：cap 設定變更後無需重載頁面即生效（原行為：死代碼 + 36500）。
- （過審後補登，委員 #2/#3 觀察）`ensureQueue` 開頭 `session?.running` 早退在 sync 行之前 → session **進行中**改 cap 要到下次重進學習頁才生效；與既有 newPerDay/maxReviewsPerDay 同步參數同限制，非本 fix 新增回歸。

## 審查等級
- 3 檔改動（非單一檔案）→ 依律不降級，3 名委員。

## 狀態
- [x] 根因查證完成（行號實錘）
- [x] 驗證腳本實跑（37/37 ALL PASS，見 subagent-log）
- [x] 送審（R1：3 委員）
- [x] 過審（3/3 全 ✅）→ commit
