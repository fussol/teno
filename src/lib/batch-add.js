// batch-add.js — BATCHADD1 批量新增純函式（node-safe，無 DOM、無 DB）
// 輸入像筆記本一樣的一大坨字：apply,rent, remember, pay, touch, torch,...
// 以 [,，、\n;；] 切分，lowercase，去重，合法性檢查（英文單字：字母開頭，允許 ' - 空格）。
// partitionBatch(tokens, words)：分出已存在 vs 未存入（比對 w.word lowercased trim）。

const WORD_RE = /^[a-z][a-z' \-]*$/;

/**
 * @param {string} text 使用者貼的一大坨
 * @returns {{tokens: string[], invalid: string[]}} tokens=合法去重小寫；invalid=非法去重原文（最多回傳，不寫庫）
 */
export function parseBatchInput(text) {
  const raw = String(text ?? '').split(/[,，、\n;；]+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set(), badSeen = new Set();
  const tokens = [], invalid = [];
  for (const tok of raw) {
    const norm = tok.toLowerCase();
    if (WORD_RE.test(norm)) {
      if (!seen.has(norm)) { seen.add(norm); tokens.push(norm); }
    } else {
      if (!badSeen.has(tok)) { badSeen.add(tok); invalid.push(tok); }
    }
  }
  return { tokens, invalid };
}

/**
 * @param {string[]} tokens parseBatchInput 的 tokens
 * @param {Array<{id:string, word:string, deck:string}>} words s.state.words
 * @returns {{existing: Array, fresh: string[]}}
 */
export function partitionBatch(tokens, words) {
  const idx = new Map();
  for (const w of words || []) {
    const k = String(w?.word || '').toLowerCase().trim();
    if (k && !idx.has(k)) idx.set(k, w);
  }
  const existing = [], fresh = [];
  for (const t of tokens || []) {
    const hit = idx.get(t);
    if (hit) existing.push(hit);
    else fresh.push(t);
  }
  return { existing, fresh };
}
