// LOG-SCOPE1: 日誌分類驗證 — 源頭貼標籤＋開關擋寫入＋舊 log 相容
// 跑法：node tools/verify-logscope1.mjs
import { readFileSync } from 'node:fs';
import { classifyScope, setLogScopes, isScopeEnabled, LOG_SCOPES } from '../src/lib/app-log.js';

const R = '/home/jupiter/teno 修檢版';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const src = (p) => readFileSync(`${R}/${p}`, 'utf8');

console.log('== LOG-SCOPE1 classify ==');
ok('scopes 五類', JSON.stringify(LOG_SCOPES) === JSON.stringify(['study', 'sync', 'ocr', 'system', 'misc']));
ok('[exam-flip]→study', classifyScope('[exam-flip] foo') === 'study');
ok('[exam-mc]→study', classifyScope('[exam-mc] foo') === 'study');
ok('[exam-spell]→study', classifyScope('[exam-spell] foo') === 'study');
ok('[fsrs]→study', classifyScope('[fsrs] foo') === 'study');
ok('[empty]→study', classifyScope('[empty] foo') === 'study');
ok('[auto-backup]→sync', classifyScope('[auto-backup] foo') === 'sync');
ok('[import]→sync', classifyScope('[import] foo') === 'sync');
ok('[webdav]→sync', classifyScope('[webdav] foo') === 'sync');
ok('[ocr]→ocr', classifyScope('[ocr] foo') === 'ocr');
ok('[store]→system', classifyScope('[store] foo') === 'system');
ok('[db]→system', classifyScope('[db] foo') === 'system');
ok('[app-log]→system', classifyScope('[app-log] foo') === 'system');
ok('[main]→system', classifyScope('[main] foo') === 'system');
ok('[boot]→system', classifyScope('[boot] foo') === 'system');
ok('[sim]→system', classifyScope('[sim] foo') === 'system');
ok('未知前綴→misc', classifyScope('[zzz] foo') === 'misc');
ok('無前綴裸訊息→misc', classifyScope('hello world') === 'misc');
ok('關鍵字 備份→sync', classifyScope('自動備份完成') === 'sync');
ok('關鍵字 複習→study', classifyScope('複習完成：8 張') === 'study');
ok('關鍵字 辨識→ocr', classifyScope('辨識完成') === 'ocr');
ok('前綴優先於關鍵字', classifyScope('[ocr] 備份完成') === 'ocr');

console.log('== LOG-SCOPE1 scope switches ==');
setLogScopes({ study: true, sync: true, ocr: false, system: true, misc: true });
ok('ocr 關了', isScopeEnabled('ocr') === false);
ok('其他照開', isScopeEnabled('study') && isScopeEnabled('sync') && isScopeEnabled('system') && isScopeEnabled('misc'));
ok('非法 scope 視為開', isScopeEnabled('bogus') === true);
setLogScopes(null);
ok('null 不炸（維持現狀）', isScopeEnabled('ocr') === false);
setLogScopes({ ocr: true });
ok('開回來', isScopeEnabled('ocr') === true);

console.log('== LOG-SCOPE1 static: app-log.js ==');
const al = src('src/lib/app-log.js');
ok('logToDb 三參簽名', al.includes('maybeMsg') && al.includes('LOG_SCOPES.includes(scopeOrMsg)'));
ok('error 無視總開關', al.includes("lv !== 'error'") && al.includes('強制'));
ok('flush 關了也放行 error', al.includes("level === 'error'") && al.includes('writable'));
ok('flush 四欄寫入＋三欄退路', al.includes('ts, level, scope, message') && al.includes('舊庫'));
ok('prune error 90 天', al.includes('90 * 86400000') && al.includes('ERROR_KEEP_MS'));
ok('prune 關了清非 error', al.includes("level != 'error'"));
ok('fetchLogs scope 參數', al.includes('scope = null') && al.includes('scope = ?'));
ok('fetchLogs 舊庫退路', al.includes('退三欄'));
ok('countLogs scope 參數', al.includes('countLogs({ scope'));
ok('reset 重建帶 scope 欄', al.includes("scope TEXT NOT NULL DEFAULT 'misc'"));
ok('demo 種子帶 scope', al.includes("scope: 'study'") && al.includes("scope: 'ocr'"));

console.log('== LOG-SCOPE1 static: main.js ==');
const mj = src('src/main.js');
ok('轉發先分類', mj.includes('classifyScope(msg)') && mj.includes("logToDb(level, scope, msg)"));
ok('鏡像開關預設開', mj.includes('__logMirrorEnabled') && mj.includes('=== undefined'));
ok('關鏡像只剩 error', mj.includes("level !== 'error'") && mj.includes('return'));
ok('boot 訊息標 system', mj.includes("logToDb('log', 'system', '[boot]"));

console.log('== LOG-SCOPE1 static: rust ==');
const rs = src('src-tauri/src/lib.rs');
ok('migration v2 加 scope', rs.includes('version: 2') && rs.includes('ADD COLUMN scope'));
ok('v1 SQL 未動（checksum 保命）', rs.includes('create app_log and sim_runs tables'));
ok('ensure_applog_scope', rs.includes('fn ensure_applog_scope'));
ok('normalize_scope', rs.includes('fn normalize_scope'));
ok('匯出四段格式', rs.includes('# 格式: ISO時間 | level | scope | message'));
ok('匯入雙格式', rs.includes('舊三段') && rs.includes('splitn(4'));
ok('去重鍵含 scope', rs.includes('ts = ? AND level = ? AND scope = ? AND message = ?'));
ok('patch 四段', rs.includes('normalize_scope(&scope)'));
ok('patch 舊庫 misc 補齊', rs.includes('| misc |'));
ok('建表含 scope＋index', rs.includes("scope TEXT NOT NULL DEFAULT 'misc'") && rs.includes('idx_app_log_scope'));
ok('scope 單元測試', rs.includes('mod log_scope_tests'));

console.log('== LOG-SCOPE1 static: settings/store/applog-page ==');
const st = src('src/pages/settings.js');
ok('設定頁分類 checkbox', st.includes('data-logscope') && st.includes('記錄哪些分類'));
ok('設定頁鏡像開關', st.includes('logMirrorToggle') && st.includes('除錯鏡像'));
ok('設定頁保留天數搬出 devMode', st.includes('logRetentionInput') && !/devMode \? `[^`]*logRetentionInput/s.test(st));
ok('設定頁接線 setLogScope/setLogMirror', st.includes('setLogScope') && st.includes('setLogMirror'));
ok('error 90 天文案', st.includes('90 天'));
const so = src('src/lib/store.js');
ok('store: logScopes/logMirror 預設', so.includes('logScopes: { study: true') && so.includes('logMirror: true'));
ok('store: 載入＋hydrate', so.includes("getSetting('logScopes')") && so.includes("getSetting('logMirror')"));
ok('store: actions', so.includes('async setLogScope') && so.includes('async setLogMirror'));
ok('store: 開機下發開關', so.includes('setLogScopes(state.logScopes)') && so.includes('__logMirrorEnabled = state.logMirror'));
const ap = src('src/pages/app-log.js');
ok('日誌頁分類下拉', ap.includes('id="logScope"') && ap.includes('全部分類'));
ok('日誌頁 scope 徽標', ap.includes('SCOPE_LABEL'));
ok('日誌頁查詢帶 scope', ap.includes('scope: _scope || null'));

console.log(fail === 0 ? `LOG-SCOPE1: PASS (${pass} pass, 0 fail)` : `LOG-SCOPE1: FAIL (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
