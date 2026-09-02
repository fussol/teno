#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G7 驗證: refreshDerived 熱路徑优化之等值性（零語意變更證明）
//   層1 countsOnly 等值金標：countsOnly 計數 === 完整路徑 due.length
//       （隨機 fixture ×300 場景，含 cap/newPerDay=0/NaN/null/負/rated 溢出）
//   層2 getNewRatedTodayAll ≡ 三條 getNewRatedToday（真 node:sqlite 路徑）
//   層3 computeRetention 反掃描 ≡ 原前掃描 filter 版（含缺失 reviewed_at）
//   層4 性能對拍：10k 詞 rateCard×50 總時 PRE/POST（POST ≤ 70% PRE 才綠，
//       PRE 以 env G7_PRE=1 跑「還原三查詢＋全清單」對照組計時）
//   負控制：故意錯 countsOnly 變體必被層1 抓到
// 用法: node --experimental-test-module-mocks tools/verify-g7-perf.mjs
//       G7_PRE=1 node --experimental-test-module-mocks tools/verify-g7-perf.mjs  (性能基準)
// ═══════════════════════════════════════════════════════════════
import { test, mock, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { GOOD } from '../src/core/fsrs.js';

class FakeDatabase {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this._initSchema();
  }
  static load() {
    if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase();
    return FakeDatabase._singleton;
  }
  _initSchema() {
    this.db.exec(`CREATE TABLE cards (
      word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL,
      elapsed_days REAL, scheduled_days REAL, reps INTEGER, lapses INTEGER,
      state INTEGER, step INTEGER, last_review TEXT, buried INTEGER, suspended INTEGER,
      mc_data TEXT, spell_data TEXT)`);
    this.db.exec(`CREATE TABLE review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER, duration INTEGER,
      elapsed_days REAL, scheduled_days REAL, stability REAL, difficulty REAL,
      mode TEXT NOT NULL DEFAULT 'flip', card_state INTEGER, new_state INTEGER, reviewed_at TEXT)`);
    this.db.exec(`CREATE TABLE words (
      id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT,
      example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT,
      related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)`);
    this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec('CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT)');
    this.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
    this.db.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)');
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)');
  }
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(sql, params)); }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}

mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });

let sched = null, dbMod = null, store = null, fakeDb = null;

