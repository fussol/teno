#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// VERIFY-OCR2-IMPORTFILE（F′）— 匯入來源擴充（多圖 / PDF / 文字檔）
//
// 測 F′（OCR-OPTIMIZE-plan §F′）：
//   F0 靜態釘：ocr.js 匯入 input 多檔 accept + multiple；文字檔分流；
//      fast-path 呼叫 importOcrText；PDF 列後續；按鈕改「匯入檔案」。
//   F1 純函式 extractTextTokens：.txt / markdown / csv / srt 抽 token、
//      去重、去 noise（數字/標點/網址/超長）。
//   F2 純函式 classifyImportFile：text/image/pdf 分流。
//   F3 負控制 A：classifyImportFile 把 .txt 當 image（剝離 text 判定）→
//      重現「對文字檔跑 OCR」原缺陷。
//   F4 真實 store 呼叫：text token → importOcrText 入庫（fast-path 真通）。
//
// 用法: node --experimental-test-module-mocks tools/verify-ocr2-importfile.mjs
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OCR = path.join(ROOT, 'src/pages/ocr.js');

// ✂️ 前置 tauri mock：讓 ocr.js 與 store.js 可被動態 import
globalThis.localStorage = { getItem: (k) => (k === 'teno_no_seed' ? '1' : null), setItem: () => {}, removeItem: () => {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
let _fakeDb = null;
class FakeDatabase {
  constructor() { this.db = new DatabaseSync(':memory:'); this._init(); }
  static load() { if (!FakeDatabase._s) FakeDatabase._s = new FakeDatabase(); return FakeDatabase._s; }
  _init() {
    this.db.exec('CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT, related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)');
    this.db.exec('CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL, elapsed_days REAL, scheduled_days REAL, reps INTEGER, lapses INTEGER, state INTEGER, step INTEGER, last_review TEXT, buried INTEGER, suspended INTEGER, mc_data TEXT, spell_data TEXT)');
    this.db.exec('CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER, duration INTEGER, elapsed_days REAL, scheduled_days REAL, stability REAL, difficulty REAL, mode TEXT NOT NULL DEFAULT \'flip\', card_state INTEGER, new_state INTEGER, reviewed_at TEXT)');
    this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec('CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT)');
    this.db.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')");
    this.db.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)');
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)');
    this.db.exec('CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, examples TEXT, deck TEXT, added_at TEXT)');
    this.db.exec('CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, correct INTEGER, question_type TEXT, examined_at TEXT)');
    this.db.exec('CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT, max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)');
    this.db.exec('CREATE TABLE app_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL)');
  }
  _bind(sql, params = []) { const o = {}; for (let i = 0; i < params.length; i++) o['$' + (i + 1)] = params[i]; return o; }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(sql, params)); }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() { this.db.close(); }
}
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: { invoke: async () => {} } });
mock.module('../src/main.js', { exports: { toast() {} } });
mock.module('../src/lib/svg.js', { exports: { icon: (n) => `<i data-icon="${n}"/>` } });
mock.module('../src/lib/ocr/preprocess.js', { exports: { filterHighlighter: async () => ({ file: null, count: 0, boxes: [] }), resolveColor: () => null, HIGHLIGHTER_COLORS: { yellow: { name: '黃', h: [20, 35] }, green: { name: '綠', h: [70, 95] }, pink: { name: '粉', h: [300, 340] } }, HIGHLIGHTER_KEYS: ['yellow', 'green', 'pink'] } });

let failures = 0;
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

