#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C10 防回歸驗證 — rateCard _ratingLock 無 try/finally → 同步尾段拋錯永久鎖死
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-c10-lock-finally.mjs
//       → 修法後期望（任何路徑釋鎖、undo 不連坐）ALL PASS
//   node --experimental-test-module-mocks tools/verify-c10-lock-finally.mjs --expect-legacy
//       → 負控制（尾段拋錯 → 評分+undo 雙鎖死）ALL PASS
//
// 注入（確定態）：
//   主：mock session-v4 包裹 Session.next()——武裝式單發拋錯（僅評分窗口武裝；
//       next() 位於快照之後、鎖釋放之前的裸奔段，三檔同構通用）。
//   輔：mock easter-eggs.checkMilestone 武裝拋錯（flip 專屬，忠於稽核單 easter-egg 語意）。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { STATE_NEW } from '../src/core/fsrs.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.__throwNext = false;
globalThis.__throwMilestone = false;

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

// ── FakeDatabase（C3/C7/C8/C9 同型）──
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

// ── 注入層 1：Session.next() 武裝式單發拋錯（三檔通用；快照後、釋鎖前必中裸奔段）──
const realS4 = await import('../src/engine/session-v4.js');
mock.module('../src/engine/session-v4.js', {
  exports: {
    ...realS4,
    Session: class extends realS4.Session {
      next() {
        if (globalThis.__throwNext) { globalThis.__throwNext = false; throw new Error('boom-next'); }
        return super.next();
      }
    },
  },
});
// ── 注入層 2：easter-eggs.checkMilestone 武裝拋錯（flip 專屬語意源）──
const realEE = await import('../src/lib/easter-eggs.js');
mock.module('../src/lib/easter-eggs.js', {
  exports: {
    ...realEE,
    checkMilestone(...a) {
      if (globalThis.__throwMilestone) { globalThis.__throwMilestone = false; throw new Error('boom-ee'); }
      return realEE.checkMilestone(...a);
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
const rateCalls = [];   // store.actions.rateCard 入口 spy（同步 push）
const undoCalls = [];   // store.actions.undoLastRating 入口 spy（同步 push）

async function resetState() {
  mkDoc();
  globalThis.__throwNext = false;
  globalThis.__throwMilestone = false;
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
  rateCalls.length = 0; undoCalls.length = 0;
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}
const logN = (mode) => store.state.reviewLog.filter(l => (l.mode || 'flip') === mode).length;
function mkRender() { const f = () => { f.n++; }; f.n = 0; return f; }
async function rateCurrent(u, rating, mode, r) {
  if (u.state === 'QUESTION') {
    if (mode === 'mc') u.pickAnswer(0);
    else if (mode === 'spell') u.submitAnswer('xyz');
    else u.flipCard(() => {});
  }
  return u.rateCard(store, rating, r || (() => {}));
}
// 拋錯評分：回傳 {rejected}
async function rateExpectThrow(u, rating, mode) {
  let rejected = false;
  await rateCurrent(u, rating, mode).then(() => {}, () => { rejected = true; });
  return rejected;
}

async function main() {
  fakeDb = await FakeDatabase.load();
  const dbMod = await import('../src/lib/db.js');
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();
  const _rate = store.actions.rateCard.bind(store.actions);
  store.actions.rateCard = (...a) => { rateCalls.push(a[0] + ':' + a[3]); return _rate(...a); };
  const _undo = store.actions.undoLastRating.bind(store.actions);
  store.actions.undoLastRating = (mode = 'flip') => { undoCalls.push(mode); return _undo(mode); };
  await resetState();

  console.log(`\n═══ C10 rateCard 鎖 finally（${LEGACY ? '負控制：舊碼鎖死必須精準重現' : '修法後'}）═══`);

  // ── T1 flip 主鏈：next 拋 → 鎖釋與否 → 重評恢復 ──
  const fl = await import('../src/engine/session-utils.js?c10t1');
  fl.ensureSession(store.state);
  fl.ensureQueue(undefined, store.state);
  fl.mount(store, 's4FlipBtn', () => {});
  globalThis.__throwNext = true;
  check('T1 拋錯必上拋不吞錯（屬性釘：兩態=true）', await rateExpectThrow(fl, 2, 'flip'), true);
  check('T1 首評已入库（拋在 next，存檔已完成）', logN('flip'), 1);
  const r1 = rateCalls.length;
  const rd1 = mkRender();
  await rateCurrent(fl, 2, 'flip', rd1);           // 重評（拋後 state 殘 ANSWER → 直呼評分）
  check('T1 鎖死吞評（修前=0 修後=1）', rateCalls.length - r1, LEGACY ? 0 : 1);
  check('T1 恢復後 log（修前=1 修後=2）', logN('flip'), LEGACY ? 1 : 2);
  check('T1 恢復後 renderFn 呼入（修前=0 修後=1）', rd1.n, LEGACY ? 0 : 1);

  // ── T2 連坐釘：拋錯後 Ctrl+Z——undo 頭部查同款鎖 → LEGACY 雙路徑癱瘓 ──
  await resetState();
  const fl2 = await import('../src/engine/session-utils.js?c10t2');
  fl2.ensureSession(store.state);
  fl2.ensureQueue(undefined, store.state);
  fl2.mount(store, 's4FlipBtn', () => {});
  globalThis.__throwNext = true;
  await rateExpectThrow(fl2, 2, 'flip');           // 快照已生成（next 在快照後）
  const u2 = undoCalls.length;
  pressUndo(); await flush();
  check('T2 undo 連坐鎖死（修前=0 修後=1）', undoCalls.length - u2, LEGACY ? 0 : 1);
  if (!LEGACY) {
    check('T2 undo 正確回靶', fl2.session.current?.word?.id, store.state.reviewLog[store.state.reviewLog.length - 1]?.wordId ?? fl2.session.current?.word?.id);
  }

  // ── T3 mc 同構（next 注入；mc 獨有 generateOptions 拋源同理封堵）──
  await resetState();
  const mc = await import('../src/engine/session-mc-utils.js?c10t3');
  mc.ensureSession(store.state);
  mc.ensureQueue(undefined, store.state);
  mc.mount(store, () => {});
  globalThis.__throwNext = true;
  check('T3 mc 拋錯上拋（兩態=true）', await rateExpectThrow(mc, 2, 'mc'), true);
  const r3 = rateCalls.length;
  await rateCurrent(mc, 2, 'mc');
  check('T3 mc 鎖死吞評（修前=0 修後=1）', rateCalls.length - r3, LEGACY ? 0 : 1);

  // ── T4 spell 同構 ──
  await resetState();
  const sp = await import('../src/engine/session-spell-utils.js?c10t4');
  sp.ensureSession(store.state);
  sp.ensureQueue(undefined, store.state);
  sp.mount(store, () => {});
  globalThis.__throwNext = true;
  check('T4 spell 拋錯上拋（兩態=true）', await rateExpectThrow(sp, 2, 'spell'), true);
  const r4 = rateCalls.length;
  await rateCurrent(sp, 2, 'spell');
  check('T4 spell 鎖死吞評（修前=0 修後=1）', rateCalls.length - r4, LEGACY ? 0 : 1);

  // ── T5 flip easter-eggs 拋源（稽核單語意忠實：checkMilestone 拋）──
  await resetState();
  const fl5 = await import('../src/engine/session-utils.js?c10t5');
  fl5.ensureSession(store.state);
  fl5.ensureQueue(undefined, store.state);
  fl5.mount(store, 's4FlipBtn', () => {});
  globalThis.__throwMilestone = true;
  check('T5 easter-egg 拋錯上拋（兩態=true）', await rateExpectThrow(fl5, 2, 'flip'), true);
  const r5 = rateCalls.length;
  await rateCurrent(fl5, 2, 'flip');
  check('T5 easter-egg 鎖死吞評（修前=0 修後=1）', rateCalls.length - r5, LEGACY ? 0 : 1);

  // ── T6 靜態標記：三檔 C10 註解 ──
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check(`T6 ${f.split('/').pop()} C10 標記`, src.includes('// C10:') ? 1 : 0, LEGACY ? 0 : 1);
  }

  // ── T7 反覆拋錯抗性：拋→恢復→拋→恢復→第三評必成＋undo 可用（鎖無累積泄漏）──
  await resetState();
  const fl7 = await import('../src/engine/session-utils.js?c10t7');
  fl7.ensureSession(store.state);
  fl7.ensureQueue(undefined, store.state);
  fl7.mount(store, 's4FlipBtn', () => {});
  globalThis.__throwNext = true;
  await rateExpectThrow(fl7, 2, 'flip');           // 拋 1
  await rateCurrent(fl7, 2, 'flip');               // 恢復評（LEGACY 此處起全吞）
  globalThis.__throwNext = true;
  await rateExpectThrow(fl7, 2, 'flip');           // 拋 2（LEGACY 鎖死無感）
  await rateCurrent(fl7, 2, 'flip');               // 恢復評
  check('T7 反覆後入庫總數（修前=1 修後=4）', logN('flip'), LEGACY ? 1 : 4);
  const u7 = undoCalls.length;
  pressUndo(); await tick();
  check('T7 反覆後 undo 可用（修前=0 修後=1）', undoCalls.length - u7, LEGACY ? 0 : 1);

  // ── T8 正常路徑不傷釘（兩態恆綠）：rate→undo→rate，鎖語意/C8 互斥零逆轉 ──
  await resetState();
  const fl8 = await import('../src/engine/session-utils.js?c10t8');
  fl8.ensureSession(store.state);
  fl8.ensureQueue(undefined, store.state);
  fl8.mount(store, 's4FlipBtn', () => {});
  const rd8 = mkRender();
  await rateCurrent(fl8, 2, 'flip', rd8);
  check('T8 正常評分 log', logN('flip'), 1);
  check('T8 正常評分 renderFn 呼入', rd8.n, 1);
  pressUndo(); await tick();
  check('T8 undo 淨效果 log 0', logN('flip'), 0);
  await rateCurrent(fl8, 2, 'flip', rd8);
  check('T8 undo 後重評 log 1', logN('flip'), 1);

  // ── T9 渲染時序＋重入探測釘（R1#3 盲區封堵；兩態恆綠——現行碼本就鎖釋先於渲染）──
  await resetState();
  const fl9 = await import('../src/engine/session-utils.js?c10t9');
  fl9.ensureSession(store.state);
  fl9.ensureQueue(undefined, store.state);
  fl9.mount(store, 's4FlipBtn', () => {});
  const probe = { stateAtRender: null, wordAtRender: null, rateDuringRender: -1 };
  const rd9 = () => {
    // renderFn 同步採樣：渲染瞬間的引擎狀態（stale render / 渲染期持鎖偵測）
    if (probe.stateAtRender === null) {
      probe.stateAtRender = fl9.state;
      probe.wordAtRender = fl9.session.current?.word?.id ?? null;
      // 鎖探針：renderFn 內同步重入 rateCard——await f() 之 f() 於掛起前同步執行，
      // rateCalls spy 同步 push＝鎖已釋證據；渲染期持鎖變體則頭部吞（+0）。
      const rP = rateCalls.length;
      fl9.rateCard(store, 3, () => {});
      probe.rateDuringRender = rateCalls.length - rP;
    }
  };
  await rateCurrent(fl9, 2, 'flip', rd9);   // 評 wA → next 到次題（隊列經 shuffle，非必 wB）
  await tick();
  check('T9 渲染時 state=QUESTION（封提前渲染的 ANSWER 殘留）', probe.stateAtRender, 'QUESTION');
  check('T9 渲染時 current≠剛評卡 wA（封 stale render）', probe.wordAtRender === 'wA' ? 'wA' : 'other', 'other');
  check('T9 渲染期重入評分不被鎖吞（封渲染期持鎖；+1=鎖釋先於渲染）', probe.rateDuringRender, 1);

  // ── T10 結構忠實靜態釘（封「只包 await 段＋finally」結構違約變體）──
  for (const f of ['src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const seg = src.slice(src.indexOf('export async function rateCard'));
    const segEnd = seg.indexOf('\nexport function');
    const body = segEnd > 0 ? seg.slice(0, segEnd) : seg;
    const outerFinally = /finally\s*\{[^}]*_ratingLock = false/.test(body) ? 1 : 0;
    const tryIdx = body.indexOf('_ratingLock = true;');
    const tryOpen = body.indexOf('try {', tryIdx);
    const snapIdx = body.indexOf('_undoSnapshot = {');
    const finIdx = body.lastIndexOf('} finally {');
    const finClose = finIdx >= 0 ? body.indexOf('}', finIdx + 11) : -1;
    const renderIdx = body.lastIndexOf('renderFn()');
    const snapInTry = tryOpen >= 0 && snapIdx > tryOpen && finIdx > snapIdx ? 1 : 0;
    const renderAfterFin = finClose >= 0 && renderIdx > finClose ? 1 : 0;
    const ok = (outerFinally && snapInTry && renderAfterFin) ? 1 : 0;
    check(`T10 ${f.split('/').pop()} 結構忠實（finally 釋鎖＋尾段在 try＋render 出 finally）`, ok, LEGACY ? 0 : 1);
  }

  console.log(LEGACY ? '\n（負控制模式：以上 PASS＝舊碼鎖死精準重現；「兩態」斷言為恆綠屬性釘）' : '');
  console.log(failures === 0 ? `\n=== C10 lock finally ${LEGACY ? '負控制' : ''} ALL PASS ===` : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(1); });
