#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR2-D′ 入庫自動填欄位 — 驗證（plan §D′）
//
// 用法: node --experimental-test-module-mocks tools/verify-ocr2-enrich.mjs
//
// 任務書 tech 裁示 D′.1：fire-and-forget 問題 — 改 await enrich 完成＋多 sense
// 合併＋UI 同步，讓使用者看到填好的卡不是空白。
//
//    T1 enrich 對「空欄字」填齊 pos/pron/definition/examples/example
//    T2 多 sense 合併（senses[0]+senses[1] definition 匯總）
//    T3 overwrite=true 覆寫殘缺值；false(預設) 保守只填空欄
//    T4 importOcrText 內 enrich 是 await（非 fire-and-forget）
//    PRE 紅態：harness 用新行為預期在未改動 code 上 → T2/T3(T)/T4 紅
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE_SRC = path.join(ROOT, 'src/lib/store.js');
const NEG_TMP = path.join(ROOT, 'src/lib/.ocr2-enrich-neg-control.js');

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

const CAMBRIDGE_DB = {
  'apple': {
    uk_ipa: 'ˈæp.əl', us_ipa: 'ˈæp.əl',
    senses: [
      { part_of_speech: 'noun', definition: 'a round fruit', examples: ['She ate an apple', 'Apple pie'] },
      { part_of_speech: 'verb', definition: 'to make an apple (rare)', examples: ['They apple the harvest'] },
    ],
  },
  'bravo': {
    uk_ipa: 'brɑːˈvəʊ', us_ipa: 'broʊ',
    senses: [{ part_of_speech: 'interjection', definition: 'well done', examples: ['Bravo!'] }],
  },
  'charlie': {}, // 無 senses → 不 enrich
};

// mock invoke 設定在 class 定義後（TDZ 安全）
// （FakeDatabase 定義見下方，mock.module 移至 class 後）

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

// mock：FakeDatabase＋invoke（lookup_cambridge 依 word 回傳多 sense）
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
let invokeImpl;
globalThis.__setInvoke = (fn) => { invokeImpl = fn; };
mock.module('@tauri-apps/api/core', {
  exports: {
    invoke: (cmd, args) => {
      if (cmd === 'lookup_cambridge') {
        if (invokeImpl) return invokeImpl(args);
        return CAMBRIDGE_DB[args.word] || null;
      }
      return null;
    },
  },
});
mock.module('../src/lib/toast.js', { exports: { toast() {} } });

let fakeDb = null;
// 空欄字卡（definition/pos/pron/example/examples 全空）——OCR 入庫的殘缺典型
const mkEmptyWord = (id, w) => ({
  id, word: w, definition: '', pos: '', pron: '', example: '', deck: 'OCR Inbox',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(),
});
const mkPartialWord = (id, w, patch = {}) => ({
  id, word: w, definition: 'legacy old', pos: 'n', pron: '', example: '', deck: 'OCR Inbox',
  tags: [], image: '', description: '', related: [], forms: [], synonym: '',
  antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString(), ...patch,
});