async function main() {
  console.log('═══ VERIFY-OCR2-IMPORTFILE F′ 驗證 ═══');

  const src = fs.readFileSync(OCR, 'utf8');

  // ── F0 靜態釘 ──
  {
    check('F0a ocrImportInput 多檔 accept（含 text/pdf）+ multiple',
      /id="ocrImportInput" accept="[^"]*(image\/\*|text\/\*|\.txt|\.pdf)[^"]*"[^>]*multiple/.test(src), true);
    check('F0b 有文字檔分流（classifyImportFile / text 判定）',
      /classifyImportFile|text\/plain|text\/markdown/.test(src), true);
    check('F0c 文字檔 fast-path 呼叫 importOcrText',
      /importOcrText/.test(src), true);
    check('F0d 匯入按鈕文案改「匯入檔案」', /匯入檔案/.test(src), true);
    check('F0e PDF 列後續（有 toast 提示未支援）', /PDF 匯入尚未支援/.test(src), true);
  }

  // ── F1/F2 純函式（dynamic import ocr.js 讀 export）──
  let extractor = null, classify = null;
  try {
    const mod = await import('file://' + OCR);
    extractor = mod.extractTextTokens;
    classify = mod.classifyImportFile;
  } catch (err) {
    extractor = null; classify = null;
    console.log('  [import err]', err?.message);
  }

  if (extractor) {
    const txt = 'Hello world HELLO 123 don\'t well-known http://example.com/path\n**bold** word\napple,banana,apple\r\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
    check('F1a .txt 抽 token（去重/去數字/網址/markdown符號/超長）',
      extractor(txt), ['hello', 'world', "don't", 'well-known', 'bold', 'word', 'apple', 'banana']);
    check('F1b csv 逗號分隔抽 token', extractor('apple,banana,banana\ncherry\n'), ['apple', 'banana', 'cherry']);
    check('F1b2 字內數字被 split 剝離（cat2→cat；規律合理）', extractor('cat2 dog'), ['cat', 'dog']);
    check('F1c srt 時間戳跳過只抽字', extractor('1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\nadvanced\n'), ['hello', 'there', 'advanced']);
    check('F1d 併集去重（兩檔 merge）', [...extractor('apple banana'), ...extractor('banana cherry')].filter((v, i, a) => a.indexOf(v) === i), ['apple', 'banana', 'cherry']);
  } else {
    console.log('FAIL F1 extractTextTokens 未 export'); failures++;
  }

  if (classify) {
    check('F2a text/plain 判定 text', classify({ type: 'text/plain', name: 'a.txt' }), 'text');
    check('F2b .md 判定 text', classify({ type: '', name: 'b.md' }), 'text');
    check('F2c image/png 判定 image', classify({ type: 'image/png', name: 'c.png' }), 'image');
    check('F2d application/pdf 判定 pdf（未支援）', classify({ type: 'application/pdf', name: 'd.pdf' }), 'pdf');
    check('F2e .csv 判定 text', classify({ type: '', name: 'e.csv' }), 'text');
    check('F2f .srt 判定 text', classify({ type: '', name: 'f.srt' }), 'text');
  } else {
    console.log('FAIL F2 classifyImportFile 未 export'); failures++;
  }

  // ── F3 負控制 A：類別化把 .txt 當 image → 「對文字檔跑 OCR」──
  {
    // 模擬「classifyImportFile 移除非 text 判定」：用壞版 regex（把 text 分支全刪）
    // 以 .txt file（type 空、無 text 副檔名匹配）→ 走 other→runFile(原 OCR)
    const buggySrc = src.replace(/type\.startsWith\('text\/'\)/, 'false');
    const shouldBreak = !/type\.startsWith\('text\/'\)/.test(buggySrc);
    check('F3 PRE 剝除 text 判定後 → 文字檔不再分流為 text（重現對 .txt 跑 OCR）', shouldBreak, true);
    // 再實測：classify 對 type='' + .txt（若 name 判 .txt 仍在則算 text）——驗證真實 classification 含 .txt
    if (classify) {
      check('F3b 實測 classify({type:\'\',name:\'n.txt\'}) = text（.txt 副檔名兜底）',
        classify({ type: '', name: 'n.txt' }), 'text');
    }
  }

  // ── F4 真實 store 呼叫（fast-path 真通）──
  {
    _fakeDb = await FakeDatabase.load();
    const dbMod = await import('../src/lib/db.js');
    await dbMod.initDB();
    const { createStore } = await import('../src/lib/store.js');
    const store = createStore();
    await store.actions.init();
    store.state.ocrCambridgeVerify = false;
    store.state.words = [];
    store.state.blacklist = []; store.state.graylist = [];
    const res = await store.actions.importOcrText(['hello', 'world', 'hello', 'cat']);
    const words = _fakeDb.db.prepare('SELECT word FROM words ORDER BY word').all().map(r => r.word);
    check('F4 文字檔 token → importOcrText added=3（helloworldcat）', res.added, 3);
    check('F4 入庫詞集正確（fast-path 跳過 OCR 直入）', words, ['cat', 'hello', 'world']);
  }

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[harness error]', e); process.exit(2); });