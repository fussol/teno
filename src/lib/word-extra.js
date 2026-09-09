// ═══════════════════════════════════════════════════════════════
// 單字擴充欄位卡背渲染（LOG-MW D段，共享 helper）
// etymology（字源＋首次使用）／syllables（音節；唯一來源＝韋氏字典）／
// synonym／antonym（單數欄，逗號分隔 → chips）。
// 片語已併入例句（mergeExamplePhrases／wordExample，src/lib/svg.js）：
// 同規則、同顯示上限、同展開，此處不再獨立渲染。
// 呼叫端：study-v4/mc/spell、exam-flip/mc/spell（ctx 'study'，exam 併入共用）、
// browser/deck-browser 字卡正反面（ctx 'browserFront'／'browserBack'）。
// esc：呼叫端的 escape 函式（study 頁 e／exam 頁 esc）。
// ctx：'study'（學習／測驗共用；'exam' 為別名）
// ═══════════════════════════════════════════════════════════════

/** 欄位可見度 key → 中文標籤（設定頁 master＋各渲染端共用）。 */
export const FIELD_LABELS = {
  word: '英文單字',
  pron: '發音',
  definition: '定義',
  example: '例句（含片語）',
  description: '描述',
  related: '相似詞',
  forms: '詞形變化',
  synonym: '同義',
  antonym: '反義',
  tags: '標籤',
  image: '圖片',
  syllables: '音節',
  etymology: '字源',
};

export const FIELD_KEYS = Object.keys(FIELD_LABELS);

/**
 * 取某情境可見欄位 Set（讀 window.__fieldVis；store 開機 hydrate、
 * 設定頁即時更新；缺失時全可見）。
 * @param {'browserFront'|'browserBack'|'study'|'exam'|'browser'} ctx
 *   'exam' 是 'study' 的別名（學習／測驗共用同一組）；
 *   'browser' 是 'browserFront' 的舊別名（列表等非卡片處沿用）。
 */
export function getFieldVis(ctx) {
  const c = ctx === 'exam' ? 'study' : ctx === 'browser' ? 'browserFront' : ctx;
  try {
    const v = window.__fieldVis?.[c];
    if (Array.isArray(v)) return new Set(v.filter(k => FIELD_KEYS.includes(k)));
  } catch (_) {}
  return new Set(FIELD_KEYS);
}

/** 某情境下某欄位是否可見（'word' 只在字卡正反面可關，其餘處呼叫端直接渲染）。 */
export function visShow(ctx, key) {
  return getFieldVis(ctx).has(key);
}

/**
 * 瀏覽器字卡某一面的欄位 HTML（browser.js／deck-browser.js 共用，兩頁渲染一致）。
 * @param {object} w 單字物件
 * @param {object} s store（取 state.decks 過濾字本名、state.tagConfig 取色）
 * @param {'browserFront'|'browserBack'} face 該面可見度
 * @param {object} h 呼叫端 helpers：{ escapeHtml, wordImageSlotHTML, splitFieldsHtml, fmtExample, wordExample }
 * @returns {string} HTML（該面無可見欄位時回空字串）
 */
