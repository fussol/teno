#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G14 防回歸驗證 — settings.js renderInPlace 重渲染後 custom-select 轉換遺失
// 修後: renderInPlace 在 onMount 後補 initCustomSelects(container)。
// 負控制: 修前 renderInPlace 不重建 custom-select → 重渲染的 <select> 非 custom。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const src = readFileSync(new URL('../src/pages/settings.js', import.meta.url), 'utf8');

console.log('── G14 renderInPlace 重建 custom-select ──');

// T1 FIX MARKER: renderInPlace 內呼叫 initCustomSelects
const rip = src.match(/function renderInPlace[\s\S]*?\n}/)?.[0] || '';
ok('T1 renderInPlace 呼叫 initCustomSelects', /initCustomSelects\(container\)/.test(rip));
ok('T1b 在 onMount 之後', /onMount\(s\);[\s\S]*?initCustomSelects\(container\)/.test(rip));
// T2 FIX MARKER: import 存在
ok('T2 import initCustomSelects', /import \{ initCustomSelects \} from '\.\.\/lib\/custom-select\.js'/.test(src));
// T3 G14 註解 marker
ok('T3 G14 註解 marker', src.includes('G14'));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);