#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-d5-checkpoint.mjs — D5-SR1: backupDb 必先 await checkpoint()
// 雙態驗證：修後 backupDb 呼叫順序 = [checkpoint, invoke("backup_db")]。
// 負控制：剝除 await checkpoint() 那行 → 該版 backupDb 順序只剩 invoke →
//         本腳本對真實 source 斷言必紅（bug 精準重現）。
// 用法: node --experimental-test-module-mocks tools/verify-d5-checkpoint.mjs
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const API_JS = join(REPO, 'src/lib/api.js');
const apiSource = readFileSync(API_JS, 'utf8');

let failures = 0;
function ok(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? '  «' + detail + '»' : ''}`);
  if (!cond) failures++;
}

// ═══ T1 source-level 判別：backupDb 內含 await checkpoint() 且 import 在位 ═══
console.log('── T1 source 判別（雙態門檻）──');
// import { checkpoint } from './db.js'（允許雙引號/單引號/間距變體）
const importOk = /import\s*\{[^}]*checkpoint[^}]*\}\s*from\s*['"]\.\/db\.js['"]/.test(apiSource);
ok('T1a checkpoint 從 ./db.js import 在位', importOk);

// backupDb 主體：在 backupDb 區塊內、invoke('backup_db') 之前必有 await checkpoint()
const backupDbBlock = apiSource.match(/export const backupDb =[\s\S]*?invoke\('backup_db'\)/);
const block = backupDbBlock ? backupDbBlock[0] : '';
ok('T1b backupDb 區塊可定位', !!backupDbBlock);
ok('T1c 區塊內 invoke 前有 await checkpoint()', /await\s*checkpoint\(\)[\s\S]*invoke\('backup_db'\)/.test(block));
ok('T1d backupDb 為 async', /export const backupDb = async/.test(apiSource));

// ═══ T2 行為驗證：真實 import（mock 依賴）跑 backupDb，捕獲呼叫順序 ═══
console.log('── T2 行為驗證（mock invoke/checkpoint）──');
const order = [];
// mock.module 需在「首次 import」前宣告
mock.module('@tauri-apps/api/core', { exports: {
  invoke: async (cmd) => { order.push(cmd); return { ok: true }; },
} });
// mock './db.js'（api.js 的相對依賴）→ checkpoint spy
mock.module('../src/lib/db.js', { exports: {
  checkpoint: async () => { order.push('checkpoint'); return true; },
} });

try {
  const api = await import('../src/lib/api.js');
  await api.backupDb();
  ok('T2a 呼叫順序 = checkpoint → invoke(backup_db)',
    JSON.stringify(order) === JSON.stringify(['checkpoint', 'backup_db']),
    JSON.stringify(order));
  ok('T2b invoke 參數為 backup_db', order[order.length - 1] === 'backup_db');
} catch (e) {
  ok('T2 真實 backupDb 可執行', false, String(e.message).slice(0, 120));
}

// ═══ T3 負控制：剝除 await checkpoint() → 該版斷言精準翻紅 ═══
console.log('── T3 負控制（剝除修法 → 必紅）──');
// 把真實 source 的 await checkpoint() 那行移除，模擬「未修 bug 版」
const uncleaned = apiSource.replace(/^\s*await\s*checkpoint\(\);?.*$/m, '').replace(/import\s*\{[^}]*checkpoint[^}]*\}\s*from\s*['"]\.\/db\.js['"]/, '');
// 對「未修版」重跑同判別：應缺 checkpoint → 證明 harness 能打破 bug 態
const ucBlock = uncleaned.match(/export const backupDb =[\s\S]*?invoke\('backup_db'\)/);
const ucBlockStr = ucBlock ? ucBlock[0] : '';
const ucHasCheckpoint = /await\s*checkpoint\(\)[\s\S]*invoke\('backup_db'\)/.test(ucBlockStr);
// 負控制斷言：未修版缺 checkpoint（isFalse→算 PASS 證明 bug 存在會被 T1 抓到）
console.log(`  INFO  剝除後 backupDb 含 checkpoint = ${ucHasCheckpoint}`);
ok('T3 剝除修法後 checkpoint 消失（bug 態可被 T1 判別翻紅 → 負控制成立）', ucHasCheckpoint === false);

const hasError = failures > 0;
console.log(`\n═══ D5-SR1 verify: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} ═══`);
process.exit(hasError ? 1 : 0);