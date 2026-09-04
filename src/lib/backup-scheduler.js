import { getDbMtime, backupDb, pruneBackups } from './api.js'

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

// D18：啟動時把 lastBackupMtime 設為現行 DB mtime，使首個 tick 僅在「本 session 有變更」時才備份，
// 不再每次啟動都做冗余備份覆蓋有差異的舊備份。無法讀取時維持 0（退回首 tick 即備份的舊行為）。
async function seedLastBackupMtime() {
  try {
    const { checkpoint } = await import('./db.js');
    await checkpoint();
    const mtime = await getDbMtime();
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
    const { checkpoint } = await import('./db.js');
    await checkpoint();
    const mtime = await getDbMtime();
    if (mtime <= lastBackupMtime) return;
    await backupDb();
    const { keepMax } = await readCfg();
    await pruneBackups(keepMax);
    lastBackupMtime = mtime;
  } catch (e) {
    console.warn('[auto-backup]', e);
  } finally {
    _ticking = false;                // G30: 釋放重入鎖，下一 tick 正常
  }
}
