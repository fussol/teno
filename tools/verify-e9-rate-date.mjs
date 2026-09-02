#!/usr/bin/env node
// verify-e9-rate-date.mjs — E9: rate --date 零驗證（Invalid time value 難懂堆疊＋
// 2026-02-30 V8 靜默 rollover 資料污染＋缺值靜默無沙箱）。修法＝regex+finite+round-trip 三重閘。
// 全部 tmp DB，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
const dir = mkdtempSync(join(tmpdir(), 'e9-verify-'));

const E9_MARK = '// E9: --date 強驗證';
const REJECT_LIT = '❌ --date 需有效日期';
// 原版兩行（負控制反換用；git HEAD 2026-08-28 逐字）
const ORIG_PAIR = `  const rateDate = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
  const rateNow = rateDate ? new Date(rateDate + 'T08:00:00Z').getTime() : Date.now();`;

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
    INSERT INTO words(id,word) VALUES ('w1','apple');
    INSERT INTO cards(word_id,due,state,reps,stability,difficulty,last_review)
      VALUES ('w1','2026-08-20T08:00:00.000Z',2,3,10.5,6.2,'2026-08-20T08:00:00.000Z');
  `);
  d.close();
  return p;
}
function run(cliPath, argv, db) {
  return spawnSync('node', [cliPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: db, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
const cardOf = (p) => { try { return new DatabaseSync(p, { readOnly: true }).prepare("SELECT due,stability,reps,state FROM cards WHERE word_id='w1'").get(); } catch { return null; } };
const logCnt = (p) => { try { return new DatabaseSync(p, { readOnly: true }).prepare("SELECT count(*) n FROM review_log").get().n; } catch { return -1; } };
const lastLogAt = (p) => { try { return new DatabaseSync(p, { readOnly: true }).prepare("SELECT reviewed_at v FROM review_log ORDER BY id DESC LIMIT 1").get()?.v; } catch { return undefined; } };
function mkTarget(tag) { const d2 = join(dir, tag); mkdirSync(d2); return mkDb(join(d2, 'teno.db')); }

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(E9_MARK);

  console.log('T1 有效日期 → 評分成功＋沙箱語意不變（reviewed_at=輸入日期）');
  {
    const tgt = mkTarget('t1');
    const r = run(CLI, ['rate', 'w1', '3', '--date', '2026-08-22'], tgt);
    T('T1a 評分成功＋exit 0', r.stdout.includes('rating=3') && r.status === 0, r.stdout.trim().split('\n').pop());
    T('T1b reviewed_at 沙箱生效（2026-08-22，非今日）', (lastLogAt(tgt) || '').startsWith('2026-08-22'), `reviewed_at=${lastLogAt(tgt)}`);
    T('T1c elapsed 沙箱日計（8/20→8/22＝2）', (() => { try { return new DatabaseSync(tgt, { readOnly: true }).prepare("SELECT elapsed_days e FROM review_log ORDER BY id DESC LIMIT 1").get().e === 2; } catch { return false; } })());
  }

  console.log('T2 四壞態精準拒絕（凍結字面量＋exit 1＋零寫入）');
  for (const [tag, badargv, why] of [
    ['T2a', ['rate', 'w1', '3', '--date', 'garbage'], '非日期字串'],
    ['T2b', ['rate', 'w1', '3', '--date', '2026-13-45'], '月13拒解析'],
    ['T2c', ['rate', 'w1', '3', '--date', '2026-02-30'], 'day 溢出 rollover 態'],
    ['T2d', ['rate', 'w1', '3', '--date'], '末位缺值'],
  ]) {
    const tgt = mkTarget(`e9-${tag}`);
    const c0 = cardOf(tgt);
    const r = run(CLI, badargv, tgt);
    T(`${tag} 拒絕（${why}）：字面量+exit 1`, r.stdout.includes(REJECT_LIT) && r.status === 1, `status=${r.status}`);
    T(`${tag} 零寫入（cards 不變＋log 0 筆）`, JSON.stringify(cardOf(tgt)) === JSON.stringify(c0) && logCnt(tgt) === 0);
  }
  { // rollover 专项：拒絕的 2/30 不得有任何 3/2 系痕迹
    const tgt = mkTarget('e9-roll');
    run(CLI, ['rate', 'w1', '3', '--date', '2026-02-30'], tgt);
    T('T2e rollover 態零 3/2 資料入庫', logCnt(tgt) === 0 && !String(cardOf(tgt)?.due).includes('2026-03'), `due=${cardOf(tgt)?.due}`);
  }

  console.log('T3 帶時間尾巴 → 拒（date-only 契約，要全 ISO 用 sim --now）');
  {
    const tgt = mkTarget('t3');
    const r = run(CLI, ['rate', 'w1', '3', '--date', '2026-08-20T12:00'], tgt);
    T('T3 拒絕', r.stdout.includes(REJECT_LIT) && r.status === 1 && logCnt(tgt) === 0);
  }

  console.log('T4 無 --date 正常評分（回歸釘）');
  {
    const tgt = mkTarget('t4');
    const r = run(CLI, ['rate', 'w1', '2'], tgt);
    T('T4 評分成功＋log 1 筆＋exit 0', r.stdout.includes('rating=2') && logCnt(tgt) === 1 && r.status === 0);
  }

  console.log('T5 負控制：守門反換 → RangeError 堆疊＋2/30 靜默 rollover 污染重現');
  {
    let buggySrc;
    if (fixed) {
      // 反換＝把「E9 標記起至 rateNow 行」換回 HEAD 原兩行
      const mStart = src.indexOf(E9_MARK);
      const cut = src.lastIndexOf('\n', mStart) + 1; // 切在標記行行首（連標記行一併剝除）
      const rnLine = "  const rateNow = rateDate ? new Date(rateDate + 'T08:00:00Z').getTime() : Date.now();";
      const mEnd = src.indexOf(rnLine) + rnLine.length;
      buggySrc = src.slice(0, cut) + rnLine + src.slice(mEnd);
      T('T5a 反換真實性（剝後無守門＋rateNow 行在位）',
        !buggySrc.includes(E9_MARK) && buggySrc.includes(rnLine) && buggySrc !== src &&
        buggySrc.includes(ORIG_PAIR.split('\n')[0]) && buggySrc.includes(rnLine));
    } else {
      buggySrc = src;
      T('T5a 反換真實性（工作區即原版）', !buggySrc.includes(E9_MARK));
    }
    const bugDir = join(dir, 'bugsub'); mkdirSync(bugDir);
    if (!existsSync(join(dir, 'src'))) symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
    writeFileSync(join(bugDir, 'cli.mjs'), buggySrc);
    const BCLI = join(bugDir, 'cli.mjs');
    {
      const tgt = mkTarget('t5g');
      const r = run(BCLI, ['rate', 'w1', '3', '--date', 'garbage'], tgt);
      T('T5b 負控制 garbage → Invalid time value 難懂錯重現',
        /Invalid time value/.test(r.stderr + r.stdout) && !r.stdout.includes(REJECT_LIT) && logCnt(tgt) === 0);
    }
    {
      const tgt = mkTarget('t5r');
      const r = run(BCLI, ['rate', 'w1', '3', '--date', '2026-02-30'], tgt);
      const at = lastLogAt(tgt);
      T('T5c 負控制 2/30 靜默 rollover 污染重現（宣稱成功＋reviewed_at=2026-03-02）',
        r.stdout.includes('rating=3') && String(at).startsWith('2026-03-02'), `reviewed_at=${at}`);
    }
    if (fixed) {
      const markIdx = src.indexOf(E9_MARK);
      const inj = src.indexOf('Date.now = () => rateNow', markIdx);
      const secEnd = src.indexOf('function cmdSim()', markIdx);
      T('T5d 守門順序釘：E9 標記在沙箱注入之前（函式區段內）',
        markIdx > 0 && inj > markIdx && inj < secEnd, `mark=${markIdx} inj=${inj}`);
      T('T5e round-trip 條在位（toISOString slice 對比＝rollover 唯一閘）',
        src.includes("dd.toISOString().slice(0, 10) === rateDate"));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-e9: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
