import { getDbMtime, getAppLogMtime, backupDb, pruneBackups, webdavUpload, webdavPatchUpload, webdavMediaUpload } from './api.js'
import { pendingCount, flushMediaQueue } from './media-queue.js'

let timer = null;
let lastBackupMtime = 0;
let _ticking = false;   // G30: tick 重入保護 — 重複備份 race 防護（前一個 backupDb await 未完，下一個 tick 觸發時跳過）
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 預設一天一次（2026-09-04 使用者裁示）
const DEFAULT_KEEP_MAX = 7;                       // 預設最多保留 7 個（超出刪最舊）

// 使用者可調（devMode 設定頁）：backupIntervalH（小時）、backupKeepMax（個數）
async function readCfg() {
  let intervalMs = DEFAULT_INTERVAL_MS;
  let keepMax = DEFAULT_KEEP_MAX;
  try {
    const { getSetting } = await import('./db.js');
    const h = await getSetting('backupIntervalH');
    const n = await getSetting('backupKeepMax');
    if (Number.isFinite(h) && h >= 1) intervalMs = h * 60 * 60 * 1000;
    if (Number.isFinite(n) && n >= 1) keepMax = n;
  } catch (_) {}
  return { intervalMs, keepMax };
}

export async function startAutoBackup() {
  stopAutoBackup();
  const { intervalMs } = await readCfg();
  seedLastBackupMtime();   // D18: 啟動以目前 DB mtime 定基準，避免每次啟動都備份洗掉有差異舊檔
  tick();
  timer = setInterval(tick, intervalMs);
  window.addEventListener('beforeunload', stopAutoBackup);
}

// LOG-BACKUP1: 兩庫 max——任一有變更都備份（日誌自己也會長大）
async function currentMaxMtime() {
  const mtime = await getDbMtime();
  let logMtime = 0;
  try { logMtime = await getAppLogMtime(); } catch (_) {}
  return Math.max(mtime, logMtime);
}

// D18：啟動時把 lastBackupMtime 設為現行 DB mtime，使首個 tick 僅在「本 session 有變更」時才備份、
// 不再每次啟動都做冗余備份覆蓋有差異的舊備份。無法讀取時維持 0（退回首 tick 即備份的舊行為）。
async function seedLastBackupMtime() {
  try {
    const { checkpoint } = await import('./db.js');
    await checkpoint();
    try {
      const { checkpointAppLog } = await import('./app-log.js');
      await checkpointAppLog();
    } catch (_) {}
    const mtime = await currentMaxMtime();
    if (mtime > 0) lastBackupMtime = mtime;
  } catch (e) {
    console.warn('[auto-backup] seed mtime failed:', e);
  }
}

export function stopAutoBackup() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  window.removeEventListener('beforeunload', stopAutoBackup);
}

async function tick() {
  if (_ticking) return;              // G30: 重入保護 — 前一輪備份未完，跳過本 tick
  _ticking = true;
  try {
    // ponytail: checkpoint flushes WAL so mtime reflects real changes
    // LOG-BACKUP1: 雙 checkpoint（主庫＋日誌庫），mtime 取兩庫 max
    const { checkpoint } = await import('./db.js');
    await checkpoint();
    try {
      const { checkpointAppLog } = await import('./app-log.js');
      await checkpointAppLog();
    } catch (_) {}
    const mtime = await currentMaxMtime();
    // 本地備份（D18 seed：首 tick 僅變更才備份；無變更不再早退 — 同步有自己狀態）
    if (mtime > lastBackupMtime) {
      await backupDb();
      const { keepMax } = await readCfg();
      await pruneBackups(keepMax);
      lastBackupMtime = mtime;
    }
    // 雲端同步（SYNC-STATE1）：獨立持久化狀態，成功才推進、失敗下 tick 重試、重啟讀回欠帳即清
    await syncTick(mtime);
  } catch (e) {
    console.warn('[auto-backup]', e);
  } finally {
    _ticking = false;                // G30: 釋放重入鎖，下一 tick 正常
  }
}

// SYNC-STATE1：自動同步自己的狀態（不與本地備份耦合）。
// webdavLastSyncMtime 只在成功時寫入 DB → 失敗下一 tick 必重試；
// 啟動讀回持久值 → 上個 session 的欠帳本 session 首個 tick 即清（0＝從未同步）。
let _syncSeeded = false;
let _lastSyncMtime = 0;

async function syncTick(mtime) {
  try {
    const { getSetting, setSetting } = await import('./db.js');
    const flag = await getSetting('webdavAutoUpload');
    if (!(flag === 1 || flag === true || flag === '1')) return;
    if (!_syncSeeded) {
      _lastSyncMtime = Number(await getSetting('webdavLastSyncMtime')) || 0;
      _syncSeeded = true;
    }
    const due = mtime > _lastSyncMtime;
    let pend = 0;
    try { pend = pendingCount(); } catch (_) {}
    if (!due && !pend) return;
    let msg = '';
    if (due) {
      // 差量優先（同手動鈕）；NO_BASE/PAGE_SIZE/PATCH_TOO_BIG 等任一失敗落整包
      try { msg = await webdavPatchUpload(); }
      catch (_) { msg = await webdavUpload(); }
      await setSetting('webdavLastSyncMtime', String(mtime));   // 成功才推進
      await setSetting('webdavLastSyncAt', String(Date.now()));
      await setSetting('webdavLastSyncErr', '');
    }
    console.log('[auto-sync]', msg || 'media-only');
    // 媒體佇列順帶（兌現 UI「一併帶」；佇列空／僅 WiFi 停機由 flush 內自理；
    // 媒體失敗不作廢已完成的 DB 同步）
    if (pend) {
      try { await flushMediaQueue({ webdavMediaUpload }); }
      catch (me) { console.warn('[auto-sync] media:', me?.message || me); }
    }
  } catch (e) {
    const err = String(e?.message || e).slice(0, 300);
    try {
      const { setSetting } = await import('./db.js');
      await setSetting('webdavLastSyncErr', err);
    } catch (_) {}
    console.warn('[auto-sync] 失敗（下個 tick 重試）:', err);
  }
}
