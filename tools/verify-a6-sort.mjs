#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// A6 防回歸驗證 — dashboard 預覽（getDueCards）與實際 session（buildQueue →
// intradayLearning）的 learning/relearning 卡排序必須一致，且兩端都符合
// Anki sort_learning: cmp_by_reps_then_due（reps 小→大，再 due 早→晚）。
//
// 同時守住：
//   • review 卡排序不受影響（仍是 due 早→晚）
//   • new 卡 shuffle 不受影響（仍會 shuffle、newPerDay cap 仍生效）
//
// 用法: node tools/verify-a6-sort.mjs
// 期望: 全部 PASS（exit 0）；任何 FAIL → exit 1
// ═══════════════════════════════════════════════════════════════
import { getDueCards, cmpByRepsThenDue } from '../src/core/scheduler.js';
import { Session } from '../src/engine/session-v4.js';
import { FSRS, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../src/core/fsrs.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', msg); }
}
function eqArr(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}
function idArr(items) { return items.map(x => (x.word ? x.word.id : x.id)); }

// ── 固定「今天」：以 UTC 今天 00:00 為基準；TZ=0、dayCutoff=0 → 兩端同日 ──
// buildQueue 無法注入時間（用真實 now），故 getDueCards 也吃真實 now，
// 全部 due 設在 todayStart + 0.5h~10h → 無論測試幾點跑都在「今天」內。
const now = new Date();
const T = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = ms => new Date(ms).toISOString();
const H = 3600e3;

// ── 學習卡：刻意讓 reps / due / lastReview 三種排序方向互相矛盾 ──
// reps_then_due 期望序：[wD(0,10h), wC(1,8h), wA(1,9h), wB(2,8h)]
// 舊 scheduler（lastReview 早→晚）：[wB(0.5h), wC(4h), wA(5h), wD(6h)] — 不同
// 舊 buildQueue（due 早→晚）：       [wC, wB, wA, wD]                  — 不同
const cards = new Map([
  ['wA', { state: STATE_LEARNING,    reps: 1, due: iso(T + 9 * H),   lastReview: iso(T + 5 * H) }],
  ['wB', { state: STATE_RELEARNING,  reps: 2, due: iso(T + 8 * H),   lastReview: iso(T + 0.5 * H) }],
  ['wC', { state: STATE_LEARNING,    reps: 1, due: iso(T + 8 * H),   lastReview: iso(T + 4 * H) }],
  ['wD', { state: STATE_LEARNING,    reps: 0, due: iso(T + 10 * H),  lastReview: iso(T + 6 * H) }],
  // review：due 早→晚 = [wR2, wR1]（reps 故意反著放，證明不受 reps 影響）
  ['wR1', { state: STATE_REVIEW, reps: 10, due: iso(T + 7 * H), lastReview: iso(T + 2 * H) }],
  ['wR2', { state: STATE_REVIEW, reps: 5,  due: iso(T + 6 * H), lastReview: iso(T + 3 * H) }],
]);
const words = ['wD', 'wC', 'wA', 'wB', 'wR1', 'wR2', 'wN1', 'wN2', 'wN3']
  .map(id => ({ id, word: id }));
const EXPECT_LEARN = ['wD', 'wC', 'wA', 'wB'];
const EXPECT_REVIEW = ['wR2', 'wR1'];
const NEW_IDS = ['wN1', 'wN2', 'wN3'];

// ── 1. comparator 單元檢查 ──
assert(cmpByRepsThenDue(cards.get('wC'), cards.get('wB')) < 0, 'cmpByRepsThenDue: reps 少→多 (wC reps1 < wB reps2)');
assert(cmpByRepsThenDue(cards.get('wC'), cards.get('wA')) < 0, 'cmpByRepsThenDue: 同 reps 時 due 早→晚 (wC 8h < wA 9h)');
assert(cmpByRepsThenDue(cards.get('wD'), cards.get('wC')) < 0, 'cmpByRepsThenDue: reps=0 排最前 (wD reps0 < wC reps1)');
assert(cmpByRepsThenDue({}, {}) === 0, 'cmpByRepsThenDue: 空卡安全 (0 === 0)');

