// verify-tag-add-overlay.mjs — TAG-ADD1: 新增列透明 color input 不得溢出蓋住新增鈕
// Root cause: `.tag-add-area input{width:140px;height:30px}` 通殺區內所有 input，
// 把「自訂顏色」圓鈕（22px）裡透明 input 撐成 140px 向右溢出，蓋住 #tagAddBtn →
// 點新增＝點到透明 input＝原生取色框彈出＋新增沒觸發。修法：規則縮到 .form-input。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const tm = readFileSync(join(root, 'src/pages/tag-manager.js'), 'utf8');
const css = tm.slice(tm.indexOf('<style>'), tm.indexOf('</style>'));
ok('無裸 input 通殺', !/\.tag-add-area\s+input\s*\{/.test(css), '透明 input 不再被撐大');
ok('文字框仍 140px', /\.tag-add-area\s+input\.form-input\s*\{[^}]*width:\s*140px/.test(css), 'tagNewName 不動');
ok('color input 無 width', !/id="tagNewColor"[^>]*width/.test(tm), 'inset 填滿 22px 圓鈕');
ok('新增鈕仍在', tm.includes('id="tagAddBtn"'), '防刪錯');
ok('handler 仍在', tm.includes("getElementById('tagAddBtn')"), '接線不动');
process.exit(fail ? 1 : 0);
