// word-image.js — IMG1 單字圖片共享組件（2026-09-07）
// ─────────────────────────────────────────────────────────────
// 設計（IMG1-word-images-plan.md v1.2，R2/R3 席吸收）：
//  - 圖存 word_images 表（base64 data URL），本模組只做「懶載入 + 渲染」
//  - state.words 不帶圖（開機全量載入不炸記憶體）
//  - 渲染點一律走「占位 div + onMount 填充」——render() 同步簽名不動
//  - carousel：dots + 左右箭頭（Lucide）+ touch swipe + 方向鍵
//    （非輸入態才攔；doc-level keydown 走 G11 冪等慣例：具名 handler 先 remove 再 add）
//  - module cache 以 wordId 為鍵；editWord 後 invalidate(wordId)
// ─────────────────────────────────────────────────────────────
import { getImagesForWord, getImagesForWords } from './db.js';
import { icon } from './svg.js';

// ── module cache（wordId → images[]；無圖快取為空陣列以省重查）──
const _cache = new Map();

/** 渲染前批量載入（一次 IN query）。回傳快取/DB 合併後的 Map。 */
export async function hydrateImages(wordIds) {
  const ids = [...new Set((wordIds || []).filter(Boolean))];
  if (!ids.length) return _cache;
  const miss = ids.filter(id => !_cache.has(id));
  if (miss.length) {
    const fromDb = await getImagesForWords(miss);
    for (const id of miss) _cache.set(id, fromDb.get(id) || []);
  }
  return _cache;
}

/** 取單字圖（快取優先，miss 才查 DB）。 */
export async function getWordImages(wordId) {
  if (!wordId) return [];
  if (_cache.has(wordId)) return _cache.get(wordId);
  const imgs = await getImagesForWord(wordId);
  _cache.set(wordId, imgs);
  return imgs;
}

/** 編輯存檔後失效該字快取（store.editWord 完成後呼叫）。 */
export function invalidateWordImages(wordId) {
  if (wordId) _cache.delete(wordId);
  else _cache.clear();
}

/** 同步讀快取（渲染點 onMount 已 hydrate 過後的快速路徑；無鍵回 null＝未載入）。 */
export function peekWordImages(wordId) {
  return _cache.has(wordId) ? _cache.get(wordId) : null;
}

// ── carousel 渲染（純字串生成，可 harness 測）──

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 產生 carousel 的 HTML。占位容器掛 `data-wimg` 屬性，onMount 由
 * mountWordImage() 綁互動。
 * @param {Array<{filename:string,data:string}>} images
 * @param {{maxH?:string,cls?:string}} opts
 */
export function renderImageCarousel(images, opts = {}) {
  if (!images || !images.length) return '';
  const maxH = opts.maxH || '40vh';
  const cls = opts.cls || 'wimg-carousel';
  const dots = images.length > 1
    ? `<div class="wimg-dots" data-wimg-dots>${images.map((_, i) =>
        `<span class="wimg-dot${i === 0 ? ' on' : ''}" data-wimg-dot="${i}"></span>`).join('')}</div>`
    : '';
  const arrows = images.length > 1
    ? `<button class="wimg-nav wimg-prev" data-wimg-prev title="上一張（←）">${icon('chevronL')}</button>
       <button class="wimg-nav wimg-next" data-wimg-next title="下一張（→）">${icon('chevronR')}</button>`
    : '';
  const imgs = images.map((im, i) =>
    `<img class="wimg-img${i === 0 ? ' on' : ''}" src="${esc(im.data)}" alt="${esc(im.filename || 'word image')}" loading="lazy" decoding="async" data-wimg-idx="${i}">`
  ).join('');
  return `<div class="${cls}" data-wimg data-count="${images.length}">
    <div class="wimg-track" data-wimg-track>${imgs}</div>
    ${arrows}
    ${dots}
  </div>`;
}

