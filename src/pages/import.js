import { icon } from '../lib/svg.js';
import { toast } from '../lib/toast.js';
import { scrapeQuizlet, inspectApkgDialog, getApkgMedia } from '../lib/api.js';
import { isMobile } from '../lib/platform.js';
import {
  parseCSVTable, parseAnkiTSV, mapWords, hasHeaderRow,
  resolveField, CANONICAL_FIELDS, FIELD_LABELS,
} from '../core/import.js';

let _importMode = 'csv';
// CSV/TSV state
let _fileName = '';
let _table = null;
let _fields = [];
let _targetDeck = 'Default';
let _forceDeck = false;
// Quizlet state
let _quizletUrl = '';
let _quizletCards = null;
// Anki .apkg state（每來源欄獨立開關：_colEnabled 全 true 預設；
// 有效 mapping = 開關 AND 下拉，見 effectiveApkgFields）
let _colEnabled = [];
let _importImages = true;
let _apkgInfo = null;
let _cellImages = [];
// Shared state
let _phase = 'idle';
let _progress = { done: 0, total: 0, added: 0, skipped: 0 };
let _result = null;

const PREVIEW_ROWS = 5;

export function renderContent(s) {
  if (_phase === 'importing') return renderProgress(s);
  if (_phase === 'done') return renderDone(s);
  return `
    ${renderTabs()}
    ${_importMode === 'csv' ? renderCsvSection(s) : _importMode === 'apkg' ? renderApkgSection(s) : renderQuizletSection(s)}
  `;
}

export function render(s) {
  if (_phase === 'importing') return renderProgress(s);
  if (_phase === 'done') return renderDone(s);
  return `
    <div class="page-title">${icon('upload')} 匯入</div>
    <div class="page-subtitle">從 CSV/TSV、Anki .apkg 或 Quizlet URL 匯入單字</div>
    ${renderContent(s)}
  `;
}

function renderTabs() {
  return `
    <div class="sub-tabs" id="importTabs">
      <button class="sub-tab ${_importMode === 'csv' ? 'active' : ''}" data-mode="csv">${icon('file')} CSV / TSV</button>
      <button class="sub-tab ${_importMode === 'apkg' ? 'active' : ''}" data-mode="apkg">${icon('layers')} Anki .apkg</button>
      <button class="sub-tab ${_importMode === 'quizlet' ? 'active' : ''}" data-mode="quizlet">${icon('globe')} Quizlet URL</button>
    </div>
  `;
}

function renderCsvSection(s) {
  return `
    <div class="section">
      <div class="section-title">${icon('upload')} 選擇檔案</div>
      <div class="config-section">
        ${renderDropZone()}
      </div>
    </div>
    ${_table ? renderMapping(s) + renderPreview(s, true) + renderImportBar(s) : ''}
  `;
}

function renderDropZone() {
  return `
    <div class="drop-zone" id="dropZone">
      <div class="drop-zone-inner">
        <div class="drop-zone-ic">${icon('upload')}</div>
        <div class="drop-zone-title">${_fileName ? escapeHtml(_fileName) : '拖曳 CSV/TSV 檔案到此'}</div>
        <div class="drop-zone-sub">${_table ? `${_table.rows.length} 列 · ${_table.headers.length} 欄` : '或點擊選擇檔案 (.csv / .tsv / .txt)'}</div>
      </div>
      <input type="file" id="csvFile" accept="text/csv,.csv,.tsv,.txt" hidden>
    </div>
    <div style="display:flex;gap:var(--s2);margin-top:var(--s3);justify-content:center;flex-wrap:wrap">
      <button class="btn" id="csvPickBtn">${icon('folder')} 選擇檔案</button>
      ${_table ? `<button class="btn" id="csvClearBtn">${icon('x')} 清除</button>` : ''}
    </div>
  `;
}

