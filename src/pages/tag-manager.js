import { icon } from '../lib/svg.js';
import { toast } from '../lib/toast.js';

// ─── System tag editor ───

const DEFAULT_PALETTE = [
  '#ef4444', '#f59e0b', '#22c55e', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#ec4899', '#78716c',
];

function getPalette(s) { return s.state.colorPalette || DEFAULT_PALETTE; }

const ROLE_INFO = {
  'correct':     { origName: 'correct',    desc: '測驗答對時自動貼上此標籤' },
  'wrong':       { origName: 'wrong',      desc: '測驗答錯時自動貼上此標籤' },
  'leech-flip':  { origName: 'leech-flip',  desc: '翻卡學習超過水蛭門檻時自動貼上' },
  'leech-mc':    { origName: 'leech-mc',    desc: '多選學習超過水蛭門檻時自動貼上' },
  'leech-spell': { origName: 'leech-spell', desc: '拼字學習超過水蛭門檻時自動貼上' },
};

const ORIGINALS = {
  'correct':     { name: 'correct',     color: '#4ade80' },
  'wrong':       { name: 'wrong',       color: '#f87171' },
  'leech-flip':  { name: 'leech-flip',   color: '#f87171' },
  'leech-mc':    { name: 'leech-mc',     color: '#fb9d52' },
  'leech-spell': { name: 'leech-spell',  color: '#a78bfa' },
};

let _filterTag = null;
let _tmDocOutside = null;   // G11: palette outside-click（onMount 重複註冊累積）

function sysTagStats(s) {
  const { words, reviewLog, systemTags, tagConfig } = s.state;
  const tagByName = new Map((systemTags || []).map(t => [t.name, t]));
  const stats = new Map();
  for (const w of words) for (const t of (w.tags || [])) {
    if (!stats.has(t)) stats.set(t, { count: 0, correct: 0, total: 0 });
    stats.get(t).count++;
  }
  for (const e of reviewLog) {
    if (!e || !e.wordId) continue;
    const word = words.find(w => w.id === e.wordId);
    if (!word || !word.tags) continue;
    for (const t of word.tags) {
      const m = stats.get(t); if (!m) continue;
      m.total++; if (e.rating >= 2) m.correct++;
    }
  }
  return stats;
}

function userTagStats(s) {
  const { words, reviewLog, tags: userTags, tagConfig } = s.state;
  const tagByName = new Map((userTags || []).map(t => [t.name, t]));
  const stats = new Map();
  for (const w of words) for (const t of (w.tags || [])) {
    if (!stats.has(t)) stats.set(t, { count: 0, correct: 0, total: 0, words: [] });
    const m = stats.get(t); m.count++; m.words.push(w);
  }
  for (const e of reviewLog) {
    if (!e || !e.wordId) continue;
    const word = words.find(w => w.id === e.wordId);
    if (!word || !word.tags) continue;
    for (const t of word.tags) {
      const m = stats.get(t); if (!m) continue;
      m.total++; if (e.rating >= 2) m.correct++;
    }
  }
  return [...stats.entries()].map(([name, m]) => {
    const def = tagByName.get(name);
    return { name, color: def?.color || tagConfig[name] || getPalette(s)[[...stats.keys()].indexOf(name) % getPalette(s).length], id: def?.id || null, count: m.count, retention: m.total > 0 ? m.correct / m.total : null, words: m.words };
  }).sort((a, b) => b.count - a.count);
}

function retentionColor(r) {
  if (r == null) return 'var(--text-tertiary)';
  if (r >= 0.85) return 'var(--green)';
  if (r >= 0.7) return 'var(--amber)';
  return 'var(--red)';
}

// ─── Render ───

