# F19 計畫書 v1 — simulate_fsrs today_days UTC 天數 vs Anki 當地日界線

## §0 版本紀錄
- v1.0（2026-08-29）：初版送審。送審後凍結，修正升版記 §7。

## §1 Bug 定義
`simulate_fsrs`（Rust）把既有卡的 `due`/`last_date` 換算成模擬器「距今天數」時，
零點用 **UTC epoch 天**（`now / 86400`）；但 due 輸入是 **當地 cutoff 日界線錨定**
的時間戳（A10 約定，見 §2）。兩參考系混用 → `timezoneOffset ≠ 0` 或
`dayCutoff > 0` 的使用者，全部既有卡的初始 `due_day`/`last_date` 依「執行模擬的
當地時刻」抖動 ±1 天 → 模擬排程起點錯位（逾期卡少算/多算一天到期潮）。

審計行號 1055 已漂移；**實際行號（HEAD fb2b217 實錘）**：
- lib.rs:1118 `let today_days = (now / 86400) as f32;`
- lib.rs:1126 `let due_day = c.due_ms.map(|ms| (ms / 86400000) as f32 - today_days).unwrap_or(0.0);`
- lib.rs:1127 `let last_date = (due_day - c.interval).min(0.0);`（連動面）

## §2 Root cause（代碼事實，全鏈一手實錘）
1. **due_ms 輸入約定＝當地日界線錨定**（自家 A10 立法，`src/core/scheduler.js:302-348`）：
   `computeDueIso`：`due = nextDayAtMs + (ivl-1)*86400000`，`nextDayAtMs` =
   當地 cutoff 分鐘的下一個日界線（epoch ms）。前端
   `src/pages/simulator.js:104` `dueMs: new Date(c.due).getTime()` 原樣透傳。
2. **Anki 官方零點＝當地日界線天數**（一手源碼，2026-08-29 main 抓取）：
   - `rslib/src/scheduler/answering/review.rs:20` `card.due = days_elapsed + scheduled_days`（天數制）
   - `rslib/src/scheduler/fsrs/simulator.rs:145` `days_elapsed = timing_today().days_elapsed`（當地 rollover 系）
   - 同檔 `Card::convert`（:322-340）`relative_due = due - days_elapsed`、
     `last_date = (relative_due - interval).min(0)` ＝ **減的是當地系天數**。
   - `rslib/src/scheduler/timing.rs` `sched_timing_today_v2_new`：rollover 以當地日期
     + rollover_hour 切割，非 UTC 午夜。
3. **fsrs-rs 6.6.1 內部同系**：`extract_simulator_config`（simulation.rs:1689，參數名
   即 `day_cutoff`）`real_days = (row.id/1000 - day_cutoff)/86400`，Teno 傳入
   `next_day_at`（當地錨定，lib.rs:1083 由 `compute_next_day_at` 正確計算）→
   **revlog 端已是當地系**；卡片端 :1118 用 UTC 系 ＝ 同函式雙參考系實錘。
4. **徵狀算例**（tz=+8、cutoff=0）：到期日 D 的卡 `due_ms` = D 00:00+08 = D-1 日
   16:00 UTC → `(ms/86400000)` 整除得 D-1；使用者「今天」= D。
   - 當地 10:00 跑模擬：`now/86400` → UTC 日 = D → `due_day = D-1-D = -1`（應 0，逾期化）
   - 當地 02:00 跑模擬：UTC 日 = D-1 → `due_day = 0`（恰好對）
   → 同一天不同時刻跑，結果不同 ＝ 參考系混用的指紋。

## §3 修法（lib.rs 單檔，白名單內）
### 3.1 新純函式（`compute_next_day_at` 旁，:1049 後）
```rust
/// Anki 當地 cutoff 系天數：floor((t + tz - cutoff) / 86400)
/// 對齊 timing.rs 日界線切割（日界線＝當地 cutoff 分鐘）。
/// div_euclid＝floor 語意，負偏移（西時區／cutoff 後凌晨）不破。
fn local_day_index(t_secs: i64, timezone_offset_secs: i64, cutoff_secs: i64) -> i64 {
    (t_secs + timezone_offset_secs - cutoff_secs).div_euclid(86400)
}
```
### 3.2 呼叫點改寫
```rust
// :1118 → 
let cutoff_secs = (req.day_cutoff_minutes.max(0) as i64) * 60;
let today_days = local_day_index(now, tz_secs, cutoff_secs) as f32;
// :1126 →
let due_day = c.due_ms
    .map(|ms| local_day_index(ms.div_euclid(1000), tz_secs, cutoff_secs) as f32 - today_days)
    .unwrap_or(0.0);
```
- `cutoff.max(0)` 與 `compute_next_day_at`（:1043）既有處理逐字同構。
- `last_date`（:1127）零改動——輸入 `due_day` 歸正後自動歸正。
- 其餘零碰：`interval_to_weekday`/`next_day_at` 已當地系；revlog 端已當地系。

