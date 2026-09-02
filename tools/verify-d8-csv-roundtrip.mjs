#!/usr/bin/env node
// verify-d8-csv-roundtrip.mjs — D8: CLI CSV 匯入匯出與 app 合同脫節（7 欄丟資料、
// pos/pron header 不一致、tags 雙重序列化、大小寫丟、逐行 parse 斷行）。
// 修法＝重用 src/core/import.js 單一真值源（buildCSV/parseCSVTable/resolveField）。
// 全部 tmp DB，嚴禁碰真檔。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// R1#3 補洞：app.csv 用真合同 buildCSV 產出（消手刻转义漂移）＋ export 字节参考值
import { buildCSV } from '../src/core/import.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'tools', 'cli.mjs');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};
const dir = mkdtempSync(join(tmpdir(), 'd8-verify-'));

// 合同 header（app buildCSV src/core/import.js:229 逐字）
const CONTRACT_HEADER = 'word,definition,pos,pron,example,deck,image,description,tags,related,forms,synonym,antonym,derivative,examples';
const OLD_HEADER = 'word,definition,part_of_speech,pronunciation,example,deck,tags';
const D8_MARK = '// D8: CSV 合同對齊';
// 負控制重建：區段起訖錨（修法後源碼）
const SEC_START = 'function cmdExportCsv()';
const SEC_END = '// ═══════════════ 評分 / 模擬 ═══════════════';
// 舊版三函式本體（2026-08-28 repo 逐字，負控制反換用）
const ORIGINAL_BLOCK = `function cmdExportCsv() {
  const out = args[0] || \`\${HOME}/影片/teno-export-\${new Date().toISOString().slice(0,10)}.csv\`;
  const rows = db.prepare('SELECT word, definition, part_of_speech, pronunciation, example, deck, tags FROM words ORDER BY word').all();
  const esc = (s) => {
    s = String(s ?? '');
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = '${OLD_HEADER}';
  const body = rows.map(r => [r.word, r.definition, r.part_of_speech, r.pronunciation, r.example, r.deck, r.tags].map(esc).join(',')).join('\\n');
  writeFileSync(out, head + '\\n' + body);
  log('READ', \`export-csv \${rows.length} 筆 → \${out}\`);
  console.log(\`已匯出 \${rows.length} 筆 → \${out}\`);
}

function cmdImportCsv() {
  const file = args[0];
  if (!file) return console.log('需 CSV 路徑 (欄位: word,definition,part_of_speech,pronunciation,example,deck,tags)');
  if (!existsSync(file)) return console.log('檔案不存在');
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\\r?\\n/).filter(l => l.trim());
  const header = lines[0].split(',').map(h => h.trim());
  backupDb();
  const w = dbw();
  let added = 0, skipped = 0;
  const existing = new Set(db.prepare('SELECT lower(word) w FROM words').all().map(x => x.w));
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const obj = {};
    header.forEach((h, i) => obj[h] = cells[i] ?? '');
    const wd = (obj.word || '').trim().toLowerCase();
    if (!wd || existing.has(wd)) { skipped++; continue; }
    existing.add(wd);
    const id = nextWordId();
    w.prepare(\`INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, related, forms, synonym, antonym, derivative, examples, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)\`).run(
      id, wd, obj.definition || '', obj.part_of_speech || '', obj.pronunciation || '',
      obj.example || '', obj.deck || 'Default', JSON.stringify((obj.tags || '').split(',').map(s => s.trim()).filter(Boolean)),
      '', '', '[]', '[]', '', '', '', '[]', new Date().toISOString());   // E2: created_at ISO 帶 Z
    added++;
  }
  w.close();
  log('WRITE', \`import-csv \${file}: 新增 \${added}, 跳過 \${skipped}\`);
  audit('import-csv', \`匯入 CSV \${args[0] || ''}\`);
  console.log(\`匯入完成: 新增 \${added}, 跳過重複 \${skipped}\`);
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

`;

const SCHEMA = `
  CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, definition TEXT,
    part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT NOT NULL DEFAULT 'Default',
    tags TEXT DEFAULT '', image TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
    description TEXT DEFAULT '', related TEXT DEFAULT '[]', forms TEXT DEFAULT '[]',
    synonym TEXT NOT NULL DEFAULT '', antonym TEXT NOT NULL DEFAULT '',
    derivative TEXT NOT NULL DEFAULT '', examples TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL,
    elapsed_days INTEGER, scheduled_days INTEGER, reps INTEGER, lapses INTEGER, state INTEGER,
    last_review TEXT, buried INTEGER, suspended INTEGER, step INTEGER, mc_data TEXT, spell_data TEXT);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER,
    elapsed_days INTEGER, scheduled_days INTEGER, stability REAL, difficulty REAL,
    reviewed_at TEXT, duration INTEGER, mode TEXT, card_state INTEGER, new_state INTEGER);`;