export function renderContent(s) {
  const sysTags = s.state.systemTags || [];
  const userTags = s.state.tags || [];
  const uMeta = userTagStats(s);
  return `
    <div style="display:flex;flex-direction:column;gap:var(--s3);padding:0 var(--s1)">
      ${sysTags.length > 0 ? `
        <div style="font-size:11px;font-weight:600;color:var(--text-tertiary)">系統標籤</div>
        ${renderSysTab(s, sysTags)}
      ` : ''}
      <div style="font-size:11px;font-weight:600;color:var(--text-tertiary)">自訂標籤（${userTags.length}）</div>
      ${renderUserTab(s, userTags, uMeta)}
      ${_filterTag ? renderFilteredWords(s, _filterTag) : ''}
      <div style="border-top:1px solid var(--border-subtle);padding-top:var(--s2);margin-top:var(--s2)">
        <button class="btn btn-ghost btn-sm" id="editPaletteBtn" style="font-size:11px">${icon('sliders')} 編輯常用色</button>
        <div id="paletteEditor" style="display:none;margin-top:var(--s2)">
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:var(--s2)">點擊色塊更改顏色</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
            ${getPalette(s).map((c, i) => `
              <label style="position:relative;width:28px;height:28px;border-radius:50%;overflow:hidden;cursor:pointer;border:1.5px solid var(--border-subtle);background:${c}" title="顏色 ${i + 1}">
                <input type="color" class="palette-edit-color" data-idx="${i}" value="${c}" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;padding:0;border:none">
              </label>
            `).join('')}
            <button class="btn btn-sm" id="resetPaletteBtn" style="font-size:10px">${icon('refresh')} 重設</button>
          </div>
        </div>
      </div>
    </div>
    <style>
      .tag-row-name{
        font-size:13px;font-weight:600;border:none;background:transparent;
        color:var(--text-primary);outline:none;padding:2px 4px;border-radius:4px;
        min-width:60px;flex:1;font-family:inherit;
      }
      .tag-row-name:focus{background:var(--bg-surface);box-shadow:0 0 0 1.5px var(--accent)}
      .tag-role-badge{
        font-size:10px;color:var(--text-tertiary);background:var(--bg-elevated);
        padding:1px 6px;border-radius:var(--r-full);font-weight:600;white-space:nowrap;
        width:76px;text-align:center;
      }
      .tag-stats{font-size:11px;color:var(--text-tertiary);white-space:nowrap;min-width:130px}
      .tag-stats b{color:var(--text-primary);font-weight:700;font-feature-settings:'tnum'}
      .tag-colors{display:none;gap:3px;align-items:center;position:absolute;top:100%;right:0;background:var(--bg-surface);border:1px solid var(--border);border-radius:10px;padding:8px;z-index:10;box-shadow:0 4px 16px rgba(0,0,0,.25)}
      .tag-colors.open{display:flex;flex-wrap:wrap;width:auto;max-width:260px}
      .tag-colors button{width:22px;height:22px;border-radius:50%;border:1.5px solid transparent;cursor:pointer;padding:0;transition:transform .1s,border-color .1s}
      .tag-colors button:hover{transform:scale(1.3);z-index:1}
      .tag-colors button.active{border-color:#fff;box-shadow:0 0 0 1.5px var(--accent)}
      .tag-colors .tag-custom-color{width:22px;height:22px;position:relative}
      .tag-colors .tag-custom-color input[type=color]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;padding:0;border:none}
      .tag-colors .tag-custom-color label{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px dashed var(--border);font-size:11px;color:var(--text-tertiary);cursor:pointer;transition:border-color .1s;background:var(--bg-elevated)}
      .tag-colors .tag-custom-color label:hover{border-color:var(--accent);color:var(--accent)}
      .tag-add-area{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin-top:var(--s1)}
      .tag-add-area input{width:140px;height:30px;font-size:13px}
      .tag-add-area .btn-sm{height:30px}
      .tag-add-swatch{border:1.5px solid transparent;width:22px;height:22px;border-radius:50%;cursor:pointer;padding:0;transition:transform .1s,border-color .1s}
      .tag-add-swatch.active{border-color:#fff;box-shadow:0 0 0 1.5px var(--accent)}
      .tag-add-swatch:hover{transform:scale(1.2)}
    </style>
  `;
}

export function render(s) {
  return `
    <div class="page-title">${icon('hash')} 標籤管理</div>
    <div class="page-subtitle">管理所有標籤</div>
    ${renderContent(s)}
  `;
}

