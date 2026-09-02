#!/usr/bin/env node
// verify-e6-study-log.mjs — E6: cmdStudy 不寫 review_log → optimize/audit 看不到 CLI 複習。
// 連帶：study FSRS 構造統一 fsrsCtx(mode)、elapsed dayCutoff-aware＋夾零、futureCounts。
// 全部跑 tmp DB 副本（spawnSync input: 管線餡鍵），嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('./cli.mjs', import.meta.url).pathname;
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'e6-verify-'));
// buggy 副本目錄：cli.mjs 用 '../src/...' 相對 import，副本須與 tools/ 同深度（E5 同法）
const bugDir = join(dir, 'bugsub');
mkdirSync(bugDir);
symlinkSync(new URL('../src', import.meta.url).pathname, join(dir, 'src'));

function mkTmpDb(name, extraSettings = {}, settings = {}) {
  const p = join(dir, name + '.db');
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
  d.prepare("INSERT INTO settings (key,value) VALUES ('dayCutoff',?)").run(String(settings.dayCutoff ?? 0));
  const anki = { timezoneOffset: 0, ...extraSettings };
  d.prepare("INSERT INTO settings (key,value) VALUES ('ankiSettings',?)").run(JSON.stringify(anki));
  d.close();
  return p;
}
function addWords(p, ids) {
  const d = new DatabaseSync(p);
  for (const id of ids) d.prepare(`INSERT INTO words (id, word, definition) VALUES (?,?,?)`).run(id, id, `def ${id}`);
  d.close();
}
function seedCard(p, wid, o = {}) {
  const d = new DatabaseSync(p);
  d.prepare(`INSERT INTO cards (word_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,step)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(wid, o.due ?? '2026-08-20T01:00:00Z', o.stability ?? 10, o.difficulty ?? 6,
      o.elapsedDays ?? 0, o.scheduledDays ?? 8, o.reps ?? 5, o.lapses ?? 0, o.state ?? 2,
      o.lastReview ?? null, o.step ?? 0);
  d.close();
}
function cpDb(src, name) {
  const p = join(dir, name + '.db');
  const s = new DatabaseSync(src, { readOnly: true });
  s.exec(`VACUUM INTO '${p}'`);
  s.close();
  return p;
}
function cli(dbPath, argv, bin = CLI, input = null) {
  const r = spawnSync('node', [bin, ...argv], {
    encoding: 'utf8', input,
    env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log'), TZ: 'UTC' },
    timeout: 90000,
  });
  if (r.status !== 0) throw new Error(`cli ${argv.join(' ')} exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return r.stdout;
}
const q1 = (dbPath, sql, ...a) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const row = d.prepare(sql).get(...a);
  d.close();
  return row;
};
const qAll = (dbPath, sql, ...a) => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const rows = d.prepare(sql).all(...a);
  d.close();
  return rows;
};
// study 以管線 stdin 餡鍵（readline 逐行；尾鍵必為 q 防 EOF 懸掛）
function study(dbPath, mode, count, keys, bin = CLI) {
  return cli(dbPath, ['study', mode, String(count)], bin, keys.map(k => k + '\n').join(''));
}
const NOW = new Date();
const isoDaysAgo = (n, h = '09:00:00') => {
  const d = new Date(NOW.getTime() - n * 86400000);
  return d.toISOString().slice(0, 10) + 'T' + h + 'Z';
};

