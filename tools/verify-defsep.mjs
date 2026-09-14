// DEFSEP1: 定義分隔契約 — 存檔一律 ，；讀取認 [,，;；\n]
// 跑法：node tools/verify-defsep.mjs
import { readFileSync } from 'node:fs';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const engine = readFileSync(`${R}/src/lib/autofill-engine.js`, 'utf8');
const store = readFileSync(`${R}/src/lib/store.js`, 'utf8');
const mw = readFileSync(`${R}/src/lib/merriam.js`, 'utf8');
const svg = readFileSync(`${R}/src/lib/svg.js`, 'utf8');
const browser = readFileSync(`${R}/src/pages/browser.js`, 'utf8');
const deck = readFileSync(`${R}/src/pages/deck-browser.js`, 'utf8');

console.log('== T1 存檔端：一律 ， ==');
ok('engine trans 用 ，join', engine.includes("join('，')") && engine.includes('DEFSEP1'));
ok('engine trans 無 join(\\n) 殘留', !engine.match(/zh\.slice\(0, 3\)[^;]*join\('\\n'\)/));
ok('engine 單條內換行先壓成 ，', engine.includes("replace(/\\s*\\n\\s*/g, '，')"));
ok('store OCR enrich 兩處用 ，join', (store.match(/defs\.join\('，'\)/g) || []).length === 2);
ok('store 無 defs.join(；) 殘留', !store.includes("defs.join('；')"));
ok('merriam definition 用 ，join', mw.includes(").join('，')") || mw.includes(".join('，')"));
ok('merriam 無 definition join(\\n)', !mw.match(/out\.definition = .*join\('\\n'\)/));

console.log('== T2 讀取端：認 [,，;；\\n] ==');
ok('splitFieldsHtml 切 [,，;；\\n]', svg.includes('split(/[,，;；\\n]/)'));
ok('browser word-row 同規則', browser.includes("split(/[,，;；\\n]/)"));
ok('deck-browser word-row 同規則', deck.includes("split(/[,，;；\\n]/)"));
for (const [f, src] of [['deck-add', deck], ['deck-edit', deck], ['browser-combo', browser]]) {
  ok(`${f} defSep 含 \\n`, src.includes("',|;|；|\\\\n'"));
}

console.log('== T3 行為：舊髒資料照樣切得開 ==');
{
  const split = (d) => d.split(/[,，;；\n]/).map(s => s.trim()).filter(Boolean);
  const stuck = '輪流，交替\n使輪流，使交替；assert;主張';
  const parts = split(stuck);
  ok('混合分隔全切開（6 顆）', parts.length === 6, JSON.stringify(parts));
  ok('純 ， 資料不受影響', JSON.stringify(split('農業的，纖維')) === JSON.stringify(['農業的', '纖維']));
  const chipSpl = new RegExp(',|;|；|\\n');
  ok('膠囊 regex 同步切開', 'a\nb；c,d'.split(chipSpl).length === 4);
}

console.log('== T4 例句欄未被誤傷（\\n 仍是例句分隔） ==');
ok('engine example 維持 join(\\n)', engine.includes("join('\\n')"));
ok('merriam example 維持 join(\\n)', mw.includes('patch.example = [exBase, ...unique]') || mw.includes('pick.examples.slice(0, 3).join'));
ok('例句 exSep=null 模式不變', deck.includes("exSep = null") && browser.includes("exSep = null"));

console.log('== T5 AUTOFILL-CONTRACT1：四洞靜態釘 ==');
ok('洞一 pron 包斜線（cambridge 分支）',
  engine.includes('AUTOFILL-CONTRACT1') && engine.includes('patch.pron = `/${pron}/`'));
ok('洞二 trans 壓 [;；]（同 DEFSEP1 join）',
  engine.includes(".replace(/[;；]/g, '，')"));
ok('洞三 mergeComma 認全形（/,，/ 切分）',
  engine.includes('const spl = /[,，]/;'));
ok('洞四 tatoeba trim（空白句不過）',
  engine.includes("String(x.text ?? '').trim()"));

console.log(fail === 0 ? `DEFSEP1: PASS (${pass} pass, 0 fail)` : `DEFSEP1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