/** carousel 的 CSS（一次注入；wordImageCSS 被各頁嵌入 or main.js 統一注入一次）。 */
export const WORD_IMAGE_CSS = `
.wimg-carousel{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;width:100%}
.wimg-track{position:relative;width:100%;max-width:440px;aspect-ratio:auto;min-height:0}
.wimg-track img.wimg-img{display:none;width:100%;max-height:var(--wimg-maxh,40vh);object-fit:contain;border-radius:12px;border:1px solid var(--border);background:var(--bg-base)}
.wimg-track img.wimg-img.on{display:block}
.wimg-nav{position:absolute;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .15s,border-color .15s,color .15s;z-index:2}
.wimg-nav:hover{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}
.wimg-prev{left:4px}.wimg-next{right:4px}
.wimg-dots{display:flex;gap:6px;align-items:center}
.wimg-dot{width:6px;height:6px;border-radius:50%;background:var(--border);cursor:pointer;transition:background-color .15s,transform .15s}
.wimg-dot.on{background:var(--accent);transform:scale(1.25)}
`;

// ── DOM 綁定（薄層，內測門驗）──

/** 綁定一個 carousel 容器的互動（arrows/dots/swipe）。回傳 cleanup fn。 */
export function bindWordImageCarousel(container) {
  if (!container) return () => {};
  const root = container.closest('[data-wimg]') || container;
  const imgs = [...root.querySelectorAll('img.wimg-img')];
  const dots = [...root.querySelectorAll('[data-wimg-dot]')];
  if (imgs.length < 2) return () => {};
  let idx = imgs.findIndex(i => i.classList.contains('on'));
  if (idx < 0) idx = 0;
  const show = (n) => {
    idx = ((n % imgs.length) + imgs.length) % imgs.length;
    imgs.forEach((im, i) => im.classList.toggle('on', i === idx));
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  const prev = root.querySelector('[data-wimg-prev]');
  const next = root.querySelector('[data-wimg-next]');
  const onPrev = () => show(idx - 1);
  const onNext = () => show(idx + 1);
  prev?.addEventListener('click', onPrev);
  next?.addEventListener('click', onNext);
  dots.forEach(d => d.addEventListener('click', () => show(+d.dataset.wimgDot)));

  // touch swipe（沿 OCR pointer 模型：down 記 x，up 判位移）
  let sx = null;
  const onDown = (e) => { sx = e.clientX; };
  const onUp = (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) < 24) return;
    show(dx < 0 ? idx + 1 : idx - 1);
  };
  const track = root.querySelector('[data-wimg-track]');
  track?.addEventListener('pointerdown', onDown);
  track?.addEventListener('pointerup', onUp);

  return () => {
    prev?.removeEventListener('click', onPrev);
    next?.removeEventListener('click', onNext);
    dots.forEach(d => d.removeEventListener('click', () => {}));
    track?.removeEventListener('pointerdown', onDown);
    track?.removeEventListener('pointerup', onUp);
  };
}

// ── doc-level 鍵盤（G11 冪等慣例：具名 handler 先 remove 再 add）──
let _docBound = false;
function _onDocKey(e) {
  // IME 組字期不攔（R2 席）；輸入態（input/textarea/contenteditable）不攔——
  // spell/mc 有文字輸入游標，ArrowLeft/Right 屬游標移動
  if (e.isComposing) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const car = document.querySelector('[data-wimg] .wimg-img.on');
  if (!car) return;
  const root = car.closest('[data-wimg]');
  const imgs = [...root.querySelectorAll('img.wimg-img')];
  const dots = [...root.querySelectorAll('[data-wimg-dot]')];
  if (imgs.length < 2) return;
  let idx = imgs.findIndex(i => i.classList.contains('on'));
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const next = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
    idx = ((next % imgs.length) + imgs.length) % imgs.length;
    imgs.forEach((im, i) => im.classList.toggle('on', i === idx));
    dots.forEach((d, i) => d.classList.toggle('on', i === idx));
  }
}
/** 啟用全域方向鍵（頁面掛了 carousel 時呼叫一次；冪等）。 */
export function ensureWordImageKeys() {
  if (_docBound) return;
  _docBound = true;
  document.addEventListener('keydown', _onDocKey, true);
}
/** 面板關閉/離頁時停用（Escape 關面板掛這個）。 */
export function disableWordImageKeys() {
  if (!_docBound) return;
  _docBound = false;
  document.removeEventListener('keydown', _onDocKey, true);
}

// ── onMount 填充（渲染點標準接入：占位 → 查圖 → 插入 carousel）──

/**
 * 渲染點 onMount 標準調用：找頁內 [data-wimg-slot="<wordId>"] 占位，
 * 查圖後填入 carousel 並綁互動。翻卡/換頁重跑 onMount 時自然重綁。
 * @param {string[]} wordIds 本次渲染會顯示的字
 */