function renderMapping(s) {
  const { headers } = _table;
  const skipLabel = '- 略過 -';
  const optionList = ['', ...CANONICAL_FIELDS];
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('columns')} 欄位對應</div>
        <span class="muted" style="font-size:12px">自動偵測，可手動調整</span>
      </div>
      <div class="config-section">
        <div class="map-table">
          <div class="map-row map-head">
            <span>CSV 欄位</span>
            <span>預覽</span>
            <span>對應到</span>
            <span></span>
          </div>
          ${headers.map((h, i) => {
            const field = _fields[i] || '';
            const preview = String(_table.rows[0]?.[i] ?? '').trim().slice(0, 28);
            const resolved = resolveField(h);
            const opts = optionList.map(f => {
              const label = f ? (FIELD_LABELS[f] + ' · ' + f) : skipLabel;
              return `<option value="${f}" ${field === f ? 'selected' : ''}>${label}</option>`;
            }).join('');
            return `
              <div class="map-row">
                <span class="map-hdr" title="${escapeAttr(h)}">${escapeHtml(h)}</span>
                <span class="map-prev" title="${escapeAttr(preview)}">${escapeHtml(preview) || '<span class="muted">-</span>'}</span>
                <select class="map-sel" data-col="${i}">${opts}</select>
                ${resolved ? `<span class="tag tag-accent" style="font-size:10px">建議</span>` : '<span></span>'}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderImportBar(s) {
  const decks = s.state.decks;
  const deckNames = decks.map(d => d.name);
  const allDecks = Array.from(new Set(['Default', ...deckNames, _targetDeck].filter(Boolean)));
  const mapped = computeMappedCsv(s);
  const newCount = mapped.length;
  return `
    <div class="section">
      <div class="section-title">${icon('book')} 匯入設定</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">目標字本</div>
            <div class="config-field-hint">CSV 無字本欄位時使用此字本</div>
          </div>
          <input type="text" id="targetDeck" list="deckList" value="${escapeAttr(_targetDeck)}" placeholder="Default" style="width:160px">
          <datalist id="deckList">
            ${allDecks.map(d => `<option value="${escapeAttr(d)}">`).join('')}
          </datalist>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">強制匯入至此字本</div>
            <div class="config-field-hint">勾選後忽略 CSV 中的字本欄位</div>
          </div>
          <label style="display:flex;align-items:center;gap:var(--s2);cursor:pointer">
            <input type="checkbox" id="forceDeck" ${_forceDeck ? 'checked' : ''}>
            <span style="font-size:13px">啟用</span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--s4);flex-wrap:wrap;gap:var(--s3)">
          <div style="font-size:13px;color:var(--text-secondary)">
            將匯入 <span class="tnum" style="color:var(--green);font-weight:700">${newCount}</span> 詞
            ${_table.rows.length - newCount > 0 ? `· 跳過 <span class="tnum">${_table.rows.length - newCount}</span> 重複` : ''}
          </div>
          <button class="btn-primary" id="importRunBtn" ${newCount === 0 || _phase === 'importing' ? 'disabled' : ''}>
            ${icon('check')} 開始匯入
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPreview(s, isCsv) {
  const isApkg = isCsv === 'apkg';
  const mapped = isApkg ? computeMappedApkg(s) : isCsv ? computeMappedCsv(s) : computeMappedQuizlet(s);
  const shown = mapped.slice(0, PREVIEW_ROWS);
  const effFields = isApkg ? effectiveApkgFields() : (_fields || []);
  const mappedFields = [...new Set(effFields.filter(Boolean))];
  const mappedChips = mappedFields.map(f => `<span class="tag" style="font-size:10px">${escapeHtml(FIELD_LABELS[f] || f)}</span>`).join('');
  if (shown.length === 0) {
    return `<div class="section"><div class="section-title">${icon('eye')} 預覽</div>
      <div class="empty-state" style="padding:var(--s6)">${icon('box')}<h3>沒有可匯入的單字</h3><p>調整欄位對應或選擇其他檔案</p></div></div>`;
  }
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('eye')} 預覽</div>
        <span class="muted" style="font-size:12px">前 ${shown.length} 筆</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:0 var(--s4) var(--s2);font-size:11px;color:var(--text-tertiary)">
        <span>本次對應：</span>${mappedChips || '<span class="muted">無</span>'}
      </div>
      <div class="config-section" style="padding:0;overflow:hidden">
        <div class="preview-table">
          <div class="preview-row preview-head">
            <span>#</span><span>單字</span><span>定義</span><span>詞性</span>
          </div>
          ${shown.map((w, i) => `
            <div class="preview-row">
              <span class="tnum muted">${i + 1}</span>
              <span class="preview-word">${escapeHtml(w.word)}</span>
              <span class="preview-def">${escapeHtml(w.definition) || '<span class="muted">-</span>'}</span>
              <span>${escapeHtml(w.pos) || '<span class="muted">-</span>'}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// ─── Anki .apkg ─────────────────────────────────────────
// 後端 inspect 回 {headers, rows, media_files, cell_images, skipped_*}
// _table 沿用既有形狀 {headers, rows}，_fields 自動偵測，_colEnabled 逐欄開關。
function renderApkgSection(s) {
  return `
    <div class="section">
      <div class="section-title">${icon('layers')} 選擇牌組檔</div>
      <div class="config-section">
        <div class="drop-zone" id="apkgDropZone">
          <div class="drop-zone-inner">
            <div class="drop-zone-ic">${icon('layers')}</div>
            <div class="drop-zone-title">${_fileName ? escapeHtml(_fileName) : '點擊選擇 .apkg 檔案'}</div>
            <div class="drop-zone-sub">${_table ? `${_table.rows.length} 列 · ${_table.headers.length} 欄` : 'Anki 匯出的牌組檔（.apkg）'}</div>
          </div>
        </div>
        <div style="display:flex;gap:var(--s2);margin-top:var(--s3);justify-content:center;flex-wrap:wrap">
          <button class="btn" id="apkgPickBtn">${icon('folder')} 選擇檔案</button>
          ${_table ? `<button class="btn" id="apkgClearBtn">${icon('x')} 清除</button>` : ''}
        </div>
        ${_apkgInfo ? `
        <div style="margin-top:var(--s2);font-size:12px;color:var(--text-tertiary);text-align:center">
          無卡片 ${ _apkgInfo.skipped_no_cards} 筆略過 · 首欄空白 ${_apkgInfo.skipped_empty} 筆
        </div>` : ''}
      </div>
    </div>
    ${_table ? renderApkgMapping(s) + renderPreview(s, 'apkg') + renderApkgImportBar(s) : ''}
  `;
}

// 某欄含圖張數（_cellImages 按 col 彙總，去重）。
function apkgColImageCount(colIdx) {
  const seen = new Set();
  for (const c of (_cellImages || [])) {
    if (c.col === colIdx) for (const f of (c.files || [])) seen.add(f);
  }
  return seen.size;
}

function renderApkgMapping(s) {
  const { headers } = _table;
  const skipLabel = '- 略過 -';
  const optionList = ['', ...CANONICAL_FIELDS];
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('columns')} 欄位對應</div>
        <span class="muted" style="font-size:12px">每欄開關決定要不要進 · 自動偵測，可手動調整</span>
      </div>
      <div class="config-section">
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s3)">
          <button class="btn btn-sm" id="apkgSelectAll">全選</button>
          <button class="btn btn-sm" id="apkgSelectNone">全不選</button>
        </div>
        <div class="map-table">
          <div class="map-row map-head">
            <span></span>
            <span>Anki 欄位</span>
            <span>預覽</span>
            <span>對應到</span>
            <span></span>
          </div>
          ${headers.map((h, i) => {
            const enabled = _colEnabled[i] !== false;
            const field = _fields[i] || '';
            const preview = String(_table.rows[0]?.[i] ?? '').trim().slice(0, 28);
            const resolved = h === '_deck' || h === '_tags' ? h : resolveField(h);
            const imgCount = apkgColImageCount(i);
            const opts = optionList.map(f => {
              const label = f ? (FIELD_LABELS[f] + ' · ' + f) : skipLabel;
              return `<option value="${f}" ${field === f ? 'selected' : ''}>${label}</option>`;
            }).join('');
            return `
              <div class="map-row">
                <span><input type="checkbox" class="apkg-col-toggle" data-col="${i}" ${enabled ? 'checked' : ''} title="此欄要不要匯入"></span>
                <span class="map-hdr" title="${escapeAttr(h)}">${escapeHtml(h)}${imgCount ? ` <span class="tag" style="font-size:10px" title="此欄附帶圖片，關掉即連圖一起丟">含圖 ${imgCount}</span>` : ''}</span>
                <span class="map-prev" title="${escapeAttr(preview)}">${escapeHtml(preview) || '<span class="muted">-</span>'}</span>
                <select class="map-sel apkg-map-sel" data-col="${i}" ${enabled ? '' : 'disabled'}>${opts}</select>
                ${resolved ? `<span class="tag tag-accent" style="font-size:10px">建議</span>` : '<span></span>'}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderApkgImportBar(s) {
  const decks = s.state.decks;
  const deckNames = decks.map(d => d.name);
  const allDecks = Array.from(new Set(['Default', ...deckNames, _targetDeck].filter(Boolean)));
  const mapped = computeMappedApkg(s);
  const newCount = mapped.length;
  const effCount = effectiveApkgFields().filter(Boolean).length;
  return `
    <div class="section">
      <div class="section-title">${icon('book')} 匯入設定</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">目標字本</div>
            <div class="config-field-hint">無字本欄位時使用此字本</div>
          </div>
          <input type="text" id="targetDeck" list="deckList" value="${escapeAttr(_targetDeck)}" placeholder="Default" style="width:160px">
          <datalist id="deckList">
            ${allDecks.map(d => `<option value="${escapeAttr(d)}">`).join('')}
          </datalist>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">強制匯入至此字本</div>
            <div class="config-field-hint">勾選後忽略牌組中的字本欄位</div>
          </div>
          <label style="display:flex;align-items:center;gap:var(--s2);cursor:pointer">
            <input type="checkbox" id="forceDeck" ${_forceDeck ? 'checked' : ''}>
            <span style="font-size:13px">啟用</span>
          </label>
        </div>
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">圖片一起匯入</div>
            <div class="config-field-hint">關掉則只進文字，圖一張都不抓</div>
          </div>
          <label style="display:flex;align-items:center;gap:var(--s2);cursor:pointer">
            <input type="checkbox" id="apkgImportImages" ${_importImages ? 'checked' : ''}>
            <span style="font-size:13px">啟用</span>
          </label>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--s4);flex-wrap:wrap;gap:var(--s3)">
          <div style="font-size:13px;color:var(--text-secondary)">
            將匯入 <span class="tnum" style="color:var(--green);font-weight:700">${newCount}</span> 詞 · ${effCount} 欄
            ${_table.rows.length - newCount > 0 ? `· 跳過 <span class="tnum">${_table.rows.length - newCount}</span> 重複` : ''}
          </div>
          <button class="btn-primary" id="importRunBtn" ${newCount === 0 || _phase === 'importing' ? 'disabled' : ''}>
            ${icon('check')} 開始匯入
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderQuizletSection(s) {
  return `
    <div class="section">
      <div class="section-title">${icon('globe')} Quizlet 網址</div>
      <div class="config-section">
        <div class="config-field" style="${isMobile ? 'flex-direction:column;align-items:stretch' : ''}">
          <div class="config-field-info">
            <div class="config-field-label">Quizlet 單字集網址</div>
            <div class="config-field-hint">輸入公開 Quizlet 單字集網址，例如 https://quizlet.com/123456/...</div>
          </div>
          <input type="url" class="form-input" id="quizletUrlInput" value="${escapeAttr(_quizletUrl)}" placeholder="https://quizlet.com/..." style="${isMobile ? 'margin-top:var(--s2)' : ''}">
        </div>
        <div style="display:flex;gap:var(--s2);margin-top:var(--s3);flex-wrap:wrap">
          <button class="btn-primary" id="quizletFetchBtn">${icon('globe')} 取得單字</button>
          ${_quizletCards ? `<button class="btn" id="quizletClearBtn">${icon('x')} 清除</button>` : ''}
        </div>
        ${_quizletCards ? `
          <div style="margin-top:var(--s4);font-size:13px;color:var(--text-secondary)">
            找到 <span class="tnum" style="color:var(--green);font-weight:700">${_quizletCards.length}</span> 個單字
          </div>
        ` : ''}
      </div>
    </div>
    ${_quizletCards ? renderQuizletPreview(s) + renderQuizletImportBar(s) : ''}
  `;
}

function renderQuizletPreview(s) {
  const mapped = computeMappedQuizlet(s);
  const shown = mapped.slice(0, PREVIEW_ROWS);
  if (shown.length === 0) {
    return `<div class="section"><div class="section-title">${icon('eye')} 預覽</div>
      <div class="empty-state" style="padding:var(--s6)">${icon('box')}<h3>沒有可匯入的單字</h3></div></div>`;
  }
  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('eye')} 預覽</div>
        <span class="muted" style="font-size:12px">前 ${shown.length} 筆</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;padding:0 var(--s4) var(--s2);font-size:11px;color:var(--text-tertiary)">
        <span>本次對應：</span><span class="tag" style="font-size:10px">單字</span><span class="tag" style="font-size:10px">定義</span>
        <span>（Quizlet 僅提供這兩欄，其餘欄位可用工具頁自動補齊補上）</span>
      </div>
      <div class="config-section" style="padding:0;overflow:hidden">
        <div class="preview-table">
          <div class="preview-row preview-head">
            <span>#</span><span>Term</span><span>Definition</span>
          </div>
          ${shown.map((w, i) => `
            <div class="preview-row">
              <span class="tnum muted">${i + 1}</span>
              <span class="preview-word">${escapeHtml(w.word)}</span>
              <span class="preview-def">${escapeHtml(w.definition) || '<span class="muted">-</span>'}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderQuizletImportBar(s) {
  const mapped = computeMappedQuizlet(s);
  const newCount = mapped.length;
  const decks = s.state.decks;
  const deckNames = decks.map(d => d.name);
  const allDecks = Array.from(new Set(['Default', ...deckNames, _targetDeck].filter(Boolean)));
  return `
    <div class="section">
      <div class="section-title">${icon('book')} 匯入設定</div>
      <div class="config-section">
        <div class="config-field">
          <div class="config-field-info">
            <div class="config-field-label">目標字本</div>
            <div class="config-field-hint">匯入至此字本</div>
          </div>
          <input type="text" id="quizletTargetDeck" list="quizletDeckList" value="${escapeAttr(_targetDeck)}" placeholder="Default" style="width:160px">
          <datalist id="quizletDeckList">
            ${allDecks.map(d => `<option value="${escapeAttr(d)}">`).join('')}
          </datalist>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--s4);flex-wrap:wrap;gap:var(--s3)">
          <div style="font-size:13px;color:var(--text-secondary)">
            將匯入 <span class="tnum" style="color:var(--green);font-weight:700">${newCount}</span> 詞
          </div>
          <button class="btn-primary" id="quizletImportRunBtn" ${newCount === 0 || _phase === 'importing' ? 'disabled' : ''}>
            ${icon('check')} 開始匯入
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderProgress(s) {
  const { done, total, added, skipped } = _progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `
    <div class="page-title">${icon('upload')} 匯入中</div>
    <div class="page-subtitle">${_importMode === 'quizlet' ? 'Quizlet: ' + escapeHtml(_quizletUrl) : escapeHtml(_fileName)}</div>
    <div class="section">
      <div class="config-section" style="text-align:center;padding:var(--s10)">
        <div class="hero-pct" style="font-size:48px;font-weight:800;color:var(--accent);font-feature-settings:'tnum';line-height:1">${pct}<span style="font-size:20px">%</span></div>
        <div style="font-size:13px;color:var(--text-tertiary);margin:var(--s2) 0 var(--s5)" id="importProgressText">已處理 ${done} / ${total} · 新增 ${added} · 跳過 ${skipped}</div>
        <div class="hero-bar"><div class="hero-bar-fill" id="importProgressBar" style="width:${pct}%"></div></div>
      </div>
    </div>
  `;
}

function renderDone(s) {
  const r = _result || { added: 0, skipped: 0, decksCreated: [] };
  return `
    <div class="page-title">${icon('check')} 匯入完成</div>
    <div class="page-subtitle">${_importMode === 'quizlet' ? 'Quizlet: ' + escapeHtml(_quizletUrl) : escapeHtml(_fileName)}</div>
    <div class="hero" style="text-align:center">
      <div class="hero-glow"></div>
      <div class="hero-content">
        <div class="hero-pct done" style="font-size:64px">${r.added}<span class="unit"> 詞</span></div>
        <div class="hero-label" style="margin-top:var(--s2)">成功匯入</div>
        <div style="display:flex;justify-content:center;gap:var(--s8);margin-top:var(--s6)">
          <div><div style="font-size:26px;font-weight:800;color:var(--green)">${r.added}</div><div class="hero-stat-lbl">新增</div></div>
          <div><div style="font-size:26px;font-weight:800;color:var(--text-tertiary)">${r.skipped}</div><div class="hero-stat-lbl">重複跳過</div></div>
          <div><div style="font-size:26px;font-weight:800;color:var(--accent)">${r.decksCreated.length}</div><div class="hero-stat-lbl">新字本</div></div>
        </div>
      </div>
    </div>
    ${r.decksCreated.length > 0 ? `
      <div class="section">
        <div class="section-title">${icon('book')} 自動建立字本</div>
        <div class="config-section" style="display:flex;gap:var(--s2);flex-wrap:wrap">
          ${r.decksCreated.map(d => `<span class="tag tag-accent">${escapeHtml(d)}</span>`).join('')}
        </div>
      </div>
    ` : ''}
    <div style="display:flex;gap:var(--s3);justify-content:center;flex-wrap:wrap">
      <button class="btn-primary" id="importGoReview">${icon('book')} 開始學習</button>
      <button class="btn" id="importGoBrowser">${icon('list')} 查看字庫</button>
      <button class="btn" id="importAgain">${icon('upload')} 再匯入一個</button>
    </div>
  `;
}

// ─── Anki .apkg 映射 ────────────────────────────────────
// 有效 mapping = _colEnabled[i] AND _fields[i]；任一關即不注入。
// computeMappedCsv 不動（純 _fields 版），apkg 走自己的 computeMappedApkg。
function effectiveApkgFields() {
  if (!_table) return [];
  return _table.headers.map((h, i) => (_colEnabled[i] !== false ? (_fields[i] || null) : null));
}

function computeMappedApkg(s) {
  return mapApkgWithRows(s).map(x => x.w);
}

// 逐列映射並保留原始列號（圖片階段靠 rowIdx 對回 _cellImages）。
// 去重語意與 importWords 對齊：DB 已有略過，檔內重複只留首見。
function mapApkgWithRows(s) {
  if (!_table) return [];
  const eff = effectiveApkgFields();
  const existing = new Set(s.state.words.map(w => w.word.toLowerCase()));
  const out = [];
  _table.rows.forEach((row, ri) => {
    const arr = mapWords(_table.headers, [row], eff, { deck: _targetDeck || 'Default' });
    if (!arr.length) return;
    const w = arr[0];
    if (_forceDeck) w.deck = _targetDeck || 'Default';
    const key = w.word.toLowerCase();
    if (existing.has(key)) return;
    existing.add(key);
    out.push({ w, rowIdx: ri });
  });
  return out;
}

function computeMappedCsv(s) {
  if (!_table) return [];
  const mapped = mapWords(_table.headers, _table.rows, _fields, { deck: _targetDeck || 'Default' });
  if (_forceDeck) mapped.forEach(w => { w.deck = _targetDeck || 'Default'; });
  const existing = new Set(s.state.words.map(w => w.word.toLowerCase()));
  return mapped.filter(w => !existing.has(w.word.toLowerCase()));
}

function computeMappedQuizlet(s) {
  if (!_quizletCards) return [];
  const mapped = _quizletCards.map(c => ({
    word: (c.term || c.word || '').toLowerCase(),
    definition: c.definition || '',
    pos: '', pron: '', example: '',
    synonym: '', antonym: '', derivative: '',
    etymology: '', syllables: '', phrases: '',
    related: [], forms: [],
    deck: _targetDeck || 'Default',
    image: '', description: '', examples: [], tags: [],
  }));
  const existing = new Set(s.state.words.map(w => w.word.toLowerCase()));
  return mapped.filter(w => !existing.has(w.word.toLowerCase()));
}

export function onMount(s, renderFn) {
  if (renderFn) _renderInPlace = renderFn;
  // Tab switching
  document.querySelectorAll('#importTabs .sub-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _importMode = btn.dataset.mode;
      resetState();
      _renderInPlace(s);
    });
  });

  if (_importMode === 'csv') mountCsv(s);
  else if (_importMode === 'apkg') mountApkg(s);
  else mountQuizlet(s);

  // Done navigation
  const goReview = document.getElementById('importGoReview');
  if (goReview) goReview.addEventListener('click', () => s.actions.navigate('study-v4'));
  const goBrowser = document.getElementById('importGoBrowser');
  if (goBrowser) goBrowser.addEventListener('click', () => s.actions.navigate('browser'));
  const again = document.getElementById('importAgain');
  if (again) again.addEventListener('click', () => { resetState(); _renderInPlace(s); });
}

function mountCsv(s) {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('csvFile');
  const pickBtn = document.getElementById('csvPickBtn');
  const clearBtn = document.getElementById('csvClearBtn');

  if (dropZone) {
    dropZone.addEventListener('click', () => fileInput?.click());
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag');
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(s, f);
    });
  }
  if (pickBtn) pickBtn.addEventListener('click', () => fileInput?.click());
  if (fileInput) fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(s, f);
  });
  if (clearBtn) clearBtn.addEventListener('click', () => { resetState(); _renderInPlace(s); });

  document.querySelectorAll('.map-sel[data-col]').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = parseInt(sel.dataset.col, 10);
      _fields[i] = sel.value || null;
      _renderInPlace(s);
    });
  });

  const targetDeckInput = document.getElementById('targetDeck');
  if (targetDeckInput) {
    targetDeckInput.addEventListener('input', () => {
      _targetDeck = targetDeckInput.value.trim() || 'Default';
    });
    targetDeckInput.addEventListener('change', () => {
      _targetDeck = targetDeckInput.value.trim() || 'Default';
      _renderInPlace(s);
    });
  }
  const forceDeckInput = document.getElementById('forceDeck');
  if (forceDeckInput) {
    forceDeckInput.addEventListener('change', () => {
      _forceDeck = forceDeckInput.checked;
      _renderInPlace(s);
    });
  }

  const runBtn = document.getElementById('importRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => runCsvImport(s));
}

function mountApkg(s) {
  const pickBtn = document.getElementById('apkgPickBtn');
  if (pickBtn) pickBtn.addEventListener('click', () => pickApkg(s));
  const clearBtn = document.getElementById('apkgClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => { resetState(); _renderInPlace(s); });

  const allBtn = document.getElementById('apkgSelectAll');
  if (allBtn) allBtn.addEventListener('click', () => {
    _colEnabled = (_table?.headers || []).map(() => true);
    _renderInPlace(s);
  });
  const noneBtn = document.getElementById('apkgSelectNone');
  if (noneBtn) noneBtn.addEventListener('click', () => {
    _colEnabled = (_table?.headers || []).map(() => false);
    _renderInPlace(s);
  });

  document.querySelectorAll('.apkg-col-toggle[data-col]').forEach(box => {
    box.addEventListener('change', () => {
      const i = parseInt(box.dataset.col, 10);
      _colEnabled[i] = box.checked;
      _renderInPlace(s);
    });
  });
  document.querySelectorAll('.apkg-map-sel[data-col]').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = parseInt(sel.dataset.col, 10);
      _fields[i] = sel.value || null;
      _renderInPlace(s);
    });
  });

  const targetDeckInput = document.getElementById('targetDeck');
  if (targetDeckInput) {
    targetDeckInput.addEventListener('input', () => {
      _targetDeck = targetDeckInput.value.trim() || 'Default';
    });
    targetDeckInput.addEventListener('change', () => {
      _targetDeck = targetDeckInput.value.trim() || 'Default';
      _renderInPlace(s);
    });
  }
  const forceDeckInput = document.getElementById('forceDeck');
  if (forceDeckInput) {
    forceDeckInput.addEventListener('change', () => {
      _forceDeck = forceDeckInput.checked;
      _renderInPlace(s);
    });
  }
  const imgToggle = document.getElementById('apkgImportImages');
  if (imgToggle) {
    imgToggle.addEventListener('change', () => {
      _importImages = imgToggle.checked;
      _renderInPlace(s);
    });
  }

  const runBtn = document.getElementById('importRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => runApkgImport(s));
}

function mountQuizlet(s) {
  const urlInput = document.getElementById('quizletUrlInput');
  const fetchBtn = document.getElementById('quizletFetchBtn');
  const clearBtn = document.getElementById('quizletClearBtn');

  if (urlInput) {
    urlInput.addEventListener('input', () => { _quizletUrl = urlInput.value.trim(); });
  }
  if (fetchBtn) fetchBtn.addEventListener('click', () => fetchQuizlet(s));
  if (clearBtn) clearBtn.addEventListener('click', () => { _quizletCards = null; _renderInPlace(s); });

  const targetDeckInput = document.getElementById('quizletTargetDeck');
  if (targetDeckInput) {
    targetDeckInput.addEventListener('input', () => {
      _targetDeck = targetDeckInput.value.trim() || 'Default';
    });
    targetDeckInput.addEventListener('change', () => {
      _targetDeck = targetDeckInput.value.trim() || 'Default';
      _renderInPlace(s);
    });
  }

  const runBtn = document.getElementById('quizletImportRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => runQuizletImport(s));
}

async function handleFile(s, file) {
  _fileName = file.name;
  try {
    const text = await file.text();
    const isTsv = file.name.endsWith('.tsv') || text.includes('\t');
    if (isTsv) {
      const rows = parseAnkiTSV(text);
      if (rows.length === 0) {
        toast('TSV 為空或格式錯誤', 'toast-error');
        _fileName = '';
        _table = null;
        _renderInPlace(s);
        return;
      }
      // D-TSV1: 無標頭偵測 — 首列無一格能 resolve 即為資料列，不可吃掉；
      // 無標頭時 headers 取位置回退標籤，全部列入 rows。
      const headered = hasHeaderRow(rows[0]);
      const dataRows = (headered ? rows.slice(1) : rows)
        .filter(r => r.some(c => String(c).trim() !== ''));
      if (dataRows.length === 0) {
        toast(headered ? 'TSV 為空或格式錯誤' : 'TSV 只有標頭、無資料列', 'toast-error');
        _fileName = headered ? '' : file.name;
        _table = null;
        _renderInPlace(s);
        return;
      }
      _table = {
        headers: headered ? rows[0] : rows[0].map((_, i) => `欄${i + 1}`),
        rows: dataRows,
      };
      // D12：Anki TSV 標準標頭（Front/Back/Notes 等）不在 FIELD_MAP → resolveField 全 null，
      // 列整欄靜默丟失。用位置式回退（mapAnkiRows 語意）：col0→word、col1→definition、col2→description。
      _fields = _table.headers.map((h, i) => {
        const f = resolveField(h);
        if (f) return f;
        if (/^fro?nt$/i.test(h)) return 'word';
        if (/^back$/i.test(h)) return 'definition';
        if (/note/i.test(h)) return 'description';
        // 未識別標頭依位置回退（Anki 慣例）— 第一個欄當 word，其次 definition
        return i === 0 ? 'word' : i === 1 ? 'definition' : i === 2 ? 'description' : null;
      });
    } else {
      const table = parseCSVTable(text);
      if (table.headers.length === 0 || table.rows.length === 0) {
        toast('CSV 為空或格式錯誤', 'toast-error');
        _fileName = '';
        _table = null;
        _renderInPlace(s);
        return;
      }
      // D-CSV1（D-TSV1 同族）: 無標頭偵測 — 首列無一格能 resolve 即為
      // 資料列；headers 取位置回退標籤，首列併回 rows。有標頭時維持
      // 原語意（resolveField only），不擴大位置回退。
      if (!hasHeaderRow(table.headers)) {
        table = { headers: table.headers.map((_, i) => `欄${i + 1}`), rows: [table.headers, ...table.rows] };
        _table = table;
        _fields = _table.headers.map((h, i) => (i === 0 ? 'word' : i === 1 ? 'definition' : i === 2 ? 'description' : null));
      } else {
        _table = table;
        _fields = _table.headers.map(h => resolveField(h));
      }
    }
    _phase = 'ready';
    toast(`已載入 ${_table.rows.length} 列、${_table.headers.length} 欄`, '');
    _renderInPlace(s);
  } catch (e) {
    console.error('[import] handleFile error:', e);
    toast('讀取檔案失敗: ' + e.message, 'toast-error');
    _fileName = '';
    _table = null;
    _renderInPlace(s);
  }
}

async function fetchQuizlet(s) {
  const url = _quizletUrl;
  if (!url) { toast('請輸入 Quizlet 網址', 'toast-error'); return; }
  try {
    const cards = await scrapeQuizlet(url);
    _quizletCards = typeof cards === 'string' ? JSON.parse(cards) : cards;
    toast(`找到 ${_quizletCards.length} 個單字`, '');
    _renderInPlace(s);
  } catch (e) {
    console.error('[import] fetchQuizlet error:', e);
    toast('取得 Quizlet 單字失敗: ' + e, 'toast-error');
  }
}

async function runCsvImport(s) {
  // G28：重入保護 — 雙擊/重複觸發不得產生重複匯入
  if (_phase === 'importing') { toast('匯入進行中…'); return; }
  const mapped = computeMappedCsv(s);
  if (mapped.length === 0) { toast('沒有可匯入的單字', 'toast-error'); return; }
  const toImport = _forceDeck
    ? mapped.map(w => ({ ...w, deck: _targetDeck || 'Default' }))
    : mapped;
  _phase = 'importing';
  _progress = { done: 0, total: toImport.length, added: 0, skipped: 0 };
  _renderInPlace(s);
  await doImport(s, toImport);
}

async function runQuizletImport(s) {
  // G28：重入保護 — 雙擊/重複觸發不得產生重複匯入
  if (_phase === 'importing') { toast('匯入進行中…'); return; }
  const mapped = computeMappedQuizlet(s);
  if (mapped.length === 0) { toast('沒有可匯入的單字', 'toast-error'); return; }
  _phase = 'importing';
  _progress = { done: 0, total: mapped.length, added: 0, skipped: 0 };
  _renderInPlace(s);
  await doImport(s, mapped);
}

// ─── Anki .apkg 執行 ────────────────────────────────────
async function pickApkg(s) {
  if (_phase === 'importing') { toast('匯入進行中…'); return; }
  try {
    const r = await inspectApkgDialog();
    if (!r || !r.headers || !r.rows || r.rows.length === 0) {
      toast('牌組為空或格式錯誤', 'toast-error');
      return;
    }
    _fileName = '牌組（' + r.rows.length + ' 列）';
    // Anki tags 以空格分隔；mapWords 吃逗號分隔 → 就地轉換（Anki tag 不可含空白，安全）
    const tagsIdx = r.headers.indexOf('_tags');
    if (tagsIdx !== -1) {
      for (const row of r.rows) {
        if (row[tagsIdx]) row[tagsIdx] = String(row[tagsIdx]).split(/\s+/).filter(Boolean).join(',');
      }
    }
    _table = { headers: r.headers, rows: r.rows };
    _fields = r.headers.map(h => h === '_deck' ? 'deck' : h === '_tags' ? 'tags' : resolveField(h));
    _colEnabled = r.headers.map(() => true);
    _cellImages = r.cell_images || [];
    _apkgInfo = { skipped_no_cards: r.skipped_no_cards || 0, skipped_empty: r.skipped_empty || 0 };
    _phase = 'ready';
    toast(`已載入 ${r.rows.length} 列、${r.headers.length} 欄`, '');
    _renderInPlace(s);
  } catch (e) {
    const msg = String(e || '');
    if (/取消/.test(msg)) return; // 使用者取消選檔，不打擾
    console.error('[import] pickApkg error:', e);
    toast('讀取牌組失敗: ' + (e.message || e), 'toast-error');
  }
}

async function runApkgImport(s) {
  // G28：重入保護 — 雙擊/重複觸發不得產生重複匯入
  if (_phase === 'importing') { toast('匯入進行中…'); return; }
  const pairs = mapApkgWithRows(s);
  if (pairs.length === 0) { toast('沒有可匯入的單字', 'toast-error'); return; }
  const toImport = pairs.map(x => x.w);
  // word → 原始列號（首見；圖片階段對回 _cellImages 用。
  // importWords 內還會擋黑灰名單，那些字無 addedId，自然不會走到圖片階段）
  const wordRowIdx = new Map(pairs.map(x => [x.w.word.toLowerCase(), x.rowIdx]));
  _phase = 'importing';
  _progress = { done: 0, total: toImport.length, added: 0, skipped: 0 };
  _renderInPlace(s);
  await doImport(s, toImport, (res) => importApkgImages(s, res, wordRowIdx));
}

// 圖片三層 AND：總開關 AND 該圖所在欄開關 AND 該欄下拉有選。
// 單張失敗記 skipped 不整批掛；總張數超 500 先問。
async function importApkgImages(s, res, wordRowIdx) {
  if (!_importImages) {
    toast('圖片已略過（開關關閉）', '');
    return;
  }
  const eff = effectiveApkgFields();
  const jobs = [];
  let colSkipped = 0;
  for (const id of (res.addedIds || [])) {
    const w = s.state.words.find(x => x.id === id);
    if (!w) continue;
    const ri = wordRowIdx.get((w.word || '').toLowerCase());
    if (ri == null) continue;
    for (const c of (_cellImages || [])) {
      if (c.row !== ri) continue;
      if (!eff[c.col]) { colSkipped += (c.files || []).length; continue; }
      for (const f of (c.files || [])) jobs.push({ wordId: id, file: f });
    }
  }
  if (!jobs.length) return;
  if (jobs.length > 500 && !confirm(`圖片共 ${jobs.length} 張，確定全部匯入嗎？`)) {
    toast(`圖片已略過（${jobs.length} 張未匯入）`, '');
    return;
  }
  const { addWordImage } = await import('../lib/db.js');
  let ok = 0, skipped = 0;
  for (const { wordId, file } of jobs) {
    try {
      const dataUrl = await getApkgMedia(file);
      await addWordImage(wordId, file, dataUrl);
      ok++;
    } catch (e) {
      console.warn('[import] apkg image skip:', file, e);
      skipped++;
    }
  }
  toast(`圖片 ${ok} 張${skipped ? `、跳過 ${skipped} 張` : ''}${colSkipped ? `（關閉欄 ${colSkipped} 張未抓）` : ''}`, ok ? 'toast-success' : '');
}

async function doImport(s, toImport, after) {
  try {
    const res = await s.actions.importWords(toImport, (p) => {
      _progress = p;
      const bar = document.getElementById('importProgressBar');
      if (bar) {
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        bar.style.width = pct + '%';
      }
      const sub = document.getElementById('importProgressText');
      if (sub) sub.textContent = `已處理 ${p.done} / ${p.total} · 新增 ${p.added} · 跳過 ${p.skipped}`;
      const pctEl = document.querySelector('.hero-pct');
      if (pctEl) {
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        pctEl.firstChild.textContent = pct;
      }
    });
    _result = res;
    if (after) {
      try { await after(res); } catch (e) { console.warn('[import] after-hook error:', e); }
    }
    _phase = 'done';
    _renderInPlace(s);
    toast(`成功匯入 ${res.added} 詞`, 'toast-success');
  } catch (e) {
    console.error('[import] doImport error:', e);
    _phase = 'ready';
    toast('匯入失敗: ' + e.message, 'toast-error');
    _renderInPlace(s);
  }
}

function resetState() {
  _fileName = '';
  _table = null;
  _fields = [];
  _quizletUrl = '';
  _quizletCards = null;
  _colEnabled = [];
  _importImages = true;
  _apkgInfo = null;
  _cellImages = [];
  _targetDeck = 'Default';
  _forceDeck = false;
  _phase = 'idle';
  _progress = { done: 0, total: 0, added: 0, skipped: 0 };
  _result = null;
}

let _renderInPlace = (s) => {
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