// ── 2. dashboard 預覽端：getDueCards ──
const { due, newCount } = getDueCards(words, cards, new Set(), new Set(), 20, 0, 0, 0, iso(now), 0);
const previewLearn = due.slice(0, 4).map(w => w.id);
const previewReview = due.slice(4, 6).map(w => w.id);
const previewNew = due.slice(6).map(w => w.id).sort();
assert(eqArr(previewLearn, EXPECT_LEARN), `getDueCards 學習序 = reps_then_due (got ${previewLearn.join(',')})`);
assert(eqArr(previewReview, EXPECT_REVIEW), `getDueCards review 序仍 due 早→晚 (got ${previewReview.join(',')})`);
assert(eqArr(previewNew, [...NEW_IDS].sort()), `getDueCards new 全數在列 (got ${previewNew.join(',')})`);
assert(newCount === 3, `getDueCards newCount = 3 (got ${newCount})`);
assert(due.length === 9, `getDueCards 總數 = 9 (got ${due.length})`);

// ── 3. session 端：buildQueue（reviewMix=0 → mainQueue = review + new）───
function makeSession(mode, newPerDay = 20) {
  return new Session({
    words, cards, buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9),
    dayCutoff: 0, newPerDay, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10',
    maxReviewsPerDay: 0, reviewMix: 0, timezoneOffset: 0,
    mode, learnAheadLimit: 20,
  });
}
const s = makeSession('flip');
s.buildQueue();

const sessionLearn = idArr(s.intradayLearning);
const sessionReview = idArr(s.mainQueue.slice(0, 2));
const sessionNew = idArr(s.mainQueue.slice(2)).sort();
assert(eqArr(sessionLearn, EXPECT_LEARN), `buildQueue 學習序 = reps_then_due (got ${sessionLearn.join(',')})`);
assert(eqArr(sessionReview, EXPECT_REVIEW), `session review 序仍 due 早→晚 (got ${sessionReview.join(',')})`);
assert(eqArr(sessionNew, [...NEW_IDS].sort()), `session new 全數在列 (got ${sessionNew.join(',')})`);
assert(s.mainQueue.length === 5, `session mainQueue = 2 review + 3 new = 5 (got ${s.mainQueue.length})`);

// ── 4. A6 核心：預覽端與 session 端學習序必須一字不差 ──
assert(eqArr(previewLearn, sessionLearn),
  `A6: getDueCards 與 buildQueue 學習序一致 (preview=${previewLearn.join(',')} session=${sessionLearn.join(',')})`);
assert(eqArr(previewReview, sessionReview),
  `A6: review 序兩端一致 (preview=${previewReview.join(',')} session=${sessionReview.join(',')})`);

// ── 5. new 卡 shuffle 不受影響：shuffle 仍在（三 mode 至少一個 ≠ 輸入序）──
const inputOrder = [...NEW_IDS];
const shuffledOrders = ['flip', 'mc', 'spell'].map(mode => {
  const s2 = makeSession(mode);
  s2.buildQueue();
  return idArr(s2.mainQueue.slice(2)); // new segment
});
assert(shuffledOrders.some(o => !eqArr(o, inputOrder)),
  `new shuffle 仍生效 (flip=${shuffledOrders[0].join(',')} mc=${shuffledOrders[1].join(',')} spell=${shuffledOrders[2].join(',')})`);

// ── 6. newPerDay cap 兩端一致 ──
const capped = makeSession('flip', 2);
capped.buildQueue();
const { due: dueCapped, newCount: newCountCapped } =
  getDueCards(words, cards, new Set(), new Set(), 2, 0, 0, 0, iso(now), 0);
assert(newCountCapped === 2, `getDueCards newPerDay=2 → newCount 2 (got ${newCountCapped})`);
assert(dueCapped.slice(6).length === 2, `getDueCards newPerDay=2 → due 只含 2 張 new (got ${dueCapped.slice(6).length})`);
assert(idArr(capped.mainQueue.slice(2)).length === 2, `session newPerDay=2 → mainQueue 只含 2 張 new (got ${idArr(capped.mainQueue.slice(2)).length})`);

console.log(`\nA6 驗證: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
