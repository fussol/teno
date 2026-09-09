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

// ── word-extra：可見度預設全開、缺失回退 ──
const extra = await import('../src/lib/word-extra.js');
globalThis.window = {};
ok('FIELD_KEYS=12', extra.FIELD_KEYS.length === 12, extra.FIELD_KEYS.join(','));
ok('default all visible', extra.visShow('study', 'example') && extra.visShow('exam', 'syllables') && extra.visShow('browser', 'image'));
globalThis.window.__fieldVis = { browser: ['pron'], study: [], exam: ['example'] };
ok('browser gate', !extra.visShow('browser', 'example') && extra.visShow('browser', 'pron'));
ok('empty array = all hidden', !extra.visShow('study', 'example'));
// extraFieldsHtml 不再渲染片語獨立區塊
globalThis.window.__fieldVis = {};
const html = extra.extraFieldsHtml({ syllables: 'scram·ble', phrases: 'scramble up', etymology: 'x', synonym: 'a', antonym: 'b' }, (s) => s, 'study');
ok('no phrases block', !html.includes('片語') && html.includes('scram·ble'), html.slice(0, 60));

process.exit(fail ? 1 : 0);
