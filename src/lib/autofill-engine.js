// ═══════════════════════════════════════════════════════════════
// 自動填入共用引擎（AUTOFILL-ENGINE1，2026-09-11）
//
// 收斂前：tools.js __comboFull/fillWord、deck-browser.js runBatchAdd/fillOne
// 各寫一套來源分派（pos/example/pron/related/forms/trans/syn/ant/phrase
// ＋字源/音節/衍生），改一邊漏一邊（字源音節漏接組合包即實例）。
// 收斂後：欄位表＋fetch 快取語意＋逐欄填寫全歸這裡；
// 組合包、批量新增調同一個 fillWordFields，只差 methods map 跟 UI。
// 編輯器 sparkle（llmFill*/mwFillExtra/三顆例句鈕）亦全走 fillWordFields
// （ENGINE3；單欄 UI 寫入＋chip 合併留在呼叫端，引擎保持 node-safe 可測），
// autoFillAll chain（順序 UI 流）維持呼叫既有函數，傳遞受惠不動。
//
// node-safe：只 import core/import.js（無外部依賴）；
// lookup/LLM 全經 fetchers 注入，harness 用 stub 零網路可測。
// ═══════════════════════════════════════════════════════════════
import { normalizePos } from '../core/import.js';

// ── 欄位表（12 欄；組合包用其中 11，不含 derivative）──
// fixed: true＝來源寫死不給選（only Merriam provides these）
export const AUTOFILL_FIELDS = [
  { id: 'pos', label: '詞性', fixed: false },
  { id: 'example', label: '例句', fixed: false },
  { id: 'pron', label: '發音', fixed: false },
  { id: 'related', label: '相關詞', fixed: false },
  { id: 'forms', label: '詞形', fixed: false },
  { id: 'trans', label: '翻譯', fixed: false },
  { id: 'syn', label: '同義詞', fixed: false },
  { id: 'ant', label: '反義詞', fixed: false },
  { id: 'phrase', label: '片語', fixed: false },
  { id: 'etymology', label: '字源', fixed: true },
  { id: 'syllables', label: '音節', fixed: true },
  { id: 'derivative', label: '衍生', fixed: true },
];

// 組合包預設（11 欄；related 預設 llm 沿用舊行為）
export const DEFAULT_METHODS = {
  pos: 'cambridge',
  example: 'dictionary-api',
  pron: 'cambridge',
  related: 'llm',
  forms: 'merriam',
  trans: 'cambridge',
  syn: 'merriam',
  ant: 'merriam',
  phrase: 'merriam',
  etymology: 'merriam',
  syllables: 'merriam',
};

// 批量新增固定（12 欄；related 走 merriam+llm 雙併，沿用舊 fillOne 語意）
export const BATCH_METHODS = {
  pos: 'cambridge',
  example: 'dictionary-api',
  pron: 'cambridge',
  related: 'merriam+llm',
  forms: 'merriam',
  trans: 'cambridge',
  syn: 'merriam',
  ant: 'merriam',
  phrase: 'merriam',
  etymology: 'merriam',
  syllables: 'merriam',
  derivative: 'merriam',
};

// ── 純函式（語意照抄 tools.js，engine 內自含不跨檔 import）──

export function countSentences(text) {
  if (!text || !text.trim()) return 0;
  return text.split('\n').filter(l => l.trim().length > 2).length;
}

export function dedupSentences(text, newLines) {
  const existing = new Set(
    (text || '').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
  );
  return [...new Set(newLines)].filter(l => !existing.has(l.trim().toLowerCase()));
}

export function mergeComma(cur, fresh) {
  const spl = /[,，]/;
  const seen = new Set(String(cur || '').split(spl).map(x => x.trim().toLowerCase()).filter(Boolean));
  const add = [...new Set(fresh.map(x => String(x || '').trim()).filter(Boolean))].filter(x => !seen.has(x.toLowerCase()));
  return [...String(cur || '').split(spl).map(x => x.trim()).filter(Boolean), ...add].join(', ');
}

