#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C9 防回歸驗證 — incrementGoal fire-and-forget → undo 的 goal 還原被 in-flight 覆寫
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-c9-goal-undo-race.mjs
//       → 修法後期望（undo 前排空 goal 增量、DB 幽靈封堵）ALL PASS
//   node --experimental-test-module-mocks tools/verify-c9-goal-undo-race.mjs --expect-legacy
//       → 未修負控制（undo 還原後 increment 後落覆寫 DB）ALL PASS
//
// 確定性設計（非時間擡測）：
//   閘門放在 **db.saveGoalStreak** 層（mock.module db.js 透包裝）——
//   記憶體同步段（dates push / 快照捕獲）與生產逐字同序，只有 DB 寫入落地受閘門控制。
//   W1(increment 含 today) 掛起 → undo 進場 → 放閘 → 落序受控、终態确定。
//   主斷言双面：記憶體 goalStreak.dates + **goal_streak 表直讀**（幽靈＝重啟回靈機制本體）。
//   harness 餘同 C8（FakeDatabase + invoke/main.js mock + jsdom + 真 store/engine）。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { STATE_NEW } from '../src/core/fsrs.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const LEGACY = process.argv.includes('--expect-legacy');

const { JSDOM } = await import('jsdom');
let dom = null;
function mkDoc() {
  dom = new JSDOM('<!doctype html><html><body><div id="pageContainer"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
}
mkDoc();

let failures = 0;
function check(label, got, expect) {
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));
const flush = () => new Promise(r => setTimeout(r, 10));
function pressUndo() {
  globalThis.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
}

// ── FakeDatabase（C3/C7/C8 同型）──
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
    this.db.exec('CREATE TABLE additions (id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, added_at TEXT)');
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
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

// ── C9 閘門層：透包裝 db.saveGoalStreak（記憶體同步段保真，只有落地受控）──
const realDb = await import('../src/lib/db.js');
const goalWrites = [];               // 入口同步記 payload 快照（序列化定值）
let goalGates = [];                  // FIFO 捕捉佇列：每筆呼叫至多綁一個閘
function mkGate() { let r; const p = new Promise(res => { r = res; }); return { p, res: r }; }
mock.module('../src/lib/db.js', {
  exports: {
    ...realDb,
    saveGoalStreak(data) {
      // payload 於**呼叫時刻**深拷貝快照＝生產 db.js:600-608 參數（JSON.stringify）在
      // execute 掛起前已定值之語意——閘後落地不受後續 state 突變回溯污染（忠實競態模型）。
      const payload = JSON.parse(JSON.stringify(data));
      goalWrites.push(JSON.parse(JSON.stringify(payload.dates || {})));
      const g = goalGates.shift();
      return (g ? g.p : Promise.resolve()).then(() => realDb.saveGoalStreak(payload));
    },
  },
});

const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});
const mkNewCard = (id) => ({
  due: new Date(Date.now() - 60000).toISOString(), stability: 0, difficulty: 5,
  elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: STATE_NEW, step: 0,
  lastReview: null, buried: false, suspended: false, interval: 0, wordId: id,
});

let store = null, fakeDb = null;
const undoCalls = [];                // store.actions.undoLastRating 入口 spy（同步 push）
const rateCalls = [];                // store.actions.rateCard 入口 spy（T8：drain 期間鎖覆蓋鑑別）
function openGoalGate() { const g = mkGate(); goalGates.push(g); return g; }

async function resetState() {
  mkDoc();
  const s = store.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: null, cardsPerDay: 80, reviewMix: 2, learnAheadLimit: 20 };
  s.ankiSettings = { ...anki };
  s.ankiSettingsMc = { ...anki };
  s.ankiSettingsSpell = { ...anki };
  s.words = ['wA', 'wB', 'wC'].map((id, i) => mkWord(id, ['alpha', 'bravo', 'charlie'][i]));
  s.cards = new Map();
  s.cardsMc = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.cardsSpell = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.reviewLog = [];
  s.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  s.newRatedToday = 0; s.newRatedTodayMc = 0; s.newRatedTodaySpell = 0;
  goalGates = []; goalWrites.length = 0; undoCalls.length = 0; rateCalls.length = 0;
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}
const memLen = (mode) => (store.state.goalStreak.dates?.[mode] || []).length;
function dbGoalDates() {
  const row = fakeDb.db.prepare('SELECT dates FROM goal_streak WHERE id=1').get();
  return row ? JSON.parse(row.dates) : {};
}
const dbLen = (mode) => (dbGoalDates()?.[mode] || []).length;
const logN = (mode) => store.state.reviewLog.filter(l => (l.mode || 'flip') === mode).length;
async function rateCurrent(u, rating, mode) {
  if (u.state === 'QUESTION') {
    if (mode === 'mc') u.pickAnswer(0);
    else if (mode === 'spell') u.submitAnswer('xyz');
    else u.flipCard(() => {});
  }
  await u.rateCard(store, rating, () => {});
}

