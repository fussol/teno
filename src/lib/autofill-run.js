// AUTOFILL3：自動填入共用執行器
//
// 目的：所有自動填入入口（瀏覽器新增/編輯、牌組新增/編輯、各「補一句」鈕）
//   共用同一份實作 —— 吃「設定 → 自動補齊（組合包）」的逐欄來源，跑共用引擎。
//   取代過去三份各自手寫的 chip 排序鏈。
//
// 為什麼是語意等價的替換，不是功能取捨：
//   舊 chip 鏈看似「跨來源 fallback 序列」，但每個 setter 只寫入仍為空的欄位
//   （fSet: `if (!e.value.trim())`）→ 實質語意＝逐欄由鏈上第一個提供它的來源勝出，
//   正是逐欄 methods 的靜態展開。組合包 DEFAULT_METHODS 的註解亦寫「沿用舊行為」。
import { fillWordFields, readComboConfig, DEFAULT_METHODS } from './autofill-engine.js';
import { lookupMerriam, lookupCambridge, fetchLLM } from './api.js';
import { merriamToFields } from './merriam.js';
import { store } from './app-store.js';

/** 共用 fetcher 組（單次 fetch 多欄：各來源結果快取，同欄多分支不重打） */
export function makeComboFetchers(word) {
  let camEn = null, camZh = null, mwCache = null;
  const getCamEn = async () => { if (!camEn) camEn = JSON.parse(await lookupCambridge(word)); return camEn; };
  const getCamZh = async () => { if (!camZh) camZh = JSON.parse(await lookupCambridge(word, 'zh')); return camZh; };
  const getMw = async () => {
    if (!mwCache) mwCache = merriamToFields(JSON.parse(await lookupMerriam(word, store.state.mwDictKey || '', store.state.mwThesKey || '')), word);
    return mwCache;
  };
  const baseUrl = store.state.ollamaUrl || 'http://localhost:11434';
  const model = store.state.ollamaModel || 'qwen2.5-coder:7b';
  const llmText = async (prompt) => fetchLLM(`${baseUrl}/api/generate`, model, prompt);
  const llmJson = async (prompt) => {
    const text = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
    const cleaned = String(text ?? '').trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? [...new Set(arr.map(x => String(x).trim()).filter(Boolean))] : null;
  };
  return { getCamEn, getCamZh, getMw, llmJson, llmText, llmOk: true };
}

/** 某欄在組合包設定裡的來源（未設定／該欄被關 → 回預設） */
export async function comboSourceOf(field) {
  const { methods } = await readComboConfig();
  return methods[field] || DEFAULT_METHODS[field];
}

/**
 * 主入口：依組合包設定補齊整個單字。
 * @param {string} word
 * @param {object} existing 表單現值（契約同各 modal 存檔：related/forms 陣列、其餘字串）
 * @param {{threshold?:number, count?:number}} [opts] 預設 threshold 1／count 1＝沿用舊鏈（只補空缺、單句）
 * @returns {Promise<{patch, aborted, abortError, usedRemote}>}
 */
export async function comboAutoFill(word, existing, opts = {}) {
  const { threshold = 1, count = 1 } = opts;
  const { methods, overwrite } = await readComboConfig();
  return fillWordFields({
    wordText: word, existing, methods, overwrite, threshold, count,
    fetchers: makeComboFetchers(word), onStat: () => {},
  });
}

/**
 * 「補一句例句」鈕用：依組合包設定的例句來源取候選句。
 * 例句來源為韋氏時走片語路（舊鏈語意：韋氏片語即例句候選）。
 * @returns {Promise<{src:string, cands:string[]}>}
 */
export async function comboExampleCandidate(word) {
  const src = await comboSourceOf('example');
  let patch = {};
  try {
    const r = src === 'merriam'
      ? await fillWordFields({ wordText: word, existing: { example: '', phrases: '' }, methods: { phrase: 'merriam' },
          overwrite: {}, threshold: 1, count: 1, fetchers: makeComboFetchers(word), onStat: () => {} })
      : await fillWordFields({ wordText: word, existing: { example: '' }, methods: { example: src },
          overwrite: {}, threshold: 1, count: 1, fetchers: makeComboFetchers(word), onStat: () => {} });
    patch = r.patch || {};
  } catch (_) {}
  const cands = String(patch.example || '').split('\n').map(x => x.trim()).filter(Boolean);
  return { src, cands };
}
