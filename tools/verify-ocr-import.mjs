#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-IMPORT 驗證（T5）— store.importOcrText（計畫 v1.3 §6.2b）
//
// 用法: node --experimental-test-module-mocks tools/verify-ocr-import.mjs
//
// 測試設計（真實 store＋FakeDatabase，沿用 T1/a10 harness）：
//   T0 靜態釘：importOcrText 存在＋§5 正則逐字元＋走 this.importWords
//   T1 過濾矩陣：大小寫正規化／§5 白名單拒垃圾（數字頭、單字母、符號尾、
//      超長 32 字、非 a-z）／合法連字號撇號放行
//   T2 入庫語意：全進 added、DB 實查 deck='OCR Inbox'＋definition=''
//   T3 去重：批內重複＋與既有字重複 → skipped；decksCreated 含 OCR Inbox
//   T4 自訂 deckName 參數透傳
//   T5 全垃圾輸入 → added=0 skipped=0 不拋（UI「入庫失敗」分支依據）
//   PRE 雙態：NEG 檔＝importOcrText 整段剝除（= T4 時點實態重現）
//       → 呼叫必 TypeError 紅；NC 反換釘：NEG.importWords 正常路徑仍綠
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.ocr-import-neg-control.js');

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
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

let fakeDb = null;
const mkWord = (id, w) => ({
  id, word: w, definition: 'def', pos: 'n', pron: '', example: '', deck: 'Default',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});

async function resetState(st) {
  const s = st.state;
  s.dayCutoff = 480;
  s.ocrCambridgeVerify = false; // harness 無真網路：關 Cambridge 查證只測白名單/黑名單過濾
  s.words = [mkWord('wA', 'alpha'), mkWord('wB', 'bravo')];
  s.decks = [];
  s.cards = new Map(); s.cardsMc = new Map(); s.cardsSpell = new Map();
  s.reviewLog = [];
  s.buried = new Set(); s.suspended = new Set();
  s.buriedMc = new Set(); s.suspendedMc = new Set();
  s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
}
const dbWords = () => fakeDb.db.prepare('SELECT word, deck, definition FROM words ORDER BY word').all();

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  const store = createStore();
  await store.actions.init();

  console.log('═══ OCR-IMPORT T5 驗證 ═══');

  // T0 靜態釘
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const start = src.indexOf('async importOcrText(');
    check('T0a importOcrText 存在', start !== -1, true);
    const block = src.slice(start, src.indexOf('\n    },', start));
    const want = ['.filter(w => /^', '[a-z]', "[a-z'-]", '{1', ',30', '}$', '/i.test(w))'].join('');
    check('T0b §5 正則逐字元釘入', block.includes(want), true);
    check('T0c 走 this.importWords（唯一入庫路徑 §5.2，帶 override options）', /await this\.importWords\(parsed[^)]*override/.test(block), true);
    check('T0d 預設 deck＝OCR Inbox', block.includes(`deckName = 'OCR Inbox'`), true);
  }

  // T1 過濾矩陣（樣本避開 OCR 黑名單字——apple/banana 屬 PDF 基礎級，blacklist 已擋，換 neon/zebra 維持白名單過濾測意）
  {
    await resetState(store);
    const dirty = ['Neon', ' ZEBRA ', '3d', 'a', 'cafe?', 'x'.repeat(32),
      "don't", 'well-known', 'UPPER', 'alpha'];
    const res = await store.actions.importOcrText(dirty);
    const words = dbWords().map(r => r.word);
    check('T1 added＝合法去重後 5', res.added, 5);
    check('T1 skipped＝3d/a/超長/cafe?/alpha 重複→5? 不，過濾非 skip', res.skipped, 1);
    check('T1 落盤詞集（正規化＋白名單）', words, ['don\'t', 'neon', 'upper', 'well-known', 'zebra']);
  }

  // T2 入庫語意：deck/definition
  {
    await resetState(store);
    await store.actions.importOcrText(['journey']);
    const row = dbWords().find(r => r.word === 'journey');
    check('T2 deck 預設 OCR Inbox', row?.deck, 'OCR Inbox');
    check('T2 definition 空串（後續 Cambridge 補全 P3）', row?.definition, '');
  }

  // T3 去重：批內＋跨既有
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['alpha', 'star', 'star', 'STAR']);
    check('T3 added＝1（star 批內大小寫重複收斂）', res.added, 1);
    check('T3 skipped＝3（alpha 既有＋star 批內×2）', res.skipped, 3);
    check('T3 decksCreated 含 OCR Inbox', res.decksCreated.includes('OCR Inbox'), true);
  }

  // T4 自訂 deckName
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['quantum'], 'Physics');
    const row = dbWords().find(r => r.word === 'quantum');
    check('T4 deckName 透傳', [res.added, row?.deck], [1, 'Physics']);
  }

  // T5 全垃圾 → 不拋、added=0
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['3d', '!', 'x'.repeat(40)]);
    check('T5 全垃圾 added=0 skipped=0 不拋', [res.added, res.skipped], [0, 0]);
  }

  // PRE 雙態＋NC：NEG＝importOcrText 整段剝除（T4 時點實態）
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const start = src.indexOf('    async importOcrText(');
    const end = src.indexOf('\n    },', start);
    if (start === -1 || end === -1) { console.log('FAIL NC 錨點漂移'); failures++; }
    else {
      const stripped = src.slice(0, start) + src.slice(end + '\n    },'.length);
      if (stripped.includes('importOcrText')) { console.log('FAIL NC 剝除不完全'); failures++; }
      fs.writeFileSync(NEG_TMP, stripped);
      try {
        const { createStore: createNeg } = await import('../src/lib/.ocr-import-neg-control.js');
        const negStore = createNeg();
        await negStore.actions.init();
        let tError = null;
        try { await negStore.actions.importOcrText(['neon']); } catch (e) { tError = e.constructor.name; }
        check('PRE/NC 剝除後呼叫 TypeError（測敏感＝T4 時點紅態重現）', tError, 'TypeError');
        await resetState(negStore);
        const ok = await negStore.actions.importWords([{ word: 'foxtrot', deck: 'Default' }]);
        check('NC 反換釘：NEG importWords 正常綠（NC 只打 OCR 路徑）', ok.added, 1);
      } finally {
        if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);
      }
    }
  }

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('[harness error]', e); process.exit(2); });
