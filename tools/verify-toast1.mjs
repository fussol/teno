#!/usr/bin/env node
// TOAST1: 右上角 toast（從右滑入＋右框型別色＋進度條＋單擊保留/雙擊關閉）
// 用法: node tools/verify-toast1.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); } };

const css = readFileSync('src/styles/base.css', 'utf8');
const js = readFileSync('src/lib/toast.js', 'utf8');
const html = readFileSync('index.html', 'utf8');
const main = readFileSync('src/main.js', 'utf8');

console.log('[T1] 位置：右上角');
chk('container 置頂', /\.toast-container\{[^}]*top:16px/.test(css));
chk('container 靠右', /\.toast-container\{[^}]*right:16px/.test(css));
chk('不再置底', !/\.toast-container\{[^}]*bottom:24px/.test(css));
chk('手機版全寬', /max-width:768px[\s\S]{0,200}\.toast-container\{[^}]*left:12px/.test(css));

console.log('[T2] 進場：從右邊框滑入');
chk('toastInRight 從 translateX(100%)', /@keyframes toastInRight\{from\{opacity:0;transform:translateX\(100%\)\}to\{opacity:1;transform:none\}\}/.test(css));
chk('toast 用新進場', /\.toast\{[^}]*animation:toastInRight/.test(css));
chk('舊 toastIn 已刪', !/@keyframes toastIn\{/.test(css));
chk('退場往右縮', /\.toast\.out\{[^}]*translateX\(32px\)/.test(css));

console.log('[T3] 型別色：右框＋圓點＋進度條');
chk('右框 3px 型別色', /border-right:3px solid var\(--toast-accent/.test(css));
chk('圓點吃型別色', /\.toast::before\{[^}]*background:var\(--toast-accent\)/.test(css));
chk('進度條吃型別色＋--toast-life', /\.toast::after\{[^}]*background:var\(--toast-accent\)[^}]*animation:toastBar var\(--toast-life/.test(css));
for (const [cls, accent] of [['success', 'green'], ['error', 'red'], ['warn', 'orange'], ['info', 'accent'], ['easter', 'accent']])
  chk(`${cls} 有型別色`, new RegExp(`\\.toast-${cls}\\{[^}]*--toast-accent:var\\(--${accent}\\)`).test(css));
chk('error 紅字保留', /\.toast-error\{[^}]*color:var\(--red\)/.test(css));
chk('舊 easter 散裝規則已刪', !/\.toast-easter::before/.test(css));
chk('reduced-motion 降級', /prefers-reduced-motion:reduce[\s\S]{0,160}\.toast::after\{[^}]*display:none/.test(css));

console.log('[T4] 行為：單擊保留／雙擊關閉／堆疊');
chk('預設型別 toast-info', /if \(!t\) t = 'toast-info'/.test(js));
chk('裸字正規化', /!t\.startsWith\('toast-'\)/.test(js));
chk('新的在上（prepend）', /container\.prepend\(el\)/.test(js));
chk('最多疊 4 顆', /children\.length > 4/.test(js));
chk('error 停 4.2s', /t === 'toast-error' \? 4200 : 2600/.test(js));
chk('單擊保留十秒', /addEventListener\('click'[\s\S]{0,260}setTimeout\(dismiss, 10000\)/.test(js));
chk('保留態凍結進度條', /\.toast\.held::after\{[^}]*animation-play-state:paused/.test(css));
chk('雙擊立刻縮回', /addEventListener\('dblclick'/.test(js));
chk('XSS 仍走純文字', /el\.textContent = String\(message/.test(js) && !/\.innerHTML\s*=/.test(js));

console.log('[T5] 接線：容器＋全域＋呼叫點');
chk('index.html 有容器', /id="toastContainer"/.test(html));
chk('main.js 掛 window.toast', /window\.toast = toast/.test(main));
{
  const files = ['src/main.js', 'src/pages/settings.js', 'src/pages/tools.js', 'src/pages/browser.js', 'src/pages/deck-browser.js',
    'src/pages/ocr.js', 'src/pages/import.js', 'src/pages/export.js', 'src/pages/simulator.js', 'src/pages/app-log.js',
    'src/pages/tag-manager.js', 'src/pages/exam-flip.js', 'src/pages/exam-mc.js', 'src/pages/exam-spell.js',
    'src/engine/session-utils.js', 'src/engine/session-mc-utils.js', 'src/engine/session-spell-utils.js', 'src/lib/easter-eggs.js'];
  const missing = files.filter(f => { try { return !/toast/.test(readFileSync(f, 'utf8')); } catch { return true; } });
  chk('18 個呼叫檔全接上', missing.length === 0, missing.join(','));
}
chk('warn 有樣式可用（舊 2＋正名 7）', (js.match(/toast-warn/g) || []).length >= 0
  && readFileSync('src/pages/deck-browser.js', 'utf8').includes(`'toast-warn'`)
  && readFileSync('src/pages/browser.js', 'utf8').includes(`'toast-warn'`)
  && readFileSync('src/pages/tools.js', 'utf8').includes(`'toast-warn'`)
  && readFileSync('src/pages/settings.js', 'utf8').includes(`'toast-warn'`)
  && /\.toast-warn\{[^}]*--toast-accent:var\(--orange\)/.test(css));

console.log(`\nTOAST1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
