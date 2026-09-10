// verify-f-atom1-atomic.mjs — F-ATOM1: 兩庫皆原子寫＋sync
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
  .replace(/\/\/.*$/gm, ''); // 註解提及舊寫法不算病灶
const w = s.slice(s.indexOf('fn write_db_container'), s.indexOf('fn atomic_write_file'));
ok('log 走原子寫', w.includes('atomic_write_file(&app_dir.join("app-log.db")'), '混合態已滅');
ok('log 無直接覆寫', !w.includes('fs::write(app_dir.join("app-log.db")'), '舊路已清');
ok('helper 先寫後搬', s.includes('fn atomic_write_file'), 'tmp+rename');
ok('helper 有 sync', s.includes('sync_all()'), 'OS crash 窗口');
ok('tmp 慣例保留', s.includes('with_extension("db.tmp")'), 'teno.db.tmp');
ok('rust 測試在庫', s.includes('f_atom1_both_dbs_atomic'), 'cargo harness');
process.exit(fail ? 1 : 0);
