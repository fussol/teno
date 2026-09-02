// G21 驗證工具 — CANONICAL_FIELDS 缺 tags/examples、FIELD_MAP 缺中文標記
// 直接 import 真源碼（src/core/import.js 為純模組，零 DOM/DB 依賴）。
// 負控制：讀源碼剝除 G21 新增行 → tmp mjs → import → bug 必須精準重現。
// 全程不修改任何源碼；node tools/verify-g21-import-fields.mjs 執行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/core/import.js');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

const M = await import(SRC);
const { resolveField, CANONICAL_FIELDS, FIELD_LABELS, parseCSV, buildCSV } = M;

// ---------- T1 resolveField：中文新鍵 + 英文不回歸 ----------
console.log('T1 resolveField 中文標記/描述/例句 與英文回歸');
assert(resolveField('標記') === 'tags', "resolveField('標記') === 'tags'");
assert(resolveField('標籤') === 'tags', "resolveField('標籤') === 'tags'");
assert(resolveField('描述') === 'description', "resolveField('描述') === 'description'");
assert(resolveField('例句們') === 'examples', "resolveField('例句們') === 'examples'");
assert(resolveField('範例') === 'examples', "resolveField('範例') === 'examples'");
assert(resolveField('tags') === 'tags', "resolveField('tags') === 'tags'（英文不回歸）");
assert(resolveField('examples') === 'examples', "resolveField('examples') === 'examples'（英文不回歸）");
assert(resolveField('description') === 'description', "resolveField('description')（英文不回歸）");
assert(resolveField('單字') === 'word', "resolveField('單字') === 'word'（既有中文鍵不回歸）");
assert(resolveField('詞性(POS)') === 'pos', "括號路徑 '詞性(POS)' === 'pos' 不回歸");
assert(resolveField('意義(m)') === 'definition', "'意義(m)' 前綴路徑不回歸");
assert(resolveField('') === null && resolveField('乱七八糟') === null, '空/未知欄位仍 null');
// 每個映射值都必须是合法 canonical 欄
const NEW_TARGETS = ['tags', 'examples', 'description'];
assert(NEW_TARGETS.every(f => CANONICAL_FIELDS.includes(f)),
  '新解析目標全在 CANONICAL_FIELDS（下拉可選到）');

// ---------- T2 CANONICAL_FIELDS 完整性 ----------
console.log('T2 CANONICAL_FIELDS');
assert(CANONICAL_FIELDS.includes('tags'), "含 'tags'");
assert(CANONICAL_FIELDS.includes('examples'), "含 'examples'");
for (const f of ['word', 'definition', 'pos', 'pron', 'example', 'synonym',
  'antonym', 'derivative', 'deck', 'image', 'description', 'related', 'forms']) {
  assert(CANONICAL_FIELDS.includes(f), `原有欄 '${f}' 不遺失`);
}
assert(new Set(CANONICAL_FIELDS).size === CANONICAL_FIELDS.length, '無重複欄位');

// ---------- T3 FIELD_LABELS 覆蓋（pages/import.js:107 直接取用，防 undefined） ----------
console.log('T3 FIELD_LABELS 覆蓋');
for (const f of CANONICAL_FIELDS) {
  assert(typeof FIELD_LABELS[f] === 'string' && FIELD_LABELS[f].length > 0,
    `FIELD_LABELS['${f}'] 存在`);
}

