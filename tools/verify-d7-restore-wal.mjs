#!/usr/bin/env node
// verify-d7-restore-wal.mjs — D7: CLI 覆寫 DB 前不刪 -wal/-shm → 殭屍 WAL 混入新主檔。
// 類缺陷：cmdRestore（無 backup 無 rmWal）＋ cmdBackups restore 分支（Discord bot 路徑，缺 rmWal）；
// cmdImportDb 為正面教材（本地 rmWal 頂層化共用）。全部 tmp DB＋假 HOME，嚴禁碰真檔。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
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

const dir = mkdtempSync(join(tmpdir(), 'd7-verify-'));

// 契約文字（動工前凍結，負控制反剝錨；計畫書 §3 同步逐字收錄，triple 內禁插文字）
const FIX_RESTORE = "  backupDb();\n  rmWal(DB);\n  copyFileSync(file, DB);";
const BUGGY_RESTORE = "  copyFileSync(file, DB);";
const FIX_BKRS = "    backupDb();\n    rmWal(DB);\n    copyFileSync(`${dir}/${name}`, DB);";
const BUGGY_BKRS = "    backupDb();\n    copyFileSync(`${dir}/${name}`, DB);";
const FIX_DRIVE = "    if (existsSync(DB)) copyFileSync(DB, `${DB}.bak-sync`);\n    rmWal(DB);\n    writeFileSync(DB, buf);";
const BUGGY_DRIVE = "    if (existsSync(DB)) copyFileSync(DB, `${DB}.bak-sync`);\n    writeFileSync(DB, buf);";
const TOP_DEF = "// D7: 覆寫 DB 主檔前清掉舊 WAL/SHM，避免 SQLite 讀到舊狀態";
// backupDb stamp 實為 ISO slice(0,14) → 'YYYY-MM-DDHHMM'（分鐘粒度，#2/#3 委員實錘）
const BAK_RE = /teno\.db\.bak-\d{4}-\d{2}-\d{2}\d{4}$/;

