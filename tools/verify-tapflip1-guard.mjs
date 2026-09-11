#!/usr/bin/env node
// TAPFLIP1: 字卡點文字發音、點空白處才翻面
// 用法: node tools/verify-tapflip1-guard.mjs
// 驗證四腿:
//   T1 browser/deck-browser: onCardBodyClick/onDeckCardBodyClick 有文字 guard（closest 清單）
//   T2 browser/deck-browser: onMount 綁 bindSpeakClick（點文字發音的上半段——之前兩頁根本沒綁）
//   T3 tts: bindSpeakClick selector 涵蓋 .card-panel-* ＋ .split-badge
//   T4 guard 名單與 tts selector 對齊（guard 擋的每個可發音元素 tts 都吃得到；
//      純功能元素（button/.wimg-slot-wrap）在 guard 擋翻面但 tts 不誤收）
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const browser = readFileSync('src/pages/browser.js', 'utf8');
const deck = readFileSync('src/pages/deck-browser.js', 'utf8');
const tts = readFileSync('src/lib/tts.js', 'utf8');

console.log('[T1] 翻面 guard');
chk('browser: onCardBodyClick(e) 收 event', /function onCardBodyClick\(e\)/.test(browser));
chk('browser: guard closest 檔文字', /e\.target\.closest\('\.card-panel-word, \.card-panel-pron, \.card-panel-def, \.card-panel-example, \.card-panel-desc, \.card-panel-tags, \.split-badge, \.chip-accent, \.chip-subtle, \.wimg-slot-wrap'\)/.test(browser));
chk('deck: onDeckCardBodyClick(e) 收 event', /function onDeckCardBodyClick\(e\)/.test(deck));
chk('deck: guard closest 檔文字', /e\.target\.closest\('\.card-panel-word, \.card-panel-pron, \.card-panel-def, \.card-panel-example, \.card-panel-desc, \.card-panel-tags, \.split-badge, \.chip-accent, \.chip-subtle, \.wimg-slot-wrap'\)/.test(deck));
chk('browser: guard 後才 flipCardBody', /onCardBodyClick\(e\)[\s\S]{0,600}flipCardBody\(document\.getElementById\('cardPreviewBody'\)\)/.test(browser));
chk('deck: guard 後才 flipDeckCardBody', /onDeckCardBodyClick\(e\)[\s\S]{0,600}flipDeckCardBody\(document\.getElementById\('deckCardPreviewBody'\)\)/.test(deck));

console.log('[T2] bindSpeakClick 綁定');
chk('browser: import bindSpeakClick', /import \{ bindSpeakClick \} from '\.\.\/lib\/tts\.js'/.test(browser));
chk('deck: import bindSpeakClick', /import \{ bindSpeakClick \} from '\.\.\/lib\/tts\.js'/.test(deck));
chk('browser: 發音監聽直綁面板（bindCardEvents 內）', /bindCardEvents[\s\S]{0,300}bindSpeakClick\(document\.getElementById\('cardPreviewModal'\)/.test(browser));
chk('deck: 發音監聽直綁面板（bindCardEvents 內）', /bindCardEvents[\s\S]{0,300}bindSpeakClick\(document\.getElementById\('deckCardPreview'\)/.test(deck));

console.log('[T3] tts selector');
// CARDNEXT1（2026-09-11 使用者裁示第3點）：中文欄位移出清單——
// selector 取含 .study-word 的那個 closest（第一個 closest 已是 button  guard）。
const matches = [...tts.matchAll(/ev\.target\.closest\('([^']*)'\)/g)].map(m => m[1]);
const sel = matches.find(s => s.includes('.study-word')) || '';
for (const c of ['.card-panel-word', '.card-panel-pron', '.card-panel-example']) {
  chk(`tts selector 含 ${c}`, sel.split(', ').includes(c));
}
for (const c of ['.card-panel-def', '.card-panel-desc', '.split-badge']) {
  chk(`tts selector 不含中文欄 ${c}`, !sel.split(', ').includes(c));
}

console.log('[T4] guard ⊆ 可發音 ∪ 純功能');
// guard 擋的元素: 英文類必須 tts 吃得到; 中文/純功能類在 guard 擋翻面但 tts 不收為正確行為
const guardClasses = ['.card-panel-word', '.card-panel-pron', '.card-panel-def', '.card-panel-example', '.card-panel-desc', '.card-panel-tags', '.split-badge', '.chip-accent', '.chip-subtle', '.wimg-slot-wrap'];
const ttsSet = new Set(sel.split(', '));
for (const g of guardClasses) {
  const speakable = ['.card-panel-word', '.card-panel-pron', '.card-panel-example', '.chip-accent', '.chip-subtle'].includes(g);
  if (speakable) chk(`${g} 在 guard 且 tts 可發音`, ttsSet.has(g));
  else chk(`${g} 純功能/中文（guard 檔翻面；tts 不誤收）`, !ttsSet.has(g));
}

// 反向驗證：HEAD 已含特徵（已 commit）→ 跳過；僅工作區有未 commit 改動時 stash 驗證
console.log('[NEG] 反向驗證 (stash 後應紅)');
let headHas;
try { headHas = /TAPFLIP1/.test(execSync('git show HEAD:src/pages/browser.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) {
  console.log('  NEG-SKIP: 特徵已在 HEAD（已 commit），stash 拔 HEAD 不可能 — 跳過');
} else {
execSync('git stash push -q -- src/pages/browser.js src/pages/deck-browser.js src/lib/tts.js');
let negFail = 0;
try {
  const b2 = readFileSync('src/pages/browser.js', 'utf8');
  const d2 = readFileSync('src/pages/deck-browser.js', 'utf8');
  const t2 = readFileSync('src/lib/tts.js', 'utf8');
  if (/TAPFLIP1/.test(b2)) { negFail++; console.log('  NEG-FAIL: stash 後 browser 仍有 guard'); }
  if (/TAPFLIP1/.test(d2)) { negFail++; console.log('  NEG-FAIL: stash 後 deck 仍有 guard'); }
  if (/bindSpeakClick/.test(d2)) { negFail++; console.log('  NEG-FAIL: stash 後 deck 仍有 bindSpeakClick'); }
  if (/split-badge/.test(t2.match(/ev\.target\.closest\('([^']*)'\)/)?.[1] || '')) { negFail++; console.log('  NEG-FAIL: stash 後 tts 仍收 split-badge'); }
} finally {
  execSync('git stash pop -q');
}
if (negFail === 0) { pass++; console.log('  NEG-OK: stash 後 guard/綁定全滅 (harness 有效)'); }
else fail++;
}

console.log(`\nTAPFLIP1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
