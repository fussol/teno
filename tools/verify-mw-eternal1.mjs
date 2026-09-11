#!/usr/bin/env node
// ETERNAL1: sense 層 thesaurus 四表＋stems 衍生＋編輯器韋氏優先（2026-09-11）
// fixture = live eternal 回傳原文（tools/fixtures/mw-eternal-*.json，不含 key）
// 鎖三件事：
//   [E1] related 不再 []（sense 層 rel_list union；durable/timeless 在列）
//   [E2] near_list 進反義（ephemeral/fleeting/transitory）
//   [E3] derivative＝stems 扣查詢詞/扣 forms（eternally/eternalize 在列；
//        Gross:b 人名 stems、Eternals 專有名詞排除）
//   [E4] 編輯器接線：兩瀏覽器 llmFillRelated＋llmFillSynAntDeriv 韋氏優先
// 用法: node tools/verify-mw-eternal1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  parseThesaurusEntries, parseStems, merriamToFields,
} from '../src/lib/merriam.js';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};

const dict = JSON.parse(readFileSync('tools/fixtures/mw-eternal-collegiate.json', 'utf8'));
const ithes = JSON.parse(readFileSync('tools/fixtures/mw-eternal-ithesaurus.json', 'utf8'));
const gdict = JSON.parse(readFileSync('tools/fixtures/mw-gross-collegiate.json', 'utf8'));

console.log('[E1] sense 層 related');
const t = parseThesaurusEntries(ithes);
chk('related 非空（舊 parser 永遠 []）', t.related.length > 0, `got=${t.related.length}`);
chk('durable/timeless/steadfast 在列',
  ['durable', 'timeless', 'steadfast'].every(w => t.related.includes(w)));
chk('顶层 meta.syns 照吃（≥15）', t.synonyms.length >= 15, `got=${t.synonyms.length}`);

console.log('[E2] near_list 進反義');
chk('ephemeral 在反義', t.antonyms.includes('ephemeral'));
chk('fleeting 在反義', t.antonyms.includes('fleeting'));
chk('transitory 在反義', t.antonyms.includes('transitory'));
chk('impermanent/mortal 仍在（meta.ants 不回歸）',
  t.antonyms.includes('impermanent') && t.antonyms.includes('mortal'));

console.log('[E3] stems 衍生');
chk('eternally 在列', parseStems(dict, 'eternal').includes('eternally'));
chk('eternalize 在列', parseStems(dict, 'eternal').includes('eternalize'));
chk('查詢詞本身排除', !parseStems(dict, 'eternal').some(s => s.toLowerCase() === 'eternal'));
chk('Eternals 專有名詞排除', !parseStems(dict, 'eternal').includes('Eternals'));
chk('Gross:b 人名 stems 排除（David Gross 不得出現）',
  !parseStems(gdict, 'gross').some(s => /david/i.test(s)), `got=${JSON.stringify(parseStems(gdict, 'gross'))}`);
chk('空陣列/非法不炸', JSON.stringify(parseStems(null, 'x')) === '[]' && JSON.stringify(parseStems([], 'x')) === '[]');
const f = merriamToFields({ dictionary: dict, thesaurus: ithes }, 'eternal');
chk('fields.derivative 非空', f.derivative.includes('eternally'), `got=${f.derivative.slice(0, 60)}`);
chk('fields.related 非空', f.related.length > 0);
const fg = merriamToFields({ dictionary: gdict, thesaurus: JSON.parse(readFileSync('tools/fixtures/mw-gross-ithesaurus.json', 'utf8')) }, 'gross');
chk('gross 回歸：forms 仍合併', fg.forms === 'grossed, grossing, grosses, gross', `got=${fg.forms}`);
chk('gross 回歸：derivative 無人名無 forms 重複',
  !/david/i.test(fg.derivative) && !fg.derivative.split(',').map(s => s.trim()).some(s => ['grossed', 'grossing', 'grosses', 'gross'].includes(s.toLowerCase())),
  `got=${fg.derivative.slice(0, 80)}`);

console.log('[E4] 編輯器接線（靜態）');
const mw = readFileSync('src/lib/merriam.js', 'utf8');
const br = readFileSync('src/pages/browser.js', 'utf8');
const dk = readFileSync('src/pages/deck-browser.js', 'utf8');
chk('parseStems 匯出', /export function parseStems/.test(mw));
chk('collectSenseLists 存在', /function collectSenseLists/.test(mw));
chk('merriamToFields 產 derivative', /out\.derivative = parseStems\(dict, word\)/.test(mw));
const _win = (src, fn, look) => { const i = src.indexOf('async function ' + fn); return i >= 0 && src.slice(i, i + 800).includes(look); };
chk('browser llmFillRelated 韋氏優先（ENGINE2 起走引擎）', _win(br, 'llmFillRelated', "_engineMw(word, { related"));
chk('browser llmFillSynAntDeriv 韋氏優先（ENGINE2 起走引擎）', _win(br, 'llmFillSynAntDeriv', '_engineMw(word, { syn'));
chk('browser 衍生寫 fDerivativeChips', /'fDerivatives', 'fDerivativeChips', f\.derivative/.test(br));
chk('deck llmFillRelated 韋氏優先（ENGINE2 起走引擎）', _win(dk, 'llmFillRelated', "_engineMw(word, { related"));
chk('deck llmFillSynAntDeriv 韋氏優先（prefix 版，ENGINE2 起走引擎）', _win(dk, 'llmFillSynAntDeriv', '_engineMw(word, { syn'));
chk('兩檔 LLM fallback 保留', /fetchLLM\(`\$\{baseUrl\}\/api\/generate`, model,\s+`Return a JSON array of synonyms\/similar words/.test(br) && /Return a JSON array of word derivations/.test(dk));

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /collectSenseLists/.test(execSync('git show HEAD:src/lib/merriam.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/lib/merriam.js src/pages/browser.js src/pages/deck-browser.js');
  try {
    const m2 = await import('../src/lib/merriam.js?neg=2');
    const t2 = m2.parseThesaurusEntries(ithes);
    const f2 = m2.merriamToFields({ dictionary: dict, thesaurus: ithes }, 'eternal');
    const relGone = t2.related.length === 0;
    const derivGone = !('derivative' in f2) || !f2.derivative;
    if (relGone && derivGone) { pass++; console.log('  NEG-OK: stash 後 related 空＋derivative 缺失重現（harness 有效）'); }
    else { fail++; console.log(`  NEG-FAIL relGone=${relGone} derivGone=${derivGone}`); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nETERNAL1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
