#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR2-C 黑灰名單 override 強制加入 — 驗證（plan §C.5）
//
// 用法: node --experimental-test-module-mocks tools/verify-ocr2-override.mjs
//
// 任務書 tech 裁示 C.6 高風險：override 雙層漏傳（importOcrText 漏 importWords
// → 字被第二道擋，bug 半解）。此 harness 負控制專門測 importWords 層。
//
//    T1 override 字入庫成功（cat）＋非 override 仍擋（dog）＋正常字加入（apple）
//    T2 override 空集 → cat/dog 都擋（現況重現）
//    T3 NEG 負控制：剝除 override 參數(undefined) → cat 又擋回（重現原 bug）
//    T4 importWords 第二道層：直接呼叫 importWords 帶 override → 跳過黑灰
//    T5 UI 靜態釘：ocr.js 有 isBlacklisted/isGraylisted badge + override 透傳
//    PRE 紅態：harness 用新 API(第三參數 override) 在未改動 code 上 → T1/T4 紅
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const OCR_SRC = path.join(ROOT, 'src/pages/ocr.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.ocr2-override-neg-control.js');

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

// enrich 不打真網路（fire-and-forget 會查 Cambridge）→ 透過 mock @tauri-apps/api/core
// invoke 全空（lookupCambridge 走 invoke→undefined→data 非 array→continue 不炸）
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
  s.ocrCambridgeVerify = false;
  s.blacklist = ['cat'];
  s.graylist = ['dog'];
  s.words = [mkWord('wBase', 'baseline')];
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

  console.log('═══ OCR2-C OVERRIDE 驗證 ═══');

  // T0 靜態釘：override 參數存在於 importOcrText 且透傳 importWords
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const start = src.indexOf('    async importOcrText(');
    const block = start === -1 ? '' : src.slice(start, src.indexOf('\n    },', start));
    check('T0a importOcrText 接受 options 參數(override)', /importOcrText\(rawWords,\s*deckName\s*=\s*'OCR Inbox',\s*options\s*\)/.test(src) || /importOcrText\([^)]*options/.test(src), true);
    check('T0b 黑灰剔除含 override 豁免', block.includes('override') && block.includes('blSet.has(w)'), true);
    check('T0c importWords 呼叫透傳 options', /importWords\(parsed[^)]*override/.test(block), true);
  }

  // T1 override 字入庫成功、非 override 仍擋、正常字加入
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['cat', 'dog', 'apple'], 'OCR Inbox', { override: new Set(['cat']) });
    const words = dbWords().map(r => r.word);
    check('T1 added＝2（apple 正常＋cat override 入庫）', res.added, 2);
    check('T1 blacklisted＝1（僅 dog 未 override 被擋）', res.blacklisted, 1);
    check('T1 cat 真入庫', words.includes('cat'), true);
    check('T1 dog 沒入庫', words.includes('dog'), false);
    check('T1 apple 真入庫', words.includes('apple'), true);
  }

  // T2 override 空集 → cat/dog 皆擋（現況重現）
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['cat', 'dog', 'apple'], 'OCR Inbox', { override: new Set() });
    const words = dbWords().map(r => r.word);
    check('T2 added＝1（僅 apple）', res.added, 1);
    check('T2 blacklisted＝2（cat+dog）', res.blacklisted, 2);
    check('T2 cat 沒入庫', words.includes('cat'), false);
    check('T2 dog 沒入庫', words.includes('dog'), false);
  }

  // T3 NEG 負控制：剝除 override 參數(undefined) → cat 又擋回（重現原 bug）
  {
    await resetState(store);
    const res = await store.actions.importOcrText(['cat', 'dog', 'apple'], 'OCR Inbox');
    const words = dbWords().map(r => r.word);
    check('T3 無 override → added＝1（僅 apple）', res.added, 1);
    check('T3 無 override → cat 擋回(blacklisted=2)', res.blacklisted, 2);
    check('T3 cat 沒入庫（原 bug 重現）', words.includes('cat'), false);
  }

  // T4 importWords 第二道層：直接呼叫帶 override → 跳過黑灰（C.6 高風險必測）
  {
    await resetState(store);
    const res = await store.actions.importWords(
      [{ word: 'cat', deck: 'OCR Inbox' }, { word: 'dog', deck: 'OCR Inbox' }, { word: 'apple', deck: 'OCR Inbox' }],
      undefined, { override: new Set(['cat']) });
    const words = dbWords().map(r => r.word);
    check('T4 importWords added＝2（apple＋cat override）', res.added, 2);
    check('T4 importWords blacklisted＝1（dog 未 override）', res.blacklisted, 1);
    check('T4 cat 真入庫（override 過第二道）', words.includes('cat'), true);
    check('T4 dog 被第二道擋', words.includes('dog'), false);
  }

  // T5 UI 靜態釘：ocr.js 候選 render 標黑灰 badge + 入庫組 override 透傳
  {
    const src = fs.readFileSync(OCR_SRC, 'utf8');
    check('T5a render 有 isBlacklisted badge', /isBlacklisted\?\./.test(src) || /isBlacklisted\s*\(/.test(src), true);
    check('T5b render 有 isGraylisted badge', /isGraylisted\?\./.test(src) || /isGraylisted\s*\(/.test(src), true);
    check('T5c 入庫組 override（new Set）', /override\s*:\s*new Set\(/.test(src), true);
    check('T5d importOcrText 呼叫帶 override', /importOcrText\([^)]*override/.test(src), true);
  }

  // PRE/NEG 雙態：NEG＝用 git HEAD 版 store.js（動工前實態，無 override 支援）
  //   → override 行為紅（重現原 bug「重疊字無法強制加入」）
  {
    // 動工前實態從 git HEAD 讀（最忠實的負控制：override 邏輯完全不存在）
    const { execSync } = await import('node:child_process');
    let headSrc;
    try { headSrc = execSync('git show HEAD:src/lib/store.js', { cwd: ROOT, encoding: 'utf8' }); }
    catch (_) { console.log('FAIL PRE/NC 無法讀 git HEAD store.js'); failures++; headSrc = ''; }
    if (headSrc && !headSrc.includes('options.override')) {
      fs.writeFileSync(NEG_TMP, headSrc);
      try {
        const { createStore: createNeg } = await import('../src/lib/.ocr2-override-neg-control.js');
        const negStore = createNeg();
        await negStore.actions.init();
        await resetState(negStore);
        const res = await negStore.actions.importOcrText(['cat', 'dog', 'apple'], 'OCR Inbox', { override: new Set(['cat']) });
        check('PRE/NC 動工前實態→override 被無視、cat 擋回（測敏感＝原 bug 重現）', res.blacklisted, 2);
        const words2 = dbWords2();
        check('PRE/NC cat 未入庫', words2.includes('cat'), false);
      } finally {
        if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);
      }
    }
  }

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

// PRE 段用「當前 fakeDb 的 words 表」
function dbWords2() { return fakeDb.db.prepare('SELECT word FROM words').all().map(r => r.word); }

main().catch(e => { console.error('[harness error]', e); process.exit(2); });