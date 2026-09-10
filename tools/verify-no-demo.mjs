// verify-no-demo.mjs — NO-DEMO: 展示模式切除（使用者裁示：不要預放測試單字/標籤）
// db.js 不再有 Demo 分流；demo-data.js 不再存在；main.js 不再有展示 banner；
// seedIfEmpty 死碼（/seed-data.csv 永不存在）一併清。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const db = readFileSync(join(root, 'src/lib/db.js'), 'utf8');
ok('db 無 Demo 引用', !db.includes('Demo.') && !db.includes('demo-data'), '分流全清');
ok('db 無 demoMode', !db.includes('demoMode'), '旗標全清');
ok('db 無 isDemoMode', !db.includes('isDemoMode'), 'export 全清');
ok('demo-data.js 已刪', !existsSync(join(root, 'src/lib/demo-data.js')), '檔案消失');
const mn = readFileSync(join(root, 'src/main.js'), 'utf8');
ok('main 無展示 banner', !mn.includes('網頁展示模式') && !mn.includes('isDemoMode'), '提示全清');
ok('main 保留離線錯', mn.includes('資料庫無法連線'), '真錯照報');
const st = readFileSync(join(root, 'src/lib/store.js'), 'utf8');
ok('seedIfEmpty 已清', !st.includes('seedIfEmpty') && !st.includes('seed-data.csv') && !st.includes('teno_no_seed'), '死碼全清');
process.exit(fail ? 1 : 0);
