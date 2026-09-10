// verify-g-btn1.mjs — G-BTN1/G-SIZE4: secondary/xs defs + no bare btn-sm.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
ok('btn-secondary defined', /^\.btn-secondary\s*\{/m.test(css), 'base.css main def');
ok('btn-xs defined', /^\.btn-xs\s*\{/m.test(css), 'base.css main def');
const set = readFileSync(join(root, 'src/pages/settings.js'), 'utf8');
const sim = readFileSync(join(root, 'src/pages/simulator.js'), 'utf8');
ok('no bare btn-sm (settings)', !/class="btn-sm[\s"]/m.test(set), 'theme toggle has btn base');
ok('no bare btn-sm (simulator)', !/class="btn-sm[\s"]/m.test(sim), 'mode switch has btn base');
process.exit(fail ? 1 : 0);
