// verify-import-nodb.mjs — IMPORT-NODB: 無 teno.db 時備份放行、匯入不被安全網卡死
// Root cause: runImportDb 先 backupDb 做安全網；新裝／清過資料的機器根本沒有
// teno.db → File::open 炸 os error 2 → toast「匯入失敗: 複製資料庫失敗」→
// 後面覆寫一步都沒跑。修法：backup_db 遇缺 DB 回 Ok("") 放行（三處呼叫點皆
// 不讀回傳值：匯入／還原／Drive 下載＋自動備份 scheduler）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8').replace(/\/\/.*$/gm, '');
const body = s.slice(s.indexOf('fn backup_db'), s.indexOf('fn prune_backups'));
ok('缺 DB 早退放行', body.includes('!db_path.exists()') && body.includes('Ok(String::new())'), '無檔不炸');
ok('真失敗仍響亮', body.includes('複製資料庫失敗'), '讀寫錯照報');
ok('呼叫點不讀回傳', !body.includes('backupDb() as'), '契約不變');
const st = readFileSync(join(root, 'src/pages/settings.js'), 'utf8');
ok('匯入仍先備份', /await backupDb\(\);[\s\S]{0,200}?await importDbDialog/.test(st), '安全網還在');
process.exit(fail ? 1 : 0);
