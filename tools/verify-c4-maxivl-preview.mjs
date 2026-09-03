#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C4 防回歸驗證 — 學習頁 interval 預覽必須套用 store maxIvl 上限
//
// 用法: node --experimental-test-module-mocks tools/verify-c4-maxivl-preview.mjs
// 期望: 全部 PASS（exit 0）；任何 FAIL → exit 1
//
// mock 環境三件套比照 C3 harness（FakeDatabase / invoke / toast），
// store + Session + FSRS + 三 utils 全真實。
//
// 負控制：
//   T6a 直構 FSRS 不傳第 4 參（舊 makeFSRS 行為）→ 同一 mature state
//       預覽 >365 精準重現
//   T6b 真實 Session 的 fsrs.maximumInterval 還原成 36500（模擬舊碼）
//       → 真實 computeIntervals 顯示突破上限
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FSRS, AGAIN, HARD, GOOD, EASY, STATE_REVIEW } from '../src/core/fsrs.js';

// easter-eggs（flip rateCard 呼叫鏈）在 node 沒有 localStorage
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
// store.actions.init 的 seedIfEmpty 會 fetch('/seed-data.csv')（瀏覽器相對路徑）—
// node 下必然 Invalid URL、store 已 catch；stub 掉消噪音，不影響本測試斷言
globalThis.fetch = async () => ({ ok: false });
// loadAll 內 window.__maxExampleLines / addEventListener 等 — node 無 window，別名 stub 讓 init 走完
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', msg); }
}

// ── FakeDatabase（同 C3 harness：db.js Database.load 單例 → node:sqlite in-memory）──
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
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT, decks TEXT)');
    this.db.exec(`CREATE TABLE additions (
      id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT,
      example TEXT, tags TEXT, image TEXT, description TEXT, added_at TEXT)`);
    this.db.exec(`CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, mode TEXT,
      correct INTEGER, wrong INTEGER, question_type TEXT, examined_at TEXT)`);
    this.db.exec(`CREATE TABLE exam_sessions (id TEXT PRIMARY KEY, mode TEXT, data TEXT, updated_at TEXT)`);
    this.db.exec(`CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT,
      max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)`);
    this.db.exec(`CREATE TABLE app_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, msg TEXT)`);
    this.db.exec(`CREATE TABLE sim_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, data TEXT)`);
  }
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {};
    for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i];
    return obj;
  }
  async execute(sql, params = []) {
    // app-log prune 等用 '?' Positional；db.js 主體用 '$1' Named — 雙軌支援
    if (sql.includes('?')) await this.db.prepare(sql).run(...params);
    else await this.db.prepare(sql).run(this._bind(sql, params));
    return { rowsAffected: 1, lastInsertId: 0 };
  }
  async select(sql, params = []) {
    if (sql.includes('?')) return this.db.prepare(sql).all(...params);
    return this.db.prepare(sql).all(this._bind(sql, params));
  }
  async close() { this.db.close(); }
}

mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

// ── fixtures ──
const mkWord = id => ({
  id, word: id, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});
// mature review 卡：stability=900 → GOOD raw interval ≈900 天，遠超任何 cap（bug 敏感）
const mkMature = id => ({
  wordId: id, due: new Date(Date.now() - 3600e3).toISOString(),
  stability: 900, difficulty: 7, elapsedDays: 30, scheduledDays: 30,
  reps: 20, lapses: 2, state: STATE_REVIEW, step: 0,
  lastReview: new Date(Date.now() - 30 * 86400e3).toISOString(),
  buried: false, suspended: false, interval: 30,
});
// formatInterval 逆解析回天數（'500m'/'45d'/'3.2mo'/'2.5y'）
function parseDays(s) {
  if (s == null || s === '') return null;
  if (s.endsWith('mo')) return parseFloat(s) * 30;
  if (s.endsWith('y')) return parseFloat(s) * 365;
  if (s.endsWith('d')) return parseInt(s, 10);
  if (s.endsWith('m')) return parseInt(s, 10) / 1440;
  return null;
}
const BASE_ANKI = {
  fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10',
  relearnSteps: '10', leechThreshold: 8, timezoneOffset: null, cardsPerDay: 80,
  reviewMix: 2, learnAheadLimit: 20,
};
// REVIEW 卡 GOOD 評分的中性 steps（分鐘制 → 天，本測試不觸及學習分支）
const LS = [1 / 1440, 10 / 1440], RL = [10 / 1440];
function resetStoreState(s) {
  s.dayCutoff = 0;
  s.ankiSettings = { ...BASE_ANKI };
  s.ankiSettingsMc = { ...BASE_ANKI };
  s.ankiSettingsSpell = { ...BASE_ANKI };
  s.words = [mkWord('wM')];
  s.cards = new Map([['wM', mkMature('wM')]]);
  s.cardsMc = new Map([['wM', mkMature('wM')]]);
  s.cardsSpell = new Map([['wM', mkMature('wM')]]);
  s.buried = new Set();
  s.suspended = new Set();
  s.reviewLog = [];
  s.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  s.newRatedToday = 0;
  s.newRatedTodayMc = 0;
  s.newRatedTodaySpell = 0;
}

