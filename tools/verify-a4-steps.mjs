// A4 防回歸測試 — 用真實 repo 的 fsrs.js + parseStepsStr
// 驗證：空 steps 畢業（非迴圈）、NaN 不 throw、[0] 直傳防線、畸形字串 parse、正常回歸
import { FSRS, AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, parseStepsStr, FSRS_PARAMS } from '/home/jupiter/teno/src/core/fsrs.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
}

const fsrs = new FSRS(FSRS_PARAMS, 0.9, false, 365);
const newCard = { stability: 0, difficulty: 5, state: STATE_NEW, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 };

// ── 1. 空陣列 []：AGAIN/HARD 畢業（非 1min 迴圈、非 interval=0）──
for (const [label, rating] of [['AGAIN', AGAIN], ['HARD', HARD], ['GOOD', GOOD], ['EASY', EASY]]) {
  const r = fsrs.review({ ...newCard }, rating, undefined, [], []);
  check(`NEW+[] ${label} → REVIEW 畢業`, r.state === STATE_REVIEW, `state=${r.state} ivl=${r.dueDays}`);
  check(`NEW+[] ${label} interval>0`, Number.isFinite(r.dueDays) && r.dueDays > 0, `ivl=${r.dueDays}`);
}

// ── 2. [NaN] 陣列直傳核心：不 throw、畢業 ──
try {
  const r = fsrs.review({ ...newCard }, AGAIN, undefined, [NaN], [NaN]);
  check('[NaN] + AGAIN 不 throw 且 REVIEW', r.state === STATE_REVIEW && Number.isFinite(r.dueDays), `state=${r.state} ivl=${r.dueDays}`);
} catch (e) { check('[NaN] + AGAIN 不 throw 且 REVIEW', false, e.message); }

// ── 3. [0] 直傳核心：<=0 防線 → 畢業 ──
for (const [label, rating] of [['AGAIN', AGAIN], ['HARD', HARD]]) {
  const r = fsrs.review({ ...newCard }, rating, undefined, [0], [0]);
  check(`[0] 直傳 core ${label} → 畢業（<=0 防線）`, r.state === STATE_REVIEW && Number.isFinite(r.dueDays) && r.dueDays > 0, `state=${r.state} ivl=${r.dueDays}`);
}

// ── 4. learning 卡 mid-flow 空 steps：也畢業 ──
const learnCard = { stability: 2.3, difficulty: 2.1, state: STATE_LEARNING, reps: 1, lapses: 0, step: 1, elapsedDays: 0, scheduledDays: 0 };
for (const [label, rating] of [['AGAIN', AGAIN], ['HARD', HARD], ['GOOD', GOOD]]) {
  const r = fsrs.review({ ...learnCard }, rating, undefined, [], []);
  check(`LEARNING step=1 + [] ${label} → REVIEW 畢業`, r.state === STATE_REVIEW, `state=${r.state} ivl=${r.dueDays}`);
}

// ── 5. REVIEW lapse + 空 relearnSteps：畢業且 lapses+1 ──
const reviewCard = { stability: 8.0, difficulty: 5.0, state: STATE_REVIEW, reps: 5, lapses: 0, step: 0, elapsedDays: 1, scheduledDays: 5 };
const rl = fsrs.review({ ...reviewCard }, AGAIN, undefined, [1/1440, 10/1440], []);
check('REVIEW lapse + [] relearn → REVIEW 畢業', rl.state === STATE_REVIEW, `state=${rl.state} ivl=${rl.dueDays}`);
check('REVIEW lapse + [] relearn lapses+1', rl.lapses === 1, `lapses=${rl.lapses}`);

// ── 6. parseStepsStr 邊界 ──
const cases = [
  ['', '1,10', [1/1440, 10/1440]], ['', '10', [10/1440]],
  [',', '1,10', []], ['abc', '1,10', []], ['1,,10', '1,10', [1/1440, 10/1440]],
  ['0,5', '1,10', [5/1440]], ['1.5,10', '1,10', [1.5/1440, 10/1440]],
  [null, '1,10', [1/1440, 10/1440]], [undefined, '1,10', [1/1440, 10/1440]],
  ['-5,10', '1,10', [10/1440]], ['1,10', '1,10', [1/1440, 10/1440]],
];
for (const [input, fb, expect] of cases) {
  const got = parseStepsStr(input, fb);
  const ok = got.length === expect.length && got.every((v, i) => Math.abs(v - expect[i]) < 1e-12);
  check(`parseStepsStr(${JSON.stringify(input)}, '${fb}') → ${JSON.stringify(expect.map(v => +(v*1440).toFixed(2)))}`, ok, `got=${JSON.stringify(got.map(v => +(v*1440).toFixed(2)))}`);
}

// ── 7. 正常回歸：'1,10' + AGAIN → learning step0 1min；GOOD → step1 10min ──
const a = fsrs.review({ ...newCard }, AGAIN, undefined, [1/1440, 10/1440], [10/1440]);
check("正常 '1,10' AGAIN → LEARNING step=0 ivl=1min", a.state === STATE_LEARNING && Math.abs(a.dueDays - 1/1440) < 1e-9, `state=${a.state} ivl=${a.dueDays}`);
const g = fsrs.review({ ...newCard }, GOOD, undefined, [1/1440, 10/1440], [10/1440]);
check("正常 '1,10' GOOD → LEARNING step=1 ivl=10min", g.state === STATE_LEARNING && Math.abs(g.dueDays - 10/1440) < 1e-9, `state=${g.state} ivl=${g.dueDays}`);
const rv = fsrs.review({ ...newCard }, GOOD, undefined, [1/1440], [10/1440]);
check("正常 單步 '1' GOOD → 畢業 REVIEW", rv.state === STATE_REVIEW, `state=${rv.state} ivl=${rv.dueDays}`);

// ── 8. store.js 情境：畸形字串 → 不 throw、due 正常 ──
function dueFromStr(learnStr, relearnStr) {
  const ls = parseStepsStr(learnStr, '1,10');
  const rs = parseStepsStr(relearnStr, '10');
  const res = fsrs.review({ ...newCard }, AGAIN, undefined, ls, rs);
  const due = new Date(Date.now() + Math.max(60000, Math.round(res.dueDays * 86400000))).toISOString();
  return { res, due };
}
for (const bad of [',', 'abc', '0,0', '-1']) {
  const { res, due } = dueFromStr(bad, '10');
  const dueOk = !Number.isNaN(new Date(due).getTime());
  check(`store 情境 '${bad}' → 不 throw + due ISO + REVIEW`, dueOk && res.state === STATE_REVIEW, `state=${res.state} due=${due}`);
}
// ' ' 單空格 = 空 → fallback '1,10' → learning（正確行為，非畸形）
const sp = dueFromStr(' ', '10');
check("store 情境 ' ' → fallback 進 learning（空格=空）", !Number.isNaN(new Date(sp.due).getTime()) && sp.res.state === STATE_LEARNING, `state=${sp.res.state} due=${sp.due}`);

console.log(`\n=== A4 防回歸: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
