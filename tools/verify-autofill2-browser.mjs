#!/usr/bin/env node
// AUTOFILL2：browser.js 自動填入改吃「設定 → 自動補齊（組合包）」逐欄來源（取代 chip 排序鏈）
//   [S] 源碼接線：鏈已退場、_comboAutoFill 走引擎、patch 全鍵有映射
//   [B] 引擎＋組合包設定整合（mock fetcher；tatoeba/dict-api 用 stub fetch 免真網路）
//   [NEG] 負控制：關掉的欄位在舊語意下會被寫、新語意下不寫（差異可觀測）
// 用法: node tools/verify-autofill2-browser.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};

const browser = readFileSync('src/pages/browser.js', 'utf8');

console.log('[S] chip 排序鏈已退場');
// 只允許出現在註解裡：剝掉註解行後不得再有引用
const codeOnly = browser.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
for (const k of ['getChain', 'autoFillChain', 'DEFAULT_CHAIN', '_normalizeChain', 'renderChips', 'fAutoChip']) {
  chk(`${k} 無程式碼引用`, !codeOnly.includes(k));
}
chk('fAutoOrderChips 不在模板', !browser.includes('id="fAutoOrderChips"'));
chk('autoFillOrder 不再讀寫（鏈已移除）', !codeOnly.includes('autoFillOrder'));
chk('「自動填入順序」標籤已移除', !codeOnly.includes('自動填入順序'));