function renderSysTab(s, sysTags) {
  return `<div style="display:flex;flex-direction:column;gap:var(--s1)">
    ${sysTags.map(t => {
      const info = ROLE_INFO[t.role] || {};
      return `
        <div class="deck-mgr-row" data-sys-tag-id="${t.id}" title="${escapeAttr(info.desc || '')}" style="position:relative">
          <span class="deck-mgr-dot" id="ss_${t.id}" style="background:${t.color}"></span>
          <input class="tag-row-name" id="sn_${t.id}" value="${escapeAttr(t.name)}" spellcheck="false">
          <span class="tag-role-badge">${t.role}</span>
          <div class="deck-mgr-actions">
            <button class="btn btn-ghost btn-sm" data-sys-palette style="font-size:11px;padding:2px 5px" title="顏色">${icon('sliders')}</button>
            <button class="btn btn-ghost btn-sm" data-sys-tag-id="${t.id}" data-sys-restore title="還原預設" style="font-size:11px;padding:2px 5px">${icon('refresh')}</button>
          </div>
          <div class="tag-colors" id="sc_${t.id}">
            ${getPalette(s).map(c => `
              <button type="button" class="${c === t.color ? 'active' : ''}" data-c="${c}" style="background:${c}" data-sys-color></button>
            `).join('')}
            <div class="tag-custom-color">
              <label for="scc_${t.id}" style="${getPalette(s).includes(t.color) ? '' : `background:${t.color}`}">${icon('sliders')}</label>
              <input type="color" id="scc_${t.id}" value="${t.color}">
            </div>
          </div>
        </div>
      `;
    }).join('')}
    ${sysTags.length === 0 ? '<div style="text-align:center;padding:var(--s4);color:var(--text-tertiary);font-size:13px">無系統標籤</div>' : ''}
  </div>`;
}

