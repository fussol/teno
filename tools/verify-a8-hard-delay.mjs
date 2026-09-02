// A8 防回歸測試 — hardDelay 單 step cap min(1.5x, x+1day) + maybe_round_in_days
// 用真實 repo 的 fsrs.js（hardDelay 是 review() 內 closure，經由 review() 整合路徑驗證）
// 官方對照：Anki rslib steps.rs（main / 2.1.66..25.02 同構）：
//   hard_delay_secs_for_first_step: 單 step → min(1.5x, x+1day)（#2229 cap）；首 step → avg(s0,s1)（無 cap）
//   兩者過 maybe_round_in_days：secs > DAY → round(secs/DAY)*DAY；非首 step 重複目前 step 不回 round
import { FSRS, AGAIN, HARD, GOOD, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, FSRS_PARAMS } from '/home/jupiter/teno/src/core/fsrs.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
}
const approx = (a, b) => Math.abs(a - b) < 1e-9;

const fsrs = new FSRS(FSRS_PARAMS, 0.9, false, 365);
const newCard = { stability: 0, difficulty: 5, state: STATE_NEW, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 };

// NEW + HARD + 單 learnSteps → hardDelay(learnSteps, 0)
function hardFromNew(learnSteps) {
  return fsrs.review({ ...newCard }, HARD, undefined, learnSteps, [10 / 1440]);
}

