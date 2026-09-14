#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// LOG-MW D段驗證 — merriam.js 純函式（fixture 驅動，node 直跑無 mock）
// fixture 皆取自 MW 官方 JSON 文件（dictionaryapi.com/products/json）的
// Example 原文：test homograph / traffic et / abide dros / agree syns /
// above thesaurus meta / threatening uros。
//   T1 stripMwTokens（管道/cross-ref/標點/兜底）
//   T2 hwToSyllables
//   T3 parseDictionaryEntries（test:1：fl/pron/audio/shortdef）
//   T4 et＋date（traffic）
//   T5 dros 片語（abide by）
//   T6 suggest（查無字回字串陣列）
//   T7 parseThesaurusEntries（above：syns/ants）
//   T8 merriamToFields 合併（欄位映射＋單數同反義＋audio 只存編號）
//   NC 拔 et 段→etymology 空（解析敏感）；拔 sound→pronAudio 空
// ═══════════════════════════════════════════════════════════════
import {
  stripMwTokens, hwToSyllables, parseDictionaryEntries,
  parseThesaurusEntries, parseStems, merriamToFields,
} from '../src/lib/merriam.js';

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
};

// T1 stripMwTokens
{
  check('T1a {bc}刪', stripMwTokens('{bc}of third rank'), 'of third rank');
  check('T1b {it}取內容', stripMwTokens('will {it} abide by {/it} your decision'), 'will abide by your decision');
  check('T1c {d_link}取末段', stripMwTokens('to {d_link|acquiesce|acquiesce} in'), 'to acquiesce in');
  check('T1d {a_link}取末段', stripMwTokens('{a_link|pleasure}'), 'pleasure');
  check('T1e {dx}整段丟', stripMwTokens('a {dx}see test{/dx} b'), 'a b');
  check('T1f 引號token', stripMwTokens('{ldquo}hi{rdquo}'), '"hi"');
  check('T1g {sc}取內容', stripMwTokens('{sc}agree{/sc} implies'), 'agree implies');
  check('T1h 殘留兜底', stripMwTokens('x {zzz} y'), 'x y');
  check('T1i {wi}刪', stripMwTokens('gestured {wi}threateningly{/wi}'), 'gestured threateningly');
}

// T2 hwToSyllables（官方 agonise 例）
{
  check('T2a *→·', hwToSyllables('ag*o*nise'), 'ag·o·nise');
  check('T2b 無點不變', stripMwTokens('test'), 'test');
  check('T2c 空回空', hwToSyllables(''), '');
}

// T3 test:1（官方 §2.1-2.3 Example 原文形狀）
{
  const arr = [{
    meta: { id: 'test:1' },
    hom: 1,
    hwi: { hw: 'test', prs: [{ mw: 'ˌtest', sound: { audio: 'test0001', ref: 'c', stat: '1' } }] },
    fl: 'noun',
    shortdef: ['something presented for acceptance'],
  }, {
    meta: { id: 'test:2' },
    hom: 2,
    hwi: { hw: 'test' },
    fl: 'verb',
  }];
  const { entries, suggest } = parseDictionaryEntries(arr);
  check('T3a 兩條目', entries.length, 2);
  check('T3b fl', entries[0].fl, 'noun');
  check('T3c pron', entries[0].pron, 'ˌtest');
  check('T3d audio編號', entries[0].pronAudio, 'test0001');
  check('T3e shortdef', entries[0].shortdef, ['something presented for acceptance']);
  check('T3f 無suggest', suggest, []);
}

// T4 traffic et＋date（官方 §2.26-2.27 Example）
{
  const arr = [{
    meta: { id: 'traffic' },
    hwi: { hw: 'traf*fic' },
    fl: 'noun',
    et: [['text', 'Middle French {it} trafique {/it} , from Old Italian {it} traffico {/it}']],
    date: 'circa 1842',
    def: [{ sseq: [[['sense', { sn: '1', dt: [[ 'text', '{bc} vehicles' ], ['vis', [{ t: 'heavy {it} traffic {/it}' }]]] }]]] }],
  }];
  const { entries } = parseDictionaryEntries(arr);
  check('T4a et去標記', entries[0].et.includes('Middle French') && entries[0].et.includes('trafique') && !entries[0].et.includes('{it}'), true);
  check('T4b date', entries[0].date, 'circa 1842');
  check('T4c def收集', entries[0].defs, ['vehicles']);
  check('T4d 例句去標記', entries[0].examples, ['heavy traffic']);
  check('T4e 音節', entries[0].syllables, 'traf·fic');
}

// T5 abide dros（官方 §2.19 Example）
{
  const arr = [{
    meta: { id: 'abide' },
    hwi: { hw: 'abide' },
    fl: 'verb',
    dros: [{ drp: 'abide by', def: [{ sseq: [[['sense', { sn: '1', dt: [[ 'text', '{bc} to conform to' ], ['vis', [{ t: '{it} abide by {/it} the rules' }]]] }]]] }] }],
  }];
  const { entries } = parseDictionaryEntries(arr);
  check('T5a 片語', entries[0].phrases, [{ phrase: 'abide by', def: 'to conform to' }]);
}

