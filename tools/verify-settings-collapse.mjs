// SETCOLLAPSE1: 設定頁收合整頓 — 標題常駐＋內容下拉＋狀態記憶
// 跑法：node tools/verify-settings-collapse.mjs
import { readFileSync } from 'node:fs';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

const css = readFileSync(`${R}/src/styles/base.css`, 'utf8');
const js = readFileSync(`${R}/src/pages/settings.js`, 'utf8');

console.log('== T1 CSS：收合樣式（作用域只限 .collapsible，不污染他頁） ==');
ok('collapsible 標題可點（cursor）', css.includes('.section.collapsible > .section-title'));
ok('收起隱藏內容（:not 保留標題列）', css.includes('.section.collapsible.collapsed > :not(.section-title):not(.section-header)'));
ok('chevron 指示＋旋轉', css.includes('.collapse-chevron') && css.includes('rotate(-90deg)'));
ok('工具列樣式', css.includes('.collapse-toolbar'));
ok('無全域 .section.collapsed 裸規則（他頁免疫）',
  !/^(\s*)\.section\.collapsed\s*>/m.test(css.replace(/\.section\.collapsible\.collapsed/g, '')));

console.log('== T2 JS：綁定邏輯 ==');
ok('bindCollapsibleSections 定義', js.includes('function bindCollapsibleSections()'));
ok('onMount 首行呼叫', /export function onMount\(s\) \{\n  bindCollapsibleSections\(\);/.test(js));
ok('localStorage 記憶（key＋讀寫）', js.includes("const COLLAPSE_KEY = 'teno-settings-collapsed'")
  && js.includes('_loadCollapsedSet') && js.includes('_saveCollapsedSet'));
ok('首次預設全收（只留標題）', js.includes('firstRun') && /firstRun \? true/.test(js));
ok('chevron 掛載（chevronD）', js.includes("icon('chevronD')") && js.includes('collapse-chevron'));
ok('頂層過濾（內嵌匯入/匯出/標籤子 section 不收）',
  js.includes("!(el.parentElement && el.parentElement.closest('.section'))"));
ok('標題列按鈕不觸發收合（字本管理新增鈕等）',
  js.includes("e.target.closest('button, a, input, select, textarea, label')"));
ok('全部展開／全部收起工具列', js.includes('data-collapse-act="expand"') && js.includes('data-collapse-act="collapse"'));
ok('aria-expanded 無障礙', js.includes('aria-expanded'));
ok('render 零改動（新 section 自動跟上，無 data-section 硬編碼）', !js.includes('data-section='));

console.log('== T3 結構：設定頁 section 全覆蓋 ==');
const titles = [...js.matchAll(/<div class="section-title"[^>]*>\$\{icon\('([a-zA-Z]+)'\)\} ([^<]+)<\/div>/g)]
  .map(m => m[2].trim());
ok(`section-title 數量充足（${titles.length} 個）`, titles.length >= 18, `got ${titles.length}`);
for (const t of ['每日重置時間', '主題配色', 'WebDAV 同步', '危險區域', '韋氏字典', '關於'])
  ok(`標題「${t}」存在`, titles.includes(t));
ok('section-header 型（含操作鈕）也被覆蓋', js.includes('section-header'));

console.log('== T4 他頁免疫 ==');
for (const p of ['deck-browser.js', 'browser.js', 'study.js']) {
  const src = readFileSync(`${R}/src/pages/${p}`, 'utf8');
  ok(`${p} 未掛 collapsible`, !src.includes('collapsible') && !src.includes('collapse-toolbar'));
}

console.log(fail === 0 ? `SETCOLLAPSE1: PASS (${pass} pass, 0 fail)` : `SETCOLLAPSE1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
