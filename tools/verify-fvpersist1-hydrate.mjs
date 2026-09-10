#!/usr/bin/env node
// FVPERSIST1: 欄位顯示設定可記憶（hydrate 讀回 array 直取）
// 根因: settings 寫入 JSON.stringify(vals) → getSetting 讀回已 parse 成 array
//       → 舊 _parseVis JSON.parse(array) 必 throw → 恆 fallback → 設定記不住
// 用法: node tools/verify-fvpersist1-hydrate.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const store = readFileSync('src/lib/store.js', 'utf8');

console.log('[F1] _parseVis array 直取');
chk('Array.isArray(v) 分支存在', /if \(Array\.isArray\(v\)\) return v\.filter\(k => _FV_KEYS\.includes\(k\)\);/.test(store));
chk('分支在 JSON.parse 之前', /if \(Array\.isArray\(v\)\)[\s\S]{0,200}try \{[\s\S]{0,80}JSON\.parse\(v\)/.test(store));
chk('字串 parse 路徑保留（舊 JSON 字串相容）', /const a = JSON\.parse\(v\);\s*\n\s*if \(Array\.isArray\(a\)\) return a\.filter/.test(store));
chk('fallback 路徑保留（null/空/壞值）', /return \[\.\.\.fb\];/.test(store));

console.log('[F2] 行為模擬（production 同型鏈）');
const sim = execSync(`node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
function setSetting(key, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, str);
}
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
setSetting('fieldVisBrowserFront', JSON.stringify(['word','pron']));
setSetting('fieldVisBrowserBack', JSON.stringify(['word','definition','example']));
setSetting('fieldVisStudy', JSON.stringify(['word','definition']));
const _FV_KEYS = ['word','pron','definition','example','description','related','forms','synonym','antonym','tags','image','syllables','etymology'];
const _parseVis = (v, fallback) => {
  const fb = fallback || _FV_KEYS;
  if (v == null || v === '') return [...fb];
  if (Array.isArray(v)) return v.filter(k => _FV_KEYS.includes(k));
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a.filter(k => _FV_KEYS.includes(k)); } catch (_) {}
  return [...fb];
};
const front = _parseVis(getSetting('fieldVisBrowserFront'), ['word']).join();
const back = _parseVis(getSetting('fieldVisBrowserBack')).join();
const study = _parseVis(getSetting('fieldVisStudy')).join();
console.log(front + '|' + back + '|' + study);
"`, { encoding: 'utf8' }).trim();
const [f, b, s] = sim.split('|');
chk('front 記住 word,pron', f === 'word,pron');
chk('back 記住 word,definition,example', b === 'word,definition,example');
chk('study 記住 word,definition', s === 'word,definition');

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /if \(Array\.isArray\(v\)\) return v\.filter\(k => _FV_KEYS\.includes\(k\)\);/.test(execSync('git show HEAD:src/lib/store.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) {
  console.log('  NEG-SKIP: 特徵已在 HEAD（已 commit）— 跳過');
} else {
  execSync('git stash push -q -- src/lib/store.js');
  try {
    const st2 = readFileSync('src/lib/store.js', 'utf8');
    const hasFix = /Array\.isArray\(v\)\) return v\.filter/.test(st2);
    if (!hasFix) { pass++; console.log('  NEG-OK: stash 後修復消失（harness 有效）'); }
    else { fail++; console.log('  NEG-FAIL: stash 後修復仍在'); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nFVPERSIST1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