// ---------- T4 中文標頭 CSV round-trip（實測解析落地） ----------
console.log('T4 中文標頭 CSV → parseCSV');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g21-'));
// CSV 引號規則：含逗號/引號的欄位必須外加 "" 包裹、內文 " 加倍
const csvQ = v => '"' + String(v).replace(/"/g, '""') + '"';
const csvCN = [
  '單字,意義,標記,描述,例句們',
  'apple,蘋果,"[""fruit"",""red""]",一種水果,' + csvQ(JSON.stringify([{ en: 'An apple a day.', zh: '一天一蘋果。' }])),
  'banana,香蕉,"[""fruit""]",黃色水果長條,' + csvQ(JSON.stringify([{ en: 'Bananas are yellow.', zh: '香蕉是黃的。' }])),
].join('\n');
const csvPath = path.join(tmpDir, 'cn.csv');
fs.writeFileSync(csvPath, csvCN, 'utf8');
const wordsCN = parseCSV(fs.readFileSync(csvPath, 'utf8'));
assert(wordsCN.length === 2, '解析出 2 筆');
assert(wordsCN[0].word === 'apple' && wordsCN[0].definition === '蘋果', 'word/definition 正確');
assert(Array.isArray(wordsCN[0].tags) && wordsCN[0].tags.join(',') === 'fruit,red',
  `標記欄 → tags 陣列（實際 ${JSON.stringify(wordsCN[0].tags)}）`);
assert(wordsCN[0].description === '一種水果', `描述欄 → description（實際 '${wordsCN[0].description}'）`);
assert(Array.isArray(wordsCN[0].examples) && wordsCN[0].examples[0]?.en === 'An apple a day.',
  '例句們欄 → examples 陣列');
assert(wordsCN[1].tags.join(',') === 'fruit', '第二筆 tags 正確');

// ---------- T5 buildCSV → parseCSV 英文 round-trip ----------
console.log('T5 buildCSV→parseCSV round-trip');
const src1 = [{
  word: 'test', definition: '測試', pos: 'n.', pron: '/tɛst/', example: '',
  synonym: '', antonym: '', derivative: '', deck: 'Default', image: '',
  description: '描述文字', tags: ['a', 'b'], examples: [{ en: 'x', zh: 'Y' }],
  related: ['r1'], forms: ['tested'],
}];
const rt = parseCSV(buildCSV(src1));
assert(rt.length === 1, 'round-trip 1 筆');
assert(rt[0].tags.join(',') === 'a,b', `tags 回還（實際 ${JSON.stringify(rt[0].tags)}）`);
assert(rt[0].examples[0]?.en === 'x' && rt[0].examples[0]?.zh === 'Y', 'examples 回還');
assert(rt[0].related.join(',') === 'r1' && rt[0].forms.join(',') === 'tested', 'related/forms 回還（D1 不回歸）');
assert(rt[0].description === '描述文字', 'description 回還');

// ---------- T6 負控制：剝除 G21 新增行 → bug 精準重現 ----------
console.log('T6 負控制（剝除修法 → bug 必須再現）');
let buggy = fs.readFileSync(SRC, 'utf8');
const before = buggy;
buggy = buggy
  .replace(/^[ \t]*'標記': 'tags',.*\n/m, '')
  .replace(/^[ \t]*'標籤': 'tags',.*\n/m, '')
  .replace(/^[ \t]*'描述': 'description',.*\n/m, '')
  .replace(/^[ \t]*'例句們': 'examples',.*\n/m, '')
  .replace(/^[ \t]*'範例': 'examples',.*\n/m, '')
  .replace(/^[ \t]*'tags', 'examples',\n/m, '');
if (buggy === before) throw new Error('[harness] 負控制剝除失敗：源碼找不到 G21 新增行（修法未套用？）');
const bugPath = path.join(tmpDir, 'import-buggy.mjs');
fs.writeFileSync(bugPath, buggy, 'utf8');
const B = await import('file://' + bugPath);
assert(B.resolveField('標記') === null, '負控制：剝除後 resolveField(標記) 回 null（bug 再現）');
assert(B.resolveField('描述') === null, '負控制：剝除後 resolveField(描述) 回 null');
assert(B.resolveField('例句們') === null, '負控制：剝除後 resolveField(例句們) 回 null');
assert(!B.CANONICAL_FIELDS.includes('tags') && !B.CANONICAL_FIELDS.includes('examples'),
  '負控制：剝除後 CANONICAL_FIELDS 缺 tags/examples（下拉 bug 再現）');
assert(B.resolveField('單字') === 'word' && B.resolveField('tags') === 'tags',
  '負控制：既有鍵仍活（證明只剝除新增行，測試差異归因 G21）');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n結果: ${passed}/${passed + failed} PASS` + (failed ? ' ❌ FAIL' : ' ✅ ALL PASS'));
process.exit(failed ? 1 : 0);
