#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G4 防回歸驗證 — _totalRated 無人寫入 → 成就永不觸發
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-g4-total-rated.mjs
//       → 修法後（incrementGoal 累加 _totalRated）ALL PASS
//
// 負控制原理: harness 測「真實 store.js」——若未修（incrementGoal 不寫 _totalRated），
//   _rated 永遠不變 → T1/T2/T3 自然 FAIL。接 real createStore + init。
// 真實度（沿用 C3）: mock @tauri/plugin-sql(FakeDatabase)+api/core+main.js, 其餘全真實。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

let failures = 0;
function check(label, got, expect) {
  const pass = String(got) === String(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

// ── localStorage mock（node 無此全域；_rated 只會被 store 寫）──
let _rated = '0';
globalThis.localStorage = {
  getItem: (k) => (k === '_totalRated' ? _rated : null),
  setItem: (k, v) => { if (k === '_totalRated') _rated = String(v); },
  removeItem: () => {},
};

// ── FakeDatabase（plugin-sql 替身：與 C3 harness 同款完整 schema，node:sqlite in-memory）──
// 單例：db.js Database.load 都拿同個實例
class FakeDatabase {
  static load() { if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase(); return FakeDatabase._singleton; }
  constructor() { this.db = new DatabaseSync(':memory:'); this._initSchema(); }
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
    const obj = {}; for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i]; return obj;
  }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(sql, params)); }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

async function main() {
  const dbMod = await import('../src/lib/db.js');
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  const store = createStore();
  await store.actions.init();
  const { getToday } = await import('../src/core/scheduler.js');

  store.state.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  store.state.dayCutoff = 0;
  store.state.ankiSettings = { timezoneOffset: null };
  store.state.ankiSettingsMc = { timezoneOffset: null };
  store.state.ankiSettingsSpell = { timezoneOffset: null };

  console.log('── G4 _totalRated 累加（真實 store.js）──');

  // T1 初值 '0' → 一次評分(flip) → 1
  _rated = '0';
  await store.actions.incrementGoal('flip');
  check('T1 初值0 一次評分 → _totalRated=1', _rated, '1');

  // T2 三模式各一次 → 3
  _rated = '0';
  await store.actions.incrementGoal('flip');
  await store.actions.incrementGoal('mc');
  await store.actions.incrementGoal('spell');
  check('T2 三模式3次 → _totalRated=3', _rated, '3');

  // T3 既有值 17 → 累加非覆寫 → 18
  _rated = '17';
  await store.actions.incrementGoal('flip');
  check('T3 既有17 → 累加 → 18', _rated, '18');

  // T4 streak 既有行為不變: dates.flip 計入今天
  const gs = store.state.goalStreak;
  const today = getToday(0, null);
  check('T4 goalStreak.dates.flip 含 today', gs.dates.flip.includes(today), true);

  // T5 無 localStorage（負向）→ incrementGoal 不 throw（try/catch 隔離）
  const savedLS = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    await store.actions.incrementGoal('flip');
    check('T5 無 localStorage → 不 throw', true, true);
  } catch (e) {
    check('T5 無 localStorage → 不 throw', false, true);
  }
  globalThis.localStorage = savedLS;

  // T6 污染值（非數字）→ Number.isFinite 防護 → 得 1
  _rated = 'abc';
  await store.actions.incrementGoal('flip');
  check('T6 NaN 污染 abc → _totalRated=1', _rated, '1');

  console.log(`\n結果: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERR', e); process.exit(2); });