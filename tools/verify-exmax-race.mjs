#!/usr/bin/env node
// ═ VERIFY-EXMAX-RACE：例句顯示上限歸零競態（EXRACE1） ═
// 症狀：切太快時例句顯示全部＋「下一組」鈕消失。
// 根因：工具頁掛載把 input 預設值（寫死 0）回寫 window.__maxExampleLines，
//       async DB 復原前的窗口內渲染的卡全數中招；DB 讀失敗則卡死到下次復原。
// 守門：掛載路徑只「從全域渲染 input」，不寫全域；唯一寫回點＝使用者 input 事件。
// 用法: node tools/verify-exmax-race.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0, total = 0;
const ok = (label, cond, detail) => {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
};

const tools = read('src/pages/tools.js');
const browser = read('src/pages/browser.js');
const deck = read('src/pages/deck-browser.js');
const svg = read('src/lib/svg.js');
const store = read('src/lib/store.js');

ok('tools: input 從全域渲染（無寫死 value="0"）',
  /id="exampleDisplayMax"[^>]*value="\$\{window\.__maxExampleLines \?\? 0\}"/.test(tools));
ok('tools: 掛載不回寫全域（無 parseInt(input) 歸零點）',
  !/window\.__maxExampleLines\s*=\s*parseInt\(exampleDisplayMax\.value/.test(tools));
ok('tools: 寫回只在使用者 input 事件',
  /exampleDisplayMax\.addEventListener\('input'/.test(tools));
ok('browser: db 復原有 n>0 守門（不會歸零）',
  /if \(n > 0\) window\.__maxExampleLines = n;/.test(browser));
ok('deck-browser: db 復原有 n>0 守門（不會歸零）',
  /if \(n > 0\) window\.__maxExampleLines = n;/.test(deck));
ok('renderer: 按鈕/限量仍看全域（max>0 且超句數才旋轉）',
  /rotatable = max > 0 && lines\.length > max;/.test(svg));
ok('store: 開機從 settings 設全域', /window\.__maxExampleLines = Math\.max\(0, parseInt\(settings\.exampleDisplayMax/.test(store));

console.log(`\n${total - fail}/${total} PASS`);
process.exit(fail ? 1 : 0);
