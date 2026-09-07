// ═══════════════════════════════════════════════════════════════
// 單字擴充欄位卡背渲染（LOG-MW D段，共享 helper）
// etymology（字源＋首次使用）／syllables（音節）／phrases（片語）／
// synonym／antonym（單數欄，逗號分隔 → chips）。
// 呼叫端：study-v4/mc/spell、exam-flip/mc/spell、browser/deck-browser 詳情。
// esc：呼叫端的 escape 函式（study 頁 e／exam 頁 esc）。
// ═══════════════════════════════════════════════════════════════

/**
 * @param {object} w 單字物件
 * @param {(s:string)=>string} esc escape 函式
 * @returns {string} HTML（無欄位時回空字串）
 */
export function extraFieldsHtml(w, esc) {
  if (!w) return '';
  const e = esc || ((s) => String(s ?? ''));
  const out = [];
  if (w.syllables) {
    out.push(`<div class="study-chips"><span class="study-chips-label">音節</span><span style="font-size:13px;color:var(--text-primary);font-weight:600;letter-spacing:.04em">${e(w.syllables)}</span></div>`);
  }
  const syns = String(w.synonym || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (syns.length) {
    out.push(`<div class="study-chips"><span class="study-chips-label">同義</span>${syns.map(s => `<span class="chip-accent">${e(s)}</span>`).join('')}</div>`);
  }
  const ants = String(w.antonym || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (ants.length) {
    out.push(`<div class="study-chips"><span class="study-chips-label">反義</span>${ants.map(s => `<span class="chip-subtle">${e(s)}</span>`).join('')}</div>`);
  }
  if (w.etymology) {
    out.push(`<div class="study-example" style="font-style:normal"><span style="color:var(--accent);font-size:10px;letter-spacing:.08em">字源</span><br>${e(w.etymology).replace(/\n/g, '<br>')}</div>`);
  }
  if (w.phrases) {
    out.push(`<div class="study-example" style="font-style:normal"><span style="color:var(--accent);font-size:10px;letter-spacing:.08em">片語</span><br>${e(w.phrases).replace(/\n/g, '<br>')}</div>`);
  }
  return out.join('');
}
