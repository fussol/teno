// verify-d-tsv1-header.mjs — D-TSV1/D-CSV1: headerless first row must not be eaten.
import { hasHeaderRow, parseCSVTable, parseAnkiTSV } from '../src/core/import.js';
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
ok('headerless tsv data', hasHeaderRow(['apple', '蘋果']) === false, 'no cell resolves');
ok('headerless csv data', hasHeaderRow(['apple', '蘋果', 'n.']) === false, 'n. is data not header');
ok('chinese header', hasHeaderRow(['單字', '定義', '詞性']) === true, 'FIELD_MAP hit');
ok('english header', hasHeaderRow(['word', 'definition']) === true, 'canonical hit');
ok('anki header', hasHeaderRow(['Front', 'Back']) === true, 'front/back pattern');
ok('mixed headerless', hasHeaderRow(['hello world', '你好世界']) === false, 'sentences are data');

// ── 分流接線（與 import.js handleFile 同邏輯，不碰 DOM）──
{
  // TSV 無標頭：兩列全保留
  const rows = parseAnkiTSV('apple\t蘋果\nbanana\t香蕉\n');
  const headered = hasHeaderRow(rows[0]);
  const data = (headered ? rows.slice(1) : rows).filter(r => r.some(c => String(c).trim() !== ''));
  ok('tsv headerless keeps 2', !headered && data.length === 2, `${data.length} rows`);
  // TSV 有標頭：首列吃掉
  const rows2 = parseAnkiTSV('Front\tBack\napple\t蘋果\n');
  ok('tsv headed drops header', hasHeaderRow(rows2[0]) && rows2.slice(1).length === 1, 'Front/Back');
  // CSV 無標頭：首列併回
  const t = parseCSVTable('apple,蘋果\nbanana,香蕉\n');
  const t2 = !hasHeaderRow(t.headers)
    ? { headers: t.headers.map((_, i) => `欄${i + 1}`), rows: [t.headers, ...t.rows] }
    : t;
  ok('csv headerless keeps 2', t2.rows.length === 2 && t2.headers[0] === '欄1', t2.rows.length + ' rows');
  // CSV 有標頭：不動
  const t3 = parseCSVTable('單字,定義\napple,蘋果\n');
  ok('csv headed intact', hasHeaderRow(t3.headers) && t3.rows.length === 1, '單字/定義');
}
process.exit(fail ? 1 : 0);
