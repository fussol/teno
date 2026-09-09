// ═══════════════════════════════════════════════════════════════
// 操作日誌 — 查看操作記錄 + 模擬歷史 (隔離 DB: app-log.db)
// ═══════════════════════════════════════════════════════════════
import { icon } from '../lib/svg.js';
import { fetchLogs, fetchSimRuns, countLogs, getRetentionDays, checkpointAppLog } from '../lib/app-log.js';
import { exportAppLogText, importAppLogText, exportDbBundleData, exportBundleDialog } from '../lib/api.js';
import { isAndroid, downloadBlobFromArray } from '../lib/platform.js';
import { toast } from '../lib/toast.js';

const PAGE = 200;
let _logs = [];
let _sims = [];
let _count = 0;
let _search = '';
let _level = '';
let _loaded = false;

const LEVEL_COLOR = { log: 'var(--text-tertiary)', warn: 'var(--amber)', error: 'var(--red)' };
const KIND_LABEL = { simulate: '模擬', mature: '目標模擬' };

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderSims(sims) {
  if (!sims.length) return '<div style="font-size:12px;color:var(--text-tertiary)">尚無模擬記錄</div>';
  return sims.map(r => {
    const kind = KIND_LABEL[r.kind] || r.kind;
    const pct = r.mature_pct != null ? `${r.mature_pct}%` : '-';
    const target = r.kind === 'mature' ? `目標 ${r.target_pct}% · ` : '';
    return `
      <div style="display:flex;align-items:center;gap:var(--s3);padding:var(--s2) 0;border-bottom:1px solid var(--border);flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-tertiary);min-width:150px;font-family:var(--mono)">${fmtTs(r.ts)}</span>
        <span class="badge" style="background:var(--accent);color:var(--accent-on);padding:2px 8px;border-radius:20px;font-size:11px">${kind}</span>
        <span style="font-size:12px;color:var(--text-secondary)">${target}${r.days ?? '-'} 天</span>
        <span style="font-size:12px;color:var(--text-secondary)">成熟 ${r.mature_cards ?? '-'} (${pct})</span>
        <span style="font-size:12px;color:var(--text-tertiary)">${(r.total_reviews ?? 0).toLocaleString()} 次評分</span>
        ${r.from_zero ? '<span style="font-size:11px;color:var(--orange)">從零</span>' : ''}
        ${r.seed != null ? `<span style="font-size:11px;color:var(--text-tertiary)">seed ${r.seed}</span>` : ''}
      </div>`;
  }).join('');
}

function renderLogs(logs) {
  if (!logs.length) return '<div style="font-size:12px;color:var(--text-tertiary)">尚無操作記錄</div>';
  return logs.map(l => `
    <div style="display:flex;gap:var(--s2);padding:3px 0;font-family:var(--mono);font-size:11px;border-bottom:1px solid var(--border-subtle, var(--border));align-items:baseline">
      <span style="color:var(--text-tertiary);flex-shrink:0;min-width:150px">${fmtTs(l.ts)}</span>
      <span style="color:${LEVEL_COLOR[l.level] || 'var(--text-tertiary)'};flex-shrink:0;min-width:38px;font-weight:700">${l.level}</span>
      <span style="color:var(--text-secondary);word-break:break-all">${escapeHtml(l.message)}</span>
    </div>`).join('');
}

export function render(s) {
  const retention = getRetentionDays();
  return `
    <div class="page-title">${icon('list')} 操作日誌</div>
    <div class="page-subtitle">隔離 DB (app-log.db) · 保留 ${retention > 0 ? retention + ' 天' : '停用'}</div>

    <div class="section">
      <div class="card" style="padding:var(--s4);display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm" id="applogExportTxtBtn">${icon('list')} 匯出操作日誌 (.txt)</button>
        <span style="font-size:11px;color:var(--text-tertiary)">文字檔（app_log＋模擬歷史）</span>
        <button class="btn btn-sm" id="applogImportTxtBtn">${icon('upload')} 匯入操作日誌 (.txt)</button>
        <span style="font-size:11px;color:var(--text-tertiary)">文字檔（去重併入，重複不怕）</span>
        <button class="btn btn-sm" id="applogExportBundleBtn">${icon('save')} 匯出完整備份 (.db)</button>
        <span style="font-size:11px;color:var(--text-tertiary)">捆包（teno.db＋app-log.db，匯入可吃）</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">${icon('chart')} 模擬歷史</div>
      <div class="card" style="padding:var(--s4)">${_sims.length ? renderSims(_sims) : '<div style="font-size:12px;color:var(--text-tertiary)">載入中...</div>'}</div>
    </div>

    <div class="section">
      <div class="section-title">${icon('activity')} 操作記錄 (${_count ? _count.toLocaleString() : '…'} 筆)</div>
      <div class="card" style="padding:var(--s4)">
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s3);flex-wrap:wrap;align-items:center">
          <input id="logSearch" type="text" placeholder="搜尋訊息..." value="${escapeHtml(_search)}"
            style="flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:12px">
          <select id="logLevel" style="padding:6px 8px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:12px">
            <option value="">全部級別</option>
            <option value="log" ${_level === 'log' ? 'selected' : ''}>log</option>
            <option value="warn" ${_level === 'warn' ? 'selected' : ''}>warn</option>
            <option value="error" ${_level === 'error' ? 'selected' : ''}>error</option>
          </select>
          <button class="btn btn-sm" id="logRefresh">${icon('refresh')} 重新整理</button>
          ${_logs.length >= PAGE ? '<button class="btn btn-sm" id="logMore">載入更多</button>' : ''}
        </div>
        <div id="logList" style="max-height:520px;overflow:auto">${_logs.length ? renderLogs(_logs) : '<div style="font-size:12px;color:var(--text-tertiary)">載入中...</div>'}</div>
      </div>
    </div>
  `;
}

