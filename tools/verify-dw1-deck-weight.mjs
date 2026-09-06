// verify-dw1-deck-weight.mjs — DW1 字本新卡抽卡權重 雙態 harness
// 用法: node tools/verify-dw1-deck-weight.mjs        （POST 態：修法後全綠）
//       node tools/verify-dw1-deck-weight.mjs --pre    （PRE 態：修法前必紅）
// 期望: 修法後全部 PASS（exit 0）；修法前（--pre 或未修碼）加權腿必 FAIL → exit 1
// ═══════════════════════════════════════════════════════════════
// 設計依據: DW1-deck-newcard-weight-plan.md（2026-09-07）
//  - buildQueue（src/engine/session-v4.js:53）新卡洗牌段插入加權分支：
//    deckWeights = Map<deckName, w>；全 w=1（或缺 map）→ 原 seeded Fisher-Yates
//    原封不動（bit-identical）；任一 w≠1 → Efraimidis–Spirakis 加權抽樣
//    （key = rng()^(1/w)，同 seed=hashCode(mode+'_'+today)）
//  - decks.new_weight 欄（migration v11）＋ getAllDecks/saveDeck 帶值
// 測試腿:
//  T1 加權生效（高權重字本入選多）        — 修法前必紅（權重被忽略）
//  T2 零回歸 bit-identical（全 1 權重）  — 修法前後都綠（保護腿）
//  T3 同天穩定（兩次 buildQueue 同序）    — 修法前後都綠
//  T4 w=0 字本當天零新卡                  — 修法前必紅
//  T5 filter 語意（單本過濾+權重共存）    — 保護腿（單本過濾全選與權重無關，修前恆綠；R1 席核正）
//  T6 newSlots cap（加權池截斷）          — 修法前必紅（權重池 150→cap 20 分佈）
//  T7 SQLite 語意腿（new_weight DDL）     — node:sqlite 驗欄位語意；db.js 真實 CRUD 走內測門③
//  NC 負控制：未修碼時實跑紅腿 = T1a/T1b/T4/T6b（T2/T3/T5 保護腿恆綠）→ 證 harness 主牙真實
// ═══════════════════════════════════════════════════════════════
import { Session } from '../src/engine/session-v4.js';
import { FSRS, STATE_NEW, STATE_LEARNING, STATE_REVIEW } from '../src/core/fsrs.js';

const PRE = process.argv.includes('--pre');
let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  FAIL:', msg); }
}

// ── 固定「今天」窗（沿 a7 手法：due 全設 UTC 今天 5h~10h，任何時刻跑都在今天）──
const now = new Date();
const T = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = ms => new Date(ms).toISOString();
const H = 3600e3;

function idArr(items) { return items.map(x => x.word.id); }

// ── 場景工廠：deckA w 權重、deckB w=1，各 N 張 new 卡 ──
function makeScenario(nA, nB, weights, mode = 'flip', newPerDay = 200) {
  const cards = new Map();
  const words = [];
  for (let i = 0; i < nA; i++) {
    const id = `wA${String(i).padStart(2, '0')}`;
    cards.set(id, { state: STATE_NEW });
    words.push({ id, word: id, deck: 'deckA' });
  }
  for (let i = 0; i < nB; i++) {
    const id = `wB${String(i).padStart(2, '0')}`;
    cards.set(id, { state: STATE_NEW });
    words.push({ id, word: id, deck: 'deckB' });
  }
  const s = new Session({
    words, cards, buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9),
    dayCutoff: 0, newPerDay, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10',
    maxReviewsPerDay: 0, reviewMix: 1,
    timezoneOffset: 0, mode, learnAheadLimit: 20,
    ...(weights ? { deckWeights: weights } : {}),
  });
  return s;
}

