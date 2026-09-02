#!/usr/bin/env node
// verify-e11-report-totalwords.mjs — E11: cmdReport totalWords 硬編碼 4868。
// 修法＝提升 :2769 查詢作用域＋主庫回退＋maturePct 分母守衛。全 tmp，不碰真庫。
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'tools', 'cli.mjs');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};
const dir = mkdtempSync(join(tmpdir(), 'e11-verify-'));

const HEAD_LINE = 'const totalWords = 4868;';
const FIX_MARK = '// E11: 原硬編碼 4868';

function mkDb(p, nWords, nMature = 3) {
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
  `);
  const ins = d.prepare('INSERT INTO words(id,word) VALUES (?,?)');
  for (let i = 1; i <= nWords; i++) ins.run('w' + i, 'word' + i);
  const insc = d.prepare("INSERT INTO cards(word_id,due,state,scheduled_days) VALUES (?,'x',2,30)");
  for (let i = 1; i <= nMature; i++) insc.run('w' + i);
  d.close();
  return p;
}
function mkLogs(tag) {
  const ld = join(dir, tag);
  mkdirSync(ld);
  writeFileSync(join(ld, 'day-1-2026-08-01.log'), 'x [store.rate] apple w1 dueDays= 25 rating= 2 y\n[mature] 成熟=3\n');
  writeFileSync(join(ld, 'day-2-2026-08-02.log'), 'x [store.rate] apple w1 dueDays= 26 rating= 0 y\n');
  return ld;
}
function run(cliPath, argv, mainDb) {
  return spawnSync('node', [cliPath, 'report', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: mainDb, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
const json = (out) => { const i = out.indexOf('{'); try { return JSON.parse(out.slice(i)); } catch { return null; } };
function variantCli(s) {
  const d2 = mkdtempSync(join(dir, 'v-')); // mkdtempSync 已建目錄
  if (!existsSync(join(dir, 'src'))) symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
  writeFileSync(join(d2, 'cli.mjs'), s);
  return join(d2, 'cli.mjs');
}

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = !src.includes(HEAD_LINE) && src.includes(FIX_MARK);

  console.log('T1 主鏈：base.db 7 字 3 成熟 → totalWords=7 maturePct=43＋HTML');
  {
    const ld = mkLogs('t1');
    mkDb(join(ld, 'base.db'), 7);
    const main = mkDb(join(dir, 't1-main.db'), 100); // 主庫 100——證明吃的是 base.db 非主庫
    const r = run(CLI, [ld, '--json'], main);
    const j = json(r.stdout);
    T('T1a totalWords=7（非主庫 100、非 4868）', j && j.totalWords === 7, JSON.stringify(j && j.totalWords));
    T('T1b maturePct=43（3/7）', j && j.maturePct === 43, JSON.stringify(j && j.maturePct));
    const r2 = run(CLI, [ld], main);
    const html = readFileSync(join(ld, 'report.html'), 'utf8');
    T('T1c HTML「· 7 單字」', r2.status === 0 && html.includes('· 7 單字'));
  }

  console.log('T2 即時釘：加 3 字重跑 → 10（實時查詢非快照殘影）');
  {
    const ld = mkLogs('t2');
    const bdb = mkDb(join(ld, 'base.db'), 7);
    const main = mkDb(join(dir, 't2-main.db'), 999);
    run(CLI, [ld, '--json'], main);
    const d = new DatabaseSync(bdb);
    d.prepare("INSERT INTO words(id,word) VALUES ('x1','a'),('x2','b'),('x3','c')").run();
    d.close();
    const j = json(run(CLI, [ld, '--json'], main).stdout);
    T('T2 totalWords=10', j && j.totalWords === 10, JSON.stringify(j && j.totalWords));
  }

  console.log('T3 回退鏈：無 base/mature → 主庫；主庫 0 字 → 0＋maturePct null 不 Infinity');
  {
    const ld = mkLogs('t3'); // 無任何 db 檔
    const main = mkDb(join(dir, 't3-main.db'), 5);
    const j = json(run(CLI, [ld, '--json'], main).stdout);
    T('T3a 回退主庫 totalWords=5', j && j.totalWords === 5, JSON.stringify(j && j.totalWords));
    const empty = mkDb(join(dir, 't3-empty.db'), 0, 0);
    const j2 = json(run(CLI, [ld, '--json'], empty).stdout);
    T('T3b 0 字 → totalWords=0＋pct null（非 Infinity/NaN）',
      j2 && j2.totalWords === 0 && j2.maturePct === null, JSON.stringify(j2 && [j2.totalWords, j2.maturePct]));
    // R1 建議#1 混源釘：base.db 有 cards 無 words 表（schema 矛盾）→ 整組敗才回退主庫，
    // 禁「分子 base.db=3／分母主庫=9」混源 pct → totalWords/pct 皆 null（誠實非混數）
    const ld3 = mkLogs('t3c');
    const bad = new DatabaseSync(join(ld3, 'base.db'));
    bad.exec(`CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT NOT NULL, stability REAL DEFAULT 2.5, difficulty REAL DEFAULT 0, elapsed_days INTEGER DEFAULT 0, scheduled_days INTEGER DEFAULT 0, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, state INTEGER DEFAULT 0, last_review TEXT, buried INTEGER DEFAULT 0, suspended INTEGER DEFAULT 0, step INTEGER DEFAULT 0, mc_data TEXT, spell_data TEXT);
      INSERT INTO cards(word_id,due,state,scheduled_days) VALUES ('w1','x',2,30),('w2','x',2,25),('w3','x',2,22);`);
    bad.close();
    const main3 = mkDb(join(dir, 't3c-main.db'), 9); // 主庫 9 字——混源則 pct=33
    const j3 = json(run(CLI, [ld3, '--json'], main3).stdout);
    T('T3c 混源釘：schema 矛盾 DB → totalWords=null＋pct=null（絕非混源 33）',
      j3 && j3.totalWords === null && j3.maturePct === null, JSON.stringify(j3 && [j3.totalWords, j3.maturePct]));
  }

  console.log('T4 負控制：4868 段反換 → 謊數＋maturePct 誤導重現');
  {
    let buggySrc;
    if (fixed) {
      const cStart = src.lastIndexOf('\n', src.indexOf('  // E11:')) + 1;
      const fbLine = '  if (totalWords == null && matureCumulative == null) { try { totalWords = db.prepare(\'SELECT count(*) n FROM words\').get().n; } catch { totalWords = 0; } }';
      const block = src.slice(cStart, src.indexOf(fbLine) + fbLine.length);
      buggySrc = src
        .replace(', matureCumulative = null, totalWords = null;', ', matureCumulative = null;')
        .replace('      totalWords = words; // E11: 提升作用域（原 :2783 取不到本查詢而硬編碼 4868）\n', '')
        .replace(block, '  const totalWords = 4868;')
        .replaceAll('matureCumulative && totalWords ?', 'matureCumulative ?');
      T('T4a 反換真實性（四 hunk 全還原＝HEAD 語義）',
        !buggySrc.includes(FIX_MARK) && buggySrc.includes(HEAD_LINE) && buggySrc !== src &&
        !buggySrc.includes('totalWords = words;') && !buggySrc.includes('matureCumulative && totalWords'));
    } else {
      buggySrc = src;
      T('T4a 反換真實性（工作區即原版）', buggySrc.includes(HEAD_LINE));
    }
    const B = variantCli(buggySrc);
    const ld = mkLogs('t4');
    mkDb(join(ld, 'base.db'), 7);
    const main = mkDb(join(dir, 't4-main.db'), 999);
    const j = json(run(B, [ld, '--json'], main).stdout);
    T('T4b 負控制 totalWords=4868 謊數重現', j && j.totalWords === 4868, JSON.stringify(j && j.totalWords));
    T('T4c 負控制 maturePct 誤導（3/4868→0，真值 43）', j && j.maturePct === 0, JSON.stringify(j && j.maturePct));
  }

  console.log('T5 源碼釘：4868 賦值零殘留＋分母守衛雙在位');
  T('T5a 「= 4868」賦值零殘留（註解文字豁免）', !/totalWords\s*=\s*4868/.test(readFileSync(CLI, 'utf8')));
  T('T5b maturePct 分母守衛 ×2（JSON＋HTML）',
    (readFileSync(CLI, 'utf8').match(/matureCumulative && totalWords \?/g) || []).length === 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-e11: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
