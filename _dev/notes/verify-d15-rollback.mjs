#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// D15 驗證 — importWords 批次 DB 寫失敗時 in-memory state.words 回滾
//   root cause：newWords 於 :1262-1264 迴圈內 push 到 state.words，
//   但 DB 批次 tx (:1272-1282) 在後；tx 失敗原碼只 added=0，state.words
//   殘留 → UI 顯示已入庫、DB 0 顆 → 重開即失蹤（OCR「無法正常工作」的症狀）。
//   修法 :1284-1289 filter 掉 newIds。
// 用法: node --experimental-test-module-mocks _dev/notes/verify-d15-rollback.mjs
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let failures = 0;
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

globalThis.localStorage = {
  getItem: (k) => (k === 'teno_no_seed' ? '1' : null),
  setItem: () => {}, removeItem: () => {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

class FakeDatabase {
  constructor() { this.db = new DatabaseSync(':memory:'); this.failInsert = false; this._init(); }
  static load() { if (!FakeDatabase._singleton) FakeDatabase._singleton = new FakeDatabase(); return FakeDatabase._singleton; }
  _init() {
    this.db.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT, related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)`);
    this.db.exec(`CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)`);
    this.db.exec(`CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL, elapsed_days REAL, scheduled_days REAL, reps INTEGER, lapses INTEGER, state INTEGER, step INTEGER, last_review TEXT, buried INTEGER, suspended INTEGER, mc_data TEXT, spell_data TEXT)`);
    this.db.exec(`CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER, duration INTEGER, elapsed_days REAL, scheduled_days REAL, stability REAL, difficulty REAL, mode TEXT, card_state INTEGER, new_state INTEGER, reviewed_at TEXT)`);
    this.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
    this.db.exec(`CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT)`);
    this.db.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`);
    this.db.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)`);
    this.db.exec(`CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, examples TEXT, deck TEXT, added_at TEXT)`);
    this.db.exec(`CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, correct INTEGER, question_type TEXT, examined_at TEXT)`);
    this.db.exec(`CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT, max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)`);
  }
  _bind(sql, params = []) {
    if (!params || params.length === 0) return {};
    const obj = {}; for (let i = 0; i < params.length; i++) obj['$' + (i + 1)] = params[i]; return obj;
  }
  async execute(sql, params = []) {
    if (this.failInsert && /INSERT INTO words/.test(sql)) throw new Error('SQLITE_CONSTRAINT: simulated disk write failure');
    this.db.prepare(sql).run(this._bind(sql, params));
  }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}

mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../../src/main.js', { exports: { toast() {} } });

let fakeDb = null;
const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

async function resetState(st) {
  const s = st.state;
  s.dayCutoff = 480;
  s.words = ['wA', 'wB'].map((id, i) => mkWord(id, ['alpha', 'bravo'][i]));
  s.decks = [];
  s.cards = new Map(); s.cardsMc = new Map(); s.cardsSpell = new Map();
  s.reviewLog = []; s.buried = new Set(); s.suspended = new Set();
  s.buriedMc = new Set(); s.suspendedMc = new Set(); s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  for (const t of ['words', 'decks', 'cards', 'review_log', 'settings', 'goal_streak', 'audit_log', 'folders', 'additions', 'exam_history', 'filtered_decks']) fakeDb.db.exec(`DELETE FROM ${t}`);
  for (const w of s.words) fakeDb.db.prepare('INSERT INTO words (id, word, created_at) VALUES (?, ?, ?)').run(w.id, w.word, w.createdAt);
}
const dbWordCount = () => fakeDb.db.prepare('SELECT COUNT(*) AS c FROM words').get().c;
const stateWordCount = (st) => st.words.length;
const stateHas = (st, w) => st.words.some(x => x.word === w);

async function main() {
  const dbMod = await import('../../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const st = await import('../../src/lib/store.js');
  const store = st.createStore();
  const state = store.state;
  await store.actions.init(); // 載 scheduler/simulator/filterEngine + initDB + seed

  console.log('\n═══ D15 驗證 — importWords DB 失敗時 state.words 回滾 ═══\n');

  // ── P1：DB 寫入失敗 → state.words 不得殘留新字 ──
  await resetState(store);
  fakeDb.failInsert = true; // 讓 INSERT INTO words 拋錯
  const p1 = await store.actions.importWords([
    { word: 'charlie', deck: 'OCR Inbox' },
    { word: 'delta', deck: 'OCR Inbox' },
  ]);
  check('P1 回報 added=0', p1.added, 0);
  check('P1 DB 無新字（0 新增）', dbWordCount(), 2); // 原本 alpha/bravo，新增全失敗
  check('P1 state.words 無殘留 charlie', stateHas(store.state, 'charlie'), false);
  check('P1 state.words 無殘留 delta', stateHas(store.state, 'delta'), false);
  check('P1 state.words 維持 2 顆', stateWordCount(store.state), 2);
  check('P1 decksCreated 回報已建 deck（獨立於 words tx）', p1.decksCreated, ['OCR Inbox']);

  // ── P2：DB 寫入成功 → 正常入庫 ═══
  await resetState(store);
  fakeDb.failInsert = false;
  const p2 = await store.actions.importWords([
    { word: 'echo', deck: 'Flip Deck' },
    { word: 'foxtrot', deck: 'Flip Deck' },
  ]);
  check('P2 回報 added=2', p2.added, 2);
  check('P2 state.words 含 echo/foxtrot', stateHas(store.state, 'echo') && stateHas(store.state, 'foxtrot'), true);
  check('P2 state.words 增至 4 顆', stateWordCount(store.state), 4);
  check('P2 DB 2 新增（總 4）', dbWordCount(), 4);

  // ── P3：負控制 — failInsert 關閉時不該誤觸 rollback ──
  await resetState(store);
  fakeDb.failInsert = false;
  const p3 = await store.actions.importWords([{ word: 'golf', deck: 'Default' }]);
  check('P3 正常 added=1', p3.added, 1);
  check('P3 golf 在位', stateHas(store.state, 'golf'), true);
  check('P3 DB golf 在位', dbWordCount(), 3);

  // ── P4：partial — 前段已成功 push、後段失敗 → 全部回滾（不流一半）──
  // 注意：— failInsert 對所有 INSERT INTO words 生效，故 newWords 無一入 DB；
  //       此腿檢驗「即使部分 in-memory push 已發生，tx 失敗後也要全量撤」。
  await resetState(store);
  fakeDb.failInsert = true;
  const p4 = await store.actions.importWords([{ word: 'hotel', deck: 'Default' }]);
  check('P4 added=0', p4.added, 0);
  check('P4 hotel 不殘留', stateHas(store.state, 'hotel'), false);

  console.log(failures === 0 ? '\n✅ 全部通過' : `\n❌ ${failures} 個 FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('驗證腳本崩潰:', e); process.exit(2); });