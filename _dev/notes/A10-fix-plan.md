# A10 Fix Plan — due 錨定作答時刻非 Anki 日界線

## 1. Bug 事實

**位置**：src/lib/store.js:620（rateCard due 寫入）、tools/cli.mjs rate

**問題**：`due: new Date(Date.now() + Math.max(60000, Math.round(result.dueDays * 86400000)))` — due 錨定**作答時刻**：
1. 23:50 作答 → due 在 23:50+interval → 隔天 00:00-23:50 到期卡「早一天到期」抖動（sweep 實錘：1.5d step 08:30 作答→+1、23:50 作答→+2）
2. scheduledDays=Math.round(dueDays) 但 due 用未捨入值 → 不一致

## 2. Anki 官方公式（rslib 查證）

- `answering/review.rs:20`：Review 卡 `card.due = days_elapsed + scheduled_days`（天數制）→ 到期日 = 今天日界線 + interval 天，與作答時刻無關
- `timing.rs:27-55`：`next_day_at` = 下一個日界線時刻（今天 rollover 未過則今天，否則明天）
- `intraday_due.sql`：學習卡時間戳制 `due <= next_day_at`；`learning.rs:52-64` sub-day step = `now + step 秒`、≥1 天 step 轉日數制
- 等價時間戳：到期日 X 天 = `next_day_at + (X-1) × 86400` 秒

## 3. 修法

scheduler.js 新增兩函數：
- `nextDayAtMs(dayCutoff, timezoneOffset, now)` — 下一個日界線（對齊 next_day_at）
- `computeDueIso(dueDays, state, dayCutoff, timezoneOffset, now)`：
  - **REVIEW/日級 step（≥1 天）** → 日界線錨定 `nextDayAt + (round(interval)-1)*86400000`（到期日恆 = getToday + scheduledDays）
  - **sub-day 學習 step** → intraday `now + max(60s, step)`（Anki InSecs 路徑，60s 下限保留）

套用：store.js rateCard due 行、cli.mjs rate dueIso（同一函式，DAY_CUTOFF/TZ_OFFSET）。

## 4. 範圍確認

- session-v4.js requeue/intradayLearning 只讀 due（無寫入）✅
- core/simulator.js 整數日槽模型、store.js simulate 迴圈 UTC 日字串模型 — 刻意不動（會破壞日比較一致性）

## 5. 驗證

tools/verify-a10-due-anchor.mjs 31/31：T1 23:50 vs 00:10 due 完全相同＋到期日=今日+6＋時刻=08:00；T2/T3 fractional 一致（1.5d→+2、5.4→+5、5.6→+6）；T4 sub-day step intraday 不變＋60s 下限；T5 getDueCards 不受影響；T6 cutoff=0 退化（午夜界線）；T7 07:59/08:00 邊界；T8 e2e rateCard Date 沙箱；T9 負控制剝除 → 抖動再現。全量回歸 a3-a9/b5-b11/c1/c3/l1 全過。vite build 777ms。

## 6. 範圍外

- simulator.js / simulate 迴圈（日槽模型）
- fsrs.js 核心 interval 計算
