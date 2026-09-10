// verify-g-i18n1-zh.mjs — G-I18N1: 空態／OCR 區無英文裸奔
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const ch = readFileSync(join(root, 'src/lib/chart.js'), 'utf8').replace(/\/\/.*$/gm, '');
ok('無 No data', !ch.includes('No data'), '空態不冒英文');
ok('無 more', !/\+.*more</.test(ch), '圖例不冒英文');
ok('空態繁中', ch.includes('暫無資料'), 'chart.js');
const emptyLine = ch.split('\n').find(l => l.includes('暫無資料')) || '';
ok('空態跟主題色', !/128,120,153/.test(emptyLine) && /var\(--text-disabled\)/.test(emptyLine), '硬編碼 rgba 已清');
const ocr = readFileSync(join(root, 'src/pages/ocr.js'), 'utf8');
for (const s of ['切割照片', '辨識已選取範圍', '拖曳四個圓點框選', '將勾選單字加入字本']) {
  ok(`ocr 有「${s}」`, ocr.includes(s), '防倒退');
}
process.exit(fail ? 1 : 0);
