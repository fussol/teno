#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// SR-C4 防回歸驗證 — makeSession 統一走 fsrsCtx（原 new FSRS() 預設權重/步漂移）
// 修前: makeSession 用 new FSRS() 預設權重，與 app/rate 讀 ankiSettings 漂移。
// 修後: makeSession 用 fsrsCtx(mode) 共享構造器（權重/retention/maxIvl/steps parse）。
// 負控制: 修前 makeSession 用 new FSRS() → 靜態 marker FAIL（bug 重現）。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const cli = readFileSync(new URL('../tools/cli.mjs', import.meta.url), 'utf8');

console.log('── SR-C4 makeSession 統一 fsrsCtx ──');

// 抓 makeSession 函式主體到 return 結尾
const m = cli.match(/function makeSession\(s\)\s*\{[\s\S]*?\n\}/);
const body = m ? m[0] : '';
// makeSession 內的 return 行
const retLine = (body.match(/return new Session\([^;]*;/) || [''])[0];

// T1 FIX MARKER: makeSession 的 return 不再用 new FSRS()
ok('T1 makeSession 不用 new FSRS() 預設權重', !/new FSRS\(\)/.test(retLine));

// T2 FIX MARKER: makeSession 呼叫 fsrsCtx
ok('T2 makeSession 呼叫 fsrsCtx(...)', body.includes('fsrsCtx(s.mode'));

// T3 FIX MARKER: 用 _ctx.fsrs（非 new FSRS()）
ok('T3 makeSession 用 fsrsCtx 回的 fsrs', /fsrs:\s*_ctx\.fsrs/.test(body));

// T4 順序正確：learnSteps(_ctx 版) 在 ANKI 之後，不會被 ANKI 字串覆蓋
ok('T4 learnSteps 覆蓋 ANKI（ANKI 在前）', /\.\.\.ANKI,\s*learnSteps:\s*_ctx\.learnSteps/.test(body));

// T5 fsrsCtx 是 function 宣告（hoisted，makeSession 前可用）
ok('T5 fsrsCtx 為 hoisted function 宣告', /^function fsrsCtx/.test(cli.match(/function fsrsCtx[\s\S]*?\n\}/)?.[0] || cli.split('\n').find(l=>l.includes('function fsrsCtx'))));

// T6 既有 makeSession spread 順序：mode 從 s 繼承
ok('T6 makeSession 保留 ...s（含 mode）', body.includes('...s') && !/\.\.\.s,[^}]*mode/.test(body.split(';')[0]));

// T7 負控制標記：E5 前 makeSession 是 new FSRS()
// 檢查 source 含 fsrsCtx 統一註解（修法標記）
ok('T7 makeSession 含統一副註解（SR-C4）', body.includes('SR-C4'));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);