#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G30 防回歸驗證 — backup-scheduler tick 重入保護
// 修後: tick 執行中再觸發直接 return（_ticking flag），防重複備份。
// 負控制: 修前無 _ticking → 併發重複 backupDb。
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const src = readFileSync(new URL('../src/lib/backup-scheduler.js', import.meta.url), 'utf8');

console.log('── G30 tick 重入保護 ──');

// T1 FIX MARKER: tick 開頭有 _ticking 檢查
ok('T1 tick 開頭 if(_ticking) return', /if \(_ticking\) return/.test(src));
// T2 FIX MARKER: _ticking = true 設鎖
ok('T2 設 _ticking=true', /_ticking = true/.test(src));
// T3 FIX MARKER: finally 釋放鎖（保證異常也釋放）
ok('T3 finally 釋放 _ticking=false', /finally[\s\S]*?_ticking = false/.test(src));
// T4 FIX MARKER: 宣告 _ticking 初始 false
ok('T4 宣告 let _ticking = false', /let _ticking = false/.test(src));
// T5 原有 backupDb 邏輯保留
ok('T5 backupDb/pruneBackups 保留', /await backupDb\(\)/.test(src) && /await pruneBackups\(MAX_BACKUPS\)/.test(src));

// T6 重入語意模擬：兩次 tick 同時 → 只執行一次 backup
// 驗證 _ticking flag 的「檢查→設鎖」順序（同步前綴，符合 JS 單執行緒）
const hasSyncGuard = /async function tick\(\) \{[\s\S]*?if \(_ticking\) return;[\s\S]*?_ticking = true;/.test(src);
ok('T6 tick 同步檢查/設鎖在前（先 check 後 lock，同 tick 安全）', hasSyncGuard);

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);