// T6 suggest
{
  const { entries, suggest } = parseDictionaryEntries(['testt', 'taste']);
  check('T6a 無條目', entries, []);
  check('T6b suggest', suggest, ['testt', 'taste']);
  const empty = parseDictionaryEntries([]);
  check('T6c 空陣列', [empty.entries, empty.suggest], [[], []]);
}

// T7 above thesaurus（官方 meta Example 形狀）
{
  const arr = [{
    meta: { id: 'above', syns: [['aloft', 'over', 'overhead']], ants: [['below']] },
    syn_list: [{ wd: 'above', syn: ['aloft', 'over'] }],
    ant_list: [{ wd: 'above', ant: ['below', 'beneath'] }],
    phrase_list: [{ phrase: 'above and beyond' }],
    rel_list: [{ rel: ['overhead'] }],
  }];
  const t = parseThesaurusEntries(arr);
  check('T7a synonyms', t.synonyms, ['aloft', 'over', 'overhead']);
  check('T7b antonyms', t.antonyms, ['below', 'beneath']);
  check('T7c phrases', t.phrases, ['above and beyond']);
  check('T7d related', t.related.sort(), ['above', 'overhead']);
}

// T8 merriamToFields 合併
{
  const payload = {
    word: 'test',
    dictionary: [{
      meta: { id: 'test:1' },
      hwi: { hw: 'test', prs: [{ mw: 'ˌtest', sound: { audio: 'test0001' } }] },
      fl: 'noun',
      shortdef: ['something presented for acceptance'],
      date: 'circa 1842',
      et: [['text', 'Middle English {it} test {/it} vessel']],
    }],
    thesaurus: [{
      meta: { id: 'test', syns: [['trial', 'exam']], ants: [['recess']] },
    }],
  };
  const f = merriamToFields(payload, 'test');
  check('T8a pos', f.pos, 'noun');
  check('T8b definition', f.definition, 'something presented for acceptance');
  check('T8c pron', f.pron, 'ˌtest');
  check('T8d audio只存編號（非URL）', f.pronAudio, 'test0001');
  check('T8e etymology含字源＋首次', f.etymology.includes('vessel') && f.etymology.includes('circa 1842'), true);
  check('T8f synonym單數逗號', f.synonym, 'trial, exam');
  check('T8g antonym單數', f.antonym, 'recess');
  check('T8h 無suggest', f.suggest, []);
  // 查無字：suggest 透出
  const f2 = merriamToFields({ word: 'testt', dictionary: ['testt', 'taste'], thesaurus: [] }, 'testt');
  check('T8i suggest透出', f2.suggest, ['testt', 'taste']);
  check('T8j 查無字pos空', f2.pos, '');
}

// ── MWFILTER1（live 實錘：mw-thes-ant.json 唯一條目 id=driver）──
{
  const driver = [{ meta: { id: 'driver', syns: [['automobilist', 'motorist']] }, syn_list: [{ wd: 'driver', syn: ['automobilist'] }] }];
  const t = parseThesaurusEntries(driver, 'ant');
  check('MWFILTER1a ant 不吃 driver（syn 空）', t.synonyms, []);
  check('MWFILTER1b ant 不吃 driver（related 空）', t.related, []);
  // 同 id 照收（run/run:1；後綴數字外丟）
  const runs = [
    { meta: { id: 'run', syns: [['dash']] } },
    { meta: { id: 'run:1', syns: [['sprint']] } },
    { meta: { id: 'run away', syns: [['flee']] } },
    { meta: { id: 'run:b', syns: [['junk']] } },
  ];
  const t2 = parseThesaurusEntries(runs, 'run');
  check('MWFILTER1c run 本體＋數字後綴收', t2.synonyms.sort(), ['dash', 'sprint']);
  // stems 兩刀：片語丟＋須含查詢詞（run/set 實測）
  check('MWFILTER1d 片語不出 derivative', !parseStems([{ meta: { id: 'run', stems: ['runs', 'up and running'] } }], 'run').includes('up and running'), true);
  check('MWFILTER1e 無關字不出 derivative', !parseStems([{ meta: { id: 'set:2', stems: ['class', 'seth'] } }], 'set').includes('class'), true);
  check('MWFILTER1f 含查詢詞照留', parseStems([{ meta: { id: 'set:2', stems: ['class', 'seth'] } }], 'set'), ['seth']);
  // 不傳 word＝舊行為（T7 相容，不炸）
  check('MWFILTER1g 不傳 word 不過濾', parseThesaurusEntries(driver).synonyms.includes('automobilist'), true);
}

// ── NC 負控制 ──
{
  // NC1：拔 et/date→etymology 空（解析敏感：段缺失≠整單炸）
  const { entries } = parseDictionaryEntries([{ meta: { id: 'x' }, hwi: { hw: 'x' }, fl: 'noun' }]);
  check('NC1 無et→et空字串', entries[0].et, '');
  check('NC1 無date→date空', entries[0].date, '');
  // NC2：拔 sound→pronAudio 空但 pron 仍可有（層級獨立）
  const e2 = parseDictionaryEntries([{ meta: { id: 'y' }, hwi: { hw: 'y', prs: [{ mw: 'ˌy' }] }, fl: 'noun' }]);
  check('NC2 無sound→audio空', e2.entries[0].pronAudio, '');
  check('NC2 pron仍在', e2.entries[0].pron, 'ˌy');
}

console.log(failures === 0 ? '═══ ALL PASS ═══' : `═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);
