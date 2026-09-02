#!/usr/bin/env node
// verify-e4-rate-log.mjs — E4: CLI rate 寫 review_log 缺 5 欄（duration/elapsed_days/
// scheduled_days/stability/difficulty）＋ cards.elapsed_days 永不寫回（delta_t stale）。
// 全部跑 tmp DB 副本，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('./cli.mjs', import.meta.url).pathname;
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'e4-verify-'));
function mkDb(name) { return join(dir, name + '.db'); }

function mkTmpDb(name, { dayCutoff = 0, tz = 0 } = {}) {
  const p = mkDb(name);
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
  `);
  d.prepare("INSERT INTO settings (key,value) VALUES ('dayCutoff',?)").run(String(dayCutoff));
  d.prepare("INSERT INTO settings (key,value) VALUES ('ankiSettings',?)").run(JSON.stringify({ timezoneOffset: tz }));
  d.prepare("INSERT INTO words (id, word, definition) VALUES ('w1','apple','n. 蘋果')").run();
  d.close();
  return p;
}

function cli(dbPath, argv) {
  const r = spawnSync('node', [CLI, ...argv, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log'), TZ: 'UTC' },
    timeout: 30000,
  });
  if (r.status !== 0) throw new Error(`cli ${argv.join(' ')} exit ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const q1 = (dbPath, sql, ...a) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const row = d.prepare(sql).get(...a);
  d.close();
  return row;
};

