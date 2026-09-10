#!/usr/bin/env node
// MODEDESC1: 學習/測驗六張模式卡說明納入 uiHints 備註開關
// 用法: node tools/verify-modedesc1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const study = readFileSync('src/pages/study.js', 'utf8');
const exam = readFileSync('src/pages/exam.js', 'utf8');
const css = readFileSync('src/styles/base.css', 'utf8');

console.log('[M1] 六張卡掛 mode-desc');
chk('study modeCard desc 掛 mode-desc', /class="mode-desc"[^>]*>\$\{m\.desc\}/.test(study));
chk('exam modeCard desc 掛 mode-desc', /class="mode-desc"[^>]*>\$\{m\.desc\}/.test(exam));
chk('study 三模式說明存在（翻卡/多選/拼字）', /FSRS 排程/.test(study) && /四選一/.test(study) && /訓練拼字/.test(study));
chk('exam 三模式說明存在', /核對正確/.test(exam) && /四個選項/.test(exam) && /字母級驗證/.test(exam));

console.log('[M2] CSS 隱藏規則');
chk('body.no-hints .mode-desc → none', /body\.no-hints \.mode-desc\{display:none\}/.test(css) || /body\.no-hints [\s\S]*?\.mode-desc[\s\S]*?\{display:none\}/.test(css));

console.log('[M3] 標題/待複習數字不受影響');
chk('study 模式標題不掛 class', /font-size:15px;font-weight:600;color:var\(--text-primary\)\">\$\{m\.label\}/.test(study));
chk('study 待複習數字不在 desc 行', !/mode-desc[\s\S]{0,120}待複習/.test(study));

// NEG: HEAD 已含則跳
console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /mode-desc/.test(execSync('git show HEAD:src/pages/study.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) { console.log('  NEG-SKIP: 特徵已在 HEAD'); }
else {
  execSync('git stash push -q -- src/pages/study.js src/pages/exam.js src/styles/base.css');
  try {
    const s2 = readFileSync('src/pages/study.js', 'utf8');
    const c2 = readFileSync('src/styles/base.css', 'utf8');
    // 精確比對：class="mode-desc"（HEAD 既有 .study-mode-desc 是另一顆舊類，勿誤傷）
    const gone = !/class="mode-desc"/.test(s2) && !/body\.no-hints \.mode-desc/.test(c2);
    if (gone) { pass++; console.log('  NEG-OK: stash 後特徵全滅'); }
    else { fail++; console.log('  NEG-FAIL: stash 後特徵仍在'); }
  } finally { execSync('git stash pop -q'); }
}

console.log(`\nMODEDESC1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
