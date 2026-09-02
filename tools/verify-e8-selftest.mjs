#!/usr/bin/env node
// verify-e8-selftest.mjs — E8: selftest 模擬引擎段 import 死路徑 ../src/lib/sim-engine.js → 永遠 ❌。
// 修法：第 3 段整塊退役（舊 JS 引擎已隔離 deprecated/、官方 simulate_fsrs 取代、app 零消费者）。
// 全部跑 tmp DB 副本，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'tools', 'cli.mjs');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'e8-verify-'));
const BUG_MARK = '// 3. (E8 退役)';
// 修法落地後的原 block（負控制逐字重建用，與 cli.mjs 修法註解成對）
const ORIGINAL_BLOCK = `  // 3. 模擬引擎 (Day1 新卡首刷 + 成熟>0)
  try {
    const d = new DatabaseSync(DB, { readOnly: true });
    const words = d.prepare('SELECT id, word, deck FROM words').all();
    const cards = new Map();
    const reviewLog = d.prepare('SELECT * FROM review_log').all();
    d.close();
    const { runSimulation } = await import('../src/lib/sim-engine.js');
    const ankiCfg = { fsrsWeights: null, desiredRetention: 0.9, maxIvl: 365, cardsPerDay: 80, maxReviewsPerDay: 1000, learnSteps: '1,10', relearnSteps: '10' };
    const res = runSimulation({ words, cards, reviewLog, ankiCfg, mode: 'simulate', days: 30, seed: 1, fromZero: true });
    check('模擬 Day1 新卡當天首刷', (res.daily[0]?.reviews ?? 0) > 0, \`Day1=\${res.daily[0]?.reviews}\`);
    check('模擬 30天 有成熟卡', res.finalMature > 0, \`成熟=\${res.finalMature}\`);
    check('模擬 30天 每日評分合理', res.daily.every(x => x.reviews >= 0), '');
  } catch (e) { check('模擬引擎', false, e.message); }`;

function mkTmpDb(name) {
  const p = join(dir, name, 'teno.db');
  mkdirSync(join(dir, name), { recursive: true });
  const d = new DatabaseSync(p);
  d.exec(`
    CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, definition TEXT,
      part_of_speech TEXT, pronunciation TEXT, example TEXT, deck TEXT NOT NULL DEFAULT 'Default',
      tags TEXT DEFAULT '', image TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
      description TEXT DEFAULT '', related TEXT DEFAULT '[]', forms TEXT DEFAULT '[]',
      synonym TEXT NOT NULL DEFAULT '', antonym TEXT NOT NULL DEFAULT '',
      derivative TEXT NOT NULL DEFAULT '', examples TEXT NOT NULL DEFAULT '');
    CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT NOT NULL DEFAULT (datetime('now')),
      stability REAL NOT NULL DEFAULT 2.5, difficulty REAL NOT NULL DEFAULT 0.0,
      elapsed_days INTEGER NOT NULL DEFAULT 0, scheduled_days INTEGER NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
      state INTEGER NOT NULL DEFAULT 0, last_review TEXT, buried INTEGER NOT NULL DEFAULT 0,
      suspended INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 0,
      mc_data TEXT, spell_data TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL, rating INTEGER NOT NULL, elapsed_days INTEGER,
      scheduled_days INTEGER, stability REAL, difficulty REAL,
      reviewed_at TEXT DEFAULT (datetime('now')), duration INTEGER,
      mode TEXT NOT NULL DEFAULT 'flip', card_state INTEGER, new_state INTEGER);
    INSERT INTO words (id, word, deck) VALUES ('w1','apple','Default'),('w2','banana','Default');
  `);
  d.close();
  return p;
}