let _logGen = 0;   // G29: 併發 guard — 互斥 refresh/load-more，舊請求結果不覆蓋後續操作

export function onMount(s) {
  // A段搬家（自 settings.js runExportAppLog 原樣遷入）：WAL 先合併再讀，
  // Rust 直讀 app-log.db 不走 IPC 大陣列。
  document.getElementById('applogExportTxtBtn')?.addEventListener('click', async () => {
    try {
      await checkpointAppLog().catch(() => {});
      const bytes = await exportAppLogText();
      const fname = `teno-applog-${new Date().toISOString().slice(0, 10)}.txt`;
      if (isAndroid) {
        downloadBlobFromArray(bytes, fname, 'text/plain');
      } else {
        const blob = new Blob([new Uint8Array(bytes)], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fname; a.click();
        URL.revokeObjectURL(url);
      }
      toast('操作日誌已匯出（文字檔）', 'toast-success');
    } catch (e) {
      toast('操作日誌匯出失敗: ' + e, 'toast-error');
    }
  });
  // C段：文字檔匯入（匯出格式逆操作；去重併入＋壞行跳過，後端回傳計數）。
  // 先 closeAppLog 斷開 plugin-sql 連線再寫（避 WAL 競態），匯完重載列表。
  document.getElementById('applogImportTxtBtn')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.txt,text/plain';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        if (f.size > 50 * 1024 * 1024) { toast('檔案過大（>50MB），拒絕匯入', 'toast-error'); return; }
        const text = await f.text();
        const { closeAppLog } = await import('../lib/app-log.js');
        await checkpointAppLog().catch(() => {});
        await closeAppLog().catch(() => {});
        const r = await importAppLogText(text);
        toast(`匯入完成：日誌＋${r.log_added}／已存在${r.log_skipped}，模擬＋${r.sim_added}／已存在${r.sim_skipped}${r.bad_lines ? `，壞行跳過${r.bad_lines}` : ''}`, 'toast-success');
        _loaded = false;
        renderInPlace(s);
      } catch (e) {
        toast('操作日誌匯入失敗: ' + e, 'toast-error');
      }
    };
    inp.click();
  });
  // B段：捆包匯出（TENOC 容器；雙 checkpoint＋50MB 守門；匯入走既有
  // importDbDialog，本來就吃容器，零改動）。
  document.getElementById('applogExportBundleBtn')?.addEventListener('click', async () => {
    try {
      const { checkpoint } = await import('../lib/db.js');
      await checkpoint().catch(() => {});
      await checkpointAppLog().catch(() => {});
      if (isAndroid) {
        const bytes = await exportDbBundleData();
        const mb = bytes.length / 1048576;
        if (mb > 50 && !confirm(`完整備份約 ${mb.toFixed(1)}MB，超過 50MB 在手機上可能記憶體不足，確定繼續？`)) return;
        const fname = `teno-full-backup-${new Date().toISOString().slice(0, 10)}.db`;
        downloadBlobFromArray(bytes, fname, 'application/octet-stream');
        toast('完整備份已匯出（含操作日誌）', 'toast-success');
      } else {
        const path = await exportBundleDialog();
        toast(`完整備份已匯出 → ${path}`, 'toast-success');
      }
    } catch (e) {
      if (e !== '使用者取消') toast('完整備份匯出失敗: ' + e, 'toast-error');
    }
  });
  const refresh = async () => {
    const myGen = ++_logGen;
    _search = document.getElementById('logSearch')?.value || '';
    _level = document.getElementById('logLevel')?.value || '';
    const [logs, sims, count] = await Promise.all([
      fetchLogs({ limit: PAGE, level: _level || null, search: _search || null }),
      fetchSimRuns({ limit: 50 }),
      countLogs(),
    ]);
    if (myGen !== _logGen) return;   // 已被後續 refresh/load-more 取代 → 丟棄
    _logs = logs;
    _sims = sims;
    _count = count;
    renderInPlace(s);
  };
  document.getElementById('logSearch')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });
  document.getElementById('logLevel')?.addEventListener('change', refresh);
  document.getElementById('logRefresh')?.addEventListener('click', refresh);
  document.getElementById('logMore')?.addEventListener('click', async () => {
    const myGen = ++_logGen;          // load-more 搶最新 gen，使在途 refresh 失效
    const more = await fetchLogs({ limit: PAGE, offset: _logs.length, level: _level || null, search: _search || null });
    if (myGen !== _logGen) return;
    _logs = [..._logs, ...more];
    renderInPlace(s);
  });
  if (!_loaded) { _loaded = true; refresh(); }
}

function renderInPlace(s) {
  const c = document.getElementById('pageContainer');
  if (c) { c.innerHTML = render(s); onMount(s); }
}
