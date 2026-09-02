#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// C7 防回歸驗證 — 完成畫面／QUESTION 態 Ctrl+Z undo 被擋
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-c7-undo-gate.mjs
//       → 修法後期望（QUESTION 態可 undo、完成畫面 mount 後可 undo、
//         再完成走完成畫面分支不 reset）ALL PASS
//   node --experimental-test-module-mocks tools/verify-c7-undo-gate.mjs --expect-legacy
//       → 未修負控制（三處 gate/早退/reset 全部擋死或清空）ALL PASS
//
// 真實度設計（沿用 C3 harness 三件套 mock + jsdom 真實 document）:
//   mock @tauri-apps/plugin-sql → FakeDatabase（node:sqlite in-memory）
//   mock @tauri-apps/api/core   → no-op invoke
//   mock ../src/main.js         → toast stub
//   jsdom（本專案 devDep ^30.0.1）→ 真實 document + KeyboardEvent 派發
//   真實: session-utils/mc/spell + Session + FSRS + store.actions.rateCard
//         /undoLastRating（真寫 memory+DB，undo 走 C1 真實鏈路）
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { STATE_NEW } from '../src/core/fsrs.js';

// easter-eggs（flip rateCard 呼叫 checkAchievement/checkMilestone）防呆 stub
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const LEGACY = process.argv.includes('--expect-legacy');

// ── jsdom 環境（mount()/keydown 派發需要真實 document）──
// v1.1（R1#3 處方）：每相位獨立 document——resetState() 重建 document/window，
// 使各引擎 module 的 module-level keydown handler 相位間互不見面（貼近真實 App
// renderPage pageCleanup 語意，消除 harness 特有的 stale handler 跨相位污染）。
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
// 真實 UI 等價：document 上派發 Ctrl+Z（三檔 mount 的 handler 都掛 document）
function pressUndo() {
  globalThis.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
}

// ── FakeDatabase（C3 同型：單例 + $n Named 綁定）──
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
const undoCalls = []; // mode 序列（wrapper push，undo 未發生則不進）

