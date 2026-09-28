import { icon } from '../lib/svg.js';
import { PLUGINS } from '../lib/plugins.js';

// 題目 hub：文法翻譯／作文批改／學測題庫 三入口（2026-09-28 使用者指定自學習頁獨立成同級頁）。
// 排版＝study/exam 同形；手機切換走 mobile-mode-tabs（跟切換測驗同一方法）。
const pluginModes = PLUGINS.map(p => ({
  id: p.id, label: p.label, icon: p.icon, desc: p.desc, color: p.color, getDue: () => null,
}));

function modeCard(s, m) {
  return `
    <div class="mode-card" data-page="${m.id}" style="cursor:pointer;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;display:flex;gap:16px;align-items:flex-start;transition:background-color .15s,border-color .15s,color .15s">
      <div style="width:44px;height:44px;border-radius:var(--r-md);background:${m.color}20;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${m.color}">
        ${icon(m.icon)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600;color:var(--text-primary)">${m.label}</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">${m.desc}</div>
      </div>
    </div>
  `;
}

export function render(s) {
  return `
    <div class="page-title">${icon('target')} 題目</div>
    <div class="page-subtitle">文法、作文與學測題庫</div>
    <div class="mobile-mode-tabs" style="display:none;gap:8px;margin-bottom:16px">
      <button class="btn btn-sm" style="flex:1" data-nav="study">${icon('bookOpen')} 學習</button>
      <button class="btn btn-sm" style="flex:1" data-nav="exam">${icon('scrollText')} 測驗</button>
      <button class="btn btn-primary btn-sm" style="flex:1" data-nav="topics">${icon('target')} 題目</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:24px;max-width:600px">
      ${pluginModes.map(m => modeCard(s, m)).join('')}
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
  document.querySelectorAll('[data-nav]').forEach(el =>
    el.addEventListener('click', () => s.actions.navigate(el.dataset.nav)));
}
