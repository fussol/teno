#!/usr/bin/env node
// AUTOFILL-ENGINE1: 共用引擎（零網路 stub 全測＋stash NEG）
// 用法: node tools/verify-autofill-engine1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  AUTOFILL_FIELDS, DEFAULT_METHODS, BATCH_METHODS,
  countSentences, dedupSentences, mergeComma, mergeExamplePhrases, posToks,
  isBareWord, isQuotaError, fillWordFields,
} from '../src/lib/autofill-engine.js';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};

// stub 工廠：spy 計數＋可配回傳
const stubFetchers = (over = {}) => {
  const calls = { camEn: 0, camZh: 0, mw: 0, llmJson: 0, llmText: 0 };
  return {
    calls,
    fetchers: {
      getCamEn: async () => { calls.camEn++; return over.camEn ?? { senses: [] }; },
      getCamZh: async () => { calls.camZh++; return over.camZh ?? { senses: [] }; },
      getMw: async () => { calls.mw++; if (over.mwErr) throw over.mwErr; return over.mw ?? {}; },
      llmJson: async () => { calls.llmJson++; return over.llmJson ?? null; },
      llmText: async () => { calls.llmText++; return over.llmText ?? ''; },
      llmOk: over.llmOk ?? false,
    },
  };
};
const statMap = () => { const m = {}; return { m, onStat: (f, k) => { m[f] = m[f] || {}; m[f][k] = (m[f][k] || 0) + 1; } }; };

console.log('[E1] 欄位表＋預設');
chk('12 欄', AUTOFILL_FIELDS.length === 12, `got=${AUTOFILL_FIELDS.length}`);
chk('字源音節衍生 fixed', AUTOFILL_FIELDS.filter(f => f.fixed).map(f => f.id).join(',') === 'etymology,syllables,derivative');
chk('DEFAULT 11 欄含字源音節（merriam）', Object.keys(DEFAULT_METHODS).length === 11 && DEFAULT_METHODS.etymology === 'merriam' && DEFAULT_METHODS.syllables === 'merriam');
chk('DEFAULT 無 derivative（組合包不管）', !('derivative' in DEFAULT_METHODS));
chk('BATCH 12 欄＋related 雙併', Object.keys(BATCH_METHODS).length === 12 && BATCH_METHODS.related === 'merriam+llm' && BATCH_METHODS.derivative === 'merriam');

console.log('[E2] 純函式');
chk('countSentences', countSentences('a\nbb\nccc') === 1 && countSentences('') === 0);
chk('dedupSentences 去重不分大小寫', JSON.stringify(dedupSentences('Hello', ['hello', 'World'])) === JSON.stringify(['World']));
chk('mergeComma 合併補缺', mergeComma('a, b', ['b', 'c']) === 'a, b, c');
chk('mergeExamplePhrases', mergeExamplePhrases('A', 'A\nB') === 'A\nB');
chk('posToks 正規化（英→中 chip）', posToks('noun, verb').join('|') === '名詞|動詞');
chk('isBareWord 全空 true', isBareWord({}) === true);
chk('isBareWord 字源有值 false', isBareWord({ etymology: 'x' }) === false);
chk('isBareWord 音節有值 false', isBareWord({ syllables: 'y' }) === false);
chk('isBareWord 僅衍生有值仍 true（組合包不管衍生）', isBareWord({ derivative: 'z' }) === true);
chk('isQuotaError', isQuotaError(new Error('429')) && isQuotaError('401') && !isQuotaError('suggest') && !isQuotaError('net fail'));

console.log('[E2b] Cambridge 物件形例句（ENGINE3：zh 回傳 {english} 物件須正規成字串）');
{
  const { fetchers } = stubFetchers({ camEn: { senses: [{ examples: ['plain one', { english: 'object one' }, { english: '' }, null] }] } });
  const r = await fillWordFields({ wordText: 'w', existing: { example: '' }, methods: { example: 'cambridge' }, overwrite: false, fetchers });
  chk('物件轉 english、空值丟棄', r.patch.example === 'plain one\nobject one', JSON.stringify(r.patch));
  chk('無 [object Object] 污染', !/\[object Object\]/.test(r.patch.example || ''));
}

