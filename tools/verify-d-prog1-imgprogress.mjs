// verify-d-prog1-imgprogress.mjs — D-PROG1: image phase must drive progress UI.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src/pages/import.js'), 'utf8');
const body = s.slice(s.indexOf('async function importApkgImages'), s.indexOf('async function doImport'));
ok('touches progress text', body.includes('importProgressText'), 'per-image update');
ok('touches progress bar', body.includes('importProgressBar'), 'bar keeps moving');
ok('labels image phase', body.includes('圖片進度'), 'per-image counter label');
process.exit(fail ? 1 : 0);
