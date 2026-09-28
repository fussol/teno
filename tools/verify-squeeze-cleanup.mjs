#!/usr/bin/env node
// SQUEEZE1: 卡片查詢面板返回後整頁擠壓 — 靜態接線守門
//
// 病灶：openCardPreview 把 sidebar 隱藏＋.main 設 margin-right:50vw（inline，
// 掛在共享外殼 .main/#sidebar 上），但 __pageCleanup 只 remove 面板本體。
// 面板掛 document.body（頁容器外），換頁後 .main margin 殘留 → 其他畫面全被擠一半。
//
// 修法：__pageCleanup 委託既有的 closeCardPreview()（它才負責還原 sidebar/.main）。
//
// 用法: node tools/verify-squeeze-cleanup.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};

for (const [file, outsideHandlers, panelId] of [
  ['src/pages/browser.js', ['_bCardOutside', '_bTagDocHandler'], 'cardPreviewModal'],
  ['src/pages/deck-browser.js', ['_dCardOutside'], 'deckCardPreview'],
]) {
  const src = readFileSync(file, 'utf8');
  console.log(`── ${file}`);

  // 1. 恰一個 __pageCleanup
  const n = (src.match(/window\.__pageCleanup =/g) || []).length;
  chk('__pageCleanup 恰一個', n === 1, `n=${n}`);

  // 2. cleanup 塊切片（定義起點 ~500 字元）
  const i = src.indexOf('window.__pageCleanup');
  const block = i >= 0 ? src.slice(i, i + 500) : '';
  chk('__pageCleanup 委託 closeCardPreview（還原 sidebar/.main margin）',
    /closeCardPreview\(\)/.test(block));
  chk('cleanup 不再只 remove 面板本體（舊殘留寫法退場）',
    !/const modal = document\.getElementById/.test(block));

  // 3. document 級 outside handler 仍於 cleanup 移除
  for (const h of outsideHandlers) {
    chk(`${h} 於 cleanup 內 removeEventListener`, new RegExp(`removeEventListener\\('click', ${h}\\)`).test(block));
  }

  // 4. closeCardPreview 負責還原（委託鏈的下游）
  const ci = src.indexOf('function closeCardPreview()');
  const closeFn = ci >= 0 ? src.slice(ci, ci + 700) : '';
  chk('closeCardPreview 還原 sidebar', /sidebar\.style\.display = ''/.test(closeFn));
  chk('closeCardPreview 還原 .main marginRight', /main\.style\.marginRight = ''/.test(closeFn));
  chk('closeCardPreview 移面板本體', new RegExp(`getElementById\\('${panelId}'\\)`).test(closeFn));
  chk('closeCardPreview 解 keydown', /_cardKeyHandler/.test(closeFn));

  // 5. 擠壓確實掛在共享外殼（病灶前提：inline 掛 .main，非頁容器內）
  chk('擠壓源：.main margin-right 50vw inline', /main\.style\.marginRight = isFull \? '0' : '50vw'/.test(src));
  chk('面板掛 document.body（頁容器外，頁容器清碗清不到）',
    new RegExp(`document\\.body\\.insertAdjacentHTML\\('beforeend', mkPanelHTML`).test(src));
}

console.log(`\nSQUEEZE1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