function mkDb(p, val) {
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, deck TEXT NOT NULL DEFAULT 'Default',
    tags TEXT DEFAULT '', created_at TEXT, description TEXT DEFAULT '', related TEXT DEFAULT '[]',
    forms TEXT DEFAULT '[]', synonym TEXT NOT NULL DEFAULT '', antonym TEXT NOT NULL DEFAULT '',
    derivative TEXT NOT NULL DEFAULT '', examples TEXT NOT NULL DEFAULT '', definition TEXT,
    part_of_speech TEXT, pronunciation TEXT, example TEXT, image TEXT DEFAULT '');
    CREATE TABLE cards (word_id TEXT PRIMARY KEY, due TEXT, stability REAL, difficulty REAL,
    elapsed_days INTEGER, scheduled_days INTEGER, reps INTEGER, lapses INTEGER, state INTEGER,
    last_review TEXT, buried INTEGER, suspended INTEGER, step INTEGER, mc_data TEXT, spell_data TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT, rating INTEGER,
    elapsed_days INTEGER, scheduled_days INTEGER, stability REAL, difficulty REAL,
    reviewed_at TEXT, duration INTEGER, mode TEXT, card_state INTEGER, new_state INTEGER);`);
  d.prepare("INSERT INTO words (id, word) VALUES ('w1', ?)").run(val);
  d.close();
  return p;
}
const readWord = (p) => new DatabaseSync(p, { readOnly: true }).prepare("SELECT word FROM words WHERE id='w1'").get()?.word;

function runCli(cliPath, argv, env) {
  return spawnSync('node', [cliPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log'), ...env },
    timeout: 60000,
  });
}

try {
  const src = readFileSync(CLI, 'utf8');

  console.log('T1 靜態：rmWal 頂層化＋四呼叫點');
  const restoreBody = src.slice(src.indexOf('function cmdRestore()'), src.indexOf('async function cmdOptimize()'));
  const importBody = src.slice(src.indexOf('function cmdImportDb()'), src.indexOf('// ─── 自我測試'));
  const backupsBody = src.slice(src.indexOf('function cmdBackups()'), src.indexOf('function readdirSyncSafe'));
  const driveBody = src.slice(src.indexOf("audit('drive-upload'"), src.indexOf("audit('drive-download'"));
  T('T1a 頂層 rmWal 定義在場（D7 標記）', src.includes(TOP_DEF));
  T('T1b 全檔僅一處 rmWal 定義（const/function 兩式）', (src.match(/const rmWal\s*=|function\s+rmWal\s*\(/g) || []).length === 1);
  T('T1c cmdRestore 覆寫前 backupDb＋rmWal', restoreBody.includes(FIX_RESTORE));
  T('T1d cmdBackups restore 覆寫前 rmWal', backupsBody.includes(FIX_BKRS));
  T('T1e cmdImportDb 經頂層 rmWal（本地定義已除）', importBody.includes('rmWal(DB)') && !/const rmWal\s*=|function\s+rmWal\s*\(/.test(importBody));
  T('T1f drive download 覆寫前 rmWal（第四條路徑，R1#1 Rust 鏡像同源實錘）', driveBody.includes(FIX_DRIVE));

  console.log('T2 restore 實跑：垃圾 wal 必刪＋覆寫前備份＋數據正確');
  const f2 = join(dir, 't2'); mkdirSync(f2);
  const db2 = mkDb(join(f2, 'teno.db'), 'OLD');
  writeFileSync(db2 + '-wal', 'JUNK-WAL'); writeFileSync(db2 + '-shm', 'JUNK-SHM');
  const src2 = mkDb(join(f2, 'backup-src.db'), 'RESTORED');
  const r2 = runCli(CLI, ['restore', src2], { TENO_DB: db2, TENO_NO_BACKUP: '' }); // 不禁備份：驗 bak 生成
  T('T2a 還原數據正確', readWord(db2) === 'RESTORED');
  T('T2b 殭屍 wal/shm 已刪', !readdirSync(f2).includes('teno.db-wal') && !readdirSync(f2).includes('teno.db-shm'), readdirSync(f2).join(','));
  const baks2 = readdirSync(f2).filter(f => BAK_RE.test(f));
  T('T2c 覆寫前備份已生成', baks2.length === 1, readdirSync(f2).join(','));
  T('T2d 備份內容＝覆寫前舊值（備份時序釘）', baks2.length === 1 && readWord(join(f2, baks2[0])) === 'OLD');

  console.log('T3 backups restore 實跑（Discord bot 路徑）');
  const f3 = join(dir, 't3'); mkdirSync(f3);
  const home3 = join(f3, 'home'); mkdirSync(join(home3, '.config', 'com.teno.app'), { recursive: true });
  const db3 = mkDb(join(f3, 'teno.db'), 'OLD3');
  writeFileSync(db3 + '-wal', 'JUNK-WAL'); writeFileSync(db3 + '-shm', 'JUNK-SHM');
  const named = join(home3, '.config', 'com.teno.app', 'teno.db.bak-20260101000000');
  mkDb(named, 'BKRESTORED');
  const r3 = runCli(CLI, ['backups', 'restore', 'teno.db.bak-20260101000000'], { TENO_DB: db3, HOME: home3, TENO_NO_BACKUP: '' });
  T('T3a 還原數據正確', readWord(db3) === 'BKRESTORED', (r3.stdout || '') + (r3.stderr || ''));
  T('T3b 殭屍 wal/shm 已刪（bot 路徑同修）', !readdirSync(f3).includes('teno.db-wal') && !readdirSync(f3).includes('teno.db-shm'), readdirSync(f3).join(','));

  console.log('T4 import-db 回歸釘：頂層化重構零行為變化');
  const f4 = join(dir, 't4'); mkdirSync(f4);
  const db4 = mkDb(join(f4, 'teno.db'), 'OLD4');
  writeFileSync(db4 + '-wal', 'JUNK-WAL'); writeFileSync(db4 + '-shm', 'JUNK-SHM');
  // TENOC 容器 = 'TENOC'+ver+u32LE(len)+tenoBytes+u32LE(len)+logBytes（selftest §4 同構）
  const teno4 = readFileSync(mkDb(join(f4, 'payload.db'), 'IMPORTED'));
  // D19 承接：log 段改 l2=0 無 log 正品（原 'LOGDATA' 非 SQLite，現行 magic 守門正確拒絕屬預期；
  // 本釘目標是 import 覆寫路徑 rmWal，非 log 段語意——log 段正/拒全家由 verify-d19 覆蓋）
  const logB4 = Buffer.alloc(0);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const packed = Buffer.concat([Buffer.from('TENOC'), Buffer.from([1]), u32(teno4.length), teno4, u32(logB4.length), logB4]);
  const cont4 = join(f4, 'pack.tenoc'); writeFileSync(cont4, packed);
  const r4 = runCli(CLI, ['import-db', cont4], { TENO_DB: db4 });
  T('T4a 匯入數據正確', readWord(db4) === 'IMPORTED', (r4.stdout || '') + (r4.stderr || ''));
  T('T4b 殭屍 wal/shm 已刪', !readdirSync(f4).includes('teno.db-wal') && !readdirSync(f4).includes('teno.db-shm'));

  console.log('T5 負控制：反剝修法 → 殭屍 wal 存活＋restore 無備份 精準重現');
  let buggy = src;
  if (src.includes(FIX_RESTORE)) buggy = buggy.replace(FIX_RESTORE, BUGGY_RESTORE);
  if (src.includes(FIX_BKRS)) buggy = buggy.replace(FIX_BKRS, BUGGY_BKRS);
  if (src.includes(FIX_DRIVE)) buggy = buggy.replace(FIX_DRIVE, BUGGY_DRIVE);
  T('T5a 負控制源碼已剝（不含 FIX 契約行；反空洞：剝除必須真實發生）',
    src.includes(FIX_RESTORE) || src.includes(FIX_BKRS) || src.includes(FIX_DRIVE)
      ? (buggy !== src && !buggy.includes(FIX_RESTORE) && !buggy.includes(FIX_BKRS) && !buggy.includes(FIX_DRIVE))
      : (!buggy.includes(FIX_RESTORE) && !buggy.includes(FIX_BKRS) && !buggy.includes(FIX_DRIVE)));
  const bugDir = join(dir, 'bugsub'); mkdirSync(bugDir);
  symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
  writeFileSync(join(bugDir, 'cli.mjs'), buggy);
  const f5 = join(dir, 't5'); mkdirSync(f5);
  const db5 = mkDb(join(f5, 'teno.db'), 'OLD5');
  writeFileSync(db5 + '-wal', 'JUNK-WAL'); writeFileSync(db5 + '-shm', 'JUNK-SHM');
  const src5 = mkDb(join(f5, 'backup-src.db'), 'RESTORED5');
  const r5 = runCli(join(bugDir, 'cli.mjs'), ['restore', src5], { TENO_DB: db5, TENO_NO_BACKUP: '' });
  T('T5b 負控制 restore 後殭屍 wal 仍存活', readdirSync(f5).includes('teno.db-wal') && readdirSync(f5).includes('teno.db-shm'), readdirSync(f5).join(','));
  T('T5c 負控制 restore 無覆寫前備份', readdirSync(f5).filter(f => BAK_RE.test(f)).length === 0);
  const f6 = join(dir, 't6'); mkdirSync(f6);
  const home6 = join(f6, 'home'); mkdirSync(join(home6, '.config', 'com.teno.app'), { recursive: true });
  const db6 = mkDb(join(f6, 'teno.db'), 'OLD6');
  writeFileSync(db6 + '-wal', 'JUNK-WAL');
  mkDb(join(home6, '.config', 'com.teno.app', 'teno.db.bak-20260101000000'), 'BK6');
  const r6 = runCli(join(bugDir, 'cli.mjs'), ['backups', 'restore', 'teno.db.bak-20260101000000'], { TENO_DB: db6, HOME: home6, TENO_NO_BACKUP: '' });
  T('T5d 負控制 backups restore 後殭屍 wal 仍存活', readdirSync(f6).includes('teno.db-wal'), readdirSync(f6).join(','));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-d7: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
