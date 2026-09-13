// SHARE1: 分享匯出驗證 — 內容 only、不含 tag，匯入端回吃正常
import { buildCSV, buildShareCSV, parseCSV } from '../src/core/import.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const words = [
  { word: 'apple', definition: '蘋果', pos: 'n', pron: 'a', example: 'ex', deck: 'D1', image: '', description: 'd', tags: ['私人', '難字'], related: [], forms: [], synonym: 's', antonym: 'a', derivative: '', examples: ['e1'], etymology: '', syllables: '', phrases: '' },
  { word: 'run, fast', definition: '跑 "快"', pos: '', pron: '', example: 'a\nb', deck: 'D1', image: '', description: '', tags: ['x'], related: [], forms: [], synonym: '', antonym: '', derivative: '', examples: [], etymology: '', syllables: '', phrases: '' },
];

const share = buildShareCSV(words);
const header = share.split('\n')[0];
ok('share header 無 tags 欄', !header.split(',').includes('tags'));
ok('share header 保留內容欄', header.includes('word') && header.includes('definition') && header.includes('deck'));
ok('share 內容無私人 tag 字串', !share.includes('私人') && !share.includes('難字'));
ok('share 逗號/引號/換行照樣轉義', share.includes('"run, fast"') && share.includes('""快""'));

const back = parseCSV(share);
ok('share 回吃筆數對', back.length === 2);
ok('share 回吃 tags 為空', (back[0].tags ?? []).length === 0 || back[0].tags === '');
ok('share 回吃內容無損', back[0].word === 'apple' && back[0].definition === '蘋果');

const full = buildCSV(words);
ok('原匯出仍帶 tags（沒動到舊路）', full.split('\n')[0].split(',').includes('tags'));

const expSrc = readFileSync('/home/jupiter/teno 修檢版/src/pages/export.js', 'utf8');
ok('export 頁有分享區', expSrc.includes('shareRunBtn') && expSrc.includes('分享下載'));
ok('分享平台列出現有字本（一直觀下載）', expSrc.includes('data-share-deck') && expSrc.includes('全部字本'));
ok('分享檔名前綴 teno-share', expSrc.includes('teno-share'));

console.log(fail === 0 ? `SHARE1: PASS (${pass} pass, 0 fail)` : `SHARE1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