function renderUserTab(s, userTags, uMeta) {
  return `
    ${userTags.length === 0 ? `
      <div style="text-align:center;padding:var(--s4);color:var(--text-tertiary);font-size:13px">尚無自訂標籤，使用下方欄位建立</div>
    ` : `
      <div style="display:flex;flex-direction:column;gap:var(--s1)">
        ${userTags.map(t => {
          const m = uMeta.find(um => um.name === t.name);
          const count = m?.count ?? 0;
          const ret = m?.retention != null ? Math.round(m.retention * 100) + '%' : '-';
          return `
            <div class="deck-mgr-row" data-tag-id="${t.id}" style="position:relative">
              <span class="deck-mgr-dot" id="uts_${t.id}" style="background:${t.color}"></span>
              <input class="tag-row-name" id="utn_${t.id}" value="${escapeAttr(t.name)}" spellcheck="false">
              <span class="tag-stats"><b>${count}</b> 詞 · 保留率 <b style="color:${retentionColor(m?.retention)}">${ret}</b></span>
              <div class="deck-mgr-actions">
                <button class="btn btn-ghost btn-sm" data-user-palette style="font-size:11px;padding:2px 5px" title="顏色">${icon('sliders')}</button>
                <button class="btn btn-ghost btn-sm" data-action="filter" data-tag-name="${escapeAttr(t.name)}" style="font-size:11px;padding:2px 5px" title="篩選">${icon('filter')}</button>
                <button class="btn btn-ghost btn-sm danger" data-action="delete" data-tag-id="${t.id}" data-tag-name="${escapeAttr(t.name)}" style="font-size:11px;padding:2px 5px" title="刪除">${icon('trash')}</button>
              </div>
              <div class="tag-colors" id="utc_${t.id}">
                ${getPalette(s).map(c => `
                  <button type="button" class="${c === t.color ? 'active' : ''}" data-c="${c}" style="background:${c}" data-user-color></button>
                `).join('')}
                <div class="tag-custom-color">
                  <label for="utcc_${t.id}" style="${getPalette(s).includes(t.color) ? '' : `background:${t.color}`}">${icon('sliders')}</label>
                  <input type="color" id="utcc_${t.id}" value="${t.color}">
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `}
    <div class="tag-add-area">
      <input class="form-input" id="tagNewName" placeholder="新標籤名稱">
      <div style="display:flex;gap:3px;align-items:center">
        ${getPalette(s).map(c => `
          <button type="button" class="tag-add-swatch" data-new-color="${c}" style="background:${c}" title="${c}"></button>
        `).join('')}
        <label style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1.5px dashed var(--border);font-size:11px;color:var(--text-tertiary);cursor:pointer;position:relative;background:var(--bg-elevated);flex-shrink:0" title="自訂顏色">
          ${icon('sliders')}
          <input type="color" id="tagNewColor" value="#a78bfa" style="position:absolute;inset:0;opacity:0;cursor:pointer;padding:0;border:none">
        </label>
      </div>
      <button class="btn-primary btn-sm" id="tagAddBtn">${icon('plus')} 新增</button>
    </div>`;
}

function renderFilteredWords(s, tag) {
  const { words, tagConfig } = s.state;
  const color = tagConfig[tag] || '#b69dff';
  const list = words.filter(w => (w.tags || []).includes(tag));
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('filter')} 「${escapeHtml(tag)}」字庫 (${list.length})</div>
        <button class="btn btn-sm" id="tagFilterClear">${icon('x')} 清除篩選</button>
      </div>
      <div class="word-list">
        ${list.slice(0, 100).map(w => `
          <div class="word-row" style="cursor:default">
            <span class="word-row-word">${escapeHtml(w.word)}</span>
            ${w.pos ? `<span class="word-row-pos">${escapeHtml(w.pos)}</span>` : ''}
            <span class="word-row-def">${escapeHtml(w.definition || '-')}</span>
            ${w.description ? `<div class="word-row-desc" style="margin-left:var(--s6)">${escapeHtml(w.description)}</div>` : ''}
            <span class="tag tag-accent" style="background:${color}22;color:${color}">${escapeHtml(tag)}</span>
          </div>
        `).join('')}
      </div>
      ${list.length > 100 ? `<div class="center muted" style="font-size:12px;margin-top:var(--s4)">還有 ${list.length - 100} 筆，請使用字庫頁面查看全部</div>` : ''}
    </div>`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ─── onMount ───

export function onMount(s, renderFn) {
  if (renderFn) _renderInPlace = renderFn;

  // ── Palette toggle ──
  document.querySelectorAll('[data-sys-palette]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('[data-sys-tag-id]');
      if (!row) return;
      const p = row.querySelector('.tag-colors');
      if (!p) return;
      p.classList.toggle('open');
    });
  });
  document.querySelectorAll('[data-user-palette]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('[data-tag-id]');
      if (!row) return;
      const p = row.querySelector('.tag-colors');
      if (!p) return;
      p.classList.toggle('open');
    });
  });

  mountSysTab(s);
  mountUserTab(s);

  // ── Palette close on outside click ──
  // G11：具名＋冪等 — onMount 重複註冊不疊加；頁面切換時由 __pageCleanup 移除
  if (_tmDocOutside) { document.removeEventListener('click', _tmDocOutside); _tmDocOutside = null; }
  _tmDocOutside = (e) => {
    if (!e.target.closest('.tag-colors, [data-sys-palette], [data-user-palette]')) {
      document.querySelectorAll('.tag-colors.open').forEach(p => p.classList.remove('open'));
    }
  };
  document.addEventListener('click', _tmDocOutside);

  window.__pageCleanup = () => {
    if (_tmDocOutside) { document.removeEventListener('click', _tmDocOutside); _tmDocOutside = null; }
  };

  // ── Filter clear ──
  document.getElementById('tagFilterClear')?.addEventListener('click', () => {
    _filterTag = null;
    _renderInPlace(s);
  });

  // ── Palette editor ──
  document.getElementById('editPaletteBtn')?.addEventListener('click', () => {
    const el = document.getElementById('paletteEditor');
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  document.querySelectorAll('.palette-edit-color').forEach(input => {
    input.addEventListener('input', async () => {
      const idx = parseInt(input.dataset.idx);
      const palette = [...getPalette(s)];
      palette[idx] = input.value;
      await s.actions.updateColorPalette(palette);
      _renderInPlace(s);
    });
  });
  document.getElementById('resetPaletteBtn')?.addEventListener('click', async () => {
    await s.actions.updateColorPalette(null);
    _renderInPlace(s);
  });
}

function mountSysTab(s) {
  document.querySelectorAll('[data-sys-tag-id]').forEach(row => {
    const id = row.dataset.sysTagId;
    const nameEl = row.querySelector('.tag-row-name');
    const dot = row.querySelector('.deck-mgr-dot');
    const colors = row.querySelector('.tag-colors');
    if (!colors) return;

    const updatePreview = (name, color) => {
      if (dot) dot.style.background = color;
      colors.querySelectorAll('[data-sys-color]').forEach(b => b.classList.toggle('active', b.dataset.c === color));
    };

    const save = debounce(async (name, color) => {
      const tag = s.state.systemTags.find(t => t.id === id);
      if (!tag) return;
      color = color || tag.color;
      name = (name || '').trim() || tag.name;
      await s.actions.updateSystemTag(id, { name, color });
      updatePreview(name, color);
    }, 300);

    nameEl?.addEventListener('input', () => {
      const tag = s.state.systemTags.find(t => t.id === id);
      updatePreview(nameEl.value || '-', tag?.color || '#a78bfa');
      save(nameEl.value, null);
    });
    colors.querySelectorAll('[data-sys-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.c;
        const tag = s.state.systemTags.find(t => t.id === id);
        if (!tag) return;
        updatePreview(nameEl?.value || tag.name, c);
        save(nameEl?.value, c);
      });
    });
    const customInput = colors.querySelector('.tag-custom-color input[type=color]');
    customInput?.addEventListener('input', () => {
      const c = customInput.value;
      const tag = s.state.systemTags.find(t => t.id === id);
      if (!tag) return;
      updatePreview(nameEl?.value || tag.name, c);
      const label = colors.querySelector('.tag-custom-color label');
      if (label) label.style.background = c;
      save(nameEl?.value, c);
    });

    row.querySelector('[data-sys-restore]')?.addEventListener('click', async () => {
      const tag = s.state.systemTags.find(t => t.id === id);
      if (!tag || !tag.role) return;
      const orig = ORIGINALS[tag.role];
      if (!orig) return;
      await s.actions.updateSystemTag(id, { name: orig.name, color: orig.color });
      if (nameEl) nameEl.value = orig.name;
      updatePreview(orig.name, orig.color);
      const label = colors.querySelector('.tag-custom-color label');
      if (label) label.style.background = 'transparent';
    });
  });
}

