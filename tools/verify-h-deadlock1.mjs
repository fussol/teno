#!/usr/bin/env node
// verify-h-deadlock1.mjs — H-DEADLOCK1: clearAll/bulkSaveWords 在 _write 回呼內再呼叫
// addAudit（亦走 _write）→ 佇列自我等待，promise 永不 resolve（設定頁「清除所有資料」卡死）。
// 行為驗證：mock plugin-sql 真跑 db.js，對 clearAll/bulkSaveWords 加逾時閘；修後必須 <3s 完成。
// 反向控制：內聯一份「把 addAudit 放回 _write 內」的鏡像，證明逾時閘抓得到死鎖。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mock } from 'node:test';

class FakeDatabase {
  static load() { if (!FakeDatabase._s) FakeDatabase._s = new FakeDatabase(); return FakeDatabase._s; }
  constructor() {
    this.db = new DatabaseSync(':memory:');
    // base 表由 Rust sqlx migration 建；此處為 mock，需自備（migrate() 只 ALTER/CREATE 附屬表）
    this.db.exec(`
      CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT, definition TEXT DEFAULT '', part_of_speech TEXT DEFAULT '',
        pronunciation TEXT DEFAULT '', example TEXT DEFAULT '', deck TEXT DEFAULT 'Default', tags TEXT DEFAULT '',
        image TEXT DEFAULT '', description TEXT DEFAULT '', related TEXT DEFAULT '', forms TEXT DEFAULT '',
        synonym TEXT DEFAULT '', antonym TEXT DEFAULT '', derivative TEXT DEFAULT '', examples TEXT DEFAULT '',
        etymology TEXT DEFAULT '', syllables TEXT DEFAULT '', phrases TEXT DEFAULT '', created_at TEXT DEFAULT '');
      CREATE TABLE cards (word_id TEXT PRIMARY KEY);
      CREATE TABLE decks (id TEXT PRIMARY KEY);
      CREATE TABLE folders (name TEXT PRIMARY KEY);
      CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, new_state INTEGER);
      CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE goal_streak (id INTEGER PRIMARY KEY);
      CREATE TABLE filtered_decks (id TEXT PRIMARY KEY);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    `);
  }
  _bind(sql, params = []) { const o = {}; (params || []).forEach((v, i) => { o['$' + (i + 1)] = v; }); return o; }
  async execute(sql, params = []) { this.db.prepare(sql).run(this._bind(sql, params)); }
  async select(sql, params = []) { return this.db.prepare(sql).all(this._bind(sql, params)); }
  async close() {}
}
mock.module('@tauri-apps/plugin-sql', { exports: { default: FakeDatabase } });
const fakeInvoke = async (cmd, args) => {
  if (cmd !== 'sql_tx') return {};
  const d = FakeDatabase._s;
  d.db.exec('BEGIN');
  try { for (const st of (args?.statements || [])) await d.execute(st.sql, st.params || []); d.db.exec('COMMIT'); return (args?.statements || []).length; }
  catch (e) { try { d.db.exec('ROLLBACK'); } catch (_) {} throw e; }
};
mock.module('@tauri-apps/api/core', { exports: { invoke: fakeInvoke } });

let pass = 0, fail = 0;
const chk = (n, ok, x = '') => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x ? ' | ' + x : ''}`); } };
const gate = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`DEADLOCK: 未在 ${ms}ms 內 resolve`)), ms))]);

const db = await import('../src/lib/db.js');
await db.initDB();

console.log('── H-DEADLOCK1：_write 佇列自我等待 ──');
{
  let ok = true, err = '';
  try { await gate(db.clearAll(), 3000); } catch (e) { ok = false; err = e.message; }
  chk('clearAll() 3s 內 resolve（無自我死鎖）', ok, err);
}
{
  let ok = true, err = '';
  try { await gate(db.bulkSaveWords([{ id: 'w1', word: 'apple' }]), 3000); } catch (e) { ok = false; err = e.message; }
  chk('bulkSaveWords() 3s 內 resolve（無自我死鎖）', ok, err);
}

// ── 反向控制：內聯還原死鎖結構 → 逾時閘必須抓到 ──
console.log('── 反向控制（內聯 buggy 結構）──');
{
  let _chain = Promise.resolve();
  const _write = (fn) => { const p = _chain.then(fn, fn); _chain = p.catch(() => {}); return p; };
  const addAudit = () => _write(async () => {});
  const buggy = () => _write(async () => { await addAudit(); });   // addAudit 在回呼內＝死鎖
  let caught = false;
  try { await gate(buggy(), 500); } catch (_) { caught = true; }
  chk('反向控制：死鎖結構確實被逾時閘抓到（測試有牙）', caught);
}

console.log(fail === 0 ? `\n═══ H-DEADLOCK1 ALL PASS ═══` : `\n═══ ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
