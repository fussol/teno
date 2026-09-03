#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-IMP 驗證 — store.importWords DB 失敗幽靈入庫修復（txFailed→added=0）
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-ocr-imp.mjs
//
// Bug（計畫書 v1.3 §6.2a 實錘）: store.js importWords 於 newWords 入列時
//   `added++` 已累加；事務內 saveWord 拋錯 → ROLLBACK 後 catch 僅 console.warn，
//   仍回傳 added>0 = 幽靈成功（DB 零落盤但呼叫端 import.js 顯示「新增 N 字」）。
//
// 修法（計畫書 diff）: txFailed 旗標 → ROLLBACK 分支設 true →
//   `if (txFailed) { added = 0; }`。skip/deck 計數不受波及。
//
// 測試設計（真實 store + FakeDatabase，沿用 a10 harness；failInsert 於
//   最低層 execute() 攔截 INSERT INTO words 模擬 DB 寫入中斷）:
//   T0  靜態釘：importWords 區塊含 txFailed 三要素（防呆錨，非充分條件）
//   T1  DB 失敗路徑：3 新字 + 1 重複字，saveWord 拋錯
//       → added=0（幽靈消除）＋ skipped 不受波及（=1）＋ decksCreated 保留
//   T2  成功路徑零回歸：3 新字全入 → added=3 且 DB 實查 3 行
//   T3  負控制：剝除 `if (txFailed) { added = 0; }`（寫入 .ocr-imp-neg-control.js
//       匯入）→ 同一失敗場景必須再現 added=3 幽靈（測試對修法敏感）
//   T4  負控制反換釘：NEG 檔成功路徑 added=3 仍正確（NC 只對失敗態敏感）
// 雙態：修法前跑 T1 FAIL（PRE 紅）；修法後全綠（POST）。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.ocr-imp-neg-control.js');

let failures = 0;
let expectedFail = false; // T3/T4 負控制其「PASS」= bug 再現
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

// ── harness（沿用 a10：FakeDatabase 實 sqlite :memory: + failInsert 攔截）──
globalThis.localStorage = {
  getItem: (k) => (k === 'teno_no_seed' ? '1' : null),
  setItem: () => {}, removeItem: () => {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };

class FakeDatabase {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.failInsert = false; // T1/T3: 模擬 DB 寫入中斷（saveWord 底層 execute 拋錯）
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
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

let store = null;
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
  s.decks = []; // 清 deck 殘留（上輪 importWords/OCR Inbox 會污染 decksCreated 斷言）
  s.cards = new Map(); s.cardsMc = new Map(); s.cardsSpell = new Map();
  s.reviewLog = [];
  s.buried = new Set(); s.suspended = new Set();
  s.buriedMc = new Set(); s.suspendedMc = new Set();
  s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) {
    fakeDb.db.exec(`DELETE FROM ${t}`);
  }
  // 既有兩字落盤（skipped 判定來源）
  for (const w of s.words) {
    fakeDb.db.prepare('INSERT INTO words (id, word, created_at) VALUES (?, ?, ?)').run(w.id, w.word, w.createdAt);
  }
}

const dbWordCount = () => fakeDb.db.prepare('SELECT COUNT(*) AS c FROM words').get().c;

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  store = createStore();
  await store.actions.init();

  console.log('\n═══ OCR-IMP importWords 幽靈入庫修復 驗證 ═══');

  // ── T0 靜態釘（防呆錨：修法三要素存在 importWords 區塊內）──
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const impStart = src.indexOf('async importWords(');
    if (impStart === -1) throw new Error('[harness] store.js 找不到 importWords');
    const block = src.slice(impStart, src.indexOf('async editWord(', impStart));
    check('T0a txFailed 宣告存在', /let txFailed = false;/.test(block), true);
    check('T0b ROLLBACK 分支設 txFailed', /txFailed = true;/.test(block), true);
    check('T0c txFailed→added=0 存在', /if \(txFailed\) \{\s*[^}]*added = 0;?[^}]*\}/.test(block), true);
    check('T0d D15 rollback：tx 失敗回滾 state.words 新字', /if \(txFailed\) \{[\s\S]*state\.words = state\.words\.filter\(w => !newIds\.has\(w\.id\)\)[\s\S]*\}/.test(block), true);
  }

  // ── T1 DB 失敗路徑：added=0、skipped 不受波及、DB 零新行 ──
  {
    await resetState(store);
    fakeDb.failInsert = true;
    const res = await store.actions.importWords([
      { word: 'bravo', definition: 'dup' },      // 與既有 wB 重複 → skipped
      { word: 'charlie', deck: 'OCR Inbox' },
      { word: 'delta', deck: 'OCR Inbox' },
      { word: 'echo', deck: 'OCR Inbox' },
    ]);
    fakeDb.failInsert = false;
    check('T1 失敗事務回傳 added=0（幽靈消除）', res.added, 0);
    check('T1 skipped 不受波及', res.skipped, 1);
    check('T1 DB 實查零新行（words 仍 2）', dbWordCount(), 2);
    // 消費者 import.js 讀 res.added 顯示 → 0 筆「新增」訊息正確
  }

  // ── T2 成功路徑零回歸 ──
  {
    await resetState(store);
    const res = await store.actions.importWords([
      { word: 'charlie', deck: 'OCR Inbox' },
      { word: 'delta', deck: 'OCR Inbox' },
      { word: 'echo', deck: 'OCR Inbox' },
    ]);
    check('T2 成功路徑 added=3', res.added, 3);
    check('T2 DB 實查 2+3=5 行', dbWordCount(), 5);
    check('T2 decksCreated 含 OCR Inbox', res.decksCreated.includes('OCR Inbox'), true);
  }

  // ── T3 負控制：剝除 txFailed→added=0 → 幽靈必再現 ──
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const stripped = src.replace(/if \(txFailed\) \{[\s\S]*?state\.words = state\.words\.filter\(w => !newIds\.has\(w\.id\)\)[\s\S]*?added = 0;[\s\S]*?\n\s*\}/, '/* NEG: D15 rollback stripped */');
    if (stripped === src) throw new Error('[harness] 找不到 D15 rollback 錨（修法已漂移？更新 NC）');
    fs.writeFileSync(NEG_TMP, stripped);
    try {
      const { createStore: createNegStore } = await import('../src/lib/.ocr-imp-neg-control.js');
      const negStore = createNegStore();
      await negStore.actions.init();
      await resetState(negStore);
      fakeDb.failInsert = true;
      const res = await negStore.actions.importWords([
        { word: 'bravo', definition: 'dup' },
        { word: 'charlie', deck: 'OCR Inbox' },
        { word: 'delta', deck: 'OCR Inbox' },
        { word: 'echo', deck: 'OCR Inbox' },
      ]);
      fakeDb.failInsert = false;
      check('T3 負控制：剝除後 added=3 幽靈再現（測試敏感）', res.added, 3);
      check('T3 負控制：DB 實查仍 2 行（幽靈=回報與落盤不一致）', dbWordCount(), 2);
      // T4 反換釘：NEG 成功路徑不誤傷
      await resetState(negStore);
      const ok = await negStore.actions.importWords([{ word: 'foxtrot', deck: 'Default' }]);
      check('T4 NC 成功路徑 added=1（NC 只打失敗態）', ok.added, 1);
    } finally {
      if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);
    }
  }

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[harness error]', e); process.exit(2); });
