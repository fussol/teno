import { icon, splitFieldsHtml, fmtExample, mergeExamplePhrases, wordExample, examplePoolFor, rotateExamples } from '../lib/svg.js';
import { cardFaceHtml } from '../lib/word-extra.js';
import { wordImageSlotHTML, mountWordImages, WORD_IMAGE_CSS, disableWordImageKeys, renderEditorThumbs, bindEditorThumbs, getWordImages, invalidateWordImages, addImageUrlFlow, ensureThumbCSS } from '../lib/word-image.js';
import { deleteWordImagesForWord, addWordImage } from '../lib/db.js';
import { store } from '../lib/app-store.js';
import { toast } from '../lib/toast.js';
import { hashCode, mulberry32 } from '../lib/rng.js';
import { speak, stopSpeech } from '../lib/tts.js';
import { bindSpeakClick } from '../lib/tts.js';
import { fetchGet, fetchLLM, lookupCambridge, lookupMerriam } from '../lib/api.js';
import { merriamToFields } from '../lib/merriam.js';
import { isMobile } from '../lib/platform.js';
import { DISPLAY_LIMIT_KEY, DISPLAY_LIMIT_DEFAULT, normalizeDisplayLimit, capList, limitNote, limitSelectHtml } from '../lib/display-limit.js';

// 字本瀏覽顯示上限（可調＋記憶：與 browser.js 共享 db settings.browserDisplayLimit）
let _displayLimit = DISPLAY_LIMIT_DEFAULT;

// 自動填入來源鏈（四 modal 共用；與 browser.js 同步：merriam 預設第二順位）
// 舊存檔只有四步時 _normalizeAutoChain 把缺的 merriam 補到 llm 之前
const AUTO_FILL_LABELS = { cambridge: 'Cambridge', merriam: '韋氏字典', 'dict-api': '字典API', tatoeba: 'Tatoeba', llm: 'LLM' };
const AUTO_FILL_DEFAULT = ['cambridge', 'merriam', 'dict-api', 'tatoeba', 'llm'];
const _KNOWN_AUTO_SRC = new Set(AUTO_FILL_DEFAULT);
const _normalizeAutoChain = (arr) => {
  const kept = (arr || []).map(s => String(s || '').trim()).filter(s => _KNOWN_AUTO_SRC.has(s));
  if (!kept.includes('merriam')) {
    const li = kept.indexOf('llm');
    if (li === -1) kept.push('merriam'); else kept.splice(li, 0, 'merriam');
  }
  return kept.length ? kept : [...AUTO_FILL_DEFAULT];
};

let _deckName = null;
let _query = '';
let _tagFilter = null;
let _searchScope = 'all';
let _sortRandom = false;
let _sortSeed = '';
let _rulerSpacing = 3;
let _selectMode = false;
let _selectedIds = new Set();
function allTags(s) { return [...(s.state.systemTags || []), ...(s.state.tags || [])]; }
function tagPickerHtml(sysTags, userTags, selectedTags, cbClass) {
  const cb = (t, val) =>
    `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;padding:2px 0">
      <input type="checkbox" class="${cbClass}" value="${escapeAttr(val)}" ${selectedTags.includes(val) ? 'checked' : ''}>
      <span class="tag" style="background:${t.color || '#a78bfa'};color:${t.color ? '#fff' : '#160e2b'};font-size:11px">${escapeHtml(t.name)}</span>
    </label>`;
  let html = '';
  if (sysTags.length) {
    html += '<div style="font-size:10px;color:var(--text-tertiary);margin:4px 0 2px;width:100%">系統標籤</div>';
    html += sysTags.map(t => cb(t, t.role)).join('');
  }
  if (userTags.length) {
    html += '<div style="font-size:10px;color:var(--text-tertiary);margin:4px 0 2px;width:100%">自訂標籤</div>';
    html += userTags.map(t => cb(t, t.name)).join('');
  }
  if (!sysTags.length && !userTags.length) html += '<span class="muted" style="font-size:12px">尚無標籤</span>';
  return html;
}
export function render(s) {
  if (s.state.browserDeckFilter) {
    _deckName = s.state.browserDeckFilter;
    s.state.browserDeckFilter = null;
    s.state.browserDeckLock = false;
  }
  const words = _deckName ? s.state.words.filter(w => w.deck === _deckName) : s.state.words;
  const allTags = collectTags(words);
  const filtered = filterDeckWords(words);

  return `
    <div class="page-title">${icon('list')} ${escapeHtml(_deckName || '')}</div>
    <div class="page-subtitle">${words.length} 詞</div>

    <div style="display:flex;gap:var(--s3);margin-bottom:var(--s5);flex-wrap:wrap;align-items:center">
      <div class="search-box" style="${isMobile ? 'width:100%' : 'flex:1;min-width:240px'}">
        ${icon('search')}
        <input id="deckBrowserSearch" type="text" placeholder="搜尋單字、定義、例句...（Enter 執行）" value="${escapeAttr(_query)}">
      </div>
      <button class="btn-ghost btn-sm" id="deckSearchBtn" title="執行搜尋">${icon('search')} 搜尋</button>
      <button class="btn-ghost btn-sm" id="deckBrowserScopeToggle" style="font-size:11px;border:1px solid var(--border);padding:5px 10px;min-width:10ch;text-align:center;white-space:nowrap;box-sizing:border-box" title="切換搜尋範圍">${_searchScope === 'worddef' ? '單字+定義' : '全部欄位'}</button>
      <select id="deckBrowserTagFilter" class="form-input" style="max-width:170px">
        <option value="">標籤：全部</option>
        <optgroup label="系統標籤">
        ${(s.state.systemTags || []).map(t => `<option value="${escapeAttr(t.role)}" ${_tagFilter === t.role ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        </optgroup>
        <optgroup label="自訂標籤">
        ${(s.state.tags || []).map(t => `<option value="${escapeAttr(t.name)}" ${_tagFilter === t.name ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        </optgroup>
      </select>
      <button class="btn-ghost btn-sm" id="deckBrowserSortToggle" style="font-size:11px;min-width:6ch;text-align:center;white-space:nowrap;box-sizing:border-box" title="切換排序">${_sortRandom ? '隨機' : 'A-Z'}</button>
      ${_sortRandom ? `<input id="deckBrowserSeed" type="text" placeholder="seed" value="${escapeAttr(_sortSeed)}" style="width:80px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-size:11px;font-family:var(--mono)">` : ''}
      <button class="btn-ghost btn-sm ${_selectMode ? 'selected' : ''}" id="deckBrowserSelectToggle" style="font-size:11px;min-width:10ch;text-align:center;white-space:nowrap;box-sizing:border-box" title="切換選擇模式">${icon('check')} ${_selectMode ? '取消選擇' : '選擇'}</button>
      <button class="btn-primary btn-sm" id="deckBrowserAdd">${icon('plus')} 新增</button>
      <button class="btn btn-sm" id="deckBrowserBatch" title="批量新增（筆記本式一次多字）">${icon('layers')} 批量新增</button>
    </div>

    ${filtered.length === 0 ? `
      <div class="empty-state">
        ${icon('search')}
        <h3>${_query || _tagFilter ? '找不到符合的單字' : '字本是空的'}</h3>
        <p>${_query || _tagFilter ? '試試其他關鍵字或標籤' : ''}</p>
      </div>
    ` : renderDeckList(filtered, s.state.tagConfig, s.state.systemTags, (s.state.decks || []).map(d => d.name))}
    <button class="scroll-top-btn" id="scrollTopBtn">${icon('chevronU')}</button>
  `;
}

// EFF(C1)：memo — words ref 不變即回快取（1.16ms/render → 0），ref 變或編輯標籤後自然重建
let _ctRef = null, _ctCache = null;
function collectTags(words) {
  if (_ctRef === words && _ctCache) return _ctCache;
  const set = new Set();
  for (const w of words) for (const t of (w.tags || [])) set.add(t);
  _ctRef = words; _ctCache = [...set].sort((a, b) => a.localeCompare(b));
  return _ctCache;
}

// EFF：預先 lowercase 搜尋索引（同 browser.js 手法）— words ref 不變時復用。
let _siWordsRef = null;
let _siMap = null;
function searchIndex(words) {
  if (_siWordsRef === words && _siMap) return _siMap;
  const m = new Map();
  for (const w of words) {
    const hay1 = `${w.word || ''}\n${w.definition || ''}`.toLowerCase();
    const hay2 = `${w.example || ''}\n${w.pos || ''}\n${w.description || ''}`.toLowerCase();
    m.set(w, { hay1, hay2, related: (w.related || []).map(r => r.toLowerCase()), forms: (w.forms || []).map(f => f.toLowerCase()) });
  }
  _siWordsRef = words; _siMap = m;
  return m;
}

function filterDeckWords(words) {
  const q = _query.trim().toLowerCase();
  const idx = searchIndex(words);
  const scope = _searchScope === 'worddef' ? ['word', 'definition'] : null;
  const filtered = words.filter(w => {
    if (_tagFilter && !(w.tags || []).includes(_tagFilter)) return false;
    if (!q) return true;
    const e = idx.get(w);
    if (!e) return false;
    if (scope) return e.hay1.includes(q);
    return e.hay1.includes(q)
      || e.hay2.includes(q)
      || e.related.some(r => r.includes(q))
      || e.forms.some(f => f.includes(q));
  });
  const copy = filtered.slice();
  if (_sortRandom) {
    const seed = _sortSeed ? hashCode(_sortSeed) : hashCode((_deckName || 'all') + '_' + new Date().toISOString().slice(0, 10));
    const rng = mulberry32(seed);
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  return copy.sort((a, b) => (a.word || '').localeCompare(b.word || ''));
}

function renderDeckList(words, tagColors, sysTags, deckNames) {
  const display = capList(words, _displayLimit);
  return `
    <div id="deckListHead" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s3)">
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-tertiary)">
        ${_selectMode ? `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-weight:500">
          <input type="checkbox" id="deckSelectAll" ${_selectedIds.size === display.length && display.length > 0 && display.length === words.length ? 'checked' : ''}>
          全選
        </label>` : ''}
        <span style="font-weight:500">${limitNote(words, _displayLimit)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-tertiary)">
          上限
          ${limitSelectHtml('deckLimitSelect', _displayLimit)}
        </label>
        ${_selectMode && _selectedIds.size > 0 ? `<button class="btn-primary btn-sm" id="deckBatchMoveBtn">${icon('shuffle')} 搬到字本 (${_selectedIds.size})</button>` : ''}
      </div>
    </div>
    <div class="word-list" id="deckWordList">
      ${display.map(w => wordRowHtml(w, tagColors, sysTags, deckNames)).join('')}
    </div>
  `;
}

function wordRowHtml(w, tagColors, sysTags, deckNames) {
  const tc = tagColors || {};
  const sys = sysTags || [];
  const tagName = (t) => { const st = sys.find(s => s.role === t); return st ? st.name : t; };
  // 字本名不是標籤：歷史資料把字本名塞進 w.tags，列表只印真標籤。
  const deckSet = new Set(deckNames || []);
  const showTags = (w.tags || []).filter(t => !deckSet.has(t));
  return `<div class="word-row" data-word="${escapeAttr(w.id)}">
    ${_selectMode ? `<label class="batch-cb" onclick="event.stopPropagation()"><input type="checkbox" class="deck-word-select-cb" value="${escapeAttr(w.id)}" ${_selectedIds.has(w.id) ? 'checked' : ''}></label>` : ''}
    <div style="display:flex;flex-direction:column;flex:1;min-width:0;gap:2px">
      <div style="display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap">
        <span class="word-row-word">${escapeHtml(w.word)}</span>
        ${w.pos ? w.pos.split(/[,，]/).map(s => s.trim()).filter(Boolean).map(s => `<span class="word-row-pos">${escapeHtml(s)}</span>`).join('') : ''}
      </div>
      <span class="word-row-def">${(() => {
        const parts = (w.definition || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        if (!parts.length) return '<span class="muted" style="font-size:12px">-</span>';
        return parts.map(s => `<span style="display:inline-block;font-size:12px;color:var(--text-primary);background:var(--bg-surface);padding:2px 10px;border-radius:100px;border:1px solid var(--border-subtle);white-space:nowrap;margin:1px 3px 1px 0">${escapeHtml(s)}</span>`).join('');
      })()}</span>
      <span class="word-row-tags" data-word-id="${escapeAttr(w.id)}" style="margin-top:2px">
        ${showTags.map(t => {
          const c = tc[t] || 'var(--accent)';
          return `<span class="tag" style="background:${c};color:${tc[t] ? '#fff' : 'var(--accent-on)'}" data-tag-chip="${escapeAttr(t)}">${escapeHtml(tagName(t))}</span>`;
        }).join('')}
      </span>
      ${w.description ? `<div class="word-row-desc" style="margin-left:0">${escapeHtml(w.description)}</div>` : ''}
      ${w.related && w.related.length ? `<div class="word-row-related" style="margin-left:0">${w.related.map(r => `<span>${escapeHtml(r)}</span>`).join('')}</div>` : ''}
      ${w.forms && w.forms.length ? `<div class="word-row-forms" style="margin-left:0">${w.forms.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="word-row-actions" style="${isMobile ? 'opacity:1' : ''}">
      <button title="編輯標籤" data-action="tags" data-word-id="${escapeAttr(w.id)}">${icon('hash')}</button>
      <button title="發音" data-action="speak" data-word-id="${escapeAttr(w.id)}">${icon('volume')}</button>
      <button title="編輯" data-action="edit" data-word-id="${escapeAttr(w.id)}">${icon('edit')}</button>
      <button class="danger" title="刪除" data-action="delete" data-word-id="${escapeAttr(w.id)}">${icon('trash')}</button>
    </div>
  </div>`;
}

export function onMount(s) {
  initScrollTop();
  // 顯示上限：db 還原（與 browser.js 共享同一設定鍵＝兩頁一致記憶）＋ selector 變更寫回
  import('../lib/db.js').then(m => m.getSetting(DISPLAY_LIMIT_KEY)).then(v => {
    const n = normalizeDisplayLimit(v);
    if (n !== _displayLimit) { _displayLimit = n; renderInPlace(s); }
  }).catch(() => {});
  // 例句限數：db 還原（與工具頁同一設定鍵）— 沒這段 window 變數永遠 undefined＝無限
  import('../lib/db.js').then(m => m.getSetting('exampleDisplayMax')).then(v => {
    const n = Math.max(0, parseInt(v, 10) || 0);
    if (n > 0) window.__maxExampleLines = n;
  }).catch(() => {});
  // 卡片播放設定：db 還原（換頁/重整不再重置回預設）
  import('../lib/db.js').then(m => m.getSetting(CARD_SETTINGS_KEY)).then(v => {
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object') {
        if (typeof o.pronAuto === 'boolean') cardSettings.pronAuto = o.pronAuto;
        if (typeof o.pronManual === 'boolean') cardSettings.pronManual = o.pronManual;
        if (typeof o.pauseAfterPron === 'number') cardSettings.pauseAfterPron = o.pauseAfterPron;
        if (typeof o.pauseBetweenCards === 'number') cardSettings.pauseBetweenCards = o.pauseBetweenCards;
      }
    } catch (_) {}
  }).catch(() => {});
  document.getElementById('deckLimitSelect')?.addEventListener('change', async (e) => {
    _displayLimit = normalizeDisplayLimit(e.target.value);
    renderInPlace(s);
    try {
      const { setSetting } = await import('../lib/db.js');
      await setSetting(DISPLAY_LIMIT_KEY, String(_displayLimit));
    } catch (_) {}
  });
  const search = document.getElementById('deckBrowserSearch');
  if (search) {
    // 搜尋改「Enter / 搜尋鈕」觸發（元首令 2026-08-31）— 不再輸入即時過濾
    const doSearch = () => {
      _query = search.value;
      renderListInPlace(s);
    };
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    document.getElementById('deckSearchBtn')?.addEventListener('click', doSearch);
  }

  document.getElementById('deckBrowserScopeToggle')?.addEventListener('click', () => {
    _searchScope = _searchScope === 'worddef' ? 'all' : 'worddef';
    renderInPlace(s);
  });

  const tagFilter = document.getElementById('deckBrowserTagFilter');
  if (tagFilter) {
    tagFilter.addEventListener('change', () => {
      _tagFilter = tagFilter.value || null;
      renderInPlace(s);
    });
  }

  const sortBtn = document.getElementById('deckBrowserSortToggle');
  if (sortBtn) sortBtn.addEventListener('click', () => {
    _sortRandom = !_sortRandom;
    renderInPlace(s);
  });

  const seedInput = document.getElementById('deckBrowserSeed');
  if (seedInput) {
    const onSeedChange = () => {
      _sortSeed = seedInput.value;
      renderInPlace(s);
      const el = document.getElementById('deckBrowserSeed');
      if (el) el.focus();
    };
    seedInput.addEventListener('change', onSeedChange);
    seedInput.addEventListener('keydown', e => { if (e.key === 'Enter') onSeedChange(); });
  }

  document.getElementById('deckBrowserAdd')?.addEventListener('click', () => openAddModal(s));
  document.getElementById('deckBrowserBatch')?.addEventListener('click', () => openBatchModal(s));

  document.getElementById('deckBrowserSelectToggle')?.addEventListener('click', () => {
    _selectMode = !_selectMode;
    if (!_selectMode) _selectedIds.clear();
    renderInPlace(s);
  });

  bindDeckWordEvents(s);
}

function bindDeckWordEvents(s) {
  // EFF：delegation — deckWordList 容器單一 listener 涵蓋 row/chip/batch-cb。
  // 原逐列綁（500 列 500+ listener）整頁重建時重綁成本大戶；局部渲染後只重綁這一個。
  const listEl = document.getElementById('deckWordList');
  if (!listEl || listEl.dataset.bound === '1') return;
  listEl.dataset.bound = '1';
  listEl.addEventListener('click', (e) => {
    // tag chip → 移除標籤
    const chip = e.target.closest('.tag[data-tag-chip]');
    if (chip) {
      e.stopPropagation();
      const tag = chip.dataset.tagChip;
      const wordId = chip.closest('[data-word-id]')?.dataset.wordId;
      const w = s.state.words.find(x => x.id === wordId);
      if (!w) return;
      const next = (w.tags || []).filter(t => t !== tag);
      s.actions.editWord(wordId, { tags: next }).then(() => {
        toast(`已移除標籤「${tag}」`, 'toast-success');
        renderInPlace(s);
      }).catch(() => {});
      return;
    }
    // row
    const row = e.target.closest('.word-row[data-word]');
    if (!row) return;
    if (_selectMode && e.target.closest('.batch-cb, .deck-word-select-cb')) return;
    const btn = e.target.closest('[data-action]');
    const id = btn?.dataset.wordId || row.dataset.word;
    if (btn) {
      const action = btn.dataset.action;
      if (action === 'edit') openEditModal(s, id);
      else if (action === 'delete') confirmDelete(s, id);
      else if (action === 'speak') speakWord(id);
      else if (action === 'tags') inlineEditTags(s, id);
      e.stopPropagation();
    } else {
      openDeckCardPreview(s, row.dataset.word);
    }
  });

  if (_selectMode) {
    document.getElementById('deckWordList')?.addEventListener('change', (e) => {
      const cb = e.target.closest('.deck-word-select-cb');
      if (!cb) return;
      if (cb.checked) _selectedIds.add(cb.value);
      else _selectedIds.delete(cb.value);
      renderInPlace(s);
    });
    document.getElementById('deckSelectAll')?.addEventListener('change', function() {
      const all = document.querySelectorAll('.deck-word-select-cb');
      if (this.checked) all.forEach(cb => _selectedIds.add(cb.value));
      else _selectedIds.clear();
      renderInPlace(s);
    });
    document.getElementById('deckBatchMoveBtn')?.addEventListener('click', () => batchMoveToDeck(s));
  }
}

function speakWord(id) {
  const row = document.querySelector(`.word-row[data-word="${cssEscape(id)}"] .word-row-word`);
  const word = row?.textContent || '';
  if (!word) return;
  speak(word, store.state.ttsSpeed, store.state.ttsVoice, store.state.ttsPitch);
}

function confirmDelete(s, id) {
  const w = s.state.words.find(x => x.id === id);
  if (!w) return;
  if (!confirm(`確定要刪除「${w.word}」？此操作無法復原。`)) return;
  s.actions.deleteWord(id).then(() => {
    toast(`已刪除「${w.word}」`, 'toast-success');
    renderInPlace(s);
  }).catch(e => {
    console.error('deleteWord error:', e);
    toast('刪除失敗', 'toast-error');
  });
}

function inlineEditTags(s, id) {
  const w = s.state.words.find(x => x.id === id);
  if (!w) return;
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const existing = document.getElementById('deckTagPickerModal');
  if (existing) existing.remove();

  container.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay open" id="deckTagPickerModal">
      <div class="modal" style="max-width:360px">
        <div class="modal-header">
          <div class="modal-title">${icon('hash')} 編輯標籤：${escapeHtml(w.word)}</div>
          <button class="modal-close" id="deckTagPickerClose">${icon('x')}</button>
        </div>
        <div class="form-group" style="padding:var(--s4)">
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="deckTagPickerGroup">
            ${tagPickerHtml(s.state.systemTags || [], s.state.tags || [], w.tags || [], 'deck-tag-picker-cb')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="deckTagPickerCancel">取消</button>
          <button class="btn-primary" id="deckTagPickerSave">${icon('check')} 儲存</button>
        </div>
      </div>
    </div>`);

  const close = () => document.getElementById('deckTagPickerModal')?.remove();
  document.getElementById('deckTagPickerClose')?.addEventListener('click', close);
  document.getElementById('deckTagPickerCancel')?.addEventListener('click', close);
  document.getElementById('deckTagPickerModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckTagPickerModal') close();
  });
  document.getElementById('deckTagPickerSave')?.addEventListener('click', async () => {
    const cbs = document.querySelectorAll('#deckTagPickerGroup .deck-tag-picker-cb:checked');
    const tags = Array.from(cbs).map(cb => cb.value);
    await s.actions.editWord(id, { tags });
    toast(`已更新標籤`, 'toast-success');
    close();
    renderInPlace(s);
  });
}

// ─── Edit Modal ────────────────────────────────────────────
// ── IMG1: 編輯器圖片縮圖列（新增/編輯 modal 共用；存檔時 getVal() 全量替換寫庫）──
// IMGURL1: 加 urlInputId/urlAddId（貼連結加圖；不傳則不綁，舊呼叫相容）
function attachImagePicker({ thumbsId, pickId, filesId, wordId, urlInputId, urlAddId }) {
  let api = null;
  let cleanup = null;
  let changed = false;
  const el = () => document.getElementById(thumbsId);
  const render = () => {
    ensureThumbCSS(); // THUMBOVERFLOW1: 縮圖 CSS 沒注入即原尺寸撐開 modal；此處冪等注入（新增/編輯共用）
    const t = el(); if (!t || !api) return;
    if (cleanup) cleanup();
    t.innerHTML = api.html;
    cleanup = bindEditorThumbs(t, api);
  };
  (async () => {
    const existing = wordId ? await getWordImages(wordId) : [];
    api = renderEditorThumbs(existing, () => { changed = true; render(); });
    render();
  })().catch(() => { api = renderEditorThumbs([], () => { changed = true; render(); }); render(); });
  document.getElementById(pickId)?.addEventListener('click', () => document.getElementById(filesId)?.click());
  document.getElementById(filesId)?.addEventListener('change', async (ev) => {
    if (!api) return;
    await api.addFiles([...(ev.target.files || [])], (m) => toast(m, 'toast-error'));
    changed = true;
    ev.target.value = '';
  });
  // IMGURL1: 貼連結加圖（直連收；Tenor/Giphy/Imgur 分享頁轉 og:image；Tauri 走 fetchGet 繞 CSP）
  if (urlInputId && urlAddId) {
    const _addUrl = async () => {
      if (!api) return;
      const inp = document.getElementById(urlInputId);
      const raw = inp?.value || '';
      if (!raw.trim()) return;
      const fetchText = async (u) => {
        try { return await fetchGet(u); }
        catch { const r = await fetch(u); return await r.text(); }
      };
      await addImageUrlFlow(raw, api, fetchText,
        (m, k) => toast(m, k === 'ok' ? 'toast-success' : 'toast-error'));
      if (inp) inp.value = '';
    };
    document.getElementById(urlAddId)?.addEventListener('click', _addUrl);
    document.getElementById(urlInputId)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _addUrl(); }
    });
  }
  return {
    /** 存檔時呼叫：動過才全刪全插保序寫庫 */
    persist: async (targetId) => {
      if (!api || !changed || !targetId) return;
      const imgs = api.getVal();
      await deleteWordImagesForWord(targetId);
      for (const im of imgs) await addWordImage(targetId, im.filename, im.data);
      invalidateWordImages(targetId);
    },
  };
}

