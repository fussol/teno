#!/usr/bin/env node
// COMBO1: 「一鍵全補組合包」每列在手機寬度下「覆寫」開關被擠到下一行。
//
// 根因：來源選單 .cs 是 flex-shrink:0（不可壓縮）+ .cs-t white-space:nowrap
//       → 寬度完全固定。360px 手機容器僅約 270px，一行需要 297px，
//       選單不肯讓 → 覆寫開關／標籤被 flex-wrap 擠到第二行（實測 x=0 top=38）。
// 修法：選單可壓縮＋文字省略號；其餘固定項不換行（flex-wrap:nowrap）；
//       窄螢幕收固定項預算（gap/欄位名/覆寫字級）。
// 用法: node tools/verify-combo1-mobile.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};

const src = readFileSync('src/pages/tools.js', 'utf8');
const count = (re) => (src.match(re) || []).length;

console.log('[S] 列結構');
chk('11 列都用 class="combo-row"', count(/<div class="combo-row">/g) === 11, String(count(/<div class="combo-row">/g)));
chk('11 個欄位名用 class="combo-name"', count(/<span class="combo-name">/g) === 11, String(count(/<span class="combo-name">/g)));
chk('11 個覆寫標籤用 class="combo-ow"', count(/<span class="combo-ow">覆寫<\/span>/g) === 11, String(count(/<span class="combo-ow">覆寫<\/span>/g)));

console.log('[S] 版面不變式（修復核心）');
chk('.combo-row 用 nowrap（不再讓開關換行）',
  /\.combo-row\{display:flex;align-items:center;gap:var\(--s2\);flex-wrap:nowrap;min-width:0\}/.test(src));
chk('.cs 可壓縮（原 flex-shrink:0 已移除）',
  /\.cs\{position:relative;font-size:12px;min-height:30px;flex-shrink:1;min-width:0\}/.test(src));
chk('.cs-t 允許內容被裁切',
  /\.cs-t\{[^}]*min-width:0[^}]*overflow:hidden/.test(src));
chk('.cs-lbl 有省略號三件套',
  /\.cs-lbl\{[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/.test(src));
chk('窄螢幕 media query 存在', /@media \(max-width:420px\)\{/.test(src));
chk('窄螢幕收 gap', /@media \(max-width:420px\)\{[\s\S]{0,120}gap:5px/.test(src));
chk('窄螢幕收欄位名寬度', /@media \(max-width:420px\)\{[\s\S]{0,200}\.combo-name\{min-width:36px\}/.test(src));

console.log('[S] 選單標籤包了 span（省略號才生效，且相容 childNodes[0] 更新）');
chk('_selHtml 標籤包 .cs-lbl', /<button class="cs-t"[^>]*><span class="cs-lbl">/.test(src));

console.log('[NEG] 負控制');
chk('combo 列不再殘留 flex-wrap:wrap',
  !/display:flex;align-items:center;gap:var\(--s2\);flex-wrap:wrap/.test(src));
chk('舊的固定寬度 inline 樣式已清（min-width:52px 不應留在 combo 列）',
  !/font-size:12px;min-width:52px;color:var\(--text-secondary\)/.test(src));
// 修復前 .cs 是 flex-shrink:0 —— 若有人改回去，上面「.cs 可壓縮」會紅
chk('∴ 若 .cs 改回 flex-shrink:0，上面斷言會紅（控制力有效）',
  !/\.cs\{position:relative;font-size:12px;min-height:30px;flex-shrink:0\}/.test(src));

console.log(`\nCOMBO1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
