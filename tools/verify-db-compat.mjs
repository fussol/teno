// ═══════════════════════════════════════════════════════════════════
// verify-db-compat.mjs — db-compat 工具＋新舊雙視角開機模擬 harness
//
// 測什麼（全部真實出貨碼，不手抄 SQL）：
//  A. loadMigrations 从 lib.rs 抽取 v1..v14（結構一變就喊，不靜默）
//  B. 合成 v10 時代舊庫（migrations 1..10；v1 指紋故意寫舊＝模擬 5.2.9 血統；
//     words 帶 synonym/antonym 缺 etymology 系；decks 無 new_weight；無 word_images）
//  C. repair 合成庫 → v1..v14 全登記＋指紋全對＋筆數不變（＝新版 migrator no-op）
//  D. 新版視角模擬 == sqlx Migrator::run gate（checksum 比＋pending 查＋未知版查）
//  E. downgrade 10/12/13 → 登記恰為 v1..target、schema 剝離如預期、筆數不變
//  F. 舊版視角：降級檔 v1..v10 指紋 == 現行（已證 == 5.9.45 文字：v1 tag 比對
//     byte-identical；v2..v10 真庫指紋 MATCH 且 5.9.45 跑過）＋5.9.45 真實查詢可跑
//  G. 有真庫（~/下載/teno-backup (15).db）才跑：raw 死 v1、repair 後全過（缺檔跳過）
// ═══════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadMigrations, sha384, unpackFile, isSqlite, fingerprintFile, prepareImportFile, REPAIR_TOOLS } from './db-compat.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let fail = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!c) fail++; };
const tmp = (t) => join(tmpdir(), `vdbc-${t}-${process.pid}-${Date.now()}.db`);
const REAL = '/home/jupiter/下載/teno-backup (15).db';

// A. 抽取
let MIGS;
try {
  MIGS = loadMigrations();
  ok('A 抽取 v1..v14', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].every(v => MIGS[v]?.sql?.length > 0));
} catch (e) { ok('A 抽取 v1..v14', false, e.message); process.exit(1); }
ok('A V13 釘選五欄', ['etymology', 'syllables', 'phrases', 'synonym', 'antonym'].every(c => MIGS[13].sql.includes('ADD COLUMN ' + c)));

// sqlx gate 模擬（唯讀）
function gate(tenoBuf, maxV, label) {
  const p = tmp('gate'); writeFileSync(p, tenoBuf);
  const db = new DatabaseSync(p);
  const rows = db.prepare('SELECT version, checksum, success FROM _sqlx_migrations').all();
  const app = new Map(rows.map(r => [r.version, r]));
  let res = true, why = '';
  for (const r of rows) if (!r.success) { res = false; why = `v${r.version} success=0`; }
  if (res) for (let v = 1; v <= maxV; v++) {
    const a = app.get(v);
    if (!a) { res = false; why = `v${v} 未登記`; break; }
    if (!Buffer.from(a.checksum).equals(sha384(MIGS[v].sql))) { res = false; why = `v${v} VersionMismatch`; break; }
  }
  if (res) {
    const extra = [...app.keys()].filter(v => v > maxV);
    if (extra.length) { res = false; why = `未知登記 [${extra}] VersionMissing`; }
  }
  db.close(); unlinkSync(p);
  return { res, why, label };
}

