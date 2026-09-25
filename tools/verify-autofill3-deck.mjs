#!/usr/bin/env node
// AUTOFILL3：deck-browser 新增/編輯 modal 自動填入改吃「設定 → 自動補齊（組合包）」逐欄來源
//   [S] 源碼接線：鏈已退場、四處呼叫點走共用執行器、映射完整
//   [S] 契約對齊：_addExisting/_editExisting 的鍵 == 各 modal 存檔器的鍵（錯一個就靜默漏欄）
//   [S] 未定義變數防護：editAutoFillChain 等移除後不得再有程式碼引用（會 ReferenceError）
//   [B] 引擎＋組合包整合（同 L2 路徑，這裡驗共用模組本身）
// 用法: node tools/verify-autofill3-deck.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};

const deck = readFileSync('src/pages/deck-browser.js', 'utf8');
const codeOnly = deck.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
/** 從 marker 起、到下一個 `\n  };` 為止的程式碼片段 */
const grab = (marker) => { const i = deck.indexOf(marker); return i === -1 ? '' : deck.slice(i, deck.indexOf('\n  };', i)); };

console.log('[S] chip 排序鏈已退場');
for (const k of ['getChain', 'autoFillChain', 'editAutoFillChain', 'AUTO_FILL_DEFAULT', 'AUTO_FILL_LABELS', '_normalizeAutoChain', 'renderAutoOrderChips', 'autoFillOrder', 'auto-order-chip']) {
  chk(`${k} 無程式碼引用`, !codeOnly.includes(k));
}
chk('「自動填入順序」標籤已移除', !codeOnly.includes('自動填入順序'));
chk('兩處 chip 容器已移除', !deck.includes('AutoOrderChips'));

console.log('[S] 四處呼叫點走共用執行器');
chk('新增 modal 自動填入', /const r = await comboAutoFill\(w, _addExisting\(\)\)/.test(deck));
chk('編輯 modal 自動填入', /const r = await comboAutoFill\(w, _editExisting\(\)\)/.test(deck));
chk('新增 modal 例句鈕', /const \{ cands \} = await comboExampleCandidate\(w\);/.test(deck));
chk('自動填入本體無自有 fetcher 組（已收斂到共用模組）',
  !grab('const autoFillAll = async () => {').includes('getCamEn') && !grab('const editAutoFillAll = async () => {').includes('getCamEn'));
