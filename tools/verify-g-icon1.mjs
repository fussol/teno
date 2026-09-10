// verify-g-icon1.mjs — G-ICON1: every icon('name') call site must resolve.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/lib/svg.js'), 'utf8');
const defined = new Set([...src.matchAll(/^  ([A-Za-z-]+):/gm)].map(m => m[1]));
// 'x-y' kebab keys must be quoted in table; match those too
for (const m of src.matchAll(/^  '([A-Za-z-]+)':/gm)) defined.add(m[1]);
const used = new Set();
for (const d of ['src/pages', 'src/lib']) {
  for (const f of readdirSync(join(root, d))) {
    if (!f.endsWith('.js')) continue;
    const t = readFileSync(join(root, d, f), 'utf8');
    for (const m of t.matchAll(/icon\('([^']+)'\)/g)) used.add(m[1]);
  }
}
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const missing = [...used].filter(u => !defined.has(u));
ok('all icon() names resolve', missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : `${used.size} names`);
ok('icon() non-empty', src.includes('if (!fn) return'), 'guard present');
process.exit(fail ? 1 : 0);
