// verify-g-size2-chip.mjs — G-SIZE2: deck chip 不換行＋count 等寬＋色點不誤傷
// G-SIZE2b (ellipse regression): 舊 selector `> span:last-child` 誤命中匯出頁
// 7px 色點（無數字 chip 的末 span）→ min-width:3ch 撐成橢圓。count 規則必須
// 綁 .deck-count class，色點（無 class）不得命中。
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
ok('count scoped to .deck-count', /\.exam-deck-chip\s*>\s*span\.deck-count\s*\{[^}]*min-width/.test(css), '色點不誤傷');
ok('no bare last-child count rule', !/\.exam-deck-chip\s*>\s*span:last-child\s*\{/.test(css), '舊 selector 已清');
ok('count tabular-nums', /\.exam-deck-chip\s*>\s*span\.deck-count\s*\{[^}]*tabular-nums/.test(css), '數字等寬');
const br = readFileSync(join(root, 'src/pages/browser.js'), 'utf8');
ok('browser counts carry class', (br.match(/<span class="deck-count"/g) || []).length >= 2, '兩處計數 span');
const ex = readFileSync(join(root, 'src/pages/export.js'), 'utf8');
ok('export dot has no count class', !ex.includes('deck-count'), '色點保持 7px 圓');
process.exit(fail ? 1 : 0);
