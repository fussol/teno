// verify-d-name1-filename.mjs — D-NAME1: apkg real filename reaches UI.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const rs = readFileSync(join(root, 'src-tauri/src/apkg.rs'), 'utf8');
ok('struct carries file_name', /pub file_name:\s*String/.test(rs), 'ApkgInspect.file_name');
ok('dialog fills file_name', /res\.file_name\s*=/.test(rs), 'dialog sets it');
const js = readFileSync(join(root, 'src/pages/import.js'), 'utf8');
ok('ui prefers real name', /r\.file_name/.test(js), 'pickApkg uses r.file_name');
ok('no count-only overwrite', !/_fileName = '牌組（' \+ r\.rows\.length/.test(js), 'fallback keeps name');
process.exit(fail ? 1 : 0);
