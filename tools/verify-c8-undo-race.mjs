#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C8 防回歸驗證 — rateCard/undoRating 雙向 in-flight 互斥
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-c8-undo-race.mjs
//       → 修法後期望（in-flight undo 丟棄、undo 在途評分丟棄）ALL PASS
//   node --experimental-test-module-mocks tools/verify-c8-undo-race.mjs --expect-legacy
//       → 未修負控制（undo 不查鎖照跑、rateCard 不擋 undo 在途）ALL PASS
//
// 確定性設計（非時間擡測）：
//   store.actions.rateCard / undoLastRating 以可開閘 deferred 包裹——
//   開閘＝該呼叫掛起（in-flight 窗口拉到受控），放閘＝續跑。
//   spy 計數在包裹入口**同步**記錄 → 「窗口內是否觸發」為純確定斷言。
//   harness 其餘同 C7（FakeDatabase + invoke/main.js mock + jsdom + 真 store/engine）。
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
const flush = () => new Promise(r => setTimeout(r, 10)); // 微任務＋小宏任務刷新（非競態擡測：閘門掛起態與時序無關）
function pressUndo() {
  globalThis.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
}

// ── FakeDatabase（C3/C7 同型）──
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
mock.module('../src/main.js', { exports: { toast() {} } });

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
const rateCalls = [];  // store.actions.rateCard 入口 spy（同步 push）
const undoCalls = [];  // store.actions.undoLastRating 入口 spy（同步 push，含 mode）
let rateGate = null, undoGate = null;
function openRateGate() { let r; rateGate = { p: new Promise(res => { r = res; }), res: r }; }
function openUndoGate() { let r; undoGate = { p: new Promise(res => { r = res; }), res: r }; }
function releaseRateGate() { const g = rateGate; rateGate = null; if (g) g.res(); }
function releaseUndoGate() { const g = undoGate; undoGate = null; if (g) g.res(); }

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
  rateGate = null; undoGate = null;
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
  rateCalls.length = 0; undoCalls.length = 0;
}
const logN = (mode) => store.state.reviewLog.filter(l => l.mode === mode).length;
async function rateCurrent(u, rating, mode) {
  if (u.state === 'QUESTION') {
    if (mode === 'mc') u.pickAnswer(0);
    else if (mode === 'spell') u.submitAnswer('xyz');
    else u.flipCard(() => {});
  }
  await u.rateCard(store, rating, () => {});
}

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
  // 閘門包裹：入口同步記 spy，閘開→掛起後才落真實作
  const _rate = store.actions.rateCard.bind(store.actions);
  store.actions.rateCard = (...a) => {
    rateCalls.push(a[0] + ':' + a[3]);
    const g = rateGate;
    return (g ? g.p : Promise.resolve()).then(() => _rate(...a));
  };
  const _undo = store.actions.undoLastRating.bind(store.actions);
  store.actions.undoLastRating = (mode = 'flip') => {
    undoCalls.push(mode);
    const g = undoGate;
    return (g ? g.p : Promise.resolve()).then(() => _undo(mode));
  };
  await resetState();

  console.log(`\n═══ C8 in-flight 互斥（${LEGACY ? '負控制：舊碼 bug 必須精準重現' : '修法後'}）═══`);

  // ── T1 flip 主鏈路：評 A 完成 → B ANSWER → rateCard(B) 掛起中按 Ctrl+Z ──
  const fl = await import('../src/engine/session-utils.js?c8t1');
  fl.ensureSession(store.state);
  fl.ensureQueue(undefined, store.state);
  fl.mount(store, 's4FlipBtn', () => {});
  const wA = fl.session.current.word.id;
  await rateCurrent(fl, 2, 'flip');                 // A 完成（快照=A，B=QUESTION）
  const wB = fl.session.current.word.id;
  fl.flipCard(() => {});                            // B → ANSWER
  const r1 = rateCalls.length;                      // 基線：首次 rateCurrent 也計入 spy
  openRateGate();                                   // store.rateCard 掛起
  const pRate = fl.rateCard(store, 2, () => {});    // fire（不 await）
  await flush();
  check('T1 前置 評分化 in-flight', rateCalls.length - r1, 1);
  const u0 = undoCalls.length;
  pressUndo();                                      // in-flight Ctrl+Z
  await flush();
  check('T1 in-flight 誤 undo（修前=1 修後=0）', undoCalls.length - u0, LEGACY ? 1 : 0);
  releaseRateGate(); await pRate; await flush();
  // LEGACY：誤 undo 刪 A log（B 尚未入庫不受刪）＋B 落庫 → 1；FIXED：A+B → 2
  check('T1 放閘後 log 淨效果（修前=1 修後=2）', logN('flip'), LEGACY ? 1 : 2);
  if (!LEGACY) {
    // T1b 修後正向不誤傷：鎖釋後 Ctrl+Z 正常（undo B → 回到 B/ANSWER，log 2→1）
    const u2 = undoCalls.length;
    const l2 = logN('flip');
    pressUndo(); await tick();
    check('T1b 鎖釋後 undo 觸發', undoCalls.length - u2, 1);
    check('T1b undo 淨效果 log-1', logN('flip'), l2 - 1);
  } else {
    check('T1b(legacy 跳過佔位) 標記不存在', 0, 0);
  }

  // ── T2 反向互斥：undo 在途時直呼 rateCard ──
  await resetState();
  const fl2 = await import('../src/engine/session-utils.js?c8t2');
  fl2.ensureSession(store.state);
  fl2.ensureQueue(undefined, store.state);
  fl2.mount(store, 's4FlipBtn', () => {});
  await rateCurrent(fl2, 2, 'flip');                // A 完成，快照在場
  openUndoGate();
  const pUndo = fl2.undoRating(store, () => {});    // fire：store undo 掛起
  await flush();
  check('T2 前置 undo in-flight', undoCalls.length, 1);
  const r0 = rateCalls.length;
  const pR2 = fl2.rateCard(store, 2, () => {});     // 直呼（mc click 路徑等價）
  await flush();
  check('T2 undo 在途評分（修前=1 修後=0）', rateCalls.length - r0, LEGACY ? 1 : 0);
  releaseUndoGate(); await pUndo; if (pR2) await pR2; await tick();

  // ── T3 mc 同構：pickAnswer+rate 掛起中 Ctrl+Z ──
  await resetState();
  const mc = await import('../src/engine/session-mc-utils.js?c8t3');
  mc.ensureSession(store.state);
  mc.ensureQueue(undefined, store.state);
  mc.mount(store, () => {});
  await rateCurrent(mc, 2, 'mc');
  if (mc.state === 'QUESTION') mc.pickAnswer(0);
  openRateGate();
  const pM = mc.rateCard(store, 2, () => {});
  await flush();
  const u3 = undoCalls.length;
  pressUndo(); await flush();
  check('T3 mc in-flight 誤 undo（修前=1 修後=0）', undoCalls.length - u3, LEGACY ? 1 : 0);
  releaseRateGate(); await pM; await tick();

  // ── T4 spell 同構 ──
  await resetState();
  const sp = await import('../src/engine/session-spell-utils.js?c8t4');
  sp.ensureSession(store.state);
  sp.ensureQueue(undefined, store.state);
  sp.mount(store, () => {});
  await rateCurrent(sp, 2, 'spell');
  if (sp.state === 'QUESTION') sp.submitAnswer('xyz');
  openRateGate();
  const pS = sp.rateCard(store, 2, () => {});
  await flush();
  const u4 = undoCalls.length;
  pressUndo(); await flush();
  check('T4 spell in-flight 誤 undo（修前=1 修後=0）', undoCalls.length - u4, LEGACY ? 1 : 0);
  releaseRateGate(); await pS; await tick();

  // ── T5 靜態標記：三檔 C8 修法註解 ──
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check(`T5 ${f.split('/').pop()} C8 標記`, src.includes('// C8:') ? 1 : 0, LEGACY ? 0 : 1);
  }

  // ── T6 C7 回歸釘：QUESTION 態 undo（非 in-flight）照常生效 ──
  await resetState();
  const fl3 = await import('../src/engine/session-utils.js?c8t6');
  fl3.ensureSession(store.state);
  fl3.ensureQueue(undefined, store.state);
  fl3.mount(store, 's4FlipBtn', () => {});
  await rateCurrent(fl3, 2, 'flip');                // A 完成 → B QUESTION
  const u6 = undoCalls.length;
  const wA6 = store.state.reviewLog[store.state.reviewLog.length - 1]?.wordId; // 剛評的卡
  pressUndo(); await tick();
  check('T6 QUESTION 態 undo 不被鎖誤傷', undoCalls.length - u6, 1);
  check('T6 undo 回到原卡', fl3.session.current?.word.id, wA6);

  // ── T7 finally 鎖釋放屬性釘（R1#3-F1：M-c 變異牙）：undo body 拋錯 → 鎖必釋 ──
  await resetState();
  const fl4 = await import('../src/engine/session-utils.js?c8t7');
  fl4.ensureSession(store.state);
  fl4.ensureQueue(undefined, store.state);
  fl4.mount(store, 's4FlipBtn', () => {});
  await rateCurrent(fl4, 2, 'flip');                // 快照在場
  const _u7 = store.actions.undoLastRating;
  store.actions.undoLastRating = () => Promise.reject(new Error('boom')); // body 開頭即拋
  const pU7 = fl4.undoRating(store, () => {});
  await pU7.catch(() => {});                        // undoRating 拋穿（finally 已釋鎖）
  store.actions.undoLastRating = _u7;
  const r7 = rateCalls.length;
  await rateCurrent(fl4, 2, () => {});              // 若鎖卡死→被吞（增量 0）
  check('T7 undo 拋錯後鎖必釋（屬性釘：兩態皆 1）', rateCalls.length - r7, 1);

  // ── T8 快照必清釘（2026-08-27 實錄教訓：repo 實裝漏植 _undoSnapshot=null，
  //    store 層無感（自帶 snapshot delete）但 engine 重複 undo 再 pop——本腳本當時未抓到，
  //    由 verify-c7 T4 組合拳逮到。此釘補牙：undo 完成後第二次 Ctrl+Z 必須 no-op）──
  await resetState();
  const fl5 = await import('../src/engine/session-utils.js?c8t8');
  fl5.ensureSession(store.state);
  fl5.ensureQueue(undefined, store.state);
  fl5.mount(store, 's4FlipBtn', () => {});
  await rateCurrent(fl5, 2, 'flip');
  const resAfter2 = fl5.session.results.length;
  pressUndo(); await tick();                        // 第一次 undo：生效
  const u8 = undoCalls.length;
  pressUndo(); await tick();                        // 第二次：快照必已清 → no-op
  check('T8 undo 後二次 Ctrl+Z no-op（快照必清）', undoCalls.length - u8, 0);
  check('T8 results 未被重複 pop', fl5.session.results.length, resAfter2 - 1);

  console.log(LEGACY ? '\n（負控制模式：以上 PASS＝舊碼 bug 精準重現；T7/T8 為修法屬性釘兩態恆綠）' : '');
  console.log(failures === 0 ? `\n=== C8 undo race ${LEGACY ? '負控制' : ''} ALL PASS ===` : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(1); });