function mountUserTab(s) {
  // ─── Add new tag ───
  let newColor = '#a78bfa';
  document.querySelectorAll('.tag-add-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      newColor = btn.dataset.newColor;
      document.querySelectorAll('.tag-add-swatch').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  document.getElementById('tagNewColor')?.addEventListener('input', (e) => {
    newColor = e.target.value;
  });
  document.getElementById('tagAddBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('tagNewName')?.value.trim();
    if (!name) { toast('請輸入標籤名稱', 'toast-error'); return; }
    const tag = await s.actions.createTag(name, newColor);
    if (tag) { toast(`已建立「${name}」`, 'toast-success'); document.getElementById('tagNewName').value = ''; }
    else toast('名稱重複', 'toast-error');
    _renderInPlace(s);
  });
  document.getElementById('tagNewName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('tagAddBtn')?.click();
  });

  // ─── User tag rows ───
  document.querySelectorAll('[data-tag-id]').forEach(row => {
    const id = row.dataset.tagId;
    const nameEl = row.querySelector('.tag-row-name');
    const dot = row.querySelector('.deck-mgr-dot');
    const colors = row.querySelector('.tag-colors');
    if (!colors) return;

    const updatePreview = (name, color) => {
      if (dot) dot.style.background = color;
      colors.querySelectorAll('[data-user-color]').forEach(b => b.classList.toggle('active', b.dataset.c === color));
    };

    const save = debounce(async (name, color) => {
      const tag = s.state.tags.find(t => t.id === id);
      if (!tag) return;
      color = color || tag.color;
      name = (name || '').trim() || tag.name;
      await s.actions.updateTag(id, { name, color });
      updatePreview(name, color);
    }, 300);

    nameEl?.addEventListener('input', () => {
      const tag = s.state.tags.find(t => t.id === id);
      updatePreview(nameEl.value || '-', tag?.color || '#a78bfa');
      save(nameEl.value, null);
    });

    colors.querySelectorAll('[data-user-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.c;
        const tag = s.state.tags.find(t => t.id === id);
        if (!tag) return;
        updatePreview(nameEl?.value || tag.name, c);
        save(nameEl?.value, c);
      });
    });

    const customColor = colors.querySelector('.tag-custom-color input[type=color]');
    customColor?.addEventListener('input', () => {
      const c = customColor.value;
      const tag = s.state.tags.find(t => t.id === id);
      if (!tag) return;
      updatePreview(nameEl?.value || tag.name, c);
      const label = colors.querySelector('.tag-custom-color label');
      if (label) label.style.background = c;
      save(nameEl?.value, c);
    });
  });

  // ─── Card actions ───
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const tagName = btn.dataset.tagName;
      const tagId = btn.dataset.tagId;
      if (action === 'filter') {
        _filterTag = _filterTag === tagName ? null : tagName;
        _renderInPlace(s);
      } else if (action === 'delete') {
        if (!tagId) return;
        const tag = s.state.tags.find(t => t.id === tagId);
        if (!tag) return;
        if (!confirm(`從所有單字移除標籤「${tag.name}」？`)) return;
        const n = await s.actions.removeTagFromAll(tag.name);
        await s.actions.deleteTag(tagId);
        toast(`已刪除「${tag.name}」並從 ${n} 個單字移除`, 'toast-success');
        if (_filterTag === tag.name) _filterTag = null;
        _renderInPlace(s);
      }
    });
  });
}

let _renderInPlace = (s) => {
  const container = document.getElementById('pageContainer');
  if (container) { container.innerHTML = render(s); onMount(s); }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
