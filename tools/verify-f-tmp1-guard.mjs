// verify-f-tmp1-guard.mjs — F-TMP1: temp 檔 RAII 守衛＋陳屍清理
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src-tauri/src/apkg.rs'), 'utf8')
  .replace(/\/\/.*$/gm, ''); // 註解提及舊寫法不算病灶
ok('RAII 守衛存在', s.includes('struct TempAnki2'), 'drop 即清');
ok('drop 先關後刪', /impl Drop for TempAnki2[\s\S]{0,300}?c\.close\(\)/.test(s), 'Windows 順序');
ok('寫失敗先刪', /暫存 collection\.anki2 失敗/.test(readFileSync(join(root, 'src-tauri/src/apkg.rs'), 'utf8')), '早退不殘留');
ok('檔名 random', s.includes('teno-apkg-{}.anki2", random_temp_name()'), 'nanos 可撞已換');
ok('陳屍清理在場', s.includes('fn cleanup_stale_anki2_tmp'), '24h 門');
ok('年齡門純函式', s.includes('fn anki2_tmp_is_stale'), '邊界可測');
ok('開檔失敗先刪', s.includes('開啟 collection.anki2 失敗'), '早退不殘留');
ok('rust 測試在庫', s.includes('f_tmp1_guard_cleans_up') && s.includes('f_tmp1_stale_gate'), 'cargo harness');
process.exit(fail ? 1 : 0);