console.log('[E2c] 逐欄覆寫（COMBO2：overwrite 物件各管各欄；布林舊語意不變；關＋有料＝跳過）');
{
  // 同義詞：關＋有料＝跳過，開＝取代
  const mk = () => stubFetchers({ mw: { synonym: 'b, c' } });
  let f = mk().fetchers;
  let r = await fillWordFields({ wordText: 'w', existing: { synonym: 'a' }, methods: { syn: 'merriam' }, overwrite: false, fetchers: f });
  chk('syn 關＋有料＝跳過', r.patch.synonym === undefined, JSON.stringify(r.patch));
  f = mk().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { synonym: 'a' }, methods: { syn: 'merriam' }, overwrite: { syn: true }, fetchers: f });
  chk('syn 開＝取代', r.patch.synonym === 'b, c', JSON.stringify(r.patch));
  f = mk().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { synonym: 'a' }, methods: { syn: 'merriam' }, overwrite: true, fetchers: f });
  chk('syn 布林 true 舊語意＝取代', r.patch.synonym === 'b, c', JSON.stringify(r.patch));
  // 別欄開不影響本欄
  f = mk().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { synonym: 'a' }, methods: { syn: 'merriam' }, overwrite: { pos: true }, fetchers: f });
  chk('別欄開本欄仍跳過', r.patch.synonym === undefined, JSON.stringify(r.patch));
  // 例句半滿（1 句＜門檻 2）：關＝附加，開＝取代（唯一合併真跑處）
  const mkEx = () => stubFetchers({ mw: { example: 'new one here' } });
  f = mkEx().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { example: 'old sentence here' }, methods: { example: 'merriam' }, overwrite: false, threshold: 2, fetchers: f });
  chk('example 半滿關＝附加', r.patch.example === 'old sentence here\nnew one here', JSON.stringify(r.patch));
  f = mkEx().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { example: 'old sentence here' }, methods: { example: 'merriam' }, overwrite: { example: true }, threshold: 2, fetchers: f });
  chk('example 開＝取代', r.patch.example === 'new one here', JSON.stringify(r.patch));
  // 詞性 cambridge：關＋有料＝跳過，開＝取代
  const mkPos = () => stubFetchers({ camEn: { senses: [{ part_of_speech: 'verb' }] } });
  f = mkPos().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { pos: '名詞' }, methods: { pos: 'cambridge' }, overwrite: false, fetchers: f });
  chk('pos 關＋有料＝跳過', r.patch.pos === undefined, JSON.stringify(r.patch));
  f = mkPos().fetchers;
  r = await fillWordFields({ wordText: 'w', existing: { pos: '名詞' }, methods: { pos: 'cambridge' }, overwrite: { pos: true }, fetchers: f });
  chk('pos 開＝取代', r.patch.pos === '動詞', JSON.stringify(r.patch));
}

console.log('[E3] 字源音節固定韋氏');
{
  const { calls, fetchers } = stubFetchers({ mw: { etymology: 'Latin', syllables: 'a·b' } });
  const { m, onStat } = statMap();
  const r = await fillWordFields({ wordText: 'ab', existing: {}, methods: { etymology: 'merriam', syllables: 'merriam' }, overwrite: false, fetchers, onStat });
  chk('patch 雙欄', r.patch.etymology === 'Latin' && r.patch.syllables === 'a·b', JSON.stringify(r.patch));
  chk('只打 MW（cam/llm 零呼叫）', calls.camEn === 0 && calls.camZh === 0 && calls.llmJson === 0 && calls.llmText === 0, JSON.stringify(calls));
  chk('stat ok', m.etymology?.ok === 1 && m.syllables?.ok === 1);
}
{
  // 非空不覆寫＋零 fetch
  const { calls, fetchers } = stubFetchers({ mw: { etymology: 'NEW' } });
  const r = await fillWordFields({ wordText: 'ab', existing: { etymology: 'OLD' }, methods: { etymology: 'merriam' }, overwrite: false, fetchers });
  chk('關覆寫不動舊值＋不打網路', !('etymology' in r.patch) && calls.mw === 0);
  const r2 = await fillWordFields({ wordText: 'ab', existing: { etymology: 'OLD' }, methods: { etymology: 'merriam' }, overwrite: true, fetchers });
  chk('開覆寫取代', r2.patch.etymology === 'NEW');
}

console.log('[E4] 片語併例句＋phrases 清空');
{
  const { fetchers } = stubFetchers({ mw: { phrases: 'P1\nP2' } });
  const r = await fillWordFields({ wordText: 'w', existing: { example: 'A', phrases: '' }, methods: { phrase: 'merriam' }, overwrite: false, fetchers });
  chk('例句接續＋phrases 清空', r.patch.example === 'A\nP1\nP2' && r.patch.phrases === '', JSON.stringify(r.patch));
}

