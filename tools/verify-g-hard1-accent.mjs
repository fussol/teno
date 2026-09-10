// verify-g-hard1-accent.mjs — G-HARD1: UI 殼 accent 衍生色跟主題走
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const R = (f) => strip(readFileSync(join(root, f), 'utf8'));
const base = R('src/styles/base.css');
const baseNoDef = base.split('\n').filter(l => !/--(accent|state-focus|shadow-glow)/.test(l)).join('\n');
ok('base 無散裝 accent-rgba', !baseNoDef.includes('182,157,255'), '只剩 var 定義源');
ok('btn-tonal 跟 container', /\.btn-tonal:hover\{[^}]*var\(--accent-container\)/.test(base), 'hover 換 accent 即走');
const ocr = R('src/pages/ocr.js');
ok('ocr 把手光暈跟 glow', ocr.includes('var(--accent-glow)'), '換 accent 即走');
ok('ocr 無散裝 accent-rgba', !ocr.includes('182,157,255'), '清乾淨');
const set = R('src/pages/settings.js');
ok('無懸空 --danger', !set.includes('--danger'), 'var(--red) 接管');
process.exit(fail ? 1 : 0);
