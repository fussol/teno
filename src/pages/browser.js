// ═══════════════════════════════════════════════════════════════
// Browser — Word library: search, filter by deck/tag, edit & delete
// v05.01.00.0010
// ═══════════════════════════════════════════════════════════════

import { icon, splitFieldsHtml, fmtExample, mergeExamplePhrases, wordExample } from '../lib/svg.js';
import { cardFaceHtml } from '../lib/word-extra.js';
import { wordImageSlotHTML, mountWordImages, WORD_IMAGE_CSS, invalidateWordImages, disableWordImageKeys, renderEditorThumbs, bindEditorThumbs, getWordImages } from '../lib/word-image.js';
import { deleteWordImagesForWord, addWordImage } from '../lib/db.js';
import { store } from '../lib/app-store.js';
import { toast } from '../lib/toast.js';
import { speak, stopSpeech } from '../lib/tts.js';
import { isMobile } from '../lib/platform.js';
import { hashCode, mulberry32 } from '../lib/rng.js';
import { fetchGet, fetchLLM, lookupCambridge, lookupMerriam } from '../lib/api.js';
import { merriamToFields } from '../lib/merriam.js';
import { DISPLAY_LIMIT_KEY, DISPLAY_LIMIT_DEFAULT, normalizeDisplayLimit, capList, limitNote, limitSelectHtml } from '../lib/display-limit.js';

// 字庫顯示上限（可調＋記憶：存 db settings.browserDisplayLimit；0=全部）
let _displayLimit = DISPLAY_LIMIT_DEFAULT;

let _query = '';
let _deckFilter = null;
let _tagFilter = null;
let _searchScope = 'all';
let _deckCounts = {};
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
function displayTagName(s, tagStr) {
  const st = (s.state.systemTags || []).find(t => t.role === tagStr);
  return st ? st.name : tagStr;
}
let _sortRandom = false;
let _sortSeed = '';
let _rulerSpacing = 3;
let _editing = null;      // word id being edited


export function render(s) {
  const { words, decks } = s.state;
  const allTags = collectTags(words);
  const filtered = filterWords(words);
  if (!_deckCounts || Object.keys(_deckCounts).length === 0 || _deckCounts._total !== words.length) {
    _deckCounts = { _total: words.length };
    for (const w of words) {
      const d = w.deck || '';
      _deckCounts[d] = (_deckCounts[d] || 0) + 1;
    }
  }
  const deckCounts = _deckCounts;

  return `
    <div class="page-title">${icon('list')} 字庫</div>
    <div class="page-subtitle">瀏覽、搜尋、編輯你的單字 · 共 ${words.length} 詞</div>

    <div style="display:flex;gap:var(--s3);margin-bottom:var(--s5);flex-wrap:wrap;align-items:center">
      <div class="search-box" style="${isMobile ? 'width:100%' : 'flex:1;min-width:240px'}">
        ${icon('search')}
        <input id="browserSearch" type="text" placeholder="搜尋單字、定義、例句...（Enter 執行）" value="${escapeAttr(_query)}">
      </div>
      <button class="btn-ghost btn-sm" id="browserSearchBtn" title="執行搜尋">${icon('search')} 搜尋</button>
      <button class="btn-ghost btn-sm" id="browserScopeToggle" style="font-size:11px;border:1px solid var(--border);padding:5px 10px;min-width:10ch;text-align:center;white-space:nowrap;box-sizing:border-box" title="切換搜尋範圍">${_searchScope === 'worddef' ? '單字+定義' : '全部欄位'}</button>
       <div class="cs-wrap" style="position:relative;max-width:170px" id="browserTagDropdown">
         <button class="cs-trigger" type="button" id="browserTagTrigger" style="display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-size:12px;cursor:pointer;width:100%;white-space:nowrap;overflow:hidden">
           <span id="browserTagLabel">${_tagFilter || '標籤：全部'}</span>
           <span style="margin-left:auto;color:var(--text-tertiary)">${icon('chevron-down')}</span>
         </button>
         <div class="cs-menu" id="browserTagMenu" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:100;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);max-height:240px;overflow:auto;margin-top:4px">
           <div class="cs-option" data-tag-value="" style="padding:8px 12px;cursor:pointer;font-size:12px;color:var(--text-primary);border-bottom:1px solid var(--border-subtle)">全部</div>
           <div style="padding:4px 12px;font-size:10px;color:var(--text-tertiary);text-transform:uppercase">系統標籤</div>
           ${(s.state.systemTags || []).map(t => `<div class="cs-option" data-tag-value="${escapeAttr(t.role)}" style="padding:8px 12px;cursor:pointer;font-size:12px;color:var(--text-primary)">${escapeHtml(t.name)}</div>`).join('')}
           ${(s.state.tags || []).length > 0 ? `<div style="padding:4px 12px;font-size:10px;color:var(--text-tertiary);text-transform:uppercase">自訂標籤</div>` + (s.state.tags || []).map(t => `<div class="cs-option" data-tag-value="${escapeAttr(t.name)}" style="padding:8px 12px;cursor:pointer;font-size:12px;color:var(--text-primary)">${escapeHtml(t.name)}</div>`).join('') : ''}
         </div>
       </div>
      <button class="btn-ghost btn-sm" id="browserSortToggle" style="font-size:11px;min-width:6ch;text-align:center;white-space:nowrap;box-sizing:border-box" title="切換排序">${_sortRandom ? '隨機' : 'A-Z'}</button>
      ${_sortRandom ? `<input id="browserSeed" type="text" placeholder="seed" value="${escapeAttr(_sortSeed)}" style="width:80px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-size:11px;font-family:var(--mono)">` : ''}
      <button class="btn-primary btn-sm" id="browserAddWord">${icon('plus')} 新增</button>
    </div>

    <!-- Deck filter chips -->
    <div style="display:flex;gap:var(--s2);margin-bottom:var(--s5);flex-wrap:wrap;align-items:center">
      <span class="muted" style="font-size:12px;font-weight:600">字本：</span>
      <button class="exam-deck-chip ${_deckFilter === null ? 'selected' : ''}" data-deck="">
        全部
        <span style="font-size:10px;opacity:.6;margin-left:4px">${words.length}</span>
      </button>
      ${decks.map(d => `
        <button class="exam-deck-chip ${_deckFilter === d.name ? 'selected' : ''}" data-deck="${escapeAttr(d.name)}">
          <span style="width:7px;height:7px;border-radius:50%;background:${d.color};display:inline-block"></span>
          ${escapeHtml(d.name)}
          <span style="font-size:10px;opacity:.6;margin-left:4px">${deckCounts[d.name] || 0}</span>
        </button>
      `).join('')}
    </div>

    ${filtered.length === 0 ? renderEmpty(words.length) : renderList(filtered, s, s.state.tagConfig)}
    <button class="scroll-top-btn" id="scrollTopBtn">${icon('chevronU')}</button>
  `;
}

function renderEmpty(total) {
  const isFilter = _query || _deckFilter || _tagFilter;
  return `<div class="empty-state">
    ${icon(isFilter ? 'search' : 'box')}
    <h3>${isFilter ? '找不到符合的單字' : '字庫是空的'}</h3>
    <p>${isFilter ? '試試其他關鍵字、字本或標籤' : `共 ${total} 詞，開始新增或匯入 CSV`}</p>
  </div>`;
}

function wordRowHtml(w, tagColors, sysTags, deckNames) {
  const tc = tagColors || {};
  const sys = sysTags || [];
  const tagName = (t) => { const st = sys.find(s => s.role === t); return st ? st.name : t; };
  // 字本名不是標籤：歷史資料把字本名塞進 w.tags（4879/4921 字全是字本名 tag），
  // 列表只印真標籤，與任何字本同名的 tag 一律過濾（設定定義表也沒有它們）。
  const deckSet = new Set(deckNames || []);
  const showTags = (w.tags || []).filter(t => !deckSet.has(t));
  return `<div class="word-row" data-word="${escapeAttr(w.id)}">
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
    </div>
    <div class="word-row-actions" style="${isMobile ? 'opacity:1' : ''}">
      <button title="編輯標籤" data-action="tags" data-word-id="${escapeAttr(w.id)}">${icon('hash')}</button>
      <button title="發音" data-action="speak" data-word-id="${escapeAttr(w.id)}">${icon('volume')}</button>
      <button title="編輯" data-action="edit" data-word-id="${escapeAttr(w.id)}">${icon('edit')}</button>
      <button class="danger" title="刪除" data-action="delete" data-word-id="${escapeAttr(w.id)}">${icon('trash')}</button>
    </div>
  </div>`;
}

