#!/usr/bin/env node
// ═══ VERIFY-G2 手機側欄打不開 ═══
// Bug：≤768px .topbar{display:none} 隱藏唯一 #sidebarReopen → 側欄關閉後無入口。
// 修法：bottom-bar 加 data-sidebar-toggle「字本」鈕（手機態）＋ delegation 綁定。
// 用法: node tools/verify-g2-sidebar-mobile.mjs [--pre]（--pre 對 bug 態源碼必紅）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src/styles/base.css'), 'utf8');

const PRE = process.argv.includes('--pre');
let fail = 0, total = 0;
function ok(label, cond, detail) {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
}

// ── 修法釘（FIXED 態）— v3（2026-08-31 元首令二連：FAB 也拔，backdrop 元素保留）──
// 字本進入途徑＝字庫頁 deck chips / 字本管理（非 bottom-bar 非 FAB）。
const backdropEl = /id="sidebarBackdrop"/.test(MAIN);
const backdropBind = /sidebarBackdrop'\)\.addEventListener\('click'/.test(MAIN);
const fabGone = !/sidebarFab/.test(MAIN);
const fabCssGone = !/sidebar-fab/.test(CSS);
const topbarIntact = /#sidebarReopen/.test(MAIN);
const cssBackdrop = /\.sidebar-backdrop/.test(CSS);

if (PRE) {
  ok('T0.1（v1 bug 態）無側欄入口痕', fabGone && backdropEl === false);
  ok('T0.3 病灶確認：手機 topbar display:none 在位', /@media\(max-width:768px\)\{[\s\S]*?\.topbar\{display:none\}/.test(CSS));
} else {
  ok('T1.1 FAB 已完全移除（JS 零殘留）', fabGone);
  ok('T1.2 FAB CSS 已完全移除', fabCssGone);
  ok('T1.3 sidebarBackdrop 元素在位（v2 順修保留：點外關側欄）', backdropEl);
  ok('T1.4 backdrop click 關側欄綁定', backdropBind);
  ok('T1.5 topbar #sidebarReopen 桌面路徑保留（回歸）', topbarIntact);
  ok('T1.6 CSS backdrop 類在位', cssBackdrop);
}

console.log(fail === 0 ? `\n═══ ${PRE ? 'PRE(BUG)' : 'POST(FIXED)'}: ${total - fail}/${total} ALL PASS ═══` : `\n═══ ${PRE ? 'PRE(BUG)' : 'POST'}: ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
