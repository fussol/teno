#!/usr/bin/env node
// 一輪 OCR 完整輸出盤點：黑名單擋 / Cambridge 查證擋 / 實際入庫 / 補欄位
import { mock } from 'node:test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const tokens = ["listen","to","this","story","have","been","banned","for","criticising","israel","are","we","free","any","more","cenk","uygur's","question","posed","his","followers","on","week","has","some","merit","mr","uygur","and","hasan","piker","two","controversial","american","left-wing","influencers","were","both","blocked","by","the","british","government","from","entering","country","speak","at","sxsw","festival","in","london","oxford","university","decision","is","shabby","behaviour","that","sees","itself","as","birthplace","of","speech","one","fundamental","pillars","liberal","democracy","people","should","be","able","say","think","what","they","want","not","just","right","citizens","it","cultural","norm","eroded","if","speakers","abroad","regularly","turned","away","border","messrs","because","shabana","mahmood","home","secretary","judged","their","presence","may","conducive","public","good","extraordinarily","vague","standard","increasingly","being","used","appears","ban","high-profile","foreigners","whose","views","does","welcome","april","rationale","was","deployed","stop","kanye","west","rapper","with","history","unhinged","nazi","ramblings","which","he","since","apologised","performing","music","cited","justification","blocking","several","far-righters","attending","speaking","rally","organised","tommy","robinson","white-nationalist","rabble-rouser"];

globalThis.localStorage = { getItem: () => '1', setItem() {}, removeItem() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
class FakeDatabase {
  constructor() { this.db = new DatabaseSync(':memory:'); this._init(); }
  static load() { if (!FakeDatabase._s) FakeDatabase._s = new FakeDatabase(); return FakeDatabase._s; }
  _init() {
    const T = (sql) => this.db.exec(sql);
    T(`CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL)`);
    T(`CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT DEFAULT 'flip')`);
    T(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, definition TEXT, part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT, tags TEXT, image TEXT, description TEXT, created_at TEXT, related TEXT, forms TEXT, synonym TEXT, antonym TEXT, derivative TEXT, examples TEXT)`);
    T(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
    T(`CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, dates TEXT)`);
    T(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, action TEXT DEFAULT '', detail TEXT DEFAULT '')`);
    T(`CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT, color TEXT)`);
    T(`CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, color TEXT, deck_ids TEXT)`);
    T(`CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
    T(`CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
    T(`CREATE TABLE filtered_decks (id TEXT PRIMARY KEY)`);
  }
  _bind(sql, p = []) { const o = {}; for (let i = 0; i < p.length; i++) o['$' + (i + 1)] = p[i]; return o; }
  async execute(sql, p = []) { this.db.prepare(sql).run(this._bind(sql, p)); }
  async select(sql, p = []) { return this.db.prepare(sql).all(this._bind(sql, p)); }
  async close() { this.db.close(); }
}
const KNOWN = new Set(['listen','story','ban','criticising','free','any','question','week','merit','two','american','government','country','speak','university','decision','people','right','cultural','abroad','home','public','good','standard','music','history','cited','speaking','blocked','foreigners','views']);
const invokeMock = { invoke: async (cmd, args) => {
  if (cmd === 'lookup_cambridge') {
    const w = args?.word;
    if (!KNOWN.has(w)) return '{}';
    return JSON.stringify({ word: w, uk_ipa: '/'+w+'/', senses: [{ part_of_speech: 'noun', definition: 'def '+w, examples: ['ex '+w+'.'] }] });
  }
  return null;
}};
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
mock.module('@tauri-apps/api/core', { exports: invokeMock });
mock.module(path.join(ROOT, 'src/main.js'), { exports: { toast() {} } });

const fakeDb = await FakeDatabase.load();
const dbMod = await import(path.join(ROOT, 'src/lib/db.js'));
await dbMod.initDB();
const { createStore } = await import(path.join(ROOT, 'src/lib/store.js'));
const store = createStore();
await store.actions.init();
store.state.ocrCambridgeVerify = true;

const blSet = new Set(store.state.blacklist);
const blockedByBl = tokens.filter(t => blSet.has(t));
const passedBl = tokens.filter(t => !blSet.has(t));
const notFound = passedBl.filter(t => !KNOWN.has(t));
const addedGuess = passedBl.filter(t => KNOWN.has(t));

console.log('═══ 一輪 OCR（153 token，去重後）流出盤點 ═══\n');
console.log(`【1】黑名單擋掉 ${blockedByBl.length} 個（功能詞＋草漯檢定詞＋簡單字）:`);
console.log('  ' + blockedByBl.join(', ') + '\n');
console.log(`【2】過黑名單 ${passedBl.length} 個 → 進 Cambridge 查證`);
console.log(`   ├─ 查不到/專名被擋 ${notFound.length} 個:`);
console.log('   │  ' + notFound.join(', '));
console.log(`   └─ 查得到 → 實際入庫 ${addedGuess.length} 個:`);
console.log('      ' + addedGuess.join(', ') + '\n');

const r = await store.actions.importOcrText(tokens);
console.log(`═══ 實跑結果 ═══`);
console.log(`  added=${r.added}  blacklisted=${r.blacklisted}  notFound=${r.notFound}`);
const inDb = new Set(fakeDb.db.prepare('SELECT word FROM words').all().map(x=>x.word));
console.log(`  實際 DB 內: ${[...inDb].join(', ')}`);

await store.actions.enrichOcrWords(r.addedIds);
const enriched = store.state.words.filter(w => r.addedIds.includes(w.id));
const withDef = enriched.filter(w => w.definition);
console.log(`\n═══ 背景補欄位 ═══`);
console.log(`  入庫 ${enriched.length} 字中，${withDef.length} 字成功補齊`);
for (const w of withDef.slice(0, 6)) console.log(`   ${w.word}: pos=${w.pos} def="${w.definition}" pron=${w.pron} ex="${w.example}"`);
process.exit(0);