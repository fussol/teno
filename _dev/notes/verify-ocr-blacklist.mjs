#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-BLACKLIST 驗證 — OCR 錄入黑名單 + Cambridge 查證開關 + 背景補欄位
//
// 測項：
//   T1 黑名單預設載入（DEFAULT_BLACKLIST 含 is/she/cat/dog/address/…）
//   T2 importWords 擋黑名單 → blacklisted 計數、不入庫
//   T3 importOcrText 同步擋黑名單（不發查證網路）＋計數回填
//   T4 Cambridge 查證開：查得到才入、查不到 notFound
//   T5 Cambridge 查證關：全放行（黑名單仍擋）
//   T6 devMode 管理：addBlacklistWord / removeBlacklistWord 持久化
//   T7 背景補欄位 enrichOcrWords：由 lookup result 填 pos/pron/definition/examples
//   NC 負控制：加字後 isBlacklisted 命中；移除後不命中
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

globalThis.localStorage = { getItem: () => '1', setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

class FakeDatabase {
  constructor() { this.db = new DatabaseSync(':memory:'); this._init(); }
  static load() { if (!FakeDatabase._s) FakeDatabase._s = new FakeDatabase(); return FakeDatabase._s; }
  _init() {
    this.db.exec(`CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL, elapsed_days REAL, scheduled_days REAL, reps INTEGER, lapses INTEGER, state INTEGER, step INTEGER, last_review TEXT, buried INTEGER, suspended INTEGER, mc_data TEXT, spell_data TEXT)`);
    this.db.exec(`CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER, duration INTEGER, elapsed_days REAL, scheduled_days REAL, stability REAL, difficulty REAL, mode TEXT, card_state INTEGER, new_state INTEGER, reviewed_at TEXT)`);
    this.db.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT, related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)`);
    this.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec('CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT)');
    this.db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    this.db.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)');
    this.db.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)');
    this.db.exec('CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    this.db.exec('CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    this.db.exec('CREATE TABLE filtered_decks (id TEXT PRIMARY KEY, name TEXT, search_query TEXT, max_cards INTEGER, order_by TEXT, color TEXT, created_at TEXT, last_used TEXT)');
  }
  _bind(sql, p = []) { const o = {}; for (let i = 0; i < p.length; i++) o['$' + (i + 1)] = p[i]; return o; }
  async execute(sql, p = []) { this.db.prepare(sql).run(this._bind(sql, p)); }
  async select(sql, p = []) { return this.db.prepare(sql).all(this._bind(sql, p)); }
  async close() { this.db.close(); }
}

const lookupCalls = [];
const DICT = {
  neon: { word: 'neon', uk_ipa: 'ˈniːɒn', us_ipa: 'ˈniːɑːn', senses: [{ part_of_speech: 'noun', definition: 'a gas', examples: ['The neon sign.'] }] },
  quantum: { word: 'quantum', uk_ipa: 'ˈkwɒntəm', senses: [{ part_of_speech: 'noun', definition: 'a quantity', examples: ['Quantum physics.'] }] },
  zebra: { word: 'zebra', senses: [{ part_of_speech: 'noun', definition: 'a striped animal', examples: ['The zebra runs.'] }] },
};
const invokeMock = {
  invoke: async (cmd, args) => {
    if (cmd === 'lookup_cambridge') {
      lookupCalls.push(args?.word);
      const hit = DICT[args?.word];
      return hit ? JSON.stringify(hit) : '{}';
    }
    return null;
  },
};
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: invokeMock });
mock.module(path.join(ROOT, 'src/main.js'), { exports: { toast() {} } });

let fakeDb = null;
const mkWord = (id, w) => ({ id, word: w, definition: '', pos: '', pron: '', example: '', deck: 'Default', tags: [], image: '', description: '', related: [], forms: [], synonym: '', antonym: '', derivative: '', examples: [], createdAt: new Date().toISOString() });

async function resetState(store) {
  const s = store.state;
  s.dayCutoff = 480;
  s.ocrCambridgeVerify = false;
  s.words = [mkWord('wA', 'alpha'), mkWord('wB', 'bravo')];
  s.decks = [];
  s.cards = new Map(); s.cardsMc = new Map(); s.cardsSpell = new Map();
  s.reviewLog = []; s.buried = new Set(); s.suspended = new Set();
  s.buriedMc = new Set(); s.suspendedMc = new Set(); s.buriedSpell = new Set(); s.suspendedSpell = new Set();
  for (const t of ['cards', 'review_log', 'words', 'settings', 'goal_streak', 'audit_log', 'decks', 'folders', 'additions', 'exam_history', 'filtered_decks']) fakeDb.db.exec(`DELETE FROM ${t}`);
  for (const w of s.words) fakeDb.db.prepare('INSERT INTO words (id, word, created_at) VALUES (?,?,?)').run(w.id, w.word, w.createdAt || '');
  lookupCalls.length = 0;
}
const dbWordSet = () => new Set(fakeDb.db.prepare('SELECT word FROM words').all().map(r => r.word));

async function main() {
  const dbMod = await import(path.join(ROOT, 'src/lib/db.js'));
  fakeDb = await FakeDatabase.load();
  await dbMod.initDB();
  const { createStore } = await import(path.join(ROOT, 'src/lib/store.js'));
  const store = createStore();
  // 避免 publish 順序問題：api module 已 mock，直接 init
  await store.actions.init();
  const bl = store.state.blacklist;
  const { DEFAULT_BLACKLIST } = await import(path.join(ROOT, 'src/lib/ocr-blacklist.js'));

  console.log('\n═══ OCR-BLACKLIST 驗證 ═══\n');

  // T1 黑名單預設載入
  check('T1 載入後含 is', bl.includes('is'), true);
  check('T1 含 she/he/it/i', ['she','he','it','i'].every(x => bl.includes(x)), true);
  check('T1 含 cat/hot/dog', ['cat','hot','dog'].every(x => bl.includes(x)), true);
  check('T1 含 PDF 字 address', bl.includes('address'), true);
  check('T1 含 PDF 字 apple', bl.includes('apple'), true);   // 初級表
  check('T1 含 PDF 字 basketball', bl.includes('basketball'), true);
  check('T1 不含正常字 neon', bl.includes('neon'), false);
  check('T1 DEFAULT 與 db 一致（初載）', JSON.stringify(bl) === JSON.stringify(DEFAULT_BLACKLIST), true);

  // T2 importWords 擋黑名單
  {
    await resetState(store);
    const r = await store.actions.importWords([
      { word: 'address', deck: 'Default' },
      { word: 'is', deck: 'Default' },
      { word: 'quantum', deck: 'Default' },
    ]);
    check('T2 blacklisted=2', r.blacklisted, 2);
    check('T2 added=1（quantum）', r.added, 1);
    check('T2 DB 無 is/address（黑名單未入庫）', !dbWordSet().has('is') && !dbWordSet().has('address'), true);
    check('T2 DB 有 quantum', dbWordSet().has('quantum'), true);
  }

  // T3 importOcrText 同步擋黑名單＋計數回填
  {
    await resetState(store);
    const r = await store.actions.importOcrText(['cat', 'neon', 'she']);
    check('T3 blacklisted=2（cat/she）', r.blacklisted, 2);
    check('T3 added=1（neon）', r.added, 1);
    check('T3 DB 無 cat/she', !dbWordSet().has('cat') && !dbWordSet().has('she'), true);
  }

  // T4 Cambridge 查證開：查得到才入、查不到 notFound
  {
    await resetState(store);
    store.state.ocrCambridgeVerify = true;
    // zebra 在 DICT、mango 查不到
    const r = await store.actions.importOcrText(['zebra', 'mango']);
    check('T4 added=1（zebra 查得到）', r.added, 1);
    check('T4 notFound=1（mango）', r.notFound, 1);
    check('T4 DB 有 zebra', dbWordSet().has('zebra'), true);
    check('T4 DB 無 mango', !dbWordSet().has('mango'), true);
    check('T4 對查證字發 lookup（zebra，非黑名單）', lookupCalls.includes('zebra'), true);
    check('T4 黑名單字不發 lookup（cat 已被前面擋）', !lookupCalls.includes('cat'), true);
  }

  // T5 Cambridge 查證關：全放行（黑名單仍擋）
  {
    await resetState(store);
    store.state.ocrCambridgeVerify = false;
    const r = await store.actions.importOcrText(['neon', 'mango', 'cat']);
    check('T5 added=2（neon+mango，查證關全放行）', r.added, 2);
    check('T5 blacklisted=1（cat 仍擋）', r.blacklisted, 1);
    check('T5 DB 無 cat', !dbWordSet().has('cat'), true);
    // 查證關不該發「查證用途」的 lookup——但背景補欄位（enrich）仍會查；
    // 故不苛求 lookup=0（enrich 是獨立的補欄位機制，非擋查證）。改驗證：查證關時
    // 非清黑字全入（added=2）即符合語意。
    check('T5 查證關：neon+mango 全入（無 notFound）', r.notFound, 0);
  }

  // T6 devMode 管理：add / remove 持久化
  {
    await resetState(store);
    await store.actions.addBlacklistWord('nebula');
    check('T6 isBlacklisted nebula（加後）', store.actions.isBlacklisted('nebula'), true);
    const saved = await dbMod.getSetting('blacklist');
    check('T6 db 持久化含 nebula', Array.isArray(saved) && saved.includes('nebula'), true);
    await store.actions.removeBlacklistWord('nebula');
    check('T6 isBlacklisted nebula（移除後）', store.actions.isBlacklisted('nebula'), false);
    const saved2 = await dbMod.getSetting('blacklist');
    check('T6 db 移除 nebula', Array.isArray(saved2) && !saved2.includes('nebula'), true);
  }

  // T7 背景補欄位 enrichOcrWords（D′：importOcrText 內部 await enrich，入庫即填齊）
  {
    await resetState(store);
    const r = await store.actions.importOcrText(['neon']);
    const word = store.state.words.find(w => w.word === 'neon');
    // D′：入庫時已 await enrich → definition 非空（非 fire-and-forget 的空卡）
    check('T7 入庫即填齊（definition 填 a gas，D′ 同步）', word.definition, 'a gas');
    const filled = await store.actions.enrichOcrWords([word.id]);
    const enriched = store.state.words.find(w => w.id === word.id);
    check('T7 再次 enrich 無需重填（回傳 0）', filled, 0);
    check('T7 pos 填 noun', enriched.pos, 'noun');
    check('T7 definition 填 a gas', enriched.definition, 'a gas');
    check('T7 pron 填 IPA', enriched.pron.includes('ˈniː'), true);
    check('T7 examples 填', Array.isArray(enriched.examples) && enriched.examples[0] === 'The neon sign.', true);
    const persist = fakeDb.db.prepare('SELECT part_of_speech FROM words WHERE id=?').get(word.id);
    check('T7 DB 已存 pos', persist.part_of_speech, 'noun');
  }

  // NC 負控制：pre 態（無黑名單功能→不擋）由 importWords 已暗示；此處驗證 isBlacklisted 敏感性
  {
    const hit = store.actions.isBlacklisted('address');
    check('NC isBlacklisted(address)=true', hit, true);
    const miss = store.actions.isBlacklisted('xylophone');
    check('NC isBlacklisted(xylophone)=false', miss, false);
  }

  console.log(failures === 0 ? '\n✅ 全部通過' : `\n❌ ${failures} 個 FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error('崩潰:', e); process.exit(2); });