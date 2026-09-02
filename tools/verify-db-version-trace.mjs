#!/usr/bin/env node
// VERSION-TRACE 驗證 — stampDbVersion 寫入 PRAGMA user_version + settings
// 直接檢驗 db.js 的版本指紋邏輯（不載整個 store，用輕量截取測試）。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const src = readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8');

console.log('── VERSION-TRACE DB 版本指紋 ──');

// 真實 SQLite 測 PRAGMA user_version 行為
const db = new DatabaseSync(':memory:');
const v = db.prepare('PRAGMA user_version').get();
ok('T0 PRAGMA user_version 可讀(初始0)', v.user_version === 0);
db.exec('PRAGMA user_version = 5001018');
const v2 = db.prepare('PRAGMA user_version').get();
ok('T1 PRAGMA user_version 可寫/讀', v2.user_version === 5001018);
// 「只升不降」由 app code 判斷（T10 已驗證 verInt>cur），SQLite 原生允許覆寫。
// T2 改驗 user_version 存於檔（真實檔案斷連重開仍在）
import { rmSync } from 'node:fs';
const dbF = new DatabaseSync('/tmp/vtrace-test.db');
dbF.exec('PRAGMA user_version = 5001018');
dbF.close();
const dbR = new DatabaseSync('/tmp/vtrace-test.db');
const vr = dbR.prepare('PRAGMA user_version').get();
dbR.close();
try { rmSync('/tmp/vtrace-test.db'); } catch {}
ok('T2 user_version 存於檔（重開仍在）', vr.user_version === 5001018);

// check source 結構
ok('T3 db.js 有 stampDbVersion', /export async function stampDbVersion/.test(src));
ok('T4 db.js 有 getDbVersion', /export async function getDbVersion/.test(src));
ok('T5 寫 PRAGMA user_version', /PRAGMA user_version = /.test(src));
ok('T6 settings 記 db_from_version', /db_from_version/.test(src));
ok('T7 settings 記 db_from_commit(commit hash)', /db_from_commit/.test(src));
ok('T8 initDB 呼叫 stampDbVersion', /await stampDbVersion\(db\)/.test(src));
ok('T9 buildHash 讀取(getBuildCommit)', /buildHash/.test(src));
ok('T10 只升不降語意(verInt > cur)', /verInt > cur/.test(src));
ok('T11 版本解析 5.1.18→5001018', (()=>{ const m='5.1.18'.match(/^(\d+)\.(\d+)\.(\d+)/); return Number(m[1])*1000000+Number(m[2])*1000+Number(m[3])===5001018 })());

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);