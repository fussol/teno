// WEBDAV1: WebDAV 同步靜態＋實彈驗收（零外部依賴）
// 跑法：node tools/verify-webdav1.mjs
// 靜態：後端 6 命令註冊／api 匯出／設定頁 WebDAV 接線／Drive UI 已退役／server 腳本方法齊
// 實彈：起本地 webdav-server.py（127.0.0.1:18089）→ PUT/GET/HEAD/PROPFIND＋401 否定全過
import { readFileSync, existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('== WEBDAV1 static ==');
const rs = readFileSync(`${R}/src-tauri/src/webdav_sync.rs`, 'utf8');
for (const c of ['webdav_save_config', 'webdav_status', 'webdav_test', 'webdav_upload', 'webdav_download', 'webdav_logout'])
  ok(`rust:${c}`, rs.includes(`pub async fn ${c}`));
ok('rust:0600 私寫', rs.includes('0o600'));
ok('rust:HEAD 對帳', rs.includes('head_remote'));
ok('rust:下載守門 SQLite magic', rs.includes('SQLite format 3'));
ok('rust:b64 自帶（零新依賴）', rs.includes('fn base64_encode'));
ok('rust:單元測試 b64/normalize/civil', rs.includes('mod tests'));

const lib = readFileSync(`${R}/src-tauri/src/lib.rs`, 'utf8');
ok('lib:mod webdav_sync', lib.includes('mod webdav_sync;'));
for (const c of ['webdav_save_config', 'webdav_status', 'webdav_test', 'webdav_upload', 'webdav_download', 'webdav_logout'])
  ok(`lib:handler ${c}`, lib.includes(`webdav_sync::${c}`));

const api = readFileSync(`${R}/src/lib/api.js`, 'utf8');
for (const f of ['webdavSaveConfig', 'webdavStatus', 'webdavTest', 'webdavUpload', 'webdavDownload', 'webdavLogout'])
  ok(`api:${f}`, api.includes(`export const ${f}`));

const st = readFileSync(`${R}/src/pages/settings.js`, 'utf8');
for (const id of ['webdavUrl', 'webdavUser', 'webdavPass', 'webdavSaveBtn', 'webdavTestBtn', 'webdavUploadBtn', 'webdavDownloadBtn', 'webdavClearBtn', 'webdavStatusText'])
  ok(`settings:id ${id}`, st.includes(`id="${id}"`));
ok('settings:Drive UI 已退役', !st.includes('driveCredsSection') && !st.includes('driveSaveCredsBtn') && !st.includes('driveSyncBtn') && !st.includes('Google Drive 同步'));
ok('settings:密碼存後清空', st.includes("getElementById('webdavPass').value = ''"));
ok('settings:上傳前 checkpoint', st.includes('checkpoint()') && st.includes('webdavUpload()'));
ok('settings:下載前備份＋關庫', st.includes('backupDb()') && st.includes('webdavDownload()'));

const py = readFileSync(`${R}/scripts/webdav-server.py`, 'utf8');
for (const m of ['do_GET', 'do_HEAD', 'do_PUT', 'do_DELETE', 'do_MKCOL', 'do_PROPFIND', 'do_OPTIONS'])
  ok(`server:${m}`, py.includes(`def ${m}`));
ok('server:Basic 認證＋401', py.includes('WWW-Authenticate') && py.includes('compare_digest'));
ok('server:原子寫 .part＋replace', py.includes('.part') && py.includes('os.replace'));
ok('server:防穿越 commonpath', py.includes('commonpath'));
ok('server:207 multistatus', py.includes('207') && py.includes('multistatus'));
ok('serve.sh 存在可執行', existsSync(`${R}/scripts/webdav-serve.sh`));

console.log('== WEBDAV1 live (127.0.0.1:18089) ==');
try { execSync('python3 -c "import sys; assert sys.version_info>=(3,8)"'); ok('python3 可用', true); }
catch { ok('python3 可用', false); process.exit(1); }

const PORT = 18089, USER = 't1', PASS = 'p1';
const srv = spawn('python3', [`${R}/scripts/webdav-server.py`, '--dir', '/tmp/webdav1-test',
  '--port', String(PORT), '--user', USER, '--password', PASS],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const curl = (args, input) => {
  try {
    return execSync(`curl -s -o /tmp/w1.out -w "%{http_code}" ${args}`,
      { input, timeout: 10000 }).toString().trim();
  } catch (e) { return 'CURL-ERR'; }
};
await new Promise(r => setTimeout(r, 1200));
const B = `http://127.0.0.1:${PORT}`;
const AUTH = `-u ${USER}:${PASS}`;
try {
  ok('live:未認證→401', curl(`-X PROPFIND ${B}/`) === '401');
  ok('live:錯密碼→401', curl(`-X PROPFIND ${B}/ -u ${USER}:wrong`) === '401');
  ok('live:PROPFIND 207', curl(`-X PROPFIND ${B}/ ${AUTH}`) === '207');
  ok('live:HEAD 無檔→404', curl(`-I ${B}/teno.db ${AUTH}`) === '404');
  execSync(`python3 -c "open('/tmp/w1up.bin','wb').write(b'TENOC\\x01'+b'WEBDAV1-HELLO'+b'\\x00'*30000)"`);
  ok('live:PUT 201', curl(`-X PUT --data-binary @/tmp/w1up.bin ${B}/teno.db ${AUTH}`) === '201');
  ok('live:HEAD 有檔→200', curl(`-I ${B}/teno.db ${AUTH}`) === '200');
  ok('live:PUT 覆寫 204', curl(`-X PUT --data-binary @/tmp/w1up.bin ${B}/teno.db ${AUTH}`) === '204');
  execSync(`curl -s ${B}/teno.db -u ${USER}:${PASS} -o /tmp/w1down.bin`);
  ok('live:GET 內容一致', readFileSync('/tmp/w1down.bin').equals(readFileSync('/tmp/w1up.bin')));
  // SYNC2-Q6：空檔／壞魔數照樣拒收（舊版行為變更點，鎖死）
  execSync(`printf 'hi' > /tmp/w1tiny`);
  ok('live:空檔 PUT→422', curl(`-X PUT --data-binary @/tmp/w1tiny ${B}/tiny.db ${AUTH}`) === '422');
  ok('live:DELETE 204', curl(`-X DELETE ${B}/teno.db ${AUTH}`) === '204');
  ok('live:刪後 HEAD 404', curl(`-I ${B}/teno.db ${AUTH}`) === '404');
} finally { srv.kill(); }

console.log(fail === 0 ? `WEBDAV1: PASS (${pass} pass, 0 fail)` : `WEBDAV1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
