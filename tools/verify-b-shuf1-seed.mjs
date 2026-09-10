// verify-b-shuf1-seed.mjs — B-SHUF1: MC options must use seeded Fisher-Yates.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src/engine/session-mc-utils.js'), 'utf8');
const body = s.slice(s.indexOf('function generateOptions'), s.indexOf('export function pickAnswer'))
  .replace(/\/\/.*$/gm, ''); // 註解提及舊寫法不算病灶
ok('no sort-random shuffle', !/sort\(\s*\(\s*\)\s*=>\s*Math\.random/.test(body), 'unbiased only');
ok('seeded rng', /mulberry32\s*\(\s*hashCode/.test(body), 'mode+day+word seed');
ok('fisher-yates place', /for\s*\(.*i\s*>\s*0.*\)/.test(body) && /rng\(\)/.test(body), 'rng-driven swap');
ok('rng imported', /import\s*\{[^}]*mulberry32[^}]*hashCode[^}]*\}\s*from\s*['"]\.\.\/lib\/rng\.js['"]/.test(s), 'lib/rng.js');
// B-SHUF1 測驗路徑同病（exam-mc.js:225）：干擾項挑選＋排位同顆 seeded rng
const em = readFileSync(join(root, 'src/pages/exam-mc.js'), 'utf8')
  .replace(/\/\/.*$/gm, '');
ok('exam: no sort-random pick', !/sort\(\s*\(\s*\)\s*=>\s*Math\.random/.test(em), 'exam unbiased');
ok('exam: seeded rng', /mulberry32\s*\(\s*hashCode\('em_'/.test(em), "'em_'+day+word seed");
ok('exam: options stored once', em.includes('w._options = options'), 're-render/resume stable');
process.exit(fail ? 1 : 0);
