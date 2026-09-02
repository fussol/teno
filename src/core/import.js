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
  '反義詞': 'antonym', '反義詞(a)': 'antonym',
  '影像': 'image', '影像(i)': 'image',
  '字本': 'deck',
  // G21: Chinese aliases for tags / description / examples (FIELD_LABELS 正式標籤 + 常見變體)
  '標記': 'tags', '標籤': 'tags',
  '描述': 'description',
  '例句們': 'examples', '範例': 'examples',
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
];

/** Human-readable label for each canonical field (zh-TW). */
export const FIELD_LABELS = {
  word: '單字', definition: '定義', pos: '詞性', pron: '發音',
  example: '例句', synonym: '相似詞', antonym: '反義詞',
  derivative: '衍生物', deck: '字本', image: '影像',
  description: '描述', examples: '例句們', tags: '標記',
  related: '相關詞', forms: '詞形變化',
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
  const header = ['word', 'definition', 'pos', 'pron', 'example', 'deck', 'image', 'description', 'tags', 'related', 'forms', 'synonym', 'antonym', 'derivative', 'examples'];
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
    tags: match.tags || word.tags || [],
    examples: match.examples || word.examples || [],
    image: match.image || word.image || '',
    description: match.description || word.description || '',
    related: match.related || word.related || [],
    forms: match.forms || word.forms || [],
  };
}
