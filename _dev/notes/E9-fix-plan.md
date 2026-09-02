# E9 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.1＝R1 過審＋§6 三筆補登）

## 1. Bug 定義（行號實錘 2026-08-28：cmdRate cli.mjs:1277-1278）
`--date` 傳入後 `new Date(rateDate + 'T08:00:00Z').getTime()` 零驗證。四態實測
（tmp DB，rate w1 3 --date X）：
1. `garbage`／2. `2026-13-45` → rateNow=NaN → :1311 `toISOString()` 拋
   `RangeError: Invalid time value`（頂層 catch 列堆疊，使用者看不懂根因）。
3. **`2026-02-30` → V8 靜默 rollover 至 2026-03-02**（實測 due=2026-03-21＝
   以 3/2 作答計程）——無聲資料污染，比崩潰更毒。
4. `--date` 末位缺值（rateDate=undefined）→ 靜默走「無沙箱」正常評分，
   使用者誤以為日期生效。

## 2. Root cause
date→ms 轉換無守門（同檔 cmdSim `--now` 已有 `Number.isFinite` 守門——
cli.mjs:1347，E5 時加的正面教材——cmdRate --date 未同步移植）。

## 3. 修法（tools/cli.mjs cmdRate :1277 後插入，~9 行）
```js
const rateDate = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
// E9: --date 強驗證（usage 契約 YYYY-MM-DD）。無效字串 rateNow=NaN →
// toISOString RangeError 難懂堆疊；2026-02-30 級 out-of-range V8 靜默
// rollover（實測 2/30→3/2）＝無聲資料污染，round-trip 守門同堵兩類＋缺值。
if (args.includes('--date')) {
  const dd = rateDate != null ? new Date(rateDate + 'T08:00:00Z') : null;
  const dateOk = dd != null && /^\d{4}-\d{2}-\d{2}$/.test(rateDate)
    && Number.isFinite(dd.getTime()) && dd.toISOString().slice(0, 10) === rateDate;
  if (!dateOk) { process.exitCode = 1; return console.log(`❌ --date 需有效日期 YYYY-MM-DD（收到 "${rateDate ?? ''}"）`); }
}
const rateNow = rateDate ? new Date(rateDate + 'T08:00:00Z').getTime() : Date.now();
```
- 三重閘：regex 形（擋 garbage／帶時間尾巴／缺值）＋finite（擋 2026-13-45
  ISO 拒解析）＋**round-trip `toISOString().slice(0,10)===rateDate`**（擋
  2026-02-30 rollover——V8 對 ISO date-time 的 day 溢出採進位非拒斥，實測）。
- 拒絕時零副作用（守門在 findWord 之後、一切寫入/沙箱注入之前；沙箱注入在
  :1280 之後才開始，順序天然安全）。
- 凍結字面量：`❌ --date 需有效日期`（驗證判針）。
- `process.exitCode = 1`：做（D19/D20 既定方向；頂層 catch 現行 exit 0 屬
  既存全 CLI 缺陷，D19 §6 已登「exit code 系統化」另單，本單不越修——本路徑
  自設 exitCode 不受其影響已實錘路徑）。
- 可選項（憲法⑦）：**接受 ISO 全格式？** 不做——usage 契約明寫 YYYY-MM-DD，
  且 'T08:00:00Z' 拼接設計就是 date-only；要全 ISO 的用法是 sim --now。
- **cmdSim --now 已有守門不動**（正面教材零風險）；cmdStudy 無 --date 參數
  （grep 實錘）零連帶。

## 4. 驗證方式（tools/verify-e9-rate-date.mjs，全 tmp DB）
- T1 有效日期 `2026-08-20` → 評分成功（回歸釘：沙箱語意不變，reviewed_at
  日期=輸入日期實錘非只驗不炸）。
- T2 四壞態精準拒絕（凍結字面量＋exitCode 1＋cards/review_log 零變動）：
  `garbage`／`2026-13-45`／`2026-02-30`（rollover 態——斷言 due **不是** 3/2
  系且零寫入）／末位缺值。
- T3 `2026-08-20T12:00` 帶時間尾巴 → 拒（date-only 契約）。
- T4 無 --date 正常評分（回歸釘）。
- T5 負控制：守門段反換刪除 → garbage 重現 RangeError 堆疊＋2026-02-30
  重現靜默 rollover 寫入（due 以 3/2 計）。
- T6 靜態釘：round-trip 條在沙箱注入（:1280 段）之前。

## 5. 風險
- 純攔截守門：合法日期路徑逐字不動（T1/T4 釘）。
- 之前「靠 rollover 撿漏」的髒腳本輸入由崩潰/污染轉為明確報錯——行為變化
  如實登記（這正是本 bug 的修復目的）。

## 6. 範圍外清單（憲法⑥）
- 頂層 catch exit 0（全 CLI exit code 系統化，D19 §6 既登另單）。
- cmdSim --now 守門已存在不動；--date 支援時刻級（設計上 date-only）。
- review_log 已入庫的 rollover 髒資料回溯（無判別資料）。
- **R1 新增**：LOW-1 等號制 `--date=X` 未識別 token 靜默當無日期入庫（同
  「以為生效」家族，~2 行修法，另案）；INFO-1 極端合法年（0000/9999）過閘
  寫出怪 due（垃圾進垃圾出不崩，可選年範圍 sanity）；INFO-2 沙箱 run 的
  CLI log duration 巨負值（log() 沙箱 Date vs wall-clock 既存表面缺陷另單）。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席）
- ✅ **APPROVE**。代碼與計畫 §3 逐字一致；驗證 19/19 屬實重跑。
- 攻擊矩陣 21/21 符合預期：關鍵獨立實錘——**`1900-02-29` finite 擋不住
  （V8 給 finite 3/1）→ round-trip 是唯一閘**，比 2/30 例更強地證明三重閘
  分層設計；全形数字/未補零/正負前綴/尾空格/等號制/擴展年全拒零寫入。
- 變異矩陣：M-a 拆 round-trip→2/30＋1900-02-29 雙污染入庫（T2c/T2e 紅，
  due=3/21 與 §1 實測逐字吻合）；M-b 拆 regex→行為等價冗餘（可證明：過
  finite+round-trip 者必已 canonical），保留＝defense-in-depth＋fail-fast；
  M-c 拆 exitCode→5 釘紅；M-d 守門後移→行為零變（現行無中間消費者），
  T5d 靜態釘價值＝防未來插碼無聲炸。
- 消費者面零誤殺：bot.py 不存在、crontab 零條目、run-50days.sh 用舊快照
  副本＋date -u 恒合法、UI runCli 無 rate 面。
- 新發現 LOW-1/INFO-1/INFO-2 已補登 §6。
- 結論：**R1 全席 ✅ 過審**（單席制），動工 commit。
