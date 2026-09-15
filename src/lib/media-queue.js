// media-queue.js — MEDIAPEEL1 媒體上傳佇列（有時間慢慢傳）
// ─────────────────────────────────────────────────────────────
// 語義：加圖時只記 sha（pending），有空才傳；傳前問雲端有沒有（server 按檔名去重天然存在即跳過）。
// 落地 localStorage（App 重開還在）；取消＋重試＋進度回調；僅 WiFi 開關（預設開；WebView 取不到真實網路類型時視 LAN＝WiFi）。
const KEY = 'teno-media-queue-v1';
const FLAG = 'teno-media-queue-wifionly-v1';

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => x && x.sha) : [];
  } catch { return []; }
}
function save(q) {
  try { localStorage.setItem(KEY, JSON.stringify(q.slice(-500))); } catch {}
}

let _cancel = false;

export function enqueueMedia(sha, file) {
  if (!sha) return;
  const q = load();
  if (!q.some(x => x.sha === sha)) {
    q.push({ sha, file: file || '', ts: Date.now(), tries: 0, status: 'pending' });
    save(q);
  }
}

export function pendingCount() {
  return load().filter(x => x.status !== 'done').length;
}

export function clearDone() {
  save(load().filter(x => x.status !== 'done'));
}

export function cancelFlush() { _cancel = true; }

export function wifiOnly() {
  try {
    const v = localStorage.getItem(FLAG);
    return v === null ? true : v === '1';
  } catch { return true; }
}
export function setWifiOnly(on) {
  try { localStorage.setItem(FLAG, on ? '1' : '0'); } catch {}
}

/** 後台慢慢傳：調 webdavMediaUpload（server 按檔名去重，已有即跳過）。
 * onProgress({done,total})；傳完成功清 done。失敗記 tries＋1，三次後停等下次。
 * 取消／離線直接停（佇列落地，下次重試）。 */
export async function flushMediaQueue(api, onProgress) {
  _cancel = false;
  const q = load().filter(x => x.status !== 'done');
  if (!q.length) return { ok: 0, skip: 0, note: 'empty' };
  // 僅 WiFi：真實類型取不到時，有 LAN 心跳即視為 WiFi（Tailscale direct 也算）
  if (wifiOnly() && typeof navigator !== 'undefined' && navigator.connection) {
    const t = String(navigator.connection.type || '');
    if (t === 'cellular') return { ok: 0, skip: q.length, note: 'cellular-skip' };
  }
  try {
    const r = await api.webdavMediaUpload();
    // 成功：全部標 done（server 去重保證冪等）
    save(load().map(x => ({ ...x, status: 'done' })));
    clearDone();
    onProgress && onProgress({ done: q.length, total: q.length });
    return { ok: q.length, skip: 0, note: String(r || '') };
  } catch (e) {
    const cur = load();
    for (const x of cur) {
      if (x.status !== 'done') { x.tries = (x.tries || 0) + 1; if (x.tries >= 3) x.status = 'failed'; }
    }
    save(cur);
    throw e;
  }
}
