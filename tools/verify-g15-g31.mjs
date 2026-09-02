// verify-g15-g31.mjs — G15/G17/G22/D13/G31 整合驗證
// 讀原始碼確認修復落點（無 browser 實跑；本波全為靜態可驗證修法）
import { readFileSync, accessSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

const css = readFileSync('src/styles/base.css', 'utf8');
const br = readFileSync('src/pages/browser.js', 'utf8');
const store = readFileSync('src/lib/store.js', 'utf8');
const settings = readFileSync('src/pages/settings.js', 'utf8');
const main = readFileSync('src/main.js', 'utf8');

// ── G15: multi-accent distribution block 已刪，且無殘留互動元素撞色覆蓋 ──
ok(!/Multi-accent distribution/.test(css), 'G15 block 標題已移除');
ok(!css.includes('.btn-icon:hover { color: var(--accent-secondary)'), 'G15 btn-icon:hover 不再撞色');
ok(!css.includes('#word-row-pos { color: var(--accent-tertiary)') && !css.includes('.word-row-pos { color: var(--accent-tertiary)'), 'G15 word-row-pos 不再 tertiary');
// 前面定義仍保留單一 accent
ok(css.replace(/\s+/g,'').includes('input:focus,select:focus,textarea:focus{border-color:var(--accent)'), 'G15 原始 input:focus 單一 accent 保留');

// ── G17: memoization ──
ok(br.includes('_fwSig') && br.includes('_fwCache'), 'G17 memo cache 存在');
ok(br.includes('_sortRandom && !_sortSeed'), 'G17 無 seed 隨機不 memo 分支存在');
ok(br.indexOf('_fwSig') < br.indexOf('_fwCache'), 'G17 declare 次序合理');

// ── G22: synonym/antonym/derivative 欄位 ──
for (const id of ['fSynonyms', 'fAntonyms', 'fDerivatives']) {
  ok(br.includes(`id="${id}"`), `G22 input ${id} 存在`);
  ok(br.includes(`document.getElementById('${id}')?.value.trim()`), `G22 save 讀取 ${id}`);
}
ok(br.includes('synonym: document.getElementById'), 'G22 data.synonym 帶入');

// ── D13: audit ──
ok(store.includes("addAudit('import-words'"), 'D13 importWords 加 audit');
ok(settings.includes("addAudit('drive-upload'"), 'D13 drive upload 加 audit');

// ── G31: splash img integrity ──
ok(main.includes('img.onerror'), 'G31 splash img onerror 存在');
ok(main.includes('tried.has(p.key)'), 'G31 已試 set 防循環');

// icon 檔都存在（完整性前提）
for (const f of ['icon-original','icon-ocean','icon-forest','icon-sunset','icon-midnight','icon-lemon','icon-mint','icon-rose','icon-graphite','icon-cream']) {
  try { accessSync(`public/icons/${f}.png`); ok(true, `G31 icon ${f}.png 存在`); }
  catch { ok(false, `G31 icon ${f}.png 存在`); }
}

console.log(`\n=== ${pass} pass / ${fail} fail ===`);
process.exit(fail ? 1 : 0);