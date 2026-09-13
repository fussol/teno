// ═══════════════════════════════════════════════════════════════
// app-log — 操作日誌 + 模擬歷史。
// 使用隔離 DB (app-log.db)，與 teno.db 真實學習資料完全分離。
// 保留天數由設定控制 (0 = 不記錄)。啟動時清理過期記錄。
// ═══════════════════════════════════════════════════════════════

let ready = false;
let enabled = false;
let retentionDays = 14;
let queue = [];
let timer = null;
let db = null;
let resetCount = 0;   // G25: 損壞重建次數（上限防死循環；非永真布林 → 二次損壞仍能重建）
const MAX_BATCH = 200;

// ─── LOG-SCOPE1：日誌分類（源頭貼標籤，開關在寫入前擋；filter 只是順便查）───
// scope 出生即定：study 學習測驗／sync 備份同步匯出入／ocr 辨識補齊／
// system 開機底層除錯／misc 認不出來的。error 級別無視開關強制留。
export const LOG_SCOPES = ['study', 'sync', 'ocr', 'system', 'misc'];
export const LOG_SCOPE_LABEL = { study: '學習', sync: '同步', ocr: '辨識', system: '系統', misc: '其他' };
const SCOPE_BY_PREFIX = {
  study: ['empty', 'exam-flip', 'exam-mc', 'exam-spell', 'fsrs', 'study'],
  sync: ['auto-backup', 'import', 'export', 'backup', 'drive', 'webdav', 'apkg'],
  ocr: ['ocr'],
  system: ['store', 'db', 'app-log', 'main', 'boot', 'settings', 'sim', 'tts'],
};
const _prefixToScope = {};
for (const [scope, prefixes] of Object.entries(SCOPE_BY_PREFIX)) {
  for (const p of prefixes) _prefixToScope[p] = scope;
}
// 無前綴訊息的中文關鍵字兜底（console 轉發裡大量裸訊息）
const SCOPE_KEYWORDS = [
  [/webdav|備份|匯出|匯入|同步/i, 'sync'],
  [/ocr|辨識|查證|還原模型/i, 'ocr'],
  [/複習|測驗|學習|模擬|fsrs/i, 'study'],
  [/開機|啟動|boot/i, 'system'],
];

/** 訊息 → scope（前綴表優先，中文關鍵字兜底，認不出＝misc）。pure fn，可測。 */
export function classifyScope(msg) {
  const s = String(msg ?? '');
  const m = /^\[([a-zA-Z0-9_-]+)\]/.exec(s);
  if (m && _prefixToScope[m[1]]) return _prefixToScope[m[1]];
  for (const [re, scope] of SCOPE_KEYWORDS) {
    if (re.test(s)) return scope;
  }
  return 'misc';
}

const _scopeEnabled = { study: true, sync: true, ocr: true, system: true, misc: true };

/** store 載入設定後呼叫（物件缺鍵視為開；null/非法視為全開）。 */
export function setLogScopes(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const sc of LOG_SCOPES) {
      if (obj[sc] !== undefined) _scopeEnabled[sc] = obj[sc] !== false && obj[sc] !== 0 && obj[sc] !== '0';
    }
  }
  if (typeof window !== 'undefined') window.__logScopes = { ..._scopeEnabled };
}

export function isScopeEnabled(scope) {
  if (!LOG_SCOPES.includes(scope)) return true;
  return _scopeEnabled[scope] !== false;
}

// ─── WEB-DEMO（2026-09-08 使用者裁示：網頁版內建示範資料）───
// 無 Tauri 後端時：寫入走記憶體、查詢回種子，不碰 plugin-sql。實機零影響。
const noBackend = () => typeof window !== 'undefined' && typeof window.__TAURI__?.core !== 'object';
let demoLogSeq = -1;
const demoLogs = [
  { id: -1, ts: Date.now() - 5 * 60000, level: 'log', scope: 'system', message: '展示模式啟動：載入 36 個示範單字' },
  { id: -2, ts: Date.now() - 42 * 60000, level: 'log', scope: 'study', message: '複習完成：GRE 核心 8 張（Good 6 / Again 2）' },
  { id: -3, ts: Date.now() - 3 * 3600000, level: 'log', scope: 'ocr', message: '自動補齊：pos-Cambridge 為 3 個單字補上詞性' },
  { id: -4, ts: Date.now() - 5 * 3600000, level: 'log', scope: 'sync', message: '匯入示範字庫：托福 12 詞' },
  { id: -5, ts: Date.now() - 26 * 3600000, level: 'warn', scope: 'ocr', message: 'OCR 引擎忙碌中，重試第 1 次' },
  { id: -6, ts: Date.now() - 30 * 3600000, level: 'log', scope: 'study', message: '測驗完成：拼寫 10 題答對 7 題' },
];
const demoSimRuns = [
  { id: 1, ts: Date.now() - 2 * 86400000, kind: 'simulate', days: 30, target_pct: 90, seed: 42, from_zero: 0, total_reviews: 512, mature_cards: 28, mature_pct: 77.8, summary: '示範模擬：30 天後成熟度 77.8%' },
];

