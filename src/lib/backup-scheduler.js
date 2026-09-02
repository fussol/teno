import { getDbMtime, backupDb, pruneBackups } from './api.js'

let timer = null;
let lastBackupMtime = 0;
let _ticking = false;   // G30: tick 重入保護 — 重複備份 race 防護（前一個 backupDb await 未完，下一個 tick 觸發時跳過）
const INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKUPS = 100;

export function startAutoBackup() {
  if (timer) return;
  seedLastBackupMtime();   // D18: 啟動以目前 DB mtime 定基準，避免每次啟動都備份洗掉有差異舊檔
  tick();
  timer = setInterval(tick, INTERVAL_MS);
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
    await pruneBackups(MAX_BACKUPS);
    lastBackupMtime = mtime;
  } catch (e) {
    console.warn('[auto-backup]', e);
  } finally {
    _ticking = false;                // G30: 釋放重入鎖，下一 tick 正常
  }
}