// ── T1 主 bug：3d 單 step → 4d（A8 前是 4.5d）──
{
  const r = hardFromNew([3]);
  check('3d 單 step HARD → 4d（cap min(4.5,4)=4，A8 前 4.5d）', r.state === STATE_LEARNING && approx(r.dueDays, 4), `state=${r.state} ivl=${r.dueDays}`);
}
// ── T2 1min 單 step → 1.5min 不變（cap 不影響短 step）──
{
  const r = hardFromNew([1 / 1440]);
  check('1min 單 step HARD → 1.5min', r.state === STATE_LEARNING && approx(r.dueDays, 1.5 / 1440), `state=${r.state} ivl=${r.dueDays}`);
}
// ── T3 10min 單 step → 15min（Anki 官方 test [10.0] → 900s）──
{
  const r = hardFromNew([10 / 1440]);
  check('10min 單 step HARD → 15min', r.state === STATE_LEARNING && approx(r.dueDays, 15 / 1440), `state=${r.state} ivl=${r.dueDays}`);
}
// ── T4 多 step 首 step avg（Anki 官方 test [1,10] → 330s=5.5min）──
{
  const r = hardFromNew([1 / 1440, 10 / 1440]);
  check('多 step [1,10] 首 step HARD → 5.5min avg', r.state === STATE_LEARNING && approx(r.dueDays, 5.5 / 1440), `state=${r.state} ivl=${r.dueDays}`);
}
// ── T5 多 step avg 無 cap（鎖定官方行為：查證 #2229 diff 僅 cap 單 step 分支）──
{
  const r = hardFromNew([3, 10]);
  // Anki: avg(3d,10d)=6.5d → maybe_round → 7d；若誤加 cap 會得 min(6.5, 4)=4d
  check('多 step [3,10] 首 step HARD → 7d（avg 6.5→round，官方無 cap）', r.state === STATE_LEARNING && approx(r.dueDays, 7), `state=${r.state} ivl=${r.dueDays}`);
}
// ── T6 maybe_round_in_days 邊界（單 step，皆先 min 後 round）──
{
  const r1 = hardFromNew([1.4]);   // min(2.1, 2.4)=2.1 → 2d
  check('1.4d 單 step → 2d（round 2.1）', approx(r1.dueDays, 2), `ivl=${r1.dueDays}`);
  const r2 = hardFromNew([1]);     // min(1.5, 2)=1.5 → 2d（Anki 官方 test: 1.5*DAY → 2*DAY）
  check('1d 單 step → 2d（round 1.5 進位）', approx(r2.dueDays, 2), `ivl=${r2.dueDays}`);
  const r3 = hardFromNew([0.99]);  // min(1.485, 1.99)=1.485 → 1d
  check('0.99d 單 step → 1d（round 1.485 退位）', approx(r3.dueDays, 1), `ivl=${r3.dueDays}`);
  const r4 = hardFromNew([0.5]);   // min(0.75, 1.5)=0.75 ≤ 1d → 不捨入
  check('0.5d 單 step → 0.75d（≤1d 不 round）', approx(r4.dueDays, 0.75), `ivl=${r4.dueDays}`);
}
// ── T7 多 step avg 過 maybe_round ──
{
  const r = hardFromNew([1.5, 10]); // avg 5.75 → 6d
  check('多 step [1.5,10] 首 step → 6d（avg 5.75→round）', approx(r.dueDays, 6), `ivl=${r.dueDays}`);
}
// ── T8 非首 step：重複目前 step，不回 round（Anki 官方 test [1,10,100] rem=1 → 6000s）──
{
  const learnCard = { stability: 2.3, difficulty: 2.1, state: STATE_LEARNING, reps: 1, lapses: 0, step: 1, elapsedDays: 0, scheduledDays: 0 };
  const r = fsrs.review({ ...learnCard }, HARD, undefined, [1 / 1440, 10 / 1440], [10 / 1440]);
  check('LEARNING stp=1 HARD → 重複 10min', approx(r.dueDays, 10 / 1440), `ivl=${r.dueDays}`);
  const r2 = fsrs.review({ ...learnCard }, HARD, undefined, [1 / 1440, 2.3], [10 / 1440]);
  check('LEARNING stp=1 HARD → 2.3d 原樣（非首 step 不回 round）', approx(r2.dueDays, 2.3), `ivl=${r2.dueDays}`);
  const learnCard2 = { ...learnCard, step: 2 };
  const r3 = fsrs.review({ ...learnCard2 }, HARD, undefined, [1 / 1440, 10 / 1440, 100 / 1440], [10 / 1440]);
  check('LEARNING stp=2 HARD → 100min', approx(r3.dueDays, 100 / 1440), `ivl=${r3.dueDays}`);
}
// ── T9 relearn 單 step 3d → 4d（REVIEW lapse 進 relearning 後 HARD）──
{
  const reviewCard = { stability: 8.0, difficulty: 5.0, state: STATE_REVIEW, reps: 5, lapses: 0, step: 0, elapsedDays: 1, scheduledDays: 5 };
  const ag = fsrs.review({ ...reviewCard }, AGAIN, undefined, [1 / 1440, 10 / 1440], [3]);
  check('REVIEW lapse + relearn [3] → RELEARNING 3d', ag.state === STATE_RELEARNING && approx(ag.dueDays, 3), `state=${ag.state} ivl=${ag.dueDays}`);
  const hd = fsrs.review({ ...ag, state: ag.state }, HARD, undefined, [1 / 1440, 10 / 1440], [3]);
  check('relearn 3d 單 step 再 HARD → 4d（cap）', approx(hd.dueDays, 4), `ivl=${hd.dueDays}`);
}
// ── T10 A4 回歸：null 防線不破壞（空/NaN/<=0 畢業）──
{
  const r = hardFromNew([]);
  check('[] + HARD → REVIEW 畢業（null）', r.state === STATE_REVIEW && r.dueDays > 0, `state=${r.state} ivl=${r.dueDays}`);
  const r2 = hardFromNew([NaN]);
  check('[NaN] + HARD → REVIEW 畢業 不 throw', r2.state === STATE_REVIEW && r2.dueDays > 0, `state=${r2.state} ivl=${r2.dueDays}`);
  const r3 = hardFromNew([0]);
  check('[0] + HARD → REVIEW 畢業（<=0 防線）', r3.state === STATE_REVIEW && r3.dueDays > 0, `state=${r3.state} ivl=${r3.dueDays}`);
  const r4 = hardFromNew([-3]);
  check('[-3] + HARD → REVIEW 畢業（<=0 防線）', r4.state === STATE_REVIEW && r4.dueDays > 0, `state=${r4.state} ivl=${r4.dueDays}`);
  const r5 = hardFromNew([NaN, 10 / 1440]);
  check('[NaN,10] + HARD → REVIEW 畢業（avg NaN → null）', r5.state === STATE_REVIEW && r5.dueDays > 0, `state=${r5.state} ivl=${r5.dueDays}`);
  // undefined learnSteps → 預設 [1min,10min] → 5.5min learning（A4 行為不變）
  const r6 = hardFromNew(undefined);
  check('undefined learnSteps → 預設 [1,10] avg 5.5min（A4 不變）', r6.state === STATE_LEARNING && approx(r6.dueDays, 5.5 / 1440), `state=${r6.state} ivl=${r6.dueDays}`);
}
// ── T11 對照：GOOD 畢業語意不受影響（單 step GOOD → REVIEW）──
{
  const r = fsrs.review({ ...newCard }, GOOD, undefined, [3], [10 / 1440]);
  check('單 step [3] GOOD → REVIEW 畢業（非 hardDelay 路徑）', r.state === STATE_REVIEW && r.dueDays > 0, `state=${r.state} ivl=${r.dueDays}`);
}

console.log(`\n=== A8 防回歸: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
