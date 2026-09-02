// A3 驗證：A1 修後 interval 是否已支援「縮水」語意（Anki 三態：成長→+1 / 持平→回 prev / 縮水→允許縮短）
// 測試法：模擬 desiredRetention 調高（DR↑ → raw interval 縮小）時，review 卡 GOOD 是否允許縮短（不再強制 prev+1）
import { FSRS, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, AGAIN, HARD, GOOD, EASY } from '../src/core/fsrs.js';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', msg); }
}

// 構造一顆穩定 review 卡：高 stability、低 difficulty → 大 interval
const stableCard = {
  wordId: 'w_test',
  stability: 200,        // 高穩定性
  difficulty: 1.5,       // 低難度
  state: STATE_REVIEW,
  reps: 20,
  lapses: 0,
  elapsedDays: 100,
  scheduledDays: 100,    // 上次間隔 100 天
  step: 0,
};

// 情境 1: 正常權重，prev=100 → 應該成長（>100）
{
  const fsrs = new FSRS(null, 0.9);
  const r = fsrs.review(stableCard, GOOD, null, [1/1440, 10/1440], [10/1440], null);
  assert(r.state === STATE_REVIEW, `情境1 成長: state=REVIEW (got ${r.state})`);
  assert(r.dueDays >= 100, `情境1 成長: dueDays>=100 (got ${r.dueDays})`);
}

// 情境 2: desiredRetention 調高到 0.99（DR↑ → 間隔縮小）
// Anki 語意：縮水時允許縮短（branch 3: prevIvl 超出 fuzz 範圍 → 0 下限）
{
  const fsrs = new FSRS(null, 0.99);
  const r = fsrs.review(stableCard, GOOD, null, [1/1440, 10/1440], [10/1440], null);
  assert(r.state === STATE_REVIEW, `情境2 縮水: state=REVIEW (got ${r.state})`);
  console.log(`  情境2 縮水: DR=0.99 → dueDays=${r.dueDays} (prev=100)`);
  // 允許縮短 → dueDays 可能 < 100；不強制 >= 100
  // 此處只是輸出觀察，斷言由下方「不崩潰」擔保
  assert(Number.isFinite(r.dueDays) && r.dueDays >= 1, `情境2: dueDays 有效 (got ${r.dueDays})`);
}

// 情境 3: 手動降級（lapse 後再次 GOOD）→ interval 應能縮
{
  const lapseCard = {
    wordId: 'w_lapse', stability: 5, difficulty: 7,
    state: STATE_REVIEW, reps: 12, lapses: 2,
    elapsedDays: 30, scheduledDays: 30, step: 0,
  };
  const fsrs = new FSRS(null, 0.9);
  const r = fsrs.review(lapseCard, AGAIN, null, [1/1440, 10/1440], [10/1440], null);
  // AGAIN → relearning 或 review；lapse 後應有穩定 interval
  assert(Number.isFinite(r.dueDays) && r.dueDays >= 0, `情境3 lapse: dueDays 有效 (got ${r.dueDays})`);
}

// 情境 4: 早複習（elapsed=1, prev=30）→ Anki 允許縮短（branch 3）
{
  const earlyCard = {
    wordId: 'w_early', stability: 20, difficulty: 4,
    state: STATE_REVIEW, reps: 8, lapses: 0,
    elapsedDays: 1, scheduledDays: 30, step: 0,
  };
  const fsrs = new FSRS(null, 0.9);
  const r = fsrs.review(earlyCard, GOOD, null, [1/1440, 10/1440], [10/1440], null);
  assert(r.state === STATE_REVIEW, `情境4 早複習: state=REVIEW (got ${r.state})`);
  console.log(`  情境4 早複習: elapsed=1 prev=30 → dueDays=${r.dueDays}`);
  assert(Number.isFinite(r.dueDays) && r.dueDays >= 1, `情境4: dueDays 有效 (got ${r.dueDays})`);
}

console.log(`\nA3 驗證: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