try {
  // ── T1: 新卡 rate — 5 欄非 NULL、語意正確 ──
  console.log('T1 新卡 rate 補齊欄位');
  const db1 = mkTmpDb('t1');
  cli(db1, ['rate', 'w1', '2', '--date', '2026-01-10']);
  const log1 = q1(db1, 'SELECT * FROM review_log ORDER BY id DESC LIMIT 1');
  const card1 = q1(db1, 'SELECT * FROM cards WHERE word_id=\'w1\'');
  T('review_log 恰 1 筆', !!log1);
  T('elapsed_days 非 NULL 且=0（新卡）', log1.elapsed_days === 0, `got ${log1.elapsed_days}`);
  T('scheduled_days 非 NULL', log1.scheduled_days != null, `got ${log1.scheduled_days}`);
  T('stability 非 NULL 且=cards 行（皆複習後）', log1.stability != null && Math.abs(log1.stability - card1.stability) < 1e-9);
  T('difficulty 非 NULL 且=cards 行', log1.difficulty != null && Math.abs(log1.difficulty - card1.difficulty) < 1e-9);
  T('duration 為 NULL（CLI 無真實時長，app 缺→null 語意）', log1.duration === null);
  T('scheduled_days=round(dueDays) 整數', Number.isInteger(log1.scheduled_days) && log1.scheduled_days >= 0);
  T('card_state=0(new) new_state=非0', log1.card_state === 0 && log1.new_state !== 0);
  T('reviewed_at ISO 帶 Z（E2 語意不破）', /Z$/.test(log1.reviewed_at));

  // ── T2: 跨日 e2e — elapsed_days=3、cards 行同步 ──
  console.log('T2 跨日 --date（delta_t 語意）');
  const db2 = mkTmpDb('t2');
  cli(db2, ['rate', 'w1', '2', '--date', '2026-01-10']);
  cli(db2, ['rate', 'w1', '2', '--date', '2026-01-13']);
  const log2 = q1(db2, 'SELECT * FROM review_log ORDER BY id DESC LIMIT 1');
  const card2 = q1(db2, 'SELECT * FROM cards WHERE word_id=\'w1\'');
  T('第2筆 log elapsed_days=3', log2.elapsed_days === 3, `got ${log2.elapsed_days}`);
  T('cards.elapsed_days=3（修前永不寫回）', card2.elapsed_days === 3, `got ${card2.elapsed_days}`);
  T('第1筆 log elapsed_days=0', q1(db2, 'SELECT elapsed_days FROM review_log ORDER BY id LIMIT 1').elapsed_days === 0);

  // ── T3: dayCutoff 邊界 — 03:00Z 作答歸前一日（cutoff=300） ──
  console.log('T3 dayCutoff 感知');
  const db3 = mkTmpDb('t3', { dayCutoff: 300, tz: 0 });
  {
    const d = new DatabaseSync(db3);
    d.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review)
      VALUES ('w1','2026-01-10T08:00:00Z',3,6,0,2,1,0,2,0,'2026-01-10T03:00:00Z')`).run();   // 03:00Z < 05:00 界 → Anki 日=01-09
    d.close();
  }
  cli(db3, ['rate', 'w1', '2', '--date', '2026-01-10']);   // 08:00Z ≥ 界 → Anki 日=01-10
  const log3 = q1(db3, 'SELECT elapsed_days FROM review_log ORDER BY id DESC LIMIT 1');
  T('cutoff=300: 03:00Z→08:00Z 跨日界線 elapsed=1', log3.elapsed_days === 1, `got ${log3.elapsed_days}`);
  const db3b = mkTmpDb('t3b', { dayCutoff: 0, tz: 0 });
  {
    const d = new DatabaseSync(db3b);
    d.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review)
      VALUES ('w1','2026-01-10T08:00:00Z',3,6,0,2,1,0,2,0,'2026-01-10T03:00:00Z')`).run();
    d.close();
  }
  cli(db3b, ['rate', 'w1', '2', '--date', '2026-01-10']);
  T('cutoff=0 對照: 同一日历天 elapsed=0', q1(db3b, 'SELECT elapsed_days FROM review_log ORDER BY id DESC LIMIT 1').elapsed_days === 0);

  // ── T4: legacy naive last_review（無 Z）不炸 ──
  console.log('T4 legacy naive 時間戳（normTs）');
  const db4 = mkTmpDb('t4');
  {
    const d = new DatabaseSync(db4);
    d.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review)
      VALUES ('w1','2026-01-10 08:00:00',3,6,0,2,1,0,2,0,'2026-01-08 05:00:00')`).run();
    d.close();
  }
  cli(db4, ['rate', 'w1', '2', '--date', '2026-01-10']);
  const log4 = q1(db4, 'SELECT elapsed_days FROM review_log ORDER BY id DESC LIMIT 1');
  T('naive last_review elapsed=2 且非 NaN/NULL', log4.elapsed_days === 2, `got ${log4.elapsed_days}`);

  // ── T5: 同日二次 rate — delta_t=0 正確語意 ──
  console.log('T5 同日二次 rate');
  const db5 = mkTmpDb('t5');
  cli(db5, ['rate', 'w1', '2', '--date', '2026-01-10']);
  cli(db5, ['rate', 'w1', '0', '--date', '2026-01-10']);
  T('第2筆 elapsed_days=0（同 Anki 日）', q1(db5, 'SELECT elapsed_days FROM review_log ORDER BY id DESC LIMIT 1').elapsed_days === 0);
  T('cards.elapsed_days=0', q1(db5, 'SELECT elapsed_days FROM cards').elapsed_days === 0);

  // ── T7: --date 亂序回填 — 負 elapsed 夾 0（審查 MED-1：fsrs-rs u32 serde 防爆） ──
  console.log('T7 亂序回填負值夾零');
  const db7 = mkTmpDb('t7');
  cli(db7, ['rate', 'w1', '2', '--date', '2026-08-20']);
  cli(db7, ['rate', 'w1', '2', '--date', '2026-08-25']);
  cli(db7, ['rate', 'w1', '2', '--date', '2026-08-10']);   // 回填 15 天前 → 原生日差 -15
  const log7 = q1(db7, 'SELECT elapsed_days FROM review_log ORDER BY id DESC LIMIT 1');
  const card7 = q1(db7, 'SELECT elapsed_days FROM cards WHERE word_id=\'w1\'');
  T('回填 log.elapsed_days=0（夾零，非 -15）', log7.elapsed_days === 0, `got ${log7.elapsed_days}`);
  T('回填 cards.elapsed_days=0 ≥ 0', card7.elapsed_days === 0, `got ${card7.elapsed_days}`);
  T('全 log elapsed_days ≥ 0', q1(db7, 'SELECT COUNT(*) c FROM review_log WHERE elapsed_days < 0').c === 0);

  // ── T6: 負控制 — 剝除修法後 bug 精準重現 ──
  console.log('T6 負控制（buggy CLI 副本）');
  const src = readFileSync(CLI, 'utf8');
  let buggy = src;
  const strips = [
    // E5 後呼叫端從 session.fsrs.review( 改為 fsrs.review(（fsrsCtx 構造）— 剝除語意不變：
    // 去掉 {...card, elapsedDays: elapsed} 改餵 stale card，重現 E4 delta_t 陳舊 bug
    ['fsrs.review({ ...card, elapsedDays: elapsed }, rating', 'fsrs.review(card, rating'],
    ['UPDATE cards SET due=?, stability=?, difficulty=?, elapsed_days=?, scheduled_days=?', 'UPDATE cards SET due=?, stability=?, difficulty=?, scheduled_days=?'],
    ['dueIso, res.stability, res.difficulty, elapsed, sched,\n      res.reps, res.lapses, res.state, res.step ?? 0, nowIso, w.id);', 'dueIso, res.stability, res.difficulty, sched,\n      res.reps, res.lapses, res.state, res.step ?? 0, nowIso, w.id);'],
    ['INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', 'INSERT INTO review_log (word_id, rating, reviewed_at, mode, card_state, new_state) VALUES (?,?,?,?,?,?)'],
    ["w.id, rating, null, elapsed, Math.round(res.dueDays), res.stability, res.difficulty,\n    'flip', isNew ? 0 : (card.state ?? 0), res.state, nowIso);", "w.id, rating, nowIso, 'flip', isNew ? 0 : (card.state ?? 0), res.state);"],
  ];
  for (const [from, to] of strips) {
    if (!buggy.includes(from)) throw new Error(`負控制剝除失敗，找不到的片段: ${from.slice(0, 60)}...`);
    buggy = buggy.split(from).join(to);
  }
  const buggyCli = new URL('./.e4-buggy-cli.mjs', import.meta.url).pathname;
  writeFileSync(buggyCli, buggy);
  try {
    const db6 = mkTmpDb('t6');
    const runB = (argv) => {
      const r = spawnSync('node', [buggyCli, ...argv, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, TENO_DB: db6, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log'), TZ: 'UTC' },
        timeout: 30000,
      });
      if (r.status !== 0) throw new Error(`buggy cli exit ${r.status}: ${r.stderr || r.stdout}`);
    };
    runB(['rate', 'w1', '2', '--date', '2026-01-10']);
    runB(['rate', 'w1', '2', '--date', '2026-01-13']);
    const log6 = q1(db6, 'SELECT * FROM review_log ORDER BY id DESC LIMIT 1');
    const card6 = q1(db6, 'SELECT * FROM cards WHERE word_id=\'w1\'');
    T('負控制: log.elapsed_days NULL（bug 重現 → 優化器視 delta_t=0）', log6.elapsed_days === null, `got ${log6.elapsed_days}`);
    T('負控制: log.scheduled_days NULL', log6.scheduled_days === null);
    T('負控制: log.stability/difficulty NULL', log6.stability === null && log6.difficulty === null);
    T('負控制: cards.elapsed_days 陳舊=0（delta_t 漂移重現）', card6.elapsed_days === 0, `got ${card6.elapsed_days}`);
  } finally {
    rmSync(buggyCli, { force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nE4 驗證: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
process.exit(fail ? 1 : 0);
