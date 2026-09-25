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
  // REPS1（2026-09-25 使用者裁示）：複習次數／上次複習各自獨立顯示，
  // 資料源＝cards 表（words 無排程欄位）。新增 key 必須進 FIELD_LABELS，
  // 否則 getFieldVis() 的白名單 filter 會把它濾掉、設定頁也不會長出開關。
  reps: '複習次數',
  lastReview: '上次複習',
};

export const FIELD_KEYS = Object.keys(FIELD_LABELS);

/**
 * REPS1：僅適用於學習情境的欄位（flip／mc／spell 三個學習模式各自顯示自己的卡狀態）。
 *
 * 兩個後果，都由此清單驅動：
 * 1. 不在瀏覽器字卡（browserFront／browserBack）與測驗頁渲染——那兩處沒有「對應模式」
 *    可言（瀏覽器無模式；測驗根本不寫卡，顯示的數字永遠不受該次測驗影響）。
 * 2. 預設隱藏：使用者須在設定頁「學習」組明確勾選才會出現。
 *
 * store.js 的 hydrate 白名單／fallback 與 settings.js 的 UI fallback 共用此清單，
 * 避免語意散落多處而漂移。
 */
export const FIELD_STUDY_ONLY = ['reps', 'lastReview'];

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
  // 無可見度資料時：全可見，但僅限學習情境的欄位仍不自動出現（REPS1）
  return new Set(FIELD_KEYS.filter(k => !FIELD_STUDY_ONLY.includes(k)));
}

/** 某情境下某欄位是否可見（'word' 只在字卡正反面可關，其餘處呼叫端直接渲染）。 */
export function visShow(ctx, key) {
  return getFieldVis(ctx).has(key);
}

/**
 * REPS1：lastReview（UTC ISO 字串，cards.last_review）→ 相對時間文字。
 * 無法解析／空值回空字串（呼叫端據此整塊不渲染，不塞佔位）。
 * 分段沿用 exam-session.js 的 formatSessionTime（1 分／1 時／1 天／7 天），
 * 但該檔在 core/ 且吃 ms number，word-extra 是零 import 的共用 leaf，
 * 故本地實作以免 lib→core 反向依賴。
 */
function fmtLastReview(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '剛剛';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const d = new Date(t);   // 超過一週改絕對日期（本地時區）
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 複習次數／上次複習兩塊 HTML（瀏覽器字卡與學習／測驗共用；各自獨立判斷可見度）。
 *  回傳 block 字串陣列（呼叫端 push(...)），保持與其他欄位一致的 out 結構。
 *  無 card（未學過的詞）或欄位無值 → 該塊不產生。 */
function cardStatBlocks(card, e, gv) {
  if (!card) return [];
  const out = [];
  if (gv('reps')) {
    out.push(`<div class="card-panel-desc" style="margin-top:4px"><span style="font-weight:600;color:var(--text-tertiary);font-size:11px">複習次數 </span><span style="font-weight:600">${e(card.reps ?? 0)}</span></div>`);
  }
  if (gv('lastReview')) {
    const s = fmtLastReview(card.lastReview);
    if (s) out.push(`<div class="card-panel-desc" style="margin-top:4px"><span style="font-weight:600;color:var(--text-tertiary);font-size:11px">上次複習 </span><span style="font-weight:600">${e(s)}</span></div>`);
  }
  return out;
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
  // IMGTOP1: 圖片顯示於英文單字上方（使用者 2026-09-10 裁示）
  if (gv('image')) out.push(`<div style="width:100%;max-width:440px;justify-content:center" class="wimg-slot-wrap">${h.wordImageSlotHTML(w.id)}</div>`);
  if (gv('word')) out.push(`<div class="card-panel-word">${e(w.word)}</div>`);
  if (gv('pron') && w.pron) out.push(`<div class="card-panel-pron">${e(w.pron)}</div>`);
  // 空欄位整塊隱藏（含標題）：定義＋詞性都空就不渲染，不塞 '-' 佔位
  if (gv('definition') && (String(w.definition || '').trim() || String(w.pos || '').trim())) {
    const sf = h.splitFieldsHtml(w.pos, w.definition);
    out.push(`<div>${sf || (w.pos ? '<div style="font-size:13px;font-weight:600;color:var(--accent);background:var(--accent-bg);padding:3px 12px;border-radius:8px;display:inline-block">' + e(w.pos) + '</div>' : '') + (w.definition ? '<div class="card-panel-def">' + e(w.definition) + '</div>' : '')}</div>`);
  }
  if (gv('example') && exMerged) {
    // EXNEXT1: 抽樣池（超上限時可按鈕換下一組）
    // CARDNEXT1（2026-09-11 使用者裁示）：瀏覽器字卡例句區內「下一組」鈕拔除——
    // head 已有同功能鈕（cardExNextBtn），留兩顆沒意義。刷新只走 head 鈕。
    const shown = h.examplePoolFor ? h.examplePoolFor(w) : [exMerged];
    out.push(`<div class="card-panel-example">${h.fmtExample(shown)}</div>`);
  }
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
  // REPS1：複習次數／上次複習刻意【不在】瀏覽器字卡渲染——
  //   flip／mc／spell 三模式各有自己的卡狀態（state.cards／cardsMc／cardsSpell），
  //   瀏覽器沒有「對應模式」可言，硬取 flip 那張會對只練 mc/spell 的詞顯示錯誤數字。
  //   故只在學習情境（extraFieldsHtml，由該模式自己的 session.current.card 供值）顯示。
  return out.join('');
}

/**
 * @param {object} w 單字物件
 * @param {(s:string)=>string} esc escape 函式
 * @param {'study'|'exam'} [ctx] 可見度情境（預設 study）
 * @param {object} [card] card 物件（REPS1：複習次數／上次複習來源）。
 *   ⚠️ 只有學習頁該傳，且必須傳【該模式自己的卡】：
 *   study-v4 傳 session.current.card（flip）／study-mc 傳 session.current.card（mc）／
 *   study-spell 傳 session.current.card（spell）—— 三者由 makeSession 分別餵
 *   state.cards／cardsMc／cardsSpell，所以同一個存取式天然取得對應模式的資料。
 *   測驗頁不傳（測驗不寫卡，顯示該數字會誤導）；瀏覽器不走本函式。
 * @returns {string} HTML（無欄位時回空字串）
 */
export function extraFieldsHtml(w, esc, ctx = 'study', card = null) {
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
  // REPS1：複習次數／上次複習——僅學習情境渲染。
  //   ctx 'exam' 依設計別名到 study（可見度共用），但這兩個欄位不該出現在測驗頁
  //   （測驗不寫卡），故此處獨立擋掉，避免未來有人補傳 card 就漏出來。
  if (ctx !== 'exam') out.push(...cardStatBlocks(card, e, show));
  return out.join('');
}
