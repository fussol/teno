# C3 — mc/spell rateCard 缺 _ratingLock → 快速連按重複評分寫兩次 review_log（v1.2 — 凍結送 opencode）

狀態：**v1.2 凍結（3 delegate 全席 ✅ + harness 實作完成，送 opencode 2 席）**
關聯：bug-audit-2026-08-13.md C3（🟠）；污染卡分析佐證（teno-backup0815.db mc/spell 污染 2+1 卡）
負責人：總統 Oliver

## 一、Bug 定義

1. **現象**：mc/spell 學習頁快速連按評分按鈕 → `store.actions.rateCard` 被呼叫兩次 → **同一張卡寫兩筆 review_log**（同秒重複）、reps 多算、FSRS 排程被同一 rating 連打兩次。
2. **code 實錘**（2026-08-15 實測 grep）：
   - flip `src/engine/session-utils.js:12,89-90`：有 `_ratingLock`（`if (_ratingLock) return; _ratingLock = true;`）— 共 5 處
   - mc `src/engine/session-mc-utils.js:101-144`：**無鎖**（grep 0 處）
   - spell `src/engine/session-spell-utils.js:98-134`：**無鎖**（grep 0 處）
   - `grep -n "_ratingLock" src/engine/session-utils.js src/engine/session-mc-utils.js src/engine/session-spell-utils.js` → 只有 session-utils.js 5 次，mc/spell 0 次（實測輸出如上）
3. **佐證**：污染卡分析中 mc/spell 各有少量污染卡（mc 2、spell 1）— 與 flip 的 learnAhead 循環（L1）機制不同，此為連按雙寫。

## 二、Root Cause

- mc/spell 的 rateCard 是 async 函數：`await store.actions.rateCard(...)` 期間若有第二次點擊/鍵盤事件 → 沒有鎖擋 → 兩次都執行 → 兩筆 review_log + 兩次 `session.rate()` + 兩次 `requeueIntraday`。
- flip 有 `_ratingLock` 所以同秒連按被擋（第一次設鎖、await 期間第二次 `return`）。
- audit C3 列為 🟠，但 23 個 commit（A/B/C/D/E/F/G 系列 🔴）未包含 → **漏修**。

## 三、修法（檔名:行號 — 實際路徑 `src/engine/`）

### 修法 1 — src/engine/session-mc-utils.js

```js
// :13 附近 module scope 加（_completionShown 之後）
let _ratingLock = false;

// :101 rateCard 開頭（:102 `if (!session?.current) return;` 之後）加
if (_ratingLock) return;
_ratingLock = true;

// catch 分支 :108-109 加解鎖
toast('儲存失敗', 'toast-error');
_ratingLock = false;
return;

// :143 renderFn() 前（最後）加解鎖
_ratingLock = false;
renderFn();
```

### 修法 2 — src/engine/session-spell-utils.js（同構）

```js
// :12 附近 module scope 加（_completionShown 之後）
let _ratingLock = false;

// :98 rateCard 開頭（:99 `if (!session?.current) return;` 之後）加
if (_ratingLock) return;
_ratingLock = true;

// catch 分支 :105-106 加解鎖
toast('儲存失敗', 'toast-error');
_ratingLock = false;
return;

// :133 renderFn() 前加解鎖
_ratingLock = false;
renderFn();
```

> 對齊 flip 的鎖語意：鎖在 `await store.actions.rateCard` 期間持有（含 requeue/next 同步段），render 前釋放；catch（DB 失敗）也釋放，避免 **DB 失敗路徑**鎖死（同步段 throw 仍會鎖死 — 與 flip 現狀相同，屬 C10 範圍外）。**維持最小改動、與 flip 嚴格同構，不採 try/finally 強化**（避免與 flip 行為分叉；C10 另案處理）。

## 三之一、消費者清單（憲法② 窮舉）

`rateCard` 呼叫點（grep 實測，共 6 處，全部在 session-utils/mc/spell 三檔內部，無外部 import）：
- flip：`src/engine/session-utils.js:209`（按鈕 click）、`:224`（鍵盤 1-4）
- mc：`src/engine/session-mc-utils.js:225`（按鈕 click）、`:243`（鍵盤 1-4）
- spell：`src/engine/session-spell-utils.js:216`（按鈕 click）、`:240`（鍵盤 1-4）

修法只動 mc/spell 的 rateCard 函數本身（module scope 加鎖變數 + 函數內 4 行），消費者呼叫端不需改 — 鎖在函數內擋住第二次呼叫。flip 消費端（:209/:224）不受影響。

## 三之二、範圍外清單（憲法⑥）

本 bug 不處理、已知存在但不動：
1. **C10** — flip 的 `_ratingLock` 無 try/finally，`session.rate()` 拋錯（easter-egg）後永久鎖死。本案不擴散（維持與 flip 現狀一致）。
2. **store.actions.rateCard 本身**（src/lib/store.js:537）無防重 — 依賴 session 層鎖；若未來有第二個呼叫者需另行審查。
3. **undo 快照 / requeueIntraday / C2 rateCard fallback** — 與本案無關。
4. **L1（learnAheadLimit clamp）** — 已獨立修復（commit f7b30ac），不重複。

## 四、驗證（✅ 附實測證據）

1. **code 比對**：三檔 `_ratingLock` 出現次數 flip=5、mc=5、spell=5（修完後三檔同構，各 5 處：decl + 檢查 + 設鎖 + catch 解鎖 + render 前解鎖）
2. **連按模擬 harness（已實作 `tools/verify-c3-rating-lock.mjs`，287 行）**：
   - 真實相依（真實 session-mc/spell/flip-utils + 真實 Session/FSRS/真實 store.actions.rateCard），只 mock 3 樣環境（@tauri-apps/plugin-sql → node:sqlite in-memory、@tauri-apps/api/core → no-op、src/main.js → toast stub）
   - 連按時序兩種：同 tick 連發 + mid-flight +10ms 第二擊（真實雙擊）
   - 斷言：DB review_log 表層級只 1 筆、renderFn 只 1 次、鎖釋放後能正常評下一張卡、catch 解鎖（store 拋錯後下次評分正常）、不同 rating 連按、flip 對照組恆 1 筆
   - **負控制（未修）26/26 ALL PASS** — mc/spell 連按寫 2 筆、flip 恆 1 筆（harness 正確偵測 bug）；修法後預期 11 個連按測試紅燈轉綠
   - 用法：`node --experimental-test-module-mocks tools/verify-c3-rating-lock.mjs`（修法後 → ALL PASS）
3. **node --check**：兩檔語法
4. **vite build**：全過
5. **回歸**：flip 不受影響（鎖邏輯未動；harness 內 flip 對照組恆 1 筆）

## 五、風險

- 低：與 flip 既有鎖模式同構，改動 2 檔各 4 行
- 與 L1（learnAheadLimit clamp）獨立，可拆 commit
- C10（flip 鎖無 try/finally）為已知另一 bug，本案不處理（避免範圍蔓延）