console.log('[S] 新接線');
chk('_comboAutoFill 存在', /async function _comboAutoFill\(word, existing\)/.test(browser));
chk('_comboAutoFill 讀組合包設定', /readComboConfig\(\)/.test(browser));
chk('_comboAutoFill 呼叫引擎', /fillWordFields\(\{/.test(browser) && /wordText: word, existing, methods, overwrite/.test(browser));
chk('fetchers 六件齊',
  ['getCamEn', 'getCamZh', 'getMw', 'llmJson', 'llmText', 'llmOk'].every(k => browser.includes(k + (k === 'llmOk' ? ': true' : ' =')) || browser.includes(k)));
chk('autoFillAll 走 _comboAutoFill', /const r = await _comboAutoFill\(w, _formExisting\(\)\)/.test(browser));
chk('表單→引擎映射存在', /const _formExisting = \(\) => \(\{/.test(browser));
chk('引擎→表單映射存在', /const _applyPatch = \(p\) => \{/.test(browser));

console.log('[S] 欄位映射完整性');
// 引擎會吐的 patch key（見引擎註解「patch：欄位差量」）
const PATCH_KEYS = ['pos', 'definition', 'example', 'pron', 'related', 'forms', 'synonym', 'antonym', 'derivative', 'etymology', 'syllables'];
const applyBody = browser.slice(browser.indexOf('const _applyPatch = (p) => {'));
const applyFn = applyBody.slice(0, applyBody.indexOf('\n  };'));
for (const k of PATCH_KEYS) chk(`_applyPatch 處理 patch.${k}`, applyFn.includes(`p.${k}`));
chk('chip 欄位映射表完整',
  ['fDefinition: \'fDefChips\'', 'fExample: \'fExChips\'', 'fRelated: \'fRelatedChips\'', 'fForms: \'fFormsChips\'',
   'fSynonyms: \'fSynonymChips\'', 'fAntonyms: \'fAntonymChips\'', 'fDerivatives: \'fDerivativeChips\'']
    .every(s => browser.includes(s)));
chk('related/forms 依契約轉陣列', /related: _splitList\(/.test(browser) && /forms: _splitList\(/.test(browser));

// ── 整合：引擎 ＋ 組合包設定 ──
const { comboConfig, fillWordFields } = await import('../src/lib/autofill-engine.js');

const mkFetchers = () => {
  const calls = [];
  return {
    calls,
    getCamEn: async () => { calls.push('camEn'); return { uk_ipa: 'həˈləʊ', senses: [{ part_of_speech: 'noun', definition: 'greeting' }] }; },
    getCamZh: async () => { calls.push('camZh'); return { senses: [{ translation: '你好', part_of_speech: 'noun' }] }; },
    getMw: async () => {
      calls.push('mw');
      return { pron: 'həˈloʊ', pos: 'noun', synonym: 'hi, hey', antonym: 'bye', related: ['greeting'],
               forms: ['hellos', 'helloed'], etymology: 'OE', syllables: 'hel·lo', example: 'Hello there.', phrases: 'say hello', derivative: 'hellos' };
    },
    llmText: async () => { calls.push('llmText'); return 'LLM 值'; },
    llmJson: async () => { calls.push('llmJson'); return ['a', 'b']; },
    llmOk: true,
  };
};
const run = (methods, overwrite, existing = {}) =>
  fillWordFields({ wordText: 'hello', existing, methods, overwrite, threshold: 1, count: 1,
    fetchers: mkFetchers(), onStat: () => {} });

console.log('[B] 逐欄來源真的生效');
{
  const r = await run({ pron: 'merriam' }, {});
  chk('pron=merriam → 來自韋氏', /həˈloʊ/.test(r.patch.pron), r.patch.pron);
}
{
  const r = await run({ pron: 'cambridge' }, {});
  chk('pron=cambridge → 來自 Cambridge', /həˈləʊ/.test(r.patch.pron), r.patch.pron);
}
{
  const r = await run({ trans: 'cambridge' }, {});
  chk('trans=cambridge → 中文翻譯寫入 patch.definition', r.patch.definition === '你好', r.patch.definition);
}
{
  const r = await run({ related: 'merriam' }, {});
  chk('related 是陣列', Array.isArray(r.patch.related), typeof r.patch.related);
  chk('related 內容正確', r.patch.related.includes('greeting'), JSON.stringify(r.patch.related));
}
{
  const r = await run({ syn: 'merriam', ant: 'merriam', derivative: 'merriam' }, {});
  chk('syn/ant 都來自韋氏', r.patch.synonym === 'hi, hey' && r.patch.antonym === 'bye',
    JSON.stringify([r.patch.synonym, r.patch.antonym]));
  chk('derivative 來自韋氏（不再靜默漏補）', r.patch.derivative === 'hellos', String(r.patch.derivative));
}

console.log('[B] 關掉的欄位不寫（comboOn=false）');
{
  const cfg = comboConfig({ comboOn: { pron: false } }, false);
  chk('comboConfig 移除 pron', !('pron' in cfg.methods));
  const r = await run(cfg.methods, cfg.overwrite, {});
  chk('點掉 pron → patch 不含 pron', !('pron' in r.patch), JSON.stringify(Object.keys(r.patch)));
}

console.log('[B] 覆寫語意（逐欄）');
{
  const r = await run({ pron: 'merriam' }, { pron: false }, { pron: '/old/' });
  chk('未開覆寫＋已有值 → 不動', !('pron' in r.patch), JSON.stringify(r.patch));
}
{
  const r = await run({ pron: 'merriam' }, { pron: true }, { pron: '/old/' });
  chk('開覆寫＋已有值 → 覆寫', /həˈloʊ/.test(r.patch.pron), r.patch.pron);
}
{
  const cfg = comboConfig({ comboOw: { syn: true } }, false);
  const r = await run(cfg.methods, cfg.overwrite, { synonym: '舊值' });
  chk('逐欄覆寫（syn）生效', r.patch.synonym === 'hi, hey', r.patch.synonym);
  chk('未開覆寫的欄位仍只補空', !('antonym' in r.patch) || r.patch.antonym === 'bye');
}

console.log('[B] comboConfig 全預設 → 引擎照跑（＝舊行為）');
{
  const cfg = comboConfig(null, false);
  const r = await run(cfg.methods, cfg.overwrite, {});
  chk('11 欄幾乎都填到', Object.keys(r.patch).length >= 8, String(Object.keys(r.patch).length));
  chk('無 abort', r.aborted === false);
}

console.log('[NEG] 負控制：關掉的欄位舊語意下會寫');
{
  // 舊語意＝鏈上所有欄位都跑（無「開關」概念）；新語意＝comboOn 可關
  const onAll = await run({ pron: 'merriam' }, {}, {});
  chk('（舊）全開時 pron 會被寫', 'pron' in onAll.patch);
  const off = await run(comboConfig({ comboOn: { pron: false } }, false).methods, {}, {});
  chk('（新）關掉後 pron 不寫 → 差異可觀測', !('pron' in off.patch));
}

console.log(`\nAUTOFILL2: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