function openAddModal(s) {
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const existing = document.getElementById('deckAddModal');
  if (existing) existing.remove();

  const decks = s.state.decks || [];
  const deckNames = decks.map(d => d.name);
  const curDeck = (_deckName && deckNames.includes(_deckName)) ? _deckName
    : (deckNames.includes('Default') ? 'Default' : (deckNames[0] || 'Default'));
  const deckOpts = decks.map(d =>
    `<option value="${escapeAttr(d.name)}" ${d.name === curDeck ? 'selected' : ''}>${escapeHtml(d.name)}</option>`
  ).join('') + (deckNames.includes(curDeck) ? '' : `<option value="${escapeAttr(curDeck)}" selected>${escapeHtml(curDeck)}</option>`);

  const html = `
    <div class="modal-overlay open" id="deckAddModal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${icon('plus')} 新增單字</div>
          <button class="modal-close" id="deckAddClose">${icon('x')}</button>
        </div>
        <div class="form-group">
          <label class="form-label">單字 *</label>
          <div style="display:flex;gap:4px">
            <input class="form-input" id="deckAddWord" placeholder="apple" style="flex:1" autofocus>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">定義</label>
          <input class="form-input" id="deckAddDef" placeholder="多個定義用逗號分隔">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddDefChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">詞性</label>
            <div style="display:flex;flex-wrap:wrap;gap:4px" id="deckAddPosGroup">
              ${['名詞','動詞','形容詞','副詞','介係詞','連接詞','代名詞','感嘆詞','限定詞','冠詞','片語','慣用語','後綴','前綴','縮寫','複數名詞'].map(p =>
                `<span class="pos-chip" data-pos="${p}" style="cursor:pointer;padding:2px 10px;border-radius:100px;font-size:12px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);transition:background-color .15s,border-color .15s,color .15s">${p}</span>`
              ).join('')}
            </div>
          </div>
        <div class="form-row" style="${isMobile ? 'flex-direction:column' : ''}">
          <div class="form-group" style="flex:1">
            <label class="form-label">發音</label>
            <input class="form-input" id="deckAddPron" placeholder="/ˈæp.əl/">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">音節</label>
            <div style="display:flex;gap:4px"><input class="form-input" id="deckAddSyllables" placeholder="例：dic·tion·a·ry；Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckAddFillExtra" type="button" title="韋氏補上音節／字源（片語併入例句；只填空欄）">${icon('sparkle')}</button></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">例句（含片語）</label>
          <div style="display:flex;gap:4px;${isMobile ? 'flex-direction:column' : ''}"><input class="form-input" id="deckAddExample" placeholder="輸入後按 Enter（一行一筆；片語同一欄）" style="flex:1"><button class="btn btn-sm" id="deckAddFillExample" type="button" title="依順序新增一句例句">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddExChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">描述</label>
          <textarea class="form-input" id="deckAddDesc" rows="2" placeholder="補充說明、記憶技巧...；Ctrl+Enter 跳下一欄" style="resize:vertical"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">相關詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckAddRelated" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckAddFillRelated" type="button" title="LLM 自動產生相關詞">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddRelatedChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">詞形變化</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckAddForms" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckAddFillForms" type="button" title="LLM 自動產生詞形變化">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddFormsChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">相似詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckAddSynonym" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckAddFillSynonym" type="button" title="LLM 自動產生相似詞">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddSynonymChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">反義詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckAddAntonym" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckAddFillAntonym" type="button" title="LLM 自動產生反義詞">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddAntonymChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">衍生物</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckAddDerivative" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckAddFillDerivative" type="button" title="LLM 自動產生衍生物">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckAddDerivativeChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">字源</label>
          <textarea class="form-input" id="deckAddEtymology" rows="2" style="resize:vertical" placeholder="字源與首次使用年份；Ctrl+Enter 跳下一欄"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">字本</label>
          <select class="form-input" id="deckAddDeck">
            ${deckOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">圖片 <span class="hint-inline" style="font-size:11px;color:var(--text-tertiary)">（可多張；儲存時全量替換）</span></label>
          <div id="deckAddImgsThumbs"></div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-top:6px">
            <input type="file" id="deckAddImgFiles" accept="image/*" multiple style="display:none">
            <button class="btn btn-sm" type="button" id="deckAddImgPick">${icon('image')} 選擇圖片</button>
            <span style="font-size:11px;color:var(--text-tertiary)">PNG/JPG；單張 ≤10MB</span>
          </div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-top:6px">
            <input class="form-input" id="deckAddImgUrl" placeholder="或貼圖片連結…（直連 .gif/.jpg，或 Tenor 分享頁）" style="flex:1">
            <button class="btn btn-sm" type="button" id="deckAddImgUrlAdd">加入</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">標籤</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="deckAddTagGroup">
            ${tagPickerHtml(s.state.systemTags || [], s.state.tags || [], [], 'deck-add-tag-checkbox')}
          </div>
        </div>
        <div class="form-group" style="border-top:1px solid var(--border);padding-top:var(--s2);margin-top:var(--s2)">
          <label class="form-label">自動填入順序 <span style="font-size:11px;color:var(--text-tertiary)">（點 chip 往後移）</span></label>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:var(--s2)" id="deckAddAutoOrderChips"></div>
          <div style="display:flex;gap:var(--s2);align-items:center">
            <button class="btn" id="deckAddAutoFill">${icon('search')} 自動填入</button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="deckAddCancel">取消</button>
          <button class="btn-primary" id="deckAddSave">${icon('check')} 新增</button>
        </div>
      </div>
    </div>`;

  container.insertAdjacentHTML('beforeend', html);

  const close = () => document.getElementById('deckAddModal')?.remove();
  document.getElementById('deckAddClose')?.addEventListener('click', close);
  document.getElementById('deckAddCancel')?.addEventListener('click', close);
  document.getElementById('deckAddModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckAddModal') close();
  });

  // IMG1: 圖片選擇器（新增字：無既有圖）
  const addImgPicker = attachImagePicker({ thumbsId: 'deckAddImgsThumbs', pickId: 'deckAddImgPick', filesId: 'deckAddImgFiles', wordId: null, urlInputId: 'deckAddImgUrl', urlAddId: 'deckAddImgUrlAdd' });

  // ── Tag input for definition & example ───
  // ═══ 統一膠囊輸入系統（元首令 2026-08-31 v2）═══
  // 全欄位行為一致：
  //  • Enter → 輸入框內容存入膠囊（逗號分割：'狗,貓' → 兩顆；'狗狗' → 一顆）
  //  • 例句模式（sep=null）：逗號是句子一部分 → 不分割，Enter 整句一顆
  //  • 點膠囊 → 內容進輸入框編輯；框內有半成品 → 先存回膠囊再清空，換點的膠囊進框
  //    （一般欄位：框內 '狗,貓' + 點膠囊'牛' → 框變 '狗,貓,牛'；例句欄：半成品句先存膠囊再換）
  //  • 雙擊膠囊 → 刪除
  const _tagInput = (containerId, inputId, chipClass, initialVal, sep, jn, style) => {
    const cont = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    const isSentenceMode = sep === null || sep === undefined;   // 例句模式：不分割
    const spl = isSentenceMode ? null : new RegExp(sep);
    // 同欄去重（編輯器重開不再把膠囊值複製一次；保留首次出現順序）
    const _dedupe = (arr) => [...new Set(arr)];
    let chips = _dedupe(isSentenceMode
      ? (initialVal || '').split('\n').map(s => s.trim()).filter(Boolean)
      : (initialVal || '').split(spl).map(s => s.trim()).filter(Boolean));
    const render = () => {
      cont.innerHTML = '';
      chips.forEach((d, i) => {
        const el = document.createElement('span');
        el.className = chipClass;
        el.textContent = d;
        el.dataset.idx = i;
        el.style.cssText = style;
        el.title = '點擊編輯，雙擊刪除';
        cont.appendChild(el);
      });
    };
    const parseInput = (v) => isSentenceMode
      ? v.trim() ? [v.trim()] : []
      : v.split(spl).map(s => s.trim()).filter(Boolean);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const vals = parseInput(input.value);
        if (vals.length) {
          // 有打字就地消化：只收膠囊沒有的新值（重複的不再塞一次），不清跳轉
          const fresh = vals.filter(v => !chips.includes(v));
          if (fresh.length) { chips.push(...fresh); render(); }
          input.value = '';
          e.stopPropagation();
        }
      }
    });
    cont.addEventListener('click', (e) => {
      const chip = e.target.closest('.' + chipClass);
      if (!chip) { input.focus(); return; }
      const idx = parseInt(chip.dataset.idx, 10);
      const clicked = chips[idx];
      const draft = input.value.trim();
      chips.splice(idx, 1);
      if (draft) {
        if (isSentenceMode) {
          // 例句模式：半成品句先存回膠囊（保留打字內容），再換點選句進框
          chips.unshift(draft);
        } else {
          // 一般模式：半成品是 '狗,貓' + 點'牛' → '狗,貓,牛'（split+join 分隔一致）
          const vals = draft.split(spl).map(x => x.trim()).filter(Boolean); vals.push(clicked); input.value = vals.join(jn);
          render();
          input.focus();
          const endPos = input.value.length;
          input.setSelectionRange(endPos, endPos);
          return;
        }
      }
      input.value = clicked;
      render();
      input.focus();
      const endPos = input.value.length;
      input.setSelectionRange(endPos, endPos);
    });
    cont.addEventListener('dblclick', (e) => {
      const chip = e.target.closest('.' + chipClass);
      if (!chip) return;
      e.preventDefault();
      chips.splice(parseInt(chip.dataset.idx, 10), 1);
      render();
    });
    render();
    const api = {
      getVal: () => chips.join(isSentenceMode ? '\n' : jn),
      setVal: (str) => {
        chips = _dedupe(isSentenceMode
          ? String(str || '').split('\n').map(s => s.trim()).filter(Boolean)
          : String(str || '').split(spl || ',').map(s => s.trim()).filter(Boolean));
        render();
      },
      append: (val) => {
        if (isSentenceMode) {
          const v = String(val || '').trim();
          if (v && !chips.includes(v)) { chips.push(v); render(); }
        } else {
          const fresh = String(val || '').split(spl).map(s => s.trim()).filter(Boolean).filter(v => !chips.includes(v));
          if (fresh.length) { chips.push(...fresh); render(); }
        }
      }
    };
    cont._tagInputApi = api;   // LLM 填入函式透過 inputId+'Chips' 容器取用
    return api;
  };
  const defSep = ',', defJn = ', ';
  const exSep = null, exJn = "\n";   // 例句模式：sep=null（逗號屬句子一部分，Enter 整句一顆）
  const deckDefChips = _tagInput('deckAddDefChips', 'deckAddDef', 'def-chip', '', defSep, defJn, 'display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:100px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s');
  const deckExChips = _tagInput('deckAddExChips', 'deckAddExample', 'ex-chip', '', exSep, exJn, 'display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:6px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s');
  // 統一膠囊：相似/反義/衍生物/相關詞/詞形變化（逗號分割、Enter 入膠囊）
  const _pillStyle = 'display:inline-flex;align-items:center;gap:4px;padding:1px 10px;border-radius:100px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s';
  const deckSynChips = _tagInput('deckAddSynonymChips', 'deckAddSynonym', 'pill-chip', '', ',', ', ', _pillStyle);
  const deckAntChips = _tagInput('deckAddAntonymChips', 'deckAddAntonym', 'pill-chip', '', ',', ', ', _pillStyle);
  const deckDerivChips = _tagInput('deckAddDerivativeChips', 'deckAddDerivative', 'pill-chip', '', ',', ', ', _pillStyle);
  const deckRelChips = _tagInput('deckAddRelatedChips', 'deckAddRelated', 'pill-chip', '', ',', ', ', _pillStyle);
  const deckFormsChips = _tagInput('deckAddFormsChips', 'deckAddForms', 'pill-chip', '', ',', ', ', _pillStyle);
  // ── POS chips ───
  const _posCN = {noun:'名詞',verb:'動詞',adjective:'形容詞',adverb:'副詞',preposition:'介係詞',conjunction:'連接詞',pronoun:'代名詞',interjection:'感嘆詞',exclamation:'感嘆詞',determiner:'限定詞',article:'冠詞',phrase:'片語',idiom:'慣用語',suffix:'後綴',prefix:'前綴',abbreviation:'縮寫','plural noun':'複數名詞'};
  const _normalizePos = (pos) => (pos || '').split(',').map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(Boolean).join(', ');
  const _getPosVal = () => Array.from(document.querySelectorAll('#deckAddPosGroup .pos-chip.selected')).map(el => el.dataset.pos).join(', ');
  const _selectPosChips = (posStr) => {
    const vals = posStr.split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('#deckAddPosGroup .pos-chip').forEach(chip => {
      const on = vals.includes(chip.dataset.pos);
      chip.classList.toggle('selected', on);
      chip.style.background = on ? 'var(--accent)' : 'var(--bg-surface)';
      chip.style.color = on ? 'var(--accent-on)' : 'var(--text-secondary)';
      chip.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    });
  };
  document.getElementById('deckAddPosGroup')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.pos-chip');
    if (!chip) return;
    chip.classList.toggle('selected');
    const on = chip.classList.contains('selected');
    chip.style.background = on ? 'var(--accent)' : 'var(--bg-surface)';
    chip.style.color = on ? 'var(--accent-on)' : 'var(--text-secondary)';
    chip.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
  });

  // ── Auto-fill chain ───
  // G19/G20：db.js export 的是裸函式（無 db namespace）→ 原寫 .db.getSetting 恆拋
  // TypeError 被 catch 吞掉＝autoFillOrder 永遠存不進/讀不到（存取路徑全啞）。
  // G20：寫入分隔符統一 '|'（canonical，與 CLI join('|') 對齊；GUI 讀端 split(/[,|;]/) 已容忍）。
  let autoFillChain = [...AUTO_FILL_DEFAULT];
  (async () => {
    try {
      const { getSetting } = await import('../lib/db.js');
      const saved = await getSetting('autoFillOrder');
      if (saved) { const arr = saved.split(/[,|;]/).map(s => s.trim()).filter(Boolean); if (arr.length) autoFillChain = _normalizeAutoChain(arr); }
      _renderAutoOrderChips();
    } catch (_) {}
  })();
  const getChain = () => autoFillChain;
  const _renderAutoOrderChips = () => {
    const el = document.getElementById('deckAddAutoOrderChips');
    if (!el) return;
    el.innerHTML = autoFillChain.map((s, i) =>
      `<span class="auto-order-chip" data-idx="${i}" style="cursor:pointer;padding:2px 10px;border-radius:100px;font-size:12px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);transition:background-color .15s,border-color .15s,color .15s">${i + 1}. ${AUTO_FILL_LABELS[s] || s} ›</span>`
    ).join('');
    el.querySelectorAll('.auto-order-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const idx = parseInt(chip.dataset.idx, 10);
        if (idx < autoFillChain.length - 1) {
          [autoFillChain[idx], autoFillChain[idx + 1]] = [autoFillChain[idx + 1], autoFillChain[idx]];
          _renderAutoOrderChips();
          (async () => { try { const { setSetting } = await import('../lib/db.js'); await setSetting('autoFillOrder', autoFillChain.join('|')); } catch (_) {} })();
        }
      });
    });
  };
  _renderAutoOrderChips();

  // 新增器連續輸入：最後一欄 Enter 觸發的儲存，存完直接開下一筆（點新增鈕則照舊關閉）
  let _addEnterChain = false;
  // ── Save handler ───
  document.getElementById('deckAddSave')?.addEventListener('click', async () => {
    const _chained = _addEnterChain; _addEnterChain = false;
    const tagCbs = document.querySelectorAll('#deckAddTagGroup .deck-add-tag-checkbox:checked');
    // 殘留沖洗：沒按 Enter 的輸入框內容併入膠囊（片語換行模式：整段一切行併入）
    for (const [el, ch] of [['deckAddSynonym', deckSynChips], ['deckAddAntonym', deckAntChips], ['deckAddDerivative', deckDerivChips], ['deckAddRelated', deckRelChips], ['deckAddForms', deckFormsChips]]) {
      const e2 = document.getElementById(el);
      if (e2 && e2.value.trim()) { ch.append(e2.value.trim()); e2.value = ''; }
    }
    const data = {
      word: document.getElementById('deckAddWord')?.value.trim() || '',
      definition: deckDefChips.getVal() || document.getElementById('deckAddDef')?.value.trim() || '',
      pos: _getPosVal(),
      pron: document.getElementById('deckAddPron')?.value.trim() || '',
      example: deckExChips.getVal() || document.getElementById('deckAddExample')?.value.trim() || '',
      description: document.getElementById('deckAddDesc')?.value.trim() || '',
      synonym: deckSynChips.getVal(),
      antonym: deckAntChips.getVal(),
      derivative: deckDerivChips.getVal(),
      related: deckRelChips.getVal().split(/[,，]/).map(x => x.trim()).filter(Boolean),
      forms: deckFormsChips.getVal().split(/[,，]/).map(x => x.trim()).filter(Boolean),
      etymology: document.getElementById('deckAddEtymology')?.value.trim() || '',
      syllables: document.getElementById('deckAddSyllables')?.value.trim() || '',
      phrases: '',
      deck: document.getElementById('deckAddDeck')?.value || 'Default',
      tags: Array.from(tagCbs).map(cb => cb.value),
    };
    if (!data.word) { toast('請輸入單字', 'toast-error'); return; }
    data.word = data.word.toLowerCase();

    try {
      const dup = s.state.words.find(w => w.word.toLowerCase().trim() === data.word);
      if (dup) { close(); showDeckMergeModal(s, dup, data); return; }
      const added = await s.actions.addWord(data);
      await addImgPicker.persist(added?.id);   // IMG1: 新增字帶圖
      toast(`已新增「${data.word}」`, 'toast-success');
      close();
      renderInPlace(s);
      if (_chained) openAddModal(s);   // 連續新增：直接開下一筆
    } catch (e) { toast('儲存失敗: ' + e, 'toast-error'); }
  });

  // 相似/反義/衍生物 sparkle（新增 modal；單鈕觸發 → 三欄空欄一包填入）
  for (const btn of ['deckAddFillSynonym', 'deckAddFillAntonym', 'deckAddFillDerivative']) {
    document.getElementById(btn)?.addEventListener('click', () => {
      const w = document.getElementById('deckAddWord')?.value.trim();
      if (!w) { toast('請先輸入單字', 'toast-error'); return; }
      llmFillSynAntDeriv('deckAdd', w);
    });
  }

  document.getElementById('deckAddFillRelated')?.addEventListener('click', () => {
    const w = document.getElementById('deckAddWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    llmFillRelated('deckAddRelated', w);
  });

  document.getElementById('deckAddFillForms')?.addEventListener('click', () => {
    const w = document.getElementById('deckAddWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    llmFillForms('deckAddForms', w);
  });

  // ENGINE3: 音節／字源獨立鈕（走 mwFillExtra＝引擎三欄；只填空欄，片語併入例句）
  document.getElementById('deckAddFillExtra')?.addEventListener('click', () => {
    const w = document.getElementById('deckAddWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    mwFillExtra('deckAdd', fSet, fGet, w);
  });

  // ── Auto-fill（ENGINE3 起 g/s 提升 modal 層：autoFillAll＋音節字源鈕共用；fGet/fSet 避開 modal 參數 s）───
  let _lastAutoFilled = '';
  const fGet = id => {
    if (id === 'deckAddPos') return _getPosVal();
    if (id === 'deckAddDef') return deckDefChips.getVal() || document.getElementById('deckAddDef')?.value.trim() || '';
    if (id === 'deckAddExample') return deckExChips.getVal() || document.getElementById('deckAddExample')?.value.trim() || '';
    return document.getElementById(id)?.value?.trim() || '';
  };
  const fSet = (id, val) => {
    if (!val) return;
    if (id === 'deckAddDef') { if (!fGet('deckAddDef')) deckDefChips.setVal(val); }
    else if (id === 'deckAddExample') { if (!fGet('deckAddExample')) deckExChips.setVal(val); }
    // 片語已併入例句：韋氏/LLM 片語去重接續進例句膠囊
    else if (id === 'deckAddExampleAppend') { if (val) deckExChips.setVal(mergeExamplePhrases(deckExChips.getVal() || document.getElementById('deckAddExample')?.value.trim() || '', val)); }
    else { const e = document.getElementById(id); if (e && !e.value.trim()) e.value = val; }
  };
  const autoFillAll = async () => {
    const w = document.getElementById('deckAddWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    const btn = document.getElementById('deckAddAutoFill');
    if (btn) btn.disabled = true;
    const g = fGet, s = fSet;
    const chain = getChain();
    let cambridgeFailed = false;
    for (const src of chain) {
      if (src === 'cambridge') {
        try {
          const json = await lookupCambridge(w, 'zh');
          const d = JSON.parse(json);
          s('deckAddWord', d.word);
          s('deckAddPron', d.uk_ipa || d.us_ipa);
          if (d.senses?.length) {
            const hasZh = 'translation' in d.senses[0];
            const defs = [...new Set(d.senses.map(s => (hasZh ? s.translation : s.definition)).filter(Boolean))].map(d => d.replace(/;/g, ','));
            const pos = [...new Set(d.senses.flatMap(s => (s.part_of_speech || '').split(',').map(p => p.trim())).filter(Boolean))];
            s('deckAddDef', defs.join(', '));
            _selectPosChips(_normalizePos(pos.join(', ')));
            const exs = [...new Set(d.senses.flatMap(s => (s.examples || []).map(ex => hasZh ? ex.english : (typeof ex === 'string' ? ex : ex.english))).filter(Boolean))];
            if (exs.length && !g('deckAddExample')) s('deckAddExample', exs.join('\n'));
          }
        } catch (e) { cambridgeFailed = true; }
      } else if (src === 'merriam') {
        // 韋氏鏈步驟：有 key 才跑（音節/字源/片語只填空欄；無 key 靜默跳過不擋後續）
        try { await mwFillExtra('deckAdd', s, g, w); } catch (_) {}
      } else if (src === 'dict-api') {
        try {
          const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
          if (r.ok) {
            const exs = (await r.json()).flatMap(e =>
              (e.meanings || []).flatMap(m => (m.definitions || []).map(d => d.example).filter(Boolean))
            );
            if (exs.length && !g('deckAddExample')) s('deckAddExample', exs.join('\n'));
          }
        } catch (e) {}
      } else if (src === 'tatoeba') {
        try {
          const r = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w)}&lang=eng`);
          if (r.ok) {
            const exs = ((await r.json()).data || []).map(s => s.text).filter(Boolean);
            if (exs.length && !g('deckAddExample')) s('deckAddExample', exs.join('\n'));
          }
        } catch (e) {}
      } else if (src === 'llm') {
        if (!g('deckAddDef') || !g('deckAddPos') || !g('deckAddPron') || !g('deckAddExample') || !g('deckAddRelated') || !g('deckAddForms') || !g('deckAddEtymology')) {
          try {
            // Ollama 位址：設定頁 store 優先（modal 內無 llmUrl 元素時 fallback 本機）
            const baseUrl = (store.state.ollamaUrl || document.getElementById('llmUrl')?.value?.trim()?.replace(/\/api\/generate$/, '') || 'http://localhost:11434');
            const tagsResp = await fetchGet(`${baseUrl}/api/tags`);
            const models = (JSON.parse(tagsResp).models || []).map(m => m.name);
            if (models.length) {
              const model = models[0];
              if (!g('deckAddDef')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model,
                  `用繁體中文列出「${w}」的定義。多個定義用「、」分隔。只回傳定義，不要其他內容。`
                );
                if (t) s('deckAddDef', t.trim().replace(/、/g, ', '));
              }
              if (!g('deckAddPos')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model,
                  `What is/are the part(s) of speech of "${w}"? Return comma-separated English labels only (e.g. noun, verb, adjective).`
                );
                if (t) _selectPosChips(_normalizePos(t.trim()));
              }
              if (!g('deckAddExample')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model,
                  `Generate a short English example sentence using "${w}". Return ONLY the sentence, nothing else.`
                );
                if (t) s('deckAddExample', t.trim());
              }
              await Promise.all([
                llmFillRelated('deckAddRelated', w),
                llmFillForms('deckAddForms', w),
                llmFillSynAntDeriv('deckAdd', w),
                (async () => {
                  // 字源：LLM 一鍵分支順手補（只填空欄；韋氏在鏈內時先寫者勝；音節只吃韋氏）
                  const bUrl = (store.state.ollamaUrl || 'http://localhost:11434');
                  const mdl = store.state.ollamaModel || (models[0] || 'qwen2.5-coder:7b');
                  if (!g('deckAddEtymology')) {
                    try {
                      const t = await fetchLLM(`${bUrl}/api/generate`, mdl,
                        `用繁體中文一句話說明英文單字「${w}」的字源（來自何語、何詞根）。只回傳這一句，不要其他內容。`);
                      if (t) s('deckAddEtymology', t.trim());
                    } catch (_) {}
                  }
                  // 片語已併入例句：LLM 片語去重接續進例句（韋氏鏈步驟有 key 時走韋氏，此處不搶）
                  try {
                    const t = await fetchLLM(`${bUrl}/api/generate`, mdl,
                      `List 3-5 common English phrases or collocations using the word "${w}", one per line. Return ONLY the phrases, nothing else.`);
                    if (t) s('deckAddExampleAppend', [...new Set(t.trim().split('\n').map(x => x.trim()).filter(Boolean))].join('\n'));
                  } catch (_) {}
                })()
              ]);
            }
          } catch (e) { toast('LLM 連線失敗，請確認 Ollama 有開', 'toast-error'); }
        }
      }
    }
    if (cambridgeFailed) toast('Cambridge 查詢失敗，已用其他來源', 'toast-warn');
    // 舊鏈回補：存檔鏈不含 merriam（v5.16.3 前存的）才跑；新鏈走鏈內步驟
    if (!chain.includes('merriam')) { try { await mwFillExtra('deckAdd', s, g, w); } catch (_) {} }
    if (btn) btn.disabled = false;
    _lastAutoFilled = w;
  };
  document.getElementById('deckAddAutoFill')?.addEventListener('click', autoFillAll);
  document.getElementById('deckAddWord')?.addEventListener('blur', () => {
    const w = document.getElementById('deckAddWord')?.value.trim();
    if (w && w !== _lastAutoFilled) autoFillAll();
  });

  // Enter 導覽（由上而下；描述/字源 textarea 需 Ctrl+Enter；膠囊欄空 Enter 跳轉、有字就地存膠囊）
  const addFieldIds = ['deckAddWord', 'deckAddDef', 'deckAddPron', 'deckAddSyllables', 'deckAddExample', 'deckAddDesc', 'deckAddRelated', 'deckAddForms', 'deckAddSynonym', 'deckAddAntonym', 'deckAddDerivative', 'deckAddEtymology', 'deckAddDeck'];
  const _addJumpNext = (curId) => {
    const idx = addFieldIds.indexOf(curId);
    if (idx === -1) return;
    if (idx < addFieldIds.length - 1) {
      document.getElementById(addFieldIds[idx + 1])?.focus();
    } else {
      _addEnterChain = true;
      document.getElementById('deckAddSave')?.click();
    }
  };
  document.getElementById('deckAddModal')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (el.tagName === 'TEXTAREA') {
      // 描述/字源：普通 Enter 換行；Ctrl/Cmd+Enter 跳下一欄
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); _addJumpNext(el.id); }
      return;
    }
    if ((el.id === 'deckAddDef' || el.id === 'deckAddExample') && el.value.trim()) return;
    const idx = addFieldIds.indexOf(el.id);
    if (idx === -1) return;
    e.preventDefault();
    if (el.id === 'deckAddWord') autoFillAll();
    _addJumpNext(el.id);
  });

  // ── Example fill（片語已併入例句：韋氏片語同為候選）──
  document.getElementById('deckAddFillExample')?.addEventListener('click', async () => {
    const w = document.getElementById('deckAddWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    const chain = getChain();
    for (const src of chain) {
      let ex = '';
      try {
        if (src === 'merriam') {
          // ENGINE3: 韋氏片語候選走引擎（phrase 併例句；引擎以 chips 現值去重，取首句未收錄者＝同舊 find 語意）
          const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
          if (dk || tk) {
            const cur = deckExChips.getVal() || '';
            const r = await _engineMw(w, { phrase: 'merriam' }, { example: cur, phrases: '' });
            if (r.patch?.example) {
              const have = new Set(cur.split('\n').map(x => x.trim()).filter(Boolean));
              ex = r.patch.example.split('\n').map(x => x.trim()).filter(Boolean).find(x => !have.has(x)) || '';
            }
          }
        } else if (src === 'cambridge' || src === 'dict-api' || src === 'tatoeba') {
          // ENGINE3: 其餘來源走引擎 example 單句模式（空底全取候選、取首句照收；同舊無去重語意）
          // deck 例句鈕舊程式本無 llm 路，chain 雖含 llm 此處照舊略過
          const r = await _engineMw(w, { example: src }, { example: '' });
          if (r.patch?.example) ex = r.patch.example.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
        }
      } catch (_) {}
      if (ex) { deckExChips.append(ex); break; }
    }
  });
}

function openEditModal(s, id) {
  const w = s.state.words.find(x => x.id === id);
  if (!w) return;
  const decks = s.state.decks;
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const existing = document.getElementById('deckEditModal');
  if (existing) existing.remove();

  const html = `
    <div class="modal-overlay open" id="deckEditModal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${icon('edit')} 編輯單字</div>
          <button class="modal-close" id="deckEditModalClose">${icon('x')}</button>
        </div>
        <div class="form-group">
          <label class="form-label">單字 *</label>
          <input class="form-input" id="deckEditWord" value="${escapeAttr(w.word)}">
        </div>
        <div class="form-group">
          <label class="form-label">定義</label>
          <input class="form-input" id="deckEditDef" placeholder="多個定義用逗號分隔">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditDefChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">詞性</label>
            <div style="display:flex;flex-wrap:wrap;gap:4px" id="deckEditPosGroup">
              ${['名詞','動詞','形容詞','副詞','介係詞','連接詞','代名詞','感嘆詞','限定詞','冠詞','片語','慣用語','後綴','前綴','縮寫','複數名詞'].map(p => {
                const sel = (w.pos || '').split(',').map(s => s.trim()).includes(p);
                return `<span class="pos-chip ${sel ? 'selected' : ''}" data-pos="${p}" style="cursor:pointer;padding:2px 10px;border-radius:100px;font-size:12px;border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};background:${sel ? 'var(--accent)' : 'var(--bg-surface)'};color:${sel ? 'var(--accent-on)' : 'var(--text-secondary)'};transition:background-color .15s,border-color .15s,color .15s">${p}</span>`;
              }).join('')}
            </div>
          </div>
        <div class="form-row" style="${isMobile ? 'flex-direction:column' : ''}">
          <div class="form-group" style="flex:1">
            <label class="form-label">發音</label>
            <input class="form-input" id="deckEditPron" value="${escapeAttr(w.pron || '')}">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">音節</label>
            <div style="display:flex;gap:4px"><input class="form-input" id="deckEditSyllables" placeholder="例：dict·io·nary；Enter 跳下一欄" value="${escapeAttr(w.syllables || '')}" style="flex:1"><button class="btn btn-sm" id="deckEditFillExtra" type="button" title="韋氏補上音節／字源（片語併入例句；只填空欄）">${icon('sparkle')}</button></div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">例句（含片語）</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckEditExample" placeholder="輸入後按 Enter（一行一筆；片語同一欄）" style="flex:1"><button class="btn btn-sm" id="deckEditFillExample" type="button">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditExChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">描述</label>
          <textarea class="form-input" id="deckEditDesc" rows="2" style="resize:vertical" placeholder="補充說明、記憶技巧...；Ctrl+Enter 跳下一欄">${escapeHtml(w.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">相關詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckEditRelated" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckEditFillRelated" type="button">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditRelatedChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">詞形變化</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckEditForms" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckEditFillForms" type="button">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditFormsChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">相似詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckEditSynonym" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckEditFillSynonym" type="button" title="LLM 自動產生相似詞">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditSynonymChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">反義詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckEditAntonym" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckEditFillAntonym" type="button" title="LLM 自動產生反義詞">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditAntonymChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">衍生物</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="deckEditDerivative" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="deckEditFillDerivative" type="button" title="LLM 自動產生衍生物">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="deckEditDerivativeChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">字源</label>
          <textarea class="form-input" id="deckEditEtymology" rows="2" style="resize:vertical" placeholder="字源與首次使用年份；Ctrl+Enter 跳下一欄">${escapeHtml(w.etymology || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">字本</label>
          <select class="form-input" id="deckEditDeck">
            ${decks.map(d => `<option value="${escapeAttr(d.name)}" ${w.deck === d.name ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">圖片 <span class="hint-inline" style="font-size:11px;color:var(--text-tertiary)">（可多張；儲存時全量替換）</span></label>
          <div id="deckEditImgsThumbs"></div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-top:6px">
            <input type="file" id="deckEditImgFiles" accept="image/*" multiple style="display:none">
            <button class="btn btn-sm" type="button" id="deckEditImgPick">${icon('image')} 選擇圖片</button>
            <span style="font-size:11px;color:var(--text-tertiary)">PNG/JPG；單張 ≤10MB</span>
          </div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-top:6px">
            <input class="form-input" id="deckEditImgUrl" placeholder="或貼圖片連結…（直連 .gif/.jpg，或 Tenor 分享頁）" style="flex:1">
            <button class="btn btn-sm" type="button" id="deckEditImgUrlAdd">加入</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">標籤</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="deckEditTagGroup">
            ${tagPickerHtml(s.state.systemTags || [], s.state.tags || [], w.tags || [], 'deck-tag-checkbox')}
          </div>
        </div>
        <div class="form-group" style="border-top:1px solid var(--border);padding-top:var(--s2);margin-top:var(--s2)">
          <label class="form-label">自動填入順序 <span style="font-size:11px;color:var(--text-tertiary)">（點 chip 往後移）</span></label>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:var(--s2)" id="deckEditAutoOrderChips"></div>
          <div style="display:flex;gap:var(--s2);align-items:center">
            <button class="btn" id="deckEditAutoFill">${icon('search')} 自動填入</button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-danger" id="deckEditDelete" style="margin-right:auto">${icon('trash')} 刪除</button>
          <button class="btn" id="deckEditCancel">取消</button>
          <button class="btn-primary" id="deckEditSave">${icon('check')} 儲存</button>
        </div>
      </div>
    </div>`;

  container.insertAdjacentHTML('beforeend', html);

  const close = () => document.getElementById('deckEditModal')?.remove();
  document.getElementById('deckEditModalClose')?.addEventListener('click', close);
  document.getElementById('deckEditCancel')?.addEventListener('click', close);
  document.getElementById('deckEditModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckEditModal') close();
  });

  // IMG1: 圖片選擇器（編輯字：預載現圖）
  const editImgPicker = attachImagePicker({ thumbsId: 'deckEditImgsThumbs', pickId: 'deckEditImgPick', filesId: 'deckEditImgFiles', wordId: w.id, urlInputId: 'deckEditImgUrl', urlAddId: 'deckEditImgUrlAdd' });

  // ── Tag input for definition & example ───
  // _tagInputEdit 與 _tagInput 同款（統一膠囊系統 v2：例句模式/草稿保留/API 掛載）
  const _tagInputEdit = (containerId, inputId, chipClass, initialVal, sep, jn, style) => {
    const cont = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    const isSentenceMode = sep === null || sep === undefined;
    const spl = isSentenceMode ? null : new RegExp(sep);
    // 同欄去重（編輯器重開不再把膠囊值複製一次；保留首次出現順序）
    const _dedupe = (arr) => [...new Set(arr)];
    let chips = _dedupe(isSentenceMode
      ? (initialVal || '').split('\n').map(s => s.trim()).filter(Boolean)
      : (initialVal || '').split(spl).map(s => s.trim()).filter(Boolean));
    const render = () => {
      cont.innerHTML = '';
      chips.forEach((d, i) => {
        const el = document.createElement('span');
        el.className = chipClass;
        el.textContent = d;
        el.dataset.idx = i;
        el.style.cssText = style;
        el.title = '點擊編輯，雙擊刪除';
        cont.appendChild(el);
      });
    };
    const parseInput = (v) => isSentenceMode
      ? v.trim() ? [v.trim()] : []
      : v.split(spl).map(s => s.trim()).filter(Boolean);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const vals = parseInput(input.value);
        if (vals.length) {
          // 有打字就地消化：只收膠囊沒有的新值（重複的不再塞一次），不清跳轉
          const fresh = vals.filter(v => !chips.includes(v));
          if (fresh.length) { chips.push(...fresh); render(); }
          input.value = '';
          e.stopPropagation();
        }
      }
    });
    cont.addEventListener('click', (e) => {
      const chip = e.target.closest('.' + chipClass);
      if (!chip) { input.focus(); return; }
      const idx = parseInt(chip.dataset.idx, 10);
      const clicked = chips[idx];
      const draft = input.value.trim();
      chips.splice(idx, 1);
      if (draft) {
        if (isSentenceMode) {
          chips.unshift(draft);   // 例句：半成品先存回膠囊
        } else {
          const vals = draft.split(spl).map(x => x.trim()).filter(Boolean); vals.push(clicked); input.value = vals.join(jn);
          render();
          input.focus();
          const endPos = input.value.length;
          input.setSelectionRange(endPos, endPos);
          return;
        }
      }
      input.value = clicked;
      render();
      input.focus();
      const endPos = input.value.length;
      input.setSelectionRange(endPos, endPos);
    });
    cont.addEventListener('dblclick', (e) => {
      const chip = e.target.closest('.' + chipClass);
      if (!chip) return;
      e.preventDefault();
      chips.splice(parseInt(chip.dataset.idx, 10), 1);
      render();
    });
    render();
    const api = {
      getVal: () => chips.join(isSentenceMode ? '\n' : jn),
      setVal: (str) => {
        chips = _dedupe(isSentenceMode
          ? String(str || '').split('\n').map(s => s.trim()).filter(Boolean)
          : String(str || '').split(spl || ',').map(s => s.trim()).filter(Boolean));
        render();
      },
      append: (val) => {
        if (isSentenceMode) {
          const v = String(val || '').trim();
          if (v && !chips.includes(v)) { chips.push(v); render(); }
        } else {
          const fresh = String(val || '').split(spl).map(s => s.trim()).filter(Boolean).filter(v => !chips.includes(v));
          if (fresh.length) { chips.push(...fresh); render(); }
        }
      }
    };
    cont._tagInputApi = api;
    return api;
  };
  const defSep = ',', defJn = ', ', exSep = null, exJn = '\n';   // 例句模式
  const editDefChips = _tagInputEdit('deckEditDefChips', 'deckEditDef', 'def-chip', w.definition || '', defSep, defJn, 'display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:100px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s');
  const editExChips = _tagInputEdit('deckEditExChips', 'deckEditExample', 'ex-chip', mergeExamplePhrases(w.example, w.phrases), exSep, exJn, 'display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:6px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s');
  // 統一膠囊（編輯 modal）：既有值預載入膠囊
  const _pillStyleE = 'display:inline-flex;align-items:center;gap:4px;padding:1px 10px;border-radius:100px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s';
  const editSynChips = _tagInputEdit('deckEditSynonymChips', 'deckEditSynonym', 'pill-chip', w.synonym || '', ',', ', ', _pillStyleE);
  const editAntChips = _tagInputEdit('deckEditAntonymChips', 'deckEditAntonym', 'pill-chip', w.antonym || '', ',', ', ', _pillStyleE);
  const editDerivChips = _tagInputEdit('deckEditDerivativeChips', 'deckEditDerivative', 'pill-chip', w.derivative || '', ',', ', ', _pillStyleE);
  const editRelChips = _tagInputEdit('deckEditRelatedChips', 'deckEditRelated', 'pill-chip', (w.related || []).join(', '), ',', ', ', _pillStyleE);
  const editFormsChips = _tagInputEdit('deckEditFormsChips', 'deckEditForms', 'pill-chip', (w.forms || []).join(', '), ',', ', ', _pillStyleE);
  // ── POS chips ───
  const _getEditPosVal = () => Array.from(document.querySelectorAll('#deckEditPosGroup .pos-chip.selected')).map(el => el.dataset.pos).join(', ');
  const _selectEditPosChips = (posStr) => {
    const vals = posStr.split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('#deckEditPosGroup .pos-chip').forEach(chip => {
      const on = vals.includes(chip.dataset.pos);
      chip.classList.toggle('selected', on);
      chip.style.background = on ? 'var(--accent)' : 'var(--bg-surface)';
      chip.style.color = on ? 'var(--accent-on)' : 'var(--text-secondary)';
      chip.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    });
  };
  document.getElementById('deckEditPosGroup')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.pos-chip');
    if (!chip) return;
    chip.classList.toggle('selected');
    const on = chip.classList.contains('selected');
    chip.style.background = on ? 'var(--accent)' : 'var(--bg-surface)';
    chip.style.color = on ? 'var(--accent-on)' : 'var(--text-secondary)';
    chip.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
  });

  // ── Auto-fill ───
  let editAutoFillChain = [...AUTO_FILL_DEFAULT];
  (async () => {
    try {
      const { getSetting } = await import('../lib/db.js');
      const saved = await getSetting('autoFillOrder');
      if (saved) { const arr = saved.split(/[,|;]/).map(s => s.trim()).filter(Boolean); if (arr.length) editAutoFillChain = _normalizeAutoChain(arr); }
      _renderEditAutoOrderChips();
    } catch (_) {}
  })();
  const _renderEditAutoOrderChips = () => {
    const el = document.getElementById('deckEditAutoOrderChips');
    if (!el) return;
    el.innerHTML = editAutoFillChain.map((s, i) =>
      `<span class="auto-order-chip" data-idx="${i}" style="cursor:pointer;padding:2px 10px;border-radius:100px;font-size:12px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);transition:background-color .15s,border-color .15s,color .15s">${i + 1}. ${AUTO_FILL_LABELS[s] || s} ›</span>`
    ).join('');
    el.querySelectorAll('.auto-order-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const idx = parseInt(chip.dataset.idx, 10);
        if (idx < editAutoFillChain.length - 1) {
          [editAutoFillChain[idx], editAutoFillChain[idx + 1]] = [editAutoFillChain[idx + 1], editAutoFillChain[idx]];
          _renderEditAutoOrderChips();
          (async () => { try { const { setSetting } = await import('../lib/db.js'); await setSetting('autoFillOrder', editAutoFillChain.join('|')); } catch (_) {} })();
        }
      });
    });
  };
  _renderEditAutoOrderChips();

  let _editLastAutoFilled = '';
  // ENGINE3: g/s 提升 modal 層（editAutoFillAll＋音節字源鈕共用；fGet/fSet 避開 modal 參數 s）
  const fGetE = id => {
    if (id === 'deckEditPos') return _getEditPosVal();
    if (id === 'deckEditDef') return editDefChips.getVal() || document.getElementById('deckEditDef')?.value.trim() || '';
    if (id === 'deckEditExample') return editExChips.getVal() || document.getElementById('deckEditExample')?.value.trim() || '';
    return document.getElementById(id)?.value?.trim() || '';
  };
  const fSetE = (id, val) => {
    if (!val) return;
    if (id === 'deckEditDef') { if (!fGetE('deckEditDef')) editDefChips.setVal(val); }
    else if (id === 'deckEditExample') { if (!fGetE('deckEditExample')) editExChips.setVal(val); }
    // 片語已併入例句：韋氏/LLM 片語去重接續進例句膠囊
    else if (id === 'deckEditExampleAppend') { if (val) editExChips.setVal(mergeExamplePhrases(editExChips.getVal() || document.getElementById('deckEditExample')?.value.trim() || '', val)); }
    else { const e = document.getElementById(id); if (e && !e.value.trim()) e.value = val; }
  };
  const editAutoFillAll = async () => {
    const w = document.getElementById('deckEditWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    const btn = document.getElementById('deckEditAutoFill');
    if (btn) btn.disabled = true;
    const g = fGetE, s = fSetE;
    let cambridgeFailed = false;
    for (const src of editAutoFillChain) {
      if (src === 'cambridge') {
        try {
          const json = await lookupCambridge(w, 'zh');
          const d = JSON.parse(json);
          s('deckEditWord', d.word);
          s('deckEditPron', d.uk_ipa || d.us_ipa);
          if (d.senses?.length) {
            const hasZh = 'translation' in d.senses[0];
            const defs = [...new Set(d.senses.map(s => (hasZh ? s.translation : s.definition)).filter(Boolean))].map(d => d.replace(/;/g, ','));
            const pos = [...new Set(d.senses.flatMap(s => (s.part_of_speech || '').split(',').map(p => p.trim())).filter(Boolean))];
            s('deckEditDef', defs.join(', '));
            _selectEditPosChips(_normalizePos(pos.join(', ')));
            const exs = [...new Set(d.senses.flatMap(s => (s.examples || []).map(ex => hasZh ? ex.english : (typeof ex === 'string' ? ex : ex.english))).filter(Boolean))];
            if (exs.length && !g('deckEditExample')) s('deckEditExample', exs.join('\n'));
          }
        } catch (e) { cambridgeFailed = true; }
      } else if (src === 'merriam') {
        // 韋氏鏈步驟：有 key 才跑（音節/字源/片語只填空欄；無 key 靜默跳過不擋後續）
        try { await mwFillExtra('deckEdit', s, g, w); } catch (_) {}
      } else if (src === 'dict-api') {
        try {
          const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
          if (r.ok) {
            const exs = (await r.json()).flatMap(e => (e.meanings || []).flatMap(m => (m.definitions || []).map(d => d.example).filter(Boolean)));
            if (exs.length && !g('deckEditExample')) s('deckEditExample', exs.join('\n'));
          }
        } catch (e) {}
      } else if (src === 'tatoeba') {
        try {
          const r = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w)}&lang=eng`);
          if (r.ok) {
            const exs = ((await r.json()).data || []).map(s => s.text).filter(Boolean);
            if (exs.length && !g('deckEditExample')) s('deckEditExample', exs.join('\n'));
          }
        } catch (e) {}
      } else if (src === 'llm') {
        if (!g('deckEditDef') || !g('deckEditPos') || !g('deckEditPron') || !g('deckEditExample') || !g('deckEditRelated') || !g('deckEditForms') || !g('deckEditEtymology')) {
          try {
            // Ollama 位址：設定頁 store 優先（modal 內無 llmUrl 元素時 fallback 本機）
            const baseUrl = (store.state.ollamaUrl || document.getElementById('llmUrl')?.value?.trim()?.replace(/\/api\/generate$/, '') || 'http://localhost:11434');
            const tagsResp = await fetchGet(`${baseUrl}/api/tags`);
            const models = (JSON.parse(tagsResp).models || []).map(m => m.name);
            if (models.length) {
              const model = models[0];
              if (!g('deckEditDef')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model, `用繁體中文列出「${w}」的定義。多個定義用「、」分隔。只回傳定義，不要其他內容。`);
                if (t) s('deckEditDef', t.trim().replace(/、/g, ', '));
              }
              if (!g('deckEditPos')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model, `What is/are the part(s) of speech of "${w}"? Return comma-separated English labels only (e.g. noun, verb, adjective).`);
                if (t) _selectEditPosChips(_normalizePos(t.trim()));
              }
              if (!g('deckEditExample')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model, `Generate a short English example sentence using "${w}". Return ONLY the sentence, nothing else.`);
                if (t) s('deckEditExample', t.trim());
              }
              await Promise.all([
                llmFillRelated('deckEditRelated', w),
                llmFillForms('deckEditForms', w),
                llmFillSynAntDeriv('deckEdit', w),
                (async () => {
                  // 字源：LLM 一鍵分支順手補（只填空欄；韋氏在鏈內時先寫者勝；音節只吃韋氏）
                  const bUrl = (store.state.ollamaUrl || 'http://localhost:11434');
                  const mdl = store.state.ollamaModel || (model || 'qwen2.5-coder:7b');
                  if (!g('deckEditEtymology')) {
                    try {
                      const t = await fetchLLM(`${bUrl}/api/generate`, mdl,
                        `用繁體中文一句話說明英文單字「${w}」的字源（來自何語、何詞根）。只回傳這一句，不要其他內容。`);
                      if (t) s('deckEditEtymology', t.trim());
                    } catch (_) {}
                  }
                  // 片語已併入例句：LLM 片語去重接續進例句（韋氏鏈步驟有 key 時走韋氏，此處不搶）
                  try {
                    const t = await fetchLLM(`${bUrl}/api/generate`, mdl,
                      `List 3-5 common English phrases or collocations using the word "${w}", one per line. Return ONLY the phrases, nothing else.`);
                    if (t) s('deckEditExampleAppend', [...new Set(t.trim().split('\n').map(x => x.trim()).filter(Boolean))].join('\n'));
                  } catch (_) {}
                })()
              ]);
            }
          } catch (e) { toast('LLM 連線失敗，請確認 Ollama 有開', 'toast-error'); }
        }
      }
    }
    if (cambridgeFailed) toast('Cambridge 查詢失敗，已用其他來源', 'toast-warn');
    // 舊鏈回補：存檔鏈不含 merriam（v5.16.3 前存的）才跑；新鏈走鏈內步驟
    if (!editAutoFillChain.includes('merriam')) { try { await mwFillExtra('deckEdit', s, g, w); } catch (_) {} }
    if (btn) btn.disabled = false;
    _editLastAutoFilled = w;
  };
  document.getElementById('deckEditAutoFill')?.addEventListener('click', editAutoFillAll);
  document.getElementById('deckEditWord')?.addEventListener('blur', () => {
    const w = document.getElementById('deckEditWord')?.value.trim();
    if (w && w !== _editLastAutoFilled) editAutoFillAll();
  });

  // Enter 導覽（由上而下；描述/字源 textarea 需 Ctrl+Enter；膠囊欄空 Enter 跳轉、有字就地存膠囊）
  const editFieldIds = ['deckEditWord', 'deckEditDef', 'deckEditPron', 'deckEditSyllables', 'deckEditExample', 'deckEditDesc', 'deckEditRelated', 'deckEditForms', 'deckEditSynonym', 'deckEditAntonym', 'deckEditDerivative', 'deckEditEtymology', 'deckEditDeck'];
  const _editJumpNext = (curId) => {
    const idx = editFieldIds.indexOf(curId);
    if (idx === -1) return;
    if (idx < editFieldIds.length - 1) {
      document.getElementById(editFieldIds[idx + 1])?.focus();
    } else {
      document.getElementById('deckEditSave')?.click();
    }
  };
  document.getElementById('deckEditModal')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (el.tagName === 'TEXTAREA') {
      // 描述/字源：普通 Enter 換行；Ctrl/Cmd+Enter 跳下一欄
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); _editJumpNext(el.id); }
      return;
    }
    if ((el.id === 'deckEditDef' || el.id === 'deckEditExample') && el.value.trim()) return;
    const idx = editFieldIds.indexOf(el.id);
    if (idx === -1) return;
    e.preventDefault();
    if (el.id === 'deckEditWord') editAutoFillAll();
    _editJumpNext(el.id);
  });

  // ── Example fill（片語已併入例句：韋氏片語同為候選；ENGINE3 起整條 chain 走引擎，取句語意同舊）──
  document.getElementById('deckEditFillExample')?.addEventListener('click', async () => {
    const w = document.getElementById('deckEditWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    for (const src of editAutoFillChain) {
      let ex = '';
      try {
        if (src === 'merriam') {
          // ENGINE3: 韋氏片語候選走引擎（phrase 併例句；取首句未收錄者＝同舊 find 語意）
          const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
          if (dk || tk) {
            const cur = editExChips.getVal() || '';
            const r = await _engineMw(w, { phrase: 'merriam' }, { example: cur, phrases: '' });
            if (r.patch?.example) {
              const have = new Set(cur.split('\n').map(x => x.trim()).filter(Boolean));
              ex = r.patch.example.split('\n').map(x => x.trim()).filter(Boolean).find(x => !have.has(x)) || '';
            }
          }
        } else if (src === 'cambridge' || src === 'dict-api' || src === 'tatoeba') {
          // ENGINE3: 其餘來源走引擎 example 單句模式（空底全取候選、取首句照收；同舊無去重語意）
          // deck 例句鈕舊程式本無 llm 路，chain 雖含 llm 此處照舊略過
          const r = await _engineMw(w, { example: src }, { example: '' });
          if (r.patch?.example) ex = r.patch.example.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
        }
      } catch (_) {}
      if (ex) { editExChips.append(ex); break; }
    }
  });

  // ── 編輯 modal sparkle 綁定（G22 補全：Related/Forms 按鈕此前存在但從未綁定＝點擊無反應）──
  document.getElementById('deckEditFillRelated')?.addEventListener('click', () => {
    const w = document.getElementById('deckEditWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    llmFillRelated('deckEditRelated', w);
  });
  document.getElementById('deckEditFillForms')?.addEventListener('click', () => {
    const w = document.getElementById('deckEditWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    llmFillForms('deckEditForms', w);
  });
  // 相似/反義/衍生物 sparkle（單鈕觸發 → 三欄空欄一包填入）
  for (const btn of ['deckEditFillSynonym', 'deckEditFillAntonym', 'deckEditFillDerivative']) {
    document.getElementById(btn)?.addEventListener('click', () => {
      const w = document.getElementById('deckEditWord')?.value.trim();
      if (!w) { toast('請先輸入單字', 'toast-error'); return; }
      llmFillSynAntDeriv('deckEdit', w);
    });
  }
  // ENGINE3: 音節／字源獨立鈕（走 mwFillExtra＝引擎三欄；只填空欄，片語併入例句）
  document.getElementById('deckEditFillExtra')?.addEventListener('click', () => {
    const w = document.getElementById('deckEditWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    mwFillExtra('deckEdit', fSetE, fGetE, w);
  });

  // ── Save handler ───
  document.getElementById('deckEditSave')?.addEventListener('click', async () => {
    const tagCbs = document.querySelectorAll('#deckEditTagGroup .deck-tag-checkbox:checked');
    // 殘留沖洗：沒按 Enter 的輸入框內容併入膠囊（片語換行模式：整段一切行併入）
    for (const [el, ch] of [['deckEditSynonym', editSynChips], ['deckEditAntonym', editAntChips], ['deckEditDerivative', editDerivChips], ['deckEditRelated', editRelChips], ['deckEditForms', editFormsChips]]) {
      const e2 = document.getElementById(el);
      if (e2 && e2.value.trim()) { ch.append(e2.value.trim()); e2.value = ''; }
    }
    const wordVal = document.getElementById('deckEditWord')?.value.trim() || '';
    if (!wordVal) { toast('請輸入單字', 'toast-error'); return; }
    const lowerWord = wordVal.toLowerCase();
    const dup = s.state.words.find(w => w.id !== id && w.word.toLowerCase().trim() === lowerWord);
    if (dup) { toast(`「${lowerWord}」已存在`, 'toast-error'); return; }
    const data = {
      word: lowerWord,
      definition: editDefChips.getVal() || document.getElementById('deckEditDef')?.value.trim() || '',
      pos: _getEditPosVal(),
      pron: document.getElementById('deckEditPron')?.value.trim() || '',
      example: mergeExamplePhrases(editExChips.getVal() || document.getElementById('deckEditExample')?.value.trim() || '', w?.phrases || ''),
      description: document.getElementById('deckEditDesc')?.value.trim() || '',
      synonym: editSynChips.getVal(),
      antonym: editAntChips.getVal(),
      derivative: editDerivChips.getVal(),
      etymology: document.getElementById('deckEditEtymology')?.value.trim() || '',
      syllables: document.getElementById('deckEditSyllables')?.value.trim() || '',
      phrases: '',
      related: editRelChips.getVal().split(/[,，]/).map(x => x.trim()).filter(Boolean),
      forms: editFormsChips.getVal().split(/[,，]/).map(x => x.trim()).filter(Boolean),
      deck: document.getElementById('deckEditDeck')?.value || 'Default',
      tags: Array.from(tagCbs).map(cb => cb.value),
    };
    try {
      await s.actions.editWord(id, data);
      await editImgPicker.persist(id);   // IMG1: 動過才全量替換寫庫
      toast(`已更新「${data.word}」`, 'toast-success');
      close();
      renderInPlace(s);
    } catch (e) { toast('儲存失敗: ' + e, 'toast-error'); }
  });

  document.getElementById('deckEditDelete')?.addEventListener('click', async () => {
    if (!confirm(`確定要刪除「${w.word}」？`)) return;
    await s.actions.deleteWord(id);
    toast(`已刪除「${w.word}」`, 'toast-success');
    close();
    renderInPlace(s);
  });

}

// ─── Card Preview ──────────────────────────────────────────
let _cardState = null;
let _cardKeyBound = false;
let _autoTimer = null;
let _cardKeyHandler = null;
let _dCardOutside = null;   // G11: deck card settings outside-click（document 常駐，重開卡片疊）
let cardSettings = {
  pronAuto: false,
  pronManual: false,
  autoAdvance: false,
  pauseAfterPron: 1.5,
  pauseBetweenCards: 3,
};
// 卡片播放設定持久化（db 設定鍵 — 換頁/重整不重置；播放狀態不存）
// 顯示類設定（正反面欄位／例句句數）統一由設定頁 master 控制，此處只留播放相關
const CARD_SETTINGS_KEY = 'deckCardSettings';
function saveCardSettings() {
  import('../lib/db.js').then(m => m.setSetting(CARD_SETTINGS_KEY, JSON.stringify({
    pronAuto: cardSettings.pronAuto,
    pronManual: cardSettings.pronManual,
    pauseAfterPron: cardSettings.pauseAfterPron,
    pauseBetweenCards: cardSettings.pauseBetweenCards,
  }))).catch(() => {});
}

function openDeckCardPreview(s, wordId) {
  const words = _deckName ? s.state.words.filter(w => w.deck === _deckName) : [];
  const filtered = filterDeckWords(words);
  const idx = filtered.findIndex(w => w.id === wordId);
  if (idx === -1) return;
  _cardState = { words: filtered, s };
  showCard(idx);
}

function showCard(idx) {
  if (!_cardState) return;
  _cardState.idx = idx;
  if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
  const { words, s } = _cardState;
  const w = words[idx];
  const total = words.length;
  const st = cardSettings;
  const panel = document.getElementById('deckCardPreview');

  if (panel) {
    const isFull = _cardState.fullscreen || false;
    panel.classList.toggle('full', isFull);
    const main = document.querySelector('.main');
    if (main) main.style.marginRight = isFull ? '0' : '50vw';
    const fullBtn = document.getElementById('deckCardFullBtn');
    if (fullBtn) fullBtn.innerHTML = icon(isFull ? 'chevronR' : 'chevronL');
    if (fullBtn) fullBtn.title = isFull ? '切換半螢幕' : '全螢幕';
    document.getElementById('deckCardCounter').textContent = `${idx + 1} / ${total}`;
    const body = document.getElementById('deckCardPreviewBody');
    body.innerHTML = cardBodyHTML(w, s);
    const newBody = body;
    if (!newBody.dataset._listeners) {
      newBody.dataset._listeners = '1';
      newBody.addEventListener('dblclick', onDeckCardBodyClick);
      newBody.addEventListener('touchstart', (e) => { _cardState._sx = e.touches[0].clientX; _cardState._sy = e.touches[0].clientY; }, { passive: true });
      newBody.addEventListener('touchend', (e) => {
        const dx = _cardState._sx - e.changedTouches[0].clientX;
        const dy = (_cardState._sy ?? e.changedTouches[0].clientY) - e.changedTouches[0].clientY;
        markDeckSwipeMoved(dx, dy);
        // 左右切換只吃水平主導的手勢：斜著往下滑（dy 大）不再誤觸換字
        if (Math.abs(dx) > 40 && Math.abs(dx) > 2 * Math.abs(dy)) {
          if (dx > 0 && _cardState.idx < _cardState.words.length - 1) { stopAuto(); showCard(_cardState.idx + 1); }
          else if (dx < 0 && _cardState.idx > 0) { stopAuto(); showCard(_cardState.idx - 1); }
        }
      }, { passive: true });
    }
    const nav = panel.querySelector('.card-panel-nav');
    document.getElementById('deckCardPrev')?.remove();
    document.getElementById('deckCardNext')?.remove();
    if (idx > 0 && nav) nav.insertBefore(btn('deckCardPrev', '‹', () => { stopAuto(); showCard(_cardState.idx - 1); }), nav.firstChild);
    if (idx < total - 1 && nav) nav.appendChild(btn('deckCardNext', '›', () => { stopAuto(); showCard(_cardState.idx + 1); }));
    scrollRuler(idx);
    // IMG1: 占位填充（換字重跑）
    mountWordImages([w.id]).catch(() => {});
    if (st.pronManual && w.pron) playCardTTS(s, w.word);
    if (cardSettings.autoAdvance) scheduleNext(idx).catch(() => {});
    return;
  }

  if (!document.getElementById('deckCardStyle')) document.head.insertAdjacentHTML('beforeend', deckCardCSS);
  if (!document.getElementById('wordImageStyle')) document.head.insertAdjacentHTML('beforeend', `<style id="wordImageStyle">${WORD_IMAGE_CSS}</style>`);
  const isFull = _cardState.fullscreen || false;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = 'none';
  const main = document.querySelector('.main');
  if (main) main.style.marginRight = isFull ? '0' : '50vw';

  document.body.insertAdjacentHTML('beforeend', mkPanelHTML(w, s, st, idx, total, words, isFull));
  bindCardEvents(s, w, idx, total, st);
  // IMG1: 首掛面板後填充
  mountWordImages([w.id]).catch(() => {});
  if (cardSettings.autoAdvance) scheduleNext(idx).catch(() => {});
}

function btn(id, text, handler) {
  const el = document.createElement('button');
  el.className = 'card-panel-nav-btn'; el.id = id; el.textContent = text;
  el.addEventListener('click', handler);
  return el;
}

const deckCardCSS = `<style id="deckCardStyle">
  .card-panel{position:fixed;top:0;right:0;width:50vw;height:100vh;background:var(--bg-surface);display:flex;flex-direction:column;z-index:1000;box-shadow:-4px 0 32px rgba(0,0,0,.18);animation:panelIn .2s ease}
  .card-panel.full{width:100vw}
  @media(max-width:600px){.card-panel{width:100vw}.card-panel:not(.full) .card-panel-toggle-full{display:none}}
  @keyframes panelIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
  .card-panel-head{display:flex;align-items:center;justify-content:space-between;padding:var(--s3) var(--s5);border-bottom:1px solid var(--border);flex-shrink:0}
  .card-panel-head-actions{display:flex;gap:4px}
  .card-panel-head-actions button{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:16px;transition:background-color .15s,border-color .15s,color .15s}
  .card-panel-head-actions button:hover{background:var(--state-hover);color:var(--text-primary)}
  .card-panel-body{flex:1;overflow-y:auto;padding:var(--s8) var(--s6);text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:var(--s4);cursor:pointer;overflow-wrap:break-word;word-break:break-word}
  .card-panel-body .card-hidden{display:none}
  .card-panel-body.revealed .card-hidden{display:flex !important}
  .card-panel-word{font-size:40px;font-weight:800;color:var(--text-primary);letter-spacing:-.5px;line-height:1.2;overflow-wrap:break-word;word-break:break-word;hyphens:auto}
  .card-panel-pron{font-size:18px;color:var(--text-tertiary)}
  .card-panel-def{font-size:22px;color:var(--text-secondary);line-height:1.6}
  .card-panel-example{font-size:14px;color:var(--text-tertiary);font-style:italic;padding:var(--s4) var(--s5);background:var(--bg-base);border-radius:12px;line-height:1.6;text-align:left;width:100%;max-width:420px;box-sizing:border-box}
  .card-panel-desc{font-size:13px;color:var(--text-tertiary);line-height:1.5;text-align:left;width:100%;max-width:420px;box-sizing:border-box;padding:var(--s2) 0}
  .card-panel-tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
  .card-panel-nav{display:flex;align-items:center;justify-content:space-between;padding:var(--s3) var(--s5);border-top:1px solid var(--border);flex-shrink:0}
  .card-panel-nav-btn{width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background-color .15s,border-color .15s,color .15s;flex-shrink:0}
  .card-panel-nav-btn:hover{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}
  .card-ruler{flex:1;height:32px;overflow-x:hidden;position:relative;margin:0 6px;cursor:pointer}
  .card-ruler::-webkit-scrollbar{display:none}
  .ruler-track{position:absolute;top:0;left:0;height:100%;pointer-events:none}
  .ruler-ind{position:absolute;top:4px;width:2px;height:22px;border-radius:2px;background:var(--accent);box-shadow:0 0 6px var(--accent);transition:left .25s cubic-bezier(.4,0,.2,1);pointer-events:none}
  .ruler-base{position:absolute;top:50%;left:0;right:0;height:1px;background:var(--border);transform:translateY(-.5px)}
  .ruler-tick{position:absolute;top:8px;height:10px;display:flex;flex-direction:column;align-items:center;gap:1px}
  .ruler-tick-line{width:1px;height:8px;background:var(--border)}
  .ruler-num{font-size:7px;color:var(--text-quaternary);white-space:nowrap;font-family:var(--mono);font-feature-settings:'tnum';line-height:1}
  .card-popover{display:none;position:absolute;top:calc(100% + 4px);right:0;background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:var(--s4);z-index:1001;width:270px;box-shadow:0 8px 32px rgba(0,0,0,.2)}
  .card-popover.open{display:block}
  .card-popover label{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-secondary);padding:4px 0}
  .card-popover label:has(input[type=checkbox]){cursor:pointer}
  .card-popover select{padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-size:12px;font-family:var(--mono)}
  .card-popover-title{font-size:11px;font-weight:600;color:var(--text-tertiary);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em}
  .card-popover-divider{border:none;border-top:1px solid var(--border);margin:8px 0}
</style>`;

function cardBodyHTML(w, s) {
  // 正反面欄位由設定頁 master 控制（cardFaceHtml＋browserFront／browserBack）
  const H = { escapeHtml, wordImageSlotHTML, splitFieldsHtml, fmtExample, wordExample, examplePoolFor, rotateExamples };
  return `<div class="card-panel-body" id="deckCardPreviewBody">
    <div class="card-face" data-face="front">${cardFaceHtml(w, s, 'browserFront', H)}</div>
    <div class="card-face" data-face="back" hidden>${cardFaceHtml(w, s, 'browserBack', H)}</div>
    <div class="card-flip-hint" data-flip-hint style="font-size:11px;color:var(--text-quaternary);margin-top:4px">點兩下看背面</div>
  </div>`;
}

// ── 字卡正反面：進卡片／換字一律先正面，點一下翻背面，再點回正面 ──
function flipDeckCardBody(body) {
  if (!body) return;
  const f = body.querySelector('[data-face="front"]');
  const b = body.querySelector('[data-face="back"]');
  if (!f || !b) return;
  const toBack = !f.hidden;
  f.hidden = toBack;
  b.hidden = !toBack;
  const hint = body.querySelector('[data-flip-hint]');
  if (hint) hint.textContent = toBack ? '點兩下回正面' : '點兩下看背面';
}

function onDeckCardBodyClick(e) {
  // 滑動換字後接著觸發的 click 不翻面（touchend 已記 _swiped）
  if (_cardState && _cardState._swiped) { _cardState._swiped = false; return; }
  // DBLFLIP1: 連點兩下才翻面（單擊留給點字發音；使用者 2026-09-10 裁示）
  // 點到「文字內容」不翻面（bindSpeakClick 委派發音並 stopPropagation）
  if (e.target.closest('.card-panel-word, .card-panel-pron, .card-panel-def, .card-panel-example, .card-panel-desc, .card-panel-tags, .split-badge, .chip-accent, .chip-subtle, .wimg-slot-wrap')) return;
  flipDeckCardBody(document.getElementById('deckCardPreviewBody'));
}

function markDeckSwipeMoved(dx, dy) {
  if (_cardState && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) _cardState._swiped = true;
}

function mkPanelHTML(w, s, st, idx, total, words, isFull) {
  return `<div class="card-panel${isFull ? ' full' : ''}" id="deckCardPreview">
    <div class="card-panel-head">
      <span id="deckCardCounter" style="font-size:13px;font-weight:600;color:var(--text-tertiary);font-family:var(--mono);font-feature-settings:'tnum'">${idx + 1} / ${total}</span>
      <div class="card-panel-head-actions" style="position:relative">
        <button title="設定" id="deckCardSettingsBtn">${icon('settings')}</button>
        <div class="card-popover" id="deckCardSettingsPop">
          <div class="card-popover-title">自動朗讀</div>
          <label><span>自動播放時</span><input type="checkbox" id="dcsPronAuto" ${st.pronAuto ? 'checked' : ''}></label>
          <label><span>手動跳轉時</span><input type="checkbox" id="dcsPronManual" ${st.pronManual ? 'checked' : ''}></label>
          <label><span>發音後停頓</span><select id="dcsPausePron">${[0,0.5,1,1.5,2,3].map(v => `<option value="${v}" ${st.pauseAfterPron===v?'selected':''}>${v}s</option>`).join('')}</select></label>
          <label><span>卡間停頓</span><select id="dcsPauseBet">${[1,2,3,4,5,8].map(v => `<option value="${v}" ${st.pauseBetweenCards===v?'selected':''}>${v}s</option>`).join('')}</select></label>
        </div>
        <button title="下一組例句" id="deckCardExNextBtn">${icon('shuffle')}</button>
        <button title="編輯標籤" id="deckCardTagsBtn">${icon('hash')}</button>
        <button title="編輯" id="deckCardEditBtn" style="color:var(--accent)">${icon('edit')}</button>
        <button title="${st.autoAdvance ? '暫停自動播放' : '自動播放'}" id="deckCardPlayBtn" style="color:${st.autoAdvance ? 'var(--accent)' : ''}">${icon(st.autoAdvance ? 'pause' : 'play', 16)}</button>
        <button title="${isFull ? '切換半螢幕' : '全螢幕'}" id="deckCardFullBtn">${icon(isFull ? 'chevronR' : 'chevronL')}</button>
        <button title="關閉" id="deckCardPreviewClose">${icon('x')}</button>
      </div>
    </div>
    ${cardBodyHTML(w, s)}
    <div class="card-panel-nav">
      ${idx > 0 ? `<button class="card-panel-nav-btn" id="deckCardPrev">‹</button>` : `<span style="width:36px"></span>`}
      ${cardRulerHTML(total, idx)}
      ${idx < total - 1 ? `<button class="card-panel-nav-btn" id="deckCardNext">›</button>` : `<span style="width:36px"></span>`}
    </div>
  </div>`;
}

let _rulerBuilt = false;
function cardRulerHTML(total, idx) {
  _rulerSpacing = total > 2000 ? 2 : total > 800 ? 3 : 4;
  _rulerBuilt = false;
  const w = Math.max(1, (total - 1) * _rulerSpacing);
  const ticks = [];
  for (let i = 0; i < total; i += 10) {
    const p = i * _rulerSpacing;
    ticks.push(`<span class="ruler-tick" style="left:${p}px"><span class="ruler-tick-line"></span><span class="ruler-num">${i === 0 ? 1 : i}</span></span>`);
  }
  return `<div class="card-ruler" id="deckRuler">
    <div class="ruler-track" style="width:${w}px">
      <div class="ruler-base"></div>
      ${ticks.join('')}
      <span class="ruler-ind" id="deckRulerInd" style="left:${idx * _rulerSpacing}px"></span>
    </div>
  </div>`;
}

function scrollRuler(idx) {
  const r = document.getElementById('deckRuler');
  if (!r) return;
  document.getElementById('deckRulerInd').style.left = `${idx * _rulerSpacing}px`;
  const cw = r.offsetWidth;
  const target = idx * _rulerSpacing - cw / 2;
  r.scrollLeft = Math.max(0, Math.min(target, r.scrollWidth - cw));
}

function bindCardEvents(s, w, idx, total, st) {
  const bodyEl = document.getElementById('deckCardPreviewBody');
  bodyEl.addEventListener('dblclick', onDeckCardBodyClick);
  // TAPFLIP1: 點文字發音——面板掛 document.body（pageContainer 外），發音監聽直接綁面板
  bindSpeakClick(document.getElementById('deckCardPreview'), () => s.state);
  document.getElementById('deckCardPreviewClose').addEventListener('click', closeCardPreview);
  document.getElementById('deckCardEditBtn')?.addEventListener('click', (e) => { e.stopPropagation(); closeCardPreview(); openEditModal(s, w.id); });
  document.getElementById('deckCardTagsBtn')?.addEventListener('click', (e) => { e.stopPropagation(); closeCardPreview(); openEditTags(s, w.id); });
  const settingsBtn = document.getElementById('deckCardSettingsBtn');
  const settingsPop = document.getElementById('deckCardSettingsPop');
  if (settingsBtn && settingsPop) {
    settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); settingsPop.classList.toggle('open'); });
    // G11：outside-click 具名＋冪等（重開卡片不疊加）
    if (_dCardOutside) { document.removeEventListener('click', _dCardOutside); _dCardOutside = null; }
    _dCardOutside = (e) => {
      if (!settingsPop.contains(e.target) && e.target !== settingsBtn) settingsPop.classList.remove('open');
    };
    document.addEventListener('click', _dCardOutside);
    document.getElementById('dcsPronAuto')?.addEventListener('change', function() { st.pronAuto = this.checked; saveCardSettings(); });
    document.getElementById('dcsPronManual')?.addEventListener('change', function() { st.pronManual = this.checked; saveCardSettings(); });
    document.getElementById('dcsPausePron')?.addEventListener('change', function() { st.pauseAfterPron = parseFloat(this.value); saveCardSettings(); });
    document.getElementById('dcsPauseBet')?.addEventListener('change', function() { st.pauseBetweenCards = parseFloat(this.value); saveCardSettings(); });
  }
  document.getElementById('deckCardPlayBtn')?.addEventListener('click', (e) => { e.stopPropagation(); st.autoAdvance = !st.autoAdvance; showCard(_cardState.idx); });
  document.getElementById('deckCardFullBtn')?.addEventListener('click', (e) => { e.stopPropagation(); _cardState.fullscreen = !_cardState.fullscreen; showCard(_cardState.idx); });
  document.getElementById('deckCardPrev')?.addEventListener('click', () => { stopAuto(); showCard(_cardState.idx - 1); });
  document.getElementById('deckCardNext')?.addEventListener('click', () => { stopAuto(); showCard(_cardState.idx + 1); });
  // CARDNEXT1: 下一組例句只剩 head 鈕（例句區內鈕已拔）；刷新正反面所有例句區
  const refreshExamples = () => {
    const w = _cardState?.words?.[_cardState.idx];
    if (!w) return;
    const next = rotateExamples(w);
    document.querySelectorAll('#deckCardPreviewBody .card-panel-example').forEach(el => {
      el.innerHTML = fmtExample(next);
    });
  };
  document.getElementById('deckCardExNextBtn')?.addEventListener('click', (e) => { e.stopPropagation(); refreshExamples(); });
  scrollRuler(idx);
  if (st.pronManual && w.pron) playCardTTS(s, w.word);
  // 發音鈕已由「下一組例句」鈕取代（EXNEXT1）；朗讀保留 P 鍵（keydown handler）
  let sx = 0, sy = 0;
  bodyEl.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  bodyEl.addEventListener('touchend', (e) => {
    const dx = sx - e.changedTouches[0].clientX;
    const dy = sy - e.changedTouches[0].clientY;
    markDeckSwipeMoved(dx, dy);
    // 左右切換只吃水平主導的手勢：斜著往下滑（dy 大）不再誤觸換字
    if (Math.abs(dx) > 40 && Math.abs(dx) > 2 * Math.abs(dy)) {
      if (dx > 0 && _cardState.idx < total - 1) { stopAuto(); showCard(_cardState.idx + 1); }
      else if (dx < 0 && _cardState.idx > 0) { stopAuto(); showCard(_cardState.idx - 1); }
    }
  }, { passive: true });
  if (_cardKeyHandler) {
    document.removeEventListener('keydown', _cardKeyHandler);
    _cardKeyBound = false;
  }
  _cardKeyHandler = (e) => {
    if (!document.getElementById('deckCardPreview')) return;
    if (e.key === 'Escape') { closeCardPreview(); return; }
    if (!_cardState) return;
    if (e.key === 'ArrowLeft' && _cardState.idx > 0) { stopAuto(); showCard(_cardState.idx - 1); }
    if (e.key === 'ArrowRight' && _cardState.idx < _cardState.words.length - 1) { stopAuto(); showCard(_cardState.idx + 1); }
    if (e.key === 'ArrowDown' && !_cardState.fullscreen) { _cardState.fullscreen = true; showCard(_cardState.idx); }
    if ((e.key === 'p' || e.key === 'P') && _cardState) { playCardTTS(_cardState.s, _cardState.words[_cardState.idx].word); }
  };
  document.addEventListener('keydown', _cardKeyHandler);
  _cardKeyBound = true;
  window.__pageCleanup = () => {
    if (_cardKeyHandler) {
      document.removeEventListener('keydown', _cardKeyHandler);
      _cardKeyHandler = null;
      _cardKeyBound = false;
    }
    if (_dCardOutside) { document.removeEventListener('click', _dCardOutside); _dCardOutside = null; }
    if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
    const modal = document.getElementById('deckCardPreview');
    if (modal) modal.remove();
    _cardState = null;
  };
}

function initScrollTop() {
  const btn = document.getElementById('scrollTopBtn');
  const area = document.getElementById('contentArea');
  if (!btn || !area) return;
  const onScroll = () => btn.classList.toggle('show', area.scrollTop > 400);
  area.addEventListener('scroll', onScroll, { passive: true });
  btn.addEventListener('click', () => area.scrollTo({ top: 0, behavior: 'smooth' }));
  onScroll();
}

function stopAuto() {
  cardSettings.autoAdvance = false;
  if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
  stopSpeech();
}

async function scheduleNext(idx) {
  if (_autoTimer) clearTimeout(_autoTimer);
  const st = cardSettings;
  if (st.pronAuto && _cardState) {
    const w = _cardState.words[idx];
    if (w.pron) await playCardTTS(_cardState.s, w.word).catch(() => {});
  }
  if (!cardSettings.autoAdvance) return;
  const delay = st.pronAuto ? st.pauseAfterPron : st.pauseBetweenCards;
  _autoTimer = setTimeout(() => {
    _autoTimer = null;
    if (!_cardState) return;
    const next = idx + 1;
    if (next < _cardState.words.length) showCard(next);
    else { stopAuto(); const el = document.getElementById('deckCardPlayBtn'); if (el) el.innerHTML = icon('play', 16); }
  }, delay * 1000);
}

function playCardTTS(s, word) {
  return speak(word, s.state.ttsSpeed || 0.9, s.state.ttsVoice || 'en-us', s.state.ttsPitch || 50);
}

function openEditTags(s, id) {
  const btn = document.querySelector(`.word-row[data-word="${cssEscape(id)}"] [data-action="tags"]`);
  if (btn) btn.click();
}

function closeCardPreview() {
  stopAuto();
  if (_cardKeyHandler) {
    document.removeEventListener('keydown', _cardKeyHandler);
    _cardKeyHandler = null;
    _cardKeyBound = false;
  }
  disableWordImageKeys();   // IMG1: 面板關閉停用 carousel 方向鍵
  const el = document.getElementById('deckCardPreview');
  if (el) el.remove();
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = '';
  const main = document.querySelector('.main');
  if (main) main.style.marginRight = '';
}

// EFF：搜尋變更只更新清單區（同 browser.js renderListInPlace 手法）
function renderListInPlace(s) {
  const listEl = document.getElementById('deckWordList');
  const headEl = document.getElementById('deckListHead');
  if (!listEl || !headEl) { renderInPlace(s); return; }
  const words = _deckName ? s.state.words.filter(w => w.deck === _deckName) : s.state.words;
  const filtered = filterDeckWords(words);
  const display = capList(filtered, _displayLimit);
  const sysTags = s.state.systemTags || [];
  const deckNames = (s.state.decks || []).map(d => d.name);
  headEl.innerHTML = `
    <span style="font-weight:500">${limitNote(filtered, _displayLimit)}</span>`;
  listEl.innerHTML = display.map(w => wordRowHtml(w, s.state.tagConfig, sysTags, deckNames)).join('');
  bindDeckWordEvents(s);
}

function renderInPlace(s) {
  const container = document.getElementById('pageContainer');
  if (container) {
    container.innerHTML = render(s);
    onMount(s);
    import('../lib/custom-select.js').then(m => m.initCustomSelects(container));
  }
}

function showDeckMergeModal(s, existing, newData) {
  const container = document.getElementById('pageContainer');
  if (!container) return;
  // MERGEMOVE1（2026-09-11 使用者裁示）：合併彈窗重設計（同 modal 風格放大版）＋
  // 點「保留舊的」後第二問是否搬到現在字本；衍生第二問同風格。
  const targetDeck = _deckName || newData.deck || 'Default';

  const fieldRow = (label, v, mono) => {
    const val = String(v ?? '').trim();
    if (!val) return '';
    const disp = val.length > 160 ? val.slice(0, 160) + '…' : val;
    return `<div style="padding:5px 0;font-size:13px;line-height:1.5;border-bottom:1px solid var(--border-subtle)"><span style="color:var(--text-tertiary);margin-right:8px;font-size:12px;min-width:36px;display:inline-block">${label}</span><span ${mono ? 'style="font-family:var(--mono)"' : ''}>${escapeHtml(disp)}</span></div>`;
  };
  const deckBadge = (d) => `<span style="font-size:12px;color:var(--accent);background:var(--accent-bg);padding:2px 10px;border-radius:100px;border:1px solid var(--accent)">${escapeHtml(d || 'Default')}</span>`;
  const card = (title, d, accent) => `
    <div style="background:var(--bg-base);border:1px solid ${accent ? 'var(--accent)' : 'var(--border)'};border-radius:var(--r-lg);padding:var(--s3);min-width:0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px">
        <span style="font-weight:700;color:var(--text-primary)">${title}</span>${deckBadge(d.deck)}
      </div>
      ${fieldRow('定義', d.definition)}
      ${fieldRow('詞性', d.pos)}
      ${fieldRow('發音', d.pron, true)}
      ${fieldRow('例句', (d.example || '').split('\n')[0])}
      ${(d.tags?.length || existing.tags?.length) && d === existing && existing.tags?.length ? `<div style="padding:5px 0;font-size:13px"><span style="color:var(--text-tertiary);margin-right:8px;font-size:12px">標籤</span>${escapeHtml(existing.tags.join(', '))}</div>` : ''}
      ${d === newData && newData.tags?.length ? `<div style="padding:5px 0;font-size:13px"><span style="color:var(--text-tertiary);margin-right:8px;font-size:12px">標籤</span>${escapeHtml(newData.tags.join(', '))}</div>` : ''}
    </div>`;

  const html = `
    <div class="modal-overlay open" id="deckMergeModal">
      <div class="modal" style="max-width:680px;width:94vw">
        <div class="modal-header">
          <div class="modal-title">${icon('info')} 單字已存在</div>
          <button class="modal-close" id="deckMergeClose">${icon('x')}</button>
        </div>
        <div style="padding:var(--s3)">
          <div style="margin-bottom:var(--s3);font-size:14px;color:var(--text-primary)">
            「<strong style="font-family:var(--mono)">${escapeHtml(newData.word)}</strong>」已經在字庫中，要保留哪一個？
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s2)">
            ${card('現有的', existing, false)}
            ${card('這次新增的', newData, true)}
          </div>
        </div>
        <div class="modal-footer" style="justify-content:flex-end;gap:var(--s2)">
          <button class="btn" id="deckMergeCancel">取消</button>
          <button class="btn" id="deckMergeKeepOld" style="background:var(--bg-secondary);color:var(--text-primary)">保留舊的</button>
          <button class="btn-primary" id="deckMergeKeepNew">保留新的</button>
        </div>
      </div>
    </div>`;
  container.insertAdjacentHTML('beforeend', html);

  const closeMerge = () => document.getElementById('deckMergeModal')?.remove();
  document.getElementById('deckMergeClose')?.addEventListener('click', closeMerge);
  document.getElementById('deckMergeCancel')?.addEventListener('click', closeMerge);
  document.getElementById('deckMergeModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckMergeModal') closeMerge();
  });

  document.getElementById('deckMergeKeepOld')?.addEventListener('click', () => {
    closeMerge();
    // 第二問：舊字不在目標字本才問；已在就不打擾
    if ((existing.deck || 'Default') === targetDeck) {
      toast(`保留原有「${newData.word}」`, '');
      renderInPlace(s);
      return;
    }
    showDeckMoveModal(s, existing, targetDeck);
  });

  document.getElementById('deckMergeKeepNew')?.addEventListener('click', async () => {
    await s.actions.editWord(existing.id, newData);
    closeMerge();
    toast(`已更新「${newData.word}」`, 'toast-success');
    renderInPlace(s);
  });
}

// MERGEMOVE1 衍生第二問（同 modal 風格）：保留舊的 → 問是否搬到現在字本
function showDeckMoveModal(s, existing, targetDeck) {
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const html = `
    <div class="modal-overlay open" id="deckMoveModal">
      <div class="modal" style="max-width:520px;width:92vw">
        <div class="modal-header">
          <div class="modal-title">${icon('info')} 移到這個字本？</div>
          <button class="modal-close" id="deckMoveClose">${icon('x')}</button>
        </div>
        <div style="padding:var(--s3);font-size:14px;line-height:1.7;color:var(--text-primary)">
          「<strong style="font-family:var(--mono)">${escapeHtml(existing.word)}</strong>」
          目前在 ${`<span style="font-size:12px;color:var(--text-secondary);background:var(--bg-base);padding:2px 10px;border-radius:100px;border:1px solid var(--border)">${escapeHtml(existing.deck || 'Default')}</span>`}
          ，要搬到 ${`<span style="font-size:12px;color:var(--accent);background:var(--accent-bg);padding:2px 10px;border-radius:100px;border:1px solid var(--accent)">${escapeHtml(targetDeck)}</span>`} 嗎？
        </div>
        <div class="modal-footer" style="justify-content:flex-end;gap:var(--s2)">
          <button class="btn" id="deckMoveNo">否</button>
          <button class="btn-primary" id="deckMoveYes">是，搬過去</button>
        </div>
      </div>
    </div>`;
  container.insertAdjacentHTML('beforeend', html);
  const closeMove = () => document.getElementById('deckMoveModal')?.remove();
  document.getElementById('deckMoveClose')?.addEventListener('click', () => { closeMove(); renderInPlace(s); });
  document.getElementById('deckMoveNo')?.addEventListener('click', () => {
    closeMove();
    toast(`保留原有「${existing.word}」（留在「${existing.deck || 'Default'}」）`, '');
    renderInPlace(s);
  });
  document.getElementById('deckMoveModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckMoveModal') { closeMove(); renderInPlace(s); }
  });
  document.getElementById('deckMoveYes')?.addEventListener('click', async () => {
    await s.actions.editWord(existing.id, { deck: targetDeck });
    closeMove();
    toast(`已把「${existing.word}」搬到「${targetDeck}」`, 'toast-success');
    renderInPlace(s);
  });
}

// BATCHADD1（2026-09-11 使用者裁示）：字本瀏覽器專屬批量新增。
// 筆記本式大輸入框（全螢幕級）一次多字 → 分出已存在／未存入 →
// 已存在整批問搬移；未存入走背景任務逐字全欄位填（組合包同來源）再進現在字本。
// 只有 deck-browser 有；組合大瀏覽器（browser.js）不加。
async function openBatchModal(s) {
  const { parseBatchInput, partitionBatch } = await import('../lib/batch-add.js');
  const { normalizePos } = await import('../core/import.js');
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const decks = s.state.decks || [];
  const curDeck = (_deckName && decks.some(d => d.name === _deckName)) ? _deckName : (_deckName || 'Default');
  const deckOpts = decks.map(d =>
    `<option value="${escapeAttr(d.name)}" ${d.name === curDeck ? 'selected' : ''}>${escapeHtml(d.name)}</option>`
  ).join('') + (decks.some(d => d.name === curDeck) ? '' : `<option value="${escapeAttr(curDeck)}" selected>${escapeHtml(curDeck)}</option>`);

  const html = `
    <div class="modal-overlay open" id="deckBatchModal">
      <div class="modal" style="max-width:920px;width:94vw;height:88vh;display:flex;flex-direction:column;padding:var(--s5)">
        <div class="modal-header" style="flex:none">
          <div class="modal-title">${icon('layers')} 批量新增</div>
          <button class="modal-close" id="deckBatchClose">${icon('x')}</button>
        </div>
        <div style="display:flex;gap:var(--s2);align-items:center;margin:var(--s2) 0;flex:none;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-secondary)">目標字本</span>
          <select class="form-input" id="deckBatchDeck" style="max-width:220px">${deckOpts}</select>
          <span class="hint-inline" style="font-size:11px;color:var(--text-tertiary)">來源：跟組合包一樣（韋氏第一、劍橋第二；相關詞走 LLM）</span>
        </div>
        <textarea class="form-input" id="deckBatchInput" placeholder="用逗號或換行分開" style="flex:1;min-height:30vh;resize:vertical;font-family:var(--mono);line-height:1.8;font-size:14px"></textarea>
        <div style="display:flex;gap:var(--s2);align-items:center;margin:var(--s2) 0;flex:none;flex-wrap:wrap">
          <button class="btn" id="deckBatchParse">${icon('search')} 分析</button>
          <span id="deckBatchHint" style="font-size:12px;color:var(--text-tertiary)"></span>
        </div>
        <div id="deckBatchResult" style="flex:none;max-height:30vh;overflow-y:auto"></div>
        <div class="modal-footer" style="flex:none">
          <button class="btn" id="deckBatchCancel">取消</button>
        </div>
      </div>
    </div>`;
  container.insertAdjacentHTML('beforeend', html);

  const close = () => document.getElementById('deckBatchModal')?.remove();
  document.getElementById('deckBatchClose')?.addEventListener('click', close);
  document.getElementById('deckBatchCancel')?.addEventListener('click', close);
  document.getElementById('deckBatchModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'deckBatchModal') close();
  });

  let pending = null; // { existing:[], fresh:[], targetDeck }
  const chip = (t, deck) => `<span style="display:inline-block;font-size:12px;background:var(--bg-base);border:1px solid var(--border);border-radius:100px;padding:2px 10px;margin:1px 3px;font-family:var(--mono)">${escapeHtml(t)}${deck ? `<span style="color:var(--text-tertiary)"> · ${escapeHtml(deck)}</span>` : ''}</span>`;

  document.getElementById('deckBatchParse')?.addEventListener('click', () => {
    const raw = document.getElementById('deckBatchInput')?.value || '';
    const targetDeck = document.getElementById('deckBatchDeck')?.value || curDeck;
    const { tokens, invalid } = parseBatchInput(raw);
    const { existing, fresh } = partitionBatch(tokens, s.state.words || []);
    pending = { existing, fresh, targetDeck };
    const hint = document.getElementById('deckBatchHint');
    if (hint) hint.textContent = `共 ${tokens.length} 字：已存在 ${existing.length}，未存入 ${fresh.length}${invalid.length ? `，略過 ${invalid.length} 個看不懂的（${invalid.slice(0, 5).join('、')}${invalid.length > 5 ? '…' : ''}）` : ''}`;
    const res = document.getElementById('deckBatchResult');
    if (!res) return;
    if (!tokens.length) { res.innerHTML = ''; return; }
    res.innerHTML = `
      ${existing.length ? `<div style="margin-bottom:var(--s2)">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">已存在（${existing.length}）</div>
        <div style="margin-bottom:8px">${existing.map(w => chip(w.word, w.deck)).join('')}</div>
        <button class="btn btn-sm" id="deckBatchMoveAll">全部移到「${escapeHtml(targetDeck)}」</button>
      </div>` : ''}
      ${fresh.length ? `<div>
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">未存入（${fresh.length}）</div>
        <div style="margin-bottom:8px">${fresh.map(t => chip(t)).join('')}</div>
        <button class="btn-primary btn-sm" id="deckBatchStart">開始批量新增（背景執行）</button>
      </div>` : ''}
      ${!existing.length && !fresh.length ? `<div style="font-size:13px;color:var(--text-tertiary)">沒有可處理的字。</div>` : ''}`;
    document.getElementById('deckBatchMoveAll')?.addEventListener('click', async () => {
      const toMove = (pending?.existing || []).filter(w => (w.deck || 'Default') !== pending.targetDeck);
      for (const w of toMove) { try { await s.actions.editWord(w.id, { deck: pending.targetDeck }); } catch (_) {} }
      toast(toMove.length ? `已把 ${toMove.length} 字搬到「${pending.targetDeck}」` : `已存在的字都在「${pending.targetDeck}」了`, 'toast-success');
      // BATCHADD2: modal 不關（關閉僅限叉叉/取消/點背景）；搬完原地刷新已存在區的 deck 顯示
      const hint = document.getElementById('deckBatchHint');
      if (hint) hint.textContent = `已存在 ${toMove.length} 字搬到「${pending.targetDeck}」。`;
    });
    document.getElementById('deckBatchStart')?.addEventListener('click', async () => {
      const list = [...(pending?.fresh || [])];
      const target = pending?.targetDeck || curDeck;
      if (!list.length) return;
      // BATCHADD2: 開始批量也不關 modal — 背景執行本來就跟 modal 無關，
      // 關掉等於強迫使用者離開分析結果（關閉僅限叉叉/取消/點背景）。
      await runBatchAdd(s, list, target, normalizePos);
    });
  });
}

// BATCHADD1 背景填字引擎：來源同 tools.js 組合包預設
// （pos cambridge／example dict-api／pron cambridge／related llm／
// forms-syn-ant-phrase merriam／trans cambridge／derivative-syllables-etymology merriam）。
async function runBatchAdd(s, list, targetDeck, normalizePos) {
  const taskId = 'batch-add-' + Date.now();
  s.actions.startBackgroundTask(taskId, `批量新增→${targetDeck}`, list.length);
  let done = 0, failed = 0, aborted = false;
  // LLM 偵測（related 預設走 LLM；連不上就跳過該欄，其餘照做）
  let llm = null, llmOk = false;
  try {
    const resp = await fetchGet('http://localhost:11434/api/tags');
    const models = (JSON.parse(resp).models || []).map(m => m.name);
    if (models.length) { llm = { baseUrl: 'http://localhost:11434', model: models[0] }; llmOk = true; }
  } catch (_) { /* 無 LLM 照做 */ }
  const quotaHit = (e) => /401|429/.test(String(e?.message || e));
  const mwLookup = async (word) => {
    const raw = await lookupMerriam(word, s.state.mwDictKey || '', s.state.mwThesKey || '');
    return merriamToFields(JSON.parse(raw), word);
  };
  const llmJson = async (prompt) => {
    const text = await fetchLLM(`${llm.baseUrl}/api/generate`, llm.model, prompt);
    const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? [...new Set(arr.map(x => String(x).trim()).filter(Boolean))] : null;
  };
  async function fillOne(word) {
    // AUTOFILL-ENGINE1: 與組合包同一顆引擎（BATCH_METHODS 固定 12 欄；
    // exampleMax 3 沿用舊 cap；related 走 merriam+llm 雙併，比舊 fillOne
    // 多併 synonym union，屬只多不砍）。
    const { fillWordFields, BATCH_METHODS } = await import('../lib/autofill-engine.js');
    let mwF = null, camEn = null, camZh = null;
    const getMw = async () => { if (!mwF) mwF = await mwLookup(word); return mwF; };
    const getCamEn = async () => { if (!camEn) camEn = JSON.parse(await lookupCambridge(word)); return camEn; };
    const getCamZh = async () => { if (!camZh) camZh = JSON.parse(await lookupCambridge(word, 'zh')); return camZh; };
    const llmJson = async (prompt) => {
      const text = await fetchLLM(`${llm.baseUrl}/api/generate`, llm.model, prompt);
      const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
      const arr = JSON.parse(cleaned);
      return Array.isArray(arr) ? [...new Set(arr.map(x => String(x).trim()).filter(Boolean))] : null;
    };
    const llmText = async (prompt) => fetchLLM(`${llm.baseUrl}/api/generate`, llm.model, prompt);
    const r = await fillWordFields({
      wordText: word, existing: {}, methods: BATCH_METHODS, overwrite: true,
      threshold: 1, count: 3, exampleMax: 3,
      fetchers: { getCamEn, getCamZh, getMw, llmJson, llmText, llmOk },
      onStat: () => {},
    });
    if (r.aborted) throw r.abortError ?? new Error('429');
    return { word, deck: targetDeck, tags: [], related: [], forms: [], ...r.patch };
  }
  const queue = [...list];
  const CON = 3;
  await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
    while (queue.length && !aborted) {
      const w = queue.shift();
      try {
        const data = await fillOne(w);
        await s.actions.addWord(data);
        done++;
      } catch (e) {
        if (quotaHit(e)) { aborted = true; queue.length = 0; toast('超過韋氏每日免費額度（429），剩下的明天再試', 'toast-error'); break; }
        failed++;
      }
      s.actions.updateBackgroundTask(taskId, done + failed, list.length);
    }
  }));
  s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `批量新增完成：${done} 成功${failed ? `，${failed} 失敗` : ''}${aborted ? '（額度中止）' : ''}` });
  toast(`批量新增完成：${done} 成功${failed ? `，${failed} 失敗` : ''}`, failed ? '' : 'toast-success');
  renderInPlace(s);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function cssEscape(str) {
  return String(str ?? '').replace(/["\\]/g, '\\$&');
}

/** ENGINE2 共用：編輯器 sparkle 的韋氏分支一律走 fillWordFields（單次 fetch 多欄；LLM 兜底不動）
 *  ENGINE3：fetchers 補齊（getCamEn＋llmText），例句鈕整條 chain 可走引擎；
 *  getMw 單次快取（mwFillExtra 三欄一鍵只打一次，同舊）；threshold 預設全開（sparkle 單句模式有無都不擋） */
async function _engineMw(word, methods, existing = {}) {
  const { fillWordFields } = await import('../lib/autofill-engine.js');
  const { lookupMerriam, lookupCambridge } = await import('../lib/api.js');
  const { merriamToFields } = await import('../lib/merriam.js');
  let mwCache = null;
  const getMw = async () => {
    if (!mwCache) mwCache = merriamToFields(JSON.parse(await lookupMerriam(word, store.state.mwDictKey || '', store.state.mwThesKey || '')), word);
    return mwCache;
  };
  const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
  const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
  return fillWordFields({ wordText: word, methods, existing, overwrite: false, threshold: Infinity,
    fetchers: {
      getMw,
      getCamEn: async () => JSON.parse(await lookupCambridge(word, 'zh')),
      llmText: async (prompt) => fetchLLM(`${baseUrl}/api/generate`, model, prompt),
      llmOk: true,
    },
    onStat: () => {} });
}
async function llmFillRelated(inputId, word) {
  // ENGINE2: 韋氏優先走共用引擎（synonym＋related union 取 12；有 key 才跑，有料即返）
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      // ENGINE2: 相關詞走共用引擎
      const r = await _engineMw(word, { related: 'merriam' });
      const rel = r.patch?.related || [];
      if (rel.length) {
        const chipsHost = document.getElementById(inputId + 'Chips');
        if (chipsHost && chipsHost._tagInputApi) chipsHost._tagInputApi.setVal(rel.join(', '));
        else document.getElementById(inputId).value = rel.join(', ');
        toast('已從韋氏補上相關詞', 'toast-success');
        return;
      }
    } catch (_) { /* 掉回 LLM */ }
  }
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array of synonyms/similar words for "${word}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`
    );
    if (text && text.trim()) {
      const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        // 膠囊系統：值寫入 chips（若該欄已接膠囊容器；fallback 舊 input 行為）
        const chipsHost = document.getElementById(inputId + 'Chips');
        if (chipsHost && chipsHost._tagInputApi) {
          chipsHost._tagInputApi.setVal([...new Set(arr)].join(', '));
        } else {
          document.getElementById(inputId).value = [...new Set(arr)].join(', ');
        }
      }
    }
  } catch (e) {
    toast('LLM 產生失敗: ' + e, 'toast-error');
  }
}

