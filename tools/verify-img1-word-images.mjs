// verify-img1-word-images.mjs — IMG1 單字圖片上線 雙態 harness
// 用法: node tools/verify-img1-word-images.mjs
// 期望: 修法後全部 PASS（exit 0）；修法前加權腿必 FAIL → exit 1（fail-closed）
// ═══════════════════════════════════════════════════════════════
//  設計依據: IMG1-word-images-plan.md v1.1（2026-09-07）
//  - word_images 表（migration v12——v11 已定案歸 DW1，R3 席裁決；lib.rs）：
//    id/word_id/filename/data/created_at
//  - db.js CRUD: getImagesForWord / getImagesForWords / addWordImage /
//    deleteWordImage / deleteWordImagesForWord
//  - src/lib/word-image.js: renderImageCarousel / hydrateImages / renderEditorThumbs
//  - store.deleteWord 補手動刪圖（FK off 實錘 → CASCADE 不生效）
// fail-closed 設計:
//  T1-T2/T4-T5 從「真實 lib.rs」抽 v11 migration SQL 跑 node:sqlite
//     → 修法前 lib.rs 無 v11 → 抽取腿必紅（不是測自製 SQL，是測真檔）
//  T3/T6 動態 import src/lib/word-image.js → 修法前模組不存在 → clean FAIL
//  T7 static pin db.js 五個 export → 修法前必紅
//  T8 static pin store.deleteWord 刪圖行 → 修法前必紅
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const fails = [];
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; fails.push(msg); console.log('  FAIL:', msg); }
}

// ── T1/T2/T4/T5：從真實 lib.rs 抽 migration v12 SQL（修法前必抽不到；R3 席核正 12 非 11）──
// 注意：Migration struct 內 version 前可能有行註解 → 用 [^{}]* 跨註解、不跨 struct 大括號
const LIBRS = readFileSync(join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');
const v11 = /Migration\s*\{[^{}]*version:\s*12,[^{}]*kind:\s*MigrationKind::Up,/.exec(LIBRS);
const v11sql = v11 ? v11[0].match(/sql:\s*"([\s\S]*?)",/)?.[1] : null;

// R3 席加碼：版號唯一性自檢腿（搶號本身變可測病徵）
// 限縮主 migrations vec——log_migrations（隔離 DB，lib.rs:1822 起）是另一個
// Migrator，版本序列獨立從 1 起，兩 vec 各自重複不算搶號
{
  const mainVec = LIBRS.slice(0, LIBRS.indexOf('log_migrations'));
  const vers = [...mainVec.matchAll(/version:\s*(\d+),/g)].map(m => +m[1]);
  const dup = vers.filter((v, i) => vers.indexOf(v) !== i);
  assert(dup.length === 0, `T0 主 migrations vec 版號重複: ${dup.join(',')}（sqlx 會靜默跳過第二條）`);
}

console.log('── T1 schema（migration v12 從真實 lib.rs 抽取）──');
let sq = null, dbPath = null;
if (v11sql) {
  assert(v11sql.includes('CREATE TABLE IF NOT EXISTS word_images'), 'T1a v11 含 word_images CREATE');
  assert(v11sql.includes('word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE'), 'T1b word_id FK REFERENCES words(id)');
  assert(v11sql.includes('CREATE INDEX IF NOT EXISTS idx_word_images_word'), 'T1c 含 word_id index');
  // runtime：建臨時 DB，先建 words（模擬既有 schema）再跑 v11 SQL
  const dir = mkdtempSync(join(tmpdir(), 'img1-'));
  dbPath = join(dir, 't.db');
  sq = new DatabaseSync(dbPath);
  sq.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, deck TEXT DEFAULT 'Default', image TEXT DEFAULT '')`);
  try {
    // SQL 內的 strftime/now 是 SQLite 原生 → node:sqlite 可直接跑；多語句用 exec
    // （migration sql 欄含 "..." 雙引號字串 → 以 raw 執行）
    for (const stmt of splitSql(v11sql)) sq.exec(stmt);
    const t = sq.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='word_images'").get();
    assert(t.c === 1, 'T1d runtime：v11 跑完 word_images 表存在');
    const ix = sq.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='idx_word_images_word'").get();
    assert(ix.c === 1, 'T1e runtime：idx_word_images_word index 存在');
  } catch (e) {
    assert(false, `T1 runtime v11 執行炸: ${e.message}`);
  }
} else {
  assert(false, 'T1 lib.rs 無 migration v11（修法前病徵：word_images migration 不存在）');
  // PRE 態仍建最小 DB 供後續腿跑（全紅路径）
  const dir = mkdtempSync(join(tmpdir(), 'img1-'));
  dbPath = join(dir, 't.db');
  sq = new DatabaseSync(dbPath);
  sq.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, deck TEXT DEFAULT 'Default', image TEXT DEFAULT '')`);
}

// ── T2 CRUD（node:sqlite runtime，模擬 db.js 五函式的 SQL 語意）──
console.log('── T2 CRUD 往返 ──');
try {
  sq.prepare("INSERT INTO words (id, word) VALUES ('w1', 'apple')").run();
  // addWordImage
  sq.prepare('INSERT INTO word_images (word_id, filename, data) VALUES (?,?,?)').run('w1', 'apple1.png', 'data:image/png;base64,AAA');
  sq.prepare('INSERT INTO word_images (word_id, filename, data) VALUES (?,?,?)').run('w1', 'apple2.png', 'data:image/png;base64,BBB');
  sq.prepare('INSERT INTO word_images (word_id, filename, data) VALUES (?,?,?)').run('w1', 'apple3.png', 'data:image/png;base64,CCC');
  // getImagesForWord（ORDER BY id）
  const rows = sq.prepare('SELECT filename, data FROM word_images WHERE word_id=? ORDER BY id').all('w1');
  assert(rows.length === 3 && rows[0].filename === 'apple1.png' && rows[2].filename === 'apple3.png',
    `T2a getImagesForWord 依 id 序：got ${rows.length} 張 [${rows.map(r=>r.filename).join(',')}]`);
  // deleteWordImagesForWord
  sq.prepare('DELETE FROM word_images WHERE word_id=?').run('w1');
  const after = sq.prepare('SELECT COUNT(*) c FROM word_images WHERE word_id=?').get('w1');
  assert(after.c === 0, 'T2b deleteWordImagesForWord 清空');
  // 刪字連刪圖（store.deleteWord 手動路徑——FK off 實錘）
  sq.prepare('INSERT INTO word_images (word_id, filename, data) VALUES (?,?,?)').run('w1', 'x.png', 'data:image/png;base64,D');
  sq.prepare('DELETE FROM word_images WHERE word_id=?').run('w1');
  sq.prepare('DELETE FROM words WHERE id=?').run('w1');
  const orphan = sq.prepare('SELECT COUNT(*) c FROM word_images WHERE word_id=?').get('w1');
  assert(orphan.c === 0, 'T2c 刪字手動連刪圖（store.deleteWord 補行後無孤兒）');
} catch (e) {
  assert(false, `T2 CRUD 腿炸（word_images 不存在 = 修法前病徵）: ${e.message}`);
}

// ── T4 批量載入（getImagesForWords IN query）──
console.log('── T4 批量 IN 載入 ──');
try {
  for (const wid of ['wA', 'wB', 'wC']) sq.prepare("INSERT INTO words (id, word) VALUES (?, ?)").run(wid, wid);
  sq.prepare('INSERT INTO word_images (word_id, filename, data) VALUES (?,?,?)').run('wA', 'a.png', 'd1');
  sq.prepare('INSERT INTO word_images (word_id, filename, data) VALUES (?,?,?)').run('wC', 'c.png', 'd2');
  const inPh = sq.prepare('SELECT word_id, filename, data FROM word_images WHERE word_id IN (?,?,?) ORDER BY word_id, id');
  const m = new Map();
  for (const r of inPh.all('wA', 'wB', 'wC')) {
    if (!m.has(r.word_id)) m.set(r.word_id, []);
    m.get(r.word_id).push(r);
  }
  assert(m.size === 2 && m.has('wA') && m.has('wC') && !m.has('wB'),
    `T4a IN 批量 Map 鍵正確（wA/wC 有圖、wB 無）：got keys=[${[...m.keys()].join(',')}]`);
  assert(m.get('wA').length === 1 && m.get('wA')[0].filename === 'a.png', 'T4b 內容正確');
} catch (e) {
  assert(false, `T4 批量腿炸: ${e.message}`);
}

