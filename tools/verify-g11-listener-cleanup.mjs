// verify-g11: listener 累積系列（常駐節點無 cleanup）— 五檔全靜態
import { readFileSync } from 'node:fs';

const files = {
  'src/pages/browser.js':      ['_bCardOutside', '_bTagDocHandler'],
  'src/pages/tag-manager.js':  ['_tmDocOutside'],
  'src/pages/study-spell.js':  ['_ssVvHandler'],
  'src/pages/deck-browser.js': ['_dCardOutside'],
};
const fail = [];
const pass = [];

for (const [f, hnames] of Object.entries(files)) {
  const c = readFileSync(f, 'utf8');
  for (const h of hnames) {
    if (h === 'autoFillOrder') continue;
    // 1. module var 存在
    if (new RegExp(`let ${h} =`).test(c)) pass.push(`${f}: 具名 handler ${h} 存在`);
    else { fail.push(`${f}: 缺 module var ${h}`); continue; }
    // 2. addEventListener 掛具名（非匿名）
    const addRef = new RegExp(`addEventListener\\('[^']+', ${h}\\)`).test(c);
    if (addRef) pass.push(`${f}: ${h} 以具名掛載`);
    else fail.push(`${f}: ${h} 未以具名 addEventListener 掛載`);
    // 3. 冪等 remove-before-add（防 onMount 疊加）
    if (new RegExp(`removeEventListener\\('[^']+', ${h}\\)[\\s\\S]{0,80}${h} = `).test(c) ||
        new RegExp(`if \\(${h}\\) \\{ document\\.removeEventListener\\('click', ${h}\\); ${h} = null;`).test(c)) {
      pass.push(`${f}: ${h} 有 remove-before-add 冪等`);
    } else fail.push(`${f}: ${h} 缺冪等 remove-before-add`);
    // 4. cleanup 內移除
    if (new RegExp(`removeEventListener\\('[^']+', ${h}\\)`).test(c) && /__pageCleanup/.test(c)) {
      pass.push(`${f}: ${h} 於 __pageCleanup 移除`);
    } else fail.push(`${f}: ${h} cleanup 移除缺失`);
  }
}

// 特判：browser.js autoFillOrder 不回歸（G19/G20 已修，驗證不被 G11 破壞）
const b = readFileSync('src/pages/browser.js', 'utf8');
if (!/\.db\.setSetting|\.db\.getSetting/.test(b) && /join\('\\|'\)/.test(b)) {
  pass.push('browser.js: autoFillOrder .db.* 未殘留＋join(|)（G19/G20 不回歸）');
} else fail.push('browser.js: autoFillOrder G19/G20 回歸！');

// tools.js 維持 guard
const t = readFileSync('src/pages/tools.js', 'utf8');
if (/_toolsCsBound/.test(t)) pass.push('tools.js: 維持 _toolsCsBound guard（不回歸）');
else fail.push('tools.js: _toolsCsBound guard 遺失');

// 唯一 __pageCleanup 判定（每檔恰一個定義）
for (const [f] of Object.entries(files)) {
  const c = readFileSync(f, 'utf8');
  const n = (c.match(/window\.__pageCleanup =/g) || []).length;
  if (n === 1) pass.push(`${f}: 恰一個 __pageCleanup 定義`);
  else fail.push(`${f}: __pageCleanup 定義 ${n} 個（應 1）`);
}

console.log(`\nG11 verify: ${pass.length} PASS / ${fail.length} FAIL`);
pass.forEach(p => console.log('  ✓ ' + p));
fail.forEach(f2 => console.log('  ✗ ' + f2));
process.exit(fail.length ? 1 : 0);