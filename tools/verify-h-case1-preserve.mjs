// verify-h-case1-preserve.mjs — H-CASE1: save path must not lowercase headwords.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const store = readFileSync(join(root, 'src/lib/store.js'), 'utf8');
const imp = readFileSync(join(root, 'src/core/import.js'), 'utf8').replace(/\/\/.*$/gm, '');
const addBody = store.slice(store.indexOf('async addWord('), store.indexOf('async addWord(') + 600);
ok('addWord keeps case', /word:\s*wordData\.word\.trim\(\)/.test(addBody) && !/wordData\.word\.toLowerCase/.test(addBody), 'trim only');
ok('mapWords keeps case', /w\.word\s*=\s*val;/.test(imp) && !/w\.word\s*=\s*val\.toLowerCase/.test(imp), 'trim only');
ok('dedup still case-insensitive', store.includes('w.word.toLowerCase()') || store.includes('x.word.toLowerCase()'), 'dupes caught');
process.exit(fail ? 1 : 0);