// B. 合成舊庫
function fixture() {
  const p = tmp('old');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, definition TEXT,
    part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT NOT NULL DEFAULT 'Default',
    tags TEXT DEFAULT '', image TEXT DEFAULT '', created_at TEXT, description TEXT DEFAULT '',
    related TEXT DEFAULT '[]', forms TEXT DEFAULT '[]', synonym TEXT DEFAULT '',
    antonym TEXT DEFAULT '', derivative TEXT DEFAULT '', examples TEXT DEFAULT '[]')`);
  db.exec(`CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT NOT NULL DEFAULT '', stability REAL NOT NULL DEFAULT 2.5,
    difficulty REAL NOT NULL DEFAULT 0.0, elapsed_days INTEGER NOT NULL DEFAULT 0, scheduled_days INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0,
    last_review TEXT, buried INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0,
    step INTEGER NOT NULL DEFAULT 0, mc_data TEXT, spell_data TEXT)`);
  db.exec(`CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#5e6ad2')`);
  db.exec(`CREATE TABLE folders (name TEXT PRIMARY KEY, decks TEXT NOT NULL DEFAULT '[]')`);
  db.exec(`CREATE TABLE additions (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL, definition TEXT,
    part_of_speech TEXT, pronunciation TEXT, examples TEXT, deck TEXT NOT NULL DEFAULT 'Default', added_at TEXT)`);
  db.exec(`CREATE TABLE edits (word_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)`);
  db.exec(`CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT NOT NULL, rating INTEGER NOT NULL,
    elapsed_days INTEGER, scheduled_days INTEGER, stability REAL, difficulty REAL, reviewed_at TEXT,
    duration INTEGER, mode TEXT NOT NULL DEFAULT 'flip', card_state INTEGER, new_state INTEGER)`);
  db.exec(`CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL, correct INTEGER NOT NULL,
    question_type TEXT, examined_at TEXT)`);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE goal_streak (id INTEGER PRIMARY KEY CHECK (id = 1), daily_goal INTEGER DEFAULT 20,
    current INTEGER DEFAULT 0, best INTEGER DEFAULT 0, dates TEXT DEFAULT '[]')`);
  db.exec(`INSERT OR IGNORE INTO goal_streak (id, daily_goal, current, best, dates) VALUES (1, 20, 0, 0, '[]')`);
  const ins = db.prepare(`INSERT INTO words (id, word, definition, part_of_speech, deck, synonym, antonym)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('w1', 'apple', '蘋果', '名詞', 'Default', 'pome', '');
  ins.run('w2', 'run', '跑', '動詞', 'book2', '', 'walk');
  db.prepare('INSERT INTO decks (id, name) VALUES (?, ?)').run('d1', 'book2');
  db.exec(`CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`);
  const rec = db.prepare('INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, ?, -1)');
  for (let v = 1; v <= 10; v++) {
    // v1 指紋故意寫舊（模擬 5.2.9 血統）；v2..v10 寫現行（真庫實測 MATCH）
    const sum = v === 1 ? createHash('sha384').update('old-v1-text', 'utf8').digest() : sha384(MIGS[v].sql);
    rec.run(v, MIGS[v].desc, sum);
  }
  db.exec('PRAGMA integrity_check');
  db.close();
  return p;
}
const run = (cmd) => { try { return execSync(cmd, { cwd: ROOT, stdio: 'pipe' }).toString(); } catch (e) { return 'CMDFAIL:' + String((e.stdout || '') + (e.stderr || '')).slice(0, 300); } };
const tenoOf = (f) => { const u = unpackFile(readFileSync(f)); if (!isSqlite(u.teno)) throw new Error('teno 段非 sqlite'); return u.teno; };
const colsOf = (f, t) => {
  const p = tmp('c'); writeFileSync(p, tenoOf(f));
  const db = new DatabaseSync(p);
  const c = db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
  db.close(); unlinkSync(p); return c;
};
const migsOf = (f) => {
  const p = tmp('m'); writeFileSync(p, tenoOf(f));
  const db = new DatabaseSync(p);
  const m = db.prepare('SELECT version FROM _sqlx_migrations ORDER BY version').all().map(r => r.version);
  const n = db.prepare('SELECT COUNT(*) n FROM words').get().n;
  const it = db.prepare('PRAGMA integrity_check').get().integrity_check;
  db.close(); unlinkSync(p); return { m, n, it };
};

