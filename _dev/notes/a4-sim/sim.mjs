// A4 模擬驗證：parseStepsStr 邊界 + 空陣列 [] 傳 fsrs.review + 修法 1 畢業驗證 + store.js:622 due 路徑
import { FSRS as PatchedFSRS, parseStepsStr, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from './fsrs-patched.mjs';
import { FSRS as OrigFSRS } from './fsrs-orig.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  — ' + extra : ''}`); }
}
const approx = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;
const D = (m) => m / 1440; // minutes -> days

console.log('=== 1. parseStepsStr 邊界（修法 2 helper） ===');
check("'' + fallback '1,10' → [1/1440, 10/1440]", JSON.stringify(parseStepsStr('', '1,10')) === JSON.stringify([D(1), D(10)]));
check("null + fallback '10' → [10/1440]", JSON.stringify(parseStepsStr(null, '10')) === JSON.stringify([D(10)]));
check("undefined + no fallback → []", parseStepsStr(undefined, undefined).length === 0);
check("',' → []", parseStepsStr(',', '1,10').length === 0);
check("'1,,10' → [1/1440, 10/1440]", JSON.stringify(parseStepsStr('1,,10', '1,10')) === JSON.stringify([D(1), D(10)]));
check("'abc' → []", parseStepsStr('abc', '1,10').length === 0);
check("'0,5' → [5/1440]（0 丟棄）", JSON.stringify(parseStepsStr('0,5', '1,10')) === JSON.stringify([D(5)]));
check("'1.5,10' → [1.5/1440, 10/1440]", JSON.stringify(parseStepsStr('1.5,10', '1,10')) === JSON.stringify([D(1.5), D(10)]));
check("'-5,10' → [10/1440]（負值丟棄）", JSON.stringify(parseStepsStr('-5,10', '1,10')) === JSON.stringify([D(10)]));
check("' 1 , 10 '（空白）→ [1/1440, 10/1440]", JSON.stringify(parseStepsStr(' 1 , 10 ', '1,10')) === JSON.stringify([D(1), D(10)]));
check("'1,10' 正常 → [1/1440, 10/1440]", JSON.stringify(parseStepsStr('1,10', '1,10')) === JSON.stringify([D(1), D(10)]));
check("數字型態 42（非字串）→ 不 throw、[]（42 無逗號 → parseFloat('42')/1440）", JSON.stringify(parseStepsStr(42, '1,10')) === JSON.stringify([D(42)]));

console.log('\n=== 2. 原版（未修）對照 — bug 重現 ===');
const orig = new OrigFSRS();
const newCard = { stability: 0, difficulty: 5, state: STATE_NEW, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 };
const r1 = orig.review(newCard, 0, undefined, [], []);
check('原版 [] + AGAIN → interval = 1/1440（硬填 1 分鐘 → 層 1 迴圈 bug）', approx(r1.interval, D(1)), `interval=${r1.interval}`);
const r2 = orig.review(newCard, 0, undefined, [NaN], [NaN]);
check('原版 [NaN] + AGAIN → interval 是 NaN（層 2 bug）', Number.isNaN(r2.interval), `interval=${r2.interval}`);
// store.js:622 路徑模擬：new Date(Date.now() + Math.max(60000, Math.round(dueDays * 86400000))).toISOString()
let threw = false;
try { new Date(Date.now() + Math.max(60000, Math.round(r2.dueDays * 86400000))).toISOString(); } catch { threw = true; }
check('原版 [NaN] → store.js:622 due=NaN → RangeError throw', threw);

console.log('\n=== 3. 修法後：空陣列 [] 畢業驗證（配合修法 1） ===');
const p = new PatchedFSRS();
// 3a. 新卡全 rating
const states = ['NEW', 'LEARNING', 'REVIEW', 'RELEARNING'];
const cards = {
  NEW: { stability: 0, difficulty: 5, state: STATE_NEW, reps: 0, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 },
  LEARNING: { stability: 0.5, difficulty: 5.2, state: STATE_LEARNING, reps: 2, lapses: 0, step: 0, elapsedDays: 0, scheduledDays: 0 },
  REVIEW: { stability: 3.1, difficulty: 5.8, state: STATE_REVIEW, reps: 5, lapses: 0, step: 0, elapsedDays: 2, scheduledDays: 2 },
  RELEARNING: { stability: 1.2, difficulty: 6.5, state: STATE_RELEARNING, reps: 7, lapses: 1, step: 0, elapsedDays: 0, scheduledDays: 0 },
};
const ratingNames = ['AGAIN', 'HARD', 'GOOD', 'EASY'];
let allFinite = true, gradChecks = 0;
for (const s of states) {
  for (let r = 0; r <= 3; r++) {
    const res = p.review(cards[s], r, undefined, [], []);
    if (!Number.isFinite(res.dueDays) || !Number.isFinite(res.stability) || !Number.isFinite(res.difficulty)) {
      allFinite = false;
      console.log(`    ❌ ${s}/${ratingNames[r]}: dueDays=${res.dueDays}`);
    }
    // 空 [] 畢業檢查：任何 rating 都不得停在 learning/relearning 階段
    if (res.state === STATE_LEARNING || res.state === STATE_RELEARNING) {
      allFinite = false;
      console.log(`    ❌ ${s}/${ratingNames[r]}: 停在 learning 階段（應畢業） state=${res.state}`);
    }
    gradChecks++;
  }
}
check(`全部 ${gradChecks} 組合（4 state × 4 rating, steps=[]）: 無 NaN + 無 learning 迴圈`, allFinite);
// 3b. 畢業 interval 合理性（Anki FSRS path 語意：states.{rating}.interval — 各 rating 用各自 mem，v1.1 定案）
const gAgain = p.review(cards.NEW, 0, undefined, [], []).dueDays;
const gGood = p.review(cards.NEW, 2, undefined, [], []).dueDays;
// 複製 fsrs.js 公開公式（:32-36）算各 rating mem 的 raw 畢業 interval
const W = p.w;
function nextIvl(stability, dr = 0.9) {
  const decay = -W[20];
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return stability / factor * (Math.pow(dr, 1 / decay) - 1);
}
const gm = p.step(0, 2, { stability: 0, difficulty: 5 }, 0); // GOOD mem
const goodRaw = nextIvl(gm.stability);
const am = p.step(0, 0, { stability: 0, difficulty: 5 }, 0); // AGAIN mem
const againRaw = nextIvl(am.stability);
console.log(`    ℹ️ 消費端用各自 rating 的 mem.stability（FSRS path）→ AGAIN 空[]畢業=${gAgain.toFixed(2)}d vs GOOD 空[]畢業=${gGood.toFixed(2)}d；raw 差異 again=${againRaw.toFixed(2)}d good=${goodRaw.toFixed(2)}d`);
check('AGAIN 空 [] 畢業 interval = states.again.interval（round(max(1, AGAIN raw))）', approx(gAgain, Math.round(Math.max(1, againRaw)), 0.01), `gAgain=${gAgain.toFixed(3)} round(max(1,againRaw))=${Math.round(Math.max(1, againRaw)).toFixed(3)}`);
check('GOOD 空 [] 畢業 interval = states.good.interval（round(max(1, GOOD raw))）', approx(gGood, Math.round(Math.max(1, goodRaw)), 0.01), `gGood=${gGood.toFixed(3)} round(max(1,goodRaw))=${Math.round(Math.max(1, goodRaw)).toFixed(3)}`);
check('AGAIN 畢業 ≠ GOOD 畢業（rating-specific 語意成立，非 SM-2 同值）', Math.abs(gAgain - gGood) > 0.5, `diff=${Math.abs(gAgain - gGood).toFixed(2)}d`);
// 3b2. [0] 直傳 core 也畢業（M-1: <= 0 核心層防線）
const zAgain = p.review(cards.NEW, 0, undefined, [0], [0]);
const zHard = p.review(cards.NEW, 1, undefined, [0], [0]);
check('[0] 直傳 core AGAIN → 畢業 REVIEW（<= 0 防線）', zAgain.state === STATE_REVIEW && Number.isFinite(zAgain.dueDays) && zAgain.dueDays > 0, `state=${zAgain.state} dueDays=${zAgain.dueDays}`);
check('[0] 直傳 core HARD → 畢業 REVIEW（<= 0 防線）', zHard.state === STATE_REVIEW && Number.isFinite(zHard.dueDays) && zHard.dueDays > 0, `state=${zHard.state} dueDays=${zHard.dueDays}`);
// 3c. NaN 陣列直接進核心也防（雙層防護第二層）
const n1 = p.review(cards.NEW, 0, undefined, [NaN], [NaN]);
check('[NaN] + AGAIN → 不 throw、state=REVIEW、dueDays finite', Number.isFinite(n1.dueDays) && n1.state === STATE_REVIEW, `state=${n1.state} dueDays=${n1.dueDays}`);

console.log('\n=== 4. store.js:622 due 路徑（修法後） ===');
// 模擬 store.js rateCard 完整鏈：parseStepsStr → fsrs.review → due 計算
function rateCardLikeStore(learnStepsStr, relearnStepsStr, card, rating) {
  const learnSteps = parseStepsStr(learnStepsStr, '1,10');
  const relearnSteps = parseStepsStr(relearnStepsStr, '10');
  const result = p.review(card, rating, 0.0 /* fuzzFactor */, learnSteps, relearnSteps, null);
  const due = new Date(Date.now() + Math.max(60000, Math.round(result.dueDays * 86400000))).toISOString();
  return { result, due };
}
// 全丟（應畢業 REVIEW）：',' 'abc' ',,', '0,0', '-1'
let allOk = true;
for (const bad of [',', 'abc', ',,', '0,0', '-1']) {
  try {
    const { result, due } = rateCardLikeStore(bad, bad, cards.NEW, 0);
    const dueOk = !Number.isNaN(new Date(due).getTime());
    if (!dueOk || !Number.isFinite(result.dueDays) || result.state !== STATE_REVIEW) {
      allOk = false; console.log(`    ❌ '${bad}': dueDays=${result.dueDays} state=${result.state}`);
    }
  } catch (e) {
    allOk = false; console.log(`    ❌ '${bad}': throw ${e.message}`);
  }
}
check(`全丟畸形（',','abc','0,0','-1',' 等 5 組）: 不 throw、due 正常 ISO、畢業 REVIEW`, allOk);
// 部分有效/fallback（應進 learning，語意正確非畢業）：'1,,10'→[1,10]；'NaN,5'→[5]；''→fallback[1,10]
let okSem = true;
for (const [s, expectIvlMin] of [['1,,10', 1], ['NaN,5', 5], ['', 1]]) {
  try {
    const { result, due } = rateCardLikeStore(s, s, cards.NEW, 0);
    const dueOk = !Number.isNaN(new Date(due).getTime());
    if (!dueOk || result.state !== STATE_LEARNING || !approx(result.dueDays, D(expectIvlMin))) {
      okSem = false; console.log(`    ❌ '${s}': dueDays=${result.dueDays} state=${result.state}（期望 learning ${expectIvlMin}min）`);
    }
  } catch (e) {
    okSem = false; console.log(`    ❌ '${s}': throw ${e.message}`);
  }
}
check(`部分有效/fallback（'1,,10'→[1,10]、'NaN,5'→[5]、''→fallback）: 進 learning、interval 正確`, okSem);
// 正常輸入回歸
const ok1 = rateCardLikeStore('1,10', '10', cards.NEW, 0);
const ok2 = rateCardLikeStore('1,10', '10', cards.NEW, 2);
check("正常 '1,10' 回歸：AGAIN → learning step=0 interval=1min", ok1.result.state === STATE_LEARNING && approx(ok1.result.dueDays, D(1)), `state=${ok1.result.state} ivl=${ok1.result.dueDays}`);
check("正常 '1,10' 回歸：GOOD → learning step=1 interval=10min", ok2.result.state === STATE_LEARNING && approx(ok2.result.dueDays, D(10)), `state=${ok2.result.state} ivl=${ok2.result.dueDays}`);

console.log(`\n=== 結果: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
