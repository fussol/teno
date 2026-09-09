// 驗證：片語併入例句（mergeExamplePhrases／wordExample，抽 src/lib/svg.js 實碼執行）
// ＋ 欄位可見度預設（src/lib/word-extra.js 直接 import，無外部依賴）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

// ── 抽實碼：svg.js 的 merge／wordExample（避開 lucide .svg import，只抽兩函式）──
const svgSrc = readFileSync(join(root, 'src/lib/svg.js'), 'utf8');
const m1 = svgSrc.match(/export function mergeExamplePhrases[\s\S]*?\n\}/);
const m2 = svgSrc.match(/export function wordExample[\s\S]*?\n\}/);
ok('extract mergeExamplePhrases', !!m1);
ok('extract wordExample', !!m2);
const factory = new Function(`${m1[0].replace('export function', 'function')}\n${m2[0].replace('export function', 'function')}\nreturn { mergeExamplePhrases, wordExample };`);
const { mergeExamplePhrases, wordExample } = factory();

// 1. scramble 案例：例句3行＋片語2行（1行重複）→ 4行、例句在前
const ex = 'She scrambled up the steep hillside.\nPassengers scrambled for the door.\nWe had bacon and scrambled eggs for breakfast.';
const ph = 'scramble up\nWe had bacon and scrambled eggs for breakfast.';
const merged = wordExample({ example: ex, phrases: ph });
const lines = merged.split('\n');
ok('merge dedup+order', lines.length === 4 && lines[0].startsWith('She scrambled') && lines[3] === 'scramble up', `got ${lines.length} lines`);

// 2. 空片語 → 原樣
ok('empty phrases passthrough', wordExample({ example: ex, phrases: '' }) === ex);
// 3. 兩空 → 空字串
ok('both empty', wordExample({ example: '', phrases: '' }) === '');
// 4. 只有片語 → 片語即例句
ok('phrases only', wordExample({ example: '', phrases: 'take off\ntake off \n take off' }) === 'take off');
// 5. 空白行過濾
ok('blank lines dropped', mergeExamplePhrases('a\n\nb', '\n c \n') === 'a\nb\nc');

// ── word-extra：可見度預設全開、缺失回退、新 ctx 別名 ──
const extra = await import('../src/lib/word-extra.js');
globalThis.window = {};
ok('FIELD_KEYS=13', extra.FIELD_KEYS.length === 13, extra.FIELD_KEYS.join(','));
ok('word is first key', extra.FIELD_KEYS[0] === 'word');
ok('default all visible', extra.visShow('study', 'example') && extra.visShow('exam', 'syllables') && extra.visShow('browserFront', 'image'));
// exam 是 study 別名：只設 study，exam 跟著走
globalThis.window.__fieldVis = { browserFront: ['pron'], browserBack: [], study: [] };
ok('browserFront gate', !extra.visShow('browserFront', 'example') && extra.visShow('browserFront', 'pron'));
ok('exam aliases study', !extra.visShow('exam', 'example') && !extra.visShow('study', 'example'));
ok('empty array = all hidden', !extra.visShow('study', 'example'));
ok('legacy browser aliases front', !extra.visShow('browser', 'example') && extra.visShow('browser', 'pron'));
// extraFieldsHtml 不再渲染片語獨立區塊
globalThis.window.__fieldVis = {};
const html = extra.extraFieldsHtml({ syllables: 'scram·ble', phrases: 'scramble up', etymology: 'x', synonym: 'a', antonym: 'b' }, (s) => s, 'study');
ok('no phrases block', !html.includes('片語') && html.includes('scram·ble'), html.slice(0, 60));

// ── cardFaceHtml：正反面各走各的可見度、單字只在字卡可關 ──
const H = {
  escapeHtml: (s) => String(s ?? ''),
  wordImageSlotHTML: () => '<img>',
  splitFieldsHtml: () => '',
  fmtExample: (s) => s,
  wordExample,
};
const w = { id: 'w1', word: 'proof', pron: 'pr', definition: 'def', example: 'ex1', tags: ['correct'], related: [], forms: [] };
const s = { state: { decks: [], tagConfig: {} } };
globalThis.window.__fieldVis = { browserFront: ['word'], browserBack: ['word', 'pron', 'definition', 'example', 'tags'], study: ['word'] };
const front = extra.cardFaceHtml(w, s, 'browserFront', H);
const back = extra.cardFaceHtml(w, s, 'browserBack', H);
ok('front only word', front.includes('proof') && !front.includes('def') && !front.includes('ex1'), front.slice(0, 80));
ok('back has fields', back.includes('proof') && back.includes('def') && back.includes('ex1') && back.includes('correct'), back.slice(0, 80));
// 正面關掉 word：該面無單字（字卡限定行為）
globalThis.window.__fieldVis.browserFront = ['pron'];
const frontNoWord = extra.cardFaceHtml(w, s, 'browserFront', H);
ok('front word can hide', !frontNoWord.includes('proof') && frontNoWord.includes('pr'), frontNoWord.slice(0, 80));

// ── 空欄位整塊隱藏（含標題，不塞佔位）──
globalThis.window.__fieldVis = {};
const s2 = { state: { decks: [], tagConfig: {} } };
const emptyW = { id: 'w0', word: 'blank', pos: '', definition: '', example: '', pron: '', description: '', related: [], forms: [], tags: [] };
const emptyHtml = extra.cardFaceHtml(emptyW, s2, 'browserBack', H);
ok('empty hides all', emptyHtml.includes('blank') && !emptyHtml.includes('card-panel-def') && !emptyHtml.includes('card-panel-example') && !emptyHtml.includes('card-panel-pron') && !emptyHtml.includes('無定義') && !emptyHtml.includes('>-<'), emptyHtml.slice(0, 100));
const posOnly = extra.cardFaceHtml({ ...emptyW, pos: '動詞' }, s2, 'browserBack', H);
ok('pos-only shows pos no def', posOnly.includes('動詞') && !posOnly.includes('card-panel-def'), posOnly.slice(0, 100));
const defOnly = extra.cardFaceHtml({ ...emptyW, definition: '跑' }, s2, 'browserBack', H);
ok('def-only shows def', defOnly.includes('跑'), defOnly.slice(0, 100));

process.exit(fail ? 1 : 0);
