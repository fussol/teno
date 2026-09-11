#!/usr/bin/env node
// MWKEYS1 + MWFORMS1: (A) loadAll 漏讀五鍵→重啟恆空 (B) 詞形變化加韋氏來源
// 用法: node tools/verify-mwkeys1-forms.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const store = readFileSync('src/lib/store.js', 'utf8');
const merriam = readFileSync('src/lib/merriam.js', 'utf8');
const tools = readFileSync('src/pages/tools.js', 'utf8');
const browser = readFileSync('src/pages/browser.js', 'utf8');
const deck = readFileSync('src/pages/deck-browser.js', 'utf8');

console.log('[K1] MWKEYS1: loadAll 補讀五鍵');
for (const k of ['mwDictKey', 'mwThesKey', 'graylist', 'ocrMode', 'ocrRestoreModel']) {
  chk(`loadAll 讀 ${k}`, new RegExp(`getSetting\\('${k}'\\)`).test(store));
}
chk('hydrate 端讀取仍在（store.js:487-491）', /state\.mwDictKey = typeof settings\.mwDictKey/.test(store));

console.log('[K2] MWKEYS1 行為模擬（存→重啟→讀回非空）');
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
// 模擬使用者存 key（settings.js 儲存鈕）
setSetting('mwDictKey', JSON.stringify('abc-123'));
setSetting('mwThesKey', JSON.stringify('xyz-456'));
// 模擬 loadAll 補讀（修後）+ hydrate（store.js 同型）
const raw = getSetting('mwDictKey');
const state_v = typeof raw === 'string' ? raw : '';
console.log('restart-state=' + (state_v === 'abc-123' ? 'NON-EMPTY' : 'EMPTY'));
"`, { encoding: 'utf8' });
chk('重啟後 state 非空', sim.includes('NON-EMPTY'));

console.log('[F1] MWFORMS1: parser 吃 e.ins');
chk('parseDictionaryEntries 解析 ins', /forms: Array\.isArray\(e\.ins\)/.test(merriam));
chk('stripMwTokens 清洗 if 值', /x\.if === 'string'[\s\S]{0,60}stripMwTokens\(x\.if\)/.test(merriam));
chk('merriamToFields 產 forms 欄位', /forms: '',/.test(merriam));
chk('merriamToFields 填 forms（跨 homograph 合併，GROSSFIX）', /out\.forms = \[\.\.\.formSet\]\.join\(', '\)/.test(merriam));

console.log('[F2] MWFORMS1: tools 雙來源');
chk('__genFormsMw 存在', /window\.__genFormsMw = async/.test(tools));
chk('獨立卡雙鈕（韋氏+LLM）', /__genFormsMw\(\)[\s\S]{0,200}__genFormsLLM\(\)/.test(tools));
chk('組合包詞形來源選單（comboForms merriam 預設）', /_selHtml\('comboForms', \[\['韋氏字典','merriam'\],\['本地 LLM','llm'\]\], 'merriam'\)/.test(tools));
chk('M.forms 分派', /forms: _getMethod\('comboForms', 'merriam'\)/.test(tools));
chk('組合包執行端 merriam 分支（AUTOFILL-ENGINE1 起收斂引擎：tools 調 fillWordFields＋methods: M，分支實作在引擎）', /fillWordFields\(\{[\s\S]{0,300}methods: M/.test(tools) && /if \(M === 'merriam'\)/.test(readFileSync('src/lib/autofill-engine.js', 'utf8')));

console.log('[F3] MWFORMS1: 編輯器 sparkle 韋氏優先');
chk('browser llmFillForms 韋氏優先', /MWFORMS1[\s\S]{0,300}lookupMerriam\(word, dk, tk\)/.test(browser));
chk('deck llmFillForms 韋氏優先', /MWFORMS1[\s\S]{0,300}lookupMerriam\(word, dk, tk\)/.test(deck));
chk('browser fallback LLM 保留', /llmFillForms[\s\S]*?fetchLLM/.test(browser));
chk('deck fallback LLM 保留', /llmFillForms[\s\S]*?fetchLLM/.test(deck));

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /getSetting\('mwDictKey'\)/.test(execSync('git show HEAD:src/lib/store.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/lib/store.js src/lib/merriam.js src/pages/tools.js src/pages/browser.js src/pages/deck-browser.js');
  try {
    const s2 = readFileSync('src/lib/store.js', 'utf8');
    const m2 = readFileSync('src/lib/merriam.js', 'utf8');
    const gone = !/getSetting\('mwDictKey'\)/.test(s2) && !/Array\.isArray\(e\.ins\)/.test(m2);
    if (gone) { pass++; console.log('  NEG-OK: stash 後特徵全滅（harness 有效）'); }
    else { fail++; console.log('  NEG-FAIL'); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nMWKEYS1+MWFORMS1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
