#!/usr/bin/env node
// MODEDESC1: 學習/測驗六張模式卡說明——2026-09-10 v2 裁示：直接刪除（非隱藏）
// 用法: node tools/verify-modedesc1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const study = readFileSync('src/pages/study.js', 'utf8');
const exam = readFileSync('src/pages/exam.js', 'utf8');
const css = readFileSync('src/styles/base.css', 'utf8');

console.log('[M1] 六張卡說明已刪除（渲染層無 desc）');
chk('study modeCard 無 desc 行', !/class="mode-desc"/.test(study));
chk('exam modeCard 無 desc 行', !/class="mode-desc"/.test(exam));
chk('study MODES desc 資料保留（未來可復用不炸 build）', /desc: '看單字回想定義/.test(study));
chk('exam MODES desc 資料保留', /desc: '聽發音拼寫單字，字母級驗證'/.test(exam));

console.log('[M2] CSS no-hints 規則可留（desc 已不渲染，規則無作用但無害）');
chk('body.no-hints .mode-desc 規則存在（歷史相容）', /body\.no-hints[\s\S]{0,200}\.mode-desc/.test(css));

console.log('[NEG] 反向驗證');
let headHas;
try { headHas = /class="mode-desc"/.test(execSync('git show HEAD:src/pages/study.js', { encoding: 'utf8' })); }
catch { headHas = false; }
if (headHas) {
  execSync('git stash push -q -- src/pages/study.js src/pages/exam.js src/styles/base.css');
  try {
    const s2 = readFileSync('src/pages/study.js', 'utf8');
    if (/class="mode-desc"/.test(s2)) { pass++; console.log('  NEG-OK: stash 後 desc 行復活（harness 有效）'); }
    else { fail++; console.log('  NEG-FAIL'); }
  } finally { execSync('git stash pop -q'); }
} else {
  console.log('  NEG-SKIP: HEAD 已無 desc 行（已 commit 刪除）');
}

console.log(`\nMODEDESC1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);

