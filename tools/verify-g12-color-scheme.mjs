#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G12 防回歸驗證 — base.css 硬編碼 color-scheme:dark → light mode 原生控制項深色殘留
// 修後: base.css 用 var(--color-scheme, dark) + theme.js 注入 light/dark。
// 負控制: 未修 base.css(:102) 含字面 color-scheme:dark → T1 FAIL。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const baseCss = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');
const themeSrc = readFileSync(new URL('../src/lib/theme.js', import.meta.url), 'utf8');

console.log('── G12 color-scheme 跟 mode 連動 ──');

// 抓 base.css 的 html rule color-scheme
const htmlRule = baseCss.split('\n').find(l => l.includes('color-scheme'));
ok('H0 找到 html color-scheme rule', !!htmlRule, htmlRule?.slice(0, 60));

// T1 FIX MARKER: base.css 不再硬編碼 color-scheme:dark（改 var）
// 硬編碼 = 字面 "color-scheme:dark" 且非 var
const hasVar = /color-scheme:\s*var\(--color-scheme/.test(htmlRule || '');
const hasHardcode = htmlRule ? /color-scheme:\s*dark/.test(htmlRule.replace(/var\(--color-scheme[^)]*\)/, '__VAR__')) : true;
ok('T1 base.css 用 var(--color-scheme) 且無硬編碼 dark', hasVar && !hasHardcode, `var=${hasVar} hard=${hasHardcode}`);

// T2 FIX MARKER: theme.js applyTheme 注入 --color-scheme
// 實際 code: '--color-scheme:' + (isDark ? 'dark' : 'light') + ';'
const injectAny = themeSrc.includes('--color-scheme') && /isDark\s*\?\s*'dark'\s*:\s*'light'/.test(themeSrc);
ok('T2 theme.js applyTheme 注入 --color-scheme', injectAny);

// T3 兩檔都有才成立（協同）
ok('T3 base.css + theme.js 雙點到位', hasVar && injectAny);

// T4 負控制標記: 若 base.css 是硬編碼 dark（修前）→ T1 會 false
// （由 T1 的 hasHardcode 反推：修前硬編碼 → hasVar=false → T1 false = bug 重現）
// 此處只在未修時印出說明
if (!hasVar) console.log('  [neg] base.css 仍未用 var → 修前 T1 應 FAIL（bug 重現確認）');

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);