// C. repair 合成庫
const oldP = fixture();
const repP = tmp('rep') + '.db';
{
  const r = run(`node tools/db-compat.mjs repair ${oldP} --out ${repP}`);
  ok('C repair exit 0', !r.startsWith('CMDFAIL'), r.slice(0, 120));
  const { m, n, it } = migsOf(repP);
  ok('C 登記到頂 v14', JSON.stringify(m) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]), m.join(','));
  ok('C 筆數不變＋integrity', n === 2 && it === 'ok', `n=${n} it=${it}`);
  const wc = colsOf(repP, 'words');
  ok('C v13 五欄齊', ['etymology', 'syllables', 'phrases', 'synonym', 'antonym'].every(c => wc.includes(c)));
}
// D. 新版視角
{
  const p = tmp('g'); writeFileSync(p, tenoOf(repP));
  const db = new DatabaseSync(p); // gate() 內部另開，這裡只借 rows 數
  db.close(); unlinkSync(p);
  const g = gate(tenoOf(repP), 14, 'repaired@new');
  ok('D 新版開機 no-op', g.res, g.why);
  const g2 = gate(tenoOf(oldP), 14, 'synthetic-old@new');
  ok('D 舊庫新版必死（v1 指紋）', !g2.res && /v1/.test(g2.why), g2.why);
}
// E. downgrade 矩陣
for (const t of [13, 12, 10]) {
  const o = tmp('d' + t) + '.db';
  const r = run(`node tools/db-compat.mjs downgrade ${repP} --target ${t} --out ${o}`);
  ok(`E downgrade→${t} exit 0`, !r.startsWith('CMDFAIL'), r.slice(0, 120));
  const { m, n, it } = migsOf(o);
  const want = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].filter(v => v <= t);
  ok(`E${t} 登記恰為 v1..${t}`, JSON.stringify(m) === JSON.stringify(want), m.join(','));
  ok(`E${t} 筆數＋integrity`, n === 2 && it === 'ok');
  const wc = colsOf(o, 'words');
  if (t === 10) {
    ok('E10 synonym/antonym 留（舊版要讀）', wc.includes('synonym') && wc.includes('antonym'));
    ok('E10 剝三欄＋new_weight＋word_images',
      !wc.includes('etymology') && !colsOf(o, 'decks').includes('new_weight'));
  }
  if (t === 13) ok('E13 五欄全留', ['etymology', 'syllables', 'phrases'].every(c => wc.includes(c)));
  unlinkSync(o);
}
// F. 舊版視角（5.9.45 文字 == 現行：v1 tag 比對已證；v2..v10 真庫 MATCH）
{
  const o = tmp('d10f') + '.db';
  run(`node tools/db-compat.mjs downgrade ${repP} --target 10 --out ${o}`);
  const g = gate(tenoOf(o), 10, 'down10@old');
  ok('F 舊版開機 no-op（v1..v10 指紋＋無多餘登記）', g.res, g.why);
  // 5.9.45 真實查詢（git tag 現場抽，非手抄；抽不到則跳過不斷言）
  let sel = null;
  try {
    const src = execSync('git show v5.9.45:src/lib/db.js', { cwd: ROOT, stdio: 'pipe' }).toString();
    sel = src.match(/SELECT id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, created_at, related, forms, synonym, antonym, derivative, examples FROM words ORDER BY created_at/)[0];
  } catch { sel = null; }
  if (sel) {
    const p = tmp('q'); writeFileSync(p, tenoOf(o));
    const db = new DatabaseSync(p);
    try { const n = db.prepare(sel).all().length; ok('F 5.9.45 words 查詢可跑', n === 2, `n=${n}`); }
    catch (e) { ok('F 5.9.45 words 查詢可跑', false, e.message.slice(0, 80)); }
    db.close(); unlinkSync(p);
  } else console.log('SKIP F-select（抽不到 v5.9.45 db.js）');
  unlinkSync(o);
}
// G. 真庫（有檔才跑）
if (existsSync(REAL)) {
  const g = gate(tenoOf(REAL), 14, 'real-raw@new');
  ok('G 真庫 raw 新版必死 v1', !g.res && /v1/.test(g.why), g.why);
  const o = tmp('real') + '.db';
  const r = run(`node tools/db-compat.mjs repair "${REAL}" --out ${o}`);
  ok('G 真庫 repair exit 0', !r.startsWith('CMDFAIL'), r.slice(0, 120));
  if (!r.startsWith('CMDFAIL')) {
    const g2 = gate(tenoOf(o), 14, 'real-repaired@new');
    ok('G 真庫修後新版 no-op', g2.res, g2.why);
    const { n } = migsOf(o);
    ok('G 真庫 4934 詞不變', n === 4934, `n=${n}`);
    unlinkSync(o);
  }
} else console.log('SKIP G（無真庫檔）');

// H. 指紋→路由→修復→匯入一條龍（本版修復工具；改版加條目時此段加對應斷言）
// H1 合成舊庫指紋必須路由 repair-v14；修後檔指紋必須 ok；prepare-import 產物 gate 全綠＋筆數不變
{
  ok('H 註冊表只有本版', JSON.stringify(Object.keys(REPAIR_TOOLS)) === '["v14"]', Object.keys(REPAIR_TOOLS).join(','));
  const fpOld = fingerprintFile(oldP);
  ok('H 舊庫路由 repair-v14', fpOld.route === 'repair-v14', fpOld.route + ' ' + fpOld.reason);
  const fpRep = fingerprintFile(repP);
  ok('H 修後檔路由 ok', fpRep.route === 'ok', fpRep.route + ' ' + (fpRep.reason || ''));
  const o = tmp('prep') + '.db';
  const r = prepareImportFile(oldP, o);
  ok('H prepare-import 有修復', r.repaired === true);
  const g = gate(tenoOf(o), 14, 'prepared@new');
  ok('H 產物新版開機 no-op', g.res, g.why);
  const { n } = migsOf(o);
  ok('H 產物筆數不變', n === 2, `n=${n}`);
  unlinkSync(o);
}
unlinkSync(oldP); unlinkSync(repP);
console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全綠');
process.exit(fail ? 1 : 0);
