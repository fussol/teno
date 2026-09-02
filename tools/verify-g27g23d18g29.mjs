// verify-g27g23d18g29: 低影響批次（各靜態）
import { readFileSync } from 'node:fs';
const R = p => readFileSync(p, 'utf8');
const fail = [], pass = [];

// G27: human-data.track then 有 catch
const m = R('src/main.js');
if (/import\('\.\/lib\/human-data\.js'\)\.then\(hd => hd\.track\([^)]*\)\)\.catch\(/.test(m)) pass.push('G27: human-data.track promise 已接 .catch');
else fail.push('G27: .then(Human track) 無 catch');

// G23: settings onMount 內 mount 層 button[onclick] 轉 addEventListener
const s = R('src/pages/settings.js');
const ons = s.indexOf('export function onMount(s)');
const onEnd = s.indexOf('function showFilteredDeckModal');
const onBody = s.slice(ons, onEnd);
if (/button\[onclick\]/.test(onBody) && onBody.indexOf('querySelectorAll(\'button[onclick]') > -1) pass.push('G23: mount 層 button[onclick]→addEventListener 轉換');
else fail.push('G23: onMount 缺 mount 層 onclick 轉換');

// D18: backup-scheduler seed 目前 mtime
const b = R('src/lib/backup-scheduler.js');
if (/seedLastBackupMtime/.test(b) && /if \(mtime > 0\) lastBackupMtime = mtime/.test(b)) pass.push('D18: 啟動 seed 目前 DB mtime（首 tick 僅變更才備份）');
else fail.push('D18: 缺 seedLastBackupMtime 基準');

// G29: app-log _logGen 併發 guard
const a = R('src/pages/app-log.js');
const genCount = (a.match(/_logGen/g) || []).length;
if (/let _logGen = 0/.test(a) && /myGen !== _logGen/.test(a) && genCount >= 4) pass.push('G29: refresh/load-more 互斥 generation guard');
else fail.push(`G29: _logGen guard 不完整（${genCount} 處）`);

console.log(`\nG27/G23/D18/G29 verify: ${pass.length} PASS / ${fail.length} FAIL`);
pass.forEach(p => console.log('  ✓ ' + p));
fail.forEach(f => console.log('  ✗ ' + f));
process.exit(fail.length ? 1 : 0);