### 3.3 計算模型（憲法③）
- 天序 = epoch-day 整數（i64 floor 除法）；due_ms 先 `div_euclid(1000)`（ms→s，
  未來負 ms 理論值也不破）。
- f32 精度：epoch-day ≈ 20,664 « 2^24（f32 整數精確域上限 16,777,216），
  due_day 差值域 ±数万 → 無精度疑慮，測試含大值向量。
- 日界線語意驗證恆等式（unit test 釘死）：對任意 now/tz/cutoff，
  `local_day_index(next_day_at + (ivl-1)*86400) - local_day_index(now) == ivl`
  （ivl=1..400）＝ A10「到期日 == getToday + ivl」在 Rust 側的镜像。
  **舊公式同向量必偏（雙臂判別）**。

## §4 驗證方式
1. **cargo unit test**（lib.rs `mod f19_tests`，能寫 unit 優先寫 unit）：
   - `local_day_index` 定義表：UTC+8 凌晨 cutoff0（跨日界線前後 1 秒）；
     UTC-5 cutoff240（負偏移＋cutoff 前段＝floor vs trunc 分歧向量）；
     cutoff>tz 負锚向量。
   - A10 恆等式矩陣（tz ∈ {0, ±8h, +5:30, -11h} × cutoff ∈ {0, 240, 300} × now 一天內 24 點）
     新公式全過＋舊公式（test 內聯 `legacy_utc_due_day`）必紅（判別性內建）。
   - `due_ms` round-trip：以 `compute_next_day_at` 生成 A10 式 due，喂
     `local_day_index` 必還原 ivl。
2. **tools/verify-f19-sim-day.mjs**（雙態＋負控制）：
   - T0：`cargo test --lib f19` 計數下限釘＋3 test 名逐一 pass。
   - T1：真碼提取——從 lib.rs 抽 `local_day_index` 源碼字串＋:1118/:1126 呼叫行，
     `rustc` 獨立編譯場景機（tz/cutoff/時刻矩陣行為斷言，含徵狀算例 -1→0）。
     動工前：提取失敗/舊碼行為＝RED（徵狀在位設計語意）。
   - T2：負控制 pin `fb2b217` 舊 blob——舊公式抽入同場景機，徵狀算例精準重現
     `due_day=-1`＋新碼同向量 =0 ＝判別性雙臂。
   - T3：結構釘——舊字面量 `(now / 86400) as f32` 全檔零殘留；`today_days`/
     `due_day` 行必經 `local_day_index`；generate_handler 41 命令計數釘（防夾帶）；
     `compute_next_day_at` 零碰釘。
   - T4：host `cargo check`＋`cargo test --lib`（計數 42＋3 fail 容差僅 sim_tests
     fixture 預存紅，f 計數判別同款 F14 先例）＋android cargo check（NDK 四件套
     抄 F16 範本；環境假紅先復測再歸因）。
3. 回歸：verify-f16（命令計數同檔鄰域）、verify-d17、verify-f14（同檔結構釘）＋
   `npx vite build`（零 JS 改動，照跑留痕）。

## §5 風險
- 行為變化＝模擬輸入更正（due_day 修正 ±1）；**不碰**排程/優化/作答鏈
  （simulate_fsrs 唯讀模擬，無 DB 寫入，消費者唯 simulator.js 三呼叫點）。
- `timezoneOffset=null`（使用者未設定）→ JS 端 `?? 480` 硬編 +8 的既有缺口
  本單不修（§6）；本修法讓「設定正確 tz」的使用者立即歸正。
- 负 tz／極端 cutoff（>1440）邊界：`.max(0)` 對齊 compute_next_day_at 既有政策，
  不做上界守門（超範同函既有行為，改之＝範圍膨脹）。

## §6 範圍外（自動進追蹤，憲法⑥）
- F19-SR1：simulator.js:138 `ankiCfg.timezoneOffset ?? 480` — `timezoneOffset=null`
  （語意=系統本地）時硬編 UTC+8，系統非 +8 使用者 tz 輸入即錯（JS 域，白名單外）。
- sim_tests 3 條預存紅：`/tmp/sim-req-*.json` fixture 缺失（F14 R1#3 已認定非本帳，
  本單驗證容差 f≤3 同款）。
- `interval_to_weekday` cutoff 未計入 weekday 判定（Anki easy-days 以日界線歸日；
  現行用 UTC 日+tz——低影響（weekday 差一天僅 easy-days 微調），另單評估）。
- DST：tz 為固定分鐘偏移（產品設定模型），不支援季節性位移——產品域非本 bug。

## §7 審查紀錄（送審後填寫）