// 四顆按鈕全部解析回天數（AGAIN 對 mature 卡可能落 learning step → null/小值，只收 >1 天者檢查 cap）
function overCap(ivObj, cap) {
  const bad = [];
  for (const r of [AGAIN, HARD, GOOD, EASY]) {
    const d = parseDays(ivObj[r]);
    if (d != null && d > cap + 0.5) bad.push(`${r}=${d}d`);
  }
  return bad;
}

async function main() {
  // ── T0 靜態斷言：三 utils 檔的修法在場 ──
  for (const f of ['session-utils.js', 'session-mc-utils.js', 'session-spell-utils.js']) {
    const src = readFileSync(new URL(`../src/engine/${f}`, import.meta.url), 'utf8');
    const m = src.match(/function makeFSRS\(as\) \{([\s\S]*?)\n\}/);
    assert(!!m, `T0 ${f}: makeFSRS 存在`);
    if (m) assert(/Math\.max\(1,\s*as\?\.maxIvl \?\? 365\)/.test(m[1]), `T0 ${f}: makeFSRS 傳第 4 參 maxIvl`);
    assert(/session\.fsrs\.maximumInterval = Math\.max\(1,\s*storeState\.ankiSettings(Mc|Spell)?\?\.maxIvl \?\? 365\)/.test(src),
      `T0 ${f}: ensureQueue live sync 行在場`);
    assert(!/session\._maxIvl\s*=/.test(src), `T0 ${f}: 死代碼 _maxIvl 已移除`);
  }

  const dbMod = await import('../src/lib/db.js');
  const fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  const store = createStore();
  await store.actions.init();
  resetStoreState(store.state);

  const flip = await import('../src/engine/session-utils.js');
  const mc = await import('../src/engine/session-mc-utils.js');
  const spell = await import('../src/engine/session-spell-utils.js');

  // ── T1 flip e2e：預設 maxIvl=365 → cap 365、預覽不突破 ──
  flip.ensureSession(store.state);
  assert(!!flip.session, 'T1 flip session 建立');
  assert(flip.session.fsrs.maximumInterval === 365, `T1 makeFSRS 第 4 參生效: got=${flip.session.fsrs.maximumInterval} expect=365`);
  assert(flip.ensureQueue(undefined, store.state) === true, 'T1 flip ensureQueue 有卡');
  const iv1 = flip.session.computeIntervals('wM');
  const g1 = parseDays(iv1[GOOD]);
  assert(g1 !== null && g1 > 100, `T1 GOOD 預覽為大值（mature 卡存在）: ${iv1[GOOD]}`);
  assert(g1 <= 365, `T1 GOOD 預覽 ≤365: got=${g1}`);
  assert(overCap(iv1, 365).length === 0, `T1 四顆全部 ≤365: ${overCap(iv1, 365)}`);

  // ── T2 mc e2e：maxIvl=100 → cap 100 ──
  store.state.ankiSettingsMc.maxIvl = 100;
  mc.ensureSession(store.state);
  assert(mc.session.fsrs.maximumInterval === 100, `T2 makeFSRS mc cap: got=${mc.session.fsrs.maximumInterval} expect=100`);
  mc.ensureQueue(undefined, store.state);
  const iv2 = mc.session.computeIntervals('wM');
  assert(overCap(iv2, 100).length === 0, `T2 mc 四顆全部 ≤100: ${overCap(iv2, 100)}`);
  assert(overCap(iv2, 300).length === 0 && parseDays(iv2[GOOD]) > 50, `T2 mc GOOD 有意義大值: ${iv2[GOOD]}`);

  // ── T3 live sync：session 建立後改設定 → ensureQueue 同步 cap（含 0/undefined 退化）──
  store.state.ankiSettings.maxIvl = 50;
  flip.session.running = false; flip.session.results = [];
  flip.ensureQueue(undefined, store.state);
  assert(flip.session.fsrs.maximumInterval === 50, `T3a 改 50 即時生效: got=${flip.session.fsrs.maximumInterval}`);
  store.state.ankiSettings.maxIvl = 0;
  flip.session.running = false; flip.session.results = [];
  flip.ensureQueue(undefined, store.state);
  assert(flip.session.fsrs.maximumInterval === 1, `T3b maxIvl=0 → clamp 1: got=${flip.session.fsrs.maximumInterval}`);
  delete store.state.ankiSettings.maxIvl;
  flip.session.running = false; flip.session.results = [];
  flip.ensureQueue(undefined, store.state);
  assert(flip.session.fsrs.maximumInterval === 365, `T3c maxIvl 缺失 → 365: got=${flip.session.fsrs.maximumInterval}`);
  store.state.ankiSettings.maxIvl = 365;
  flip.session.running = false; flip.session.results = [];
  flip.ensureQueue(undefined, store.state);

  // ── T4 spell e2e：預設 cap 365 ──
  spell.ensureSession(store.state);
  assert(spell.session.fsrs.maximumInterval === 365, `T4 spell cap: got=${spell.session.fsrs.maximumInterval}`);
  spell.ensureQueue(undefined, store.state);
  assert(overCap(spell.session.computeIntervals('wM'), 365).length === 0, 'T4 spell 四顆全部 ≤365');
  // ── T5 flip e2e 作答：預覽上限 = 存檔上限（真實 rateCard → cards/DB）──
  flip.flipCard(() => {});
  const previewGood = parseDays(flip.intervals[GOOD]);
  await flip.rateCard(store, GOOD, () => {});
  const saved = store.state.cards.get('wM');
  assert(saved.scheduledDays <= 365, `T5 存檔 scheduledDays ≤365: got=${saved.scheduledDays}`);
  assert(Math.abs(saved.scheduledDays - previewGood) <= 3,
    `T5 預覽(${previewGood}) 與存檔(${saved.scheduledDays}) 一致（±3 fuzz/LB）`);
  const dbRow = fakeDb.db.prepare('SELECT scheduled_days FROM cards WHERE word_id = ?').get('wM');
  assert(dbRow.scheduled_days <= 365, `T5 DB scheduled_days ≤365: got=${dbRow.scheduled_days}`);

  // ── T6 負控制 ──
  // T6a：舊 makeFSRS 行為（不傳第 4 參）→ 同 mature state 預覽突破 365/100
  const fsrsOld = new FSRS(null, 0.9, true);
  assert(fsrsOld.maximumInterval === 36500, `T6a 舊構造預設 cap=36500: got=${fsrsOld.maximumInterval}`);
  const cs = {
    stability: 900, difficulty: 7, state: STATE_REVIEW, reps: 20, lapses: 2,
    step: 0, elapsedDays: 30, scheduledDays: 30,
  };
  const rOld = fsrsOld.review({ ...cs }, GOOD, 0.5, LS, RL, null);
  assert(rOld.dueDays > 365, `T6a bug 重現：無第 4 參 GOOD=${rOld.dueDays} > 365`);
  const rOld100 = new FSRS(null, 0.9, true).review({ ...cs }, GOOD, 0.5, LS, RL, null);
  assert(rOld100.dueDays > 100, `T6a bug 重現（mc cap=100 情境）: ${rOld100.dueDays} > 100`);
  // 修法構造同 state → ≤365（紅燈轉綠對照）
  const rFix = new FSRS(null, 0.9, true, 365).review({ ...cs }, GOOD, 0.5, LS, RL, null);
  assert(rFix.dueDays <= 365 && rFix.dueDays > 300, `T6a 對照：第 4 參=365 → ${rFix.dueDays} ∈ (300,365]`);
  const rFix100 = new FSRS(null, 0.9, true, 100).review({ ...cs }, GOOD, 0.5, LS, RL, null);
  assert(rFix100.dueDays <= 100 && rFix100.dueDays > 50, `T6a 對照：第 4 參=100 → ${rFix100.dueDays} ∈ (50,100]`);
  // T6b：真實 Session 把 cap 還原 36500（模擬舊碼全鏈路）→ computeIntervals 突破
  const realFsrs = spell.session.fsrs;
  spell.session.fsrs = new FSRS(null, 0.9, true); // 無第 4 參 = 舊 makeFSRS 原樣
  const ivBug = spell.session.computeIntervals('wM');
  assert(overCap(ivBug, 365).length > 0,
    `T6b bug 重現（全鏈路）：舊 FSRS 下預覽突破 365 → ${JSON.stringify(ivBug)}`);
  spell.session.fsrs = realFsrs; // 復原
  const ivBack = spell.session.computeIntervals('wM');
  assert(overCap(ivBack, 365).length === 0, 'T6b 復原後再次 ≤365（紅轉綠閉環）');

  // 防呆：確保 bug 情境不是「卡片太小」造成（negative control 的 negative control）
  assert(g1 > 300, `防呆：mature 卡 raw 區間應遠超 cap（T1 got=${g1}，cap 生效下仍 >300）`);

}

main().then(() => {
  console.log(`\nC4 verify: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });

