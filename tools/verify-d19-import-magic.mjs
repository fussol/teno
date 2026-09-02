#!/usr/bin/env node
// verify-d19-import-magic.mjs — D19: import-db 零驗證，垃圾/截斷容器直接覆寫主 DB。
// 修法＝unpack 後 magic 守門（拒絕時不碰 backupDb/rmWal/writeFileSync/audit）。
// 全部 tmp DB，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'd19-verify-'));

const D19_MARK = '// D19: magic 守門';
const SEC_START = 'function cmdImportDb() {';
const SEC_END = '// ─── 自我測試';
// 舊版 cmdImportDb 本體（2026-08-28 git HEAD 逐字，負控制反換用）
const ORIGINAL_BLOCK = `function cmdImportDb() {
  const src = args[0];
  if (!src || !existsSync(src)) return console.log(\`需: import-db <檔案> (\${src ?? ''})\`);
  const data = readFileSync(src);
  const { teno: tenoBytes, log: logBytes } = unpackContainer(data);
  backupDb();
  // D7: 覆寫前清掉舊 WAL/SHM（頂層 rmWal，語意同原本地定義）
  rmWal(DB);
  writeFileSync(DB, tenoBytes);
  if (logBytes) { rmWal(appLogDbPath()); writeFileSync(appLogDbPath(), logBytes); }
  console.log(\`✅ 已匯入 \${src} (teno.db=\${(tenoBytes.length / 1024 / 1024).toFixed(2)} MB\${logBytes ? \`, app-log.db=\${(logBytes.length / 1024 / 1024).toFixed(2)} MB\` : ', 無操作日誌'})\`);
  log('WRITE', \`import-db \${src} teno=\${tenoBytes.length}b log=\${logBytes ? logBytes.length : 0}b\`);
  audit('import-db', \`匯入 DB \${args[0] || ''}\`);
}

`;

const GARBAGE = Buffer.from('hello, this is not a database\n重現用垃圾檔\n'.repeat(80));
const MAGIC = 'SQLite format 3\0';
const isMagic = (b) => b.length >= 16 && b.subarray(0, 16).toString('latin1') === MAGIC;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const packC = (teno, log) => Buffer.concat([Buffer.from('TENOC'), Buffer.from([1]), u32(teno.length), teno, u32(log ? log.length : 0), log || Buffer.alloc(0)]);

