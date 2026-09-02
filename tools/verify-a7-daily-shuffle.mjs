#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// A7 防回歸驗證 — new 卡每日順序重洗（Anki 每天 salt re-hash）。
//
// Bug：Session 的 new 卡 shuffle 用固定 seed（mulberry32(hashCode(mode))，
// constructor 只建一次）→ 每天 new 卡順序都一樣，且同一天內多次 buildQueue
// 會沿用已推進的 RNG 狀態 → 重進 session 順序還亂跳。
//
// 修法：buildQueue 每次用 seed = hashCode(mode + '_' + 當天日期) 重新建 RNG →
//   • 同一天內（重進 session / 重新 build）順序完全一致（同 seed 全新 RNG）
//   • 不同天（日期字串不同）順序不同（對應 Anki 每天 salt re-hash）
//   • mode 含在 seed 內，三種學習模式各自獨立
//
// 「模擬不同天」：toLocalDateStr 把 now + timezoneOffset*60000 的日期部分當
// 「今天」，故 offset 每 +1440 分鐘 = 多一天 — 不需偽造 Date。
//
// 同時守住：learning 卡排序（cmpByRepsThenDue，A6）、review 卡 due 排序、
// new shuffle 仍生效、newPerDay cap。
//
// 用法: node tools/verify-a7-daily-shuffle.mjs
// 期望: 全部 PASS（exit 0）；任何 FAIL → exit 1
// ═══════════════════════════════════════════════════════════════
import { cmpByRepsThenDue } from '../src/core/scheduler.js';
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

// ── 固定「今天」：due 全部設在 UTC 今天 00:00 起 5h~10h 內 ──
// buildQueue 吃真實 now，但時間窗夠寬 → 任何時刻跑都在「今天」內；
// 配合 timezoneOffset 平移模擬不同天，due 的 dueLocal 會同步平移，
// 仍等於當天的 today → 不會被 due 過濾掉。
const now = new Date();
const T = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = ms => new Date(ms).toISOString();
const H = 3600e3;
const DAY = 1440; // timezoneOffset 分鐘 = 一天

// ── 資料：12 張 new、4 張 learning（reps/due 互相矛盾）、3 張 review ──
const NEW_IDS = Array.from({ length: 12 }, (_, i) => `wN${String(i + 1).padStart(2, '0')}`);
const cards = new Map([
  // learning：reps_then_due 期望序 = [wL1(0,10h), wL3(1,8h), wL2(1,9h), wL4(2,8h)]
  // （wL3/wL2 同 reps=1 → due 早者前，與 A6 測試同一 comparator 語意）
  ['wL1', { state: STATE_LEARNING,   reps: 0, due: iso(T + 10 * H) }],
  ['wL2', { state: STATE_LEARNING,   reps: 1, due: iso(T + 9 * H) }],
  ['wL3', { state: STATE_RELEARNING, reps: 1, due: iso(T + 8 * H) }],
  ['wL4', { state: STATE_LEARNING,   reps: 2, due: iso(T + 8 * H) }],
  // review：due 早→晚 = [wR3, wR2, wR1]
  ['wR1', { state: STATE_REVIEW, reps: 9, due: iso(T + 7 * H) }],
  ['wR2', { state: STATE_REVIEW, reps: 5, due: iso(T + 6 * H) }],
  ['wR3', { state: STATE_REVIEW, reps: 2, due: iso(T + 5 * H) }],
]);
for (const id of NEW_IDS) cards.set(id, { state: STATE_NEW });
const words = ['wL1', 'wL2', 'wL3', 'wL4', 'wR1', 'wR2', 'wR3', ...NEW_IDS].map(id => ({ id, word: id }));

const EXPECT_LEARN = ['wL1', 'wL3', 'wL2', 'wL4'];
const EXPECT_REVIEW = ['wR3', 'wR2', 'wR1'];

function makeSession(mode, timezoneOffset = 0, newPerDay = 20) {
  return new Session({
    words, cards, buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9),
    dayCutoff: 0, newPerDay, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10',
    maxReviewsPerDay: 0, reviewMix: 1, // reviewMix=1 → mainQueue = new 先、review 後，new segment 好切
    timezoneOffset, mode, learnAheadLimit: 20,
  });
}
// mainQueue = [...newCards, ...reviewQueue]（reviewMix=1）→ new segment = 前 nNew 個
function newSegment(s, nNew = NEW_IDS.length) {
  return idArr(s.mainQueue.slice(0, nNew));
}
function reviewSegment(s) {
  return idArr(s.mainQueue.slice(NEW_IDS.length));
}

// ── 1. 同一天內、同一 Session 連續兩次 buildQueue：順序必須一致 ──
//    （舊 code：constructor 只 seed 一次，第二次 build 沿用已推進的 RNG → 順序變 → 此斷言 FAIL）
for (const mode of ['flip', 'mc', 'spell']) {
  const s = makeSession(mode, 0);
  s.buildQueue();
  const first = newSegment(s);
  s.buildQueue(); // 模擬重進 session / 完成後重開
  const second = newSegment(s);
  assert(eqArr(first, second),
    `[${mode}] 同一天內同一 Session 兩次 buildQueue new 序一致 (${first.join(',')})`);
  const learn = idArr(s.intradayLearning);
  assert(eqArr(learn, EXPECT_LEARN),
    `[${mode}] rebuild 後 learning 序仍 reps_then_due (got ${learn.join(',')})`);
}

