#!/usr/bin/env node
// verify-e15-loadstate-cols.mjs — E15: loadState words SELECT 12 欄 vs app 真值源
// db.js getAllWords 17 欄 → 缺 pronunciation/example/image/description/created_at,
// 偽契約（消費者讀缺欄靜默 undefined 零回聲，同 E13/E14 無聲髒值族）。
// 修法＝補齊 17 欄（顯式清單非 SELECT *；不補 ORDER BY＝佇列順序行為另案）。
// 契約釘＝雙檔錨點切段擷取 SELECT 欄集合 set 相等＋size 斷言（防抽取落空空集假綠）。
// 全程唯讀 tmp，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'tools', 'cli.mjs');
const DBJS = join(REPO, 'src', 'lib', 'db.js');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};

// ── 錨點切段擷取器（R1#3/#4 處方：全檔正則會誤咬 cli 30 條/db.js 多條 FROM words）──
function extractCliCols(src) {
  const start = src.indexOf('function loadState()');
  if (start === -1) return { err: 'loadState 錨點失联' };
  const end = src.indexOf('function modeCardMap', start);
  const seg = src.slice(start, end === -1 ? start + 3000 : end);
  const sqls = seg.match(/'SELECT [^']*FROM words[^']*'/g) || [];
  if (sqls.length !== 1) return { err: `loadState 段內 FROM words SQL 擷取=${sqls.length} 條（須恰 1）` };
  const list = sqls[0].slice(" 'SELECT ".length - 1, sqls[0].indexOf(' FROM words'));
  return { cols: norm(list), sql: sqls[0] };
}
function extractDbjsCols(src) {
  const start = src.indexOf('export async function getAllWords');
  if (start === -1) return { err: 'getAllWords 錨點失联' };
  const seg = src.slice(start, start + 1200);
  const m = seg.match(/\.select\(\s*'([^']*)'/);
  if (!m) return { err: 'getAllWords select 字串擷取失敗' };
  const fromIdx = m[1].indexOf(' FROM words');
  if (fromIdx === -1) return { err: 'getAllWords SQL 無 FROM words' };
  const list = m[1].slice('SELECT '.length, fromIdx);
  return { cols: norm(list), sql: m[1] };
}
function norm(list) {
  return [...new Set(list.toLowerCase().replace(/[`"]/g, '').split(',').map(s => s.trim()).filter(Boolean))].sort();
}

const ORIG12 = `'SELECT id, word, definition, part_of_speech, deck, tags, synonym, antonym, derivative, related, forms, examples FROM words'`;

try {
  const cli = readFileSync(CLI, 'utf8');
  const dbjs = readFileSync(DBJS, 'utf8');

  console.log('T1 契約釘：loadState 欄集合 ＝ db.js getAllWords 欄集合（R1#4 防假綠三閘）');
  {
    const a = extractCliCols(cli), b = extractDbjsCols(dbjs);
    T('T1a 雙邊擷取成功（錨點＋段內恰 1 條 SQL）', !a.err && !b.err, `cli=${a.err || 'ok'} db=${b.err || 'ok'}`);
    if (!a.err && !b.err) {
      T('T1b size 斷言：兩邊皆=17（空集/半抓假綠封死）', a.cols.length === 17 && b.cols.length === 17, `cli=${a.cols.length} db=${b.cols.length}`);
      const missing = b.cols.filter(c => !a.cols.includes(c));
      const extra = a.cols.filter(c => !b.cols.includes(c));
      T('T1c set 相等（缺集∪多集=∅）', missing.length === 0 && extra.length === 0, `缺=[${missing}] 多=[${extra}]`);
    }
  }

  console.log('T2 schema 安全釘：words.created_at 存在於建表 migration（補欄不打爆任何世代 DB）');
  {
    const librs = readFileSync(join(REPO, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const m = librs.match(/CREATE TABLE IF NOT EXISTS words \(([\s\S]*?)\)/);
    T('T2a lib.rs words 建表含 created_at＋pronunciation＋example＋image', !!m && /created_at/.test(m[1]) && /pronunciation/.test(m[1]) && /example/.test(m[1]) && /image/.test(m[1]), m ? '' : '建表段擷取失敗');
    const mig = (librs.match(/ALTER TABLE words ADD COLUMN \w+/g) || []).join(',');
    T('T2b description 欄有正式 migration（lib.rs ALTER v4 世代）', /ADD COLUMN description/.test(librs), `ALTERs=[${mig}]`);
  }

  console.log('T3 行為煙霧釘：loadState 全欄 DB 上 rate/whatif 主鏈不碎');
  {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'e15-verify-'));
    const p = join(dir, 'teno.db');
    const d = new DatabaseSync(p);
    d.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, definition TEXT, part_of_speech TEXT,
        pronunciation TEXT, example TEXT, deck TEXT NOT NULL DEFAULT 'Default', tags TEXT DEFAULT '',
        image TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), description TEXT DEFAULT '',
        related TEXT DEFAULT '[]', forms TEXT DEFAULT '[]', synonym TEXT NOT NULL DEFAULT '',
        antonym TEXT NOT NULL DEFAULT '', derivative TEXT NOT NULL DEFAULT '', examples TEXT NOT NULL DEFAULT '');
      CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT NOT NULL, stability REAL NOT NULL DEFAULT 2.5,
        difficulty REAL NOT NULL DEFAULT 0.0, elapsed_days INTEGER NOT NULL DEFAULT 0,
        scheduled_days INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
        lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, last_review TEXT,
        buried INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0,
        step INTEGER NOT NULL DEFAULT 0, mc_data TEXT, spell_data TEXT);
      CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT NOT NULL,
        rating INTEGER NOT NULL, elapsed_days INTEGER, scheduled_days INTEGER, stability REAL,
        difficulty REAL, reviewed_at TEXT, duration INTEGER, mode TEXT NOT NULL DEFAULT 'flip',
        card_state INTEGER, new_state INTEGER);
      CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT, ts TEXT DEFAULT (datetime('now')));
      CREATE TABLE goal_streak (id INTEGER PRIMARY KEY, daily_goal INTEGER, current INTEGER, best INTEGER, dates TEXT);
      INSERT INTO words(id,word,definition,pronunciation,example,image,description,created_at)
        VALUES ('w1','apple','a fruit','/ˈæpəl/','an example sent.','a.png','a desc.','2026-01-01 00:00:00');
      INSERT INTO cards(word_id,due,state,reps,stability,difficulty) VALUES ('w1','2026-08-20T08:00:00.000Z',2,3,10.5,6.2);
    `);
    d.close();
    const env = { ...process.env, TENO_DB: p, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') };
    const r1 = spawnSync('node', [CLI, 'rate', 'w1', '3'], { encoding: 'utf8', env, timeout: 60000 });
    T('T3a rate 主鏈不碎（17 欄 SELECT 在新 schema 正常）', r1.status === 0 && /rating=3/.test(r1.stdout), r1.stdout.trim().slice(-80) + r1.stderr.slice(-80));
    const r2 = spawnSync('node', [CLI, 'whatif', 'w1', '2,2'], { encoding: 'utf8', env, timeout: 60000 });
    T('T3b whatif 不碎（loadState 消費面回歸）', r2.status === 0 && /whatif apple/.test(r2.stdout), r2.stdout.trim().slice(0, 80) + r2.stderr.slice(-80));
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('T4 負控制（R1 處方：12 欄同構反換 → T1 紅因=set 差非抽取落空）');
  {
    const FIXED17 = `'SELECT id, word, definition, part_of_speech, pronunciation, example, image, description, deck, tags, created_at, synonym, antonym, derivative, related, forms, examples FROM words'`;
    const hasOrig = cli.includes(ORIG12);
    const hasFixed = cli.includes(FIXED17);
    if (hasOrig && !hasFixed) {
      // 工作區=原版：直接證 T1 對原版紅（欄缺集恰 5）
      const a = extractCliCols(cli), b = extractDbjsCols(dbjs);
      const missing = !a.err && !b.err ? b.cols.filter(c => !a.cols.includes(c)) : null;
      T('T4 原版欄缺集=5 欄（pronunciation/example/image/description/created_at）', !!missing && missing.length === 5 && missing.includes('pronunciation') && missing.includes('created_at'), `missing=[${missing}]`);
    } else if (hasFixed && !hasOrig) {
      // 工作區=修法版：反換 17→12（同構語法，extractor 仍單條擷取成功→紅因必為 set 差）
      const swapped = cli.replace(FIXED17, ORIG12);
      if (swapped === cli) throw new Error('負控制替換未生效');
      const a = extractCliCols(swapped), b = extractDbjsCols(dbjs);
      const missing = !a.err && !b.err ? b.cols.filter(c => !a.cols.includes(c)) : null;
      T('T4a 反換版擷取仍成功（紅因=set 差非錨點失效）', !a.err && a.cols.length === 12, `err=${a.err} n=${a.cols && a.cols.length}`);
      T('T4b 反換版欄缺集=5 欄精準重現', !!missing && missing.length === 5, `missing=[${missing}]`);
    } else {
      throw new Error(`工作區 SQL 狀態异常：hasOrig=${hasOrig} hasFixed=${hasFixed}（两者皆無=loadState 被改寫，先同步腳本）`);
    }
  }

  console.log('T5 結構釘：五補欄 token 在 loadState SQL 字面量內各恰 1（\\b 防 examples 誤咬；只掃 SQL 不掃註解，E8 課）');
  {
    const a = extractCliCols(cli);
    const sql = a.err ? '' : a.sql;
    for (const tok of ['pronunciation', 'example', 'image', 'description', 'created_at']) {
      const cnt = (sql.match(new RegExp(`\\b${tok}\\b`, 'g')) || []).length;
      T(`T5 「${tok}」恰 1（\\b 邊界）`, cnt === 1, `cnt=${cnt}`);
    }
    T('T5f SELECT * 未採納（顯式清單防線維持）', !/SELECT \* FROM words/.test(cli.slice(cli.indexOf('function loadState()'), cli.indexOf('function modeCardMap'))));
  }
} finally {}
console.log(`\n結果: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : ''}`);
process.exit(fail === 0 ? 0 : 1);