async function llmFillForms(inputId, word) {
  // ENGINE2: 韋氏優先走共用引擎（有 key 走 inflected forms；無 key/查無 才掉 LLM）
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      // ENGINE2: 詞形走共用引擎
      const _fr = await _engineMw(word, { forms: 'merriam' });
      const _fv = (_fr.patch?.forms || []).join(', ');
      if (_fv) {
        const chipsHost = document.getElementById(inputId + 'Chips');
        const val = _fv;
        if (chipsHost && chipsHost._tagInputApi) chipsHost._tagInputApi.setVal(val);
        else document.getElementById(inputId).value = val;
        toast('已從韋氏補上詞形變化', 'toast-success');
        return;
      }
    } catch (_) { /* 掉回 LLM */ }
  }
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array of inflections/derivations (past tense, -ing, -s, past participle) for "${word}". Example: ["gets","got","getting"]. Only the JSON array, no markdown.`
    );
    if (text && text.trim()) {
      const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        // 膠囊系統：值寫入 chips（若該欄已接膠囊容器；fallback 舊 input 行為）
        const chipsHost = document.getElementById(inputId + 'Chips');
        if (chipsHost && chipsHost._tagInputApi) {
          chipsHost._tagInputApi.setVal([...new Set(arr)].join(', '));
        } else {
          document.getElementById(inputId).value = [...new Set(arr)].join(', ');
        }
      }
    }
  } catch (e) {
    toast('LLM 產生失敗: ' + e, 'toast-error');
  }
}

/** LLM 填相似詞/反義詞/衍生物（autoFill 鏈用；只填空欄，尊重已填值）。
 *  prefix: 'deckAdd' | 'deckEdit'（modal 前綴） */
async function llmFillSynAntDeriv(prefix, word) {
  // ENGINE2: 韋氏優先走共用引擎（同/反義吃 thesaurus；衍生吃 collegiate stems；只填空欄由下方迴圈維持）
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      // ENGINE2: 同／反／衍生走共用引擎
      const _sr = await _engineMw(word, { syn: 'merriam', ant: 'merriam', derivative: 'merriam' });
      const f = { synonym: _sr.patch?.synonym || '', antonym: _sr.patch?.antonym || '', derivative: _sr.patch?.derivative || '' };
      let n = 0;
      for (const [suffix, val] of [['Synonym', f.synonym], ['Antonym', f.antonym], ['Derivative', f.derivative]]) {
        if (!val) continue;
        const el = document.getElementById(`${prefix}${suffix}`);
        if (!el) continue;
        const host = document.getElementById(`${prefix}${suffix}Chips`);
        const already = host?._tagInputApi ? host._tagInputApi.getVal() : el.value.trim();
        if (already) continue;
        if (host && host._tagInputApi) host._tagInputApi.setVal(val);
        else el.value = val;
        n++;
      }
      if (n) toast('已從韋氏補上同義/反義/衍生', 'toast-success');
    } catch (_) { /* 掉回 LLM */ }
  }
  const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
  const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
  const tasks = [
    { id: `${prefix}Synonym`, empty: () => !document.getElementById(`${prefix}Synonym`)?.value.trim(),
      prompt: `Return a JSON array of synonyms for "${word}". Example: ["obtain","receive"]. Only the JSON array, no markdown.` },
    { id: `${prefix}Antonym`, empty: () => !document.getElementById(`${prefix}Antonym`)?.value.trim(),
      prompt: `Return a JSON array of antonyms for "${word}". Example: ["lose","discard"]. Only the JSON array, no markdown.` },
    { id: `${prefix}Derivative`, empty: () => !document.getElementById(`${prefix}Derivative`)?.value.trim(),
      prompt: `Return a JSON array of word derivations (adverb, noun, adjective forms) for "${word}". Example: ["happily","happiness"]. Only the JSON array, no markdown.` },
  ];
  await Promise.all(tasks.map(async t => {
    const el = document.getElementById(t.id);
    if (!el) return;
    const host = document.getElementById(t.id + 'Chips');
    const already = host?._tagInputApi ? host._tagInputApi.getVal() : el.value.trim();
    if (already) return;   // 已填不覆蓋
    try {
      const text = await fetchLLM(`${baseUrl}/api/generate`, model, t.prompt);
      if (text && text.trim()) {
        const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
        const arr = JSON.parse(cleaned);
        if (Array.isArray(arr) && arr.length) {
          const val = [...new Set(arr.map(String))].join(', ');
          if (host && host._tagInputApi) host._tagInputApi.setVal(val);
          else el.value = val;
        }
      }
    } catch (e) { /* 單欄失敗不擋其他欄 */ }
  }));
}

/** 韋氏三欄一鍵（deck modal 版；音節/字源填空欄，片語併入例句；有 key 才跑）。
 *  prefix: 'deckAdd' | 'deckEdit'；s/g 為該 modal 的 set/get 閉包 */
async function mwFillExtra(prefix, s, g, word) {
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      // ENGINE2: 音節／字源／片語走共用引擎（單次 fetch；片語以空底取新句再走 ExampleAppend 追加通道）
      const r = await _engineMw(word, { syllables: 'merriam', etymology: 'merriam', phrase: 'merriam' },
        { syllables: g(`${prefix}Syllables`), etymology: g(`${prefix}Etymology`), example: '', phrases: '' });
      if (!r.aborted) {
        const f = r.patch || {};
        if (f.syllables) s(`${prefix}Syllables`, f.syllables);
        if (f.etymology) s(`${prefix}Etymology`, f.etymology);
        if (f.example) s(`${prefix}ExampleAppend`, f.example);
        return;
      }
    } catch (_) { /* 掉回 LLM */ }
  }
  // 無 key：LLM 片語併入例句（音節只吃韋氏，此處不補）
  try { await mwFillPhrases(`${prefix}ExChips`, word); } catch (_) {}
}

/** 片語 sparkle／兜底：韋氏優先（有 key），無 key 走 LLM；一律去重併入例句膠囊 */
async function mwFillPhrases(chipsHostId, word) {
  const host = document.getElementById(chipsHostId);
  const api = host?._tagInputApi;
  if (!api) return;
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      // ENGINE2: 片語走共用引擎（併入例句；去重語意由引擎維持）
      const r = await _engineMw(word, { phrase: 'merriam' }, { example: api.getVal(), phrases: '' });
      if (r.patch?.example) {
        api.setVal(r.patch.example);
        toast('已從韋氏補上片語（併入例句）', 'toast-success');
        return;
      }
    } catch (_) { /* 掉回 LLM */ }
  }
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `List 3-5 common English phrases or collocations using the word "${word}", one per line. Return ONLY the phrases, nothing else.`
    );
    if (text && text.trim()) {
      const val = [...new Set(text.trim().split('\n').map(x => x.trim()).filter(Boolean))].join('\n');
      api.setVal(mergeExamplePhrases(api.getVal(), val));
      toast('已補上片語（併入例句）', 'toast-success');
    }
  } catch (e) { toast('片語產生失敗: ' + e, 'toast-error'); }
}

function batchMoveToDeck(s) {
  const ids = [..._selectedIds];
  if (!ids.length) return;
  const decks = s.state.decks;
  const container = document.getElementById('pageContainer');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay open" id="deckBatchMoveModal">
      <div class="modal" style="max-width:380px">
        <div class="modal-header">
          <div class="modal-title">${icon('shuffle')} 搬到字本</div>
          <button class="modal-close" id="deckBatchMoveClose">${icon('x')}</button>
        </div>
        <div class="form-group" style="padding:var(--s4)">
          <label class="form-label">目標字本</label>
          <select class="form-input" id="deckBatchMoveTarget">
            ${decks.map(d => `<option value="${escapeAttr(d.name)}">${escapeHtml(d.name)}</option>`).join('')}
          </select>
          <div style="margin-top:var(--s2);font-size:12px;color:var(--text-tertiary)">將 ${ids.length} 個單字移到所選字本</div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="deckBatchMoveCancel">取消</button>
          <button class="btn-primary" id="deckBatchMoveConfirm">${icon('check')} 確定搬移</button>
        </div>
      </div>
    </div>`);

  const close = () => document.getElementById('deckBatchMoveModal')?.remove();
  document.getElementById('deckBatchMoveClose')?.addEventListener('click', close);
  document.getElementById('deckBatchMoveCancel')?.addEventListener('click', close);
  document.getElementById('deckBatchMoveModal')?.addEventListener('click', e => { if (e.target.id === 'deckBatchMoveModal') close(); });
  document.getElementById('deckBatchMoveConfirm')?.addEventListener('click', async () => {
    const target = document.getElementById('deckBatchMoveTarget')?.value;
    if (!target) return;
    const btn = document.getElementById('deckBatchMoveConfirm');
    btn.disabled = true;
    btn.textContent = '搬移中...';
    await Promise.all(ids.map(id => s.actions.editWord(id, { deck: target })));
    _selectedIds.clear();
    _selectMode = false;
    close();
    toast(`已將 ${ids.length} 個單字搬到「${target}」`, 'toast-success');
    renderInPlace(s);
  });
}
