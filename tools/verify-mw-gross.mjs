#!/usr/bin/env node
// GROSSFIX: live gross 回歸鎖（2026-09-11 使用者 key 實測）
// fixture = 真實 API 回傳原文（tools/fixtures/mw-gross-*.json，不含 key）
// 鎖三件事：
//   [G1] ins 音節星號（gross*ing→grossing，否則詞形欄進髒字串）
//   [G2] 詞形跨 homograph 合併（pick=gross:1 adj 無 ins，動詞形在 gross:2）
//   [G3] ithesaurus 產品相容（meta.syns 照吃；lib.rs thesaurus→ithesaurus fallback 在）
// 用法: node tools/verify-mw-gross.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  parseDictionaryEntries, parseThesaurusEntries, merriamToFields,
} from '../src/lib/merriam.js';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};

const dict = JSON.parse(readFileSync('tools/fixtures/mw-gross-collegiate.json', 'utf8'));
const ithes = JSON.parse(readFileSync('tools/fixtures/mw-gross-ithesaurus.json', 'utf8'));

console.log('[G1] live gross dictionary 側');
const { entries, suggest } = parseDictionaryEntries(dict);
chk('10 條目全收（含 Gross:b/複合詞，不丟）', entries.length === 10, `got=${entries.length}`);
chk('四 homograph ids 齊', ['gross:1', 'gross:2', 'gross:3', 'gross:4'].every(id => entries.some(e => e.id === id)));
chk('pick 目標 gross:1 存在', entries.some(e => e.id === 'gross:1' && e.fl === 'adjective'));
chk('星號全清（gross*ing 不得殘留）', !entries.some(e => (e.forms || []).some(x => x.includes('*'))),
  `got=${JSON.stringify(entries[1]?.forms)}`);
chk('gross:2 動詞形正規化', JSON.stringify(entries.find(e => e.id === 'gross:2')?.forms) === JSON.stringify(['grossed', 'grossing', 'grosses']));
chk('suggest 空（查有字）', suggest.length === 0);

console.log('[G2] merriamToFields 合併');
const f = merriamToFields({ dictionary: dict, thesaurus: ithes }, 'gross');
chk('pos 取 gross:1 adj', f.pos === 'adjective', `got=${f.pos}`);
chk('forms 跨 homograph 合併', f.forms === 'grossed, grossing, grosses, gross', `got=${f.forms}`);
chk('pron 無 token', f.pron === 'ˈgrōs', `got=${f.pron}`);
chk('audio 編號', f.pronAudio === 'gross001', `got=${f.pronAudio}`);
chk('etymology 有字源+首次使用', f.etymology.includes('Middle English') && f.etymology.includes('首次使用'), '');
chk('definition 非空', f.definition.trim().length > 0);
chk('example ≤3 句非空', f.example.trim().length > 0 && f.example.split('\n').length <= 3);
chk('全欄位無 { } 殘留', !/[{}]/.test([f.pos, f.definition, f.example, f.etymology, f.phrases, f.synonym, f.forms].join(' ')));

console.log('[G3] ithesaurus 相容');
const t = parseThesaurusEntries(ithes);
chk('meta.syns 照吃（≥50）', t.synonyms.length >= 50, `got=${t.synonyms.length}`);
chk('fields synonym 非空', f.synonym.includes('coarse'), `head=${f.synonym.slice(0, 40)}`);
chk('fields antonym 非空', f.antonym.trim().length > 0, `got=${f.antonym.slice(0, 40)}`);
const rs = readFileSync('src-tauri/src/lib.rs', 'utf8');
chk('lib.rs thesaurus→ithesaurus fallback 在', rs.includes('mw_url("ithesaurus"'));
const st = readFileSync('src/pages/settings.js', 'utf8');
chk('設定頁 thesaurus 標示相容 Intermediate', /Intermediate Thesaurus/.test(st));

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /ithesaurus/.test(execSync('git show HEAD:src-tauri/src/lib.rs', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/lib/merriam.js src-tauri/src/lib.rs src/pages/settings.js');
  try {
    const { parseDictionaryEntries: p2, merriamToFields: m2 } = await import('../src/lib/merriam.js?neg=1');
    const r2 = p2(dict);
    const starBack = r2.entries.some(e => (e.forms || []).some(x => x.includes('*')));
    const f2 = m2({ dictionary: dict, thesaurus: ithes }, 'gross');
    const formsLost = f2.forms !== 'grossed, grossing, grosses, gross';
    if (starBack && formsLost) { pass++; console.log('  NEG-OK: stash 後星號 bug＋合併缺失重現（harness 有效）'); }
    else { fail++; console.log(`  NEG-FAIL starBack=${starBack} formsLost=${formsLost} forms=${f2.forms}`); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nGROSSFIX: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
