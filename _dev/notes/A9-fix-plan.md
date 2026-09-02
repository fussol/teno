# A9 Fix Plan — 作答時間無上限截斷（Anki cap_answer_secs）

## 1. Bug 事實

**位置**：src/lib/store.js rateCard durationMs

**問題**：作答時間無上限截斷 — 使用者放置卡片很久（1h+）時 duration 寫入完整值，單筆 outlier 扭曲 FSRS 優化。

## 2. Anki 官方行為（rslib 實錘）

- `cap_answer_time_to_secs` 預設 **60**（秒），合法範圍 1~9999（deckconfig/mod.rs:65）
- `cap_answer_secs`: `milliseconds_taken = min(milliseconds_taken, max_secs * 1000)`（answering/mod.rs:60-62），**revlog 寫入前**套用（answering/mod.rs:324）

## 3. teno duration 單位

**毫秒 (ms)** — 三呼叫端皆傳 `Math.max(0, Date.now() - shownAt)`（session-utils.js:92 / mc:107 / spell:107）。cap = 60 * 1000 = 60,000ms 與 Anki 完全同構。

## 4. 修法

- store.js 新增 `CAP_ANSWER_TIME_MS = 60 * 1000` 常數（含 Anki 出處註解）
- rateCard durationMs：`Math.min(Math.round(duration), CAP_ANSWER_TIME_MS)`；負值/非數字 → null 防護保留

## 5. 驗證

tools/verify-a9-duration-cap.mjs 23/23（正常不變 / cap 邊界恰等 60000 不截 / 60001ms+1h outlier 截斷 / 小數四捨五入 / 負值/undefined/'abc'/NaN → null / 三 mode 一致 / 負控制剝除 Math.min → 1h 不被截 bug 再現）。回歸 A8 22/22、A4 35/35、A5、C1 21/21、C3。vite build 742ms。

## 6. 範圍外

- review_log 寫入結構不變（只改 duration 值）
- FSRS 核心不動
