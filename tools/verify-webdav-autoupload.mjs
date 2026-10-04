#!/usr/bin/env node
// 自動備份 WebDAV 上傳：差量優先、失敗落整包（與手動鈕同路徑；防回歸回純整包）
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/lib/backup-scheduler.js', import.meta.url), 'utf8');
let n = 0, fail = 0;
const ok = (cond, msg) => { n++; if (cond) console.log(`  ✓ ${msg}`); else { fail++; console.error(`  ✗ ${msg}`); } };

ok(/webdavPatchUpload[^]*?from '\.\/api\.js'/.test(src), 'import webdavPatchUpload');
ok(/try \{ msg = await webdavPatchUpload\(\); \}/.test(src), 'tick 差量優先（webdavPatchUpload 先）');
ok(/catch \(_\) \{ msg = await webdavUpload\(\); \}/.test(src), '差量失敗落整包（webdavUpload 兜底）');
// SYNC-STATE1 常規化釘（2026-10-04）：同步狀態獨立持久化＝重試／欠帳即清的根
ok(/getSetting\('webdavLastSyncMtime'\)/.test(src), '啟動讀回持久同步基準（重啟欠帳即清）');
ok(/setSetting\('webdavLastSyncMtime', String\(mtime\)\)/.test(src), '成功才推進 lastSyncMtime（失敗必重試）');
ok(/setSetting\('webdavLastSyncErr', err\)/.test(src), '失敗寫 webdavLastSyncErr（狀態列可見）');
ok(/flushMediaQueue\(\{ webdavMediaUpload \}\)/.test(src), 'auto tick 順帶媒體佇列（兌現 UI 文案）');
ok(!/if \(mtime <= lastBackupMtime\) return;/.test(src), '無「備份無變更即早退」（舊耦合點已拆，同步不再被本地 mtime 閘掉）');

console.log(fail ? `❌ ${fail}/${n} failed` : `✅ ${n}/${n} passed`);
process.exit(fail ? 1 : 0);
