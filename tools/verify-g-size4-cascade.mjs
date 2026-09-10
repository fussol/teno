// verify-g-size4-cascade.mjs — G-SIZE4: size 類必須贏過 variant（定義順序鎖死）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
const idx = (sel) => {
  const m = css.match(new RegExp('^' + sel.replace('.', '\\.') + '\\{', 'm'));
  return m ? (m.index ?? -1) : -1;
};
const iSm = idx('.btn-sm');
const iXs = idx('.btn-xs');
const iPri = idx('.btn-primary');
const iSec = idx('.btn-secondary');
const iBase = idx('.btn');
ok('.btn-sm 有定義', iSm >= 0, 'size 存在');
ok('.btn-xs 有定義', iXs >= 0, 'size 存在');
ok('.btn-sm 在 primary 之後', iSm > iPri, 'size 永遠贏');
ok('.btn-sm 在 secondary 之後', iSm > iSec, '切態不跳盒模型');
ok('.btn-sm 在 base 之後', iSm > iBase, 'size 蓋 base');
ok('.btn-xs 在 secondary 之後', iXs > iSec, 'xs 同理');
process.exit(fail ? 1 : 0);
