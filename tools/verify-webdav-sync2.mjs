// SYNC2: 同步完整修收斂驗收（Q1 分叉／Q2 同步包／Q3 接力／Q4 GUI／Q5 雙服 parity／Q6 備用＋空檔＋多人）
// 跑法：node tools/verify-webdav-sync2.mjs
import { readFileSync, existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const R = '/home/jupiter/teno 修檢版';
const APP = '/home/jupiter/teno-webdav-app/server.py';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('== SYNC2 static: client (webdav_sync.rs) ==');
const rs = readFileSync(`${R}/src-tauri/src/webdav_sync.rs`, 'utf8');
for (const f of ['load_sync_state', 'save_sync_state', 'local_fingerprint', 'changed_since', 'remote_fingerprint', 'pack_sync_container', 'read_upload_payload', 'conflict_path', 'write_downloaded'])
  ok(`sync:${f}`, rs.includes(`fn ${f}(`));
ok('sync:CONFLICT upload', rs.includes('CONFLICT:兩邊自上次同步都各做各的'));
ok('sync:CONFLICT download', rs.includes('CONFLICT:兩邊自上次同步都各做各的'));
ok('sync:EMPTY_LOCAL', rs.includes('EMPTY_LOCAL:'));
ok('sync:EMPTY_REMOTE', rs.includes('EMPTY_REMOTE:'));
ok('sync:container magic TENOC', rs.includes('b"TENOC"'));
ok('sync:upload payload=container', rs.includes('read_upload_payload(&app_handle)?'));
ok('sync:download dual-write', rs.includes('write_downloaded(&app_handle, &db_bytes, &log_bytes)?'));
ok('sync:base advances on upload', rs.includes('last_dir: "upload"'));
ok('sync:base advances on download', rs.includes('last_dir: "download"'));
ok('sync:MIN_UPLOAD_SIZE', rs.includes('MIN_UPLOAD_SIZE'));

console.log('== SYNC2 static: embedded (webdav_serve.rs) ==');
const sv = readFileSync(`${R}/src-tauri/src/webdav_serve.rs`, 'utf8');
for (const f of ['rotate_history_file', 'port_occupied', 'maybe_autostart'])
  ok(`embed:${f}`, sv.includes(`fn ${f}(`) || sv.includes(`pub fn ${f}(`));
ok('embed:422 too small', sv.includes('too small: refuse empty/truncated upload'));
ok('embed:422 bad payload', sv.includes('bad payload: not TENOC/SQLite'));
ok('embed:history keep 5', sv.includes('saturating_sub(5)'));
ok('embed:autostart yields to standalone', sv.includes('獨立版頂著'));
ok('embed:status three-way', sv.includes('獨立版頂著') && sv.includes('都沒跑'));
ok('embed:blank pass keeps old', sv.includes('沿用已存'));

console.log('== SYNC2 static: standalone (server.py) ==');
const py = readFileSync(APP, 'utf8');
for (const f of ['load_auth_file', 'auth_user', 'user_root', 'payload_ok', 'rotate_history'])
  ok(`py:${f}`, py.includes(`def ${f}(`));
ok('py:multi-user map', py.includes('AUTH_USERS'));
ok('py:per-user dir', py.includes('os.path.join(ARGS.dir, u)'));
ok('py:422 too small', py.includes('too small: refuse empty/truncated upload'));
ok('py:422 bad payload', py.includes('bad payload: not TENOC/SQLite'));
ok('py:history keep', py.includes('HISTORY_KEEP'));
ok('py:auth-file flag', py.includes('--auth-file'));
ok('py:mirror in repo', existsSync(`${R}/scripts/webdav-server.py`));

console.log('== SYNC2 static: frontend ==');
const api = readFileSync(`${R}/src/lib/api.js`, 'utf8');
for (const f of ['webdavServerGetConfig', 'webdavServerSaveConfig', 'webdavServerStart', 'webdavServerStop', 'webdavServerStatus'])
  ok(`api:${f}`, api.includes(`export const ${f}`));
const st = readFileSync(`${R}/src/pages/settings.js`, 'utf8');
for (const id of ['webdavSrvPort', 'webdavSrvUser', 'webdavSrvPass', 'webdavSrvAutostart', 'webdavSrvSaveBtn', 'webdavSrvStartBtn', 'webdavSrvStopBtn', 'webdavSrvStatusText'])
  ok(`settings:id ${id}`, st.includes(`id="${id}"`));
ok('settings:CONFLICT upload branch', st.includes("msg.includes('CONFLICT:')"));
ok('settings:EMPTY_LOCAL branch', st.includes("msg.includes('EMPTY_LOCAL:')"));
ok('settings:EMPTY_REMOTE branch', st.includes("msg.includes('EMPTY_REMOTE:')"));
ok('settings:tenoc copy', st.includes('TENOC 同步包'));

console.log('== SYNC2 live: standalone rotation＋floors＋multi-user ==');
try { execSync('python3 -c "import sys; assert sys.version_info>=(3,8)"'); ok('python3 可用', true); }
catch { ok('python3 可用', false); process.exit(1); }

const curl = (args) => {
  try {
    return execSync(`curl -s -o /tmp/s2.out -w "%{http_code}" ${args}`, { timeout: 10000 }).toString().trim();
  } catch (e) { return 'CURL-ERR'; }
};
// --- 單人：floors＋rotation（先清殘留，保持冪等）---
{
  execSync('rm -rf /tmp/sync2-one /tmp/sync2-multi /tmp/s2tiny /tmp/s2bad.bin /tmp/s2g1.bin /tmp/s2g2.bin /tmp/s2down.bin /tmp/s2auth.json /tmp/s2a.bin /tmp/s2b.bin /tmp/s2ga.bin');
  const PORT = 18091;
  const srv = spawn('python3', [APP, '--dir', '/tmp/sync2-one', '--port', String(PORT), '--user', 'teno', '--password', 'p1'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise(r => setTimeout(r, 1200));
  const B = `http://127.0.0.1:${PORT}`, A = `-u teno:p1`;
  try {
    execSync(`printf 'hi' > /tmp/s2tiny`);
    ok('live:tiny PUT→422', curl(`-T /tmp/s2tiny ${B}/tiny.db ${A}`) === '422');
    execSync(`head -c 30000 /dev/zero | tr '\\0' 'x' > /tmp/s2bad.bin`);
    ok('live:bad-magic big PUT→422', curl(`-T /tmp/s2bad.bin ${B}/bad.db ${A}`) === '422');
    execSync(`python3 -c "open('/tmp/s2g1.bin','wb').write(b'TENOC\x01'+b'\\x00'*30000)"`);
    ok('live:good TENOC→201', curl(`-T /tmp/s2g1.bin ${B}/teno.db ${A}`) === '201');
    await new Promise(r => setTimeout(r, 1100));
    execSync(`python3 -c "open('/tmp/s2g2.bin','wb').write(b'TENOC\x01'+b'\\x01'*30000)"`);
    ok('live:overwrite→204', curl(`-T /tmp/s2g2.bin ${B}/teno.db ${A}`) === '204');
    const hist = execSync(`ls /tmp/sync2-one/.history/ 2>/dev/null | wc -l`).toString().trim();
    ok('live:.history 留檔', hist === '1', `got ${hist}`);
    execSync(`curl -s ${B}/teno.db -u teno:p1 -o /tmp/s2down.bin`);
    ok('live:GET 回來一致', readFileSync('/tmp/s2down.bin').equals(readFileSync('/tmp/s2g2.bin')) || execSync('cmp /tmp/s2g2.bin /tmp/s2down.bin && echo SAME').toString().trim() === 'SAME');
  } finally { srv.kill(); }
}
// --- 多人：隔離 ---
{
  const PORT = 18092;
  execSync(`echo '{"users": {"alice": "pw1", "bob": "pw2"}}' > /tmp/s2auth.json`);
  const srv = spawn('python3', [APP, '--dir', '/tmp/sync2-multi', '--port', String(PORT), '--auth-file', '/tmp/s2auth.json'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise(r => setTimeout(r, 1200));
  const B = `http://127.0.0.1:${PORT}`;
  try {
    execSync(`python3 -c "open('/tmp/s2a.bin','wb').write(b'TENOC\x01'+b'A'*30000)"`);
    execSync(`python3 -c "open('/tmp/s2b.bin','wb').write(b'TENOC\x01'+b'B'*30000)"`);
    ok('live:alice PUT→201', curl(`-T /tmp/s2a.bin ${B}/teno.db -u alice:pw1`) === '201');
    ok('live:bob PUT→201', curl(`-T /tmp/s2b.bin ${B}/teno.db -u bob:pw2`) === '201');
    execSync(`curl -s ${B}/teno.db -u alice:pw1 -o /tmp/s2ga.bin`);
    ok('live:alice 拿到自己的', execSync('cmp /tmp/s2a.bin /tmp/s2ga.bin && echo SAME').toString().trim() === 'SAME');
    ok('live:錯密碼→401', curl(`${B}/teno.db -u alice:pw2`) === '401');
    ok('live:未知帳號→401', curl(`${B}/teno.db -u eve:pw1`) === '401');
  } finally { srv.kill(); }
}

console.log(fail === 0 ? `SYNC2: PASS (${pass} pass, 0 fail)` : `SYNC2: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
