// verify-g-svg1-lucide.mjs — G-SVG1: 手寫 SVG 全部走 icon() Lucide 體系
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const R = (f) => readFileSync(join(root, f), 'utf8');
const svg = R('src/lib/svg.js');
ok('pause 已註冊', /pause:\s*\(\)\s*=>\s*S\(pauseRaw\)/.test(svg), 'icons 表');
ok('icon() 吃 px', /export function icon\(name,\s*px/.test(svg), '尺寸參數');
const br = R('src/pages/browser.js'), dk = R('src/pages/deck-browser.js');
ok('字庫無手寫播放三角', !br.includes('polygon points="6 3 20 12'), 'browser.js');
ok('字庫無手寫暫停方塊', !br.includes('rect x="6" y="4"'), 'browser.js');
ok('字本無手寫播放三角', !dk.includes('polygon points="6 3 20 12'), 'deck-browser.js');
ok('字本無手寫暫停方塊', !dk.includes('rect x="6" y="4"'), 'deck-browser.js');
ok('字庫用 icon pause/play', br.includes("'pause'") && br.includes("'play', 16"), 'toggle 走體系');
ok('字本用 icon pause/play', dk.includes("'pause'") && dk.includes("'play', 16"), 'toggle 走體系');
for (const f of ['src/pages/exam-flip.js','src/pages/exam-mc.js','src/pages/exam-spell.js','src/pages/study-v4.js','src/pages/study-mc.js','src/pages/study-spell.js']) {
  const s = R(f);
  ok(`${f.split('/').pop()} 無手寫打勾`, !s.includes('M20 6 9 17l-5-5'), '結果圖');
  ok(`${f.split('/').pop()} 用 icon check`, s.includes("icon('check'"), '走體系');
}
const cs = R('src/lib/custom-select.js');
ok('custom-select 無手寫箭頭', !cs.includes('m6 9 6 6 6-6'), 'chevron');
ok('custom-select 用 icon', cs.includes("icon('chevron-down'"), '走體系');
for (const f of ['src/pages/ocr.js','src/pages/tools.js']) {
  const s = R(f);
  ok(`${f.split('/').pop()} 無手寫三角`, !s.includes('M0 0l5 6 5-6z'), '下拉箭頭');
  ok(`${f.split('/').pop()} 用 icon`, s.includes("icon('chevron-down'"), '走體系');
  ok(`${f.split('/').pop()} 保留 cs-a`, s.includes('cs-a'), '開合旋轉不斷頭');
}
process.exit(fail ? 1 : 0);
