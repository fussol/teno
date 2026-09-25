#!/usr/bin/env node
// AUTOFILL0 + AUTOFILL1
//   AUTOFILL0：組合包設定（methodSources）重啟後全部回預設。
//     根因：db.js getSetting 已先 JSON.parse（db.js:649）→ 回來是物件，
//           tools.js 舊碼再 JSON.parse(物件) 必 throw → 恆走 catch → 設定全失。
//           與 FVPERSIST1（fieldVis 記不住）同源同位置，該次只修 array、object 未修。
//   AUTOFILL1：抽出共用 comboConfig()，供所有自動填入入口共用同一份設定
//           （取代 3 處 chip 排序實作）。
// 用法: node tools/verify-autofill1-combo.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};

const tools = readFileSync('src/pages/tools.js', 'utf8');
const engine = readFileSync('src/lib/autofill-engine.js', 'utf8');

console.log('[S] AUTOFILL0 源碼');
chk('物件分支已加（不再對物件 JSON.parse）',
  /const stored = \(v && typeof v === 'object'\) \? v : \(v \? JSON\.parse\(v\) : null\);/.test(tools));
chk('舊的無條件 JSON.parse(v) 已不存在',
  !/const stored = v \? JSON\.parse\(v\) : null;/.test(tools));
chk('catch 保底仍在', /catch \{ _srcMem = _srcMem \|\| \{ selectors: \{\}, comboCollapsed: false \}; \}/.test(tools));

console.log('[S] AUTOFILL1 源碼');
chk('engine 匯出 COMBO_FIELDS', /export const COMBO_FIELDS = \[/.test(engine));
chk('engine 匯出 comboConfig', /export function comboConfig\(mem, globalOverwrite = false\)/.test(engine));
chk('engine 匯出 readComboConfig', /export async function readComboConfig\(\)/.test(engine));
chk('只吃韋氏的欄位寫死 merriam', /COMBO_FIXED_MERRIAM = \['etymology', 'syllables', 'derivative'\]/.test(engine));
chk('DEFAULT_METHODS 覆蓋全部 COMBO_FIELDS（含 derivative）',
  /derivative: 'merriam',\n\};/.test(engine) && /export const DEFAULT_METHODS = \{/.test(engine));

// ── 行為 ──
const eng = await import('../src/lib/autofill-engine.js');
const { comboConfig, COMBO_FIELDS, DEFAULT_METHODS, comboSelectorId } = eng;

console.log('[B] comboConfig：預設（無設定）');
const d = comboConfig(null, false);
chk('12 欄', d.enabled.length === 12, String(d.enabled.length));
chk('含 derivative（fixed=true，只吃韋氏）', d.enabled.includes('derivative'), JSON.stringify(d.enabled));
chk('每欄來源 = DEFAULT_METHODS', COMBO_FIELDS.every(f => d.methods[f] === DEFAULT_METHODS[f]),
  JSON.stringify(d.methods));
chk('字源/音節/衍生 = merriam', d.methods.etymology === 'merriam' && d.methods.syllables === 'merriam' && d.methods.derivative === 'merriam');
chk('覆寫預設全關', COMBO_FIELDS.every(f => d.overwrite[f] === false));

console.log('[B] comboConfig：selector 覆寫');
const mem1 = { selectors: { comboPos: 'merriam', comboPron: 'merriam', comboRelated: 'merriam' } };
const d1 = comboConfig(mem1, false);
chk('comboPos → merriam', d1.methods.pos === 'merriam', d1.methods.pos);
chk('comboPron → merriam', d1.methods.pron === 'merriam');
chk('comboRelated → merriam', d1.methods.related === 'merriam');
chk('未指定的欄位仍用預設', d1.methods.forms === DEFAULT_METHODS.forms, d1.methods.forms);
chk('selector id 規則 = combo+Cap', comboSelectorId('etymology') === 'comboEtymology' && comboSelectorId('pos') === 'comboPos');

console.log('[B] comboConfig：欄位開關');
const mem2 = { comboOn: { pos: false, example: false } };
const d2 = comboConfig(mem2, false);
chk('關掉的欄位從 methods 移除', !('pos' in d2.methods) && !('example' in d2.methods));
chk('其餘欄位仍在（10 欄）', d2.enabled.length === 10, String(d2.enabled.length));
chk('未列出的視為開', 'pron' in d2.methods);

console.log('[B] comboConfig：覆寫（逐欄 + 全域）');
const mem3 = { comboOw: { syn: true, ant: true } };
const d3 = comboConfig(mem3, false);
chk('逐欄覆寫生效', d3.overwrite.syn === true && d3.overwrite.ant === true);
chk('未開的欄位仍關', d3.overwrite.pos === false);
const d4 = comboConfig(mem3, true);
chk('全域覆寫開 → 全部 true', COMBO_FIELDS.every(f => d4.overwrite[f] === true));
chk('全域開但 methods 不受影響', d4.methods.pos === DEFAULT_METHODS.pos);

console.log('[B] 邊界 / 壞值');
chk('mem=undefined 安全', comboConfig(undefined, false).enabled.length === 12);
chk('mem 非物件（字串）安全', comboConfig('garbage', false).enabled.length === 12);
chk('selectors 非物件安全', comboConfig({ selectors: 'x' }, false).methods.pos === DEFAULT_METHODS.pos);
chk('comboOn 全 false → 0 欄', comboConfig({ comboOn: Object.fromEntries(COMBO_FIELDS.map(f => [f, false])) }, false).enabled.length === 0);
chk('未知 try 值照用（引擎會自報錯誤）', comboConfig({ selectors: { comboPos: 'nope' } }, false).methods.pos === 'nope');

console.log('[NEG] 負控制：AUTOFILL0 的根因可重現');
// getSetting 的行為：JSON.parse(存進去的字串)
const STORED = '{"selectors":{"comboPos":"merriam"},"comboOn":{"pos":true}}';
const fromGetSetting = JSON.parse(STORED);              // db.js:649 會先 parse
let oldThrows = false;
try { JSON.parse(fromGetSetting); } catch { oldThrows = true; }
chk('對已 parse 的物件再 JSON.parse 會 throw（舊碼的必然結果）', oldThrows);
chk('∴ 舊碼恆走 catch → 設定全失（bug 成立）', oldThrows);
// 新碼可正確取回
const fixed = (fromGetSetting && typeof fromGetSetting === 'object') ? fromGetSetting : JSON.parse(fromGetSetting);
chk('新碼正確取回 selectors', fixed?.selectors?.comboPos === 'merriam');
const dFix = comboConfig(fixed, false);
chk('∴ 修好後設定真的進得了 comboConfig', dFix.methods.pos === 'merriam', dFix.methods.pos);

console.log(`\nAUTOFILL1(含0): ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