export function mergeExamplePhrases(example, phrases) {
  const lines = (s) => String(s ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  const out = [...lines(example)];
  const seen = new Set(out);
  for (const l of lines(phrases)) {
    if (!seen.has(l)) { seen.add(l); out.push(l); }
  }
  return out.join('\n');
}

export const posToks = (s) => normalizePos(s).split(',').map(x => x.trim()).filter(Boolean);

/** 裸詞判定（組合包管理 11 欄；derivative 不歸組合包管，不計入） */
export function isBareWord(w) {
  const empty = (v) => !v || !String(v).trim();
  const emptyArr = (a) => !a || !Array.isArray(a) || a.length === 0;
  return empty(w.pos) && empty(w.definition) && empty(w.pron) && empty(w.example)
    && emptyArr(w.related) && emptyArr(w.forms)
    && empty(w.synonym) && empty(w.antonym) && empty(w.phrases)
    && empty(w.etymology) && empty(w.syllables);
}

export function isQuotaError(e) {
  return /401|429/.test(String(e?.message || e));
}

/**
 * 逐字全欄位填寫（tools.js fillWord ＋ deck-browser fillOne 的合併體）。
 *
 * @param {object} args
 * @param {string} args.wordText 查詢詞
 * @param {object} args.existing 已有欄位（空物件＝新字；供應覆寫語意比對）
 * @param {object} args.methods 欄位→來源（DEFAULT_METHODS／BATCH_METHODS／子集）
 * @param {boolean|object} args.overwrite 覆寫開（整欄取代＋無視門檻；關＝只補缺失）
 *   布林＝全欄共用；物件＝逐欄（{pos:true,...}，COMBO2 組合包每欄覆寫開關用；未列＝關）
 * @param {number} args.threshold 例句門檻（countSentences < threshold 才補）
 * @param {number} args.count LLM 例句生成句數
 * @param {number} args.exampleMax 例句上限（批量舊語意 cap 3；組合包不過濾＝Infinity）
 * @param {object} args.fetchers { getCamEn, getCamZh, getMw, llmJson, llmText, llmOk }
 *   getCamEn/getCamZh/getMw：() => Promise<解析後物件>（呼叫端做快取＋suggest 語意）
 *   llmJson：(prompt) => Promise<string[]|null>（related/forms/syn/ant/phrase 陣列路）；
 *   llmText：(prompt) => Promise<string>（pos/example/pron/trans raw 文字路，沿用舊語意）；
 *   llmOk：bool
 * @param {(field, status)=>void} args.onStat 逐欄回報（ok/fail/skip；可省略）
 * @returns {Promise<{patch, aborted, abortError, usedRemote}>}
 *   patch：欄位差量（trans→definition；phrase 併入 example＋phrases=''）；
 *   aborted＋abortError：韋氏 quota 時置位（呼叫端清 queue＋toast）。
 *   usedRemote：有無打過遠端（呼叫端節流 400ms 用）。
 */
export async function fillWordFields({
  wordText, existing = {}, methods = DEFAULT_METHODS,
  overwrite = false, threshold = 1, count = 1, exampleMax = Infinity,
  fetchers = {}, onStat = () => {},
}) {
  const w = wordText;
  const ex = existing || {};
  const patch = {};
  const errors = {};
  let aborted = false, abortError = null, usedRemote = false;
  const { getCamEn, getCamZh, getMw, llmJson, llmText, llmOk } = fetchers;
  const need = (field) => methods[field] !== undefined;
  // COMBO2: overwrite 可為布林（全欄共用，舊語意）或物件（逐欄，組合包每欄覆寫開關用）
  const ow = (field) => (overwrite && typeof overwrite === 'object' ? !!overwrite[field] : !!overwrite);
  const bump = (f, k, e) => { if (k === 'fail' && e !== undefined) errors[f] = String(e?.message || e || ''); try { onStat(f, k); } catch (_) {} };
  const quota = (e) => {
    if (isQuotaError(e)) { aborted = true; abortError = e; return true; }
    return false;
  };
  const wrapRemote = (fn) => async () => { const r = await fn(); usedRemote = true; return r; };
  const camEn = getCamEn ? wrapRemote(getCamEn) : null;
  const camZh = getCamZh ? wrapRemote(getCamZh) : null;
  const mw = getMw ? wrapRemote(getMw) : null;
  const capEx = (lines) => (Number.isFinite(exampleMax) ? lines.slice(0, exampleMax) : lines);

  // ── 詞性 ──
  if (need('pos') && (ow('pos') || !ex.pos?.trim())) {
    try {
      const M = methods.pos;
      if (M === 'merriam') {
        const f = await mw();
        const pos = normalizePos(String(f.pos || ''));
        if (pos) { patch.pos = pos; bump('pos', 'ok'); } else bump('pos', 'fail');
      } else if (M === 'llm') {
        if (!llmOk) bump('pos', 'skip');
        else {
          const text = await llmText(`What is/are the part(s) of speech of "${w}"? If multiple, list them comma-separated. Return ONLY English POS labels (e.g. noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, determiner, article, plural noun), nothing else.`);
          const pos = normalizePos(String(text ?? ''));
          if (pos) { patch.pos = pos; bump('pos', 'ok'); } else bump('pos', 'fail');
        }
      } else {
        const data = await camEn();
        const newRaw = [...new Set((data.senses || []).flatMap(x => (x.part_of_speech || '').split(',').map(p => p.trim()).filter(Boolean)))];
        const mapped = posToks(newRaw.join(','));
        if (ow('pos')) {
          const replaced = mapped.join(', ');
          if (replaced) { patch.pos = replaced; bump('pos', 'ok'); } else bump('pos', 'fail');
        } else {
          const cur = new Set(posToks(ex.pos));
          const toAdd = mapped.filter(p => !cur.has(p));
          if (toAdd.length) { patch.pos = [...cur, ...toAdd].filter(Boolean).join(', '); bump('pos', 'ok'); } else bump('pos', 'fail');
        }
      }
    } catch (e) { bump('pos', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 例句 ──
  if (need('example') && (ow('example') || countSentences(ex.example) < threshold)) {
    try {
      const M = methods.example;
      let fresh = [];
      if (M === 'merriam') fresh = String((await mw()).example || '').split('\n').map(x => x.trim()).filter(Boolean);
      else if (M === 'cambridge') {
        const data = await camEn();
        // zh 形例句可能是 {english} 物件（en 形是純字串）；一律正規成字串，免 [object Object] 灌進 chip
        for (const sense of data.senses || []) for (const e2 of sense.examples || []) {
          const t = typeof e2 === 'string' ? e2 : String(e2?.english || '');
          if (t.trim()) fresh.push(t.trim());
        }
      } else if (M === 'tatoeba') {
        // TATOEBA-SORT1：API 必帶 sort（無則 400；實測 relevance 回 220 筆 ant）。
        const res = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w)}&lang=eng&sort=relevance`);
        if (!res.ok) throw new Error('tatoeba');
        const body = await res.json();
        // AUTOFILL-CONTRACT1：trim（同 dictionary-api 分支；免空白句佔位）
        fresh = (body.data || []).map(x => String(x.text ?? '').trim()).filter(Boolean);
      } else if (M === 'llm') {
        if (!llmOk) { bump('example', 'skip'); fresh = null; }
        else {
          const text = await llmText(`Create ${count} short example sentences using the word "${w}". Format: one sentence per line, each ending with proper punctuation (. ! ?). Only output the sentences, nothing else.`);
          fresh = String(text ?? '').split('\n').filter(Boolean).map(l => l.trim()).filter(l => l.length > 5).slice(0, count);
        }
      } else {
        // DICTAPI-TIMEOUT1：公網已死（實測 15s+ hang 零位元組），10s 斷尾
        // fail-fast，不卡例句鏈；活著時行為不變。
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        try {
          const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, { signal: ctl.signal });
          if (res.ok) {
            const data = await res.json();
            for (const entry of data) for (const m of entry.meanings || []) for (const d of m.definitions || []) if (d.example) fresh.push(d.example.trim());
          } else throw new Error('dictapi');
        } catch (e) {
          if (e?.name === 'AbortError') throw new Error('dictapi-timeout');
          throw e;
        } finally { clearTimeout(timer); }
      }
      if (fresh === null) { /* llm 跳過，已記 skip */ }
      else {
        fresh = capEx([...new Set(fresh)]);
        const unique = ow('example') ? [...new Set(fresh)] : dedupSentences(ex.example, fresh);
        if (unique.length) {
          patch.example = (ow('example') ? unique : [(ex.example || '').trim(), ...unique]).filter(Boolean).join('\n');
          bump('example', 'ok');
        } else bump('example', 'fail');
      }
    } catch (e) { bump('example', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 發音 ──
  if (need('pron') && (ow('pron') || !ex.pron?.trim())) {
    try {
      const M = methods.pron;
      if (M === 'merriam') {
        const f = await mw();
        if (f.pron) { patch.pron = `/${String(f.pron).replace(/^\/+|\/+$/g, '')}/`; bump('pron', 'ok'); } else bump('pron', 'fail');
      } else if (M === 'llm') {
        if (!llmOk) bump('pron', 'skip');
        else {
          const text = await llmText(`Provide the IPA pronunciation of "${w}". Return ONLY the IPA string (e.g. /ˈhɛloʊ/), nothing else.`);
          const cleaned = String(text ?? '').trim().replace(/^\/+|\/+$/g, '');
          if (cleaned) { patch.pron = `/${cleaned}/`; bump('pron', 'ok'); } else bump('pron', 'fail');
        }
      } else {
        const data = await camEn();
        const pron = String(data.uk_ipa || data.us_ipa || '').trim().replace(/^\/+|\/+$/g, '');
        // AUTOFILL-CONTRACT1：包斜線（同 merriam/llm 分支；裸 IPA 顯示不一致）
        if (pron) { patch.pron = `/${pron}/`; bump('pron', 'ok'); } else bump('pron', 'fail');
      }
    } catch (e) { bump('pron', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 相關詞（merriam＝synonym＋related union 取 12；llm＝JSON；merriam+llm＝雙併，批量舊語意）──
  if (need('related') && (ow('related') || !ex.related?.length)) {
    try {
      const M = methods.related;
      if (M === 'merriam' || M === 'merriam+llm') {
        const f = await mw();
        const rel = [...new Set([...String(f.synonym || '').split(',').map(x => x.trim()).filter(Boolean), ...(f.related || [])])].slice(0, 12);
        if (M === 'merriam+llm' && llmOk) {
          try {
            const arr = await llmJson(`Return a JSON array of synonyms/similar words for "${w}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`);
            if (arr?.length) for (const x of arr) if (!rel.includes(x) && rel.length < 12) rel.push(x);
          } catch (_) {}
        }
        if (rel.length) { patch.related = rel; bump('related', 'ok'); } else bump('related', 'fail');
      } else {
        if (!llmOk) bump('related', 'skip');
        else {
          const arr = await llmJson(`Return a JSON array of synonyms/similar words for "${w}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`);
          if (arr?.length) { patch.related = arr; bump('related', 'ok'); } else bump('related', 'fail');
        }
      }
    } catch (e) { bump('related', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 詞形 ──
  if (need('forms') && (ow('forms') || !ex.forms?.length)) {
    try {
      const M = methods.forms;
      if (M === 'merriam') {
        const f = await mw();
        if (f.forms?.trim()) {
          const arr = [...new Set(String(f.forms).split(/,\s*/).map(x => x.trim()).filter(Boolean))];
          if (arr.length) { patch.forms = arr; bump('forms', 'ok'); } else bump('forms', 'fail');
        } else bump('forms', 'fail');
      } else {
        if (!llmOk) bump('forms', 'skip');
        else {
          const arr = await llmJson(`Return a JSON array of inflections/derivations (past tense, -ing, -s, past participle) for "${w}". Example: ["gets","got","getting"]. Only the JSON array, no markdown.`);
          if (arr?.length) { patch.forms = arr; bump('forms', 'ok'); } else bump('forms', 'fail');
        }
      }
    } catch (e) { bump('forms', 'fail', e); }
  }

  // ── 翻譯→definition ──
  if (need('trans') && (ow('trans') || !ex.definition?.trim())) {
    try {
      const M = methods.trans;
      if (M === 'llm') {
        if (!llmOk) bump('trans', 'skip');
        else {
          const text = await llmText(`Give the Traditional Chinese (繁體中文) definition of the English word "${w}". Concise, one line. Return ONLY the Chinese definition, nothing else.`);
          const t = String(text ?? '').trim().split('\n')[0].trim();
          if (t) { patch.definition = t; bump('trans', 'ok'); } else bump('trans', 'fail');
        }
      } else {
        const data = await camZh();
        const zh = [];
        for (const sense of data.senses || []) {
          const t = (sense.translation || '').trim() || (sense.definition || '').trim();
          if (t && !zh.includes(t)) zh.push(t);
        }
        // DEFSEP1：翻譯一律用全形逗號 join（顯示端只認 [,，] 切 badge；
        // 舊碼 join('\n') 是 U6/U7 翻譯黏連的源頭）。單條內殘留換行也先壓成 ，。
        // AUTOFILL-CONTRACT1：單條內 [;；] 同壓（ant「進行…動作的人；起…作用的人」同例）。
        const text = zh.slice(0, 3).map(t => t.replace(/\s*\n\s*/g, '，').replace(/[;；]/g, '，')).join('，');
        if (text) { patch.definition = text; bump('trans', 'ok'); } else bump('trans', 'fail');
      }
    } catch (e) { bump('trans', 'fail', e); }
  }

  // ── 同義詞 ──
  if (need('syn') && (ow('syn') || !ex.synonym?.trim())) {
    try {
      const M = methods.syn;
      if (M === 'merriam') {
        const f = await mw();
        const fresh = String(f.synonym || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
        if (fresh.length) { patch.synonym = ow('syn') ? fresh.join(', ') : mergeComma(ex.synonym, fresh); bump('syn', 'ok'); } else bump('syn', 'fail');
      } else {
        if (!llmOk) bump('syn', 'skip');
        else {
          const arr = await llmJson(`Return a JSON array of synonyms for "${w}". Example: ["obtain","receive"]. Only the JSON array, no markdown.`);
          if (arr?.length) { patch.synonym = ow('syn') ? [...new Set(arr)].join(', ') : mergeComma(ex.synonym, arr); bump('syn', 'ok'); } else bump('syn', 'fail');
        }
      }
    } catch (e) { bump('syn', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 反義詞 ──
  if (need('ant') && (ow('ant') || !ex.antonym?.trim())) {
    try {
      const M = methods.ant;
      if (M === 'merriam') {
        const f = await mw();
        const fresh = String(f.antonym || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
        if (fresh.length) { patch.antonym = ow('ant') ? fresh.join(', ') : mergeComma(ex.antonym, fresh); bump('ant', 'ok'); } else bump('ant', 'fail');
      } else {
        if (!llmOk) bump('ant', 'skip');
        else {
          const arr = await llmJson(`Return a JSON array of antonyms for "${w}". Example: ["lose","surrender"]. Only the JSON array, no markdown.`);
          if (arr?.length) { patch.antonym = ow('ant') ? [...new Set(arr)].join(', ') : mergeComma(ex.antonym, arr); bump('ant', 'ok'); } else bump('ant', 'fail');
        }
      }
    } catch (e) { bump('ant', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 片語（併入例句；寫回時 phrases 清空，沿用遷移語意）──
  if (need('phrase') && (ow('phrase') || !ex.phrases?.trim())) {
    try {
      const exBase = ow('phrase')
        ? [patch.example, ex.example].filter(Boolean).join('\n')
        : mergeExamplePhrases([patch.example, ex.example].filter(Boolean).join('\n'), ex.phrases);
      const putPhrase = (fresh) => {
        const unique = dedupSentences(exBase, [...new Set(fresh)]);
        if (!unique.length) { bump('phrase', 'fail'); return; }
        patch.example = [exBase, ...unique].filter(Boolean).join('\n');
        patch.phrases = '';
        bump('phrase', 'ok');
      };
      const M = methods.phrase;
      if (M === 'merriam') {
        const f = await mw();
        const fresh = String(f.phrases || '').split('\n').map(x => x.trim()).filter(Boolean);
        if (fresh.length) putPhrase(fresh); else bump('phrase', 'fail');
      } else {
        if (!llmOk) bump('phrase', 'skip');
        else {
          const arr = await llmJson(`Return a JSON array of 3-5 common English phrases or collocations containing the word "${w}". Example: ["take advantage of", "make use of"]. Only the JSON array, no markdown.`);
          if (arr?.length) putPhrase(arr); else bump('phrase', 'fail');
        }
      }
    } catch (e) { bump('phrase', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 字源（韋氏固定；only Merriam provides these）──
  if (need('etymology') && (ow('etymology') || !ex.etymology?.trim())) {
    try {
      const f = await mw();
      if (f.etymology?.trim()) { patch.etymology = f.etymology; bump('etymology', 'ok'); } else bump('etymology', 'fail');
    } catch (e) { bump('etymology', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 音節（韋氏固定；only Merriam provides these）──
  if (need('syllables') && (ow('syllables') || !ex.syllables?.trim())) {
    try {
      const f = await mw();
      if (f.syllables?.trim()) { patch.syllables = f.syllables; bump('syllables', 'ok'); } else bump('syllables', 'fail');
    } catch (e) { bump('syllables', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  // ── 衍生（韋氏固定；組合包不用，批量用）──
  if (need('derivative') && (ow('derivative') || !ex.derivative?.trim())) {
    try {
      const f = await mw();
      if (f.derivative?.trim()) { patch.derivative = f.derivative; bump('derivative', 'ok'); } else bump('derivative', 'fail');
    } catch (e) { bump('derivative', 'fail', e); if (quota(e)) return { patch: null, aborted, abortError, errors, usedRemote }; }
  }

  if (usedRemote) await new Promise(r => setTimeout(r, 400));
  return { patch, aborted, abortError, errors, usedRemote };
}
