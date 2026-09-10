// verify-g-tiny1-touch.mjs — G-TINY1: 行動觸控目標 44px 線
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
const mob600 = css.slice(css.indexOf('@media(max-width:600px){'));
ok('行動主鈕 44 高', /\.btn,\.btn-primary,\.btn-sm,\.btn-xs\{min-height:44px\}/.test(mob600), '40→44');
ok('字卡換字鈕 44', /button\.card-panel-nav-btn\{min-width:44px;min-height:44px\}/.test(css), '36→44');
ok('study 時間標 ≥11', !/\.study-btn-time\{font-size:9px\}/.test(css), '9px 已清');
const br = readFileSync(join(root, 'src/pages/browser.js'), 'utf8');
ok('桌機 36px 原樣', br.includes('.card-panel-nav-btn{width:36px;height:36px'), '桌機像素不動');
process.exit(fail ? 1 : 0);
