#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-T5 稽核（獨立第二軌 PM-OCR2-T5）— 對 2dae766 feat(ocr): importOcrText
// 補其驗證缺口：①事務失敗 added=0（任務單 POST 明列，原腳本零 failInsert）
//               ②負控制「不過濾」態（原腳本 NC 僅「函式不存在」）
//               ③PRE 紅獨立重現（HEAD~1 快照實跑，非自製剝除檔）
// tmp 檔名 .ocr-audit-* 前綴，避與 tools/verify-ocr-import.mjs 互撞。
// 用法: node --experimental-test-module-mocks _dev/notes/verify-ocr-t5-audit.mjs
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const PRE_TMP = path.join(ROOT, 'src/lib/.ocr-audit-pre.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.ocr-audit-neg.js');
const FILTER_CALL_LITERAL = `.filter(w => /^[a-z][a-z'-]{1,30}$/i.test(w))`;

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
    this.failInsert = false;
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
  async execute(sql, params = []) {
    if (this.failInsert && /INSERT INTO words/.test(sql)) {
      throw new Error('SQLITE_CONSTRAINT: simulated disk write failure');
    }
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
  s.reviewLog = [];
  s.buried = new Set(); s.suspended = new Set();
  s.buriedMc = new Set(); s.suspendedMc = new Set();
  s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
  for (const w of s.words) {
    fakeDb.db.prepare('INSERT INTO words (id, word, created_at) VALUES (?, ?, ?)').run(w.id, w.word, w.createdAt);
  }
}
const dbWordCount = () => fakeDb.db.prepare('SELECT COUNT(*) AS c FROM words').get().c;
const dbHasWord = (w) => !!fakeDb.db.prepare('SELECT 1 FROM words WHERE word = ?').get(w);

async function main() {
  const dbMod = await import('../../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();

  console.log('\n═══ OCR-T5 稽核（獨立重跑，補 2dae766 驗證缺口）═══');

  // ── P1 PRE 獨立重現：HEAD~1（T4 時點）store.js 快照 → 函式必須不存在 ──
  {
    const preSrc = execSync('git show HEAD~1:src/lib/store.js', { cwd: ROOT }).toString();
    check('P1a HEAD~1 快照無 importOcrText（PRE 基準）', preSrc.includes('async importOcrText('), false);
    fs.writeFileSync(PRE_TMP, preSrc);
    try {
      const { createStore: createPre } = await import('../../src/lib/.ocr-audit-pre.js');
      const preStore = createPre();
      await preStore.actions.init();
      let tError = null;
      try { await preStore.actions.importOcrText(['alpha']); } catch (e) { tError = e.constructor.name; }
      check('P1b PRE 呼叫 TypeError（函式不存在紅態）', tError, 'TypeError');
    } finally {
      if (fs.existsSync(PRE_TMP)) fs.unlinkSync(PRE_TMP);
    }
  }

  const { createStore } = await import('../../src/lib/store.js');
  const store = createStore();
  await store.actions.init();

  // ── G1 垃圾過濾（POST 綠①）──
  {
    await resetState(store);
    const res = await store.actions.importOcrText(
      ['charlie', '123', '3d', 'a', 'hello!', '#tag', 'echo', "don't", 'well-known', 'x'.repeat(32)]);
    check('G1 added=4（4 合法入庫）', res.added, 4);
    check('G1 DB 無 123/hello!', [dbHasWord('123'), dbHasWord('hello!')], [false, false]);
    check('G1 DB 有 don\'t／well-known', [dbHasWord("don't"), dbHasWord('well-known')], [true, true]);
    check('G1 DB 實查 6 行', dbWordCount(), 6);
    check('G1 預設建 OCR Inbox', res.decksCreated.includes('OCR Inbox'), true);
  }

  // ── G2 大小寫去重（POST 綠②）──
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['delta', 'DELTA', 'Delta', 'DELTA']);
    check('G2 大小寫去重 added=1 skipped=3', [res.added, res.skipped], [1, 3]);
    check('G2 DB 小寫形態', dbHasWord('delta'), true);
  }

  // ── G3 既有詞 skipped（POST 綠③）──
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['alpha', 'ALPHA', 'foxtrot']);
    check('G3 既有詞 added=1 skipped=2', [res.added, res.skipped], [1, 2]);
  }

  // ── G4 事務失敗 added=0（POST 綠④ — 原腳本缺口）──
  {
    await resetState(store);
    fakeDb.failInsert = true;
    const res = await store.actions.importOcrText(['golf', 'hotel', '123', 'golf']);
    fakeDb.failInsert = false;
    check('G4 事務失敗 added=0（T1 txFailed 修復經復用生效）', res.added, 0);
    check('G4 skipped 不受波及（同批 golf 重複）', res.skipped, 1);
    check('G4 DB 實查零新行', dbWordCount(), 2);
  }

  // ── G5 回傳形態對齊 importWords ──
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['zulu'], 'My Deck');
    check('G5 key 集合＝importWords 形態', Object.keys(res).sort(), ['added', 'decksCreated', 'skipped']);
    check('G5 自訂 deckName 生效', res.decksCreated.includes('My Deck'), true);
  }

  // ── N1 負控制「不過濾」態（原腳本缺口：其 NC 僅函式剋除）──
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    if (!src.includes(FILTER_CALL_LITERAL)) {
      check('N1 NC 白名單過濾錨存在', false, true);
    } else {
      const stripped = src.replace(FILTER_CALL_LITERAL, '.filter(() => true /* AUDIT NEG: whitelist stripped */)');
      fs.writeFileSync(NEG_TMP, stripped);
      try {
        const { createStore: createNeg } = await import('../../src/lib/.ocr-audit-neg.js');
        const negStore = createNeg();
        await negStore.actions.init();
        await resetState(negStore);
        const res = await negStore.actions.importOcrText(['charlie', '123', 'x!']);
        check('N1 剝除過濾後垃圾入庫 added=3（測試對過濾態敏感）', res.added, 3);
        check('N1 垃圾 123 落盤實查', dbHasWord('123'), true);
        await resetState(negStore);
        const ok = await negStore.actions.importOcrText(['kilo', 'kilo']);
        check('N2 NC 反換釘：合法路徑 added=1 skipped=1 不誤傷', [ok.added, ok.skipped], [1, 1]);
      } finally {
        if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);
      }
    }
  }

  console.log(failures === 0 ? '\n═══ AUDIT ALL PASS ═══' : `\n═══ AUDIT ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[audit harness error]', e); process.exit(2); });
