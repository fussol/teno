// verify-g-size2-chip.mjs — G-SIZE2: deck chip 不換行＋count 等寬
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
const m = css.match(/\.exam-deck-chip\{[^}]*\}/);
ok('chip block found', !!m, 'exists');
ok('chip nowrap', !!m && /white-space:\s*nowrap/.test(m[0]), '內不換行');
ok('count tabular-nums', /exam-deck-chip[^{]*span[^}]*tabular-nums/.test(css) || /exam-deck-chip[^}]*tabular-nums/.test(css), '數字等寬');
ok('count min-width', /exam-deck-chip[^{]*span[^}]*min-width/.test(css), '0→N 不跳寬');
process.exit(fail ? 1 : 0);
