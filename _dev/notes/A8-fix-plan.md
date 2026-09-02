# A8 Fix Plan — 單步 hard delay 缺 min(1.5x, x+1day) + maybe_round_in_days

## 1. Bug 事實

**位置**：src/core/fsrs.js hardDelay（A4 改後 :317-323）

**問題**：單 step 時 `steps[0] * 1.5` 無上限 → 3d step → 4.5d；Anki 4d。

## 2. Anki 官方公式（rslib steps.rs，已查證）

來源：ankitects/anki rslib `steps.rs` `hard_delay_secs_for_first_step`（idx==0）：

```rust
if let Some(next) = self.secs_at_index(1) {
    maybe_round_in_days((again_secs + next) / 2)          // 多 step 首 step：avg(s0,s1)，無 cap
} else {
    let secs = (again_secs*3/2).min(again_secs + DAY);     // 單 step：min(1.5x, x+1day) ← #2229 cap
    maybe_round_in_days(secs)
}
// maybe_round_in_days: secs > DAY → round(secs/DAY)*DAY；非首 step 分支回 current 不 round
```

**重要查證**：cap 只加在單 step 分支；多 step 平均 case 無 cap（照官方）。舊 tag 2.1.66/23.10/24.11/25.02 完全同構；commit #1661（Round Hard days）/ #2229（Cap at again+1d）/ #1561（非首 step 用 current）。

## 3. 修法（fsrs.js :315-337）

- 單 step：`steps[0] * 1.5` → `maybeRoundInDays(Math.min(steps[0] * 1.5, steps[0] + 1))`（3d → 4d）
- 多 step 首 step：avg 後加 `maybeRoundInDays`（無 cap，照官方；[3d,10d] → 7d）
- 非首 step：重複目前 step，不回 round（照官方）
- maybe_round_in_days：`v > 1（天）→ Math.round(v)`（DAY=86400s ⟺ 1 天；`secs > DAY` ⟺ `v > 1`；恰等不捨入）
- A4 Option 語意完整保留（null 防線原樣尾端）

## 4. 驗證

tools/verify-a8-hard-delay.mjs 22/22：3d→4d（主 bug）、1min→1.5min 不變、10min→15min（Anki 官方 test 對照）、[1,10]→5.5min avg、多 step 無 cap 鎖定（[3,10]→7d）、maybe_round 邊界（1.4d→2/1d→2/0.99d→1/0.5d 不捨入/1.5 進位）、非首 step 重複、relearn 3d→4d、A4 null 防線 6 案。A4 35/35 回歸、node --check、vite build 814ms。

## 5. 範圍外

- againDelay / parseStepsStr / 畢業邏輯（A4 已修）
- greaterThanLast / fuzz（A1/A2 已修）
