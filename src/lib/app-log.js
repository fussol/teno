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

// ─── WEB-DEMO（2026-09-08 使用者裁示：網頁版內建示範資料）───
// 無 Tauri 後端時：寫入走記憶體、查詢回種子，不碰 plugin-sql。實機零影響。
const noBackend = () => typeof window !== 'undefined' && typeof window.__TAURI__?.core !== 'object';
let demoLogSeq = -1;
const demoLogs = [
  { id: -1, ts: Date.now() - 5 * 60000, level: 'log', message: '展示模式啟動：載入 36 個示範單字' },
  { id: -2, ts: Date.now() - 42 * 60000, level: 'log', message: '複習完成：GRE 核心 8 張（Good 6 / Again 2）' },
  { id: -3, ts: Date.now() - 3 * 3600000, level: 'log', message: '自動補齊：pos-Cambridge 為 3 個單字補上詞性' },
  { id: -4, ts: Date.now() - 5 * 3600000, level: 'log', message: '匯入示範字庫：托福 12 詞' },
  { id: -5, ts: Date.now() - 26 * 3600000, level: 'warn', message: 'OCR 引擎忙碌中，重試第 1 次' },
  { id: -6, ts: Date.now() - 30 * 3600000, level: 'log', message: '測驗完成：拼寫 10 題答對 7 題' },
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

export function logToDb(level, msg) {
  if (!ready || !enabled) return;
  if (noBackend()) {   // WEB-DEMO：直接進記憶體，不經 flush/DB
    demoLogs.unshift({ id: demoLogSeq--, ts: Date.now(), level: String(level || 'log'), message: String(msg || '') });
    if (demoLogs.length > 200) demoLogs.length = 200;
    return;
  }
  queue.push([Date.now(), String(level || 'log'), String(msg || '')]);
  if (queue.length >= MAX_BATCH) { flush(); return; }
  if (!timer) timer = setTimeout(flush, 2000);
}

async function flush() {
  timer = null;
  if (noBackend()) {   // WEB-DEMO：佇列直接併入記憶體日誌
    const batch = queue.splice(0, queue.length);
    for (const [ts, level, message] of batch) demoLogs.unshift({ id: demoLogSeq--, ts, level, message });
    if (demoLogs.length > 200) demoLogs.length = 200;
    return;
  }
  if (!enabled) return;
  const batch = queue.splice(0, queue.length);
  if (!batch.length) return;
  try {
    const d = await getDb();
    const values = batch.map(() => '(?, ?, ?)').join(',');
    await d.execute(`INSERT INTO app_log (ts, level, message) VALUES ${values}`, batch.flat());
  } catch (e) {
    // 失敗一律回補並重新排程, 避免批次被靜默丟棄或永久擱置
    queue.unshift(...batch);
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
      'CREATE TABLE IF NOT EXISTS app_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL DEFAULT \'log\', message TEXT NOT NULL)'
    );
    await d.execute('CREATE INDEX IF NOT EXISTS idx_app_log_ts ON app_log(ts)');
    await d.execute(
      'CREATE TABLE IF NOT EXISTS sim_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, days INTEGER, target_pct REAL, seed INTEGER, from_zero INTEGER DEFAULT 0, total_reviews INTEGER, mature_cards INTEGER, mature_pct REAL, summary TEXT)'
    );
    await d.execute('CREATE INDEX IF NOT EXISTS idx_sim_runs_ts ON sim_runs(ts)');
    console.warn('[app-log] tables rebuilt');
  } catch (e2) {
    console.warn('[app-log] resetAndReload failed:', e2);
  }
}

/** 刪除超過保留天數的記錄。 */
export async function pruneLogs() {
  if (noBackend()) return 0;   // WEB-DEMO：記憶體日誌不清理
  if (!enabled || retentionDays <= 0) return 0;
  try {
    const d = await getDb();
    const cutoff = Date.now() - retentionDays * 86400000;
    const a = await d.execute('DELETE FROM app_log WHERE ts < ?', [cutoff]);
    const b = await d.execute('DELETE FROM sim_runs WHERE ts < ?', [cutoff]);
    return (a?.rowsAffected ?? 0) + (b?.rowsAffected ?? 0);
  } catch (e) {
    console.warn('[app-log] prune 失敗:', e);
    return 0;
  }
}

// ─── 操作日誌查詢 ───

export async function fetchLogs({ limit = 200, offset = 0, level = null, search = null } = {}) {
  if (noBackend()) {   // WEB-DEMO：記憶體過濾（level/search/limit/offset 語意對齊 SQL 版）
    let rows = demoLogs;
    if (level) rows = rows.filter((r) => r.level === level);
    if (search) rows = rows.filter((r) => String(r.message).includes(search));
    return rows.slice(offset, offset + limit).map((r) => ({ ...r }));
  }
  try {
    const d = await getDb();
    let sql = 'SELECT id, ts, level, message FROM app_log';
    const where = [];
    const params = [];
    if (level) { where.push('level = ?'); params.push(level); }
    if (search) { where.push('message LIKE ?'); params.push(`%${search}%`); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return await d.select(sql, params);
  } catch (e) {
    console.warn('[app-log] fetch 失敗:', e);
    return [];
  }
}

export async function countLogs() {
  if (noBackend()) return demoLogs.length;   // WEB-DEMO
  try {
    const d = await getDb();
    const r = await d.select('SELECT count(*) n FROM app_log');
    return r?.[0]?.n ?? 0;
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
