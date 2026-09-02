// ═══════════════════════════════════════════════════════════════
// 照片切割掃描獨立頁（CROP-PAGE，2026-09-01 元首令）
//
// 需求：「手動切割模式可以做出單獨的入口嗎 — 點入切割就進入專門切割照片的頁面，
//  OCR 介面的預覽圖就無法進行任何互動」+「用戶手動切割的模式也要剁成幾塊去分析」
//
// 設計：
//   • 拍照/匯入多張（multiple）
//   • 預覽區：連續「拖曳畫框」— 每框一塊（矩形，拖曳即成），框可點選微調四角/刪除
//   • 「掃描全部塊」：每塊 2x 放大 + 小字增強（Otsu）→ 辨識 → token 疊進候選
//     （塊間若有重疊，用 crossTileVote 投票去碎片；無重疊直接 merge）
//   • 候選清單：累積制（跨照片疊加、保留勾選）→ 一次匯入（importOcrText）
// ═══════════════════════════════════════════════════════════════
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_KEYS } from '../lib/ocr/preprocess.js';
import { crossTileVote } from '../lib/ocr/tile-scan.js';

// OCR token 白名單（與 ocr.js 同正則）
const _OCR_TOKEN_RE = /^[a-z][a-z'-]{1,30}$/i;

let _photoFiles = [];       // 待處理照片
let _boxes = [];            // 使用者畫的切割框（原圖座標）[{x,y,w,h}]
let _activeBox = -1;        // 微調中的框 idx
let _busy = false;
let _batchTokens = new Set();
let _curIdx = 0;            // 當前顯示照片
let _img = null;            // 當前照片顯示物件 { bitmap, w, h }
let _dragStart = null;
let _dragMode = null;       // 'draw' | 'move' | 'resize-nw/...' | null
let _dragBox = -1;
let _origBox = null;

export function render(s) {
  const isMobile = /Android|Mobi|iPhone/i.test(navigator.userAgent || '');
  return `
    <div class="page-title">${icon('scan')} 照片切割掃描</div>
    <div class="page-subtitle">拍照或匯入 → 畫框切割（可多塊）→ 每塊放大掃描 → 勾選匯入</div>

    <div style="display:flex;gap:var(--s2);margin-bottom:var(--s3);flex-wrap:wrap">
      <button class="btn" id="cropTakeBtn">${icon('camera')} 拍照</button>
      <button class="btn" id="cropImportBtn">${icon('image')} 匯入照片（可多張）</button>
      <button class="btn" id="cropPrevBtn" style="display:none">${icon('chevronL')} 上一張</button>
      <span id="cropPageInfo" style="font-size:12px;color:var(--text-tertiary);align-self:center;display:none"></span>
      <button class="btn" id="cropNextBtn" style="display:none">${icon('chevronR')} 下一張</button>
    </div>
    <input type="file" id="cropCamInput" accept="image/*" capture="environment" style="display:none">
    <input type="file" id="cropImportInput" accept="image/*" multiple style="display:none">

    <div class="ocr-stage" id="cropStage" style="display:none">
      <div class="ocr-img-wrap" id="cropImgWrap" style="position:relative;touch-action:none">
        <img id="cropImgEl" alt="待切割照片" style="max-width:100%;user-select:none;-webkit-user-drag:none">
        <svg id="cropSvg" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">
          <g id="cropBoxesG"></g>
        </svg>
      </div>
      <div style="display:flex;gap:var(--s2);align-items:center;margin-top:var(--s2);flex-wrap:wrap">
        <button class="btn-primary" id="cropScanBtn" style="flex:1">${icon('check')} 掃描全部塊（${_boxes.length}）</button>
        <button class="btn" id="cropClearBtn">${icon('x')} 清除全部框</button>
        <span class="muted" style="font-size:11px">在圖上拖曳畫框；可畫多個；點框選取後拖邊角微調</span>
      </div>
    </div>

    <div class="ocr-result" id="cropResultArea" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="display:flex;gap:2px;align-items:center" id="cropTabsDots"></div>
        <div style="font-size:12px;color:var(--text-tertiary)" id="cropTabTitle"></div>
      </div>
      <div id="cropSwipeWrap" style="overflow-x:hidden;position:relative">
        <div id="cropSwipeTrack" style="display:flex;transition:transform .18s ease;will-change:transform">
          <div class="ocr-cand-list" id="cropListNew" style="flex:0 0 100%"></div>
          <div class="ocr-cand-list" id="cropListDup" style="flex:0 0 100%"></div>
          <div class="ocr-cand-list" id="cropListNoise" style="flex:0 0 100%"></div>
        </div>
      </div>
      <div class="ocr-cand-row">
        <button class="btn btn-sm" id="cropSelectAllBtn">全選</button>
        <button class="btn btn-sm" id="cropSelectNoneBtn">全不選</button>
        <button class="btn" id="cropDupMoveBtn" style="display:none;flex:0 0 auto">${icon('shuffle')} 批量轉移勾選到字本</button>
        <button class="btn" id="cropConfirmImportBtn" style="flex:1">${icon('check')} 將勾選單字加入字本</button>
      </div>
    </div>
  `;
}

export function onMount(s) {
  const $ = (id) => document.getElementById(id);
  const stage = $('cropStage');
  const wrapEl = $('cropImgWrap');
  const imgEl = $('cropImgEl');
  const svgEl = $('cropSvg');
  const boxesG = $('cropBoxesG');
  const area = $('cropResultArea');

  // ── 照片載入 ──
  async function loadPhoto(idx) {
    if (!_photoFiles.length) return;
    _curIdx = Math.max(0, Math.min(idx, _photoFiles.length - 1));
    const f = _photoFiles[_curIdx];
    const bmp = await createImageBitmap(f);
    _img = { bitmap: bmp, w: bmp.width, h: bmp.height };
    const fr = new FileReader();
    await new Promise((res) => { fr.onload = res; fr.readAsDataURL(f); });
    imgEl.src = fr.result;   // data: URL（WebKitGTK blob: 黑框教訓）
    stage.style.display = 'block';
    _boxes = []; _activeBox = -1; renderBoxes();
    $('cropPrevBtn').style.display = _photoFiles.length > 1 ? '' : 'none';
    $('cropNextBtn').style.display = _photoFiles.length > 1 ? '' : 'none';
    $('cropPageInfo').style.display = _photoFiles.length > 1 ? '' : 'none';
    $('cropPageInfo').textContent = `第 ${_curIdx + 1} / ${_photoFiles.length} 張（每張的框獨立）`;
  }

  // ── 座標換算（顯示 ↔ 原圖）──
  function toOrig(ev) {
    const r = wrapEl.getBoundingClientRect();
    const cx = (ev.touches?.[0] || ev).clientX;
    const cy = (ev.touches?.[0] || ev).clientY;
    const dispW = r.width, dispH = r.height;
    return {
      x: Math.max(0, Math.min(_img.w, (cx - r.left) / dispW * _img.w)),
      y: Math.max(0, Math.min(_img.h, (cy - r.top) / dispH * _img.h)),
    };
  }
  function toDisp(b) {
    const r = wrapEl.getBoundingClientRect();
    return {
      x: b.x / _img.w * r.width, y: b.y / _img.h * r.height,
      w: b.w / _img.w * r.width, h: b.h / _img.h * r.height,
    };
  }

  // ── 框渲染 ──
  function renderBoxes() {
    if (!_img) return;
    const r = wrapEl.getBoundingClientRect();
    let html = '';
    _boxes.forEach((b, i) => {
      const d = toDisp(b);
      const active = i === _activeBox;
      const stroke = active ? 'var(--accent)' : 'rgba(120,180,255,.9)';
      html += `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}"
        fill="rgba(80,140,255,.12)" stroke="${stroke}" stroke-width="${active ? 3 : 2}" rx="4" data-box="${i}"
        style="pointer-events:auto;cursor:move"></rect>`;
      if (active) {
        // 四角 handle
        for (const [hx, hy, cursor] of [[d.x, d.y, 'nwse-resize'], [d.x + d.w, d.y, 'nesw-resize'], [d.x + d.w, d.y + d.h, 'nwse-resize'], [d.x, d.y + d.h, 'nesw-resize']]) {
          html += `<circle cx="${hx}" cy="${hy}" r="8" fill="var(--accent)" stroke="#fff" stroke-width="2" data-handle="${i}" style="pointer-events:auto;cursor:${cursor}"></circle>`;
        }
        html += `<text x="${d.x + d.w / 2}" y="${d.y - 6}" text-anchor="middle" font-size="11" fill="var(--accent)">塊 ${i + 1} · ${Math.round(b.w)}×${Math.round(b.h)}</text>`;
      }
    });
    boxesG.innerHTML = html;
    $('cropScanBtn').innerHTML = `${icon('check')} 掃描全部塊（${_boxes.length}）`;
  }

  // ── 指標互動：拖曳畫框 / 點框選取 / 拖角微調 ──
  wrapEl.addEventListener('pointerdown', (ev) => {
    if (_busy || !_img) return;
    const t = ev.target;
    const hIdx = t.dataset?.handle !== undefined ? parseInt(t.dataset.handle, 10) : -1;
    if (hIdx >= 0) { _dragMode = `resize-${t.cx},${t.cy}`; _dragBox = hIdx; _origBox = { ..._boxes[hIdx] }; _dragStart = toOrig(ev); return; }
    const bIdx = t.dataset?.box !== undefined ? parseInt(t.dataset.box, 10) : -1;
    if (bIdx >= 0) { _activeBox = bIdx; _dragMode = 'move'; _dragBox = bIdx; _origBox = { ..._boxes[bIdx] }; _dragStart = toOrig(ev); renderBoxes(); return; }
    // 空白處 → 新框
    const p = toOrig(ev);
    _boxes.push({ x: p.x, y: p.y, w: 1, h: 1 });
    _activeBox = _boxes.length - 1;
    _dragMode = 'draw'; _dragBox = _activeBox; _dragStart = p; _origBox = null;
    renderBoxes();
  });
  wrapEl.addEventListener('pointermove', (ev) => {
    if (!_dragMode || _busy) return;
    ev.preventDefault();
    const p = toOrig(ev);
    const b = _boxes[_dragBox];
    if (_dragMode === 'draw') {
      b.x = Math.min(_dragStart.x, p.x); b.y = Math.min(_dragStart.y, p.y);
      b.w = Math.abs(p.x - _dragStart.x); b.h = Math.abs(p.y - _dragStart.y);
    } else if (_dragMode === 'move') {
      const dx = p.x - _dragStart.x, dy = p.y - _dragStart.y;
      b.x = Math.max(0, Math.min(_img.w - _origBox.w, _origBox.x + dx));
      b.y = Math.max(0, Math.min(_img.h - _origBox.h, _origBox.y + dy));
    } else if (_dragMode.startsWith('resize-')) {
      const [hx, hy] = _dragMode.slice(8).split(',').map(Number);
      // 被拖的角（原座標）固定，對角 = 原框對角；新框 = 兩點包圍
      const ox = _origBox, ocx = hx, ocy = hy;
      const diagX = ocx === ox.x ? ox.x + ox.w : ox.x;      // 對角 x
      const diagY = ocy === ox.y ? ox.y + ox.h : ox.y;
      const x1 = Math.min(ocx, p.x, diagX), x2 = Math.max(ocx, p.x, diagX);
      const y1 = Math.min(ocy, p.y, diagY), y2 = Math.max(ocy, p.y, diagY);
      b.x = x1; b.y = y1; b.w = x2 - x1; b.h = y2 - y1;
    }
    renderBoxes();
  });
  const endDrag = () => {
    if (_dragMode) {
      const b = _boxes[_dragBox];
      if (b && (b.w < 12 || b.h < 12)) { _boxes.splice(_dragBox, 1); _activeBox = -1; }   // 太小視為誤觸
      _dragMode = null; renderBoxes();
    }
  };
  wrapEl.addEventListener('pointerup', endDrag);
  wrapEl.addEventListener('pointercancel', endDrag);
  // 雙擊框刪除
  wrapEl.addEventListener('dblclick', (ev) => {
    const bIdx = ev.target.dataset?.box !== undefined ? parseInt(ev.target.dataset.box, 10) : -1;
    if (bIdx >= 0) { _boxes.splice(bIdx, 1); _activeBox = -1; renderBoxes(); }
  });

  // ── 照片來源 ──
  $('cropTakeBtn')?.addEventListener('click', () => { if (!_busy) $('cropCamInput').click(); });
  $('cropImportBtn')?.addEventListener('click', () => { if (!_busy) $('cropImportInput').click(); });
  $('cropCamInput')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    _photoFiles.push(f); await loadPhoto(_photoFiles.length - 1);
  });
  $('cropImportInput')?.addEventListener('change', async (e) => {
    const fs = Array.from(e.target.files || []); e.target.value = '';
    if (!fs.length) return;
    _photoFiles.push(...fs);
    toast(`${fs.length} 張照片已載入（分張切割）`, '');
    await loadPhoto(_photoFiles.length - 1);
  });
  $('cropPrevBtn')?.addEventListener('click', () => { if (!_busy) loadPhoto(_curIdx - 1); });
  $('cropNextBtn')?.addEventListener('click', () => { if (!_busy) loadPhoto(_curIdx + 1); });
  $('cropClearBtn')?.addEventListener('click', () => { _boxes = []; _activeBox = -1; renderBoxes(); });

  // ── 掃描全部塊：每塊 2x 放大 + 小字增強 → 辨識 → 疊候選（重疊塊投票）──
  $('cropScanBtn')?.addEventListener('click', async () => {
    if (_busy || !_img || !_boxes.length) { if (!_boxes.length) toast('請先在圖上拖曳畫框', 'toast-error'); return; }
    _busy = true;
    const btn = $('cropScanBtn'); if (btn) btn.disabled = true;
    const loadEl = document.createElement('div');
    loadEl.className = 'ocr-loading'; loadEl.style.display = 'block';
    stage.parentNode.insertBefore(loadEl, stage.nextSibling);
    try {
      const { getActiveEngine } = await import('../lib/ocr/engine.js');
      const { engine } = await getActiveEngine();
      const perBox = [];
      for (let i = 0; i < _boxes.length; i++) {
        const b = _boxes[i];
        if (b.w < 12 || b.h < 12) continue;
        loadEl.textContent = `掃描塊 ${i + 1}/${_boxes.length}（${Math.round(b.w)}×${Math.round(b.h)} → 2x）...`;
        // 裁切 + 2x 放大
        const scale = 2;
        const cv = document.createElement('canvas');
        cv.width = Math.round(b.w * scale); cv.height = Math.round(b.h * scale);
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(_img.bitmap, b.x, b.y, b.w, b.h, 0, 0, cv.width, cv.height);
        const blob = await new Promise((res, rej) => cv.toBlob(x => x ? res(x) : rej(new Error('塊轉存失敗')), 'image/png'));
        let feed = new File([blob], `box-${i}.png`, { type: 'image/png' });
        // 小字增強
        try {
          const { enhanceSmallText } = await import('../lib/ocr/upscale.js');
          const en = await enhanceSmallText(feed);
          if (en.file) feed = en.file;
        } catch (_) {}
        const res = await engine.recognize(feed);
        // token 白名單
        const seen = new Set(); const toks = [];
        const blocks = Array.isArray(res.blocks) && res.blocks.length ? res.blocks : [{ text: res.text || '', confidence: 1 }];
        for (const block of blocks) {
          for (const raw of String(block.text || '').split(/\s+/)) {
            const tk = raw.toLowerCase().replace(/^[^\w'-]+/, '').replace(/[^\w'-]+$/, '');
            if (!_OCR_TOKEN_RE.test(tk) || seen.has(tk)) continue;
            seen.add(tk); toks.push(tk);
          }
        }
        perBox.push(toks);
      }
      // 重疊塊投票（框有互相重疊時，token 跨框出現才可靠 — 簡化：≥2 框出現或單框直接採）
      const counts = new Map();
      for (const toks of perBox) for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
      const finalTokens = [...counts.keys()];   // 全併（塊是使用者手動畫的、無邊緣碎片概念 — 投票保留給自動切割）
      loadEl.style.display = 'none';
      if (!finalTokens.length) { toast('未偵測到有效單字', 'toast-error'); return; }
      appendCandidates(finalTokens);
      toast(`塊掃描完成：${finalTokens.length} 字已疊加`, 'toast-success');
    } catch (e) {
      toast(`掃描失敗：${e.message}`, 'toast-error');
    } finally {
      _busy = false; if (btn) btn.disabled = false; loadEl.remove();
    }
  });

  // ── 候選三清單（元首令 2026-09-01）：全新不重複 / 重複 / 黑灰+雜訊 ──
  // 左右滑切換（swipe），三點指示目前清單。重複清單可勾選 → 批量轉移到字本。
  let _tabIdx = 0;
  const TAB_NAMES = ['全新單字', '重複', '黑灰名單與雜訊'];
  let _newTokens = new Set();
  let _dupTokens = new Set();
  let _noiseTokens = new Set();   // 黑灰名單 + 疑似雜訊（短/亂碼）

  /** 雜訊判定：2-3 字母的無義短詞（tesseract 碎片特徵）— 黑灰名單也算 noise 清單 */
  function isNoiseToken(t) {
    if (s.actions.isBlacklisted?.(t) || s.actions.isGraylisted?.(t)) return true;
    // 2 字母或 3 字母且非常見縮寫 → 雜訊（碎片高頻區）
    if (t.length <= 2) return true;
    if (t.length === 3 && !['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'].includes(t)) return true;
    return false;
  }

  function classifyTokens(tokens) {
    for (const t of tokens) {
      if (isNoiseToken(t)) { _noiseTokens.add(t); continue; }
      const dup = (s.state.words || []).some(w => w.word === t);
      if (dup) _dupTokens.add(t); else _newTokens.add(t);
    }
  }

  function renderTabs() {
    const lists = [
      { el: $('cropListNew'), tokens: _newTokens, badge: '', checked: true },
      { el: $('cropListDup'), tokens: _dupTokens, badge: '', checked: true },
      { el: $('cropListNoise'), tokens: _noiseTokens, badge: '🚫' },
    ];
    lists.forEach((L, i) => {
      if (!L.el) return;
      const prevChecked = new Set();
      L.el.querySelectorAll('.crop-cand-cb:checked').forEach(cb => prevChecked.add(cb.dataset.w));
      const html = [];
      for (const t of [...L.tokens].sort()) {
        const bl = s.actions.isBlacklisted?.(t);
        const grey = !bl && s.actions.isGraylisted?.(t);
        const badge = L.badge || (bl ? ' 🔒黑名單' : grey ? ' 🔒灰名單' : '');
        const checked = prevChecked.has(t) ? 'checked' : (L.checked ? 'checked' : '');
        html.push(`<label class="ocr-cand"><input type="checkbox" class="crop-cand-cb" data-w="${t}" ${checked}><span>${t}${badge}</span></label>`);
      }
      L.el.innerHTML = html.join('') || `<div style="font-size:12px;color:var(--text-tertiary);padding:8px">（空）</div>`;
    });
    // 三點指示
    const dots = $('cropTabsDots');
    if (dots) dots.innerHTML = [0, 1, 2].map(i =>
      `<span style="display:inline-block;width:${i === _tabIdx ? 18 : 7}px;height:7px;border-radius:4px;background:${i === _tabIdx ? 'var(--accent)' : 'var(--border)'};margin:0 2px;transition:all .15s"></span>`).join('');
    // 標題
    const title = $('cropTabTitle');
    if (title) title.textContent = `${TAB_NAMES[_tabIdx]}（${lists[_tabIdx]?.tokens.size || 0} 字）`;
    // 分頁位移
    const track = $('cropSwipeTrack');
    if (track) track.style.transform = `translateX(-${_tabIdx * 100}%)`;
    // 重複頁顯示批量轉移鈕；其他頁隱藏
    const dupBtn = $('cropDupMoveBtn');
    if (dupBtn) dupBtn.style.display = _tabIdx === 1 ? '' : 'none';
    // 動作鈕（全選/全不選）只作用於當前清單
    const cur = [_newTokens, _dupTokens, _noiseTokens][_tabIdx];
    $('cropSelectAllBtn').onclick = () => activeListEl().querySelectorAll('.crop-cand-cb').forEach(cb => cb.checked = true);
    $('cropSelectNoneBtn').onclick = () => activeListEl().querySelectorAll('.crop-cand-cb').forEach(cb => cb.checked = false);
  }
  function activeListEl() {
    return [$('cropListNew'), $('cropListDup'), $('cropListNoise')][_tabIdx];
  }

  // 左右滑手勢（swipe：位移 >40px 切換清單）
  let _swipeX = null;
  $('cropSwipeWrap')?.addEventListener('pointerdown', (e) => { _swipeX = e.clientX; });
  $('cropSwipeWrap')?.addEventListener('pointerup', (e) => {
    if (_swipeX === null) return;
    const dx = e.clientX - _swipeX;
    if (dx < -40 && _tabIdx < 2) { _tabIdx++; renderTabs(); focusCand(0); }
    else if (dx > 40 && _tabIdx > 0) { _tabIdx--; renderTabs(); focusCand(0); }
    _swipeX = null;
  });

  // ── 方向鍵導航（元首令 2026-09-01：電腦版鍵盤操作清單）──
  // ←→ 切換清單；↑↓ 在清單內逐字移動焦點；Space/Enter 切換勾選。
  let _focusIdx = -1;
  function focusCand(idx) {
    const cbs = activeListEl()?.querySelectorAll('.crop-cand-cb') || [];
    if (!cbs.length) { _focusIdx = -1; return; }
    _focusIdx = Math.max(0, Math.min(cbs.length - 1, idx));
    cbs.forEach((cb, i) => {
      const label = cb.closest('.ocr-cand');
      if (!label) return;
      if (i === _focusIdx) {
        label.style.outline = '2px solid var(--accent)';
        label.style.outlineOffset = '1px';
        cb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        label.style.outline = '';
      }
    });
  }
  function moveFocus(delta) {
    const cbs = activeListEl()?.querySelectorAll('.crop-cand-cb') || [];
    if (!cbs.length) return;
    focusCand(_focusIdx < 0 ? 0 : _focusIdx + delta);
  }
  document.addEventListener('keydown', _cropKeyHandler);
  function _cropKeyHandler(e) {
    // 僅切割頁作用（離頁移除）
    if (!document.getElementById('cropResultArea')) return;
    // 輸入框聚焦時不攔（避免打字被吃）
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' && e.target?.type === 'text' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); if (_tabIdx > 0) { _tabIdx--; renderTabs(); focusCand(0); } return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); if (_tabIdx < 2) { _tabIdx++; renderTabs(); focusCand(0); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); return; }
    if ((e.key === ' ' || e.key === 'Enter')) {
      const cbs = activeListEl()?.querySelectorAll('.crop-cand-cb') || [];
      if (_focusIdx >= 0 && cbs[_focusIdx]) { e.preventDefault(); cbs[_focusIdx].checked = !cbs[_focusIdx].checked; }
    }
  }

  function appendCandidates(tokens) {
    classifyTokens(tokens);
    renderTabs();
    area.style.display = 'block';
  }

  $('cropSelectAllBtn')?.addEventListener('click', () => candL.querySelectorAll('.crop-cand-cb').forEach(cb => cb.checked = true));
  $('cropSelectNoneBtn')?.addEventListener('click', () => candL.querySelectorAll('.crop-cand-cb').forEach(cb => cb.checked = false));

  // ── 匯入（依當前清單分派）：新字頁=入庫；重複頁=批量轉移字本；雜訊頁=勾了才入（override）──
  $('cropConfirmImportBtn')?.addEventListener('click', async () => {
    const picked = Array.from(activeListEl().querySelectorAll('.crop-cand-cb:checked')).map(cb => cb.dataset.w);
    if (!picked.length) { toast('請先勾選', ''); return; }
    const btn = $('cropConfirmImportBtn'); btn.disabled = true;
    try {
      if (_tabIdx === 1) {
        // 重複頁 → 批量轉移字本（元首令：把重複字從原字本移到另一字本）
        // 選目標字本：彈小選單（借用 store decks）
        const decks = s.state.decks.map(d => d.name);
        const target = window.prompt(`轉移 ${picked.length} 字到哪個字本？（輸入名稱，或新名稱建立）`, decks[0] || '');
        if (!target) return;
        let moved = 0;
        for (const w of picked) {
          const word = (s.state.words || []).find(x => x.word === w);
          if (word) { await s.actions.editWord(word.id, { deck: target }); moved++; }
        }
        toast(`已轉移 ${moved} 字到「${target}」`, 'toast-success');
        for (const t of picked) { _dupTokens.delete(t); }
        renderTabs();
        return;
      }
      if (_tabIdx === 2) {
        // 雜訊/黑灰頁：勾選 = override 強制加入（一次性授權）
        const res = await s.actions.importOcrText(picked, undefined, { override: new Set(picked) });
        toast(`強制加入 ${res.added} 字（黑灰名單 override）`, res.added ? 'toast-success' : 'toast-error');
        for (const t of picked) _noiseTokens.delete(t);
        renderTabs();
        return;
      }
      // 新字頁：一般入庫
      const res = await s.actions.importOcrText(picked, undefined, {});
      if (res.added > 0) {
        const enrichNote = res.enriched > 0 ? `（欄位補齊 ${res.enriched} 字）` : '';
        toast(`已加入 ${res.added} 個單字${enrichNote}`, 'toast-success');
      } else {
        toast(res.skipped ? `全部 ${res.skipped} 字已存在（重複頁可批量轉移）` : '入庫失敗', res.skipped ? '' : 'toast-error');
      }
      for (const t of picked) { _newTokens.delete(t); _dupTokens.add(t); }   // 入庫後移到重複頁
      renderTabs();
    } catch (e) {
      toast(`匯入失敗：${e.message}`, 'toast-error');
    } finally { btn.disabled = false; }
  });
}
