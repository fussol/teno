// MEDIAPEEL1 驗收：sha1 優先／缺檔回退／直連透傳／寫入只存 sha。
import { readFileSync, existsSync } from 'node:fs';
const R = '/home/jupiter/teno 修檢版';
const F = (p) => readFileSync(`${R}/${p}`, 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n} ${x}`); } };

console.log('== MEDIAPEEL static: migration ==');
const lib = F('src-tauri/src/lib.rs');
ok('rust v15 sha1 column', lib.includes('version: 15,') && lib.includes('ADD COLUMN sha1'));
ok('rust v15 sha1 index', lib.includes('idx_word_images_sha1'));
const db = F('src/lib/db.js');
ok('js v15 fallback alter', db.includes('ADD COLUMN sha1'));
ok('js v15 fallback index', db.includes('idx_word_images_sha1'));

console.log('== MEDIAPEEL static: media store (rust) ==');
const ms = F('src-tauri/src/media_store.rs');
ok('media_put command', ms.includes('pub async fn media_put('));
ok('media_get command', ms.includes('pub async fn media_get('));
ok('media_list command', ms.includes('pub async fn media_list('));
ok('sha1 hex 40', ms.includes('String::with_capacity(40)'));
ok('10MB guard put', ms.includes('10 * 1024 * 1024'));
ok('handler registered', lib.includes('media_store::media_put'));

console.log('== MEDIAPEEL static: read path (js) ==');
ok('getImagesForWord sha first', db.includes('SELECT filename, data, sha1 FROM word_images WHERE word_id = $1'));
ok('getImagesForWord fallback', db.includes('缺檔回退 data 欄'));
ok('getImagesForWords batch sha', db.includes('SELECT word_id, filename, data, sha1 FROM word_images WHERE word_id IN'));
ok('old-db compat try/catch', (db.match(/catch \(\_\) \{\s*\n?\s*rows = await requireDB/g) || []).length >= 1);

console.log('== MEDIAPEEL static: write path (js) ==');
ok('addWordImage media_put first', db.includes('mediaPut'));
ok('addWordImage stores sha', db.includes('INSERT INTO word_images (word_id, filename, data, sha1)'));
ok('addWordImage fallback inline', db.includes('回退舊行為'));

console.log('== MEDIAPEEL static: share pack ==');
const sp = F('src-tauri/src/share_pack.rs');
ok('pack reads sha col', sp.includes('SELECT word_id, filename, data, sha1'));
ok('pack old-db compat', sp.includes('has_sha_col'));
ok('pack prefers media file', sp.includes('read_media_by_sha'));

console.log('== MEDIAPEEL static: sync channel ==');
const ws = F('src-tauri/src/webdav_sync.rs');
ok('parse_media_hrefs', ws.includes('fn parse_media_hrefs('));
ok('media_diff', ws.includes('fn media_diff('));
ok('media upload command', ws.includes('pub async fn webdav_media_upload('));
ok('media download command', ws.includes('pub async fn webdav_media_download('));
ok('download verifies sha', ws.includes('eq_ignore_ascii_case(want)'));
const sv = F('src-tauri/src/webdav_serve.rs');
ok('embed media channel', sv.includes('is_media_put('));
const py = readFileSync('/home/jupiter/teno-webdav-app/server.py', 'utf8');
ok('py media channel', py.includes('def is_media_put('));
ok('py media skips history', py.includes('media 內容尋址不可變'));
ok('mirror in repo', existsSync(`${R}/scripts/webdav-server.py`));

console.log('== MEDIAPEEL static: frontend ==');
const api = F('src/lib/api.js');
ok('api mediaPut/Get/List', api.includes('mediaPut') && api.includes('mediaGet') && api.includes('mediaList'));
ok('api media sync fns', api.includes('webdavMediaUpload') && api.includes('webdavMediaDownload'));
const st = F('src/pages/settings.js');
ok('settings piggyback upload', st.includes('webdavMediaUpload()'));
ok('settings piggyback download', st.includes('webdavMediaDownload()'));

console.log('== LOGPEEL static ==');
ok('upload skips app-log', ws.includes('LOGPEEL1') && ws.includes('pack_sync_container(&teno, &[])'));
ok('download keeps local log on empty seg', ws.includes('if (!log.is_empty())') || ws.includes('if !log.is_empty()'));

console.log(fail === 0 ? `MEDIAPEEL: PASS (${pass} pass, 0 fail)` : `MEDIAPEEL: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
