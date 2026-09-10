// verify-g-xss0-toast.mjs — G-XSS0: toast sink must not use innerHTML.
// FIX MARKER: src/lib/toast.js must set textContent (not innerHTML).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/lib/toast.js'), 'utf8');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
ok('no innerHTML sink', !/\.innerHTML\s*=/.test(src), 'toast must not assign innerHTML');
ok('uses textContent', src.includes('textContent'), 'plain-text sink');
process.exit(fail ? 1 : 0);
