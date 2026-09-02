import { icon } from '../lib/svg.js';

const MODES = [
  {
    id: 'exam-flip', label: '翻卡測驗', icon: 'galleryHorizontalEnd',
    desc: '看定義回想單字，核對正確性',
    color: 'var(--cyan)',
  },
  {
    id: 'exam-mc', label: '多選測驗', icon: 'form',
    desc: '從四個選項選出正確釋義',
    color: 'var(--green)',
  },
  {
    id: 'exam-spell', label: '拼字測驗', icon: 'edit',
    desc: '聽發音拼寫單字，字母級驗證',
    color: 'var(--orange)',
  },
];

function modeCard(s, m) {
  return `
    <div class="mode-card" data-page="${m.id}" style="cursor:pointer;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;display:flex;gap:16px;align-items:flex-start;transition:background-color .15s,border-color .15s,color .15s">
      <div style="width:44px;height:44px;border-radius:var(--r-md);background:${m.color}20;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${m.color}">
        ${icon(m.icon)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600;color:var(--text-primary)">${m.label}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${m.desc}</div>
      </div>
      <div style="font-size:12px;color:var(--text-tertiary);flex-shrink:0">開始測驗 ›</div>
    </div>
  `;
}

export function render(s) {
  return `
    <div class="page-title">${icon('scrollText')} 測驗</div>
    <div class="page-subtitle">選擇測驗模式，不影響學習進度</div>
    <div class="mobile-mode-tabs" style="display:none;gap:8px;margin-bottom:16px">
      <button class="btn btn-sm" style="flex:1" data-nav="study">${icon('bookOpen')} 學習</button>
      <button class="btn btn-primary btn-sm" style="flex:1" data-nav="exam">${icon('scrollText')} 測驗</button>
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
  document.querySelector('[data-nav="study"]')?.addEventListener('click', () => s.actions.navigate('study'));
}
