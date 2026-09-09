// ═══════════════════════════════════════════════════════════════
// 單字擴充欄位卡背渲染（LOG-MW D段，共享 helper）
// etymology（字源＋首次使用）／syllables（音節；唯一來源＝韋氏字典）／
// synonym／antonym（單數欄，逗號分隔 → chips）。
// 片語已併入例句（mergeExamplePhrases／wordExample，src/lib/svg.js）：
// 同規則、同顯示上限、同展開，此處不再獨立渲染。
// 呼叫端：study-v4/mc/spell、exam-flip/mc/spell、browser/deck-browser 詳情。
// esc：呼叫端的 escape 函式（study 頁 e／exam 頁 esc）。
// ctx：'study' | 'exam'（可見度看對應組；browser 由卡片自理）。
// ═══════════════════════════════════════════════════════════════

/** 欄位可見度 key → 中文標籤（設定頁 master＋各渲染端共用）。 */
export const FIELD_LABELS = {
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
 * @param {'browser'|'study'|'exam'} ctx
 */
export function getFieldVis(ctx) {
  try {
    const v = window.__fieldVis?.[ctx];
    if (Array.isArray(v)) return new Set(v.filter(k => FIELD_KEYS.includes(k)));
  } catch (_) {}
  return new Set(FIELD_KEYS);
}

/** 某情境下某欄位是否可見。 */
export function visShow(ctx, key) {
  return getFieldVis(ctx).has(key);
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