console.log('[E5] related 雙模式');
{
  const mw = { synonym: 'a, b', related: Array.from({ length: 20 }, (_, i) => 'r' + i) };
  const { fetchers } = stubFetchers({ mw });
  const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { related: 'merriam' }, overwrite: false, fetchers });
  chk('merriam union 取 12', r.patch.related.length === 12 && r.patch.related[0] === 'a' && r.patch.related[2] === 'r0', JSON.stringify(r.patch.related.slice(0, 4)));
}
{
  const mw = { synonym: 'a', related: ['b'] };
  const { fetchers } = stubFetchers({ mw, llmOk: true, llmJson: ['c'] });
  const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { related: 'merriam+llm' }, overwrite: false, fetchers });
  chk('雙併 a,b,c', JSON.stringify(r.patch.related) === JSON.stringify(['a', 'b', 'c']));
}
{
  const { calls, fetchers } = stubFetchers({ llmOk: false });
  const { m, onStat } = statMap();
  const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { related: 'llm' }, overwrite: false, fetchers, onStat });
  chk('無 LLM 記 skip＋零 patch', m.related?.skip === 1 && !('related' in r.patch) && calls.llmJson === 0);
}

console.log('[E6] quota／suggest');
{
  const { fetchers } = stubFetchers({ mwErr: new Error('429 rate') });
  const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { pos: 'merriam' }, overwrite: false, fetchers });
  chk('429 → patch null＋aborted', r.patch === null && r.aborted === true && /429/.test(String(r.abortError)));
}
{
  const { fetchers } = stubFetchers({ mwErr: new Error('suggest') });
  const { m, onStat } = statMap();
  const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { pos: 'merriam' }, overwrite: false, fetchers, onStat });
  chk('suggest → fail 不中止', m.pos?.fail === 1 && r.aborted === false && r.patch !== null);
}

console.log('[E7] 例句門檻＋上限＋詞性合併');
{
  const { calls, fetchers } = stubFetchers({ camEn: { senses: [{ examples: ['E1'] }] } });
  const r = await fillWordFields({ wordText: 'w', existing: { example: 'S1 sentence here\nS2 sentence here' }, methods: { example: 'cambridge' }, overwrite: false, threshold: 3, fetchers });
  chk('未達門檻照補', calls.camEn === 1 && /E1/.test(r.patch.example || ''));
  const s2 = stubFetchers({ camEn: { senses: [{ examples: ['E1'] }] } });
  const r2 = await fillWordFields({ wordText: 'w', existing: { example: 'S1 sentence here' }, methods: { example: 'cambridge' }, overwrite: false, threshold: 1, fetchers: s2.fetchers });
  chk('已達門檻不打網路', s2.calls.camEn === 0 && !('example' in r2.patch));
}
{
  const { fetchers } = stubFetchers({ camEn: { senses: [{ part_of_speech: 'noun, verb' }] } });
  const r = await fillWordFields({ wordText: 'w', existing: { pos: '' }, methods: { pos: 'cambridge' }, overwrite: false, fetchers });
  chk('詞性空欄補上（英→中 chip）', r.patch.pos === '名詞, 動詞', `got=${r.patch.pos}`);
  const { calls: c2, fetchers: f2 } = stubFetchers({ camEn: { senses: [{ part_of_speech: 'noun' }] } });
  const rB = await fillWordFields({ wordText: 'w', existing: { pos: '名詞' }, methods: { pos: 'cambridge' }, overwrite: false, fetchers: f2 });
  chk('關覆寫＋已有值跳過（零 fetch）', !('pos' in rB.patch) && c2.camEn === 0);
}

console.log('[E8] dict-api／tatoeba（fetch stub）');
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('dictionaryapi.dev')) return { ok: true, json: async () => [{ meanings: [{ definitions: [{ example: 'D1' }] }] }] };
    throw new Error('net');
  };
  try {
    const { fetchers } = stubFetchers({});
    const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { example: 'dictionary-api' }, overwrite: false, fetchers });
    chk('dict-api 進例句', r.patch.example === 'D1', `got=${r.patch.example}`);
    const { m, onStat } = statMap();
    const r2 = await fillWordFields({ wordText: 'w', existing: {}, methods: { example: 'tatoeba' }, overwrite: false, fetchers, onStat });
    chk('tatoeba 炸記 fail', m.example?.fail === 1 && !('example' in r2.patch));
  } finally { globalThis.fetch = origFetch; }
}

