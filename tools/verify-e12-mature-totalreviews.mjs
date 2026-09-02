#!/usr/bin/env node
// verify-e12-mature-totalreviews.mjs — E12: cmdMature sim_runs.total_reviews
// 超時分支讀 mature.db review_log（simulate 永不寫 log→報備份快照謊數）、
// 成功分支不傳（null）。修法＝cards.reps 基線差。全 tmp，嚴禁碰真庫。
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'e12-verify-'));
const SNAP_LOGS = 40; // 假 app 刷題史快照（mature.db 備份會帶來）

const E12_MARK = '// E12: totalReviews 原讀 mature.db review_log';

function mkMain(p) {
  mkdirSync(dirname(p), { recursive: true });
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
  `);
  const ins = d.prepare('INSERT INTO words(id,word) VALUES (?,?)');
  for (let i = 1; i <= 6; i++) ins.run('w' + i, 'word' + i);
  const insl = d.prepare("INSERT INTO review_log(word_id,rating,difficulty,reviewed_at) VALUES ('w1',2,6.0,'2026-08-01T08:00:00Z')");
  for (let i = 0; i < SNAP_LOGS; i++) insl.run();
  d.close();
  return p;
}
function mkCli(s) {
  const d2 = mkdtempSync(join(dir, 'v-')); // 已建目錄
  if (!existsSync(join(dir, 'src'))) symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
  writeFileSync(join(d2, 'cli.mjs'), s);
  return join(d2, 'cli.mjs');
}
function runMature(cliPath, argv, mainDb) {
  return spawnSync('node', [cliPath, 'mature', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: mainDb, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 300000,
  });
}
const simRun = (mainDb) => {
  const p = mainDb.replace(/teno\.db$/, 'app-log.db');
  if (!existsSync(p)) return null;
  try { return new DatabaseSync(p, { readOnly: true }).prepare('SELECT * FROM sim_runs').get() ?? null; } catch { return null; }
};
const sumReps = (p) => { try { return new DatabaseSync(p, { readOnly: true }).prepare('SELECT COALESCE(SUM(reps),0) n FROM cards').get().n; } catch { return null; } };
const storeRateCount = (ld) => { try { return readdirSync(ld).filter(f => /^day-\d+-/.test(f) && f.endsWith('.log')).reduce((a, f) => a + (readFileSync(join(ld, f), 'utf8').match(/\[store\.rate\]/g) || []).length, 0); } catch { return -1; } };

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(E12_MARK);

  console.log('T1 超時分支：total_reviews＝本次 reps 增量（非快照 40）＝[store.rate] 交叉核對');
  mkdirSync(join(dir, 't1'));
  const main1 = mkMain(join(dir, 't1', 'teno.db'));
  const ld1 = join(dir, 't1', 'md');
  let r1 = runMature(CLI, ['100', '--max-days', '2', '--from-zero', '--speed', '40', '--seed', '7', '--start', '2026-08-03', '--log-dir', ld1], main1);
  {
    const sr = simRun(main1);
    const mdb = join(ld1, 'mature.db');
    const reps = sumReps(mdb); // from-zero → base=0 → reps==delta
    const cnt = storeRateCount(ld1);
    T('T1a run 完成且有 sim_runs 行（kind=mature）', sr && sr.kind === 'mature', String(sr && sr.kind));
    T(`T1b total_reviews==reps 增量(${reps})`, sr && sr.total_reviews === reps, `tr=${sr && sr.total_reviews} reps=${reps}`);
    T(`T1c 交叉核對==[store.rate] 數(${cnt})`, sr && cnt > 0 && sr.total_reviews === cnt, `tr=${sr && sr.total_reviews} cnt=${cnt}`);
    T('T1d 非快照謊數（≠40）', sr && sr.total_reviews !== SNAP_LOGS && sr.total_reviews > 0, `tr=${sr && sr.total_reviews}`);
    // T5 增量釘：同 progress 再跑一天，total_reviews 應為本輪增量非累計總和
    const sBefore = sumReps(mdb);
    runMature(CLI, ['100', '--max-days', '1', '--speed', '40', '--seed', '7', '--start', '2026-09-01', '--log-dir', ld1], main1);
    const sr2 = simRun(main1);
    const sAfter = sumReps(mdb);
    T('T5 第二次 run total_reviews==S2−S1（基線差非總和）', sr2 && sr2.total_reviews === sAfter - sBefore && sr2.total_reviews < sAfter, `tr2=${sr2 && sr2.total_reviews} Δ=${sAfter - sBefore} S2=${sAfter}`);
  }

  console.log('T2 成功分支：預種成熟卡即達標 → total_reviews 非 null＝循環增量');
  {
    const main2 = mkMain(join(dir, 't2', 'teno.db'));
    const ld2 = join(dir, 't2', 'md');
    // 建立 mature.db（--max-days 1 超時退出即可）
    runMature(CLI, ['100', '--max-days', '1', '--from-zero', '--speed', '10', '--seed', '3', '--start', '2026-08-03', '--log-dir', ld2], main2);
    const mdb = join(ld2, 'mature.db');
    const d = new DatabaseSync(mdb);
    d.prepare("INSERT INTO cards(word_id,due,state,scheduled_days,reps) VALUES ('w6','2026-08-10T08:00:00.000Z',2,30,5) ON CONFLICT(word_id) DO UPDATE SET due='2026-08-10T08:00:00.000Z', state=2, scheduled_days=30").run();
    d.close();
    const sB = sumReps(mdb);
    const r = runMature(CLI, ['1', '--max-days', '3', '--speed', '10', '--seed', '3', '--start', '2026-09-01', '--log-dir', ld2], main2);
    const sr = simRun(main2);
    const sA = sumReps(mdb);
    T('T2a 達標成功退出', r.stdout.includes('達到'), r.stdout.trim().split('\n').slice(-2).join(' | '));
    T('T2b total_reviews 非 null 且==循環增量', sr && sr.total_reviews != null && sr.total_reviews === sA - sB, `tr=${sr && sr.total_reviews} Δ=${sA - sB}`);
  }

  console.log('T3 契約釘：sim_runs 欄位集合不變');
  {
    const p3 = main1.replace(/teno\.db$/, 'app-log.db');
    const row = simRun(main1);
    const cols = row ? Object.keys(row) : [];
    T('T3 欄集合＝{id,ts,kind,days,target_pct,seed,from_zero,total_reviews,mature_cards,mature_pct,summary}',
      new Set(cols).size === 11 && ['kind', 'total_reviews', 'mature_pct', 'summary'].every(c => cols.includes(c)), cols.join(','));
  }

  console.log('T4 負控制：HEAD 版（錯表查詢＋成功分支缺欄）反換重現');
  {
    let buggySrc;
    if (fixed) {
      buggySrc = src
        .replace(/  \/\/ E12: totalReviews[\s\S]*?const simReviews = \(\) => \{[^}]*\};\n/, '')
        .replace('totalReviews: simReviews(), matureCards: mature, maturePct: total ? Math.round(mature / total * 100) : null });\n      return;', 'matureCards: mature, maturePct: total ? Math.round(mature / total * 100) : null });\n      return;')
        .replace("  d.close(); // E12: totalReviews 改經 simReviews() 基線差（原讀 review_log＝備份快照謊數）", "  const totalReviews = d.prepare('SELECT count(*) n FROM review_log').get().n;\n  d.close();")
        .replace("totalReviews: simReviews(), matureCards: mature, maturePct: total ? Math.round(mature / total * 100) : null });\n}", "totalReviews, matureCards: mature, maturePct: total ? Math.round(mature / total * 100) : null });\n}");
      T('T4a 反換真實性（HEAD 語義四點全還原）',
        !buggySrc.includes(E12_MARK) && buggySrc.includes("SELECT count(*) n FROM review_log") && buggySrc !== src &&
        !buggySrc.includes('simReviews()'));
    } else {
      buggySrc = src;
      T('T4a 反換真實性（工作區即原版）', buggySrc.includes("SELECT count(*) n FROM review_log"));
    }
    const B = mkCli(buggySrc);
    // 超時分支：無 from-zero → mature.db=含 40 筆 log 的備份 → 謊報 40
    const main4 = mkMain(join(dir, 't4', 'teno.db'));
    const ld4 = join(dir, 't4', 'md');
    runMature(B, ['100', '--max-days', '1', '--speed', '20', '--seed', '5', '--start', '2026-08-03', '--log-dir', ld4], main4);
    const sr = simRun(main4);
    T('T4b 負控制超時分支 total_reviews==40（快照謊數重現）', sr && sr.total_reviews === SNAP_LOGS, `tr=${sr && sr.total_reviews}`);
    T('T4c 負控制：快照 40 ≠ 真實 reps 增量', (() => { const rp = sumReps(join(ld4, 'mature.db')); return rp !== SNAP_LOGS; })());
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-e12: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
