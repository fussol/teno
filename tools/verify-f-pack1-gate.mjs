// verify-f-pack1-gate.mjs — F-PACK1: 容器段長必須 try-U32 守門
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
  .replace(/\/\/.*$/gm, ''); // 註解提及舊寫法不算病灶
const pack = s.slice(s.indexOf('fn pack_db_container'), s.indexOf('fn unpack_db_container'));
ok('兩段走守門', (pack.match(/container_len_prefix/g) || []).length >= 2, 'teno＋log');
ok('無 as u32 截斷', !pack.includes('as u32'), '靜默截斷已清');
ok('helper 用 try_from', s.includes('u32::try_from(len)'), '超限 Err');
ok('拒訊息報段名', s.includes('拒絕打包以防損壞備份'), '用戶可讀');
ok('rust 測試在庫', s.includes('f_pack1_len_prefix_gate'), 'cargo harness');
process.exit(fail ? 1 : 0);