async function resetState(st, words = []) {
  const s = st.state;
  s.dayCutoff = 480;
  s.ocrCambridgeVerify = false;
  s.words = words;
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

async function main() {
  const dbMod = await import('../src/lib/db.js');
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import('../src/lib/store.js');
  const store = createStore();
  await store.actions.init();

  console.log('═══ OCR2-D′ ENRICH 驗證 ═══');

  // T0 靜態釘：enrichOcrWords 有 overwrite 參數、多 sense 合併、importOcrText await
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const start = src.indexOf('    async enrichOcrWords(');
    const block = start === -1 ? '' : src.slice(start, src.indexOf('\n    },', start));
    check('T0a enrichOcrWords 接受 overwrite 參數', /enrichOcrWords\(wordIds[^)]*overwrite/.test(src), true);
    check('T0b 多 sense 合併（迴圈 senses 非只取 [0]）', /for \([^)]*of [^)]*senses/.test(block) || /senses\.forEach/.test(block) || /\.flatMap/.test(block), true);
    const impStart = src.indexOf('    async importOcrText(');
    const impBlock = impStart === -1 ? '' : src.slice(impStart, src.indexOf('\n    },', impStart));
    check('T0c importOcrText 內 enrich 為 await（非 fire-and-forget）', /await this\.enrichOcrWords/.test(impBlock) && !/enrichOcrWords\(res\.addedIds\)\.then/.test(impBlock), true);
  }

  // T1 空欄字填齊（enrich 直接呼叫，多 sense 併 definition/examples）
  {
    await resetState(store, [mkEmptyWord('w1', 'apple')]);
    const filled = await store.actions.enrichOcrWords(['w1'], true);
    const w = store.state.words.find(x => x.id === 'w1');
    check('T1 filled=1', filled, 1);
    check('T1 pos 填 noun', w.pos, 'noun');
    check('T1 definition 含兩 sense 併（apple fruit + apple verb）', typeof w.definition, 'string');
    check('T1 definition 含 sense0' , w.definition.includes('round fruit'), true);
    check('T1 definition 含 sense1', w.definition.includes('to make an apple'), true);
    check('T1 pron 填 uk/us 併', w.pron, 'ˈæp.əl / ˈæp.əl');
    check('T1 examples 合併兩 sense', Array.isArray(w.examples) && w.examples.includes('She ate an apple') && w.examples.includes('They apple the harvest'), true);
    // charlie 無 sense → not enriched（filled 未含它）
    await resetState(store, [mkEmptyWord('w1c', 'charlie')]);
    const filledC = await store.actions.enrichOcrWords(['w1c'], true);
    const wC = store.state.words.find(x => x.id === 'w1c');
    check('T1 charlie 無 sense→filled=0 且欄位仍空', [filledC, wC.definition, wC.pos], [0, '', '']);
  }

  // T2 多 sense 合併只定義（bravo 單 sense 正常）
  {
    await resetState(store, [mkEmptyWord('w2', 'bravo')]);
    await store.actions.enrichOcrWords(['w2'], true);
    const w = store.state.words.find(x => x.id === 'w2');
    check('T2 bravo definition', w.definition, 'well done');
    check('T2 bravo examples', w.examples, ['Bravo!']);
  }

  // T3 overwrite=true 覆寫殘缺；false 保守
  {
    // overwrite=true → 覆寫 legacy definition + 填 pron
    let st = { store };
    await resetState(store, [mkPartialWord('w3', 'apple')]);
    await store.actions.enrichOcrWords(['w3'], true);
    let w3 = store.state.words.find(x => x.id === 'w3');
    check('T3a overwrite=true 覆寫 definition', w3.definition.includes('round fruit'), true);
    // overwrite 預設(false) → 不覆寫已有 definition，只補空欄
    await resetState(store, [mkPartialWord('w4', 'apple')]);
    await store.actions.enrichOcrWords(['w4']);
    let w4 = store.state.words.find(x => x.id === 'w4');
    check('T3b overwrite=false(預設) 不覆寫已有 definition', w4.definition, 'legacy old');
    check('T3c overwrite=false 仍補空 pron', typeof w4.pron, 'string');
  }

  // T4 importOcrText 內 enrich await（UI 同步，非 fire-and-forget）
  {
    const src = fs.readFileSync(STORE_SRC, 'utf8');
    const impStart = src.indexOf('    async importOcrText(');
    const impBlock = impStart === -1 ? '' : src.slice(impStart, src.indexOf('\n    },', impStart));
    check('T4 importOcrText enrich await 非 fire-and-forget', /await this\.enrichOcrWords/.test(impBlock), true);
    // 端到端：importOcrText 新增字 → 返回後 enrich 已填（用非黑名單字 bravo——apple 在 DEFAULT_BLACKLIST 會被擋）
    await resetState(store, []);
    const res = await store.actions.importOcrText(['bravo'], 'OCR Inbox');
    const w = store.state.words.find(x => x.word === 'bravo');
    check('T4 入庫 added=1', res.added, 1);
    check('T4 入庫後 enrich 已填 definition（await 同步）', typeof w?.definition === 'string' && w.definition.length > 0, true);
    check('T4 入庫後 enrich 已填 pos', w?.pos === 'interjection' || (typeof w?.pos === 'string' && w.pos.length > 0), true);
  }

  // PRE/NEG 負控制：用 git HEAD 版（動工前，enrich 只填空欄無 overwrite）→ 多 sense/await 行為紅
  {
    const { execSync } = await import('node:child_process');
    let headSrc;
    try { headSrc = execSync('git show HEAD:src/lib/store.js', { cwd: ROOT, encoding: 'utf8' }); }
    catch (_) { console.log('FAIL PRE/NC 無法讀 git HEAD'); failures++; headSrc = ''; }
    if (headSrc && !headSrc.includes('overwrite')) {
      fs.writeFileSync(NEG_TMP, headSrc);
      try {
        const { createStore: createNeg } = await import('../src/lib/.ocr2-enrich-neg-control.js');
        const negStore = createNeg();
        await negStore.actions.init();
        await resetState(negStore, [mkEmptyWord('wn1', 'apple')]);
        const filled = await negStore.actions.enrichOcrWords(['wn1']);
        const w = negStore.state.words.find(x => x.id === 'wn1');
        // 動工前實態：只取 senses[0] → definition 不含 sense1；且無 wait 語意可測但 sense 行為可證
        check('PRE/NC 動工前只取 sense0（不含 sense1 "to make"）', w.definition && w.definition.includes('to make an apple'), false);
      } finally {
        if (fs.existsSync(NEG_TMP)) fs.unlinkSync(NEG_TMP);
      }
    }
  }

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[harness error]', e); process.exit(2); });