#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// D14 防回歸驗證 — deleteWord 清 review_log/exam_history 孤兒
// 修後: deleteWord 在同事務同時 DELETE cards/review_log/exam_history(words)。
// 負控制: 修前不刪 → 孤兒殘留。
// 用 FakeDatabase + 真實 db.js.deleteWord 實測。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

class FakeDatabase {
  static load() { if (!FakeDatabase._s) FakeDatabase._s = new FakeDatabase(); return FakeDatabase._s; }
  constructor() { this.db = new DatabaseSync(':memory:'); this._init(); }
  _init() {
    this.db.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, deck TEXT DEFAULT 'Default', definition TEXT DEFAULT '');`);
    this.db.exec(`CREATE TABLE cards (word_id TEXT PRIMARY KEY, state INTEGER DEFAULT 0);`);
    this.db.exec(`CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER DEFAULT 0);`);
    this.db.exec(`CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, correct INTEGER DEFAULT 0);`);
  }
  async execute(sql, params = []) { this.db.prepare(this._bind(sql, params)).run(); }
  async select(sql, params = []) { return this.db.prepare(this._bind(sql, params)).all(); }
  _bind(sql, params) {
    if (!params.length) return sql;
    let s = sql;
    params.forEach((v, i) => { s = s.replace(new RegExp(`\\$${i + 1}(?=\\s|,|\\)|$|\\b)`, 'g'), `'${String(v).replace(/'/g, "''")}'`); });
    return s;
  }
  async close() {}
}
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });

const db = await import('../src/lib/db.js');
await db.initDB();

// 塞資料
const d = FakeDatabase._s;
d.db.exec(`INSERT INTO words (id, word) VALUES ('w1', 'apple'), ('w2', 'banana');`);
d.db.exec(`INSERT INTO cards (word_id) VALUES ('w1'), ('w2');`);
d.db.exec(`INSERT INTO review_log (word_id) VALUES ('w1'), ('w1'), ('w2');`);
d.db.exec(`INSERT INTO exam_history (word) VALUES ('apple'), ('banana');`);

const cnt = (t) => d.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

console.log('── D14 deleteWord 清孤兒 ──');
ok('H0 初始 w1 有 2 review_log + 1 exam_history', cnt('review_log') === 3 && cnt('exam_history') === 2);

await db.deleteWord('w1');

ok('T1 刪 w1 → words 剩 1', cnt('words') === 1);
ok('T2 刪 w1 → cards 剩 1', cnt('cards') === 1);
ok('T3 刪 w1 → review_log 孤兒清除(剩 w2 的1)', cnt('review_log') === 1);
ok('T4 刪 w1 → exam_history 孤兒清除(剩 banana 的1)', cnt('exam_history') === 1);
// 確認剩的是 w2/banana
const rlLeft = d.db.prepare('SELECT word_id FROM review_log').all();
ok('T5 review_log 剩的是 w2', rlLeft.length === 1 && rlLeft[0].word_id === 'w2');
const ehLeft = d.db.prepare('SELECT word FROM exam_history').all();
ok('T6 exam_history 剩的是 banana', ehLeft.length === 1 && ehLeft[0].word === 'banana');

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);