// 真 SQLite 檔（settings 表＝CLI 頂層 DAY_CUTOFF 必需；t 表＝內容指紋）
function mkSqlite(p, marker) {
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE audit_log (ts INTEGER, action TEXT, detail TEXT);`);
  d.prepare('INSERT INTO t VALUES (?,?)').run('marker', marker);
  d.close();
  return p;
}
const markerOf = (p) => { try { return new DatabaseSync(p, { readOnly: true }).prepare("SELECT v FROM t WHERE k='marker'").get()?.v; } catch { return undefined; } };
function runImport(cliPath, file, targetDb) {
  return spawnSync('node', [cliPath, 'import-db', file], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: targetDb, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
// 目標一律命名 teno.db（appLogDbPath = DB.replace(teno.db$→app-log.db)，副作用路徑真實）
function mkTarget(tag) { const d2 = join(dir, tag); mkdirSync(d2); return mkSqlite(join(d2, 'teno.db'), 'TGT'); }

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(D19_MARK);

  console.log('T1 raw 真 SQLite → 匯入成功（兼容 raw 是功能，回歸釘）');
  {
    const raw = mkSqlite(join(dir, 'raw1.db'), 'SRCRAW');
    const tgt = mkTarget('t1');
    const before = readFileSync(tgt);
    const r = runImport(CLI, raw, tgt);
    T('T1a raw 真 DB 匯入成功', r.stdout.includes('已匯入') && markerOf(tgt) === 'SRCRAW', r.stdout.trim().split('\n').pop());
    // 成功路徑 audit 必須記錄（正例釘，與 T3c/T4c/T5c/T6c 零記錄反例對稱）
    T('T1b 成功後 audit_log 有 import-db 記錄', (() => { try { return new DatabaseSync(tgt, { readOnly: true }).prepare("SELECT count(*) n FROM audit_log WHERE action='import-db'").get().n >= 1; } catch { return false; } })());
  }

  console.log('T2 合法 TENOC 容器 → 成功＋log 段落地');
  {
    const teno = readFileSync(mkSqlite(join(dir, 'ct.db'), 'CTENO'));
    const logb = readFileSync(mkSqlite(join(dir, 'cl.db'), 'CLOG'));
    const cf = join(dir, 'ok.tenoc'); writeFileSync(cf, packC(teno, logb));
    const tgt = mkTarget('t2');
    const r = runImport(CLI, cf, tgt);
    const logOut = tgt.replace(/teno\.db$/, 'app-log.db');
    T('T2a 容器匯入成功＋teno 段正確', r.stdout.includes('已匯入') && markerOf(tgt) === 'CTENO', r.stdout.trim().split('\n').pop());
    T('T2b app-log.db 落地且為真 SQLite', existsSync(logOut) && markerOf(logOut) === 'CLOG');
  }

  console.log('T3-T6 拒絕路徑：DB 逐字節不變＋零 audit＋exit 1');
  // R1#3 mutE：凍結精確字面量（契約見計畫 §3 v1.1），寬鬆 '拒絕' 可被 log() 雙通道稀釋
  const REJECT_LIT = '❌ 拒絕匯入';
  const rejectChecks = (name, tgt, before, r, af) => {
    T(`${name}a 拒絕（凍結字面量+exit 1）`, r.stdout.includes(REJECT_LIT) && r.status === 1, `status=${r.status} | ${r.stdout.trim().split('\n').pop()}`);
    T(`${name}b DB 逐字節不變`, readFileSync(tgt).equals(before));
    try {
      const n = new DatabaseSync(tgt, { readOnly: true }).prepare("SELECT count(*) n FROM audit_log WHERE action='import-db'").get().n;
      T(`${name}c 零 audit 記錄`, n === 0, String(n));
    } catch (e) { T(`${name}c 零 audit 記錄`, false, e.message); }
    T(`${name}d 無 app-log 副作用`, !existsSync(af));
  };
  {
    const gf = join(dir, 'garbage.txt'); writeFileSync(gf, GARBAGE);
    const tgt = mkTarget('t3'); const before = readFileSync(tgt);
    rejectChecks('T3', tgt, before, runImport(CLI, gf, tgt), join(dir, 't3', 'app-log.db'));
  }
  { // 截斷容器：header/l1 合法但檔長不足 → 舊版 fallback 整檔（含 TENOC 頭）當 raw
    const full = packC(readFileSync(mkSqlite(join(dir, 'tt.db'), 'TT')), null);
    const tf = join(dir, 'trunc.tenoc'); writeFileSync(tf, full.subarray(0, Math.floor(full.length / 2)));
    const tgt = mkTarget('t4'); const before = readFileSync(tgt);
    rejectChecks('T4', tgt, before, runImport(CLI, tf, tgt), join(dir, 't4', 'app-log.db'));
    T('T4e 測資確為截斷容器（TENOC 頭＋magic 缺失）', tf && readFileSync(tf).subarray(0, 5).toString('latin1') === 'TENOC' && !isMagic(readFileSync(tf)));
  }
  { // 容器結構完整、teno 段＝垃圾
    const ff = join(dir, 'fake.tenoc'); writeFileSync(ff, packC(GARBAGE, null));
    const tgt = mkTarget('t5'); const before = readFileSync(tgt);
    rejectChecks('T5', tgt, before, runImport(CLI, ff, tgt), join(dir, 't5', 'app-log.db'));
  }
  { // teno 真＋log 段垃圾 → 全拒（容器一致性）
    const cf = join(dir, 'badlog.tenoc');
    writeFileSync(cf, packC(readFileSync(mkSqlite(join(dir, 'rl.db'), 'RL')), GARBAGE));
    const tgt = mkTarget('t6'); const before = readFileSync(tgt);
    rejectChecks('T6', tgt, before, runImport(CLI, cf, tgt), join(dir, 't6', 'app-log.db'));
    T('T6e 拒絕理由指向 log 段', (() => { const r = runImport(CLI, cf, tgt); return r.stdout.includes(REJECT_LIT) && /log|日誌/.test(r.stdout); })());
  }

  console.log('T7 回歸釘');
  {
    const tgt = mkTarget('t7');
    const r = runImport(CLI, join(dir, 'no-such-file.db'), tgt);
    T('T7a 檔案不存在提示不變', r.stdout.includes('需: import-db'));
    const phone = join(process.env.HOME || '', '文件/Teno db檔/phone-db.db');
    if (existsSync(phone)) {
      const tgt2 = mkTarget('t7b');
      const r2 = runImport(CLI, phone, tgt2);
      T('T7b 真實手機備份（raw）匯入成功', r2.stdout.includes('已匯入') && isMagic(readFileSync(tgt2)));
    } else {
      console.log('  ⏭ SKIPPED T7b（真實手機備份檔不在場）');
    }
  }

  console.log('T9 --no-log 容器（l2=0）正品路徑（R1#1/#2 阻斷洞：空 log 段＝無 log，不驗不拒不寫）');
  {
    const cf = join(dir, 'nolog.tenoc');
    writeFileSync(cf, packC(readFileSync(mkSqlite(join(dir, 'nl.db'), 'NLOG0')), null)); // l2=0，逐字對齊 packContainer(includeLog=false)
    const tgt = mkTarget('t9');
    const r = runImport(CLI, cf, tgt);
    T('T9a l2=0 容器匯入成功（app export-db --no-log 正品不被誤拒）', r.stdout.includes('已匯入') && r.status === 0 && markerOf(tgt) === 'NLOG0', r.stdout.trim().split('\n').pop());
    T('T9b app-log.db 零觸及（不建立不清零，鏡像 Rust write_db_container if !log.is_empty()）', !existsSync(join(dir, 't9', 'app-log.db')));
  }

  console.log('T10 合法 magic＋截斷偽檔（R1#3 mutB：length>=100 門檻釘）');
  {
    const realMagic = Buffer.from(MAGIC, 'latin1');
    for (const total of [32, 99]) {
      const pf = join(dir, `fakecut-${total}.db`);
      writeFileSync(pf, Buffer.concat([realMagic, Buffer.alloc(total - 16, 0x5a)]));
      const tgt = mkTarget(`t10-${total}`); const before = readFileSync(tgt);
      const r = runImport(CLI, pf, tgt);
      T(`T10 截斷偽檔 ${total}B 拒絕＋DB 不變`, r.status === 1 && readFileSync(tgt).equals(before));
    }
  }

  console.log('T8 負控制：舊版 cmdImportDb 反換 → 垃圾直入精準重現');
  {
    const s0 = src.indexOf(SEC_START), s1 = src.indexOf(SEC_END);
    let buggySrc;
    if (fixed) {
      buggySrc = src.slice(0, s0) + ORIGINAL_BLOCK + src.slice(s1);
      T('T8a 反換真實性（剝後無守門＋區段在位）', !buggySrc.includes('isSqlite') && s0 >= 0 && s1 > s0 && buggySrc !== src);
    } else {
      buggySrc = src;
      T('T8a 反換真實性（工作區即原版）', !buggySrc.includes('isSqlite'));
    }
    const bugDir = join(dir, 'bugsub'); mkdirSync(bugDir);
    symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
    writeFileSync(join(bugDir, 'cli.mjs'), buggySrc);
    const gf = join(dir, 'garbage.txt'); if (!existsSync(gf)) writeFileSync(gf, GARBAGE);
    const tgt = mkTarget('t8');
    const r = runImport(join(bugDir, 'cli.mjs'), gf, tgt);
    T('T8b 負控制垃圾直入（DB＝垃圾字節＝原損壞）', readFileSync(tgt).equals(GARBAGE), `marker=${markerOf(tgt)}`);
    T('T8c 負控制照樣宣稱成功', r.stdout.includes('已匯入') && !r.stdout.includes(REJECT_LIT));
    // mutC 順序釘（源碼級，fixed 條件生效）：守門必須在 backupDb() 之前（拒絕不備份）
    // R2#3 必修：比較限 [SEC_START, SEC_END) 切片內——全域 indexOf 會越函式匹到
    // cmdExamSessions 的 backupDb() 致恆真（mutC 全綠實錘）
    if (fixed) {
      const sec0 = src.indexOf(SEC_START), secE = src.indexOf(SEC_END);
      const markIdx = src.indexOf(D19_MARK), bakIdx = src.indexOf('backupDb()', markIdx);
      T('T8d 守門順序釘：D19 標記在 backupDb() 之前（區段內）', markIdx > sec0 && bakIdx > markIdx && bakIdx < secE, `mark=${markIdx} bak=${bakIdx} secE=${secE}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-d19: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