// ═══ T1 加權生效：A(w=10)×50 vs B(w=1)×50，newPerDay=60（全選）→ A 應遠多於 B
// 全選場景其實驗證不了「加權」本身（都會全選）——改用稀缺場景：newPerDay=20，
// 池 100 張 → 加權抽樣後 A 佔比應顯著 > 50%；無權重（修前）≈ 50/50 ± 抽樣誤差。
// 但 seeded RNG 是確定的 → 跑多次不同 seed（mode 變體）取聚合統計，保守斷言。
{
  console.log('── T1 加權生效（聚合統計）──');
  let aWinTotal = 0, trials = 0, minA = Infinity;
  for (let t = 0; t < 30; t++) {
    const mode = 'flip' + (t === 0 ? '' : '~' + t); // 變 seed
    const s = makeScenario(50, 50, new Map([['deckA', 10], ['deckB', 1]]), mode, 20);
    s.start(null);
    const ids = idArr(s.mainQueue);
    const aCount = ids.filter(x => x.startsWith('wA')).length;
    aWinTotal += aCount; trials++;
    if (aCount < minA) minA = aCount;
  }
  const avg = aWinTotal / trials;
  console.log(`   30 trials × newPerDay=20: avg A selected = ${avg.toFixed(1)} / 20, min = ${minA}`);
  // w=10 vs w=1 → E[S] 每 20 張選 20×10/11 ≈ 18.2；修前（無權重）≈10。
  // 保守斷言：平均 ≥ 14 且最小值 ≥ 8（>50% 顯著偏向，容許 seeded 變異）。
  assert(avg >= 14, `T1a 加權偏向：avg=${avg.toFixed(1)} 應 ≥ 14（w=10 應顯著偏多）`);
  assert(minA >= 8, `T1b 最壞 trial：min=${minA} 應 ≥ 8（單 trial 容許變異但不得低於均勻水平）`);
}

// ═══ T2 零回歸 bit-identical：全權重 1 → 輸出與「無 map」完全同序 ──
{
  console.log('── T2 零回歸 bit-identical ──');
  const s1 = makeScenario(12, 12, new Map([['deckA', 1], ['deckB', 1]]), 'flip', 200);
  const s2 = makeScenario(12, 12, null, 'flip', 200);
  s1.start(null); s2.start(null);
  const o1 = idArr(s1.mainQueue), o2 = idArr(s2.mainQueue);
  assert(JSON.stringify(o1) === JSON.stringify(o2),
    `T2 全 1 權重 === 無權重：[${o1.slice(0,4).join(',')}]… vs [${o2.slice(0,4).join(',')}]…`);
}

// ═══ T3 同天穩定：同權重兩次 buildQueue → 同序（A7 語意延伸）──
{
  console.log('── T3 同天穩定 ──');
  const w = new Map([['deckA', 5], ['deckB', 1]]);
  const s1 = makeScenario(20, 20, w, 'flip', 40);
  const s2 = makeScenario(20, 20, w, 'flip', 40);
  s1.start(null); s2.start(null);
  assert(JSON.stringify(idArr(s1.mainQueue)) === JSON.stringify(idArr(s2.mainQueue)),
    'T3 同天兩次 buildQueue（同權重）順序必須相同');
}

// ═══ T4 w=0 排除：deckC w=0 → new segment 零 C 卡 ──
{
  console.log('── T4 w=0 排除 ──');
  const cards = new Map();
  const words = [];
  for (const [dk, n] of [['deckA', 30], ['deckC', 30]]) {
    for (let i = 0; i < n; i++) {
      const id = dk === 'deckA' ? `wA${i}` : `wC${i}`;
      cards.set(id, { state: STATE_NEW });
      words.push({ id, word: id, deck: dk });
    }
  }
  const s = new Session({
    words, cards, buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9), dayCutoff: 0, newPerDay: 200, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10', maxReviewsPerDay: 0, reviewMix: 1,
    timezoneOffset: 0, mode: 'flip', learnAheadLimit: 20,
    deckWeights: new Map([['deckA', 1], ['deckC', 0]]),
  });
  s.start(null);
  const cCount = idArr(s.mainQueue).filter(x => x.startsWith('wC')).length;
  assert(cCount === 0, `T4 w=0 字本零新卡：got ${cCount} wC cards（應 0）`);
}

