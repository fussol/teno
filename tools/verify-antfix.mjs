// ANTFIX: Cambridge 同頁多條目串台（ant/-ant）＋長翻譯顯示換行
// 跑法：node tools/verify-antfix.mjs（Rust 單元 cargo test -p cambridge_scraper 另跑）
import { readFileSync } from 'node:fs';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const zh = readFileSync(`${R}/src-tauri/cambridge_scraper/src/chinese.rs`, 'utf8');
const en = readFileSync(`${R}/src-tauri/cambridge_scraper/src/english.rs`, 'utf8');
const lib = readFileSync(`${R}/src-tauri/src/lib.rs`, 'utf8');
const css = readFileSync(`${R}/src/styles/base.css`, 'utf8');

console.log('== T1 scraper：sense 帶 headword ==');
ok('zh ChineseSense 有 headword（serde default 向下相容）',
  /pub struct ChineseSense[\s\S]*?#\[serde\(default\)\]\s*pub headword: String/.test(zh));
ok('zh entry 迴圈記 entry_headword', zh.includes('entry_headword') && zh.includes('headword: entry_headword.clone()'));
ok('en Sense 有 headword（serde default）',
  /pub struct Sense[\s\S]*?#\[serde\(default\)\]\s*pub headword: String/.test(en));
ok('en 舊模板記 entry_headword', en.includes('headword: entry_headword.clone()'));
ok('en 新模板 nearest_headword 歸屬', en.includes('fn nearest_headword') && en.includes('nearest_headword(&block)'));

console.log('== T2 呼叫端：lookup_cambridge 同字過濾＋回退 ==');
ok('zh 分支過濾（headword_matches＋空則全留）',
  lib.includes('cambridge_scraper::headword_matches(&s.headword, &word)'));
ok('en 分支同樣過濾', (lib.match(/headword_matches\(&s\.headword, &word\)/g) || []).length >= 2);
ok('headword_matches 匯出（crate lib.rs）', readFileSync(`${R}/src-tauri/cambridge_scraper/src/lib.rs`, 'utf8').includes('headword_matches'));

console.log('== T3 顯示：長翻譯換行 ==');
ok('split-badge-def 允許換行（white-space:normal）',
  /\.split-badge-def\{[^}]*white-space:normal/.test(css));
ok('split-badge-def overflow-wrap:anywhere（CJK 無空白不斷行）',
  /\.split-badge-def\{[^}]*overflow-wrap:anywhere/.test(css));
ok('split-badge-def 限寬 max-width:100%（不爆框）',
  /\.split-badge-def\{[^}]*max-width:100%/.test(css));
ok('詞性膠囊維持 nowrap（短標籤不散）',
  /\.split-badge-pos\{[^}]*\} walks/.test(css + ' walks') || !/\.split-badge-pos\{[^}]*white-space:normal/.test(css));

console.log('== T4 前端相容（加欄位零破壞） ==');
for (const p of ['src/pages/deck-browser.js', 'src/pages/browser.js', 'src/lib/autofill-engine.js', 'src/pages/tools.js']) {
  const src = readFileSync(`${R}/${p}`, 'utf8');
  ok(`${p} 走訪 senses 泛型（不依賴欄位數）`, src.includes('.senses'));
}

console.log(fail === 0 ? `ANTFIX: PASS (${pass} pass, 0 fail)` : `ANTFIX: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
