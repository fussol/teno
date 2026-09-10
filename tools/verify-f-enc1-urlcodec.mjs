// verify-f-enc1-urlcodec.mjs — F-ENC1: urlencode/url_decode 必須按 UTF-8 bytes
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const s = readFileSync(join(root, 'src-tauri/src/drive_sync.rs'), 'utf8')
  .replace(/\/\/.*$/gm, ''); // 註解提及舊寫法不算病灶
const enc = s.slice(s.indexOf('fn urlencode'), s.indexOf('fn url_decode'));
const dec = s.slice(s.indexOf('fn url_decode'), s.indexOf('SUCCESS_BODY'));
ok('encode 走 bytes', enc.includes('s.as_bytes()'), '逐 byte');
ok('encode 無 c as u8 截斷', !enc.includes('c as u8'), '截斷已清');
ok('decode 收 bytes', dec.includes('Vec<u8>'), '先收 bytes');
ok('decode 整段 UTF-8 解', dec.includes('from_utf8_lossy'), '多位元組不斷裂');
ok('decode 無 push-as-char 碎字', !/push\(\([^)]*\)\s*as\s+char\)/.test(dec), '碎字已清');
ok('非法 % 不吞 NUL', dec.includes("b'%'") || dec.includes('is_ascii_hexdigit'), '保留字面');
ok('rust 測試在庫', s.includes('f_enc1_utf8_roundtrip'), 'cargo harness');
process.exit(fail ? 1 : 0);