// ── 2. 同一天內、不同 Session（fresh）buildQueue：順序也必須一致（seed 決定論）──
{
  const a = newSegment(makeSession('flip', 0));
  const b = newSegment(makeSession('flip', 0));
  assert(eqArr(a, b), `同一天兩個 fresh Session new 序一致 (${a.join(',')})`);
}

// ── 3. 不同天（offset +1440 分鐘 = 多一天）→ 順序必須不同 ──
//    （舊 code：seed 只有 mode，每天都一樣 → 此斷言 FAIL）
{
  const s0 = makeSession('flip', 0);
  s0.buildQueue();
  const s1 = makeSession('flip', DAY);
  s1.buildQueue();
  const day0 = newSegment(s0);
  const day1 = newSegment(s1);
  assert(!eqArr(day0, day1),
    `不同天 new 序不同 (day0=${day0.join(',')} day1=${day1.join(',')})`);
}

// ── 4. 連續 31 天模擬：不能每天都同一種順序（每天重洗）──
for (const mode of ['flip', 'mc', 'spell']) {
  const orders = [];
  for (let d = 0; d < 31; d++) {
    const s = makeSession(mode, d * DAY);
    s.buildQueue();
    const o = newSegment(s);
    // 同一天內 rebuild 也要穩（每「天」順便驗一次）
    s.buildQueue();
    assert(eqArr(o, newSegment(s)), `[${mode}] day${d} 同天 rebuild 穩定 (${o.join(',')})`);
    orders.push(o.join(','));
  }
  const distinct = new Set(orders);
  assert(distinct.size >= 2,
    `[${mode}] 31 天中至少 2 種不同順序（每天重洗，got ${distinct.size} 種）`);
  assert(orders[0] !== orders[1],
    `[${mode}] day0 與 day1 順序不同 (${orders[0]} vs ${orders[1]})`);
}

// ── 5. mode 含在 seed 內：同一天不同 mode 順序彼此獨立 ──
{
  const o = {};
  for (const mode of ['flip', 'mc', 'spell']) {
    const s = makeSession(mode, 0);
    s.buildQueue();
    o[mode] = newSegment(s);
  }
  assert(!eqArr(o.flip, o.mc) && !eqArr(o.flip, o.spell) && !eqArr(o.mc, o.spell),
    `同一天三種 mode 順序各自不同 (flip=${o.flip.join(',')} mc=${o.mc.join(',')} spell=${o.spell.join(',')})`);
}

// ── 6. new shuffle 仍生效：new segment 是全部 new 卡的排列，且 ≠ 輸入序 ──
{
  const s = makeSession('flip', 0);
  s.buildQueue();
  const seg = newSegment(s);
  assert(eqArr([...seg].sort(), [...NEW_IDS].sort()), `new segment 含全部 ${NEW_IDS.length} 張 new 卡`);
  assert(!eqArr(seg, NEW_IDS), `shuffle 仍生效（順序 ≠ 輸入序）(got ${seg.join(',')})`);
  assert(eqArr(reviewSegment(s), EXPECT_REVIEW), `review 序仍 due 早→晚 (got ${reviewSegment(s).join(',')})`);
  assert(eqArr(idArr(s.intradayLearning), EXPECT_LEARN), `learning 序仍 reps_then_due (got ${idArr(s.intradayLearning).join(',')})`);
}

// ── 7. A6 comparator 回歸：cmpByRepsThenDue 單元檢查 ──
assert(cmpByRepsThenDue(cards.get('wL2'), cards.get('wL3')) > 0, 'cmpByRepsThenDue: 同 reps 時 due 早者前 (wL3 8h < wL2 9h)');
assert(cmpByRepsThenDue(cards.get('wL1'), cards.get('wL2')) < 0, 'cmpByRepsThenDue: reps=0 排最前');
assert(cmpByRepsThenDue(cards.get('wL4'), cards.get('wL2')) > 0, 'cmpByRepsThenDue: reps 多者後');
assert(cmpByRepsThenDue({}, {}) === 0, 'cmpByRepsThenDue: 空卡安全');

// ── 8. newPerDay cap 不因新 seed 破壞：只取前 n 張、皆為 new、不重複 ──
{
  const s = makeSession('flip', 0, 4);
  s.buildQueue();
  const seg = newSegment(s, 4);
  assert(seg.length === 4, `newPerDay=4 → new segment 只含 4 張 (got ${seg.length})`);
  assert(new Set(seg).size === 4 && seg.every(id => NEW_IDS.includes(id)),
    `cap 後的 4 張皆為相異 new 卡 (got ${seg.join(',')})`);
  assert(s.mainQueue.length === 4 + 3, `mainQueue = 4 new + 3 review = 7 (got ${s.mainQueue.length})`);
}

// ── 9. dayCutoff 存在時同天 rebuild 仍穩定（today 字串同源）──
{
  const s = new Session({
    words, cards, buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9),
    dayCutoff: 240, newPerDay: 20, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10',
    maxReviewsPerDay: 0, reviewMix: 1, timezoneOffset: 0,
    mode: 'flip', learnAheadLimit: 20,
  });
  s.buildQueue();
  const first = newSegment(s);
  s.buildQueue();
  assert(eqArr(first, newSegment(s)), `dayCutoff=240 同天 rebuild 穩定 (${first.join(',')})`);
}

console.log(`\nA7 驗證: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
