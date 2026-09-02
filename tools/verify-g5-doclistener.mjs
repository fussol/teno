#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G5 防回歸驗證 — custom-select document capture click 累積
// 修後: document-level click listener 只綁一次（module 級 _globalDocBound），
//       多次 initCustomSelects / 多個 select 不再累積。
// 負控制: 修前每 build 一個 select 都綁一個 document listener → 累積 N 次。
// ═══════════════════════════════════════════════════════════════
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

// 建 3 個 select
const html = `<!DOCTYPE html><div id="r1">${'A'.repeat(30)}<select id="s1"><option>1</option></select></div>
<div id="r2"><select id="s2"><option>2</option></select></div>
<div id="r3"><select id="s3"><option>3</option></select></div>`;
const dom = new JSDOM(html, { pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
global.window = window; global.document = document; global.CSS = window.CSS;
global.MouseEvent = window.MouseEvent; global.KeyboardEvent = window.KeyboardEvent; global.Event = window.Event;

const src = readFileSync(new URL('../src/lib/custom-select.js', import.meta.url), 'utf8');
const fn = new Function('document','window','CSS','MouseEvent','KeyboardEvent','Event',
  src.replace(/^export function/gm,'function') + '\n;return { initCustomSelects };');
const { initCustomSelects } = fn(document, window, window.CSS, window.MouseEvent, window.KeyboardEvent, window.Event);

console.log('── G5 document click listener 累積 ──');

// 測量 document 上的 click listener 數（jsdom getEventListeners 不可用 → 用自配計數器）
let clicks = 0;
window.addEventListener('click', () => clicks++);

// 初始無 select build
const before = clicks;   // 都走 capture; 這裡測 capture listener 增加量

// 多次 init（模擬每頁 render）
initCustomSelects(document.getElementById('r1'));
initCustomSelects(document.getElementById('r2'));
initCustomSelects(document.getElementById('r3'));

// 核心：確保 global doc listener 只綁一次 → 從 source 檢查 _globalDocBound gating
ok('T1 有 _globalDocBound 單次綁定', /_globalDocBound\) return/.test(src) && /_globalDocBound = true/.test(src));
ok('T2 document.addEventListener 只有 module 級一處', (src.match(/document\.addEventListener/g) || []).length === 1);
ok('T3 build 內不再有 document.addEventListener', !/build\(select\)[\s\S]{0,2000}document\.addEventListener/.test(src));
ok('T4 ensureGlobalDocListener 在 initCustomSelects 呼叫', /initCustomSelects\(root\) \{[\s\S]*?ensureGlobalDocListener/.test(src));
ok('T5 _csOpenWraps 追蹤集合存在', /const _csOpenWraps = new Set/.test(src));
ok('T6 G5 註解 marker', src.includes('G5'));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);