import { icon } from '../lib/svg.js';

export function formatSessionTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff <= 0) return new Date(timestamp).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function renderSavedSessions(sessions, mode, maxExamSessions) {
  const filtered = sessions.filter(s => s.mode === mode)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (!filtered.length) {
    return `<div class="exam-saved-list" style="width:260px;flex-shrink:0">
      <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:12px">${icon('clock')} 上次進度</div>
      <div style="font-size:12px;color:var(--text-tertiary);padding:16px;text-align:center;border:1px dashed var(--border);border-radius:var(--r-md)">尚無保存進度<br><span style="font-size:11px">測驗中途退出會自動存檔</span></div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px;text-align:center">最多 ${maxExamSessions} 組</div>
    </div>`;
  }

  return `<div class="exam-saved-list" style="width:260px;flex-shrink:0">
    <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:12px">${icon('clock')} 上次進度</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${filtered.map(s => {
        const pct = s.wordCount > 0 ? Math.min(100, Math.round((s.idx / s.wordCount) * 100)) : 0;
        return `<div class="exam-session-item" data-sid="${s.id}" style="cursor:pointer;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);transition:background-color .15s,border-color .15s,color .15s">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div style="font-size:12px;font-weight:600;color:var(--text-primary)">${formatSessionTime(s.timestamp)}</div>
            <button class="btn btn-sm" data-sdel="${s.id}" style="padding:2px 6px;font-size:11px;color:var(--red);cursor:pointer">${icon('x')}</button>
          </div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">${s.wordCount} 字 · ${s.idx}/${s.wordCount} (${pct}%)</div>
          <div style="font-size:11px;color:var(--text-tertiary)">${s.correct}✓ ${s.wrong}✗</div>
          <div class="study-progress-bar" style="height:4px;margin-top:6px"><div class="study-progress-fill" style="width:${pct}%;height:4px"></div></div>
        </div>`;
      }).join('')}
    </div>
    <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px;text-align:center">最多 ${maxExamSessions} 組 · 點擊項目恢復進度</div>
  </div>`;
}

export function buildSession(e, mode) {
  return {
    id: e.id || `exam_${mode}_${Date.now()}`,
    mode,
    timestamp: Date.now(),
    deckIds: [...e.decks],
    wordIds: e.words.map(w => w.id),
    idx: e.idx,
    correct: e.correct,
    wrong: e.wrong,
    totalTime: e.totalTime,
    wordCount: e.words.length,
    settings: { ...e.settings },
    results: [...(e.results || [])],   // B1: per-word 作答結果序列化（mc/spell 無 results → [] 無害）
  };
}
