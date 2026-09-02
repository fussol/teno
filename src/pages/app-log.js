// ═══════════════════════════════════════════════════════════════
// 操作日誌 — 查看操作記錄 + 模擬歷史 (隔離 DB: app-log.db)
// ═══════════════════════════════════════════════════════════════
import { icon } from '../lib/svg.js';
import { fetchLogs, fetchSimRuns, countLogs, getRetentionDays } from '../lib/app-log.js';

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