chk('_engineMw 保留（音節/字源鈕等韋氏專用捷徑仍用）', /async function _engineMw\(/.test(deck));
chk('共用執行器 import ≥4（四處呼叫點）', (deck.match(/lib\/autofill-run\.js/g) || []).length >= 4);

console.log('[S] 欄位映射完整性');
const PATCH_KEYS = ['pos', 'definition', 'example', 'pron', 'related', 'forms', 'synonym', 'antonym', 'derivative', 'etymology', 'syllables'];
const addFn = grab('const _applyAddPatch = (p) => {');
const editFn = grab('const _applyEditPatch = (p) => {');
for (const k of PATCH_KEYS) {
  chk(`_applyAddPatch 處理 patch.${k}`, addFn.includes(`p.${k}`));
  chk(`_applyEditPatch 處理 patch.${k}`, editFn.includes(`p.${k}`));
}
chk('新增 chip 映射表完整', ['deckAddDef:', 'deckAddExample:', 'deckAddRelated:', 'deckAddForms:', 'deckAddSynonym:', 'deckAddAntonym:', 'deckAddDerivative:'].every(s => deck.includes(s)));
chk('編輯 chip 映射表完整', ['deckEditDef:', 'deckEditExample:', 'deckEditRelated:', 'deckEditForms:', 'deckEditSynonym:', 'deckEditAntonym:', 'deckEditDerivative:'].every(s => deck.includes(s)));

console.log('[S] existing 契約對齊存檔器');
// 取出 _addExisting 的鍵
const keysOf = (marker) => {
  const src = grab(marker);
  return [...src.matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]).sort();
};
const addKeys = keysOf('const _addExisting = () => ({');
chk('_addExisting 有 12 鍵', addKeys.length === 12, JSON.stringify(addKeys));
chk('引擎契約欄位齊', ['definition', 'example', 'etymology', 'forms', 'phrases', 'pos', 'pron', 'related', 'syllables', 'synonym', 'antonym', 'derivative'].every(k => addKeys.includes(k)), JSON.stringify(addKeys));
// 存檔器契約（related/forms 必須轉陣列，否則引擎 ex.related?.length 判空失準）
chk('related 依契約轉陣列（新增）', /related: _splitListAdd\(/.test(deck));
chk('forms 依契約轉陣列（新增）', /forms: _splitListAdd\(/.test(deck));
chk('related 依契約轉陣列（編輯）', /related: _splitListE\(/.test(deck));
chk('forms 依契約轉陣列（編輯）', /forms: _splitListE\(/.test(deck));
// 存檔器的 related/forms 也是 split 成陣列 → 兩邊語意一致
chk('存檔器 related 亦為陣列（契約一致）', /related: deckRelChips\.getVal\(\)\.split\(\/\[,，\]\/\)/.test(deck));
chk('存檔器 forms 亦為陣列（契約一致）', /forms: deckFormsChips\.getVal\(\)\.split\(\/\[,，\]\/\)/.test(deck));

console.log('[NEG] 負控制：移除的變數若被引用會 ReferenceError');
{
  // 我曾真的留下 deckEditFillExample 還在 iterate editAutoFillChain 的殘骸
  const uses = [...codeOnly.matchAll(/\bfor \(const src of \w*[Aa]utoFillChain\)/g)];
  chk('不再有任何 for..of <chain> 迴圈（唯一消費點已改）', uses.length === 0, String(uses.length));
  chk('∴ 不存在對已移除變數的引用', !codeOnly.includes('editAutoFillChain'));
}

console.log('[B] 共用模組：引擎＋組合包整合');
const { comboConfig, fillWordFields } = await import('../src/lib/autofill-engine.js');
const mkFetchers = () => ({
  getCamEn: async () => ({ uk_ipa: 'həˈləʊ', senses: [{ part_of_speech: 'noun', definition: 'greeting', examples: [{ english: 'Hello there.' }] }] }),
  getCamZh: async () => ({ senses: [{ translation: '你好' }] }),
  // 註：引擎的 f.forms/f.synonym/f.antonym 期待「字串」（逗號分隔），f.related 期待陣列
  getMw: async () => ({ pron: 'həˈloʊ', pos: 'noun', synonym: 'hi, hey', antonym: 'bye', related: ['greeting'],
    forms: 'hellos, helloed', etymology: 'OE', syllables: 'hel·lo', example: 'Hello there.', derivative: 'hellos' }),
  llmText: async () => 'LLM 值', llmJson: async () => ['a', 'b'], llmOk: true,
});
{
  // example 指定 cambridge 以避開 dictionary-api 的真網路（node 環境無外網）
  const cfg = comboConfig({ selectors: { comboPos: 'merriam', comboPron: 'merriam', comboExample: 'cambridge' } }, false);
  const r = await fillWordFields({ wordText: 'hello', existing: {}, methods: cfg.methods, overwrite: cfg.overwrite,
    threshold: 1, count: 1, fetchers: mkFetchers(), onStat: () => {} });
  chk('組合包 selector 生效（pos/pron 走韋氏）', /名詞|noun/.test(r.patch.pos) && /həˈloʊ/.test(r.patch.pron), JSON.stringify([r.patch.pos, r.patch.pron]));
  chk('deck modal 會套用到的 patch 鍵齊備', ['pos', 'definition', 'pron', 'synonym', 'antonym', 'derivative', 'etymology', 'syllables', 'example', 'forms'].every(k => k in r.patch), JSON.stringify(Object.keys(r.patch)));
  chk('related 為陣列（餵 deck 表單 join）', Array.isArray(r.patch.related));
  chk('forms 為陣列（餵 deck 表單 join）', Array.isArray(r.patch.forms), typeof r.patch.forms);
}

console.log(`\nAUTOFILL3: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
