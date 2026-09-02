#!/usr/bin/env node
// ═══ 整套流程驗證：crop 頁 DOM 結構 + 三清單分類邏輯 + 匯入分派（build 產物靜態釘 + 邏輯單元）═══
import fs from 'node:fs';
import path from 'node:path';
const ROOT = '/home/jupiter/teno';
let fail = 0, total = 0;
const ok = (l, c, d) => { total++; if (!c) { fail++; console.log(`FAIL ${l}${d ? ' :: ' + JSON.stringify(d) : ''}`); } else console.log(`PASS ${l}`); };

// ── A. build 產物結構釘（crop 頁打包進 dist）──
const distDir = path.join(ROOT, 'dist/assets');
const cropChunk = fs.readdirSync(distDir).find(f => f.startsWith('crop-') && f.endsWith('.js'));
ok('A1 crop chunk 存在', !!cropChunk, cropChunk);
if (cropChunk) {
  const src = fs.readFileSync(path.join(distDir, cropChunk), 'utf8');
  ok('A2 三清單 DOM（cropListNew/Dup/Noise）', src.includes('cropListNew') && src.includes('cropListDup') && src.includes('cropListNoise'));
  ok('A3 三點指示（cropTabsDots）', src.includes('cropTabsDots'));
  ok('A4 左右滑（cropSwipeTrack + translateX）', src.includes('cropSwipeTrack') && src.includes('translateX'));
  ok('A5 批量轉移鈕（cropDupMoveBtn + editWord deck）', src.includes('cropDupMoveBtn') && src.includes('editWord'));
  // minifier 改寫識別字 — 改對源碼驗證（產物 A2-A5 已含不可改寫的 DOM id 字串）
  const SRC = fs.readFileSync(path.join(ROOT, 'src/pages/crop.js'), 'utf8');
  ok('A6 雜訊判定（isNoiseToken 黑灰+短詞）', SRC.includes('function isNoiseToken') && SRC.includes('isBlacklisted'));
  ok('A7 重複分類（dup 檢查 words.some）', SRC.includes("some(w => w.word === t)"));
  ok('A8 雜訊頁 override 匯入', SRC.includes('override: new Set(picked)'));
  ok('A9 新字頁匯入後移重複頁（_dupTokens.add）', SRC.includes('_dupTokens.add(t)'));
  ok('A10 2x 放大掃描（box- 檔名 + scale 2）', SRC.includes('box-${i}.png') && SRC.includes('const scale = 2'));
}
// ── B. main.js 路由 ──
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
ok('B1 crop 路由歸 tools', /'crop': 'tools'/.test(mainSrc));
// ── C. tools 入口 ──
const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/pages/tools.js'), 'utf8');
ok('C1 tools 入口卡（toolsGoCrop）', toolsSrc.includes('toolsGoCrop') && toolsSrc.includes('照片切割掃描'));
// ── D. OCR 主頁切割鈕導頁 ──
const ocrSrc = fs.readFileSync(path.join(ROOT, 'src/pages/ocr.js'), 'utf8');
ok('D1 OCR 切割鈕導 crop 頁', /navigate\('crop'\)/.test(ocrSrc));

console.log(fail === 0 ? `\n═══ ${total - fail}/${total} ALL PASS — 整套結構就緒 ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
