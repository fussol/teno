// settings/backup.js — 危險匯出/匯入、備份清單/還原/匯出/刪除/日誌回放（P4 Step3 純搬移）
// 原 settings.js 頂層 131–361 區塊；內部 helper（restoreBackup 等）維持模組私有
import { backupDb, deleteBackup as apiDeleteBackup, exportBackupData as apiExportBackupData, exportBackupDialog as apiExportBackup, exportDbData, exportDbDialog, exportDbToDownloads, importAppLogText as apiImportAppLogText, importDbDialog, listBackups, resetAppLogDb as apiResetAppLogDb, restoreBackup as apiRestoreBackup, writeDbBytes } from '../../lib/api.js';
import { downloadBlobFromArray, isAndroid, isWeb, pickFile } from '../../lib/platform.js';
import { icon } from '../../lib/svg.js';
import { toast } from '../../lib/toast.js';
import { escapeHtml, escapeAttr } from './_shared.js';
import { addAudit, checkpoint, closeDB, initDB, setSetting } from '../../lib/db.js';

export async function runExportDb() {
  try {
    try {
      // H3（2026-09-01 顧問報告）：humanEvents 上限 50000 事件全量塞 DB 曾實測 700KB+ 累積。
      // 備份只帶最近 500 筆（90 天內、分析統計足夠），體積歸零、還原端照吃。
      const ev = localStorage.getItem('humanEvents');
      if (ev) {
        try {
          const arr = JSON.parse(ev);
          if (Array.isArray(arr)) {
            const trimmed = JSON.stringify(arr.slice(-500));
            await setSetting('_backup_humanEvents', trimmed);
          } else {
            await setSetting('_backup_humanEvents', ev);
          }
        } catch (_) { await setSetting('_backup_humanEvents', ev); }
      }
      const pf = localStorage.getItem('humanProfile');
      if (pf) await setSetting('_backup_humanProfile', pf);
    } catch (_) {}
    await checkpoint();
    if (isAndroid) {
      // EXPORTBIG1: 大檔直寫優先（零 IPC 資料；回傳含大小）；失敗才退回舊 IPC 路（小檔用）
      try {
        const msg = await exportDbToDownloads('teno-backup.db');
        await addAudit('export-db', `匯出 .db 備份 (Android 直寫) ${msg}`).catch(() => {});
        toast(`資料庫已匯出到 下載/Teno（${msg}）`, 'toast-success');
      } catch (e2) {
        const data = await exportDbData();
        downloadBlobFromArray(data, 'teno-backup.db', 'application/octet-stream');
        await addAudit('export-db', '匯出 .db 備份 (Android 舊路)').catch(() => {});
        toast('資料庫已匯出（僅 teno.db）', 'toast-success');
      }
    } else if (isWeb) {
      const data = await exportDbData();
      downloadBlobFromArray(data, 'teno-backup.db', 'application/octet-stream');
      await addAudit('export-db', '匯出 .db（網站版下載）').catch(() => {});
      toast('資料庫已匯出（瀏覽器下載）', 'toast-success');
    } else {
      const path = await exportDbDialog();
      await addAudit('export-db', `匯出 → ${path}`).catch(() => {});
      toast(`資料庫已匯出 → ${path}`, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

export async function runImportDb() {
  if (!confirm('匯入備份將取代所有現有資料（會自動備份原資料庫），確定繼續？')) return;
  try {
    const { checkpointAppLog, closeAppLog } = await import('../../lib/app-log.js');
    // 順序（D6）：checkpoint（WAL 合併→備份完整）→ backupDb（安全網）→ flush app-log
    // → 關閉連線（teno.db + app-log.db）→ 匯入覆寫 → reload。
    // 覆寫（write_db_container）同時換 teno.db+app-log.db 並先刪 -wal/-shm，
    // 任何存活連線都會造成髒頁回刷/混合態，故 close 必須全部前於覆寫。
    await checkpoint();
    await backupDb();
    await checkpointAppLog();
    await closeDB();
    await closeAppLog();
    if (isWeb) {
      const f = await pickFile('.db,.sqlite,.sqlite3');
      if (!f) throw '使用者取消';
      await writeDbBytes(new Uint8Array(await f.arrayBuffer()));
    } else {
      await importDbDialog();
    }
    toast('匯入成功，重新載入中…', 'toast-success');
    setTimeout(() => window.location.reload(), 500);
  } catch (e) {
    // 連線可能已關閉 → 重開避免半死狀態（與 restoreBackup catch 同構；
    // app-log 由 getDb() 惰性重連）。取消發生在覆寫前 → 舊檔完好無損。
    try { await initDB(2); } catch (_) {}
    if (e !== '使用者取消') toast('匯入失敗: ' + e, 'toast-error');
  }
}

// ─── 備份管理 ──────────────────────────────────
let _backupsData = null;

export async function showBackups() {
  const el = document.getElementById('backupList');
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  try {
    const list = await listBackups();
    _backupsData = list;
    if (!list || list.length === 0) {
      el.innerHTML = '<div style="padding:8px 0">尚無自動備份</div>';
      el.style.display = 'block';
      return;
    }
    let html = '<div style="margin-top:8px;font-weight:600;color:var(--text-secondary)">自動備份列表</div>';
    for (const b of list) {
      const size = b.size > 1024 * 1024
        ? (b.size / 1024 / 1024).toFixed(1) + ' MB'
        : b.size > 1024 ? Math.round(b.size / 1024) + ' KB' : b.size + ' B';
      const d = new Date(b.timestamp * 1000);
      const dateStr = d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      // LOG-BACKUP1: 增量行——徽標＋筆數，還原走「回放到此」（reset＋逐 patch import）
      const isPatch = b.kind === 'applog-patch';
      const kindTag = isPatch
        ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-weight:700">日誌增量${Number.isFinite(b.rows) ? ` ＋${b.rows}筆` : ''}</span>`
        : `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--bg-hover);color:var(--text-secondary);font-weight:700">主庫全量</span>`;
      const restoreBtn = isPatch
        ? `<button class="btn btn-xs" data-breplay="${escapeAttr(b.filename)}" style="font-size:11px">${icon('clock')} 回放到此</button>`
        : `<button class="btn btn-xs" data-brestore="${escapeAttr(b.filename)}" style="font-size:11px">${icon('rotate')} 還原</button>`;
      html += `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-top:1px solid var(--border-subtle)">
        <span style="flex:1;color:var(--text-primary)">${dateStr} ${kindTag}</span>
        <span class="muted" style="font-size:11px;width:60px">${size}</span>
        ${restoreBtn}
        <button class="btn btn-xs" data-bexport="${escapeAttr(b.filename)}" style="font-size:11px">${icon('save')} 匯出</button>
        <button class="btn btn-xs" data-bdelete="${escapeAttr(b.filename)}" style="font-size:11px;color:var(--red)">${icon('x')}</button>
      </div>`;
    }
    el.innerHTML = html;
    el.style.display = 'block';

    // Attach event listeners
    el.querySelectorAll('[data-brestore]').forEach(btn =>
      btn.addEventListener('click', () => restoreBackup(btn.dataset.brestore, btn)));
    el.querySelectorAll('[data-breplay]').forEach(btn =>
      btn.addEventListener('click', () => replayAppLogTo(btn.dataset.breplay, btn)));
    el.querySelectorAll('[data-bexport]').forEach(btn =>
      btn.addEventListener('click', () => exportBackup(btn.dataset.bexport)));
    el.querySelectorAll('[data-bdelete]').forEach(btn =>
      btn.addEventListener('click', () => deleteBackup(btn.dataset.bdelete)));
  } catch (e) {
    el.innerHTML = '<div style="padding:8px 0;color:var(--red)">讀取備份失敗: ' + escapeHtml(String(e)) + '</div>';
    el.style.display = 'block';
  }
}

async function restoreBackup(filename, btn) {
  if (!confirm('確定要還原此備份？所有現有資料將被取代（會自動備份目前資料庫）。')) return;
  if (btn) btn.disabled = true;
  try {
    const { closeAppLog } = await import('../../lib/app-log.js');
    // 順序：checkpoint（WAL 合併→備份完整）→ backupDb（安全網）→ closeDB + closeAppLog → 還原 → reload
    await checkpoint();
    // Auto-backup current DB first
    await backupDb();
    await closeDB();
    await closeAppLog();
    await apiRestoreBackup(filename);
    toast('還原成功，重新載入中…', 'toast-success');
    setTimeout(() => location.reload(), 500);
  } catch (e) {
    toast('還原失敗: ' + e, 'toast-error');
    // DB 已關閉 → 重開避免半死狀態
    try { await initDB(2); } catch (_) {}
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function exportBackup(filename) {
  try {
    if (isAndroid || isWeb) {
      const data = await apiExportBackupData(filename);
      downloadBlobFromArray(data, filename, 'application/octet-stream');
      toast('備份已匯出', 'toast-success');
    } else {
      const path = await apiExportBackup(filename);
      toast('備份已匯出 → ' + path, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

// LOG-BACKUP1: 備份檔名取 ts（數字比；nanos 19 碼與舊秒級 10 碼混排時字串比會錯）
function backupTsOf(name) {
  const m = /^(?:teno-|applog-)(\d+)(?:\.db|\.patch\.txt)$/.exec(name || '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : -1;
}

// LOG-BACKUP1: 日誌回放——reset 日誌庫後，把「此前全部 patch」按 ts 順序 import。
// import 去重冪等，重跑同一鏈不翻倍。主庫完全不動。
async function replayAppLogTo(filename, btn) {
  if (!confirm('確定要把操作日誌回放到這個時間點？（目前的日誌會被清空後重放；單字主庫完全不受影響）')) return;
  if (btn) btn.disabled = true;
  try {
    const { closeAppLog, checkpointAppLog } = await import('../../lib/app-log.js');
    try { await checkpointAppLog(); } catch (_) {}
    await backupDb(); // 安全網：先備份當下（主庫＋未備增量一起落檔）
    await closeAppLog();
    await apiResetAppLogDb();
    const list = await listBackups();
    const targetTs = backupTsOf(filename);
    const chain = (list || [])
      .filter(b => b.kind === 'applog-patch' && backupTsOf(b.filename) <= targetTs)
      .map(b => b.filename)
      .sort((a, b) => backupTsOf(a) - backupTsOf(b));
    let added = 0, skipped = 0, bad = 0, files = 0;
    for (const f of chain) {
      const data = await apiExportBackupData(f); // Vec<u8>→數字陣列（patch KB 級）
      const text = new TextDecoder('utf-8').decode(new Uint8Array(data));
      const r = await apiImportAppLogText(text);
      added += r.log_added + r.sim_added;
      skipped += r.log_skipped + r.sim_skipped;
      bad += r.bad_lines;
      files += 1;
    }
    toast(`日誌已回放 ${files} 個增量：新增 ${added} 筆（重複 ${skipped}、壞行 ${bad}），重新載入中…`, 'toast-success');
    setTimeout(() => window.location.reload(), 800);
  } catch (e) {
    toast('日誌回放失敗: ' + e, 'toast-error');
    try { await initDB(2); } catch (_) {}
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteBackup(filename) {
  if (!confirm('確定刪除此備份？')) return;
  try {
    await apiDeleteBackup(filename);
    toast('已刪除', 'toast-success');
    showBackups(); // refresh list
  } catch (e) {
    toast('刪除失敗: ' + e, 'toast-error');
  }
}

// ─── 字本管理 ───────────────────────────────────