export function cardFaceHtml(w, s, face, h) {
  if (!w || !h) return '';
  const gv = (f) => visShow(face, f);
  const e = h.escapeHtml || ((x) => String(x ?? ''));
  const exMerged = h.wordExample(w);
  const out = [];
  if (gv('word')) out.push(`<div class="card-panel-word">${e(w.word)}</div>`);
  if (gv('image')) out.push(`<div style="width:100%;max-width:440px;justify-content:center" class="wimg-slot-wrap">${h.wordImageSlotHTML(w.id)}</div>`);
  if (gv('pron') && w.pron) out.push(`<div class="card-panel-pron">${e(w.pron)}</div>`);
  // 空欄位整塊隱藏（含標題）：定義＋詞性都空就不渲染，不塞 '-' 佔位
  if (gv('definition') && (String(w.definition || '').trim() || String(w.pos || '').trim())) {
    const sf = h.splitFieldsHtml(w.pos, w.definition);
    out.push(`<div>${sf || (w.pos ? '<div style="font-size:13px;font-weight:600;color:var(--accent);background:var(--accent-bg);padding:3px 12px;border-radius:8px;display:inline-block">' + e(w.pos) + '</div>' : '') + (w.definition ? '<div class="card-panel-def">' + e(w.definition) + '</div>' : '')}</div>`);
  }
  if (gv('example') && exMerged) out.push(`<div class="card-panel-example">${h.fmtExample(exMerged)}</div>`);
  if (gv('description') && w.description) out.push(`<div class="card-panel-desc">${e(w.description)}</div>`);
  if (gv('related') && w.related && w.related.length) out.push(`<div class="card-panel-desc" style="margin-top:8px"><span style="font-weight:600;color:var(--text-tertiary);font-size:11px">相似詞 </span>${w.related.map(r => `<span style="display:inline-block;font-size:12px;color:var(--accent);background:var(--accent-bg);padding:2px 10px;border-radius:100px;border:1px solid var(--accent);white-space:nowrap;margin:1px 3px">${e(r)}</span>`).join('')}</div>`);
  if (gv('forms') && w.forms && w.forms.length) out.push(`<div class="card-panel-desc" style="margin-top:4px"><span style="font-weight:600;color:var(--text-tertiary);font-size:11px">詞形變化 </span>${w.forms.map(f => `<span style="display:inline-block;font-size:12px;color:var(--text-secondary);background:var(--bg-base);padding:2px 10px;border-radius:100px;border:1px solid var(--border-subtle);white-space:nowrap;margin:1px 3px">${e(f)}</span>`).join('')}</div>`);
  if (gv('syllables') && w.syllables) out.push(`<div class="card-panel-desc" style="margin-top:4px"><span style="font-weight:600;color:var(--text-tertiary);font-size:11px">音節 </span><span style="font-weight:600;letter-spacing:.04em">${e(w.syllables)}</span></div>`);
  if (gv('etymology') && w.etymology) out.push(`<div class="card-panel-desc" style="margin-top:4px;text-align:left"><span style="font-weight:600;color:var(--accent);font-size:11px">字源 </span>${e(w.etymology)}</div>`);
  if ((w.tags || []).length && gv('tags')) {
    const deckSet = new Set((s?.state?.decks || []).map(d => d.name));
    const showTags = (w.tags || []).filter(t => !deckSet.has(t));
    if (showTags.length) out.push(`<div class="card-panel-tags">${showTags.map(t => {
      const c = (s?.state?.tagConfig || {})[t] || 'var(--accent)';
      return `<span class="tag" style="background:${c};color:${(s?.state?.tagConfig || {})[t] ? '#fff' : 'var(--accent-on)'}">${e(t)}</span>`;
    }).join('')}</div>`);
  }
  return out.join('');
}

/**
 * @param {object} w 單字物件
 * @param {(s:string)=>string} esc escape 函式
 * @param {'study'|'exam'} [ctx] 可見度情境（預設 study）
 * @returns {string} HTML（無欄位時回空字串）
 */
export function extraFieldsHtml(w, esc, ctx = 'study') {
  if (!w) return '';
  const e = esc || ((s) => String(s ?? ''));
  const show = (k) => visShow(ctx, k);
  const out = [];
  if (w.syllables && show('syllables')) {
    out.push(`<div class="study-chips"><span class="study-chips-label">音節</span><span style="font-size:13px;color:var(--text-primary);font-weight:600;letter-spacing:.04em">${e(w.syllables)}</span></div>`);
  }
  const syns = String(w.synonym || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (syns.length && show('synonym')) {
    out.push(`<div class="study-chips"><span class="study-chips-label">同義</span>${syns.map(s => `<span class="chip-accent">${e(s)}</span>`).join('')}</div>`);
  }
  const ants = String(w.antonym || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (ants.length && show('antonym')) {
    out.push(`<div class="study-chips"><span class="study-chips-label">反義</span>${ants.map(s => `<span class="chip-subtle">${e(s)}</span>`).join('')}</div>`);
  }
  if (w.etymology && show('etymology')) {
    out.push(`<div class="study-example" style="font-style:normal"><span style="color:var(--accent);font-size:10px;letter-spacing:.08em">字源</span><br>${e(w.etymology).replace(/\n/g, '<br>')}</div>`);
  }
  return out.join('');
}