function runSelftest(cliPath, dbPath) {
  const r = spawnSync('node', [cliPath, 'selftest'], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
  return (r.stdout || '') + (r.stderr || '');
}

try {
  const src = readFileSync(CLI, 'utf8');

  console.log('T1 靜態：死引用已除');
  T('T1a cli.mjs 不含死路徑 src/lib/sim-engine.js', !src.includes('../src/lib/sim-engine.js'));
  T('T1b cli.mjs 無 runSimulation 引用', !src.includes('runSimulation'));
  T('T1c 退役標記註解在場', src.includes(BUG_MARK));

  console.log('T2 實跑 selftest（修法後應零失敗）');
  const db1 = mkTmpDb('fixed');
  const out1 = runSelftest(CLI, db1);
  const mFix = out1.match(/結果: (\d+) 通過 \/ (\d+) 失敗/);
  T('T2a selftest 有結果行', !!mFix, out1.slice(-200));
  T('T2b 失敗 = 0', !!mFix && mFix[2] === '0');
  T('T2c 輸出零 ❌', !out1.includes('❌'));
  T('T2d 「模擬引擎」check 字樣不再出現', !out1.includes('模擬引擎'));
  T('T2e 回歸釘：FSRS 段仍 OK', out1.includes('✅ FSRS 新卡 Good 難度 init≈2.1'));
  T('T2f 回歸釘：容器段仍 OK', out1.includes('✅ 容器 round-trip teno'));
  T('T2g [TEST] log 寫入仍 OK', out1.includes('✅ 寫入 [TEST] 標記 log'));

  console.log('T3 負控制：还原原 broken block → 永远 ❌ 精準重現');
  // bugsub 與 tools/ 同深度 + src symlink（cli 用 ../src 相對 import，E5/E6 同法）
  const bugDir = join(dir, 'bugsub');
  mkdirSync(bugDir);
  symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
  // 先剝修法（還原原 block）：以 BUG_MARK 找到退役註解段，換回 ORIGINAL_BLOCK
  const markerIdx = src.indexOf(BUG_MARK);
  let buggySrc;
  if (markerIdx >= 0) {
    // 退役註解 = 從 MARK 行起至連續 '//' 註解行結束（含空行前）
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.includes(BUG_MARK));
    let end = start;
    while (end + 1 < lines.length && lines[end + 1].trim().startsWith('//')) end++;
    buggySrc = [...lines.slice(0, start), ORIGINAL_BLOCK, ...lines.slice(end + 1)].join('\n');
  } else {
    buggySrc = src; // 修法未落地（工作區即原版）→ 原樣即 buggy
  }
  T('T3a 負控制源碼含死路徑', buggySrc.includes('../src/lib/sim-engine.js'));
  writeFileSync(join(bugDir, 'cli.mjs'), buggySrc);
  const db2 = mkTmpDb('buggy');
  const out2 = runSelftest(join(bugDir, 'cli.mjs'), db2);
  const mBug = out2.match(/結果: (\d+) 通過 \/ (\d+) 失敗/);
  T('T3b 負控制 selftest 有結果行', !!mBug, out2.slice(-200));
  T('T3c 負控制 ❌ 模擬引擎 精準重現', out2.includes('❌ 模擬引擎'));
  T('T3d 負控制 Cannot find module', out2.includes('Cannot find module'));
  T('T3e 負控制 失敗計數 ≥1', !!mBug && parseInt(mBug[2]) >= 1);
  T('T3f 負控制下他段不受波及（容器段仍 ✅）', out2.includes('✅ 容器 round-trip teno'));

  console.log('T4 E16 前提釘：全庫零 sim-engine 引用（白名單豁免 _dev/cli）');
  T('T4a tools/cli.mjs 零引用', !src.includes('sim-engine'));
  function walk(d, acc) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'deprecated') walk(p, acc); }
      else if (/\.(js|mjs|ts)$/.test(e.name)) acc.push(p);
    }
    return acc;
  }
  const srcFiles = walk(join(REPO, 'src'), []);
  const hits = srcFiles.filter(f => readFileSync(f, 'utf8').includes('sim-engine'));
  T('T4b src/（除 deprecated）零引用', hits.length === 0, hits.join(','));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-e8: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