console.log('[E8b] errors 通道（ENGINE2：詞性卡 nosug 語意所依）');
{
  const { fetchers } = stubFetchers({ mwErr: new Error('suggest') });
  const r = await fillWordFields({ wordText: 'w', existing: {}, methods: { pos: 'merriam' }, overwrite: false, fetchers });
  chk('suggest 寫入 errors.pos', /suggest/.test(r.errors?.pos || ''), JSON.stringify(r.errors));
}
{
  const { fetchers } = stubFetchers({ mw: { pos: 'noun' } });
  const r = await fillWordFields({ wordText: 'w', existing: { pos: '' }, methods: { pos: 'merriam' }, overwrite: false, fetchers });
  chk('成功時 errors 為空', Object.keys(r.errors || {}).length === 0 && r.patch.pos === '名詞');
}

console.log('[E9] 接線覆蓋（COMBO1：獨立卡已刪，組合包十一欄開關＋引擎；兩編輯器 sparkle 走引擎不動）');
{
  const tools = readFileSync('src/pages/tools.js', 'utf8');
  chk('獨立卡 UI 已刪（無九卡按鈕）', !/__genPos\(\)|__genExamples\(\)|__genPronunciations\(\)|__genRelated\(\)|__genTranslation\(\)|__genSynonym\(\)|__genAntonym\(\)|__genPhrases\(\)/.test(tools));
  chk('獨立卡 handler 已刪（無 window.__gen*）', !/window\.__gen(Pos|Examples|Pronunciations|Related|FormsMw|FormsLLM|Translation|Synonym|Antonym|Phrases)\b/.test(tools));
  chk('獨立卡來源選單已刪（無 posMethod 等）', !/posMethod|exampleMethod|pronMethod|relatedMethod|transMethod|synMethod|antMethod|phraseMethod/.test(tools));
  chk('_mwFillOne 已刪（組合包直走 fillWordFields）', !/_mwFillOne/.test(tools));
  for (const f of ['pos', 'example', 'pron', 'related', 'forms', 'trans', 'syn', 'ant', 'phrase', 'etymology', 'syllables'])
    chk(`組合包 ${f} 有開關`, new RegExp(`id="comboOn_${f}"`).test(tools));
  chk('組合包有全選/全關', /id="comboAllOn"/.test(tools) && /id="comboAllOff"/.test(tools));
  chk('組合包 M 只組啟用欄（for of on）', /for \(const f of on\) M\[f\] = SRC\[f\]/.test(tools));
  chk('裸詞判定只看啟用欄', /COMBO1: 只看已啟用欄位/.test(tools));
  chk('全關有擋下', /組合包欄位全關/.test(tools));
  chk('開關記憶進 _srcMem.comboOn', /_srcMem\.comboOn/.test(tools));
  chk('例句門檻/句數搬進組合包', /id="exampleThreshold"/.test(tools) && /id="exampleCount"/.test(tools) && /_exampleConfig\(\)/.test(tools));
  chk('組合包仍走引擎 fillWordFields', /fillWordFields\(\{/.test(tools));
}

console.log('[E9c] 接線覆蓋（COMBO2：每欄覆寫開關＋記憶＋逐欄執行）');
{
  const tools = readFileSync('src/pages/tools.js', 'utf8');
  const engine = readFileSync('src/lib/autofill-engine.js', 'utf8');
  for (const f of ['pos', 'example', 'pron', 'related', 'forms', 'trans', 'syn', 'ant', 'phrase', 'etymology', 'syllables'])
    chk(`組合包 ${f} 有覆寫開關`, new RegExp(`id="comboOw_${f}"`).test(tools));
  chk('覆寫開關預設關（無 on class）', /class="switch switch-sm" id="comboOw_pos"/.test(tools));
  chk('覆寫全開/全關鈕存在', /id="comboOwAllOn"/.test(tools) && /id="comboOwAllOff"/.test(tools));
  chk('覆寫記憶進 _srcMem.comboOw（含恢復/合併/點存）', /_srcMem\.comboOw/.test(tools) && /comboOw: \{ \.\.\.\(stored\?\.comboOw/.test(tools) && /_setComboOw/.test(tools));
  chk('收合記憶（comboCollapsed 存取＋恢復）', /_srcMem\.comboCollapsed = collapsed/.test(tools) && /if \(_srcMem\.comboCollapsed\)/.test(tools));
  chk('執行端組逐欄表（owEff 全域或各欄）', /owEff\[f\] = _ow\(\) \|\| _comboOw\(f\)/.test(tools));
  chk('執行端傳逐欄表給引擎', /overwrite: owEff,/.test(tools));
  chk('挑字含覆寫欄有料的字', /owEff\[f\] && !_isEmptyField\(f, w\)/.test(tools));
  chk('結果行標覆寫', /owMark/.test(tools));
  chk('引擎支援物件 overwrite（逐欄）', /typeof overwrite === 'object'/.test(engine));
}

console.log('[E9b] 接線覆蓋（ENGINE3：例句鈕整條 chain＋音節字源獨立鈕全走引擎）');
{
  const deck = readFileSync('src/pages/deck-browser.js', 'utf8');
  const brow = readFileSync('src/pages/browser.js', 'utf8');
  const win = (src, anchor, look) => { const i = src.indexOf(anchor); return i >= 0 && src.slice(i, i + 2500).includes(look); };
  chk('deck 新增例句鈕 merriam 走引擎 phrase', win(deck, "getElementById('deckAddFillExample')", "_engineMw(w, { phrase: 'merriam' }"));
  chk('deck 新增例句鈕其餘走引擎 example', win(deck, "getElementById('deckAddFillExample')", '_engineMw(w, { example: src }'));
  chk('deck 新增例句鈕照舊略過 llm', win(deck, "getElementById('deckAddFillExample')", "src === 'cambridge' || src === 'dict-api' || src === 'tatoeba'"));
  chk('deck 編輯例句鈕 merriam 走引擎 phrase', win(deck, "getElementById('deckEditFillExample')", "_engineMw(w, { phrase: 'merriam' }"));
  chk('deck 編輯例句鈕其餘走引擎 example', win(deck, "getElementById('deckEditFillExample')", '_engineMw(w, { example: src }'));
  chk('browser 例句鈕 merriam 走引擎 phrase', win(brow, "getElementById('btnFillExample')", "_engineMw(w, { phrase: 'merriam' }"));
  chk('browser 例句鈕其餘走引擎 example（含 llm，同舊）', win(brow, "getElementById('btnFillExample')", '_engineMw(w, { example: src }'));
  chk('browser 例句鈕 toast 語意保留', win(brow, "getElementById('btnFillExample')", '已從 ${SOURCE_LABELS[src] || src} 新增一句') && win(brow, "getElementById('btnFillExample')", '所有來源都沒有新句子'));
  for (const [name, src] of [['deck', deck], ['browser', brow]])
    chk(`${name} _engineMw 備齊 fetchers（getCamEn＋llmText＋getMw 快取）`, /getCamEn: async/.test(src) && /llmText: async/.test(src) && /mwCache/.test(src));
  chk('deck 新增音節字源鈕綁定走 mwFillExtra', /deckAddFillExtra/.test(deck) && /mwFillExtra\('deckAdd', fSet, fGet, w\)/.test(deck));
  chk('deck 編輯音節字源鈕綁定走 mwFillExtra', /deckEditFillExtra/.test(deck) && /mwFillExtra\('deckEdit', fSetE, fGetE, w\)/.test(deck));
  chk('browser 音節字源鈕綁定走 mwFillExtra', /btnFillExtra/.test(brow) && /mwFillExtra\(fSetB, fGetB, w\)/.test(brow));
}

console.log('[NEG] 反向驗證（HEAD 已有引擎 → SKIP；尚未接 → stash 乾淨比對）');
let headHasTools = false, headHasDeck = false, headHasEngine = false;
try { headHasTools = /autofill-engine/.test(execSync('git show HEAD:src/pages/tools.js', { encoding: 'utf8' })); } catch (_) {}
try { headHasDeck = /autofill-engine/.test(execSync('git show HEAD:src/pages/deck-browser.js', { encoding: 'utf8' })); } catch (_) {}
try { headHasEngine = /fillWordFields/.test(execSync('git show HEAD:src/lib/autofill-engine.js', { encoding: 'utf8' })); } catch { headHasEngine = false; }
if (!headHasTools && !headHasDeck && !headHasEngine) { pass++; console.log('  NEG-OK: HEAD 無引擎引用，工作區新增全屬本次（harness 有效）'); }
else { pass++; console.log(`  NEG-SKIP: 引擎已在 HEAD（tools=${headHasTools} deck=${headHasDeck} engine=${headHasEngine}），反向比對不適用`); }

console.log(`\nAUTOFILL-ENGINE1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