async function main() {
  fakeDb = await FakeDatabase.load();
  await realDb.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
  const _undo = store.actions.undoLastRating.bind(store.actions);
  store.actions.undoLastRating = (mode = 'flip') => { undoCalls.push(mode); return _undo(mode); };
  const _rate = store.actions.rateCard.bind(store.actions);
  store.actions.rateCard = (...a) => { rateCalls.push(a[0] + ':' + a[3]); return _rate(...a); };
  await resetState();

  console.log(`\n═══ C9 goal 幽靈覆寫（${LEGACY ? '負控制：舊碼 bug 必須精準重現' : '修法後'}）═══`);

  // ── T1 flip 主鏈路：評 A（W1 掛起）→ Ctrl+Z → 放閘 → 幽靈判定 ──
  const fl = await import('../src/engine/session-utils.js?c9t1');
  fl.ensureSession(store.state);
  fl.ensureQueue(undefined, store.state);
  fl.mount(store, 's4FlipBtn', () => {});
  const g1 = openGoalGate();
  await rateCurrent(fl, 2, 'flip');
  check('T1 記憶體同步計入今日（行為保真：兩態=1）', memLen('flip'), 1);
  check('T1 goal 寫入已被閘捕捉', goalWrites.length, 1);
  check('T1 放閘前 DB 未落地', dbLen('flip'), 0);
  const u0 = undoCalls.length;
  pressUndo(); await flush();
  check('T1 in-flight 窗口 undo 直進 store（修前=1 修後=0）', undoCalls.length - u0, LEGACY ? 1 : 0);
  g1.res();                           // 放閘：LEGACY＝W1 後落覆寫；FIXED＝W1 落地後 undo 才續跑
  await tick();
  check('T1 記憶體 undo 還原（兩態=0）', memLen('flip'), 0);
  check('T1 DB 幽靈（修前=1 修後=0）', dbLen('flip'), LEGACY ? 1 : 0);

  // ── T2 回歸釘（兩態恆綠）：無閘 評分→undo 正常、log/goal/鎖三淨 ──
  await resetState();
  const fl2 = await import('../src/engine/session-utils.js?c9t2');
  fl2.ensureSession(store.state);
  fl2.ensureQueue(undefined, store.state);
  fl2.mount(store, 's4FlipBtn', () => {});
  await rateCurrent(fl2, 2, 'flip'); await tick();
  check('T2 無閘評分 goal 落地', dbLen('flip'), 1);
  const l2 = logN('flip');
  pressUndo(); await tick();
  check('T2 undo 觸發', undoCalls.length, 1);
  check('T2 log 淨 0', logN('flip'), 0);
  check('T2 DB 還原 0（增量已先行落地）', dbLen('flip'), 0);
  await rateCurrent(fl2, 2, 'flip');   // 鎖未死：undo 後可再評
  check('T2 undo 後再評不被鎖吞', logN('flip'), 1);

  // ── T3 mc 同構 ──
  await resetState();
  const mc = await import('../src/engine/session-mc-utils.js?c9t3');
  mc.ensureSession(store.state);
  mc.ensureQueue(undefined, store.state);
  mc.mount(store, () => {});
  const g3 = openGoalGate();
  await rateCurrent(mc, 2, 'mc');
  check('T3 mc 記憶體同步計入（兩態=1）', memLen('mc'), 1);
  const u3 = undoCalls.length;
  pressUndo(); await flush();
  check('T3 mc in-flight undo 直進（修前=1 修後=0）', undoCalls.length - u3, LEGACY ? 1 : 0);
  g3.res();
  await tick();
  check('T3 mc DB 幽靈（修前=1 修後=0）', dbLen('mc'), LEGACY ? 1 : 0);
  check('T3 flip 隔離不受染', memLen('flip') + dbLen('flip'), 0);

  // ── T4 spell 同構 ──
  await resetState();
  const sp = await import('../src/engine/session-spell-utils.js?c9t4');
  sp.ensureSession(store.state);
  sp.ensureQueue(undefined, store.state);
  sp.mount(store, () => {});
  const g4 = openGoalGate();
  await rateCurrent(sp, 2, 'spell');
  check('T4 spell 記憶體同步計入（兩態=1）', memLen('spell'), 1);
  const u4 = undoCalls.length;
  pressUndo(); await flush();
  check('T4 spell in-flight undo 直進（修前=1 修後=0）', undoCalls.length - u4, LEGACY ? 1 : 0);
  g4.res();
  await tick();
  check('T4 spell DB 幽靈（修前=1 修後=0）', dbLen('spell'), LEGACY ? 1 : 0);

  // ── T5 靜態標記：三檔 C9 註解 ──
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check(`T5 ${f.split('/').pop()} C9 標記`, src.includes('// C9:') ? 1 : 0, LEGACY ? 0 : 1);
  }

  // ── T6 鏈式序列化釘（單變數只追最後一筆的變體在此轉紅）：
  //    連評 A、B（W_A、W_B 雙掛起）→ 亂序放閘（先 B 後 A）→ undo 必等全鏈排空 ──
  await resetState();
  const fl6 = await import('../src/engine/session-utils.js?c9t6');
  fl6.ensureSession(store.state);
  fl6.ensureQueue(undefined, store.state);
  fl6.mount(store, 's4FlipBtn', () => {});
  const gA = openGoalGate();
  const gB = openGoalGate();
  await rateCurrent(fl6, 2, 'flip');    // 卡 A（W_A→gA）
  await rateCurrent(fl6, 2, 'flip');    // 卡 B（W_B→gB）
  check('T6 前置 兩筆 goal 寫入掛起', goalWrites.length, 2);
  const u6 = undoCalls.length;
  pressUndo(); await flush();
  check('T6 雙 in-flight undo 直進（修前=1 修後=0）', undoCalls.length - u6, LEGACY ? 1 : 0);
  gB.res(); await flush();              // 亂序：先放 B（單變數「只追最後一筆」變體此處 undo 即續跑→轉紅）
  check('T6 僅放 B 後 undo 仍等候全鏈（單變數變體紅：LEGACY=1/FIXED=0）', undoCalls.length - u6, LEGACY ? 1 : 0);
  gA.res();
  await tick();
  check('T6 全鏈排空後 undo 完成（兩態=1）', undoCalls.length - u6, 1);
  // 行為保真釘：undo 的是 B——A 之正當 today 必保留（兩態語意相同，非辨證斷言）
  check('T6 終態記憶體保 A 正當 today（兩態=1）', memLen('flip'), 1);
  check('T6 終態 DB 含 today（FIXED＝undo 還原寫必最後落，無幽靈可辨）', dbLen('flip'), 1);

  // ── T7 屬性釘（兩態恆綠）：incrementGoal 拋錯不拖垮 undo 鏈／鎖 ──
  await resetState();
  const fl7 = await import('../src/engine/session-utils.js?c9t7');
  fl7.ensureSession(store.state);
  fl7.ensureQueue(undefined, store.state);
  fl7.mount(store, 's4FlipBtn', () => {});
  await rateCurrent(fl7, 2, 'flip'); await tick();
  const _inc = store.actions.incrementGoal;
  store.actions.incrementGoal = () => Promise.reject(new Error('boom'));
  await rateCurrent(fl7, 2, 'flip');    // 第二張：increment 拋錯
  await flush();
  store.actions.incrementGoal = _inc;
  const u7 = undoCalls.length;
  pressUndo(); await tick();
  check('T7 increment 拋錯後 undo 不被拖垮', undoCalls.length - u7, 1);
  await rateCurrent(fl7, 2, 'flip');    // 鎖未死
  check('T7 拋錯後鎖必釋（再評成功）', logN('flip') >= 2, true);

  // ── T8 drain 鎖覆蓋釘（R1#3-F1：變體 C「drain 放鎖外」TOCTOU 變異牙）：
  //    drain 掛起期間鎖必持有 → 第二次評分被 lock 丟棄、undo 不錯靶 ──
  await resetState();
  const fl8 = await import('../src/engine/session-utils.js?c9t8');
  fl8.ensureSession(store.state);
  fl8.ensureQueue(undefined, store.state);
  fl8.mount(store, 's4FlipBtn', () => {});
  const g8 = openGoalGate();
  await rateCurrent(fl8, 2, 'flip');               // A 完成（W_A 掛起、快照在場）
  check('T8 前置 W_A 掛起', goalWrites.length, 1);
  pressUndo(); await tick();                       // FIXED: undo 掛鎖內 drain；LEGACY: undo 立即跑完
  const r8 = rateCalls.length;
  await rateCurrent(fl8, 2, 'flip');               // drain 期間第二評進場
  check('T8 drain 期間第二評被鎖丟棄（修前=1 修後=0）', rateCalls.length - r8, LEGACY ? 1 : 0);
  g8.res(); await tick();
  check('T8 放閘後 undo 完成（兩態=1）', undoCalls.length, 1);
  check('T8 終態 log（修前=1 錯靶殘留 修後=0）', logN('flip'), LEGACY ? 1 : 0);

  console.log(LEGACY ? '\n（負控制模式：以上 PASS＝舊碼 bug 精準重現；「兩態」斷言為恆綠屬性釘）' : '');
  console.log(failures === 0 ? `\n=== C9 goal 幽靈 ${LEGACY ? '負控制' : ''} ALL PASS ===` : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(1); });
