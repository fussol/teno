#!/usr/bin/env node
// verify-e13-simparams-guard.mjs — E13: simparams set 用 parseFloat 零驗證 →
// NaN 經 JSON.stringify 序列化 null 落盤 settings.simParams（store.js:363
// {...DEFAULT_SIM, ...simParams} null 覆蓋預設值、下游 ?? 0 靜默降級，無錯誤回聲）
// ＋'5abc' 部分截斷靜默入库。修法＝Number() 全字串語意＋trim 空堵＋isFinite 閘，
// 拒絕＝凍結字面量＋exit 1＋零副作用（守門在 backupDb/writeSetting 之前）。
// 全部 tmp DB，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'e13-verify-'));

const E13_MARK = '// E13: 寫入守門';
const REJECT_LIT = '❌ 值須為有限數字';
// 修法段（讀檔逐字比對用）＋原版單行（負控制反換用；git HEAD 2026-08-28 逐字）
const FIXED_BLOCK = `    // E13: 寫入守門——parseFloat NaN 經 JSON.stringify 序列化 null 落盤污染
    // （store.js:363 {...DEFAULT_SIM, ...simParams} null 覆蓋預設值，無錯誤回聲）；
    // '5abc' 部分截斷同堵——Number 全字串語意（'5abc'→NaN），'' →0 陷阱另堵 trim 空。
    const num = Number(value.trim());
    if (value.trim() === '' || !Number.isFinite(num)) { process.exitCode = 1; return console.log(\`❌ 值須為有限數字（收到 "\${value}"）\`); }
    s[key] = num;`;
const ORIG_LINE = `    s[key] = parseFloat(value);`;
const PRE_SEED = '{"humanSkipRate":8}'; // DEFAULT_SIM.humanSkipRate 原值語義

