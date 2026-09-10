// verify-g-dis1-disabled.mjs — G-DIS1: 主按鈕 disabled 必須有視覺
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
ok('.btn:disabled 有定義', /\.btn:disabled/.test(css), '全域禁態');
ok('.btn-primary:disabled 有定義', /\.btn-primary:disabled/.test(css), '主鈕禁態');
ok('禁態含 opacity 或灰化', /:disabled[^}]*opacity/.test(css), '視覺可辨');
ok('禁態禁 hover 位移', /:disabled[^}]*cursor:\s*not-allowed/.test(css), 'cursor 鎖死');
process.exit(fail ? 1 : 0);