async function getDb() {
  if (!db) {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    db = await Database.load('sqlite:app-log.db');
  }
  return db;
}

export function getRetentionDays() { return retentionDays; }

/** 匯出前呼叫: 先 flush 記憶體佇列, 再把 app-log.db 的 WAL 併入主檔。 */
export async function checkpointAppLog() {
  await flush();
  try {
    const d = await getDb();
    await d.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
}

/** 匯入後呼叫: 關閉連線, 強制 reload 後重建 — 避免 plugin-sql 快取舊 page cache。 */
export async function closeAppLog() {
  if (db) {
    try { await db.close(); } catch {}
    db = null;
  }
}

/** 啟動時呼叫：設定保留天數並開始運作。days=0 表示不記錄。 */
export function initAppLog(days) {
  retentionDays = days > 0 ? days : 0;
  enabled = retentionDays > 0;
  ready = true;
  if (!enabled) { queue = []; return; }
  pruneLogs();
  flush();
}

/** 設定頁調整保留天數。 */
export function setLogRetention(days) {
  retentionDays = days > 0 ? days : 0;
  enabled = retentionDays > 0;
  if (!enabled) { queue = []; return; }
  pruneLogs();
}

export function isLogEnabled() { return ready && enabled; }

/**
 * 寫一條日誌。相容兩種叫法：
 *   logToDb(level, msg) — scope 自動分類
 *   logToDb(level, scope, msg) — 出生即貼標籤（main.js 轉發用這個）
 * LOG-SCOPE1 語意：error 強制寫（無視總開關＋scope 開關）；其餘先過總開關再過 scope 開關。
 */
export function logToDb(level, scopeOrMsg, maybeMsg) {
  let scope, msg;
  if (maybeMsg !== undefined) {
    scope = LOG_SCOPES.includes(scopeOrMsg) ? scopeOrMsg : classifyScope(maybeMsg);
    msg = maybeMsg;
  } else {
    msg = scopeOrMsg;
    scope = classifyScope(msg);
  }
  const lv = String(level || 'log');
  if (lv !== 'error') {
    if (!ready || !enabled) return;
    if (!isScopeEnabled(scope)) return;
  } else if (!ready) {
    return;
  }
  if (noBackend()) {   // WEB-DEMO：直接進記憶體，不經 flush/DB
    demoLogs.unshift({ id: demoLogSeq--, ts: Date.now(), level: lv, scope, message: String(msg || '') });
    if (demoLogs.length > 200) demoLogs.length = 200;
    return;
  }
  queue.push([Date.now(), lv, scope, String(msg || '')]);
  if (queue.length >= MAX_BATCH) { flush(); return; }
  if (!timer) timer = setTimeout(flush, 2000);
}

async function flush() {
  timer = null;
  if (noBackend()) {   // WEB-DEMO：佇列直接併入記憶體日誌
    const batch = queue.splice(0, queue.length);
    for (const [ts, level, scope, message] of batch) demoLogs.unshift({ id: demoLogSeq--, ts, level, scope: scope || 'misc', message });
    if (demoLogs.length > 200) demoLogs.length = 200;
    return;
  }
  // LOG-SCOPE1：總開關關了也放行 error（強制保留）；其餘照舊擋。
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  const writable = enabled ? batch : batch.filter(([, level]) => level === 'error');
  if (!writable.length) return;
  try {
    const d = await getDb();
    // 舊庫可能尚無 scope 欄（migration v2 未跑前）：先試四欄，失敗退三欄（scope 丟失僅影響分類，不丟訊息）
    const values = writable.map(() => '(?, ?, ?, ?)').join(',');
    try {
      await d.execute(`INSERT INTO app_log (ts, level, scope, message) VALUES ${values}`, writable.flat());
    } catch (_) {
      const v3 = writable.map(() => '(?, ?, ?)').join(',');
      await d.execute(`INSERT INTO app_log (ts, level, message) VALUES ${v3}`, writable.map(([ts, level, , message]) => [ts, level, message]).flat());
    }
  } catch (e) {
    // 失敗一律回補並重新排程, 避免批次被靜默丟棄或永久擱置
    queue.unshift(...writable);
    console.warn('[app-log] 寫入失敗, 將重試:', e);
    // SQLite 檔案損壞（code 11 malformed): 刪檔重建, 避免每 2 秒無限重試。
    // G25: resetCount 上限 3 — 二次損壞仍能再重建（原 resetAttempted 永真→二次損壞卡死），
    // 但達上限即停止重建（防死循環：損壞重建後又損壞會無限刪檔）。
    if (resetCount < 3 && /malformed|code: 11/i.test(String(e?.message || e))) {
      resetCount++;
      resetAndReload();
    }
    if (!timer) timer = setTimeout(flush, 2000);
  }
}

/** app-log.db 損壞時：Kotlin/Rust 刪檔 → JS 關閉舊連線 → 重建 table → 繼續寫入。 */
async function resetAndReload() {
  try {
    const { resetAppLogDb } = await import('./api.js');
    const deleted = await resetAppLogDb();
    console.warn('[app-log] DB 損壞, 已刪檔重建:', deleted);
    await closeAppLog();
    db = null;
    // plugin-sql 的 migration 只在首次 load 跑一次；刪檔後需手動重建 table
    const d = await getDb();
    await d.execute(
      'CREATE TABLE IF NOT EXISTS app_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL DEFAULT \'log\', scope TEXT NOT NULL DEFAULT \'misc\', message TEXT NOT NULL)'
    );
    await d.execute('CREATE INDEX IF NOT EXISTS idx_app_log_ts ON app_log(ts)');
    try { await d.execute("ALTER TABLE app_log ADD COLUMN scope TEXT NOT NULL DEFAULT 'misc'"); } catch {}
    await d.execute('CREATE INDEX IF NOT EXISTS idx_app_log_scope ON app_log(scope)');
    await d.execute(
      'CREATE TABLE IF NOT EXISTS sim_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, days INTEGER, target_pct REAL, seed INTEGER, from_zero INTEGER DEFAULT 0, total_reviews INTEGER, mature_cards INTEGER, mature_pct REAL, summary TEXT)'
    );
    await d.execute('CREATE INDEX IF NOT EXISTS idx_sim_runs_ts ON sim_runs(ts)');
    console.warn('[app-log] tables rebuilt');
  } catch (e2) {
    console.warn('[app-log] resetAndReload failed:', e2);
  }
}

/** 刪除超過保留天數的記錄。LOG-SCOPE1：error 強制保留 90 天（無視保留天數＋總開關）。
 * 保留天數 0＝不記錄：非 error 全清（開關關了就不留），error 照 90 天。回傳刪除筆數。 */
export async function pruneLogs() {
  if (noBackend()) return 0;   // WEB-DEMO：記憶體日誌不清理
  const ERROR_KEEP_MS = 90 * 86400000;
  try {
    const d = await getDb();
    let n = 0;
    if (!enabled || retentionDays <= 0) {
      const a = await d.execute("DELETE FROM app_log WHERE level != 'error'");
      n += (a?.rowsAffected ?? 0);
    } else {
      const cutoff = Date.now() - retentionDays * 86400000;
      const a = await d.execute("DELETE FROM app_log WHERE level != 'error' AND ts < ?", [cutoff]);
      n += (a?.rowsAffected ?? 0);
    }
    const errCutoff = Date.now() - ERROR_KEEP_MS;
    try {
      const e = await d.execute("DELETE FROM app_log WHERE level = 'error' AND ts < ?", [errCutoff]);
      n += (e?.rowsAffected ?? 0);
    } catch {}
    if (enabled && retentionDays > 0) {
      const b = await d.execute('DELETE FROM sim_runs WHERE ts < ?', [Date.now() - retentionDays * 86400000]);
      n += (b?.rowsAffected ?? 0);
    }
    return n;
  } catch (e) {
    console.warn('[app-log] prune 失敗:', e);
    return 0;
  }
}

// ─── 操作日誌查詢 ───

export async function fetchLogs({ limit = 200, offset = 0, level = null, search = null, scope = null } = {}) {
  if (noBackend()) {   // WEB-DEMO：記憶體過濾（level/scope/search/limit/offset 語意對齊 SQL 版）
    let rows = demoLogs;
    if (level) rows = rows.filter((r) => r.level === level);
    if (scope) rows = rows.filter((r) => (r.scope || 'misc') === scope);
    if (search) rows = rows.filter((r) => String(r.message).includes(search));
    return rows.slice(offset, offset + limit).map((r) => ({ ...r }));
  }
  try {
    const d = await getDb();
    const where = [];
    const params = [];
    if (level) { where.push('level = ?'); params.push(level); }
    if (scope) { where.push('scope = ?'); params.push(scope); }
    if (search) { where.push('message LIKE ?'); params.push(`%${search}%`); }
    const suffix = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const run = (cols) => d.select(
      `SELECT ${cols} FROM app_log${suffix} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    try {
      return await run('id, ts, level, scope, message');
    } catch (_) {
      // 舊庫尚無 scope 欄：退三欄，scope 補 misc（只影響分類顯示，不丟訊息）
      const rows = await run('id, ts, level, message');
      return rows.map((r) => ({ ...r, scope: 'misc' }));
    }
  } catch (e) {
    console.warn('[app-log] fetch 失敗:', e);
    return [];
  }
}

export async function countLogs({ scope = null } = {}) {
  if (noBackend()) {
    if (!scope) return demoLogs.length;   // WEB-DEMO
    return demoLogs.filter((r) => (r.scope || 'misc') === scope).length;
  }
  try {
    const d = await getDb();
    try {
      const r = scope
        ? await d.select('SELECT count(*) n FROM app_log WHERE scope = ?', [scope])
        : await d.select('SELECT count(*) n FROM app_log');
      return r?.[0]?.n ?? 0;
    } catch (_) {
      const r = await d.select('SELECT count(*) n FROM app_log');
      return r?.[0]?.n ?? 0;
    }
  } catch { return 0; }
}

// ─── 模擬歷史 (CLI 每次模擬結束寫入; 下次模擬不會刪除) ───

export async function addSimRun(entry) {
  if (noBackend()) {   // WEB-DEMO：只保留最新一筆（對齊 SQL 版先 DELETE 語意）
    demoSimRuns.length = 0;
    demoSimRuns.push({
      id: 1, ts: Date.now(), kind: entry.kind || 'simulate',
      days: entry.days ?? null, target_pct: entry.targetPct ?? null,
      seed: entry.seed ?? null, from_zero: entry.fromZero ? 1 : 0,
      total_reviews: entry.totalReviews ?? null, mature_cards: entry.matureCards ?? null,
      mature_pct: entry.maturePct ?? null, summary: entry.summary ?? null,
    });
    return;
  }
  if (!enabled || retentionDays <= 0) return;
  try {
    const d = await getDb();
    // 模擬可簡單再生, 只保留最新一筆
    await d.execute('DELETE FROM sim_runs');
    await d.execute(
      'INSERT INTO sim_runs (ts, kind, days, target_pct, seed, from_zero, total_reviews, mature_cards, mature_pct, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [Date.now(), entry.kind || 'simulate', entry.days ?? null, entry.targetPct ?? null,
       entry.seed ?? null, entry.fromZero ? 1 : 0, entry.totalReviews ?? null,
       entry.matureCards ?? null, entry.maturePct ?? null, entry.summary ?? null]
    );
  } catch (e) {
    console.warn('[app-log] addSimRun 失敗:', e);
  }
}

export async function fetchSimRuns({ limit = 100 } = {}) {
  if (noBackend()) return demoSimRuns.slice(0, limit).map((r) => ({ ...r }));   // WEB-DEMO
  try {
    const d = await getDb();
    return await d.select('SELECT id, ts, kind, days, target_pct, seed, from_zero, total_reviews, mature_cards, mature_pct, summary FROM sim_runs ORDER BY id DESC LIMIT ?', [limit]);
  } catch (e) {
    console.warn('[app-log] fetchSimRuns 失敗:', e);
    return [];
  }
}
