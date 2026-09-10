// verify-d-img1-perf.mjs — D-IMG1: image phase must not be O(n*m) serial.
// Markers on src/pages/import.js importApkgImages body:
//  1. no state.words.find per id (id->word Map instead)
//  2. no linear _cellImages scan per row (row-index Map instead)
//  3. bounded concurrency (CON worker pool, tools.js precedent) for fetch+write
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src/pages/import.js'), 'utf8');
const body = s.slice(s.indexOf('async function importApkgImages'), s.indexOf('async function doImport'));
ok('id->word map, no find', !body.includes('state.words.find'), 'one Map build');
ok('row-indexed cells', !/c\.row\s*!==/.test(body) && body.includes('cellsByRow.get('), 'Map row->cells, no per-row compare');
ok('bounded concurrency', /CON\s*=\s*5/.test(body) && body.includes('Promise.all'), 'CON=5 pool');
ok('progress preserved', body.includes('importProgressText') && body.includes('importProgressBar'), 'D-PROG1 intact');
process.exit(fail ? 1 : 0);