try {
  // ── T1: review_log 存在性＋11 欄語意＋cards elapsed_days 新鮮 ──
  console.log('T1 study 寫 review_log（11 欄語意）');
  const db1 = mkTmpDb('t1');
  addWords(db1, ['w1', 'w2', 'w3']);
  seedCard(db1, 'w1', { due: isoDaysAgo(1), stability: 10, reps: 5, state: 2, lastReview: new Date(NOW.getTime() - 3 * 86400000).toISOString() });  // E6 R1#3: 72h 前同刻（除 UTC 午夜牆鐘依賴，同 T4 模式）
  const out1 = study(db1, 'flip', 5, ['g', 'g', 'q']);
  T('T1 study 完成 2 張', /完成 2 張/.test(out1), out1.split('\n').slice(-2)[0]);
  const logs1 = qAll(db1, 'SELECT * FROM review_log ORDER BY id');
  T('T1 review_log 恰 2 筆', logs1.length === 2, `got=${logs1.length}`);
  const L1 = logs1[0] || {}, L2 = logs1[1] || {};
  T('T1 到期卡: mode=flip rating=2 card_state=2(複習前) new_state∈{2,3}(複習後)',
    L1.mode === 'flip' && L1.rating === 2 && L1.card_state === 2 && (L1.new_state === 2 || L1.new_state === 3),
    JSON.stringify({ m: L1.mode, r: L1.rating, cs: L1.card_state, ns: L1.new_state }));
  T('T1 到期卡: elapsed_days=3(lastReview 3天前, dayCutoff0) stability/difficulty 非空(複習後)',
    L1.elapsed_days === 3 && typeof L1.stability === 'number' && L1.stability > 0 &&
    typeof L1.difficulty === 'number', JSON.stringify({ e: L1.elapsed_days, s: L1.stability, d: L1.difficulty }));
  T('T1 scheduled_days=round(dueDays) 整數 ≥0；duration 整數 0..60000(A9 cap)',
    Number.isInteger(L1.scheduled_days) && L1.scheduled_days >= 0 &&
    Number.isInteger(L1.duration) && L1.duration >= 0 && L1.duration <= 60000,
    JSON.stringify({ sd: L1.scheduled_days, du: L1.duration }));
  T('T1 reviewed_at 帶 Z ISO 且逐筆非遞減',
    /Z$/.test(L1.reviewed_at) && /Z$/.test(L2.reviewed_at) && L2.reviewed_at >= L1.reviewed_at,
    `${L1.reviewed_at} ${L2.reviewed_at}`);
  T('T1 新卡: card_state=0 new_state=1(learning GOOD 步1)',
    L2.word_id !== 'w1' && L2.card_state === 0 && L2.new_state === 1 && L2.elapsed_days === 0,
    JSON.stringify({ w: L2.word_id, cs: L2.card_state, ns: L2.new_state, e: L2.elapsed_days }));
  const c1 = q1(db1, 'SELECT * FROM cards WHERE word_id=?', 'w1');
  T('T1 cards.elapsed_days 寫回新鮮值 3（修前恆 stale 0）', c1.elapsed_days === 3, `got=${c1.elapsed_days}`);
  T('T1 cards.last_review 與 log.reviewed_at 同刻', c1.last_review === L1.reviewed_at, `${c1.last_review} vs ${L1.reviewed_at}`);

  // ── T2: audit 可見＋零假差異（rate 建史 → study 收尾 → replay 全鏈一致）──
  console.log('T2 audit replay 零差異（fsrsCtx 統一實證）');
  const db2 = mkTmpDb('t2');
  addWords(db2, ['w9']);
  const rateDate = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);
  // good×2 畢業 → again 回填(尾筆)：learning/relearn 分鐘級 due 保證到期（good 長 interval
  // 受權重影響會跳到未來，again 對任何權重恆到期）
  for (const [n, r] of [[6, '2'], [4, '2'], [2, '0']]) cli(db2, ['rate', 'w9', r, '--date', rateDate(n)]);
  const pre2 = q1(db2, 'SELECT due FROM cards WHERE word_id=?', 'w9');
  T('T2 前置: rate 歷史到期（due<=now，rel 日期不受權重長度影響）',
    new Date(pre2.due).getTime() <= Date.now(), pre2.due);
  const out2 = study(db2, 'flip', 5, ['g', 'q']);
  T('T2 study 復盤到期卡 w9', /完成 1 張/.test(out2), out2.split('\n').filter(l => /完成/.test(l))[0] || '');
  const audit2 = cli(db2, ['audit']);
  T('T2 audit 該卡進入 replay（checked≥1）且 0 差異', /1 張卡有 flip 複習記錄, 1 一致, 0 有差異/.test(audit2),
    audit2.split('\n').find(l => /稽核/.test(l)) || '');
  T('T2 audit 非跳過（study 前無 log 時 checked=0 — 對照用舊 bug 語意已不存在）',
    !/0 張卡有 flip 複習記錄, 0 一致/.test(audit2));

  // ── T3: per-mode 標籤＋flip audit 免疫＋optimize 同款 WHERE 可見 ──
  console.log('T3 mode 標籤與 per-mode 消費者');
  const db3 = mkTmpDb('t3');
  addWords(db3, ['wm']);
  seedCard(db3, 'wm', { due: isoDaysAgo(1), lastReview: isoDaysAgo(2) });
  study(db3, 'mc', 5, ['g', 'q']);
  const L3 = q1(db3, 'SELECT * FROM review_log');
  T('T3 study mc → log mode=mc', L3 && L3.mode === 'mc', JSON.stringify(L3 && { m: L3.mode }));
  const audit3 = cli(db3, ['audit']);
  T('T3 flip audit 不受 mc 行污染（checked=0）', /0 張卡有 flip 複習記錄/.test(audit3),
    audit3.split('\n').find(l => /稽核/.test(l)) || '');
  const visN = qAll(db3, `SELECT id FROM review_log WHERE COALESCE(mode,'flip') = ?`, 'mc').length;
  T('T3 fsrs-optimize.py 同款 WHERE 可視（mc 1 筆）', visN === 1, `got=${visN}`);

  // ── T4: elapsed 邊界（cutoff 場景同刻位移＋亂序夾零）──
  console.log('T4 elapsed dayCutoff-aware＋夾零');
  const db4 = mkTmpDb('t4', { timezoneOffset: 0 }, { dayCutoff: 300 });   // cutoff=05:00
  addWords(db4, ['wc']);
  // lastReview = 48h 前同刻（時刻逐字保留）→ 任何 cutoff 下 teno 日差恆=2（tz=0 無 DST，
  // 減 48h 於 shift 後時框仍差恰 2 日）；cutoff 生效由「讀 DB dayCutoff＋公式鏡像
  // cmdRate」結構保證（代際邊界情形 E4 T3 已釘）
  seedCard(db4, 'wc', { due: isoDaysAgo(1), lastReview: new Date(NOW.getTime() - 2 * 86400000).toISOString() });
  study(db4, 'flip', 5, ['g', 'q']);
  const L4 = q1(db4, 'SELECT elapsed_days FROM review_log');
  T('T4 cutoff=300 下 elapsed_days=2（48h 前同刻，恆等不受實際執行時刻擺動）',
    L4 && L4.elapsed_days === 2, `got=${L4 && L4.elapsed_days}`);
  const db4b = mkTmpDb('t4b');
  addWords(db4b, ['wf']);
  seedCard(db4b, 'wf', { due: isoDaysAgo(1), lastReview: isoDaysAgo(-2) });  // 亂序：未來日
  study(db4b, 'flip', 5, ['g', 'q']);
  const L4b = q1(db4b, 'SELECT elapsed_days FROM review_log');
  T('T4 亂序 lastReview 未來日 → 夾零 0（E4 MED-1 同構防線）', L4b && L4b.elapsed_days === 0,
    `got=${L4b && L4b.elapsed_days}`);

  // ── T5: 無效鍵不產生 log ──
  console.log('T5 無效鍵');
  const db5 = mkTmpDb('t5');
  addWords(db5, ['w5']);
  seedCard(db5, 'w5', { due: isoDaysAgo(1), lastReview: isoDaysAgo(2) });
  const out5 = study(db5, 'flip', 5, ['x', 'g', 'q']);
  T('T5 跳過顯示＋該題僅 1 筆 log', /跳過/.test(out5) && qAll(db5, 'SELECT id FROM review_log').length === 1);

  // ── T6: q 中斷 cards/log 同進出 ──
  console.log('T6 q 中斷一致性');
  const db6 = mkTmpDb('t6');
  addWords(db6, ['a1', 'a2', 'a3']);
  seedCard(db6, 'a1', { due: isoDaysAgo(1), lastReview: isoDaysAgo(2) });
  seedCard(db6, 'a2', { due: isoDaysAgo(1), lastReview: isoDaysAgo(2) });
  study(db6, 'flip', 5, ['g', 'q']);
  T('T6 答1題後 q：log 恰 1 筆 且 a1 last_review 已更新（cards/log 一致）',
    qAll(db6, 'SELECT id FROM review_log').length === 1 &&
    !!q1(db6, `SELECT last_review FROM cards WHERE word_id=(SELECT word_id FROM review_log LIMIT 1)`).last_review);

  // ── T7: 負控制 ──
  console.log('T7 負控制');
  {
    const src = readFileSync(CLI, 'utf8');
    // (a) 剝除 review_log INSERT → 0 筆重現（原 bug）
    const stripA = [
      ['  const insLog = w.prepare(`INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);\n  for (const rv of reviews) insLog.run(rv.wid, rv.rating, rv.durationMs, rv.elapsed,\n    Math.round(rv.post.dueDays), rv.post.stability, rv.post.difficulty, mode,\n    rv.prev, rv.post.state, new Date(rv.atMs).toISOString());\n', ''],
    ];
    let buggyA = src;
    for (const [f, t] of stripA) {
      if (!buggyA.includes(f)) throw new Error(`T7a 剝除失敗: ${f.slice(0, 60)}...`);
      buggyA = buggyA.split(f).join(t);
    }
    const buggyCliA = join(bugDir, `e6-buggy-a-${process.pid}.mjs`);
    writeFileSync(buggyCliA, buggyA);
    const dbA = mkTmpDb('t7a');
    addWords(dbA, ['wa']);
    seedCard(dbA, 'wa', { due: isoDaysAgo(1), lastReview: isoDaysAgo(3) });
    study(dbA, 'flip', 5, ['g', 'q'], buggyCliA);
    T('T7a 剝除 INSERT → review_log 0 筆（原 bug 精準重現）cards 卻已更新',
      qAll(dbA, 'SELECT id FROM review_log').length === 0 &&
      q1(dbA, 'SELECT reps FROM cards WHERE word_id=?', 'wa').reps === 6);
    rmSync(buggyCliA, { force: true });
    // (b) 構造回退（忽略 settings fsrsWeights 用預設權重寫卡）→ audit replay 假 mismatch
    // 重現（E5 cmdRate 同款；retention/maxIvl 只動 interval 不入 audit 五欄，
    // weights 才是同時打中 stability/difficulty 的 knob）
    const stripB = [
      ['  const { fsrs, learnSteps, relearnSteps } = fsrsCtx(mode);',
        '  const fsrs = new FSRS(null, ankiCfg.desiredRetention, true, ankiCfg.maxIvl ?? 365);\n  const learnSteps = parseStepsStr(ankiCfg.learnSteps, \'1,10\');\n  const relearnSteps = parseStepsStr(ankiCfg.relearnSteps, \'10\');'],
    ];
    let buggyB = src;
    for (const [f, t] of stripB) {
      if (!buggyB.includes(f)) throw new Error(`T7b 剝除失敗: ${f.slice(0, 60)}...`);
      buggyB = buggyB.split(f).join(t);
    }
    const buggyCliB = join(bugDir, `e6-buggy-b-${process.pid}.mjs`);
    writeFileSync(buggyCliB, buggyB);
    try {
      // settings desiredRetention=0.5（越界）：buggy study 用 0.5 原值寫卡，
      // audit replay（fsrsCtx clamp→0.7）重算 → 差異
      const dbB = mkTmpDb('t7b', { fsrsWeights: JSON.stringify(Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.37)).slice(1, -1) });
      addWords(dbB, ['wb']);
      for (const [n, r] of [[6, '2'], [4, '2'], [2, '0']]) cli(dbB, ['rate', 'wb', r, '--date', rateDate(n)]);
      const preB = q1(dbB, 'SELECT due FROM cards WHERE word_id=?', 'wb');
      if (new Date(preB.due).getTime() > Date.now()) throw new Error(`T7b 前置失败: wb 未到期 ${preB.due}`);
      study(dbB, 'flip', 5, ['g', 'q'], buggyCliB);
      const auditB = cli(dbB, ['audit']);
      T('T7b 構造漂移(預設權重寫、settings 權重 replay) → audit 假 mismatch 重現',
        /1 有差異/.test(auditB), auditB.split('\n').find(l => /稽核/.test(l)) || '');
    } finally { rmSync(buggyCliB, { force: true }); }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nE6 驗證: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
process.exit(fail ? 1 : 0);