async function resetState() {
  mkDoc(); // v1.1：相位級 document 隔離（R1#3 處方）
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
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
  undoCalls.length = 0;
}
const logN = (mode) => store.state.reviewLog.filter(l => l.mode === mode).length;
// 真實流程：翻面→評分（state 機由 utils 內部管）
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
  // undo spy：只計數不改變行為（handler fire-and-forget → 斷言前 tick()）
  const _origUndo = store.actions.undoLastRating;
  store.actions.undoLastRating = async (mode = 'flip') => { undoCalls.push(mode); return _origUndo(mode); };
  await resetState();

  console.log(`\n═══ C7 undo gate（${LEGACY ? '負控制：舊碼 bug 必須精準重現' : '修法後'}）═══`);

  // ── T1 flip：評分後 QUESTION 態（下一張未翻答案）Ctrl+Z ──
  const fl = await import('../src/engine/session-utils.js');
  fl.ensureSession(store.state);
  check('T1 flip ensureQueue', fl.ensureQueue(undefined, store.state), true);
  fl.mount(store, 's4FlipBtn', () => {});
  const w1 = fl.session.current.word.id;
  await rateCurrent(fl, 2, 'flip');
  check('T1 前置 評分後 state=QUESTION', fl.state, 'QUESTION');
  const w2 = fl.session.current?.word.id;
  check('T1 前置 下一張已換', w2 !== w1, true);
  const u0 = undoCalls.length;
  pressUndo(); await tick();
  check('T1 QUESTION 態 Ctrl+Z 觸發 undo', undoCalls.length - u0, LEGACY ? 0 : 1);
  check('T1 review_log 淨效果', logN('flip'), LEGACY ? 1 : 0);
  check('T1 current 回到原卡', fl.session.current?.word.id, LEGACY ? w2 : w1);

  // ── T2 flip：drain 至完成畫面 → mount() 重掛（真實頁面 onMount）→ Ctrl+Z ──
  await resetState();
  const fl2 = await import('../src/engine/session-utils.js?c7t2');
  fl2.ensureSession(store.state);
  fl2.ensureQueue(undefined, store.state);
  fl2.mount(store, 's4FlipBtn', () => {});
  const order = [];
  while (fl2.session.current && order.length < 10) {
    order.push(fl2.session.current.word.id);
    await rateCurrent(fl2, 2, 'flip');
  }
  // 動態 N：new 卡 GOOD→learning→learn-ahead 提前重現會重複計分（確定性，兩態一致）
  check('T2 前置 全評完（order==log 且>=3）', [order.length, logN('flip'), order.length >= 3].join('/'),
    [order.length, order.length, 'true'].join('/'));
  check('T2 前置 完成 state=EMPTY', fl2.state, 'EMPTY');
  // 真實渲染順序：完成 → render → ensureQueue 完成首屏（設 _completionShown 旗標）→ onMount
  check('T2 完成首屏 ensureQueue=false', fl2.ensureQueue(undefined, store.state), false);
  const u2 = undoCalls.length;
  fl2.mount(store, 's4FlipBtn', () => {}); // 完成畫面重新 onMount
  pressUndo(); await tick();
  check('T2 完成畫面 Ctrl+Z 觸發 undo', undoCalls.length - u2, LEGACY ? 0 : 1);
  check('T2 完成畫面 undo 可復原最後一張', [fl2.state, fl2.session.current?.word.id || ''].join('/'),
    LEGACY ? 'EMPTY/' : `ANSWER/${order[order.length - 1]}`);

  // ── T4 flip：快照 null 時 Ctrl+Z 安全 no-op ──
  // v1.1（R1 #1/#2/#3 一致處方）：移到 T2 undo 之後、T3 重評之前——
  // 此點 _undoSnapshot 因 undoRating 已清空而確定為 null（v1.0 誤放在 T3 後，
  // 該點 T3 重評已寫入新快照，斷言「不 undo」與修法目標直接矛盾＝假紅）。
  const u4 = undoCalls.length;
  const r4 = logN('flip');
  pressUndo(); await tick();
  check('T4 無快照 Ctrl+Z no-op（呼叫）', undoCalls.length - u4, 0);
  check('T4 無快照 Ctrl+Z no-op（log 不變）', logN('flip'), r4);

  // ── T3 flip：完成 undo → 重評 → 再完成必須走完成畫面（session 不得 reset）──
  // LEGACY 無 undo（current null，rateCurrent 為 no-op）→ ensureQueue 落入 reset 分支清空 results
  await rateCurrent(fl2, 2, 'flip'); // 最後一張重新評分 → 再度完成（FIXED）
  fl2.ensureQueue(undefined, store.state);
  check('T3 session.results 未被 reset 清空', fl2.session.results.length, LEGACY ? 0 : order.length);
  check('T3 再完成 state=EMPTY（完成畫面）', fl2.state, 'EMPTY');

  // ── T5 靜態標記：三檔 C7 修法註解在場與否 ═─
  const { readFileSync } = await import('node:fs');
  for (const f of ['src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    check(`T5 ${f.split('/').pop()} C7 標記`, src.includes('// C7:') ? 1 : 0, LEGACY ? 0 : 1);
  }

  // ── T6 mc：QUESTION 態 + 完成畫面 Ctrl+Z（同構檔 2）──
  await resetState();
  const mc = await import('../src/engine/session-mc-utils.js?c7t6');
  mc.ensureSession(store.state);
  mc.ensureQueue(undefined, store.state);
  mc.mount(store, () => {});
  const m1 = mc.session.current.word.id;
  await rateCurrent(mc, 2, 'mc');
  const m2 = mc.session.current?.word.id;
  const u6 = undoCalls.length;
  pressUndo(); await tick();
  check('T6 mc QUESTION 態 Ctrl+Z 觸發 undo', undoCalls.length - u6, LEGACY ? 0 : 1);
  check('T6 mc current 回到原卡', mc.session.current?.word.id, LEGACY ? m2 : m1);
  const morder = [];
  while (mc.session.current && morder.length < 10) {
    morder.push(mc.session.current.word.id);
    await rateCurrent(mc, 2, 'mc');
  }
  check('T6 mc 零跨 mode 誤 undo（序列全 mc）', undoCalls.filter(m => m !== 'mc').length, 0);
  // 真實完成順序：render → ensureQueue 完成首屏（設 _completionShown）→ onMount
  check('T6 mc 完成首屏 ensureQueue=false', mc.ensureQueue(undefined, store.state), false);
  const u6b = undoCalls.length;
  mc.mount(store, () => {}); // 完成畫面重新 onMount
  pressUndo(); await tick();
  check('T6 mc 完成畫面 Ctrl+Z 觸發 undo', undoCalls.length - u6b, LEGACY ? 0 : 1);
  check('T6 mc 完成 undo mode 正確', undoCalls[u6b] || 'none', LEGACY ? 'none' : 'mc');
  // RC3 鏡像（v1.1 補，R1#3 覆蓋缺口）：undo → 重評 → 再完成不得 reset
  await rateCurrent(mc, 2, 'mc');
  mc.ensureQueue(undefined, store.state);
  check('T6 mc RC3 results 未被 reset 清空', mc.session.results.length > 0 ? 1 : 0, LEGACY ? 0 : 1);

  // ── T7 spell：QUESTION 態 Ctrl+Z（同構檔 3）──
  await resetState();
  const sp = await import('../src/engine/session-spell-utils.js?c7t7');
  sp.ensureSession(store.state);
  sp.ensureQueue(undefined, store.state);
  sp.mount(store, () => {});
  const s1 = sp.session.current.word.id;
  await rateCurrent(sp, 2, 'spell');
  const s2 = sp.session.current?.word.id;
  const u7 = undoCalls.length;
  pressUndo(); await tick();
  check('T7 spell QUESTION 態 Ctrl+Z 觸發 undo', undoCalls.length - u7, LEGACY ? 0 : 1);
  check('T7 spell current 回到原卡', sp.session.current?.word.id, LEGACY ? s2 : s1);
  // RC2+RC3 鏡像（v1.1 補，R1#3 覆蓋缺口）：完成畫面 mount→undo→重評→再完成
  check('T7 spell 零跨 mode 誤 undo（序列全 spell）', undoCalls.filter(m => m !== 'spell').length, 0);
  const sorder = [];
  while (sp.session.current && sorder.length < 10) {
    sorder.push(sp.session.current.word.id);
    await rateCurrent(sp, 2, 'spell');
  }
  check('T7 spell 完成首屏 ensureQueue=false', sp.ensureQueue(undefined, store.state), false);
  const u7b = undoCalls.length;
  sp.mount(store, () => {}); // 完成畫面重新 onMount
  pressUndo(); await tick();
  check('T7 spell 完成畫面 Ctrl+Z 觸發 undo', undoCalls.length - u7b, LEGACY ? 0 : 1);
  check('T7 spell 完成 undo mode 正確', undoCalls[u7b] || 'none', LEGACY ? 'none' : 'spell');
  await rateCurrent(sp, 2, 'spell');
  sp.ensureQueue(undefined, store.state);
  check('T7 spell RC3 results 未被 reset 清空', sp.session.results.length > 0 ? 1 : 0, LEGACY ? 0 : 1);

  console.log(LEGACY ? '\n（負控制模式：以上 PASS＝舊碼 bug 精準重現）' : '');
  console.log(failures === 0 ? `\n=== C7 undo gate ${LEGACY ? '負控制' : ''} ALL PASS ===` : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(1); });
