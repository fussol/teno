// ═══════════════════════════════════════════════════════════════
// Export — Export words as a CSV download, with deck filter + preview.
// ═══════════════════════════════════════════════════════════════

import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { buildCSV } from '../core/import.js';
import { exportCsvDialog } from '../lib/api.js';
import { isAndroid, downloadBlob } from '../lib/platform.js';

let _deckFilter = null;

export function renderContent(s) {
  const { words, decks } = s.state;
  const filtered = filterWords(words);
  return `
    <div style="display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s4)">
      <span class="muted" style="font-size:12px;font-weight:600">字本：</span>
      <button class="exam-deck-chip ${_deckFilter === null ? 'selected' : ''}" data-deck="">全部</button>
      ${decks.map(d => `
        <button class="exam-deck-chip ${_deckFilter === d.name ? 'selected' : ''}" data-deck="${escapeAttr(d.name)}">
          <span style="width:7px;height:7px;border-radius:50%;background:${d.color};display:inline-block"></span>
          ${escapeHtml(d.name)}
        </button>
      `).join('')}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--s3)">
      <div style="font-size:13px;color:var(--text-secondary)">
        將匯出 <span class="tnum" style="color:var(--accent);font-weight:700">${filtered.length}</span> 詞
        ${_deckFilter ? `· 字本「${escapeHtml(_deckFilter)}」` : '（全部字本）'}
      </div>
      <button class="btn-primary" id="exportRunBtn" ${filtered.length === 0 ? 'disabled' : ''}>
        ${icon('save')} 下載 CSV
      </button>
    </div>
  `;
}

export function render(s) {
  const { words } = s.state;
  const content = renderContent(s);
  return `
    <div class="page-title">${icon('save')} 匯出</div>
    <div class="page-subtitle">將單字庫匯出為 CSV 檔案 · 共 ${words.length} 詞</div>
    <div class="section">
      <div class="section-title">${icon('filter')} 範圍</div>
      <div class="config-section">
        ${renderContent(s)}
      </div>
    </div>
  `;
}

function filterWords(words) {
  const list = _deckFilter ? words.filter(w => w.deck === _deckFilter) : words;
  return [...list].sort((a, b) => (a.word || '').localeCompare(b.word || ''));
}

export function onMount(s, renderFn) {
  const _renderInPlace = renderFn || renderInPlace;
  document.querySelectorAll('.exam-deck-chip[data-deck]').forEach(el => {
    el.addEventListener('click', () => {
      _deckFilter = el.dataset.deck || null;
      _renderInPlace(s);
    });
  });

  const runBtn = document.getElementById('exportRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => runExport(s));
}

async function runExport(s) {
  const words = s.state.words;
  const filtered = filterWords(words);
  if (filtered.length === 0) { toast('沒有資料可匯出', 'toast-error'); return; }

  const csv = buildCSV(filtered.map(w => ({
    word: w.word, definition: w.definition, pos: w.pos, pron: w.pron,
    example: w.example, deck: w.deck, image: w.image, tags: w.tags,
    description: w.description, related: w.related, forms: w.forms,
    synonym: w.synonym, antonym: w.antonym, derivative: w.derivative, examples: w.examples,
  })));

  const stamp = new Date().toISOString().slice(0, 10);
  const deckTag = _deckFilter ? '-' + _deckFilter.replace(/[^\w\u4e00-\u9fff]/g, '_') : '';
  const fname = `teno-export${deckTag}-${stamp}.csv`;

  try {
    if (isAndroid) {
      downloadBlob('\uFEFF' + csv, fname, 'text/csv');
      toast(`已匯出 ${filtered.length} 詞`, 'toast-success');
    } else {
      const path = await exportCsvDialog(csv, fname);
      toast(`已匯出 ${filtered.length} 詞 → ${path}`, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

function renderInPlace(s) {
  const container = document.getElementById('pageContainer');
  if (container) {
    container.innerHTML = render(s);
    onMount(s);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
