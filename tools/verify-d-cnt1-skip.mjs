// verify-d-cnt1-skip.mjs — D-CNT1: skip count must split dup vs empty/invalid.
import { mapWords } from '../src/core/import.js';
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
// breakdown mirrors skipBreakdown() in src/pages/import.js (same inputs)
const breakdown = (headers, rows, fields, dbWords) => {
  const all = mapWords(headers, rows, fields, { deck: 'Default' });
  const inDb = new Set(dbWords.map(w => w.toLowerCase()));
  return {
    fresh: all.filter(w => !inDb.has(w.word.toLowerCase())).length,
    dup: all.filter(w => inDb.has(w.word.toLowerCase())).length,
    empty: rows.length - all.length,
  };
};
{
  const h = ['word', 'definition'], f = ['word', 'definition'];
  const rows = [['apple', '蘋果'], ['', ''], ['apple', '蘋果'], ['have', '']];
  // row2 empty-word dropped; row3 in-file dup kept by mapWords (import dedupes later)
  const r = breakdown(h, rows, f, ['have']);
  ok('fresh 2 (apple x2)', r.fresh === 2, `fresh=${r.fresh}`);
  ok('dup 1 (have)', r.dup === 1, `dup=${r.dup}`);
  ok('empty 1 (blank row)', r.empty === 1, `empty=${r.empty}`);
  ok('sums to rows', r.fresh + r.dup + r.empty === rows.length, 'no silent loss');
}
{
  // unmapped-only row produces no word -> empty, not dup
  const r = breakdown(['word'], [['   ']], ['word'], []);
  ok('blank counts empty', r.empty === 1 && r.dup === 0, `e=${r.empty} d=${r.dup}`);
}
// ── UI marker: import.js must not blanket-label all skips as 重複 ──
{
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const s = readFileSync(join(root, 'src/pages/import.js'), 'utf8');
  ok('no blanket 重複 label', !/跳過.*<\/span> 重複/.test(s), 'split dup/empty');
  ok('skipBreakdown wired', s.includes('skipBreakdown'), 'helper present');
}
process.exit(fail ? 1 : 0);

