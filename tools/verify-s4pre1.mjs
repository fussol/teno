#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// S4PRE1 翻卡背面預建 — 行為驗證（jsdom 真實 document）
//
// 用法: node --experimental-test-module-mocks tools/verify-s4pre1.mjs
//
// 斷言（對照 src/pages/study-v4.js renderCard/rip + base.css S4PRE1 規則）：
//   T1 正面時背面 .s4-a 已在 DOM、image slot 只在 .s4-a、評分鈕預建
//   T2 按「顯示答案」＝純顯隱（wrap 加 is-ans、DOM 節點零重建、時數標籤已填）
//   T3 評分＝全量重繪（stamp 消失、下一張回正面、data-wid 換卡）
//   T4 undo（stateBefore=ANSWER、卡不同）＝全量重繪回上一張呈 ANSWER
//   T5 CSS：.s4-a/.s4-undo 預設隱藏、is-ans 顯背面
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { STATE_NEW } from '../src/core/fsrs.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// ── jsdom 環境 ──
const { JSDOM } = await import('jsdom');
let dom = null;
function mkDoc() {
  dom = new JSDOM('<!doctype html><html><body><div id="pageContainer"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
}
mkDoc();

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

// ── FakeDatabase（C7 同型）──
class FakeDatabase {
  constructor() { this.db = new DatabaseSync(':memory:'); this._initSchema(); }
  static load() { if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase(); return FakeDatabase._singleton; }
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
// svg.js 走 vite `?raw` import，node 無法載入 → 全名 stub（tree 內所有 importers 共用）
mock.module('../src/lib/svg.js', { exports: {
  icons: {}, icon: () => '', splitFieldsHtml: () => '', mergeExamplePhrases: (x) => x,
  wordExample: () => '', examplePoolFor: () => [], rotateExamples: () => {},
  bindExNext: () => {}, studyExampleHtml: () => '', fmtExample: (x) => x,
}});

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

async function main() {
  const dbMod = await import('../src/lib/db.js');
  const fakeDb = FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  const store = createStore();
  await store.actions.init();

  const s = store.state;
  s.dayCutoff = 0;
  const anki = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, learnSteps: '1,10', relearnSteps: '10', leechThreshold: 8, timezoneOffset: null, cardsPerDay: 80, reviewMix: 2, learnAheadLimit: 20 };
  s.ankiSettings = { ...anki };
  s.ankiSettingsMc = { ...anki };
  s.ankiSettingsSpell = { ...anki };
  s.words = ['wA', 'wB', 'wC'].map((id, i) => mkWord(id, ['alpha', 'bravo', 'charlie'][i]));
  s.cards = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.cardsMc = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.cardsSpell = new Map(['wA', 'wB', 'wC'].map(id => [id, mkNewCard(id)]));
  s.reviewLog = [];
  s.goalStreak = { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  s.newRatedToday = 0; s.newRatedTodayMc = 0; s.newRatedTodaySpell = 0;
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }

  const page = await import('../src/pages/study-v4.js');
  const u = await import('../src/engine/session-utils.js');

  // ── T1 正面渲染：背面預建 ──
  const c = document.getElementById('pageContainer');
  c.innerHTML = page.render(store);
  page.onMount(store);
  await tick();
  const wrap = c.querySelector('.study-wrap');
  chk('T1 wrap 存在、正面（無 is-ans）、data-wid 對卡', !!wrap && !wrap.classList.contains('is-ans') && wrap.dataset.wid === u.session?.current?.word?.id);
  chk('T1 背面 .s4-a 正面時已預建', !!wrap.querySelector('.s4-q') && !!wrap.querySelector('.s4-a'));
  chk('T1 顯示答案鈕在正面塊', !!wrap.querySelector('.s4-q #s4FlipBtn'));
  chk('T1 image slot 只在 .s4-a（正面塊無圖）', !!wrap.querySelector('.s4-a [data-wimg-slot]') && !wrap.querySelector('.s4-q [data-wimg-slot]'));
  chk('T1 評分鈕在 .s4-a 內（預建）', ['0','1','2','3'].every(r => !!wrap.querySelector(`.s4-a .study-buttons [data-r4="${r}"]`)));
  chk('T1 undo 鈕存在（CSS 隱藏、DOM 預建）', !!document.getElementById('undoBtn'));
  const t1times = [...wrap.querySelectorAll('.study-btn-time')].map(t => t.textContent);
  chk('T1 背面時數已隨 intervals 填好（ensureQueue 即算）', t1times.length === 4 && t1times.every((t, i) => t === String(u.intervals[i])), JSON.stringify(t1times));
  const w1 = u.session.current.word.id;

  // ── T2 翻卡＝純顯隱（零重建）──
  wrap.dataset.stamp = 'keep';
  document.getElementById('s4FlipBtn').click();
  const wrapT2 = c.querySelector('.study-wrap');
  chk('T2 翻卡後 is-ans', wrapT2.classList.contains('is-ans'));
  chk('T2 零重建（同一節點、stamp 幸存）', wrapT2.dataset.stamp === 'keep' && wrapT2 === wrap);
  const times = [...wrap.querySelectorAll('.study-btn-time')].map(t => t.textContent);
  chk('T2 時數標籤已填且對 intervals', times.length === 4 && times.every((t, i) => t && t === String(u.intervals[i])), JSON.stringify(times));
  chk('T2 正面節點仍在（隱藏非銷毀）', !!wrap.querySelector('.s4-q #s4FlipBtn'));

  // ── T3 評分＝全量重繪（下一張回正面）──
  wrap.querySelector('.study-buttons [data-r4="2"]').click();
  await tick(300);
  const wrap3 = c.querySelector('.study-wrap');
  chk('T3 評分後全量重繪（stamp 消失）', !!wrap3 && !wrap3.dataset.stamp);
  chk('T3 下一張回正面（無 is-ans）', !wrap3.classList.contains('is-ans'));
  chk('T3 換卡（data-wid 對新 current）', !!u.session.current && wrap3.dataset.wid === u.session.current.word.id && wrap3.dataset.wid !== w1, `wid=${wrap3.dataset.wid}`);
  chk('T3 下一張背面又已預建', !!wrap3.querySelector('.s4-a .study-buttons [data-r4]'));
  chk('T3 review_log 寫入', store.state.reviewLog.filter(l => l.mode === 'flip').length === 1);

  // ── T4 undo（stateBefore=ANSWER、卡不同）＝全量重繪回上一張 ──
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick(300);
  const wrap4 = c.querySelector('.study-wrap');
  chk('T4 undo 回上一張（data-wid=wA）', !!wrap4 && wrap4.dataset.wid === w1, `wid=${wrap4?.dataset.wid}`);
  chk('T4 undo 後呈 ANSWER（is-ans、重繪非切換）', wrap4.classList.contains('is-ans') && !wrap4.dataset.stamp);
  chk('T4 undo 撤銷評分', store.state.reviewLog.filter(l => l.mode === 'flip').length === 0);

  // ── T5 CSS 顯隱規則 ──
  const css = readFileSync('src/styles/base.css', 'utf8');
  chk('T5 .s4-a/.s4-undo 預設隱藏', css.includes('.study-wrap .s4-a,.study-wrap .s4-undo{display:none}'));
  chk('T5 is-ans：藏正面塊', css.includes('.study-wrap.is-ans .s4-q{display:none}'));
  chk('T5 is-ans：顯背面塊', css.includes('.study-wrap.is-ans .s4-a{display:flex}'));
  chk('T5 s4-q/s4-a 直條佈局（置中不跑版）', css.includes('.study-wrap .s4-q,.study-wrap .s4-a{width:100%;display:flex'));

  console.log(`\nS4PRE1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('S4PRE1 harness error:', e); process.exit(1); });
