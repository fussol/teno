#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C6 防回歸驗證 — dashboard 同頁「待複習」三處數字必一致（hero/statTile/grid）
//
// 用法: node tools/verify-c6-dashboard-due.mjs
//   期望 ALL PASS（hero == statTile == Σ grid，且語意錨點正確）
// 負控制（/tmp HEAD 副本跑）:
//   node tools/verify-c6-dashboard-due.mjs --expect-legacy
//   期望：hero(=sentinel dueCount) ≠ Σ grid（舊平行實作）bug 實錘
//
// dashboard.render 為純字串函數；svg/chart 以 mock.module 脫除 vite ?raw 依賴。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

mock.module('../src/lib/svg.js', { exports: { icon: () => '<svg></svg>' } });
mock.module('../src/lib/chart.js', {
  exports: { barChart: () => '', lineChart: () => '', pieChart: () => '', pieLegend: () => '' },
});

const { render } = await import('../src/pages/dashboard.js');
const { STATE_LEARNING, STATE_REVIEW } = await import('../src/core/fsrs.js');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', msg); }
}

const T = Date.UTC(2026, 7, 27); // fixed epoch irrelevant; relative to now
const iso = h => new Date(Date.now() + h * 3600e3).toISOString();
const mkWord = (id, deck) => ({ id, word: id, deck, definition: 'd' });
const mkCard = (id, state, dueH) => ({
  wordId: id, state, due: iso(dueH), stability: 10, difficulty: 6,
  elapsedDays: 1, scheduledDays: 10, reps: 5, lapses: 0, step: 0,
  lastReview: iso(-48), buried: false, suspended: false, interval: 10,
});

// ── fixture ──
// deckA: r_early(review due -2h)、r_late1/r_late2（cap 外）、b_r(buried)、s_r(suspended)、
//        lrn(learning due now)、a0(state-0 容器卡，R1#3：cards 內但 scheduler 歸 newQueue)、
//        nA1/nA2(new)
// deckB: 純 new ×2
// cap=1 → review 只收 r_early；cardsPerDay=3 → a0/nA1/nA2 入 due（reviewDueSet 必全剔）
// 期望 reviewDueSet = {r_early, lrn} → 三處皆 2
function makeState() {
  const words = [
    mkWord('r_early', 'A'), mkWord('r_late1', 'A'), mkWord('r_late2', 'A'),
    mkWord('b_r', 'A'), mkWord('s_r', 'A'), mkWord('lrn', 'A'), mkWord('a0', 'A'),
    mkWord('nA1', 'A'), mkWord('nA2', 'A'), mkWord('nB1', 'B'), mkWord('nB2', 'B'),
  ];
  const cards = new Map();
  cards.set('r_early', mkCard('r_early', STATE_REVIEW, -2));
  cards.set('r_late1', mkCard('r_late1', STATE_REVIEW, -1));
  cards.set('r_late2', mkCard('r_late2', STATE_REVIEW, -0.5));
  cards.set('b_r', mkCard('b_r', STATE_REVIEW, -3));
  cards.set('s_r', mkCard('s_r', STATE_REVIEW, -3));
  cards.set('lrn', mkCard('lrn', STATE_LEARNING, 0));
  // state-0 容器卡（跨 mode 評分/undo 承載，store.js:194/323 實錘路徑）
  cards.set('a0', { ...mkCard('a0', 0, -1), mcData: { stability: 5 } });
  const anki = { cardsPerDay: 3, timezoneOffset: null, desiredRetention: 0.9 };
  return {
    words, cards, cardsMc: new Map(), cardsSpell: new Map(),
    decks: [{ name: 'A', color: '#888' }, { name: 'B', color: '#999' }],
    reviewLog: [], retention: { rate: 0, total: 0 },
    buried: new Set(['b_r']), suspended: new Set(['s_r']),
    buriedMc: new Set(), suspendedMc: new Set(), buriedSpell: new Set(), suspendedSpell: new Set(),
    dayCutoff: 0,
    ankiSettings: anki, ankiSettingsMc: { ...anki }, ankiSettingsSpell: { ...anki },
    newRatedToday: 0, newRatedTodayMc: 0, newRatedTodaySpell: 0,
    simParams: { maxReviewsPerDay: 1 }, simParamsMc: { maxReviewsPerDay: 0 }, simParamsSpell: { maxReviewsPerDay: 0 },
    goalStreak: { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } },
    // legacy hero 來源（sentinel 99：舊碼 hero 直接顯示它 → 負控制捕獲點）
    dueCount: 99, dueCountMc: 99, dueCountSpell: 99,
  };
}

const store = { state: makeState(), actions: {} };
const html = render(store);

const EXPECT_LEGACY = process.argv.includes('--expect-legacy');

// ── 三處數字抽取 ──
function extract(html) {
  const hero = [...html.matchAll(/<div class="hero-stat-val"[^>]*>(\d+)<\/div>\s*<div class="hero-stat-lbl">待複習<\/div>/g)].map(m => +m[1]);
  const tile = [...html.matchAll(/<span class="stat-tile-val">(\d+)<\/span>[\s\S]{0,400}?<div class="stat-tile-lbl">待複習<\/div>/g)].map(m => +m[1]);
  const grid = [...html.matchAll(/<div class="deck-card-meta-val" style="color:var\(--rose\)">(\d+)<\/div>\s*<div class="deck-card-meta-lbl">待複習<\/div>/g)].map(m => +m[1]);
  return { hero, tile, grid };
}
const x = extract(html);

assert(x.hero.length === 1, `hero「待複習」恰 1 處: got ${x.hero.length}`);
assert(x.tile.length === 1, `statTile「待複習」恰 1 處: got ${x.tile.length}`);
assert(x.grid.length === 2, `grid「待複習」2 deck 各 1 處: got ${x.grid.length}`);

const gridSum = x.grid.reduce((a, b) => a + b, 0);
if (!EXPECT_LEGACY) {
  // 語意錨點：{r_early, lrn} = 2；cap=1 掉 r_late1/2；buried/suspended 排除；new 不計
  assert(x.hero[0] === 2, `hero 待複習 = 2（cap 後 review 1 + learning 1，new/buried/susp/超cap 排除）: got ${x.hero[0]}`);
  assert(x.tile[0] === 2, `statTile 待複習 = 2: got ${x.tile[0]}`);
  assert(x.grid[0] === 2 && x.grid[1] === 0, `grid deckA=2 deckB=0: got [${x.grid}]`);
  assert(x.hero[0] === x.tile[0] && x.hero[0] === gridSum,
    `三處一致 hero=${x.hero[0]} tile=${x.tile[0]} Σgrid=${gridSum}`);
} else {
  // 舊碼：hero=s.dueCount(sentinel 99)、grid=平行實作 6（含 buried/suspended/超cap/learning、不含 new）
  assert(x.hero[0] === 99, `[legacy] hero 顯示 sentinel dueCount=99（與實際可學脫節）: got ${x.hero[0]}`);
  assert(gridSum === 6, `[legacy] grid 平行實作 = 6（r_early+r_late1+r_late2+b_r+s_r+lrn）: got ${gridSum}`);
  assert(x.hero[0] !== gridSum, `[legacy] hero(99) ≠ Σgrid(${gridSum}) — bug 實錘`);
}

console.log(`\nC6 verify${EXPECT_LEGACY ? ' [legacy 負控制]' : ''}: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
process.exit(fail ? 1 : 0);
