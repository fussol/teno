#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C5 防回歸驗證 — maxReviewsPerDay cap 語意：scheduler.getDueCards 必須與
// Session.buildQueue 完全一致（cap 僅套 review 卡；learning 不 cap；new 走
// cardsPerDay 額度，不排擠 review 預算）。
//
// 用法:
//   node tools/verify-c5-review-cap.mjs
//       → 修法後（兩端一致）期望 ALL PASS
//   node tools/verify-c5-review-cap.mjs --expect-legacy
//       → 負控制（/tmp 舊碼副本）：期望抓到 dashboard(9) ≠ session(12) bug
//
// 純函式驗證：getDueCards + Session.buildQueue 皆無 DB/DOM 依賴，
// FSRS 用啞物件（buildQueue 不觸及 fsrs）。
// ═════════<|im_start|>══════════════════════════════════════════════════
import { getDueCards } from '../src/core/scheduler.js';
import { Session } from '../src/engine/session-v4.js';
import { FSRS, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../src/core/fsrs.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', msg); }
}
const idSet = arr => [...arr.map(x => (x.id || x.word?.id || x.word)).sort()];
const eqSet = (a, b) => JSON.stringify(idSet(a)) === JSON.stringify(idSet(b));
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const now = new Date();
const T = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = ms => new Date(ms).toISOString();
const H = 3600e3;
const mkWord = id => ({ id, word: id });
const mkCard = (id, state, dueH, reps = 0) => ({
  wordId: id, state, due: iso(T + dueH * H), stability: 10, difficulty: 6,
  elapsedDays: 1, scheduledDays: 1, reps, lapses: 0, step: 0, lastReview: null,
  buried: false, suspended: false, interval: 1,
});

// ── fixture：8 review（due 錯開 h1..h8）+ 2 learning + 2 relearning + 5 new ──
// cap=5 → 兩端都應只放最早 5 review（r1..r5）；new 3 張独立額度；learning 4 全入
const words = [
  ...['r1','r2','r3','r4','r5','r6','r7','r8'].map(mkWord),
  ...['lA','lB','rlA','rlB'].map(mkWord),
  ...['n1','n2','n3','n4','n5'].map(mkWord),
];
function fixtureCards() {
  const m = new Map();
  ['r1','r2','r3','r4','r5','r6','r7','r8'].forEach((id, i) => m.set(id, mkCard(id, STATE_REVIEW, 1 + i, 5)));
  m.set('lA', mkCard('lA', STATE_LEARNING, 0.5, 1));
  m.set('lB', mkCard('lB', STATE_LEARNING, 0.8, 0));
  m.set('rlA', mkCard('rlA', STATE_RELEARNING, 0.6, 2));
  m.set('rlB', mkCard('rlB', STATE_RELEARNING, 0.7, 1));
  // n1..n5 無卡 = new
  return m;
}
const CAP = 5, NEW_PER_DAY = 3;

function runScheduler(cap, newPerDay, ratedNew = 0) {
  const r = getDueCards(words, fixtureCards(), new Set(), new Set(),
    newPerDay, 0, null, ratedNew, undefined, cap);
  return r;
}
function runSession(cap, newPerDay, ratedNew = 0) {
  const s = new Session({
    words, cards: fixtureCards(), buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9, false, 365), dayCutoff: 0,
    newPerDay, ratedNewToday: ratedNew, learnSteps: '1,10', relearnSteps: '10',
    maxReviewsPerDay: cap, reviewMix: 2, timezoneOffset: null, mode: 'flip',
    learnAheadLimit: 20,
  });
  s.buildQueue(undefined);
  const all = [...s.intradayLearning, ...s.mainQueue];
  return { intraday: s.intradayLearning, main: s.mainQueue, all };
}
const EXPECT_LEGACY = process.argv.includes('--expect-legacy');

function scenario(name, cap, newPerDay, ratedNew, expect) {
  const sch = runScheduler(cap, newPerDay, ratedNew);
  const ses = runSession(cap, newPerDay, ratedNew);
  if (!EXPECT_LEGACY) {
    assert(sch.due.length === expect.total,
      `${name} dashboard 總數 = ${expect.total}: got ${sch.due.length}`);
    assert(ses.all.length === expect.total,
      `${name} session 可學總數 = ${expect.total}: got ${ses.all.length}`);
    // review+learning 端對端 id 一致；new 只比數量（session 依 A7 每日 shuffle 取樣，
    // scheduler 依列表順序 — 哪幾張 new 入隊非本 bug 語意，數量一致即正確）
    const nonNew = x => !/^n\d$/.test(x.id ?? x.word?.id ?? '');
    assert(eqSet(sch.due.filter(nonNew), ses.all.filter(nonNew)),
      `${name} 兩端 non-new id 集合一致: sch=[${idSet(sch.due.filter(nonNew)).join(',')}] ses=[${idSet(ses.all.filter(nonNew)).join(',')}]`);
    for (const rid of expect.reviews)
      assert(sch.due.some(w => w.id === rid) && ses.all.some(x => (x.word?.id ?? x.id) === rid),
        `${name} review ${rid} 兩端都在`);
    for (const rid of expect.reviewsOut)
      assert(!sch.due.some(w => w.id === rid) && !ses.all.some(x => (x.word?.id ?? x.id) === rid),
        `${name} review ${rid} 兩端都被 cap 掉`);
    assert(sch.newCount === expect.newCount, `${name} newCount=${expect.newCount}: got ${sch.newCount}`);
    const sesNew = ses.all.filter(x => x.type === 'new').length;
    assert(sesNew === expect.newCount, `${name} session new 入隊數=${expect.newCount}: got ${sesNew}`);
  } else {
    // 負控制：舊 scheduler 把 cap 打總和 → dashboard 少報、session 多發
    assert(sch.due.length === expect.legacySch,
      `[legacy] ${name} 舊 dashboard=${expect.legacySch}: got ${sch.due.length}`);
    assert(ses.all.length === expect.total,
      `[legacy] ${name} session 實發=${expect.total}: got ${ses.all.length}`);
    if (expect.diverge)
      assert(sch.due.length !== ses.all.length,
        `[legacy] ${name} 兩端必須矛盾（bug 實錘）: sch=${sch.due.length} ses=${ses.all.length}`);
  }
}

