import { session, state, intervals, e, ensureSession, ensureQueue, mount, getCounts, lastCorrect, mcOptions } from '../engine/session-mc-utils.js';

import { splitFieldsHtml, fmtExample } from '../lib/svg.js';
import { bindSpeakClick } from '../lib/tts.js';

export function render(s) {
  ensureSession(s.state);
  if (!ensureQueue(s.state.reviewDeckFilter, s.state)) return renderEmpty(s);
  return renderCard(s);
}

function renderEmpty(s) {
  if (!session) return '<div class="study-wrap" style="justify-content:center"><p style="color:var(--text-tertiary)">載入中…</p></div>';
  const reviewed = session?.results?.length || 0;
  const elapsed = session?.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const againCount = session?.results?.filter(r => r.rating === 0).length || 0;
  const buried = s?.state?.buriedMc?.size || 0;
  const pending = session?.pendingIntradayInfo ?? session?.pendingLearningToday?.();
  console.log('[empty] completion rendered. reviewed=', session?.results?.length, 'pendingIntraday=', JSON.stringify(pending), 'intraday=', session?.intradayLearning?.length, 'main=', session?.mainQueue?.length);

  const pendingMsg = pending
    ? `<p style="color:var(--text-tertiary);margin:0;font-size:13px">${pending.count} 張學習中卡片尚未到期，最早約 ${pending.nextDueSecs >= 60 ? Math.ceil(pending.nextDueSecs / 60) + ' 分鐘' : pending.nextDueSecs + ' 秒'} 後可複習</p>`
    : '<p style="color:var(--text-secondary);margin:0">今天學習完成</p>';

  return `<div class="study-wrap" style="justify-content:center;padding-bottom:40px">
    <div class="study-card" style="max-width:480px;padding:40px 32px;text-align:center">
      <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--green)" stroke-width="2" style="margin-bottom:8px"><path d="M20 6 9 17l-5-5"/></svg>
      <h2 style="color:var(--text-primary);margin:0 0 4px;font-size:22px">多選完成！</h2>
      ${pendingMsg}
      <div style="display:flex;gap:24px;margin-top:16px;justify-content:center">
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--text-primary);font-family:var(--mono);font-feature-settings:'tnum'">${reviewed}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">張卡片</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--text-primary);font-family:var(--mono);font-feature-settings:'tnum'">${mins}:${String(secs).padStart(2,'0')}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">用時</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:24px;font-weight:700;color:var(--text-primary);font-family:var(--mono);font-feature-settings:'tnum'">${againCount}</div>
          <div style="font-size:11px;color:var(--text-tertiary)">失誤</div>
        </div>
      </div>
      ${buried > 0 ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${buried} 張卡片已被 bury</div>` : ''}
      <button class="btn" data-goto="dashboard" style="margin-top:8px">回首頁</button>
    </div>
  </div>`;
}

function renderCard(s) {
  if (!session?.current) return renderEmpty(s);
  const w = session.current.word;
  const cnt = getCounts();

  if (state === 'QUESTION') {
    return renderFront(w, cnt);
  }
  return renderBack(w, cnt);
}

function renderFront(w, cnt) {
  return `<div class="study-wrap">
    <div class="study-progress">
      <span class="study-counts">
        <span class="study-count-new">${cnt.newCount??0}新</span>
        <span class="study-count-learn">${cnt.learnCount??0}學</span>
        <span class="study-count-review">${cnt.reviewCount??0}複</span>
      </span>
    </div>
    <div class="study-card">
      <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:4px;font-weight:500">請選擇正確的英文</div>
      ${splitFieldsHtml(w.pos, w.definition) || `<div class="study-def" style="font-size:24px;font-weight:700;color:var(--text-primary)">${e(w.definition || '(無定義)')}</div>
      ${w.pos ? `<div class="study-pos" style="margin-top:8px">${e(w.pos)}</div>` : ''}`}
      <div class="study-options">
        ${mcOptions.map((opt, i) => `
          <button class="study-opt" data-opt-index="${i}">
            <span class="study-opt-key">${i + 1}</span>
            <span class="study-opt-text">${e(opt)}</span>
          </button>
        `).join('')}
      </div>
    </div>
  </div>`;
}

function renderBack(w, cnt) {
  return `<div class="study-wrap">
    <div class="study-progress">
      <span class="study-counts">
        <span class="study-count-new">${cnt.newCount??0}新</span>
        <span class="study-count-learn">${cnt.learnCount??0}學</span>
        <span class="study-count-review">${cnt.reviewCount??0}複</span>
      </span>
      <button id="undoBtn" class="study-undo-btn" title="Ctrl+Z 復原上一張">↩ 復原</button>
    </div>
    <div class="study-result ${lastCorrect ? 'study-correct' : 'study-wrong'}">
      ${lastCorrect ? '✓ 正確' : '✗ 錯誤'}
    </div>
    <div class="study-card">
      <div class="study-word-row">
        <div class="study-word">${e(w.word)}</div>
      </div>
      ${splitFieldsHtml(w.pos, w.definition) || `<div class="study-def">${e(w.definition || '(無定義)')}</div>`}
      ${w.example ? `<div class="study-example">${fmtExample(w.example)}</div>` : ''}
      ${w.pron ? `<div class="study-pron">${e(w.pron)}</div>` : ''}
      ${w.related?.length ? `<div class="study-chips" style="margin-top:10px"><span class="study-chips-label">相似</span>${w.related.map(r => `<span class="chip-accent">${e(r)}</span>`).join('')}</div>` : ''}
      ${w.forms?.length ? `<div class="study-chips"><span class="study-chips-label">變化</span>${w.forms.map(f => `<span class="chip-subtle">${e(f)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="study-buttons">
      ${[[0,'Again','var(--red)'],[1,'Hard','var(--orange)'],[2,'Good','var(--green)'],[3,'Easy','var(--cyan)']].map(([r,lbl,c])=>`
        <button data-r4="${r}" class="study-btn" style="background:${c}">
          <span class="study-btn-lbl">${lbl}</span>
          <span class="study-btn-time">${intervals[r]||''}</span>
        </button>
      `).join('')}
    </div>

  </div>`;
}

export function onMount(s) {
  mount(s, () => rip(s));
  bindSpeakClick(document.getElementById('pageContainer'), () => s.state);
}

function rip(s) {
  const c = document.getElementById('pageContainer');
  if (c) { c.innerHTML = render(s); onMount(s); }
}