function renderList(words, s, tagColors) {
  const sysTags = s.state.systemTags || [];
  const deckNames = (s.state.decks || []).map(d => d.name);
  const display = capList(words, _displayLimit);
  return `
    <div id="browserListHead" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s3)">
      <span style="font-size:12px;color:var(--text-tertiary);font-weight:500">
        ${limitNote(words, _displayLimit)}
      </span>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-tertiary)">
        上限
        ${limitSelectHtml('browserLimitSelect', _displayLimit)}
      </label>
    </div>
    <div class="word-list" id="wordList">
      ${display.map(w => wordRowHtml(w, tagColors, sysTags, deckNames)).join('')}
    </div>
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

// EFF：預先 lowercase 搜尋索引 — words ref + 欄位內容不變時索引復用。
// filterWords 原每詞每欄 toLowerCase()（萬詞×7 欄 = 7 萬次字串分配/keystroke）；
// 索引化後比對零分配，filter 只做 includes。
let _siWordsRef = null;
let _siMap = null;   // Map<wordObj, {hay1, hay2, related, forms}>
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

function filterWords(words) {
  // G17: memoization — 萬級詞庫 render 每次全量 filter+sort 太貴。
  // words 為 immutable reference，條件不變時直接回傳上次結果。
  if (_sortRandom && !_sortSeed) {
    // 無 seed 的隨機排序每次 render 應重新洗牌（Date.now seed），不 memo。
  } else {
    // EFF：sig 用 words reference 身分（_fwWordsRef），不把陣列 join 進 sig（每次序列化 0.2ms×萬詞浪費）
    const sig = [_query, _searchScope, _deckFilter, _tagFilter, _sortRandom, _sortSeed].join('\u0001') + '|' + (words === _fwWordsRef ? '=' : '+');
    if (_fwSig === sig && _fwCache) return _fwCache;
    _fwSig = sig;
    _fwWordsRef = words;
  }
  const q = _query.trim().toLowerCase();
  const idx = searchIndex(words);
  const scope = _searchScope === 'worddef' ? ['word', 'definition'] : null;
  const filtered = words.filter(w => {
    if (_deckFilter && w.deck !== _deckFilter) return false;
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
    const seed = _sortSeed ? hashCode(_sortSeed) : Date.now();
    const rng = mulberry32(seed);
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    _fwCache = copy;
    return copy;
  }
  copy.sort((a, b) => (a.word || '').localeCompare(b.word || ''));
  _fwCache = copy;
  return copy;
}
let _fwSig = null;
let _fwWordsRef = null;
let _fwCache = null;

// ─── Card Preview ─────────────────────────────────────────────
let _cardState = null;
let _cardKeyBound = false;
let _autoTimer = null;
let _cardKeyHandler = null;
let _bCardOutside = null;      // G11: card settings outside-click (document 常駐，重開卡片疊)
let _bTagDocHandler = null;    // G11: tag dropdown outside-click（onMount 重複註冊）
let cardSettings = {
  pronAuto: false,
  pronManual: false,
  autoAdvance: false,
  pauseAfterPron: 1.5,
  pauseBetweenCards: 3,
};
// 卡片播放設定持久化（db 設定鍵 — 換頁/重整不重置；播放狀態不存）
// 顯示類設定（正反面欄位／例句句數）統一由設定頁 master 控制，此處只留播放相關
const CARD_SETTINGS_KEY = 'browserCardSettings';
function saveCardSettings() {
  import('../lib/db.js').then(m => m.setSetting(CARD_SETTINGS_KEY, JSON.stringify({
    pronAuto: cardSettings.pronAuto,
    pronManual: cardSettings.pronManual,
    pauseAfterPron: cardSettings.pauseAfterPron,
    pauseBetweenCards: cardSettings.pauseBetweenCards,
  }))).catch(() => {});
}

function openCardPreview(s, wordId) {
  const words = filterWords(s.state.words);
  const idx = words.findIndex(w => w.id === wordId);
  if (idx === -1) return;
  _cardState = { words, s };
  showCard(idx);
}

const cardPanelCSS = `<style id="cardStyle">
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

// ── 字卡正反面：進卡片／換字一律先正面，點一下翻背面，再點回正面 ──
function flipCardBody(body) {
  if (!body) return;
  const f = body.querySelector('[data-face="front"]');
  const b = body.querySelector('[data-face="back"]');
  if (!f || !b) return;
  const toBack = !f.hidden;
  f.hidden = toBack;
  b.hidden = !toBack;
  const hint = body.querySelector('[data-flip-hint]');
  if (hint) hint.textContent = toBack ? '點一下回正面' : '點一下看背面';
}

function onCardBodyClick() {
  // 滑動換字後接著觸發的 click 不翻面（touchend 已記 _swiped）
  if (_cardState && _cardState._swiped) { _cardState._swiped = false; return; }
  flipCardBody(document.getElementById('cardPreviewBody'));
}

function markSwipeMoved(dx, dy) {
  if (_cardState && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) _cardState._swiped = true;
}

function cardBodyHTML(w, s) {
  // 正反面欄位由設定頁 master 控制（cardFaceHtml＋browserFront／browserBack）
  const H = { escapeHtml, wordImageSlotHTML, splitFieldsHtml, fmtExample, wordExample };
  return `<div class="card-panel-body" id="cardPreviewBody">
    <div class="card-face" data-face="front">${cardFaceHtml(w, s, 'browserFront', H)}</div>
    <div class="card-face" data-face="back" hidden>${cardFaceHtml(w, s, 'browserBack', H)}</div>
    <div class="card-flip-hint" data-flip-hint style="font-size:11px;color:var(--text-quaternary);margin-top:4px">點一下看背面</div>
  </div>`;
}

function showCard(idx) {
  if (!_cardState) return;
  _cardState.idx = idx;
  if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
  const { words, s } = _cardState;
  const w = words[idx];
  const total = words.length;
  const st = cardSettings;
  const panel = document.getElementById('cardPreviewModal');

  if (panel) {
    const isFull = _cardState.fullscreen || false;
    panel.classList.toggle('full', isFull);
    const main = document.querySelector('.main');
    if (main) main.style.marginRight = isFull ? '0' : '50vw';
    const fullBtn = document.getElementById('cardFullBtn');
    if (fullBtn) fullBtn.innerHTML = icon(isFull ? 'chevronR' : 'chevronL');
    if (fullBtn) fullBtn.title = isFull ? '切換半螢幕' : '全螢幕';
    document.getElementById('cardCounter').textContent = `${idx + 1} / ${total}`;
    const body = document.getElementById('cardPreviewBody');
    body.innerHTML = cardBodyHTML(w, s, st);
    const newBody = body;
    if (!newBody.dataset._listeners) {
      newBody.dataset._listeners = '1';
      newBody.addEventListener('click', onCardBodyClick);
      newBody.addEventListener('touchstart', (e) => { _cardState._sx = e.touches[0].clientX; _cardState._sy = e.touches[0].clientY; }, { passive: true });
      newBody.addEventListener('touchend', (e) => {
        const dx = _cardState._sx - e.changedTouches[0].clientX;
        const dy = (_cardState._sy ?? e.changedTouches[0].clientY) - e.changedTouches[0].clientY;
        markSwipeMoved(dx, dy);
        // 左右切換只吃水平主導的手勢：斜著往下滑（dy 大）不再誤觸換字
        if (Math.abs(dx) > 40 && Math.abs(dx) > 2 * Math.abs(dy)) {
          if (dx > 0 && _cardState.idx < _cardState.words.length - 1) showCard(_cardState.idx + 1);
          else if (dx < 0 && _cardState.idx > 0) showCard(_cardState.idx - 1);
        }
      }, { passive: true });
    }
    const nav = panel.querySelector('.card-panel-nav');
    document.getElementById('cardPrev')?.remove();
    document.getElementById('cardNext')?.remove();
    if (idx > 0 && nav) nav.insertBefore(_btn('cardPrev', '‹', () => { stopAuto(); showCard(_cardState.idx - 1); }), nav.firstChild);
    if (idx < total - 1 && nav) nav.appendChild(_btn('cardNext', '›', () => { stopAuto(); showCard(_cardState.idx + 1); }));
    scrollBrowserRuler(idx);
    // IMG1: 占位填充（showCard 換字時重跑——word-image 快取已 hydrate 則零重查）
    mountWordImages([w.id]).catch(() => {});
    if (st.pronManual && w.pron) playCardTTS(s, w.word);
    if (cardSettings.autoAdvance) scheduleNext(idx).catch(() => {});
    return;
  }

  if (!document.getElementById('cardStyle')) document.head.insertAdjacentHTML('beforeend', cardPanelCSS);
  if (!document.getElementById('wordImageStyle')) document.head.insertAdjacentHTML('beforeend', `<style id="wordImageStyle">${WORD_IMAGE_CSS}</style>`);
  const isFull = _cardState.fullscreen || false;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = 'none';
  const main = document.querySelector('.main');
  if (main) main.style.marginRight = isFull ? '0' : '50vw';

  document.body.insertAdjacentHTML('beforeend', mkPanelHTML(w, s, st, idx, total, words, isFull));
  bindCardEvents(s, w, st);
  // IMG1: 首掛面板後填充
  mountWordImages([w.id]).catch(() => {});
  if (cardSettings.autoAdvance) scheduleNext(idx).catch(() => {});
}

function _btn(id, text, handler) {
  const el = document.createElement('button');
  el.className = 'card-panel-nav-btn'; el.id = id; el.textContent = text;
  el.addEventListener('click', handler);
  return el;
}

function mkPanelHTML(w, s, st, idx, total, words, isFull) {
  return `<div class="card-panel${isFull ? ' full' : ''}" id="cardPreviewModal">
    <div class="card-panel-head">
      <span id="cardCounter" style="font-size:13px;font-weight:600;color:var(--text-tertiary);font-family:var(--mono);font-feature-settings:'tnum'">${idx + 1} / ${total}</span>
      <div class="card-panel-head-actions" style="position:relative">
        <button title="設定" id="cardSettingsBtn">${icon('settings')}</button>
        <div class="card-popover" id="cardSettingsPop">
          <div class="card-popover-title">自動朗讀</div>
          <label><span>自動播放時</span><input type="checkbox" id="csPronAuto" ${st.pronAuto ? 'checked' : ''}></label>
          <label><span>手動跳轉時</span><input type="checkbox" id="csPronManual" ${st.pronManual ? 'checked' : ''}></label>
          <label><span>發音後停頓</span><select id="csPausePron">${[0,0.5,1,1.5,2,3].map(v => `<option value="${v}" ${st.pauseAfterPron===v?'selected':''}>${v}s</option>`).join('')}</select></label>
          <label><span>卡間停頓</span><select id="csPauseBet">${[1,2,3,4,5,8].map(v => `<option value="${v}" ${st.pauseBetweenCards===v?'selected':''}>${v}s</option>`).join('')}</select></label>
        </div>
        <button title="朗讀 (P)" id="cardPronBtn">${icon('volume')}</button>
        <button title="編輯標籤" id="cardTagsBtn">${icon('hash')}</button>
        <button title="編輯" id="cardEditBtn" style="color:var(--accent)">${icon('edit')}</button>
        <button title="${st.autoAdvance ? '暫停自動播放' : '自動播放'}" id="cardPlayBtn" style="color:${st.autoAdvance ? 'var(--accent)' : ''}">${icon(st.autoAdvance ? 'pause' : 'play', 16)}</button>
        <button title="${isFull ? '切換半螢幕' : '全螢幕'}" id="cardFullBtn">${icon(isFull ? 'chevronR' : 'chevronL')}</button>
        <button title="關閉" id="cardPreviewClose">${icon('x')}</button>
      </div>
    </div>
    ${cardBodyHTML(w, s)}
    <div class="card-panel-nav">
      ${idx > 0 ? `<button class="card-panel-nav-btn" id="cardPrev">‹</button>` : `<span style="width:36px"></span>`}
      ${browserRulerHTML(total, idx)}
      ${idx < total - 1 ? `<button class="card-panel-nav-btn" id="cardNext">›</button>` : `<span style="width:36px"></span>`}
    </div>
  </div>`;
}

function browserRulerHTML(total, idx) {
  _rulerSpacing = total > 2000 ? 2 : total > 800 ? 3 : 4;
  const w = Math.max(1, (total - 1) * _rulerSpacing);
  const ticks = [];
  for (let i = 0; i < total; i += 10) {
    const p = i * _rulerSpacing;
    ticks.push(`<span class="ruler-tick" style="left:${p}px"><span class="ruler-tick-line"></span><span class="ruler-num">${i === 0 ? 1 : i}</span></span>`);
  }
  return `<div class="card-ruler" id="browserRuler">
    <div class="ruler-track" style="width:${w}px">
      <div class="ruler-base"></div>
      ${ticks.join('')}
      <span class="ruler-ind" id="browserRulerInd" style="left:${idx * _rulerSpacing}px"></span>
    </div>
  </div>`;
}

function scrollBrowserRuler(idx) {
  const r = document.getElementById('browserRuler');
  if (!r) return;
  document.getElementById('browserRulerInd').style.left = `${idx * _rulerSpacing}px`;
  const cw = r.offsetWidth;
  const target = idx * _rulerSpacing - cw / 2;
  r.scrollLeft = Math.max(0, Math.min(target, r.scrollWidth - cw));
}

function bindCardEvents(s, w, st) {
  const body = document.getElementById('cardPreviewBody');
  body.addEventListener('click', onCardBodyClick);
  document.getElementById('cardPreviewClose').addEventListener('click', closeCardPreview);
  document.getElementById('cardEditBtn')?.addEventListener('click', (e) => { e.stopPropagation(); closeCardPreview(); openEditModal(s, w.id); });
  document.getElementById('cardTagsBtn')?.addEventListener('click', (e) => { e.stopPropagation(); closeCardPreview(); openEditTags(s, w.id); });
  const settingsBtn = document.getElementById('cardSettingsBtn');
  const settingsPop = document.getElementById('cardSettingsPop');
  if (settingsBtn && settingsPop) {
    settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); settingsPop.classList.toggle('open'); });
    // G11：outside-click 具名＋冪等 — 重開卡片不疊加（先移除舊再掛新）
    if (_bCardOutside) { document.removeEventListener('click', _bCardOutside); _bCardOutside = null; }
    _bCardOutside = (e) => {
      if (!settingsPop.contains(e.target) && e.target !== settingsBtn) settingsPop.classList.remove('open');
    };
    document.addEventListener('click', _bCardOutside);
    document.getElementById('csPronAuto')?.addEventListener('change', function() { st.pronAuto = this.checked; saveCardSettings(); });
    document.getElementById('csPronManual')?.addEventListener('change', function() { st.pronManual = this.checked; saveCardSettings(); });
    document.getElementById('csPausePron')?.addEventListener('change', function() { st.pauseAfterPron = parseFloat(this.value); saveCardSettings(); });
    document.getElementById('csPauseBet')?.addEventListener('change', function() { st.pauseBetweenCards = parseFloat(this.value); saveCardSettings(); });
  }
  document.getElementById('cardPlayBtn')?.addEventListener('click', (e) => { e.stopPropagation(); st.autoAdvance = !st.autoAdvance; showCard(_cardState.idx); });
  document.getElementById('cardFullBtn')?.addEventListener('click', (e) => { e.stopPropagation(); _cardState.fullscreen = !_cardState.fullscreen; showCard(_cardState.idx); });
  document.getElementById('cardPrev')?.addEventListener('click', () => { stopAuto(); showCard(_cardState.idx - 1); });
  document.getElementById('cardNext')?.addEventListener('click', () => { stopAuto(); showCard(_cardState.idx + 1); });
  scrollBrowserRuler(_cardState.idx);
  if (st.pronManual && w.pron) playCardTTS(s, w.word);
  document.getElementById('cardPronBtn')?.addEventListener('click', (e) => { e.stopPropagation(); playCardTTS(s, w.word); });
  let sx = 0, sy = 0;
  body.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  body.addEventListener('touchend', (e) => {
    const dx = sx - e.changedTouches[0].clientX;
    const dy = sy - e.changedTouches[0].clientY;
    markSwipeMoved(dx, dy);
    // 左右切換只吃水平主導的手勢：斜著往下滑（dy 大）不再誤觸換字
    if (Math.abs(dx) > 40 && Math.abs(dx) > 2 * Math.abs(dy)) {
      if (dx > 0 && _cardState.idx < _cardState.words.length - 1) showCard(_cardState.idx + 1);
      else if (dx < 0 && _cardState.idx > 0) showCard(_cardState.idx - 1);
    }
  }, { passive: true });
  if (_cardKeyHandler) {
    document.removeEventListener('keydown', _cardKeyHandler);
    _cardKeyBound = false;
  }
  _cardKeyHandler = (e) => {
    if (!document.getElementById('cardPreviewModal')) return;
    if (e.key === 'Escape') { closeCardPreview(); return; }
    if (!_cardState) return;
    if (e.key === 'ArrowLeft' && _cardState.idx > 0) { stopAuto(); showCard(_cardState.idx - 1); }
    if (e.key === 'ArrowRight' && _cardState.idx < _cardState.words.length - 1) { stopAuto(); showCard(_cardState.idx + 1); }
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
    if (_bCardOutside) { document.removeEventListener('click', _bCardOutside); _bCardOutside = null; }
    if (_bTagDocHandler) { document.removeEventListener('click', _bTagDocHandler); _bTagDocHandler = null; }
    if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
    const modal = document.getElementById('cardPreviewModal');
    if (modal) modal.remove();
    _cardState = null;
  };
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
    else { stopAuto(); const el = document.getElementById('cardPlayBtn'); if (el) el.innerHTML = icon('play', 16); }
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
  disableWordImageKeys();   // IMG1: 面板關閉停用 carousel 方向鍵（R2 席：Escape 解綁）
  const el = document.getElementById('cardPreviewModal');
  if (el) el.remove();
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = '';
  const main = document.querySelector('.main');
  if (main) main.style.marginRight = '';
}

