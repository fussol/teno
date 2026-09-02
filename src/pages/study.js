import { icon } from '../lib/svg.js';

const MODES = [
  {
    id: 'study-v4', label: '翻卡學習', icon: 'galleryHorizontalEnd',
    desc: '看單字回想定義，FSRS 排程複習',
    getDue: s => s.state.dueCount,
    color: 'var(--cyan)',
  },
  {
    id: 'study-mc', label: '多選學習', icon: 'form',
    desc: '四選一選擇題，記憶單字釋義',
    getDue: s => s.state.dueCountMc,
    color: 'var(--green)',
  },
  {
    id: 'study-spell', label: '拼字學習', icon: 'edit',
    desc: '聽發音拼寫單字，訓練拼字能力',
    getDue: s => s.state.dueCountSpell,
    color: 'var(--orange)',
  },
];

function modeCard(s, m) {
  const due = m.getDue(s) ?? 0;
  return `
    <div class="mode-card" data-page="${m.id}" style="cursor:pointer;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;display:flex;gap:16px;align-items:flex-start;transition:background-color .15s,border-color .15s,color .15s">
      <div style="width:44px;height:44px;border-radius:var(--r-md);background:${m.color}20;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${m.color}">
        ${icon(m.icon)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600;color:var(--text-primary)">${m.label}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${m.desc}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:20px;font-weight:700;color:${due > 0 ? 'var(--text-primary)' : 'var(--text-tertiary)'};font-family:var(--mono);font-feature-settings:'tnum'">${due}</div>
        <div style="font-size:11px;color:var(--text-tertiary)">待複習</div>
      </div>
    </div>
  `;
}

export function render(s) {
  return `
    <div class="page-title">${icon('bookOpen')} 學習</div>
    <div class="page-subtitle">選擇學習模式開始複習</div>
    <div class="mobile-mode-tabs" style="display:none;gap:8px;margin-bottom:16px">
      <button class="btn btn-primary btn-sm" style="flex:1" data-nav="study">${icon('bookOpen')} 學習</button>
      <button class="btn btn-sm" style="flex:1" data-nav="exam">${icon('scrollText')} 測驗</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:24px;max-width:600px">
      ${MODES.map(m => modeCard(s, m)).join('')}
    </div>
    <style>
      @media (max-width: 768px) { .mobile-mode-tabs { display: flex !important; } }
    </style>
  `;
}

export function onMount(s) {
  document.querySelectorAll('.mode-card[data-page]').forEach(el => {
    el.addEventListener('click', () => s.actions.navigate(el.dataset.page));
  });
  document.querySelector('[data-nav="exam"]')?.addEventListener('click', () => s.actions.navigate('exam'));
}