// T1 主場景：cap=5、8r+4l+5new → 兩端 12（4 learn + 5 review + 3 new）
scenario('T1 cap=5', CAP, NEW_PER_DAY, 0, {
  total: 12, reviews: ['r1','r2','r3','r4','r5'], reviewsOut: ['r6','r7','r8'], newCount: 3,
  legacySch: 9, diverge: true,
});
// T2 cap=0（不限）→ 全量 17（新舊同值：cap 不觸發；對照組非 bug 場景）
scenario('T2 cap=0', 0, 20, 0, {
  total: 17, reviews: ['r1','r2','r3','r4','r5','r6','r7','r8'], reviewsOut: [], newCount: 5,
  legacySch: 17, diverge: false,
});
// T3 ratedNewToday=2, newPerDay=3 → newSlots=1 → 4+5+1=10
scenario('T3 resume ratedNew=2', CAP, NEW_PER_DAY, 2, {
  total: 10, reviews: ['r1','r2','r3','r4','r5'], reviewsOut: ['r6','r7','r8'], newCount: 1,
  legacySch: 9, diverge: true,
});
// T4 newPerDay=0（新卡關閉）：cap 不影響 new 段；review cap 5 → 4+5=9
// （legacy 在無 new 時與修法同值 — 錨定「舊 bug 僅在 new 存在時觸發」的事實）
scenario('T4 newPerDay=0', CAP, 0, 0, {
  total: 9, reviews: ['r1','r2','r3','r4','r5'], reviewsOut: ['r6','r7','r8'], newCount: 0,
  legacySch: 9, diverge: false,
});
// T7 cap < learning 且含 new（審查 #3 邊角錨定）：cap=1、learning 4、new 額度 3
// → 兩端 8（4 learn + 1 review + 3 new）
scenario('T7 cap<learning 含 new', 1, 3, 0, {
  total: 8, reviews: ['r1'], reviewsOut: ['r2','r3','r4','r5','r6','r7','r8'], newCount: 3,
  legacySch: 5, diverge: true,
});
// T8 cap 恰 = review 數（嚴格 > 不截斷邊界）：cap=8 → 兩端全收 17（4l+8r+5new）
scenario('T8 cap==review 數邊界', 8, 20, 0, {
  total: 17, reviews: ['r1','r2','r3','r4','r5','r6','r7','r8'], reviewsOut: [], newCount: 5,
  legacySch: 12, diverge: true,
});
// T9 ratedNewToday 超額（>newPerDay）：兩端 new 0、newCount 不為負
scenario('T9 ratedNew 超額', CAP, 3, 10, {
  total: 9, reviews: ['r1','r2','r3','r4','r5'], reviewsOut: ['r6','r7','r8'], newCount: 0,
  legacySch: 9, diverge: false,
});
// T5 review 選擇正確性：cap 掉的是最晚 due（r6..r8），不是 random
{
  const isRev = id => /^r\d$/.test(id);
  const sch = runScheduler(CAP, NEW_PER_DAY);
  const revIds = sch.due.filter(w => isRev(w.id)).map(w => w.id);
  assert(eqArr(revIds, ['r1','r2','r3','r4','r5']), `T5 scheduler review 取最早 5: [${revIds}]`);
  const ses = runSession(CAP, NEW_PER_DAY);
  const sesRev = ses.main.filter(x => x.type === 'review').map(x => x.word.id).sort();
  assert(eqArr(sesRev, ['r1','r2','r3','r4','r5']), `T5 session review 取最早 5: [${sesRev}]`);
}
// T6 learning 永不被 cap（cap=1 仍 4 張全入）
{
  const sch = runScheduler(1, 0);
  const learn = sch.due.filter(w => /^(l|rl)/.test(w.id));
  assert(learn.length === 4, `T6 cap=1 learning 4 張全入: got ${learn.length}`);
  const ses = runSession(1, 0);
  assert(ses.intraday.length === 4 && ses.main.filter(x => x.type === 'review').length === 1,
    `T6 session intraday=4 review=1`);
  assert(eqSet(sch.due, ses.all), 'T6 兩端一致（cap=1 極端值，無 new 干擾）');
}

console.log(`\nC5 verify${EXPECT_LEGACY ? ' [legacy 負控制]' : ''}: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
process.exit(fail ? 1 : 0);