// EFF：delegation 版 — wordList 容器單一 listener 涵蓋 row click + tag chip click。
// 原逐列綁（500 列 = 500+ listener）在整頁重建時是重綁成本大戶；局部渲染後只需重綁這一個。
function bindListEvents(s) {
  const listEl = document.getElementById('wordList');
  if (!listEl || listEl.dataset.bound === '1') return;   // 已綁（同容器復用）跳過
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
        renderListInPlace(s);
      }).catch(() => {});
      return;
    }
    // row：action 按鈕 or 開卡
    const row = e.target.closest('.word-row[data-word]');
    if (!row) return;
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
      openCardPreview(s, row.dataset.word);
    }
  });
}

function bindWordEvents(s) {
  bindListEvents(s);
}

// ─── Scroll to top ───
function initScrollTop() {
  const btn = document.getElementById('scrollTopBtn');
  const area = document.getElementById('contentArea');
  if (!btn || !area) return;
  const onScroll = () => btn.classList.toggle('show', area.scrollTop > 400);
  area.addEventListener('scroll', onScroll);
  btn.addEventListener('click', () => area.scrollTo({ top: 0, behavior: 'smooth' }));
  onScroll();
}

export function onMount(s) {
  initScrollTop();
  // 顯示上限：db 還原（設定記憶）＋ selector 變更寫回
  import('../lib/db.js').then(m => m.getSetting(DISPLAY_LIMIT_KEY)).then(v => {
    const n = normalizeDisplayLimit(v);
    if (n !== _displayLimit) { _displayLimit = n; renderInPlace(s); }
  }).catch(() => {});
  // 例句限數：db 還原（與工具頁同一設定鍵）— 沒這段 window 變數永遠 undefined＝無限
  import('../lib/db.js').then(m => m.getSetting('exampleDisplayMax')).then(v => {
    const n = Math.max(0, parseInt(v, 10) || 0);
    if (n > 0) window.__maxExampleLines = n;
  }).catch(() => {});
  // 字卡顯示設定：db 還原（換頁/重整不再重置回預設）
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
  document.getElementById('browserLimitSelect')?.addEventListener('change', async (e) => {
    _displayLimit = normalizeDisplayLimit(e.target.value);
    renderInPlace(s);
    try {
      const { setSetting } = await import('../lib/db.js');
      await setSetting(DISPLAY_LIMIT_KEY, String(_displayLimit));
    } catch (_) {}
  });
  const searchInput = document.getElementById('browserSearch');
  if (searchInput) {
    // 搜尋改「Enter / 搜尋鈕」觸發（元首令 2026-08-31）— 不再輸入即時過濾
    const doSearch = () => {
      _query = searchInput.value;
      renderListInPlace(s);
    };
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    document.getElementById('browserSearchBtn')?.addEventListener('click', doSearch);
  }

  document.getElementById('browserScopeToggle')?.addEventListener('click', () => {
    _searchScope = _searchScope === 'worddef' ? 'all' : 'worddef';
    renderInPlace(s);
  });

  const tagTrigger = document.getElementById('browserTagTrigger');
  const tagMenu = document.getElementById('browserTagMenu');
  if (tagTrigger && tagMenu) {
    tagTrigger.addEventListener('click', () => {
      tagMenu.style.display = tagMenu.style.display === 'block' ? 'none' : 'block';
    });
    tagMenu.querySelectorAll('.cs-option').forEach(opt => {
      opt.addEventListener('click', () => {
        _tagFilter = opt.dataset.tagValue || null;
        document.getElementById('browserTagLabel').textContent = _tagFilter || '標籤：全部';
        tagMenu.style.display = 'none';
        renderInPlace(s);
      });
    });
    // G11：outside-click 具名＋冪等（onMount 重複註冊不疊加）
    if (_bTagDocHandler) { document.removeEventListener('click', _bTagDocHandler); _bTagDocHandler = null; }
    _bTagDocHandler = (e) => {
      if (!e.target.closest('#browserTagDropdown')) {
        tagMenu.style.display = 'none';
      }
    };
    document.addEventListener('click', _bTagDocHandler);
  }

  document.querySelectorAll('.exam-deck-chip[data-deck]').forEach(el => {
    el.addEventListener('click', () => {
      _deckFilter = el.dataset.deck || null;
      renderInPlace(s);
    });
  });

  const sortBtn = document.getElementById('browserSortToggle');
  if (sortBtn) sortBtn.addEventListener('click', () => {
    _sortRandom = !_sortRandom;
    renderInPlace(s);
  });

  const seedInput = document.getElementById('browserSeed');
  if (seedInput) {
    const onSeedChange = () => {
      _sortSeed = seedInput.value;
      renderInPlace(s);
      const el = document.getElementById('browserSeed');
      if (el) el.focus();
    };
    seedInput.addEventListener('change', onSeedChange);
    seedInput.addEventListener('keydown', e => { if (e.key === 'Enter') onSeedChange(); });
  }

  const addBtn = document.getElementById('browserAddWord');
  if (addBtn) addBtn.addEventListener('click', () => openAddModal(s));

  bindWordEvents(s);
}

