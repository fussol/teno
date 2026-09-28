#!/usr/bin/env node
// 自動備份 WebDAV 上傳：差量優先、失敗落整包（與手動鈕同路徑；防回歸回純整包）
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/lib/backup-scheduler.js', import.meta.url), 'utf8');
let n = 0, fail = 0;
const ok = (cond, msg) => { n++; if (cond) console.log(`  ✓ ${msg}`); else { fail++; console.error(`  ✗ ${msg}`); } };

ok(/webdavPatchUpload[^]*?from '\.\/api\.js'/.test(src), 'import webdavPatchUpload');
ok(/try \{ msg = await webdavPatchUpload\(\); \}/.test(src), 'tick 差量優先（webdavPatchUpload 先）');
ok(/catch \(_\) \{ msg = await webdavUpload\(\); \}/.test(src), '差量失敗落整包（webdavUpload 兜底）');

console.log(fail ? `❌ ${fail}/${n} failed` : `✅ ${n}/${n} passed`);
process.exit(fail ? 1 : 0);
