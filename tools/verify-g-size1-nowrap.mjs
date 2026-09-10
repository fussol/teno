// verify-g-size1-nowrap.mjs — G-SIZE1: .btn-primary must not wrap
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
const m = css.match(/\.btn-primary\{[^}]*\}/);
ok('.btn-primary block found', !!m, 'exists');
ok('.btn-primary has nowrap', !!m && /white-space:\s*nowrap/.test(m[0]), '1行鎖死');
ok('.btn parity', /\.btn\{[^}]*white-space:\s*nowrap/.test(css), '.btn 對照組');
process.exit(fail ? 1 : 0);