function mkDb(p) {
  const d = new DatabaseSync(p);
  d.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings(key,value) VALUES ('simParams','${PRE_SEED}');
  `);
  d.close();
  return p;
}
const simParamsRaw = (p) => {
  try { return new DatabaseSync(p, { readOnly: true }).prepare("SELECT value v FROM settings WHERE key='simParams'").get()?.v; }
  catch { return undefined; }
};
const bakFiles = (dbPath) => readdirSync(dirname(dbPath)).filter(f => f.startsWith('teno.db.bak-'));

function runCli(cliPath, argv, db, { noBackup = '1' } = {}) {
  const env = { ...process.env, TENO_DB: db, TENO_LOG: join(dir, 'cli.log') };
  if (noBackup) env.TENO_NO_BACKUP = '1'; else delete env.TENO_NO_BACKUP;
  return spawnSync('node', [cliPath, ...argv], { encoding: 'utf8', env, timeout: 60000 });
}
function mkTarget(tag) { const d2 = join(dir, tag); mkdirSync(d2); return mkDb(join(d2, 'teno.db')); }

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(E13_MARK);
  console.log(`[mode] ${fixed ? '修法版' : '原版(HEAD)'} — 雙態皆可跑：修法版斷言全綠，原版由 T5 負控制重現\n`);

  console.log('T1 合法寫入主鏈（exit 0＋落庫為數字＋成功路徑備份照常）');
  {
    const tgt = mkTarget('t1');
    const r = runCli(CLI, ['simparams', 'set', 'humanSkipRate', '0.3'], tgt);
    T('T1a exit 0＋無拒絕字面量', r.status === 0 && !r.stdout.includes(REJECT_LIT), `status=${r.status} out=${r.stdout.trim().slice(0, 80)}`);
    const v = (() => { try { return JSON.parse(simParamsRaw(tgt)).humanSkipRate; } catch { return 'PARSE_FAIL'; } })();
    T('T1b 落庫值 === 0.3（數字非字串非 null）', v === 0.3, `v=${JSON.stringify(v)} raw=${simParamsRaw(tgt)}`);
  }
  console.log('T1c 成功路徑備份被呼（未設 NO_BACKUP → bak 檔生成）');
  {
    const tgt = mkTarget('t1c');
    const r = runCli(CLI, ['simparams', 'set', 'humanJitter', '20'], tgt, { noBackup: '' });
    const baks = bakFiles(tgt);
    T('T1c bak- 檔存在＋值落庫', r.status === 0 && baks.length >= 1 && JSON.parse(simParamsRaw(tgt)).humanJitter === 20, `baks=${baks.join(',')}`);
  }

  console.log('T2 壞態精準拒絕（凍結字面量＋exit 1＋settings 零變動＋零備份）');
  for (const [tag, badVal, why] of [
    ['T2a', 'garbage', '非數字→NaN→原落盤 null'],
    ['T2b', '5abc', '部分截斷態（parseFloat 靜默 5）'],
    ['T2c', '', '空串（Number("")=0 陷阱，trim 空堵）'],
    ['T2d', 'Infinity', 'JSON.stringify(Infinity)=null 同族污染'],
    ['T2e', 'NaN', '字面 NaN'],
  ]) {
    const tgt = mkTarget(tag.toLowerCase());
    const r = runCli(CLI, ['simparams', 'set', 'humanSkipRate', badVal], tgt, { noBackup: '' });
    T(`${tag} 拒絕「${badVal || '(空串)'}」(${why})`, r.status === 1 && r.stdout.includes(REJECT_LIT), `status=${r.status} out=${r.stdout.trim().slice(0, 90)}`);
    T(`${tag}b settings 逐字不變＋零備份`, simParamsRaw(tgt) === PRE_SEED && bakFiles(tgt).length === 0, `raw=${simParamsRaw(tgt)} baks=${bakFiles(tgt).length}`);
  }

  console.log('T3 合法變體收（Number 全字串語意＋0 非 falsy 誤拒）');
  for (const [val, expect] of [['5', 5], [' 5 ', 5], ['+5', 5], ['5e2', 500], ['-1.5', -1.5], ['0', 0]]) {
    const tgt = mkTarget('t3_' + Buffer.from(val).toString('hex'));
    const r = runCli(CLI, ['simparams', 'set', 'maxReviewsPerDay', val], tgt);
    const v = (() => { try { return JSON.parse(simParamsRaw(tgt)).maxReviewsPerDay; } catch { return 'PARSE_FAIL'; } })();
    T(`T3 「${val}」→ ${expect}`, r.status === 0 && v === expect, `status=${r.status} v=${JSON.stringify(v)}`);
  }

  console.log('T4 get 回歸釘（無 sub 輸出 JSON、exit 0）');
  {
    const tgt = mkTarget('t4');
    const r = runCli(CLI, ['simparams'], tgt);
    T('T4 輸出含預設 seed 值＋exit 0', r.status === 0 && r.stdout.includes('"humanSkipRate": 8'), `out=${r.stdout.trim().slice(0, 80)}`);
  }

  console.log('T5 負控制（原版 HEAD 反換 → null 落盤＋5abc 靜默截斷 精準重現）');
  {
    // 以「當前工作區版」反換：若工作區=修法版→反換出原版語義；若工作區=原版→正換出修法版（雙向自適應）
    // clone 必須與 repo 同深度（cli.mjs 相對 import ../src/...）→ <tmp>/sub/tools/＋symlink src
    const subDir = join(dir, 'sub');
    mkdirSync(join(subDir, 'tools'), { recursive: true });
    if (!existsSync(join(subDir, 'src'))) symlinkSync(join(REPO, 'src'), join(subDir, 'src'), 'dir');
    const clone = join(subDir, 'tools', 'cli-sub.mjs');
    let buggy;
    if (fixed) {
      if (!src.includes(FIXED_BLOCK)) throw new Error('FIXED_BLOCK 與工作區逐字不符（修法段被改寫？先同步腳本）');
      buggy = src.replace(FIXED_BLOCK, ORIG_LINE);
    } else {
      if (!src.includes(ORIG_LINE)) throw new Error('原版 s[key]=parseFloat 行不在場，無法重建負控制');
      buggy = src.replace(ORIG_LINE, FIXED_BLOCK);
    }
    if (buggy === src) throw new Error('負控制替換未生效（buggy===src）');
    writeFileSync(clone, buggy);
    const isRevert = fixed; // true=測原版重現 bug；false=測重建修法版綠
    {
      const tgt = mkTarget('t5a');
      const r = runCli(clone, ['simparams', 'set', 'humanSkipRate', 'garbage'], tgt, { noBackup: '' });
      const raw = simParamsRaw(tgt);
      if (isRevert) {
        T('T5a 原版×garbage → {"humanSkipRate":null} 落盤＋exit 0（無回聲）', raw === '{"humanSkipRate":null}' && r.status === 0, `raw=${raw} status=${r.status}`);
      } else {
        T('T5a 重建修法版×garbage → 拒絕（自適應綠）', r.status === 1 && r.stdout.includes(REJECT_LIT) && raw === PRE_SEED, `raw=${raw} status=${r.status}`);
      }
    }
    {
      const tgt = mkTarget('t5b');
      const r = runCli(clone, ['simparams', 'set', 'humanSkipRate', '5abc'], tgt, { noBackup: '' });
      const raw = simParamsRaw(tgt);
      if (isRevert) {
        T('T5b 原版×5abc → 靜默截斷 5 入库', raw === '{"humanSkipRate":5}' && r.status === 0, `raw=${raw} status=${r.status}`);
      } else {
        T('T5b 重建修法版×5abc → 拒絕（自適應綠）', r.status === 1 && raw === PRE_SEED, `raw=${raw} status=${r.status}`);
      }
    }
    console.log(`  ℹ️ 負控制方向=${isRevert ? '反換重現 bug' : '正換重建修法版'}`);
  }

  console.log('T6 結構釘（源碼層）');
  {
    const fn = src.slice(src.indexOf('function cmdSimParams()'), src.indexOf('function cmdFilteredDecks'));
    T('T6a 守門存在（Number＋isFinite＋trim 空 三要素）', /Number\(value\.trim\(\)\)/.test(fn) && /Number\.isFinite\(num\)/.test(fn) && /value\.trim\(\) === ''/.test(fn));
    T('T6b parseFloat 殲滅（set 分支零殘留）', !/parseFloat\(value\)/.test(fn));
    T('T6c 守門位置先於 backupDb/writeSetting（零副作用順序）', (() => {
      const g = fn.indexOf('值須為有限數字'), b = fn.indexOf('backupDb()');
      return g !== -1 && b !== -1 && g < b;
    })());
    T('T6d exitCode 1 拒绝路徑釘', /process\.exitCode = 1/.test(fn));
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\n結果: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : ''}`);
process.exit(fail === 0 ? 0 : 1);
