# E4 計畫書 v1.1 — CLI rate 寫 review_log 缺 5 欄 → cards delta_t 陳舊＋log schema 缺損

## 0. 審查歷程
- v1 R1（3 委員）：#1 修法正確性 ✅（LOW×2：app 端 legacy naive 載入未 normalize 屬 app 病、--date 08:00Z 錨點極端 tz 位移列新案）；#3 Anki 官方 ✅（MED：措辞——官方優化器實由時間戳重算 delta_t（params.rs days_elapsed），非直讀 elapsed_days 欄；duration NULL 安全：py-fsrs review_duration None 一等公民、optimizer 重播恆傳 None）；#2 消費者完整性 ❌ MED-1：--date 亂序回填 → 負 elapsed 入庫 → fsrs-rs elapsed_days u32 serde 整批 OverflowError、optimize 爆。
- v1.1：採 MED-1（elapsed 持久化前 Math.max(0,·) 夾零，fsrs.js:300 同款）＋ MED 措辞修正（§1、程式碼註解）＋ verify 增 T7 回填負值測試。R1 兩 LOW 列範圍外。

## 1. Bug 定義
`tools/cli.mjs` cmdRate 寫 review_log 只寫 6 欄（word_id, rating, reviewed_at, mode,
card_state, new_state），缺 **duration / elapsed_days / scheduled_days / stability /
difficulty**；且 cards 行 elapsed_days 永不寫回、cmdRate 完全不計算 elapsed →
下次 rate 的 FSRS delta_t 用陳舊值（新建卡恆 0），排程間隔本身就錯。log 端缺欄
使 schema 與 app/Anki 不一致（匯出/第三方工具 ground truth 缺損）。

任務書行號 1210-1211（2026-08-13 audit）已漂移。

## 2. Root cause（2026-08-27 實錘）
- `tools/cli.mjs:1238-1239`：INSERT review_log 僅 6 欄。
- 深層同因缺陷（一併修，理由見 §3）：
  - cmdRate **完全不計算 elapsed**：直接把 loadState 的 stale `card.elapsedDays` 餵進
    `session.fsrs.review(card, ...)`（:1223）。cards UPDATE（:1233-1235）**永遠不寫
    elapsed_days** → 第二次 CLI rate 的 delta_t 用第一次以來的陳舊值（新建卡恆 0）
    → 排程間隔本身就錯，log 就算補欄也與排程用的 delta_t 不一致。
  - app 端參照實錘（欄位語意權威來源）：
    - `src/lib/store.js:683-687`：elapsed = lastDay!=null ? daysBetween(lastDay, todayStr) : 0，
      lastDay=toLocalDateStr(lastReview, tz, cutoff)、todayStr=getToday(cutoff, tz)。
    - `src/lib/store.js:792-803` + `src/lib/db.js:409-414`（addReviewLog）：
      duration=durationMs（缺→null）、elapsedDays=**currentState.elapsedDays（複習前）**、
      scheduledDays=**Math.round(result.dueDays)（log 無條件取整）**、
      stability/difficulty=**result.*（複習後）**、state=複習前 state、newState=複習後。
    - cards 行 scheduledDays 語意 = `state===REVIEW ? round : raw`（store.js:731，
      CLI `sched` 已同構，不動）。

## 3. 修法（全在 `tools/cli.mjs`）
### 3a. 頂層新增 daysBetween helper（getToday/toLocalDateStr import 旁，:9）
```js
// 與 store.js:535 / cli.mjs drive-replay 本地版同構：YYYY-MM-DD 日字串差（取整）
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}
```
不動 :1591 drive-replay 本地同名變數（陰影遮罩無害，避免範圍外改動）。

### 3b. cmdRate 計算 elapsed（`const res = session.fsrs.review(...)` :1223 之前）
```js
// E4: elapsed 與 store.rateCard:683-687 同法（dayCutoff/tz-aware，normTs 防legacy naive）
const lastTs = card.lastReview ? new Date(normTs(card.lastReview)).getTime() : null;
const todayStr = getToday(DAY_CUTOFF, TZ_OFFSET, rateNow);
const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), TZ_OFFSET, DAY_CUTOFF) : null;
const elapsed = lastDay != null ? daysBetween(lastDay, todayStr) : 0;
```
並把 `elapsed` 餵進 FSRS：`session.fsrs.review({ ...card, elapsedDays: elapsed }, rating, Math.random(), LEARN_STEPS, RELEARN_STEPS)`。
（fuzz 的 Math.random 屬 E5 佇列，本 commit 刻意不動，避免多 bug 交錯。）

