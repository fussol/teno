// verify-g-size3-toggle.mjs — G-SIZE3: 雙態 toggle 必須鎖 min-width＋nowrap
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
for (const f of ['src/pages/browser.js', 'src/pages/deck-browser.js']) {
  const s = readFileSync(join(root, f), 'utf8');
  const scope = s.match(/id="(deckBrowserScopeToggle|browserScopeToggle)"[^>]*>/)?.[0] || s.match(/<button[^>]*id="(deckBrowserScopeToggle|browserScopeToggle)"[^>]*>/)?.[0];
  const sort = s.match(/<button[^>]*id="(deckBrowserSortToggle|browserSortToggle)"[^>]*>/)?.[0];
  ok(`${f} scope 有 min-width`, !!scope && /min-width/.test(scope), '最長態鎖寬');
  ok(`${f} scope 有 nowrap`, !!scope && /white-space:\s*nowrap/.test(scope), '不換行');
  ok(`${f} sort 有 min-width`, !!sort && /min-width/.test(sort), '最長態鎖寬');
  ok(`${f} sort 有 nowrap`, !!sort && /white-space:\s*nowrap/.test(sort), '不換行');
}
{ // 附帶同病：deck-browser 選擇 toggle（取消選擇↔選擇）同修
  const s = readFileSync(join(root, 'src/pages/deck-browser.js'), 'utf8');
  const sel = s.match(/<button[^>]*id="deckBrowserSelectToggle"[^>]*>/)?.[0];
  ok('deck select 有 min-width', !!sel && /min-width/.test(sel), '同病附帶');
  ok('deck select 有 nowrap', !!sel && /white-space:\s*nowrap/.test(sel), '不換行');
}
process.exit(fail ? 1 : 0);
