#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G25 防回歸驗證 — app-log resetAttempted 永真布林 → resetCount 上限(3)
// 修後: 二次損壞仍能重建(resetCount<3), 達上限即停(防死循環)。
// 負控制: 修前 resetAttempted 唯一一次後永真 → 二次損壞不再重建。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const src = readFileSync(new URL('../src/lib/app-log.js', import.meta.url), 'utf8');

console.log('── G25 resetAttempted → resetCount 上限 ──');

// T1 FIX MARKER: 不再宣告 resetAttempted 布林（查變數宣告，非註解）
ok('T1 無 let resetAttempted = false', !/let resetAttempted\s*=\s*false/.test(src));
// T2 FIX MARKER: 用 resetCount 計數 + 上限 3
ok('T2 用 resetCount 且上限 3', /let resetCount = 0/.test(src) && /resetCount < 3/.test(src) && /resetCount\+\+/.test(src));
// T3 損壞監測仍保留（code 11 malformed）
ok('T3 malformed/code:11 監測仍在', /malformed\|code: 11/.test(src));
// T4 語意: 二次損壞能重建（resetCount 每次損壞++，非永真 blocking）
ok('T4 resetCount 每次損壞重設觸發(<3)', /if \(resetCount < 3 && .*malformed/.test(src));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);