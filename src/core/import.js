// ═══════════════════════════════════════════════════════════════
// Import — Pure CSV parsing, export, and enrichment.
// No window, no DOM, no DB.
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a single CSV line handling quoted fields.
 * Kept for backward compatibility; for multi-line input prefer
 * `tokenizeCSV` which correctly handles embedded newlines.
 * @param {string} str
 * @returns {string[]}
 */
export function parseLine(str) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i], next = str[i + 1];
    if (inQ) {
      if (ch === '"') {
        if (next === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { cols.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

/**
 * Tokenize a full CSV document into rows of cells.
 * Properly handles fields wrapped in double quotes that contain
 * embedded newlines and doubled ("") quote escapes. Normalizes CRLF
 * and a trailing newline.
 * @param {string} text
 * @returns {string[][]}
 */
export function tokenizeCSV(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  let rowStarted = false;

  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], next = s[i + 1];
    if (inQ) {
      if (ch === '"') {
        if (next === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
        rowStarted = true;
      } else if (ch === ',') {
        row.push(cur);
        cur = '';
        rowStarted = true;
      } else if (ch === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
        rowStarted = false;
      } else {
        cur += ch;
        rowStarted = true;
      }
    }
  }
  // Flush the last cell/row if the file didn't end with a newline.
  if (rowStarted || cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** Map of recognized header names → canonical field. */
const FIELD_MAP = {
  // English
  word: 'word', meaning: 'definition', definition: 'definition',
  pos: 'pos', part_of_speech: 'pos',
  pron: 'pron', pronunciation: 'pron',
  example: 'example', synonym: 'synonym', antonym: 'antonym',
  derivative: 'derivative', deck: 'deck', image: 'image',
  examples: 'examples', tags: 'tags', description: 'description',
  related: 'related', forms: 'forms', '相似詞': 'related',
  '詞形變化': 'forms', '相關詞': 'related',
  // Chinese (Era seed data headers)
  '單字': 'word', '單字(w)': 'word',
  '意義': 'definition', '意義(m)': 'definition',
  '發音': 'pron', '發音(p)': 'pron',
  '詞性': 'pos', '詞性(pos)': 'pos',
  '例句': 'example', '例句(e)': 'example',
  '衍生物': 'derivative', '衍生物(der)': 'derivative',
  '相似的': 'synonym', '相似的(sim)': 'synonym',
  '相似詞': 'synonym', '同義詞': 'synonym', 'synonyms': 'synonym',
  '反義詞': 'antonym', '反義詞(a)': 'antonym', 'antonyms': 'antonym',
  '定義': 'definition', '字義': 'definition',
  '影像': 'image', '影像(i)': 'image',
  '字本': 'deck',
  // G21: Chinese aliases for tags / description / examples (FIELD_LABELS 正式標籤 + 常見變體)
  '標記': 'tags', '標籤': 'tags',
  '描述': 'description',
  '例句們': 'examples', '範例': 'examples',
  '字源': 'etymology', '音節': 'syllables', '片語': 'phrases',
  etymology: 'etymology', syllables: 'syllables', phrases: 'phrases',
  // Anki 常見欄位名（notetype 各異：Front/Back、Expression/Meaning…）
  front: 'word', expression: 'word',
  back: 'definition',
  reading: 'pron', sentence: 'example',
  // Single-letter abbrev codes used in the Era seed
  w: 'word', m: 'definition', p: 'pron', e: 'example',
  der: 'derivative', sim: 'synonym', a: 'antonym', i: 'image',
};

/** Canonical fields the importer knows how to populate. */
export const CANONICAL_FIELDS = [
  'word', 'definition', 'pos', 'pron', 'example',
  'synonym', 'antonym', 'derivative', 'deck', 'image', 'description',
  'tags', 'examples',
  'related', 'forms',
  'etymology', 'syllables', 'phrases',
];

/** Human-readable label for each canonical field (zh-TW). */
export const FIELD_LABELS = {
  word: '單字', definition: '定義', pos: '詞性', pron: '發音',
  example: '例句', synonym: '相似詞', antonym: '反義詞',
  derivative: '衍生物', deck: '字本', image: '影像',
  description: '描述', examples: '例句們', tags: '標記',
  related: '相關詞', forms: '詞形變化',
  etymology: '字源', syllables: '音節', phrases: '片語',
};

/**
 * Resolve a raw CSV header to a canonical field name.
 * Tries the full header, then the parenthetical content, then the
 * text before any parenthesis.
 * @param {string} raw
 * @returns {string | null}
 */
export function resolveField(raw) {
  const h = String(raw || '').toLowerCase().trim();
  if (!h) return null;
  if (FIELD_MAP[h]) return FIELD_MAP[h];
  // Try content inside parentheses, e.g. "詞性(POS)" → "pos"
  const m = h.match(/\(([^)]+)\)/);
  if (m) {
    const inner = m[1].trim();
    if (FIELD_MAP[inner]) return FIELD_MAP[inner];
  }
  // Try text before parenthesis, e.g. "詞性(POS)" → "詞性"
  const before = h.split('(')[0].trim();
  if (before && FIELD_MAP[before]) return FIELD_MAP[before];
  return null;
}

/**
 * D-TSV1/D-CSV1: 標頭偵測 — 首列任一格能 resolve（FIELD_MAP／Anki
 * Front-Back-Notes 模式）即視為有標頭；全列無一命中＝無標頭資料列，
 * 不可吃掉。Anki 模式與 import.js 位置回退同形（front→word 等）。
 * @param {string[]} cells
 * @returns {boolean}
 */
export function hasHeaderRow(cells) {
  if (!Array.isArray(cells) || !cells.length) return false;
  return cells.some((c) => {
    const h = String(c || '').trim();
    if (!h) return false;
    if (resolveField(h)) return true;
    if (/^fro?nt$/i.test(h) || /^back$/i.test(h) || /note/i.test(h)) return true;
    return false;
  });
}

/**
 * Parse CSV text into a raw table: header row + data rows.
 * @param {string} text
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function parseCSVTable(text) {
  const all = tokenizeCSV(text);
  if (all.length === 0) return { headers: [], rows: [] };
  const headers = all[0].map(h => h.trim());
  const rows = all.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
  return { headers, rows };
}

/** app 詞性 chip 固定 16 項（browser/deck-browser 編輯器寫死中文）。 */
export const CANONICAL_POS = [
  '名詞', '動詞', '形容詞', '副詞', '介係詞', '連接詞', '代名詞', '感嘆詞',
  '限定詞', '冠詞', '片語', '慣用語', '後綴', '前綴', '縮寫', '複數名詞',
];

/** 英文縮寫/全名（含簡體）→ 中文 chip。key 為小寫去尾點形。 */
const POS_MAP = {
  'n': '名詞', 'noun': '名詞', 'no': '名詞', '名词': '名詞', '名': '名詞',
  'pl': '複數名詞', 'pls': '複數名詞', 'ns': '複數名詞', 'plural noun': '複數名詞', '复数名词': '複數名詞',
  'v': '動詞', 'verb': '動詞', 'vi': '動詞', 'vt': '動詞', '动词': '動詞',
  'adj': '形容詞', 'adjective': '形容詞', '形容词': '形容詞',
  'adv': '副詞', 'adverb': '副詞', 'ad': '副詞', '副词': '副詞',
  'prep': '介係詞', 'preposition': '介係詞', '介系词': '介係詞', '介词': '介係詞',
  'conj': '連接詞', 'conjunction': '連接詞', 'cj': '連接詞', '连接词': '連接詞',
  'pron': '代名詞', 'pronoun': '代名詞', 'pn': '代名詞', '代名词': '代名詞',
  'interj': '感嘆詞', 'interjection': '感嘆詞', 'int': '感嘆詞', 'excl': '感嘆詞', 'exclamation': '感嘆詞', '感叹词': '感嘆詞',
  'det': '限定詞', 'determiner': '限定詞', '限定词': '限定詞',
  'art': '冠詞', 'article': '冠詞', '冠词': '冠詞',
  'phrase': '片語', 'phr': '片語', 'ph': '片語', '片语': '片語',
  'idiom': '慣用語', '惯用语': '慣用語',
  'suffix': '後綴', 'suf': '後綴', 'suff': '後綴', '后缀': '後綴',
  'prefix': '前綴', 'pref': '前綴', '前缀': '前綴',
  'abbr': '縮寫', 'abbrv': '縮寫', 'abbreviation': '縮寫', '缩写': '縮寫',
};

/**
 * 詞性正規化：英文縮寫/全名 → 中文 chip（去重保序，`, ` 連接）。
 * 未知 token 原樣保留（不丟資料）；已是中文 chip 的直接保留。
 * e.g. "adj." → "形容詞", "n./v." → "名詞, 動詞"
 * @param {string} val
 * @returns {string}
 */
export function normalizePos(val) {
  const parts = String(val ?? '').split(/[,，;；/／|、]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (CANONICAL_POS.includes(p)) {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
      continue;
    }
    const key = p.toLowerCase().replace(/\.+$/g, '').trim();
    const mapped = POS_MAP[key] || POS_MAP[p.toLowerCase().trim()];
    const final = mapped || p;
    if (!seen.has(final)) { seen.add(final); out.push(final); }
  }
  return out.join(', ');
}

/**
 * Build word objects from a raw table and a per-column field mapping.
 *
 * @param {string[]} headers - raw header labels (used only for fallback)
 * @param {string[][]} rows - raw cell rows
 * @param {(string|null)[]} fields - canonical field name per column
 *   (use null or '' to skip that column)
 * @param {object} [defaults] - default values, e.g. { deck: 'Frieren' }
 * @returns {object[]}
 */
export function mapWords(headers, rows, fields, defaults = {}) {
  const out = [];
  for (const cols of rows) {
    const w = {
      word: '', definition: '', pos: '', pron: '', example: '',
      synonym: '', antonym: '', derivative: '',
      etymology: '', syllables: '', phrases: '',
      deck: defaults.deck || 'Default',
      image: '', description: '', examples: [], tags: [],
      related: [], forms: [],
    };
    cols.forEach((v, j) => {
      const key = fields[j] || null;
      if (!key || !v) return;
      const val = String(v).trim();
      if (!val) return;
      if (key === 'tags') {
        try { w.tags = JSON.parse(val); } catch { w.tags = val.split(',').map(t => t.trim()).filter(Boolean); }
      } else if (key === 'examples') {
        try { w.examples = JSON.parse(val); } catch { w.examples = val.split(';').map(e => ({ en: e.trim(), zh: '' })); }
      } else if (key === 'word') {
        w.word = val.toLowerCase();
      } else if (key === 'pos') {
        w.pos = normalizePos(val);
      } else if (key === 'related' || key === 'forms') {
        let parsed = null;
        try { parsed = JSON.parse(val); } catch {}
        w[key] = Array.isArray(parsed) ? parsed : val.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        w[key] = val;
      }
    });
    if (w.word) out.push(w);
  }
  return out;
}

/**
 * Parse CSV text into word objects using auto-detected header mapping.
 * (Backward-compatible with the original implementation, but now
 * correctly handles quoted fields that span multiple lines.)
 * @param {string} text - CSV content
 * @returns {object[]}
 */
export function parseCSV(text) {
  const { headers, rows } = parseCSVTable(text);
  if (rows.length === 0) return [];
  const fields = headers.map(h => resolveField(h));
  return mapWords(headers, rows, fields);
}

/**
 * Build CSV string from word array.
 * @param {object[]} words
 * @returns {string}
 */
export function buildCSV(words) {
  const header = ['word', 'definition', 'pos', 'pron', 'example', 'deck', 'image', 'description', 'tags', 'related', 'forms', 'synonym', 'antonym', 'derivative', 'examples', 'etymology', 'syllables', 'phrases'];
  const arrayKeys = new Set(['tags', 'related', 'forms', 'examples']);
  const lines = [header.join(',')];
  for (const w of words) {
    const row = header.map(k => {
      let v = w[k] ?? '';
      if (arrayKeys.has(k) && Array.isArray(v)) v = JSON.stringify(v);
      v = String(v).replace(/"/g, '""');
      if (v.includes(',') || v.includes('"') || v.includes('\n')) v = '"' + v + '"';
      return v;
    });
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

/**
 * Parse Anki-exported tab-separated (TSV) text into raw rows.
 * Anki exports typically have columns: Front, Back, My Notes (optional).
 * Strips UTF-8 BOM and handles HTML entity decoding.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseAnkiTSV(text) {
  const rows = [];
  // Strip BOM
  let s = text.replace(/^\uFEFF/, '');
  // Normalize line endings
  s = s.replace(/\r\n?/g, '\n');
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(trimmed.split('\t'));
  }
  return rows;
}

/**
 * Decode simple HTML entities in a string.
 * @param {string} str
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
  return String(str ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&nbsp;/g, ' ');
}

/**
 * Map Anki TSV rows to word objects.
 * Expects columns: [front, back, notes?]
 * Front = word, Back = definition, Notes (optional) = description
 * @param {string[][]} rows
 * @param {object} [defaults]
 * @returns {object[]}
 */
export function mapAnkiRows(rows, defaults = {}) {
  const out = [];
  for (const cols of rows) {
    const front = (cols[0] || '').trim();
    if (!front) continue;
    const back = decodeHtmlEntities((cols[1] || '').trim().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    const notes = cols[2] ? decodeHtmlEntities(cols[2].trim().replace(/<[^>]+>/g, '')) : '';
    out.push({
      word: front.toLowerCase(),
      definition: back,
      pos: '',
      pron: '',
      example: '',
      synonym: '',
      antonym: '',
      derivative: '',
      etymology: '',
      syllables: '',
      phrases: '',
      deck: defaults.deck || 'Default',
      image: '',
      description: notes,
      examples: [],
      tags: [],
      related: [],
      forms: [],
    });
  }
  return out;
}

/**
 * Enrich a word with data from a dictionary lookup.
 * @param {object} word
 * @param {object[]} dictEntries - Array of { word, definition, pos, ... }
 * @returns {object}
 */
export function enrichWord(word, dictEntries) {
  const match = dictEntries.find(d => d.word === word.word);
  if (!match) return word;
  return {
    ...word,
    definition: match.definition || word.definition || '',
    pos: match.pos || word.pos || '',
    pron: match.pron || word.pron || '',
    example: match.example || word.example || '',
    synonym: match.synonym || word.synonym || '',
    antonym: match.antonym || word.antonym || '',
    derivative: match.derivative || word.derivative || '',
    etymology: match.etymology || word.etymology || '',
    syllables: match.syllables || word.syllables || '',
    phrases: match.phrases || word.phrases || '',
    tags: match.tags || word.tags || [],
    examples: match.examples || word.examples || [],
    image: match.image || word.image || '',
    description: match.description || word.description || '',
    related: match.related || word.related || [],
    forms: match.forms || word.forms || [],
  };
}