### 3c. cards 持久化補 elapsed_days（:1226-1235）
- INSERT：`VALUES` 對應 elapsed_days 位置由常數 0 改 `elapsed`（新卡 elapsed 恆 0，語意不變）。
- UPDATE：`SET ... elapsed_days=?` 新增一行，綁 `elapsed`（修 stale root：下次 rate 的
  delta_t 與 review_log 一致）。

### 3d. review_log INSERT 補齊 11 欄（:1238-1239）
```sql
INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days,
  stability, difficulty, mode, card_state, new_state, reviewed_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
```
綁定：`w.id, rating, null, elapsed, Math.round(res.dueDays), res.stability,
res.difficulty, 'flip', isNew ? 0 : (card.state ?? 0), res.state, nowIso`。
- card_state 沿用現行式（isNew?0:card.state??0），與 app currentState.state 等價。
- reviewed_at 保持 nowIso（--date 沙箱錨定，E2 語意不動）。

## 4. 可選項定案（憲法⑦）
- `--duration <ms>` 旗標：**不做**。CLI 單發指令無真實作答時長，寫假數值（0/隨機）
  會污染優化器 duration 過濾（py-fsrs review_duration 語意）；app 缺時長寫 null
  是官方語意（store.js:643 durationMs 缺→null），CLI 恆 null 與 app「無 duration
  記錄」完全同構。
- futureCounts（fuzz 的 greaterThanLast 约束）：**不做**，屬 E5。
- mc/spell mode 支援：**不做**，cmdRate 現行只寫 'flip'，擴充屬範圍外。

## 5. 驗證方式
`tools/verify-e4-rate-log.mjs`（送審前實跑）：
- 環境：`sqlite3` 從真實 DB `.backup` 出 tmp 副本（或按 db.js schema 自建最小 DB），
  `TENO_DB=<tmp>` `TENO_NO_BACKUP=1` 跑 `node tools/cli.mjs rate ...`，嚴禁碰
  `~/.config/com.teno.app/teno.db`。
- T1 新卡 rate：review_log 5 新欄非 NULL；elapsed_days=0、scheduled_days=round(dueDays)、
  stability/difficulty 與 cards 行一致。
- T2 跨日 e2e：--date D0 建卡 → --date D0+3 rate → review_log.elapsed_days=3 且
  cards.elapsed_days=3（bug 版：NULL + cards 行 stale）。
- T3 dayCutoff 邊界：cutoff=300（05:00），23:00Z 與 03:00Z（tz 對齊後）作答歸同一
  Anki 日 → 跨「日界線」判定 elapsed 正確。
- T4 legacy naive last_review（無 Z）不炸（normTs 防護）。
- T5 同日二次 rate：elapsed_days=0（Anki 日界線內 delta_t=0 為正確語意，非 bug）。
- T6 負控制：剝除修法（还原本檔副本：INSERT 回 6 欄、去掉 elapsed 計算）→ T2 精準
  重現 elapsed_days NULL。

## 6. 風險
- 只動 cmdRate + 新增頂層 helper；不改 fsrs.js/store.js/scheduler.js、不動 e2e 排程
  核心。session.fsrs.review 輸入 shape 擴充 elapsedDays——loadState card 本就有該欄，
  spread 覆蓋為計算值，向後相容。
- cards UPDATE 多綁一欄：UNIQUE 約束無涉。
- 官方優化政策紅線：本修只補 log 欄位，不接任何隔離中的 JS optimizer。

## 7. 範圍外清單（憲法⑥，發現但不動）
- cmdRate 用預設 FSRS 權重（new FSRS()），不讀 ankiSettings.fsrsWeights → CLI 排程
  與 app 優化後權重不一致（audit 未列，建議列新案）。
- cmdSim/cmdStudy/audit 各路徑的 review_log 缺欄 → E6 佇列。
- fuzz Math.random / greaterThanLast → E5 佇列。
- :1591 drive-replay 本地 daysBetween 重複實作（DRY，屬重構非 bug）。