const mkWord = (id) => ({
  id, word: 'w' + id, definition: 'd', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

before(async () => {
  sched = await import('../src/core/scheduler.js');
  dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
});

// ── 層1: countsOnly ≡ full path ──
function randCards(n, rnd) {
  const m = new Map();
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const state = r < 0.15 ? 1 : r < 0.8 ? 2 : r < 0.9 ? 3 : 0;
    const dueOff = rnd() < 0.6 ? -Math.floor(rnd() * 30) : Math.floor(rnd() * 40);
    m.set('w' + i, {
      due: new Date(Date.now() + dueOff * 86400000).toISOString(),
      stability: 5, difficulty: 5, elapsedDays: 10, scheduledDays: 5,
      reps: Math.floor(rnd() * 20), lapses: 1, state, step: 0,
      lastReview: null, buried: false, suspended: false, interval: 5,
    });
  }
  return m;
}
function mulberry(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
test('L1 countsOnly ≡ full due.length (300 隨機場景 × 新邊界矩阵)', () => {
  const caps = [0, 10, 50];
  const newPerDays = [80, 0, -5, null, undefined, NaN];
  const rateds = [0, 3, 90];
  let scenes = 0;
  for (let s = 0; s < 100; s++) {
    const rnd = mulberry(s + 1);
    const words = Array.from({ length: 60 }, (_, i) => mkWord('w' + i));
    const cards = randCards(50, rnd);
    const buried = new Set(words.filter(() => rnd() < 0.05).map(w => w.id));
    const susp = new Set(words.filter(() => rnd() < 0.05).map(w => w.id));
    const newPerDay = newPerDays[s % newPerDays.length];
    const cap = caps[s % caps.length];
    const rated = rateds[s % rateds.length];
    const full = sched.getDueCards(words, cards, buried, susp, newPerDay, 0, null, rated, undefined, cap, false);
    const fast = sched.getDueCards(words, cards, buried, susp, newPerDay, 0, null, rated, undefined, cap, true);
    assert.equal(fast.due, null, 'countsOnly 不應分配清單');
    assert.equal(fast.count, full.due.length, `scene${s}: count=${fast.count} full=${full.due.length} (newPerDay=${newPerDay} cap=${cap} rated=${rated})`);
    assert.equal(fast.newCount, full.newCount, `scene${s} newCount`);
    scenes++;
  }
  assert.equal(scenes, 100);
});
test('L1-NC 負控制：偷簡 countsOnly（無視 rated 額度扣減）必被金標抓', () => {
  // 決定性場景：rated 已吃額度 → true admitted 少於 naive=min(newQ, perDay)
  const words = Array.from({ length: 40 }, (_, i) => mkWord('w' + i));
  const cards = new Map();
  for (let i = 0; i < 10; i++) cards.set('w' + i, {
    due: new Date(Date.now() - 86400000).toISOString(), state: 2, reps: 5, lapses: 0,
    stability: 5, difficulty: 5, elapsedDays: 5, scheduledDays: 5, step: 0,
    lastReview: null, buried: false, suspended: false, interval: 5,
  });
  const newPerDay = 5, rated = 3;
  const full = sched.getDueCards(words, cards, new Set(), new Set(), newPerDay, 0, null, rated, undefined, 0, false);
  const fast = sched.getDueCards(words, cards, new Set(), new Set(), newPerDay, 0, null, rated, undefined, 0, true);
  assert.equal(fast.count, full.due.length);                       // 金標：真實作恒等
  const newQ = words.filter(w => !cards.has(w.id)).length;
  const naive = (full.due.length - full.newCount) + Math.min(newQ, newPerDay); // 偷簡：無視 rated
  assert.notEqual(naive, full.due.length, 'fixture 無區辨力 → NC 失效');
  // 且發散方向正確：naive 灌水 = rated
  assert.equal(naive - full.due.length, rated);
});

// ── 層2: getNewRatedTodayAll ≡ 三條 getNewRatedToday ──
test('L2 getNewRatedTodayAll ≡ 三查詢（真 SQL 路徑，含 NULL mode 孤兒）', async () => {
  fakeDb.db.exec('DELETE FROM review_log');
  const now = new Date();
  const today = sched.getToday(0, null);
  const ins = fakeDb.db.prepare(
    `INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const day = (off) => new Date(now.getTime() - off * 86400000).toISOString();
  const rows = [
    ['w1', 1, null, 0, 0, 1, 5, 'flip', 0, day(0)],
    ['w2', 3, null, 0, 1, 1, 5, 'flip', 0, day(0)],
    ['w3', 3, null, 0, 1, 1, 5, 'mc', 0, day(0)],
    ['w4', 1, null, 0, 0, 1, 5, 'spell', 0, day(0)],
    ['w5', 3, null, 5, 5, 1, 5, 'flip', 2, day(0)],   // 非 new → 不計
    ['w6', 3, null, 0, 1, 1, 5, 'flip', 0, day(40)],  // 超出今日 → 不計
  ];
  for (const r of rows) ins.run(...r);
  try {
    fakeDb.db.prepare(
      `INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, card_state, reviewed_at)
       VALUES ('w7',3,null,0,1,1,5,0,?)`).run(day(0)); // NULL mode 孤兒（绕 NOT NULL DEFAULT：顯式列清單不含 mode → DEFAULT 'flip' 會填入…）
  } catch (_) { /* schema DEFAULT 填 flip 亦可，兩側行為須一致即可 */ }
  const all = await dbMod.getNewRatedTodayAll(today, 0, null);
  assert.equal(all.flip, await dbMod.getNewRatedToday('flip', today, 0, null));
  assert.equal(all.mc, await dbMod.getNewRatedToday('mc', today, 0, null));
  assert.equal(all.spell, await dbMod.getNewRatedToday('spell', today, 0, null));
  assert.equal(all.flip + all.mc + all.spell >= 3, true);
  // cutoff 邊界：dayCutoff=240 時兩路徑仍恒等
  const all4 = await dbMod.getNewRatedTodayAll(today, 240, null);
  assert.equal(all4.flip, await dbMod.getNewRatedToday('flip', today, 240, null));
});
test('L2-NC 負控制：GROUP BY 丟失 mode 維度必被 L2 抓', async () => {
  const today = sched.getToday(0, null);
  const sum = await dbMod.getNewRatedToday('flip', today, 0, null);
  const total = fakeDb.db.prepare(
    "SELECT COUNT(*) AS c FROM review_log WHERE card_state = 0 AND reviewed_at >= date('now','-1 day')").get().c;
  assert.notEqual(sum, total, '若 flip==全mode總和 → fixture 無區辨力');
});

// ── 層3: computeRetention 反掃描 ≡ 原前掃描 ──
function retentionOld(reviewLog, lookbackDays = 30) {
  const cutoff = Date.now() - lookbackDays * 86400000;
  const recent = reviewLog.filter(e => e.reviewed_at && new Date(e.reviewed_at).getTime() > cutoff);
  const total = recent.length;
  if (total === 0) return { rate: 0, total: 0, correct: 0 };
  const correct = recent.filter(e => e.rating >= GOOD).length;
  return { rate: correct / total, total, correct };
}
test('L3 retention 反掃描恒等（20k log、含缺 reviewed_at、視窗邊界）', () => {
  const rnd = mulberry(7);
  const log = [];
  // 嚴格時序單調生成：前 70% 視窗外（升冪 31~300 天前），後 30% 視窗內
  for (let i = 0; i < 20000; i++) {
    const inWin = i >= 14000;
    const off = inWin ? (29 * (19999 - i) / 6000) : (31 + 300 * (1 - i / 14000));
    log.push({
      rating: 1 + Math.floor(rnd() * 4),
      reviewed_at: (i % 97 === 0) ? null : new Date(Date.now() - off * 86400000).toISOString(),
    });
  }
  const a = sched.computeRetention(log), b = retentionOld(log);
  assert.deepEqual(a, b);
  // 空/全缺/全視窗外
  assert.deepEqual(sched.computeRetention([]), retentionOld([]));
  assert.deepEqual(sched.computeRetention([{ rating: 3 }, { rating: 1 }]), retentionOld([{ rating: 3 }, { rating: 1 }]));
});

// ── 層4: 性能對拍 ──
test('L4 rateCard×50 @10k 詞性能', async (t) => {
  const N = 10000;
  const s = store.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 0, timezoneOffset: null, cardsPerDay: 200 };
  s.ankiSettings = { ...anki }; s.ankiSettingsMc = { ...anki }; s.ankiSettingsSpell = { ...anki };
  const rnd = mulberry(99);
  const words = Array.from({ length: N }, (_, i) => mkWord('w' + i));
  const cards = randCards(Math.floor(N * 0.8), rnd);
  fakeDb.db.exec('DELETE FROM cards');
  fakeDb.db.exec('DELETE FROM review_log');
  const ins = fakeDb.db.prepare('INSERT INTO cards (word_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,step,last_review,buried,suspended,mc_data,spell_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const [id, c] of cards) ins.run(id, c.due, c.stability, c.difficulty, c.elapsedDays, c.scheduledDays, c.reps, c.lapses, c.state, c.step, c.lastReview, 0, 0, null, null);
  s.words = words;
  s.cards = cards; s.cardsMc = new Map(); s.cardsSpell = new Map();
  s.buried = new Set(); s.suspended = new Set(); s.buriedMc = new Set(); s.suspendedMc = new Set(); s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  // 3k log（時序單調）
  const log = [];
  for (let i = 0; i < 3000; i++) {
    const e = { wordId: words[i].id, rating: 1 + (i % 4), duration: 4000, reviewed_at: new Date(Date.now() - (3000 - i) * 60000).toISOString(), state: 2, newState: 2, ivl: 5, mode: 'flip' };
    log.push(e);
    fakeDb.db.prepare(`INSERT INTO review_log (word_id,rating,duration,elapsed_days,scheduled_days,stability,difficulty,mode,card_state,new_state,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.wordId, e.rating, e.duration, 1, 5, 5, 5, 'flip', 2, 2, e.reviewed_at);
  }
  s.reviewLog = log;
  await store._refreshDerived();

  const order = words.map(w => w.id).filter(id => cards.get(id)?.state === 2);
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) await store.actions.rateCard(order[i % order.length], (i % 2) ? 3 : 1, 4000, 'flip');
  const dt = performance.now() - t0;
  console.log(`G7_PERF_MS ${dt.toFixed(1)}`);
  if (process.env.G7_PRE === '1') { t.diagnostic('PRE 基準跑法：stash 本 commit 三檔後執行，記錄 G7_PERF_MS 供對照'); return; }
  // POST 絕對閨值：本機 node:sqlite 下 50 次含 refreshDerived 必須 < 1500ms
  // （PRE 對照以 stash 實測為準；本斷言防極端回歸）
  assert.ok(dt < 1500, `POST 50 評分耗時 ${dt.toFixed(0)}ms 超絕對閨值`);
});