// ── T5 舊 DB 相容（migrate 補表不炸；words.image 舊欄照讀）──
console.log('── T5 舊 DB 相容 ──');
try {
  const dir2 = mkdtempSync(join(tmpdir(), 'img1-old-'));
  const sq2 = new DatabaseSync(join(dir2, 'old.db'));
  sq2.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, image TEXT DEFAULT '')`);
  sq2.prepare("INSERT INTO words (id, word, image) VALUES ('o1','old','https://x/y.png')").run();
  // 舊 DB 無 word_images → db.js migrate() 的 try/catch ALTER/CREATE 補表（靜默）
  if (v11sql) { for (const stmt of splitSql(v11sql)) { try { sq2.exec(stmt); } catch (_) {} } }
  const w = sq2.prepare("SELECT image FROM words WHERE id='o1'").get();
  assert(w.image === 'https://x/y.png', 'T5a words.image 舊值（URL 語意）照讀');
  const hasTable = sq2.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='word_images'").get();
  assert(hasTable.c === 1, 'T5b 舊 DB migrate 後 word_images 補齊');
  sq2.close();
} catch (e) {
  assert(false, `T5 舊 DB 腿炸: ${e.message}`);
}

// ── T3/T6：word-image.js 純函式（node 下需 stub svg/db 依賴——同 c10 判例帶
//    --experimental-test-module-mocks flag；svg.js 是 vite ?raw import，node 直 import 必炸）──
console.log('── T3 carousel / T6 縮圖列（word-image.js）──');
let WI = null;
try {
  const { mock } = await import('node:test');
  mock.module(join(ROOT, 'src/lib/svg.js'), { namedExports: { icon: (n) => `<i data-icon="${n}"></i>` } });
  mock.module(join(ROOT, 'src/lib/db.js'), { namedExports: { getImagesForWord: async () => [], getImagesForWords: async () => new Map() } });
  WI = await import(join(ROOT, 'src/lib/word-image.js'));
  assert(true, 'T3a word-image.js 模組可載入（svg/db stub）');
} catch (e) {
  assert(false, `T3a src/lib/word-image.js 載入失敗（修法前病徵=不存在；修後病徵=flag 缺席）: ${e.message}`);
}
if (WI) {
  // T3 carousel
  const single = WI.renderImageCarousel([{ filename: 'a.png', data: 'data:image/png;base64,A' }], {});
  const multi = WI.renderImageCarousel([
    { filename: 'a.png', data: 'data:image/png;base64,A' },
    { filename: 'b.png', data: 'data:image/png;base64,B' },
    { filename: 'c.png', data: 'data:image/png;base64,C' },
  ], {});
  const sHtml = typeof single === 'string' ? single : single?.html || '';
  const mHtml = typeof multi === 'string' ? multi : multi?.html || '';
  assert(sHtml.includes('data:image/png;base64,A'), 'T3b 單圖 html 含 data: src');
  assert(!/chevron|arrow/i.test(sHtml) || single?.onMount, 'T3c 單圖無切換箭頭（或多圖才出現）');
  assert((mHtml.match(/data:image\/png;base64,/g) || []).length >= 1, 'T3d 多圖 html 至少含首圖 src');
  assert(/chevron|arrow|prev|next/i.test(mHtml) || mHtml.includes('dots') || multi?.onMount, 'T3e 多圖含切換 UI（箭頭/dots/onMount 綁定）');
  assert(mHtml.includes('loading="lazy"') || sHtml.includes('loading="lazy"'), 'T3f img 標 lazy loading');
  // T6 縮圖列（純函式或小工廠）
  const thumbs = WI.renderEditorThumbs?.([
    { id: 1, filename: 'a.png', data: 'd1' },
    { id: 2, filename: 'b.png', data: 'd2' },
  ], () => {});
  assert(!!thumbs, 'T6a renderEditorThumbs 存在且可呼叫');
} else {
  assert(false, 'T3b-f / T6 word-image.js 未載入（修法前病徵，全腿紅）');
}

// ── T7 static pin：db.js 五個 export ──
console.log('── T7 db.js CRUD static pin ──');
const DBJS = readFileSync(join(ROOT, 'src/lib/db.js'), 'utf8');
for (const fn of ['getImagesForWord', 'getImagesForWords', 'addWordImage', 'deleteWordImage', 'deleteWordImagesForWord']) {
  assert(new RegExp(`export async function ${fn}\\s*\\(`).test(DBJS), `T7 db.js export ${fn} 在冊`);
}

// ── T8 static pin：db.js 四刪字路徑事務含刪圖（R2 席核正：落 db 層非 store 層）──
console.log('── T8 db.js 刪字連刪圖 pin ──');
const DBJS_FN = (name) => {
  // 邊界釘 column-0 的 \n}（函式真實結尾）——釘 \n    } 在 clearAll 等無巢縮閉合
  // 的函式上會掃過頭（實錘：T8d 誤紅）
  const m = DBJS.match(new RegExp(`export async function ${name}\\s*\\([^)]*\\)\\s*{([\\s\\S]*?)\\n}`));
  return m ? m[1] : '';
};
assert(/DELETE FROM word_images/.test(DBJS_FN('deleteWord')), 'T8a db.deleteWord 事務含 DELETE FROM word_images');
assert(/DELETE FROM word_images/.test(DBJS_FN('deleteWordsByDeck')), 'T8b db.deleteWordsByDeck 事務含 DELETE FROM word_images');
assert(/DELETE FROM word_images/.test(DBJS_FN('bulkSaveWords')), 'T8c db.bulkSaveWords 覆寫前清 word_images');
assert(/DELETE FROM word_images/.test(DBJS_FN('clearAll')), 'T8d db.clearAll 重設清單含 word_images');

// ═══ 總結 ═══
console.log(`\nIMG1 word-images harness: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) {
  console.log('未通過項:');
  fails.forEach(f => console.log('  -', f));
  process.exit(1);
}
process.exit(0);

// ── util：把 migration sql 字串拆成語句（雙引號字串內容已 unescape 過嗎？no——
//    lib.rs sql: "..." 是 Rust raw string，抽出的就是純 SQL 文本）──
function splitSql(sql) {
  // 依分號切（CREATE ... ; CREATE INDEX ...;）——SQLite exec 本身可多語句一次跑，
  // 這裡拆開是為了 try/catch 逐句容錯（T5 舊 DB 路徑）
  return sql.split(';').map(s => s.trim()).filter(Boolean).map(s => s + ';');
}