export async function mountWordImages(wordIds) {
  await hydrateImages(wordIds);
  ensureWordImageKeys();
  for (const el of document.querySelectorAll('[data-wimg-slot]')) {
    const wid = el.dataset.wimgSlot;
    const imgs = _cache.get(wid) || [];
    el.innerHTML = imgs.length ? renderImageCarousel(imgs) : '';
    if (imgs.length) bindWordImageCarousel(el.firstChild);
  }
}

/** 占位 div helper（render 字串裡放這個）。 */
export function wordImageSlotHTML(wordId) {
  return `<div class="wimg-slot" data-wimg-slot="${esc(wordId)}"></div>`;
}

// ── 編輯器縮圖列（純字串 + api；harness T6 釘）──

/**
 * 編輯器縮圖列。回傳 { html, getVal, addFiles }。
 * images: [{id?, filename, data}]（id 有值 = 既有 row）
 * onChange(newImages)：增/刪/排序後回調（modal save 時取最終序寫庫）
 */
export function renderEditorThumbs(images, onChange) {
  const list = [...(images || [])];
  const esc2 = esc;
  const html = () => `
    <div class="wimg-thumbs" data-wimg-thumbs>
      ${list.map((im, i) => `
        <div class="wimg-thumb" data-wimg-thumb="${i}" title="${esc2(im.filename || '')}">
          <img src="${esc2(im.data)}" alt="${esc2(im.filename || '')}">
          <div class="wimg-thumb-tools">
            <button type="button" data-wimg-move="-1" title="左移">${icon('chevronL')}</button>
            <button type="button" data-wimg-move="1" title="右移">${icon('chevronR')}</button>
            <button type="button" data-wimg-del title="刪除">${icon('trash')}</button>
          </div>
          <span class="wimg-thumb-idx">${i + 1}</span>
        </div>`).join('') || '<span style="font-size:12px;color:var(--text-tertiary)">尚無圖片</span>'}
    </div>`;
  const api = {
    get html() { return html(); },
    getVal: () => list,
    /** 檔案 input change 用：FileReader 逐張轉 data URL 後 push（2MB 提醒/10MB 硬上限） */
    addFiles: async (files, onWarn) => {
      for (const f of files) {
        if (!/image\//.test(f.type)) continue;
        if (f.size > 10 * 1024 * 1024) { onWarn?.(`「${f.name}」超過 10MB 上限，已跳過`); continue; }
        if (f.size > 2 * 1024 * 1024) onWarn?.(`「${f.name}」較大（${(f.size / 1048576).toFixed(1)}MB），載入會稍慢`);
        const data = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(f);   // ocr.js:434 先例：WebKitGTK blob: taint，data: 安全
        });
        list.push({ filename: f.name, data });
      }
      onChange?.(list);
    },
    _move: (i, d) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      onChange?.(list);
    },
    _del: (i) => { list.splice(i, 1); onChange?.(list); },
  };
  return api;
}

/** 縮圖列事件綁定（modal onMount 用；回傳 cleanup）。 */
export function bindEditorThumbs(container, thumbsApi) {
  if (!container) return () => {};
  const onTool = (e) => {
    const btn = e.target.closest('[data-wimg-move],[data-wimg-del]');
    if (!btn) return;
    const thumb = btn.closest('[data-wimg-thumb]');
    if (!thumb) return;
    const i = +thumb.dataset.wimgThumb;
    if (btn.hasAttribute('data-wimg-del')) thumbsApi._del(i);
    else thumbsApi._move(i, +btn.dataset.wimgMove);
  };
  container.addEventListener('click', onTool);
  return () => container.removeEventListener('click', onTool);
}

export const WORD_IMAGE_THUMB_CSS = `
.wimg-thumbs{display:flex;flex-wrap:wrap;gap:8px}
.wimg-thumb{position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--border)}
.wimg-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wimg-thumb-tools{position:absolute;bottom:0;left:0;right:0;display:flex;gap:2px;background:rgba(0,0,0,.55);opacity:0;transition:opacity .15s}
.wimg-thumb:hover .wimg-thumb-tools{opacity:1}
.wimg-thumb-tools button{flex:1;border:none;background:transparent;color:#fff;width:22px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px}
.wimg-thumb-idx{position:absolute;top:2px;left:4px;font-size:10px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.8);font-family:var(--mono)}
`;
