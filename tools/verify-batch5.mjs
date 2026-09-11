#!/usr/bin/env node
// BATCH5 2026-09-10 五點: (1)模式卡說明刪除 (2)字卡點字發音-面板直綁 (3)圖片在單字上方 (4)雙擊翻面 (5)下一組例句
// 用法: node tools/verify-batch5.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const study = readFileSync('src/pages/study.js', 'utf8');
const exam = readFileSync('src/pages/exam.js', 'utf8');
const browser = readFileSync('src/pages/browser.js', 'utf8');
const deck = readFileSync('src/pages/deck-browser.js', 'utf8');
const svg = readFileSync('src/lib/svg.js', 'utf8');
const wordExtra = readFileSync('src/lib/word-extra.js', 'utf8');
const rotation = readFileSync('src/lib/example-rotation.js', 'utf8');
const css = readFileSync('src/styles/base.css', 'utf8');

console.log('[1] 模式卡說明直接刪除');
chk('study modeCard 無 desc 渲染', !/class="mode-desc"/.test(study));
chk('exam modeCard 無 desc 渲染', !/class="mode-desc"/.test(exam));
chk('study MODES desc 資料仍在（顯示層不印）', /desc: '看單字回想定義/.test(study));
chk('exam MODES desc 資料仍在', /desc: '聽發音拼寫單字，字母級驗證'/.test(exam));

console.log('[2] 字卡點字發音——發音監聽直綁面板');
chk('browser: bindCardEvents 內 bindSpeakClick(面板)', /bindCardEvents[\s\S]{0,400}bindSpeakClick\(document\.getElementById\('cardPreviewModal'\)/.test(browser));
chk('deck: bindCardEvents 內 bindSpeakClick(面板)', /bindCardEvents[\s\S]{0,400}bindSpeakClick\(document\.getElementById\('deckCardPreview'\)/.test(deck));
chk('browser: 面板掛 document.body（非 pageContainer）', /document\.body\.insertAdjacentHTML\('beforeend', mkPanelHTML/.test(browser));
chk('browser import bindSpeakClick', /import \{ bindSpeakClick \}/.test(browser));
chk('deck import bindSpeakClick', /import \{ bindSpeakClick \}/.test(deck));

console.log('[3] 圖片顯示於英文單字上方');
const faceHtml = wordExtra;
const imgIdx = faceHtml.search(/gv\('image'\).*wimg-slot-wrap/);
const wordIdx = faceHtml.search(/gv\('word'\).*card-panel-word/);
chk('cardFaceHtml: image push 在 word push 之前', imgIdx >= 0 && wordIdx >= 0 && imgIdx < wordIdx);

console.log('[4] 雙擊翻面');
chk('browser: dblclick 綁定 ×2', (browser.match(/addEventListener\('dblclick', onCardBodyClick\)/g) || []).length === 2);
chk('deck: dblclick 綁定 ×2', (deck.match(/addEventListener\('dblclick', onDeckCardBodyClick\)/g) || []).length === 2);
chk('browser: 無 click 翻面殘留', !/addEventListener\('click', onCardBodyClick\)/.test(browser));
chk('deck: 無 click 翻面殘留', !/addEventListener\('click', onDeckCardBodyClick\)/.test(deck));
chk('browser: hint 文字點兩下', /點兩下看背面/.test(browser));
chk('deck: hint 文字點兩下', /點兩下看背面/.test(deck));

console.log('[5] 下一組例句（演算法＋UI）');
// 演算法行為模擬（node 子進程跑 example-rotation.js 對拍使用者 ABCDEF 案例）
const sim = execSync(`node -e "
const { pickNextExamples } = await import('./src/lib/example-rotation.js');
const lines=['A','B','C','D','E','F']; const counts={};
const first = pickNextExamples(lines,2,[],counts);
chk_first: { if(first.length===2&&new Set(first).size===2) console.log('first-ok'); else { console.log('first-FAIL'); } }
const second = pickNextExamples(lines,2,first,counts);
if(second.every(s=>!first.includes(s)) && second.length===2) console.log('second-ok'); else console.log('second-FAIL');
const third = pickNextExamples(lines,2,second,counts);
if(third.length===2) console.log('third-ok'); else console.log('third-FAIL');
" --input-type=module`, { encoding: 'utf8', cwd: process.cwd() });
chk('演算法: first/second/three 全 ok', ['first-ok','second-ok','third-ok'].every(t => sim.includes(t)));
chk('svg.js 有 examplePoolFor/rotateExamples/bindExNext/studyExampleHtml', /export function examplePoolFor/.test(svg) && /export function rotateExamples/.test(svg) && /export function bindExNext/.test(svg) && /export function studyExampleHtml/.test(svg));
chk('rotation.js 優先最少出現次數', /Math\.min\(\.\.\.pool\.map/.test(rotation));
chk('六 study/exam 頁吃 studyExampleHtml', ['study-v4','study-mc','study-spell','exam-flip','exam-mc','exam-spell'].every(p => readFileSync(`src/pages/${p}.js`, 'utf8').includes('studyExampleHtml(w)')));
chk('六頁 onMount 綁 bindExNext', ['study-v4','study-mc','study-spell','exam-flip','exam-mc','exam-spell'].every(p => readFileSync(`src/pages/${p}.js`, 'utf8').includes('bindExNext(')));
chk('exam 三頁 getWord 用 e.words[e.idx]', ['exam-flip','exam-mc','exam-spell'].every(p => readFileSync(`src/pages/${p}.js`, 'utf8').includes('() => e.words[e.idx]')));
chk('browser head 鈕: 發音鈕→下一組例句鈕', /id="cardExNextBtn"[^>]*>\$\{icon\('shuffle'\)\}/.test(browser) && !/id="cardPronBtn"/.test(browser));
chk('deck head 鈕: 發音鈕→下一組例句鈕', /id="deckCardExNextBtn"/.test(deck) && !/id="deckCardPronBtn"/.test(deck));
chk('字卡例句區內鈕已拔（CARDNEXT1：只留 head 鈕）', !/ex-next-btn/.test(wordExtra) && /id="cardExNextBtn"/.test(browser) && /id="deckCardExNextBtn"/.test(deck));
chk('字卡例句走 examplePoolFor', /h\.examplePoolFor \? h\.examplePoolFor\(w\)/.test(wordExtra));
chk('study 右上角鈕 absolute top:8px right:8px', /position:absolute;top:8px;right:8px/.test(svg));
chk('shuffle icon 存在（svg.js icons）', /shuffle:/.test(svg));

// 回歸: no-hints CSS 仍在
chk('回歸: no-hints 體系含 mode-desc', /body\.no-hints \.mode-desc\{display:none\}|body\.no-hints[\s\S]*?\.mode-desc[\s\S]*?\{display:none\}/.test(css));
chk('回歸: uihints toggle 存在', /id="uiHintsToggle"/.test(readFileSync('src/pages/settings.js', 'utf8')));

console.log(`\nBATCH5: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
