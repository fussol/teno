#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-GRAYLIST 驗證 — store.js 灰名單機制（OCR-V2 plan §1）
//
// 用法: node --experimental-test-module-mocks tools/verify-ocr-graylist.mjs
//
// 測試設計（真實 store＋FakeDatabase，沿用 T5/OCR-IMPORT harness 模式）：
//   T0 靜態釘：graylist 初始/載入/API 存在＋OCR 檢查點含 graylist
//   T1 基礎 API：addToGraylist 正規化小寫／去重／回傳；removeFromGraylist 移除
//   T2 CSV 匯入：一行一詞／逗號分隔／引號剝除／大小寫正規化／重複 skip／非法字過濾
//   T3 持久化：setSetting('graylist') 被寫入（db 層）
//   T4 OCR 雙排除：灰名單字被 importOcrText 擋（blacklisted），不進 words
//   T5 直通 importWords：灰名單字同樣擋（importWords 檢查點）
//   T6 灰名單 vs 正常字：非灰名單正常入庫
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');

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
    this.db.exec('CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, examples TEXT, deck TEXT, added_at TEXT)');
    this.db.exec('CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, correct INTEGER, question_type TEXT, examined_at TEXT)');
    this.db.exec('CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT, max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)');
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

let fakeDb = null;
const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

async function resetState(st) {
  const s = st.state;
  s.dayCutoff = 480;
  s.ocrCambridgeVerify = false; // 無真網路：關 Cambridge 只測灰名單過濾
  s.words = [mkWord('wA', 'alpha'), mkWord('wB', 'bravo')];
  s.decks = [];
  s.cards = new Map(); s.cardsMc = new Map(); s.cardsSpell = new Map();
  s.reviewLog = [];
  s.buried = new Set(); s.suspended = new Set();
  s.buriedMc = new Set(); s.suspendedMc = new Set();
  s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  s.graylist = [];
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}

async function getSetting(key) {
  const row = fakeDb.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  const store = createStore();
  await store.actions.init();

  console.log('═══ OCR-GRAYLIST 驗證 ═══');

  // T0 靜態釘
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    check('T0a graylist 初始 state', /graylist:\s*\[\]/.test(src), true);
    check('T0b graylist 載入', /state\.graylist\s*=\s*Array\.from/.test(src), true);
    check('T0c addToGraylist 存在', src.includes('async addToGraylist('), true);
    check('T0d removeFromGraylist 存在', src.includes('async removeFromGraylist('), true);
    check('T0e importGraylistCsv 存在', src.includes('async importGraylistCsv('), true);
    check('T0f isGraylisted 存在', src.includes('isGraylisted('), true);
    check('T0g importWords 檢查點含 graylist',
      src.includes('state.blacklist.includes(w) || state.graylist.includes(w)'), true);
    check('T0h importOcrText 檢查點含 graylist',
      src.includes('new Set([...state.blacklist, ...state.graylist])'), true);
  }

  // T1 基礎 API
  {
    await resetState(store);
    const r1 = await store.actions.addToGraylist('  Zebra ');
    check('T1a add 正規化小寫', r1, ['zebra']);
    const r2 = await store.actions.addToGraylist('ZEBRA'); // 重複
    check('T1b add 去重', r2, ['zebra']);
    const r3 = await store.actions.addToGraylist(''); // 空
    check('T1c add 空字忽略', r3, ['zebra']);
    const r4 = await store.actions.addToGraylist('neon');
    check('T1d add 第二字', r4.sort(), ['neon', 'zebra'].sort());
    const r5 = await store.actions.removeFromGraylist('zebra');
    check('T1e remove', r5, ['neon']);
    check('T1f isGraylisted 命中', store.actions.isGraylisted('neon'), true);
    check('T1g isGraylisted 未命中', store.actions.isGraylisted('zebra'), false);
  }

  // T2 CSV 匯入
  {
    await resetState(store);
    const csv = 'moon\nValue, river;  "quoted"  \nValue\n' + 'x'.repeat(40) + '\n3d';
    const res = await store.actions.importGraylistCsv(csv);
    check('T2a 合法匯入 4 詞（moon/value/river/quoted，引號剝除）',
      ['moon', 'quoted', 'river', 'value'], store.state.graylist.slice().sort());
    check('T2b 非重複 import=4 skip=1(Value 重複) 非法 3d+超長 x 被濾', [res.imported, res.skipped], [4, 1]);
    check('T2c total＝filter 後 5（合法 4＋重複 1；超長/數字 2 被判非法移除）', res.total, 5);
  }

  // T3 持久化
  {
    await resetState(store);
    await store.actions.addToGraylist('star');
    const persisted = await getSetting('graylist');
    check('T3 add 後 db settings.graylist 含 star', persisted, ['star']);
    await store.actions.removeFromGraylist('star');
    const persisted2 = await getSetting('graylist');
    check('T3 remove 後 db 空', persisted2, []);
  }

  // T4 OCR 雙排除（importOcrText 擋灰名單字）
  {
    await resetState(store);
    await store.actions.addToGraylist('gadget');
    const res = await store.actions.importOcrText(['gadget', 'gizmo']);
    const words = fakeDb.db.prepare('SELECT word FROM words ORDER BY word').all().map(r => r.word);
    check('T4a 灰名單字被擋（blacklisted=1）', res.blacklisted, 1);
    check('T4b 正常字 gizmo 入庫', words, ['gizmo']);
    check('T4c added=1', res.added, 1);
  }

  // T5 直通 importWords 檢查點
  {
    await resetState(store);
    await store.actions.addToGraylist('quantum');
    const res = await store.actions.importWords([{ word: 'quantum', deck: 'Default' }]);
    check('T5 importWords 擋灰名單字', [res.added, res.blacklisted], [0, 1]);
  }

  // T6 灰名單不誤擋正常字
  {
    await resetState(store);
    await store.actions.addToGraylist('rejectword');
    const res = await store.actions.importOcrText(['welcome']);
    check('T6 非灰名單字正常入庫', [res.added, res.blacklisted], [1, 0]);
  }

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('[harness error]', e); process.exit(2); });