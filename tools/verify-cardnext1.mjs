#!/usr/bin/env node
// CARDNEXT1: 瀏覽器字卡五點（2026-09-11 使用者裁示）
// [C1] 例句區內「下一組」鈕拔除（只留 head 鈕）
// [C2] 按下一組不自動發音（bindSpeakClick 先查 target 是否在 button 內）
// [C3] 中文欄位不發音（def/desc/split-badge 移出清單；card-panel-example 走 extractEnglish）
// [C4] 翻卡學習正面不顯示圖片（study-v4 image 只在 isAns）
// [C5] 圖片在英文單字上方（study/exam 六頁 image 在 word-row 之前）
// 用法: node tools/verify-cardnext1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};

const we = readFileSync('src/lib/word-extra.js', 'utf8');
const tts = readFileSync('src/lib/tts.js', 'utf8');
const br = readFileSync('src/pages/browser.js', 'utf8');
const dk = readFileSync('src/pages/deck-browser.js', 'utf8');
const s4 = readFileSync('src/pages/study-v4.js', 'utf8');
const smc = readFileSync('src/pages/study-mc.js', 'utf8');
const ssp = readFileSync('src/pages/study-spell.js', 'utf8');
const ef = readFileSync('src/pages/exam-flip.js', 'utf8');
const emc = readFileSync('src/pages/exam-mc.js', 'utf8');
const esp = readFileSync('src/pages/exam-spell.js', 'utf8');

console.log('[C1] 例句區內鈕拔除');
chk('word-extra 無 ex-next-btn 生成', !we.includes('ex-next-btn'));
chk('browser 刷新無 btnHtml 殘留', !br.includes('btnHtml') && !br.includes('.ex-next-btn'));
chk('deck 刷新無 btnHtml 殘留', !dk.includes('btnHtml') && !dk.includes('.ex-next-btn'));
chk('head 鈕保留（兩頁）', br.includes('cardExNextBtn') && dk.includes('deckCardExNextBtn'));
chk('刷新寫 fmtExample(next) 不帶鈕', br.includes('el.innerHTML = fmtExample(next);') && dk.includes('el.innerHTML = fmtExample(next);'));

console.log('[C2] 下一組不自動發音');
chk('target button 優先擋（tts.js）', /ev\.target\.closest\('button, input, a, select, textarea, \.ex-next-btn, \.ex-corner'\)/.test(tts));

console.log('[C3] 中文欄位不發音');
const selMatch = tts.match(/ev\.target\.closest\('([^']+)'\);?\s*\n\s*if \(!el\) return;/);
const sel = selMatch ? selMatch[1] : '';
chk('清單無 card-panel-def', !sel.includes('.card-panel-def'), `sel=${sel.slice(0, 80)}`);
chk('清單無 card-panel-desc', !sel.includes('.card-panel-desc'));
chk('清單無 split-badge', !sel.includes('.split-badge'));
chk('清單保留英文欄（word/pron/example）', sel.includes('.card-panel-word') && sel.includes('.card-panel-pron') && sel.includes('.card-panel-example'));
chk('card-panel-example 走 extractEnglish', /card-panel-example'\)\)\s*\n?\s*\? extractEnglish/.test(tts));

console.log('[C4] 翻卡正面無圖');
chk('study-v4 image 綁 isAns', /isAns && visShow\('study', 'image'\)/.test(s4));
chk('study-v4 無裸 image 渲染', !/^\s*\$\{visShow\('study', 'image'\)/m.test(s4));

console.log('[C5] 圖片在單字上方（六頁）');
for (const [name, src, ctx] of [['study-v4', s4, 'study'], ['study-mc', smc, 'study'], ['study-spell', ssp, 'study'], ['exam-flip', ef, 'exam'], ['exam-mc', emc, 'exam'], ['exam-spell', esp, 'exam']]) {
  const imgIdx = src.indexOf(`visShow('${ctx}', 'image')`);
  const wordIdx = src.indexOf('study-word-row', imgIdx > 0 ? imgIdx - 2000 : 0);
  // image 出現位置要在同卡 word-row 之前：取最近的 word-row 在 image 之後
  const nextWord = src.indexOf('study-word-row', imgIdx);
  chk(`${name} image 在 word 前`, imgIdx > 0 && nextWord > imgIdx, '');
}

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /CARDNEXT1/.test(execSync('git show HEAD:src/lib/tts.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/lib/word-extra.js src/lib/tts.js src/pages/browser.js src/pages/deck-browser.js src/pages/study-v4.js src/pages/study-mc.js src/pages/study-spell.js src/pages/exam-flip.js src/pages/exam-mc.js src/pages/exam-spell.js');
  try {
    const w2 = readFileSync('src/lib/word-extra.js', 'utf8');
    const t2 = readFileSync('src/lib/tts.js', 'utf8');
    const innerBack = w2.includes('ex-next-btn');
    const cnBack = t2.includes('.card-panel-def');
    if (innerBack && cnBack) { pass++; console.log('  NEG-OK: stash 後舊特徵重現（harness 有效）'); }
    else { fail++; console.log(`  NEG-FAIL innerBack=${innerBack} cnBack=${cnBack}`); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nCARDNEXT1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