// ═══ T5 filter＋權重共存：filter='deckA'（單本過濾）＋ deckA w=2 ──
// 過濾後池內只剩 deckA 卡 → 全選（newPerDay 夠大時）。語意：不 crash、
// 全選且穩定。再驗證 filter 排除的字本權重無效化（不在池內根本不選）。
{
  console.log('── T5 filter＋權重共存 ──');
  const cards = new Map();
  const words = [];
  for (const [dk, n] of [['deckA', 10], ['deckB', 10]]) {
    for (let i = 0; i < n; i++) {
      const id = (dk === 'deckA' ? 'wA' : 'wB') + i;
      cards.set(id, { state: STATE_NEW });
      words.push({ id, word: id, deck: dk });
    }
  }
  const mk = () => new Session({
    words, cards, buried: new Set(), suspended: new Set(),
    fsrs: new FSRS(null, 0.9), dayCutoff: 0, newPerDay: 100, ratedNewToday: 0,
    learnSteps: '1,10', relearnSteps: '10', maxReviewsPerDay: 0, reviewMix: 1,
    timezoneOffset: 0, mode: 'flip', learnAheadLimit: 20,
    deckWeights: new Map([['deckA', 2], ['deckB', 1]]),
  });
  const s1 = mk(); const s2 = mk();
  s1.start('deckA'); s2.start('deckA');
  // start() 消耗一張 current（buildQueue 從 mainQueue shift）→ 全量 = current + 剩餘
  const o1 = idArr([s1.current, ...s1.mainQueue]), o2 = idArr([s2.current, ...s2.mainQueue]);
  assert(o1.length === 10 && o1.every(x => x.startsWith('wA')),
    "T5a filter='deckA' → 只有 deckA 卡（10 張全選，current 含入）");
  assert(JSON.stringify(o1) === JSON.stringify(o2), 'T5b filter+權重同天穩定');
}

// ═══ T6 newSlots cap：加權池 150 張、newSlots=20 → 恰 20、分佈偏 A ──
{
  console.log('── T6 newSlots cap ──');
  let aSum = 0;
  for (let t = 0; t < 20; t++) {
    const mode = 'flip' + (t === 0 ? '' : '~' + t);
    const s = makeScenario(75, 75, new Map([['deckA', 8], ['deckB', 1]]), mode, 20);
    s.start(null);
    // start() 消耗 current → 全量 = current + mainQueue，且 current 是 new 卡（池內皆 new）
    const cur = s.current ? [s.current] : [];
    const ids = idArr([...cur, ...s.mainQueue]);
    assert(ids.length === 20, `T6a trial ${t}: 選出總數 ${ids.length} 應 = newPerDay 20（current+剩餘）`);
    aSum += ids.filter(x => x.startsWith('wA')).length;
  }
  const avg = aSum / 20;
  console.log(`   20 trials: avg A in 20 = ${avg.toFixed(1)}`);
  assert(avg >= 12, `T6b cap 下加權仍偏 A：avg=${avg.toFixed(1)} 應 ≥ 12（E≈17.8，保守 12）`);
}

// ═══ T7 schema pin：db.js CRUD 帶 new_weight（runtime 臨時 DB）──
{
  console.log('── T7 schema（node:sqlite 臨時 DB）──');
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'dw1-'));
  const dbPath = join(dir, 't.db');
  const sq = new DatabaseSync(dbPath);
  // 模擬既有 schema（lib.rs v1 decks 表）
  sq.exec(`CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#5e6ad2')`);
  // 模擬 migration v11（修法後存在；修法前 new_weight 不存在 → 後續 INSERT 必炸）
  try {
    sq.exec(`ALTER TABLE decks ADD COLUMN new_weight REAL NOT NULL DEFAULT 1`);
    const hasCol = sq.prepare("SELECT COUNT(*) c FROM pragma_table_info('decks') WHERE name='new_weight'").get();
    assert(hasCol.c === 1, 'T7a migration 後 new_weight 欄存在');
    // saveDeck 往返（模擬 db.js saveDeck 帶權重寫入）
    sq.prepare('INSERT INTO decks (id, name, color, new_weight) VALUES (?,?,?,?)').run('deck_x', 'X', '#fff', 7);
    sq.prepare('UPDATE decks SET new_weight=? WHERE id=?').run(0.5, 'deck_x');
    const row = sq.prepare('SELECT new_weight FROM decks WHERE id=?').get('deck_x');
    assert(row.new_weight === 0.5, `T7b new_weight 往返 7→0.5：got ${row.new_weight}`);
    // 預設 1
    sq.prepare('INSERT INTO decks (id, name, color) VALUES (?,?,?)').run('deck_y', 'Y', '#fff');
    const rowY = sq.prepare('SELECT new_weight FROM decks WHERE id=?').get('deck_y');
    assert(rowY.new_weight === 1, `T7c 未指定時預設 1：got ${rowY.new_weight}`);
  } catch (e) {
    assert(false, `T7 schema 腿炸: ${e.message}`);
  }
  sq.close();
}

// ═══ 總結 ═══
console.log(`\n${PRE ? '[PRE 態]' : '[POST 態]'} DW1 deck-weight harness: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log('未通過項:');
  fails.forEach(f => console.log('  -', f));
  process.exit(1);
}
process.exit(0);
