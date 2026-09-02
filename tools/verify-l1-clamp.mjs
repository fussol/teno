#!/usr/bin/env node
// L1 防回歸測試: learnAheadLimit 無限循環 bug 無法被觸發
// 用法: node tools/verify-l1-clamp.mjs
// 期望: 全部 PASS（exit 0）；任何 ❌ → exit 1
import { Session } from '../src/engine/session-v4.js';
import { FSRS } from '../src/core/fsrs.js';
import { clampLearnAhead } from '../src/lib/store.js';

let failures = 0;
function check(label, got, expect) {
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${got} expect=${expect}`);
}

// 1. helper 邊界
check('clampLearnAhead(-5)', clampLearnAhead(-5), 0);
check('clampLearnAhead(999)', clampLearnAhead(999), 20);
check('clampLearnAhead(2000)', clampLearnAhead(2000), 20);
check('clampLearnAhead(20)', clampLearnAhead(20), 20);
check('clampLearnAhead(0)', clampLearnAhead(0), 0);
check('clampLearnAhead(NaN)', clampLearnAhead(NaN), 20);
check('clampLearnAhead(undefined)', clampLearnAhead(undefined), 20);
check('clampLearnAhead(null)', clampLearnAhead(null), 20);

// 2. session 讀取端: 刻意傳髒值 2000 → learnAheadSecs 必須是 1200（非 120000）
const fsrs = new FSRS(null, 0.9);
const base = {
  words: [], cards: new Map(), buried: new Set(), suspended: new Set(), fsrs,
  dayCutoff: 480, newPerDay: 80, ratedNewToday: 0,
  learnSteps: '1,10', relearnSteps: '10', maxReviewsPerDay: 1000,
  reviewMix: 2, timezoneOffset: 480,
};
for (const mode of ['flip', 'mc', 'spell']) {
  const s = new Session({ ...base, mode, learnAheadLimit: 2000 });
  check(`session[${mode}].learnAheadSecs(2000)`, s.learnAheadSecs, 1200);
}
check('session.learnAheadSecs(-5)', new Session({ ...base, mode: 'flip', learnAheadLimit: -5 }).learnAheadSecs, 0);
check('session.learnAheadSecs(0)', new Session({ ...base, mode: 'flip', learnAheadLimit: 0 }).learnAheadSecs, 0);

// 3. 完整循環模擬: learning 卡 due 在窗外 (+30min) + learnAheadLimit=2000 髒值
//    L1 bug 未修時 (33h 窗): 窗外卡也被捲入 → l2 被 review 269 次 (無限循環)
//    修法後 (20min 窗): 窗外卡不撈 → 只有到期 review 卡被答, 自然結束
function runLoop() {
  const NOW = Date.now();
  const cards = new Map();
  const words = [];
  const mk = (id, state, dueOffsetMin, reps, stability) => {
    words.push({ id, word: 'word' + id, deck: 'test' });
    cards.set(id, {
      due: new Date(NOW + dueOffsetMin * 60000).toISOString(),
      stability, difficulty: 5, elapsedDays: 0, scheduledDays: 0,
      reps, lapses: 0, state, step: 0, lastReview: new Date(NOW).toISOString(),
      buried: false, suspended: false, interval: 0,
    });
  };
  mk('l1', 1, 30, 2, 0.5);   // learning, due +30min (窗外)
  mk('l2', 1, 30, 3, 0.5);   // learning, due +30min (窗外)
  mk('v1', 2, -1, 10, 5);    // review, due 已到
  const session = new Session({
    words, cards, buried: new Set(), suspended: new Set(), fsrs,
    dayCutoff: 480, newPerDay: 80, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10', maxReviewsPerDay: 1000,
    reviewMix: 2, timezoneOffset: 480, mode: 'flip', learnAheadLimit: 2000,
  });
  const count = new Map();
  let reviews = 0;
  let current = session.start();
  while (current && reviews < 100) {
    const wid = current.word.id;
    count.set(wid, (count.get(wid) || 0) + 1);
    const rating = (reviews % 5 === 4) ? 2 : 0; // 4 Again : 1 Good (真人)
    const res = fsrs.review({
      stability: current.card?.stability ?? 0, difficulty: current.card?.difficulty ?? 5,
      state: current.card?.state ?? 0, reps: current.card?.reps ?? 0,
      lapses: current.card?.lapses ?? 0, step: current.card?.step ?? 0,
      elapsedDays: 0, scheduledDays: current.card?.scheduledDays ?? 0,
    }, rating, undefined, [1 / 1440, 10 / 1440], [10 / 1440], undefined);
    cards.set(wid, {
      ...current.card,
      due: new Date(Date.now() + Math.max(60000, Math.round(res.dueDays * 86400000))).toISOString(),
      stability: res.stability, difficulty: res.difficulty,
      state: res.state, reps: res.reps, lapses: res.lapses, step: res.step ?? 0,
    });
    session.rate(rating);
    session.requeueIntraday(wid, cards.get(wid));
    current = session.next();
    reviews++;
  }
  return { reviews, finished: session.running === false, maxCount: Math.max(0, ...count.values()) };
}

const loop = runLoop();
// 修後: learnAheadSecs=1200 (20min 窗) → 窗外 learning 卡 (+30min) 不被撈
//       只有 v1 (review, 已到期) 被答 → 作答數小, 自然結束
// L1 bug 未修時 (learnAheadSecs=120000): 窗外卡也被捲入 → 100 上限內跑滿
check('loop.reviews < 20', loop.reviews < 20, true);
check('loop.maxCount < 10', loop.maxCount < 10, true);

console.log(failures === 0 ? '\n=== L1 防回歸 ALL PASS ===' : `\n=== ${failures} FAILURES ===`);
process.exit(failures === 0 ? 0 : 1);