function mkDb(p) { const d = new DatabaseSync(p); d.exec(SCHEMA); d.close(); return p; }
function runCli(cliPath, argv, dbPath, noBak = '1') {
  return spawnSync('node', [cliPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: noBak, TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
const BIZ_COLS = ['word','definition','part_of_speech','pronunciation','example','deck','tags','image','description','related','forms','synonym','antonym','derivative','examples'];
const rowsOf = (p) => new DatabaseSync(p, { readOnly: true }).prepare(`SELECT ${BIZ_COLS.join(',')} FROM words ORDER BY lower(word)`).all();
const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// R1#3：JSON 陣列欄比對先 parse 正規化（import 端 canonical 化，非 canonical 測資不被誤判）
const JSON_COLS = new Set(['tags','related','forms','examples']);
const norm = (c, v) => { if (!JSON_COLS.has(c)) return String(v ?? ''); try { return JSON.stringify(JSON.parse(v)); } catch { return String(v ?? ''); } };

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(D8_MARK);

  // fixture 資料（15 業務欄全非空；引號/逗號/換行/中文/多元素陣列）
  const FIX = {
    id: 'w1', word: 'Apple', definition: 'a "red", fruit\n第二行', part_of_speech: 'n.',
    pronunciation: '/ˈæp.əl/', example: 'An apple a day.', deck: 'Fruit',
    tags: '["food","red"]', image: 'img/a.png', description: '苹果，常见水果',
    related: '["pear"]', forms: '["apples"]', synonym: 'pome', antonym: 'none',
    derivative: 'applet', examples: '[{"en":"An apple a day.","zh":"每日一果"}]',
  };
  const FIX2 = { id: 'w2', word: 'banana', definition: 'yellow fruit', part_of_speech: 'n.',
    pronunciation: '/bəˈnɑːnə/', example: '', deck: 'Fruit', tags: '[]', image: '',
    description: '', related: '[]', forms: '[]', synonym: '', antonym: '', derivative: '', examples: '[]' };
  // FIX3：逗號 definition（驗 quote-esc）＋多元素 tags，但無換行 →
  // 雙序列化指紋測資必須免換行（舊版逐行斷行會位移欄位、指紋不穩）
  const FIX3 = { id: 'w3', word: 'Cherry', definition: 'sweet, red fruit', part_of_speech: 'noun',
    pronunciation: '/ˈtʃɛr.i/', example: 'sweet, juicy', deck: 'Fruit',
    tags: '["fruit","red"]', image: '', description: '核果', related: '["plum"]',
    forms: '["cherries"]', synonym: 'drupe', antonym: '', derivative: '', examples: '[]' };
  // FIX4（R1#3 mutD 補洞）：非 canonical JSON（空格/鍵序）→ 對稱損壞變異在
  // export 字節釘（T1e）無所遁形：不 parse 直傳 buildCSV 會輸出原字節≠參考正規化輸出
  const FIX4 = { id: 'w4', word: 'date', definition: 'dried sweet fruit', part_of_speech: 'n.',
    pronunciation: '', example: '', deck: 'Dried',
    tags: '["b",  "a"]', image: '', description: '', related: '[ "x" , "y" ]',
    forms: '[]', synonym: '', antonym: '', derivative: '', examples: '[{"zh":"甲","en":"A"}]' };
  const FIXES = [FIX, FIX2, FIX3, FIX4];

  console.log('T1 round-trip 主牙：15 欄全等＋大小寫保留');
  const db1 = mkDb(join(dir, 'src1.db'));
  {
    const d = new DatabaseSync(db1);
    for (const f of FIXES) d.prepare(`INSERT INTO words (${BIZ_COLS.join(',')}) VALUES (${BIZ_COLS.map(() => '?').join(',')})`)
      .run(...BIZ_COLS.map(c => f[c]));
    d.close();
  }
  const csv1 = join(dir, 'out1.csv');
  const r1 = runCli(CLI, ['export-csv', csv1], db1);
  const csvText = exists(csv1) ? readFileSync(csv1, 'utf8') : '';
  T('T1a export CSV header＝合同 15 列', csvText.split('\n')[0] === CONTRACT_HEADER, csvText.split('\n')[0]);
  // T1e（R1#3 mutD 補洞）：export 全檔字節＝buildCSV(canonical 映射) 參考值
  // （行序與 DB ORDER BY word BINARY 一致；容忍結尾換行）
  const refRows = [...FIXES].sort((a, b) => a.word < b.word ? -1 : a.word > b.word ? 1 : 0)
    .map(f => ({ word: f.word, definition: f.definition, pos: f.part_of_speech, pron: f.pronunciation,
      example: f.example, deck: f.deck, image: f.image, description: f.description,
      tags: JSON.parse(f.tags), related: JSON.parse(f.related), forms: JSON.parse(f.forms),
      synonym: f.synonym, antonym: f.antonym, derivative: f.derivative, examples: JSON.parse(f.examples) }));
  const refCsv = buildCSV(refRows);
  T('T1e export 字節＝buildCSV 參考（非 canonical 測資防對稱損壞）',
    csvText === refCsv || csvText === refCsv + '\n',
    csvText && `len ${csvText.length} vs ref ${refCsv.length}`);
  const db2 = mkDb(join(dir, 'dst1.db'));
  runCli(CLI, ['import-csv', csv1], db2);
  const got = rowsOf(db2);
  const want = [...FIXES].sort((a, b) => a.word.toLowerCase() < b.word.toLowerCase() ? -1 : 1)
    .map(f => Object.fromEntries(BIZ_COLS.map(c => [c, f[c]])));
  T('T1b 匯入筆數＝4', got.length === 4, String(got.length));
  let mismatch = [];
  for (let i = 0; i < Math.min(got.length, want.length); i++) {
    for (const c of BIZ_COLS) if (norm(c, got[i][c]) !== norm(c, want[i][c])) mismatch.push(`${want[i].word}.${c}: ${JSON.stringify(got[i][c])}≠${JSON.stringify(want[i][c])}`);
  }
  T('T1c 15 欄逐欄全等（JSON 欄 parse 正規化；含換行/引號/中文/非 canonical）', mismatch.length === 0, mismatch.slice(0, 4).join(' | '));
  T('T1d word 大小寫保留（Apple≠apple）', got.some(r => r.word === 'Apple'));

  console.log('T2 app 格式寬容（真 buildCSV 產 CSV → CLI import）');
  const appCsv = join(dir, 'app.csv');
  // R1#3 阻斷洞修復：app.csv 逐字用真合同 buildCSV 產出（手刻转义曾非法致 T2c 永紅）
  writeFileSync(appCsv, buildCSV([{ word: 'cherry', definition: 'a stone fruit', pos: 'n.', pron: '/ˈtʃɛr.i/',
    example: 'sweet cherry', deck: 'Fruit', image: '', description: '', tags: ['red'], related: ['plum'],
    forms: ['cherries'], synonym: '', antonym: '', derivative: '', examples: [] }]));
  const db3 = mkDb(join(dir, 'dst2.db'));
  runCli(CLI, ['import-csv', appCsv], db3);
  const r3 = rowsOf(db3)[0] || {};
  T('T2a pos 落庫 part_of_speech', r3.part_of_speech === 'n.', JSON.stringify(r3.part_of_speech));
  T('T2b pron 落庫 pronunciation', r3.pronunciation === '/ˈtʃɛr.i/', JSON.stringify(r3.pronunciation));
  T('T2c tags JSON 陣列完好', r3.tags === '["red"]', JSON.stringify(r3.tags));
  // T2f/g（R1#2）：裸文字陣列欄 fallback 三規格（鏡像 mapWords:191/193/196-199）
  const tolCsv = join(dir, 'tol.csv');
  writeFileSync(tolCsv, 'word,deck,tags,examples,related\nTolerance,T,"red, blue",e1; e2,"x, y"');
  const db5 = mkDb(join(dir, 'dst4.db'));
  runCli(CLI, ['import-csv', tolCsv], db5);
  const r5 = rowsOf(db5)[0] || {};
  T('T2f tags 裸文字 fallback＝split(,)', r5.tags === '["red","blue"]', JSON.stringify(r5.tags));
  T('T2g examples 裸文字 fallback＝split(;) 產 {en,zh}', r5.examples === '[{"en":"e1","zh":""},{"en":"e2","zh":""}]', JSON.stringify(r5.examples));
  T('T2h related 裸文字 fallback（isArray 守衛後 split）', r5.related === '["x","y"]', JSON.stringify(r5.related));

  console.log('T3 tags 雙序列化封堵（精準值斷言，免換行测資 Cherry）');
  const cherry = got.find(r => r.word === 'Cherry');
  T('T3a tags 多元素 round-trip 精確＝["fruit","red"]', cherry?.tags === '["fruit","red"]', JSON.stringify(cherry?.tags));

  console.log('T4 回歸釘');
  const dupOut = runCli(CLI, ['import-csv', csv1], db2).stdout;
  T('T4a 重複匯入全跳過（新增 0）', /新增 0/.test(dupOut), dupOut.trim().split('\n').slice(-3).join(' / '));
  const junk = join(dir, 'junk.csv');
  writeFileSync(junk, CONTRACT_HEADER + '\n,no word here,n.,,,,,,,,,,,'  );
  const db4 = mkDb(join(dir, 'dst3.db'));
  runCli(CLI, ['import-csv', junk], db4);
  T('T4b 無 word 列跳過', rowsOf(db4).length === 0);
  const emptyTags = got.find(r => r.word === 'banana');
  T('T4c 空 tags round-trip＝[]', emptyTags?.tags === '[]', JSON.stringify(emptyTags?.tags));

  console.log('T5 負控制：舊版三函式反換 → 三損壞模式精準重現');
  const start = src.indexOf(SEC_START);
  const end = src.indexOf(SEC_END);
  let buggySrc;
  if (fixed) {
    // 修法在場：剝 D8 區段（export 起 → 評分 section 前，含 parseCsvLine 刪除處）還原舊塊
    buggySrc = src.slice(0, start) + ORIGINAL_BLOCK + src.slice(end);
  } else {
    buggySrc = src; // 工作區即原版
  }
  T('T5a 負控制源碼含舊 header', buggySrc.includes(OLD_HEADER) && !buggySrc.includes(CONTRACT_HEADER));
  const bugDir = join(dir, 'bugsub'); mkdirSync(bugDir);
  symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
  writeFileSync(join(bugDir, 'cli.mjs'), buggySrc);
  const dbB = mkDb(join(dir, 'bug.db'));
  {
    const d = new DatabaseSync(dbB);
    for (const f of FIXES) d.prepare(`INSERT INTO words (${BIZ_COLS.join(',')}) VALUES (${BIZ_COLS.map(() => '?').join(',')})`).run(...BIZ_COLS.map(c => f[c]));
    d.close();
  }
  const csvB = join(dir, 'bug.csv');
  runCli(join(bugDir, 'cli.mjs'), ['export-csv', csvB], dbB);
  const bugText = readFileSync(csvB, 'utf8');
  T('T5b 負控制 export＝舊 7 欄 header（8 欄丟失重現）', bugText.split('\n')[0] === OLD_HEADER);
  const dbB2 = mkDb(join(dir, 'bugdst.db'));
  runCli(join(bugDir, 'cli.mjs'), ['import-csv', csvB], dbB2);
  const bCherry = rowsOf(dbB2).find(r => r.word.toLowerCase() === 'cherry');
  T('T5c 負控制 tags 雙序列化指紋重現（Cherry 免換行测資）',
    String(bCherry?.tags || '') !== '["fruit","red"]' && String(bCherry?.tags || '').includes('\\"'), JSON.stringify(bCherry?.tags));
  const bApp = rowsOf(dbB2).find(r => r.word === 'apple');
  T('T5d 負控制 description/related 全丟', bApp?.description === '' && bApp?.related === '[]', JSON.stringify([bApp?.description, bApp?.related]));
  // app 格式 CSV 在舊版：pos/pron 丟
  const dbB3 = mkDb(join(dir, 'bugdst2.db'));
  runCli(join(bugDir, 'cli.mjs'), ['import-csv', appCsv], dbB3);
  const bRow = rowsOf(dbB3)[0] || {};
  T('T5e 負控制 app-CSV pos/pron 丟光', bRow.part_of_speech === '' && bRow.pronunciation === '', JSON.stringify([bRow.part_of_speech, bRow.pronunciation]));

  console.log('T6 保留釘：D8 區段源碼級（R1#2——驗證跑 TENO_NO_BACKUP=1 測不到漏呼叫，故源碼釘）');
  {
    const s0 = src.indexOf(SEC_START), s1 = src.indexOf(SEC_END);
    const sec = (s0 >= 0 && s1 > s0) ? src.slice(s0, s1) : '';
    T('T6a cmdImportCsv 保留 backupDb() 呼叫', sec.includes('backupDb()'));
    T('T6b 保留 audit(\'import-csv\' 記錄', sec.includes("audit('import-csv'"));
    T('T6c 保留 stdout 契约「已匯出 ${...} 筆 → ${out}」', /\$`?已匯出 \$\{[^}]+\} 筆 → \$\{out\}/.test(sec.replace(/\\\$\{/g, '${')) || sec.includes('已匯出') && sec.includes('筆 → '));
    T('T6d 保留 stdout 契约「匯入完成: 新增…, 跳過重複…」', sec.includes('匯入完成: 新增') && sec.includes('跳過重複'));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function exists(p) { try { readFileSync(p); return true; } catch { return false; } }

console.log(`\n═══ verify-d8: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
