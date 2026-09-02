#!/usr/bin/env node
// verify-e10-selftest-container.mjs — E10: selftest 容器檢查 `|| true` 恆真（哨兵失明）。
// 修法＝斷言改寫真實容錯契約（raw fallback）＋標籤誠實化＋補截斷頭態。
// 全部 tmp DB，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'e10-verify-'));

const FIX_A = "check('容器 非SQLite raw fallback'";
const FIX_B = "check('容器 截斷頭 raw fallback'";
const HEAD_LINE = "check('容器 拒絕非SQLite', unpackContainer(Buffer.from('GARBAGE')).teno.length === 7 || true, '(CLI 端容錯, Rust 端嚴格)');";
// 變異：容錯契約兩條 fallback 分支都改成錯誤形狀（E10 弱斷言看不見、真斷言必紅）
const FB = 'return { teno: data, log: null };';
const FB_BAD = 'return { teno: data.subarray(0, 3), log: data };';

function mkDb(p) {
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
  d.close();
  return p;
}
function runSt(cliPath, dbPath) {
  return spawnSync('node', [cliPath, 'selftest'], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
const failCnt = (out) => { const m = out.match(/結果: \d+ 通過 \/ (\d+) 失敗/); return m ? +m[1] : -1; };
function variantSrc(s) {
  const d2 = mkdtempSync(join(dir, 'v-')); // mkdtempSync 已建目錄
  if (!existsSync(join(dir, 'src'))) symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
  writeFileSync(join(d2, 'cli.mjs'), s);
  return { p: join(d2, 'cli.mjs'), db: mkDb(join(d2, 'teno.db')) };
}
const mutate = (s) => {
  const n = s.split(FB).length - 1;
  if (n !== 2) throw new Error(`fallback 分支非 2 條（實 ${n}），測資假設過時`);
  return s.replaceAll(FB, FB_BAD);
};

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(FIX_A) && src.includes(FIX_B);

  console.log('T1 真碼 selftest → 新檢查 ✅＋失敗 0');
  {
    const d2 = mkdtempSync(join(dir, 't1'));
    const db = mkDb(join(d2, 'teno.db'));
    const r = runSt(CLI, db);
    T('T1a 容器 非SQLite raw fallback ✅', /✅ 容器 非SQLite raw fallback/.test(r.stdout));
    T('T1b 容器 截斷頭 raw fallback ✅', /✅ 容器 截斷頭 raw fallback/.test(r.stdout));
    T('T1c selftest 失敗 0', failCnt(r.stdout) === 0, `fail=${failCnt(r.stdout)}`);
  }

  console.log('T2 源碼釘：恆真殘留零＋凍結字面量在位');
  T('T2a 弱斷言「|| true」容器段零殘留', !src.includes(HEAD_LINE) && !/\.teno\.length === 7 \|\| true/.test(src));
  T('T2b 凍結字面量雙條在位', src.includes(FIX_A) && src.includes(FIX_B));

  console.log('T3 牙檢：負控制（弱斷言+變異=全綠失明）vs 修法（同變異必紅）');
  if (fixed) {
    const headSrc = src.replace(
      src.slice(src.indexOf('    // E10:'), src.indexOf(FIX_B) + src.slice(src.indexOf(FIX_B)).indexOf('\n')),
      '    ' + HEAD_LINE);
    T('T3a 反換真實性（HEAD 弱斷言復原＋新條消失）',
      headSrc.includes(HEAD_LINE) && !headSrc.includes(FIX_A) && headSrc !== src);
    const v1 = variantSrc(mutate(headSrc));       // 弱斷言 × 變異
    const v2 = variantSrc(mutate(src));           // 修法 × 變異
    const r1 = runSt(v1.p, v1.db);
    const r2 = runSt(v2.p, v2.db);
    T('T3b 負控制：弱斷言×變異 → selftest 仍全綠（E10 失明重現）',
      failCnt(r1.stdout) === 0 && /✅ 容器 拒絕非SQLite/.test(r1.stdout), `fail=${failCnt(r1.stdout)}`);
    T('T3c 修法×同變異 → 必紅（真斷言有牙）',
      failCnt(r2.stdout) >= 1 && /❌ 容器 非SQLite raw fallback/.test(r2.stdout) && /❌ 容器 截斷頭 raw fallback/.test(r2.stdout), `fail=${failCnt(r2.stdout)}`);
  } else {
    const v1 = variantSrc(mutate(src));
    const r1 = runSt(v1.p, v1.db);
    T('T3b 負控制（工作區即原版）：變異下恆綠', failCnt(r1.stdout) === 0);
    T('T3c 修法缺席（待修）', false, '工作區未含修法');
  }

  console.log('T4 契約源碼釘：容錯 fallback 分支未被反向遷就（真碼仍 raw fallback）');
  {
    const cur = readFileSync(CLI, 'utf8');
    const uStart = cur.indexOf('function unpackContainer');
    const uSec = cur.slice(uStart, cur.indexOf('\n}', uStart) + 2);
    T('T4 兩分支皆 raw fallback（斷言遷就契約非反之）',
      uSec.includes(FB) && !uSec.includes(FB_BAD) && (uSec.split(FB).length - 1) === 2);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-e10: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