async function inlineEditTags(s, id) {
  const w = s.state.words.find(x => x.id === id);
  if (!w) return;
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const existing = document.getElementById('tagPickerModal');
  if (existing) existing.remove();

  container.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay open" id="tagPickerModal">
      <div class="modal" style="max-width:360px">
        <div class="modal-header">
          <div class="modal-title">${icon('hash')} 編輯標籤：${escapeHtml(w.word)}</div>
          <button class="modal-close" id="tagPickerClose">${icon('x')}</button>
        </div>
        <div class="form-group" style="padding:var(--s4)">
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="tagPickerGroup">
            ${tagPickerHtml(s.state.systemTags || [], s.state.tags || [], w.tags || [], 'tag-picker-cb')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" id="tagPickerCancel">取消</button>
          <button class="btn-primary" id="tagPickerSave">${icon('check')} 儲存</button>
        </div>
      </div>
    </div>`);

  const close = () => document.getElementById('tagPickerModal')?.remove();
  document.getElementById('tagPickerClose')?.addEventListener('click', close);
  document.getElementById('tagPickerCancel')?.addEventListener('click', close);
  document.getElementById('tagPickerModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'tagPickerModal') close();
  });
  document.getElementById('tagPickerSave')?.addEventListener('click', async () => {
    const cbs = document.querySelectorAll('#tagPickerGroup .tag-picker-cb:checked');
    const tags = Array.from(cbs).map(cb => cb.value);
    await s.actions.editWord(id, { tags });
    toast(`已更新標籤`, 'toast-success');
    close();
    renderInPlace(s);
  });
}

// EFF：搜尋/過濾變更只更新清單區（wordList+結果列），不整頁 innerHTML 重建 —
// 整頁重建會：500 卡重解析＋onMount 全 listener 重綁＋scroll 跳頂＋focus 搶救，
// 是打字卡頓主因。工具列（搜尋框/標籤/排序）不在更新面 → focus 零搶救、listener 零重綁。
function renderListInPlace(s) {
  const listEl = document.getElementById('wordList');
  const headEl = document.getElementById('browserListHead');
  if (!listEl || !headEl) { renderInPlace(s); return; }   // 結構變動 fallback 全渲染
  const { words } = s.state;
  const filtered = filterWords(words);
  const display = capList(filtered, _displayLimit);
  const sysTags = s.state.systemTags || [];
  const deckNames = (s.state.decks || []).map(d => d.name);
  headEl.innerHTML = `
    <span style="font-size:12px;color:var(--text-tertiary);font-weight:500">
      ${limitNote(filtered, _displayLimit)}
    </span>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-tertiary)">
      上限
      ${limitSelectHtml('browserLimitSelect', _displayLimit)}
    </label>`;
  listEl.innerHTML = display.map(w => wordRowHtml(w, s.state.tagConfig, sysTags, deckNames)).join('');
  bindListEvents(s);   // 清單區 listener 重綁（delegation 一次搞定，見下）
  document.getElementById('browserLimitSelect')?.addEventListener('change', async (e) => {
    _displayLimit = normalizeDisplayLimit(e.target.value);
    try {
      const { setSetting } = await import('../lib/db.js');
      await setSetting(DISPLAY_LIMIT_KEY, String(_displayLimit));
    } catch (_) {}
    renderListInPlace(s);
  });
}

function renderInPlace(s) {
  const container = document.getElementById('pageContainer');
  if (container) {
    container.innerHTML = render(s);
    onMount(s);
    import('../lib/custom-select.js').then(m => m.initCustomSelects(container));
  }
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

function speakWord(id) {
  const row = document.querySelector(`.word-row[data-word="${cssEscape(id)}"] .word-row-word`);
  const word = row?.textContent || '';
  if (!word) return;
  speak(word, store.state.ttsSpeed, store.state.ttsVoice, store.state.ttsPitch);
}

function openAddModal(s) {
  openModal(s, null);
}

function openEditModal(s, id) {
  const w = s.state.words.find(x => x.id === id);
  if (!w) return;
  openModal(s, w);
}

function openModal(s, word) {
  const isEdit = !!word;
  const decks = s.state.decks;
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const existing = document.getElementById('wordModal');
  if (existing) existing.remove();

  const html = `
    <div class="modal-overlay open" id="wordModal">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${icon(isEdit ? 'edit' : 'plus')} ${isEdit ? '編輯單字' : '新增單字'}</div>
          <button class="modal-close" id="modalClose">${icon('x')}</button>
        </div>
        <div class="form-group">
          <label class="form-label">單字 *</label>
          <div style="display:flex;gap:4px">
            <input class="form-input" id="fWord" placeholder="apple" value="${escapeAttr(word?.word || '')}" style="flex:1" autofocus>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">定義</label>
          <input class="form-input" id="fDefinition" placeholder="多個定義用逗號分隔">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fDefChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">詞性</label>
            <div style="display:flex;flex-wrap:wrap;gap:4px" id="fPosGroup">
              ${['名詞','動詞','形容詞','副詞','介係詞','連接詞','代名詞','感嘆詞','限定詞','冠詞','片語','慣用語','後綴','前綴','縮寫','複數名詞'].map(p => {
                const sel = (word?.pos || '').split(',').map(s => s.trim()).includes(p);
                return `<span class="pos-chip ${sel ? 'selected' : ''}" data-pos="${p}" style="cursor:pointer;padding:2px 10px;border-radius:100px;font-size:12px;border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};background:${sel ? 'var(--accent)' : 'var(--bg-surface)'};color:${sel ? 'var(--accent-on)' : 'var(--text-secondary)'};transition:background-color .15s,border-color .15s,color .15s">${p}</span>`;
              }).join('')}
            </div>
          </div>
        <div class="form-row" style="${isMobile ? 'flex-direction:column' : ''}">
          <div class="form-group" style="flex:1">
            <label class="form-label">發音</label>
            <input class="form-input" id="fPron" placeholder="/ˈæp.əl/" value="${escapeAttr(word?.pron || '')}">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">音節</label>
            <input class="form-input" id="fSyllables" placeholder="例：dict·io·nary；Enter 跳下一欄" value="${escapeAttr(word?.syllables || '')}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">例句（含片語）</label>
          <div style="display:flex;gap:4px;${isMobile ? 'flex-direction:column' : ''}"><input class="form-input" id="fExample" placeholder="輸入後按 Enter（一行一筆；片語同一欄）" style="flex:1"><button class="btn btn-sm" id="btnFillExample" type="button" title="依順序新增一句例句" style="align-self:flex-start">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fExChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">描述</label>
          <textarea class="form-input" id="fDescription" rows="2" placeholder="補充說明、記憶技巧...；Ctrl+Enter 跳下一欄" style="resize:vertical">${escapeHtml(word?.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">相關詞</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="fRelated" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="btnFillRelated" type="button" title="LLM 自動產生相關詞">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fRelatedChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">詞形變化</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="fForms" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="btnFillForms" type="button" title="LLM 自動產生詞形變化">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fFormsChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">相似詞</label>
            <div style="display:flex;gap:4px"><input class="form-input" id="fSynonyms" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="btnFillSynonyms" type="button" title="LLM 自動產生相似詞">${icon('sparkle')}</button></div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fSynonymChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">反義詞</label>
            <div style="display:flex;gap:4px"><input class="form-input" id="fAntonyms" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="btnFillAntonyms" type="button" title="LLM 自動產生反義詞">${icon('sparkle')}</button></div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fAntonymChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">衍生物</label>
          <div style="display:flex;gap:4px"><input class="form-input" id="fDerivatives" placeholder="輸入後按 Enter 存入膠囊（逗號分隔多筆）；空 Enter 跳下一欄" style="flex:1"><button class="btn btn-sm" id="btnFillDerivatives" type="button" title="LLM 自動產生衍生物">${icon('sparkle')}</button></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;min-height:24px" id="fDerivativeChips"></div>
        </div>
        <div class="form-group">
          <label class="form-label">字源</label>
          <textarea class="form-input" id="fEtymology" rows="2" style="resize:vertical" placeholder="字源與首次使用；Ctrl+Enter 跳下一欄">${escapeHtml(word?.etymology || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">字本</label>
          <select class="form-input" id="fDeck">
            ${decks.length > 0 ? decks.map(d => `<option value="${escapeAttr(d.name)}" ${word?.deck === d.name ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('') : ''}
            ${!decks.some(d => d.name === 'Default') ? '<option value="Default">Default</option>' : ''}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">圖片 <span style="font-size:11px;color:var(--text-tertiary)">（可多張；儲存時全量替換）</span></label>
          <div id="fImagesThumbs"></div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-top:6px">
            <input type="file" id="fImageFiles" accept="image/*" multiple style="display:none">
            <button class="btn btn-sm" type="button" id="fImagePick">${icon('image')} 選擇圖片</button>
            <span style="font-size:11px;color:var(--text-tertiary)">PNG/JPG；單張 ≤10MB</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">標籤</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="fTagGroup">
            ${tagPickerHtml(s.state.systemTags || [], s.state.tags || [], word?.tags || [], 'tag-checkbox')}
          </div>
        </div>
        <div class="form-group" style="border-top:1px solid var(--border);padding-top:var(--s2);margin-top:var(--s2)">
          <label class="form-label">自動填入順序 <span style="font-size:11px;color:var(--text-tertiary)">（點 chip 往後移）</span></label>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:var(--s2)" id="fAutoOrderChips"></div>
          <div style="display:flex;gap:var(--s2);align-items:center">
            <button class="btn" id="fAutoFill">${icon('search')} 自動填入</button>
          </div>
        </div>
        <div class="modal-footer">
          ${isEdit ? `<button class="btn btn-danger" id="modalDelete" style="margin-right:auto">${icon('trash')} 刪除</button>` : ''}
          <button class="btn" id="modalCancel">取消</button>
          <button class="btn-primary" id="modalSave">${icon('check')} ${isEdit ? '儲存' : '新增'}</button>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  // ── 統一膠囊輸入系統（元首令 2026-08-31 v2 — 與 deck-browser 同款）──
  // Enter 存膠囊（逗號分割）；例句模式（sep=null）整句一顆；點膠囊回編輯（例句半成品先存回）
  const _tagInput = (containerId, inputId, chipClass, initialVal, sep, jn, style) => {
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
          const vals = draft.split(spl).map(x => x.trim()).filter(Boolean); vals.push(clicked); input.value = vals.join(jn);   // 一般：追加（分隔一致）
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
  const defSep = ',', defJn = ', ';
  const exSep = null, exJn = '\n';   // 例句模式：sep=null（逗號屬句子一部分）
  const defIn = word?.definition || '';
  const exIn = mergeExamplePhrases(word?.example, word?.phrases);
  const _defChips = _tagInput('fDefChips', 'fDefinition', 'def-chip', defIn, defSep, defJn, 'display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:100px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s');
  const exChips = _tagInput('fExChips', 'fExample', 'ex-chip', exIn, exSep, exJn, 'display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:6px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s');
  // 統一膠囊：相似/反義/衍生物/相關詞/詞形變化（既有值預載；編輯+新增共用 modal）
  const _pillStyleB = 'display:inline-flex;align-items:center;gap:4px;padding:1px 10px;border-radius:100px;font-size:12px;background:var(--accent);color:var(--accent-on);cursor:pointer;transition:background-color .15s,border-color .15s,color .15s';
  const synChips = _tagInput('fSynonymChips', 'fSynonyms', 'pill-chip', word?.synonym || '', ',', ', ', _pillStyleB);
  const antChips = _tagInput('fAntonymChips', 'fAntonyms', 'pill-chip', word?.antonym || '', ',', ', ', _pillStyleB);
  const derivChips = _tagInput('fDerivativeChips', 'fDerivatives', 'pill-chip', word?.derivative || '', ',', ', ', _pillStyleB);
  const relChips = _tagInput('fRelatedChips', 'fRelated', 'pill-chip', (word?.related || []).join(', '), ',', ', ', _pillStyleB);
  const formsChips = _tagInput('fFormsChips', 'fForms', 'pill-chip', (word?.forms || []).join(', '), ',', ', ', _pillStyleB);

  const close = () => document.getElementById('wordModal')?.remove();
  document.getElementById('modalClose')?.addEventListener('click', close);
  document.getElementById('modalCancel')?.addEventListener('click', close);

  // ── IMG1: 圖片縮圖列（編輯時載入現圖；選檔/排序/刪除；存檔全量替換）──
  let _imgApi = null;
  let _imgCleanup = null;
  let _imgsChanged = false;
  const thumbsEl = document.getElementById('fImagesThumbs');
  const renderImgs = (list) => {
    _imgsChanged = true;   // 任何變更（含排序/刪除）都標記，存檔時全量替換
    if (!thumbsEl) return;
    if (_imgCleanup) _imgCleanup();
    thumbsEl.innerHTML = _imgApi ? _imgApi.html : '';
    _imgCleanup = _imgApi ? bindEditorThumbs(thumbsEl, _imgApi) : null;
  };
  (async () => {
    if (!isEdit || !word) { _imgApi = renderEditorThumbs([], renderImgs); renderImgs(); _imgsChanged = false; return; }
    const existing = await getWordImages(word.id);
    _imgApi = renderEditorThumbs(existing, renderImgs);
    renderImgs();
    _imgsChanged = false;   // 初始化渲染不標記（只有使用者操作後才寫庫）
  })().catch(() => { _imgApi = renderEditorThumbs([], renderImgs); renderImgs(); _imgsChanged = false; });
  document.getElementById('fImagePick')?.addEventListener('click', () => document.getElementById('fImageFiles')?.click());
  document.getElementById('fImageFiles')?.addEventListener('change', async (ev) => {
    if (!_imgApi) return;
    await _imgApi.addFiles([...(ev.target.files || [])], (m) => toast(m, 'toast-error'));
    _imgsChanged = true;
    ev.target.value = '';
  });
  document.getElementById('wordModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'wordModal') close();
  });

  // 新增器連續輸入：最後一欄 Enter 觸發的儲存，存完直接開下一筆（點儲存鈕則照舊關閉）
  let _enterChainAdd = false;
  document.getElementById('modalSave')?.addEventListener('click', async () => {
    const _chained = _enterChainAdd; _enterChainAdd = false;
    const tagCbs = document.querySelectorAll('#fTagGroup .tag-checkbox:checked');
    const defEl = document.getElementById('fDefinition');
    const exEl = document.getElementById('fExample');
    if (defEl && defEl.value.trim()) { _defChips.append(defEl.value.trim()); defEl.value = ''; }
    if (exEl && exEl.value.trim()) { exChips.append(exEl.value.trim()); exEl.value = ''; }
    // 統一膠囊：殘留輸入框內容 Enter 同款併入膠囊（防使用者沒按 Enter 就存檔）
    for (const [el, ch] of [['fSynonyms', synChips], ['fAntonyms', antChips], ['fDerivatives', derivChips], ['fRelated', relChips], ['fForms', formsChips]]) {
      const e2 = document.getElementById(el);
      if (e2 && e2.value.trim()) { ch.append(e2.value.trim()); e2.value = ''; }
    }
    const data = {
      word: document.getElementById('fWord')?.value.trim() || '',
      definition: _defChips.getVal(),
      pos: Array.from(document.querySelectorAll('#fPosGroup .pos-chip.selected')).map(el => el.dataset.pos).join(', '),
      pron: document.getElementById('fPron')?.value.trim() || '',
      example: mergeExamplePhrases(exChips.getVal(), (isEdit && word?.phrases) ? word.phrases : ''),
      description: document.getElementById('fDescription')?.value.trim() || '',
      related: relChips.getVal().split(/[,，]/).map(x => x.trim()).filter(Boolean),
      forms: formsChips.getVal().split(/[,，]/).map(x => x.trim()).filter(Boolean),
      synonym: synChips.getVal(),
      antonym: antChips.getVal(),
      derivative: derivChips.getVal(),
      etymology: document.getElementById('fEtymology')?.value.trim() || '',
      syllables: document.getElementById('fSyllables')?.value.trim() || '',
      phrases: '',
      deck: document.getElementById('fDeck')?.value || 'Default',
      tags: Array.from(tagCbs).map(cb => cb.value),
    };
    if (!data.word) { toast('請輸入單字', 'toast-error'); return; }
    data.word = data.word.toLowerCase();

    try {
      let savedId = word?.id;
      if (isEdit && word) {
        await s.actions.editWord(word.id, data);
        toast(`已更新「${data.word}」`, 'toast-success');
      } else {
        const dup = s.state.words.find(w => w.word.toLowerCase().trim() === data.word);
        if (dup) { showMergeModal(s, dup, data, close); return; }
        const added = await s.actions.addWord(data);
        savedId = added?.id;
        toast(`已新增「${data.word}」`, 'toast-success');
      }
      // IMG1: 圖片全量替換（僅動過才寫——全刪全插保序；新增字直接寫入）
      if (_imgApi && savedId && _imgsChanged) {
        const finalImgs = _imgApi.getVal();
        await deleteWordImagesForWord(savedId);
        for (const im of finalImgs) {
          await addWordImage(savedId, im.filename, im.data);
        }
        invalidateWordImages(savedId);
      }
      close();
      renderInPlace(s);
      if (_chained && !isEdit) openModal(s, null);   // 連續新增：直接開下一筆
    } catch (e) { toast('儲存失敗: ' + e, 'toast-error'); }
  });

  document.getElementById('btnFillRelated')?.addEventListener('click', () => {
    const w = document.getElementById('fWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    llmFillRelated('fRelated', w);
  });

  // 相似/反義/衍生物 sparkle（單鈕觸發三欄一包填入）
  for (const btn of ['btnFillSynonyms', 'btnFillAntonyms', 'btnFillDerivatives']) {
    document.getElementById(btn)?.addEventListener('click', () => {
      const w = document.getElementById('fWord')?.value.trim();
      if (!w) { toast('請先輸入單字', 'toast-error'); return; }
      llmFillSynAntDeriv(w);
    });
  }

  document.getElementById('btnFillForms')?.addEventListener('click', () => {
    const w = document.getElementById('fWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    llmFillForms('fForms', w);
  });

  document.getElementById('btnFillExample')?.addEventListener('click', async () => {
    const w = document.getElementById('fWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    const norm = s => s.trim().toLowerCase().replace(/[.。!！?？,，;；:：\s]+$/, '');
    const existing = new Set(exChips.getVal().split('\n').map(s => norm(s)).filter(Boolean));
    const chain = getChain();
    for (const src of chain) {
      let raw = [];
      try {
        if (src === 'cambridge') {
          const json = await lookupCambridge(w, 'zh');
          const d = JSON.parse(json);
          if (d.senses?.length) {
            const hasZh = 'translation' in d.senses[0];
            raw = d.senses.flatMap(s => (s.examples || []).map(ex => (hasZh ? ex.english : (typeof ex === 'string' ? ex : ex.english))).filter(Boolean));
          }
        } else if (src === 'merriam') {
          // 韋氏片語即例句候選（片語已併入例句）
          try {
            const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
            if (dk || tk) {
              const f = merriamToFields(JSON.parse(await lookupMerriam(w, dk, tk)), w);
              if (f?.phrases) raw = f.phrases.split('\n').map(x => x.trim()).filter(Boolean);
            }
          } catch (e) {}
        } else if (src === 'dict-api') {
          const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
          if (r.ok) {
            raw = (await r.json()).flatMap(e =>
              (e.meanings || []).flatMap(m => (m.definitions || []).map(d => d.example).filter(Boolean))
            );
          }
        } else if (src === 'tatoeba') {
          const r = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w)}&lang=eng`);
          if (r.ok) {
            raw = ((await r.json()).data || []).map(s => s.text).filter(Boolean);
          }
        } else if (src === 'llm') {
          const baseUrl = (document.getElementById('llmUrl')?.value?.trim()?.replace(/\/api\/generate$/, '') || 'http://localhost:11434');
          const tagsResp = await fetchGet(`${baseUrl}/api/tags`);
          const models = (JSON.parse(tagsResp).models || []).map(m => m.name);
          if (models.length) {
            const t = await fetchLLM(`${baseUrl}/api/generate`, models[0],
              `Generate a simple English example sentence using "${w}". Return ONLY the sentence, nothing else.`
            );
            if (t) raw = [t.trim()];
          }
        }
      } catch (e) {}
      const seen = new Set();
      const deduped = raw.filter(s => { const k = norm(s); return k && !seen.has(k) && seen.add(k); });
      const fresh = deduped.find(s => !existing.has(norm(s)));
      if (fresh) {
        exChips.append(fresh.trim());
        toast(`已從 ${SOURCE_LABELS[src] || src} 新增一句`, 'toast-success');
        return;
      }
    }
    toast('所有來源都沒有新句子', '');
  });

  document.getElementById('fWord')?.addEventListener('blur', () => {
    const w = document.getElementById('fWord')?.value.trim();
    if (w && w !== _lastAutoFilled) autoFillAll();
  });

  const SOURCE_LABELS = { cambridge: 'Cambridge', merriam: '韋氏字典', 'dict-api': '字典API', tatoeba: 'Tatoeba', llm: 'LLM' };
  const DEFAULT_CHAIN = ['cambridge', 'merriam', 'dict-api', 'tatoeba', 'llm'];
  const KNOWN_SRC = new Set(DEFAULT_CHAIN);
  // 舊存檔只有四步（無 merriam）：過濾未知值＋把缺的 merriam 補到 llm 之前
  const _normalizeChain = (arr) => {
    const kept = arr.map(s => s.trim()).filter(s => KNOWN_SRC.has(s));
    if (!kept.includes('merriam')) {
      const li = kept.indexOf('llm');
      if (li === -1) kept.push('merriam'); else kept.splice(li, 0, 'merriam');
    }
    return kept.length ? kept : [...DEFAULT_CHAIN];
  };
  let autoFillChain = [...DEFAULT_CHAIN];
  const renderChips = () => {
    const c = document.getElementById('fAutoOrderChips');
    if (!c) return;
    c.innerHTML = autoFillChain.map((k, i) =>
      `<span class="fAutoChip" data-idx="${i}" style="cursor:pointer;background:var(--bg-tertiary);padding:2px 8px;border-radius:4px;font-size:12px;display:inline-flex;align-items:center;gap:4px">${i + 1}. ${SOURCE_LABELS[k] || k} ›</span>`
    ).join('');
  };
  import('../lib/db.js').then(m => m.getSetting('autoFillOrder').then(v => {
    if (v) { autoFillChain = _normalizeChain(v.split(/[,|;]/).map(s => s.trim()).filter(Boolean)); renderChips(); }
  }));
  renderChips();
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.fAutoChip');
    if (!chip) return;
    const idx = parseInt(chip.dataset.idx, 10);
    const next = (idx + 1) % autoFillChain.length;
    [autoFillChain[idx], autoFillChain[next]] = [autoFillChain[next], autoFillChain[idx]];
    renderChips();
    import('../lib/db.js').then(m => m.setSetting('autoFillOrder', autoFillChain.join('|')).catch(() => {}));
  });
  const getChain = () => autoFillChain;

  const _posCN = {noun:'名詞',verb:'動詞',adjective:'形容詞',adverb:'副詞',preposition:'介係詞',conjunction:'連接詞',pronoun:'代名詞',interjection:'感嘆詞',exclamation:'感嘆詞',determiner:'限定詞',article:'冠詞',phrase:'片語',idiom:'慣用語',suffix:'後綴',prefix:'前綴',abbreviation:'縮寫','plural noun':'複數名詞'};
  const _normalizePos = (pos) => (pos || '').split(',').map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(Boolean).join(', ');
  const _getPosVal = () => Array.from(document.querySelectorAll('#fPosGroup .pos-chip.selected')).map(el => el.dataset.pos).join(', ');
  const _selectPosChips = (posStr) => {
    const vals = posStr.split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('#fPosGroup .pos-chip').forEach(chip => {
      const on = vals.includes(chip.dataset.pos);
      chip.classList.toggle('selected', on);
      chip.style.background = on ? 'var(--accent)' : 'var(--bg-surface)';
      chip.style.color = on ? 'var(--accent-on)' : 'var(--text-secondary)';
      chip.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
    });
  };

  let _lastAutoFilled = '';
  const autoFillAll = async () => {
    const w = document.getElementById('fWord')?.value.trim();
    if (!w) { toast('請先輸入單字', 'toast-error'); return; }
    const btn = document.getElementById('fAutoFill');
    if (btn) btn.disabled = true;
    const g = id => {
      if (id === 'fPos') return _getPosVal();
      if (id === 'fDefinition') return _defChips.getVal();
      if (id === 'fExample') return exChips.getVal();
      return document.getElementById(id)?.value?.trim() || '';
    };
    const s = (id, val) => {
      if (!val) return;
      if (id === 'fDefinition') { if (!g('fDefinition')) _defChips.setVal(val); }
      else if (id === 'fExample') { if (!g('fExample')) exChips.setVal(val); }
      // 片語已併入例句：韋氏/LLM 片語去重接續進例句膠囊
      else if (id === 'fExampleAppend') { if (val) exChips.setVal(mergeExamplePhrases(exChips.getVal(), val)); }
      else { const e = document.getElementById(id); if (e && !e.value.trim()) e.value = val; }
    };
    const chain = getChain();
    let cambridgeFailed = false;
    for (const src of chain) {
      if (src === 'cambridge') {
        try {
          const json = await lookupCambridge(w, 'zh');
          const d = JSON.parse(json);
          s('fWord', d.word);
          s('fPron', d.uk_ipa || d.us_ipa);
          if (d.senses?.length) {
            const hasZh = 'translation' in d.senses[0];
            const defs = [...new Set(d.senses.map(s => (hasZh ? s.translation : s.definition)).filter(Boolean))].map(d => d.replace(/;/g, ','));
            const pos = [...new Set(d.senses.flatMap(s => (s.part_of_speech || '').split(',').map(p => p.trim())).filter(Boolean))];
            s('fDefinition', defs.join(', '));
            _selectPosChips(_normalizePos(pos.join(', ')));
            const exs = [...new Set(d.senses.flatMap(s => (s.examples || []).map(ex => hasZh ? ex.english : (typeof ex === 'string' ? ex : ex.english))).filter(Boolean))];
            if (exs.length && !g('fExample')) s('fExample', exs.join('\n'));
          }
        } catch (e) {
          cambridgeFailed = true;
        }
      } else if (src === 'merriam') {
        // 韋氏鏈步驟：有 key 才跑（音節/字源/片語只填空欄；無 key 靜默跳過不擋後續）
        try { await mwFillExtra(s, g, w); } catch (_) {}
      } else if (src === 'dict-api') {
        try {
          const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
          if (r.ok) {
            const exs = (await r.json()).flatMap(e =>
              (e.meanings || []).flatMap(m => (m.definitions || []).map(d => d.example).filter(Boolean))
            );
            if (exs.length && !g('fExample')) s('fExample', exs.join('\n'));
          }
        } catch (e) {}
      } else if (src === 'tatoeba') {
        try {
          const r = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w)}&lang=eng`);
          if (r.ok) {
            const exs = ((await r.json()).data || []).map(s => s.text).filter(Boolean);
            if (exs.length && !g('fExample')) s('fExample', exs.join('\n'));
          }
        } catch (e) {}
      } else if (src === 'llm') {
        if (!g('fDefinition') || !g('fPos') || !g('fPron') || !g('fExample') || !g('fRelated') || !g('fForms') || !g('fEtymology')) {
          try {
            // Ollama 位址：設定頁 store 優先（modal 內無 llmUrl 元素時 fallback 本機）
            const baseUrl = (store.state.ollamaUrl || document.getElementById('llmUrl')?.value?.trim()?.replace(/\/api\/generate$/, '') || 'http://localhost:11434');
            const tagsResp = await fetchGet(`${baseUrl}/api/tags`);
            const models = (JSON.parse(tagsResp).models || []).map(m => m.name);
            if (models.length) {
              const model = models[0];
              if (!g('fDefinition')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model,
                  `用繁體中文列出「${w}」的定義。多個定義用「、」分隔。只回傳定義，不要其他內容。`
                );
                if (t) s('fDefinition', t.trim().replace(/、/g, ', '));
              }
              if (!g('fPos')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model,
                  `What is/are the part(s) of speech of "${w}"? Return comma-separated English labels only (e.g. noun, verb, adjective).`
                );
                if (t) _selectPosChips(_normalizePos(t.trim()));
              }
              if (!g('fExample')) {
                const t = await fetchLLM(`${baseUrl}/api/generate`, model,
                  `Generate a short English example sentence using "${w}". Return ONLY the sentence, nothing else.`
                );
                if (t) s('fExample', t.trim());
              }
              await Promise.all([
                llmFillRelated('fRelated', w),
                llmFillForms('fForms', w),
                llmFillSynAntDeriv(w),
                (async () => {
                  // 字源：LLM 一鍵分支順手補（只填空欄；韋氏在鏈內時先寫者勝；音節只吃韋氏）
                  const bUrl = (store.state.ollamaUrl || 'http://localhost:11434');
                  const mdl = store.state.ollamaModel || (models[0] || 'qwen2.5-coder:7b');
                  if (!g('fEtymology')) {
                    try {
                      const t = await fetchLLM(`${bUrl}/api/generate`, mdl,
                        `用繁體中文一句話說明英文單字「${w}」的字源（來自何語、何詞根）。只回傳這一句，不要其他內容。`);
                      if (t) s('fEtymology', t.trim());
                    } catch (_) {}
                  }
                  // 片語已併入例句：LLM 片語去重接續進例句（韋氏鏈步驟有 key 時走韋氏，此處不搶）
                  try {
                    const t = await fetchLLM(`${bUrl}/api/generate`, mdl,
                      `List 3-5 common English phrases or collocations using the word "${w}", one per line. Return ONLY the phrases, nothing else.`);
                    if (t) s('fExampleAppend', [...new Set(t.trim().split('\n').map(x => x.trim()).filter(Boolean))].join('\n'));
                  } catch (_) {}
                })()
              ]);
            }
          } catch (e) { toast('LLM 連線失敗，請確認 Ollama 有開', 'toast-error'); }
        }
      }
    }
    if (cambridgeFailed) toast('Cambridge 查詢失敗，已用其他來源', '');
    // 舊鏈回補：存檔鏈不含 merriam（v5.16.3 前存的）才跑；新鏈走鏈內步驟
    if (!chain.includes('merriam')) { try { await mwFillExtra(s, g, w); } catch (_) {} }
    _lastAutoFilled = w;
  };

  document.getElementById('fAutoFill')?.addEventListener('click', autoFillAll);

  document.getElementById('fPosGroup')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.pos-chip');
    if (!chip) return;
    chip.classList.toggle('selected');
    chip.style.background = chip.classList.contains('selected') ? 'var(--accent)' : 'var(--bg-surface)';
    chip.style.color = chip.classList.contains('selected') ? 'var(--accent-on)' : 'var(--text-secondary)';
    chip.style.borderColor = chip.classList.contains('selected') ? 'var(--accent)' : 'var(--border)';
  });

  // Enter 導覽（由上而下；描述/字源 textarea 需 Ctrl+Enter；膠囊欄空 Enter 跳轉、有字就地存膠囊）
  const fieldIds = ['fWord', 'fDefinition', 'fPron', 'fSyllables', 'fExample', 'fDescription', 'fRelated', 'fForms', 'fSynonyms', 'fAntonyms', 'fDerivatives', 'fEtymology', 'fDeck'];
  const _jumpNext = (curId) => {
    const idx = fieldIds.indexOf(curId);
    if (idx === -1) return;
    if (idx < fieldIds.length - 1) {
      document.getElementById(fieldIds[idx + 1])?.focus();
    } else {
      _enterChainAdd = true;
      document.getElementById('modalSave')?.click();
    }
  };

  document.getElementById('wordModal')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (el.tagName === 'TEXTAREA') {
      // 描述/字源：普通 Enter 換行；Ctrl/Cmd+Enter 跳下一欄
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); _jumpNext(el.id); }
      return;
    }
    if ((el.id === 'fDefinition' || el.id === 'fExample') && el.value.trim()) return;
    const idx = fieldIds.indexOf(el.id);
    if (idx === -1) return;
    e.preventDefault();

    if (el.id === 'fWord') {
      autoFillAll();
    }
    _jumpNext(el.id);
  });

  if (isEdit) {
    document.getElementById('modalDelete')?.addEventListener('click', async () => {
      if (!word) return;
      if (!confirm(`確定要刪除「${word.word}」？`)) return;
      await s.actions.deleteWord(word.id);
      toast(`已刪除「${word.word}」`, 'toast-success');
      close();
      renderInPlace(s);
    });
  }
}

/** 韋氏三欄一鍵（modal 版；音節/字源填空欄，片語併入例句；有 key 才跑） */
async function mwFillExtra(s, g, word) {
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      const raw = await lookupMerriam(word, dk, tk);
      const f = merriamToFields(JSON.parse(raw), word);
      if (f) {
        if (f.syllables) s('fSyllables', f.syllables);
        if (f.etymology) s('fEtymology', f.etymology);
        if (f.phrases) s('fExampleAppend', f.phrases);
        return;
      }
    } catch (_) { /* 掉回 LLM */ }
  }
  // 無 key：LLM 片語併入例句（音節只吃韋氏，此處不補）
  try { await mwFillPhrases('fExChips', word); } catch (_) {}
}

/** 片語 sparkle／兜底：韋氏優先（有 key），無 key 走 LLM；一律去重併入例句膠囊 */
async function mwFillPhrases(chipsHostId, word) {
  const host = document.getElementById(chipsHostId);
  const api = host?._tagInputApi;
  if (!api) return;
  const dk = store.state.mwDictKey || '', tk = store.state.mwThesKey || '';
  if (dk || tk) {
    try {
      const raw = await lookupMerriam(word, dk, tk);
      const f = merriamToFields(JSON.parse(raw), word);
      if (f?.phrases?.trim()) {
        api.setVal(mergeExamplePhrases(api.getVal(), f.phrases));
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

// ─── LLM auto-fill for related and forms ───────────────────────
async function llmFillRelated(inputId, word) {
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
        // 膠囊系統：值寫入 chips（容器有 API 用之；fallback 舊 input 行為）
        const chipsHost = document.getElementById(inputId + 'Chips');
        if (chipsHost && chipsHost._tagInputApi) chipsHost._tagInputApi.setVal([...new Set(arr)].join(', '));
        else document.getElementById(inputId).value = [...new Set(arr)].join(', ');
      }
    }
  } catch (e) {
    toast('LLM 產生失敗: ' + e, 'toast-error');
  }
}

/** LLM 填相似/反義/衍生物（browser modal 版；只填空欄） */
async function llmFillSynAntDeriv(word) {
  const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
  const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
  const tasks = [
    { id: 'fSynonyms', prompt: `Return a JSON array of synonyms for "${word}". Example: ["obtain","receive"]. Only the JSON array, no markdown.` },
    { id: 'fAntonyms', prompt: `Return a JSON array of antonyms for "${word}". Example: ["lose","discard"]. Only the JSON array, no markdown.` },
    { id: 'fDerivatives', prompt: `Return a JSON array of word derivations (adverb, noun, adjective forms) for "${word}". Example: ["happily","happiness"]. Only the JSON array, no markdown.` },
  ];
  await Promise.all(tasks.map(async t => {
    const el = document.getElementById(t.id);
    if (!el) return;
    const host = document.getElementById(t.id === 'fSynonyms' ? 'fSynonymChips' : t.id === 'fAntonyms' ? 'fAntonymChips' : 'fDerivativeChips');
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

async function llmFillForms(inputId, word) {
  try {
    const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
    const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
    const text = await fetchLLM(`${baseUrl}/api/generate`, model,
      `Return a JSON array of grammatical inflections/forms for "${word}" (e.g. for verbs: past tense, present participle, third person singular; for nouns: plural; for adjectives: comparative, superlative). Example: ["gets","getting","got","gotten"]. Only the JSON array, no markdown.`
    );
    if (text && text.trim()) {
      const cleaned = text.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        // 膠囊系統：值寫入 chips（容器有 API 用之；fallback 舊 input 行為）
        const chipsHost = document.getElementById(inputId + 'Chips');
        if (chipsHost && chipsHost._tagInputApi) chipsHost._tagInputApi.setVal([...new Set(arr)].join(', '));
        else document.getElementById(inputId).value = [...new Set(arr)].join(', ');
      }
    }
  } catch (e) {
    toast('LLM 產生失敗: ' + e, 'toast-error');
  }
}

// ─── HTML escaping helpers ───
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
function cssEscape(str) {
  return String(str ?? '').replace(/["\\]/g, '\\$&');
}

function showMergeModal(s, existing, newData, closeAddModal) {
  const container = document.getElementById('pageContainer');
  if (!container) return;
  const existingEl = document.getElementById('wordModal');
  if (existingEl) existingEl.remove();

  const info = (label, v) => {
    const val = v || '';
    return val ? `<div style="padding:4px 0;font-size:13px"><span style="color:var(--text-tertiary);margin-right:6px">${label}</span>${escapeHtml(val)}</div>` : '';
  };

  const html = `
    <div class="modal-overlay open" id="mergeModal">
      <div class="modal" style="max-width:560px">
        <div class="modal-header">
          <div class="modal-title">${icon('info')} 單字已存在</div>
          <button class="modal-close" id="mergeClose">${icon('x')}</button>
        </div>
        <div style="padding:var(--s3)">
          <div style="margin-bottom:var(--s3);font-size:13px;color:var(--text-secondary)">
            「${escapeHtml(newData.word)}」已經在字庫中，要保留哪一個？
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s2)">
            <div style="background:var(--bg-secondary);border-radius:var(--r1);padding:var(--s2)">
              <div style="font-weight:600;margin-bottom:6px;color:var(--text-primary)">現有的</div>
              ${info('定義', existing.definition)}
              ${info('詞性', existing.pos)}
              ${info('發音', existing.pron)}
              ${info('例句', existing.example)}
              ${info('字本', existing.deck)}
              ${existing.tags?.length ? `<div style="padding:4px 0;font-size:13px"><span style="color:var(--text-tertiary);margin-right:6px">標籤</span>${escapeHtml(existing.tags.join(', '))}</div>` : ''}
            </div>
            <div style="background:var(--bg-secondary);border-radius:var(--r1);padding:var(--s2)">
              <div style="font-weight:600;margin-bottom:6px;color:var(--text-primary)">新的</div>
              ${info('定義', newData.definition)}
              ${info('詞性', newData.pos)}
              ${info('發音', newData.pron)}
              ${info('例句', newData.example)}
              ${info('字本', newData.deck)}
              ${newData.tags?.length ? `<div style="padding:4px 0;font-size:13px"><span style="color:var(--text-tertiary);margin-right:6px">標籤</span>${escapeHtml(newData.tags.join(', '))}</div>` : ''}
            </div>
          </div>
        </div>
        <div class="modal-footer" style="justify-content:flex-end;gap:var(--s2)">
          <button class="btn" id="mergeCancel">取消</button>
          <button class="btn" id="mergeKeepOld" style="background:var(--bg-secondary);color:var(--text-primary)">保留舊的</button>
          <button class="btn-primary" id="mergeKeepNew">保留新的</button>
        </div>
      </div>
    </div>
  `;
  container.insertAdjacentHTML('beforeend', html);

  const closeMerge = () => document.getElementById('mergeModal')?.remove();
  document.getElementById('mergeClose')?.addEventListener('click', closeMerge);
  document.getElementById('mergeCancel')?.addEventListener('click', closeMerge);
  document.getElementById('mergeModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'mergeModal') closeMerge();
  });

  document.getElementById('mergeKeepOld')?.addEventListener('click', () => {
    closeMerge();
    toast(`保留原有「${newData.word}」`, '');
    closeAddModal();
    renderInPlace(s);
  });

  document.getElementById('mergeKeepNew')?.addEventListener('click', async () => {
    await s.actions.editWord(existing.id, newData);
    closeMerge();
    closeAddModal();
    toast(`已更新「${newData.word}」`, 'toast-success');
    renderInPlace(s);
  });
}
