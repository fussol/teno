#!/usr/bin/env node
// verify-e5-seeded-fuzz.mjs — E5: CLI rate/sim Math.random fuzz＋不套 greaterThanLast＋
// FSRS 構造脫離 ankiSettings（audit 假 mismatch 真兇）。
// 全部跑 tmp DB 副本，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FSRS, generateFuzzFactor, parseStepsStr } from '../src/core/fsrs.js';
import { getToday, toLocalDateStr, computeDueIso, computeFutureDueCounts } from '../src/core/scheduler.js';

const CLI = new URL('./cli.mjs', import.meta.url).pathname;
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'e5-verify-'));
// E5 R2: buggy CLI 副本专用结构 — cli.mjs 用相對 import '../src/...'，副本必須與 tools/
// 同深度才解析得到。原寫法把副本落 repo tools/（污染＋固定名競態）；改 tmp 內
// dir/src symlink → teno/src，副本放 dir/bugsub/（../src == dir/src）。dir 於 finally 整刪。
const bugDir = join(dir, 'bugsub');
mkdirSync(bugDir);
symlinkSync(new URL('../src', import.meta.url).pathname, join(dir, 'src'));
function mkTmpDb(name, extraSettings = {}) {
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
  d.prepare("INSERT INTO settings (key,value) VALUES ('dayCutoff','0')").run();
  const anki = { timezoneOffset: 0, ...extraSettings };
  d.prepare("INSERT INTO settings (key,value) VALUES ('ankiSettings',?)").run(JSON.stringify(anki));
  d.prepare("INSERT INTO words (id, word, definition) VALUES ('w1','apple','n. 蘋果')").run();
  d.close();
  return p;
}
function cpDb(src, name) {
  const p = join(dir, name + '.db');
  const s = new DatabaseSync(src, { readOnly: true });
  s.exec(`VACUUM INTO '${p}'`);
  s.close();
  return p;
}
function cli(dbPath, argv, bin = CLI) {
  const r = spawnSync('node', [bin, ...argv, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log'), TZ: 'UTC' },
    timeout: 60000,
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
// 標準成長序列（NEW→LEARNING→REVIEW，間隔長到 fuzz 範圍有寬度）
const SEQ = ['2026-01-01', '2026-01-02', '2026-01-06', '2026-01-20', '2026-02-20'];

try {
  // ── T1: 確定性 — 同序列同 seed 兩副本 due 一字不差 ──
  console.log('T1 rate 確定性');
  const base1 = mkTmpDb('t1base');
  for (const dstr of SEQ) cli(base1, ['rate', 'w1', '2', '--date', dstr]);
  const due1a = q1(base1, 'SELECT due FROM cards').due;
  const c1b = cpDb(base1, 't1b-fresh'); // 用乾淨另一副本重跑整序列
  const fresh = mkTmpDb('t1c');
  for (const dstr of SEQ) cli(fresh, ['rate', 'w1', '2', '--date', dstr]);
  const due1b = q1(fresh, 'SELECT due FROM cards').due;
  T('兩副本全序列後 due 完全一致', due1a === due1b, `${due1a} vs ${due1b}`);
  const card1 = q1(base1, 'SELECT * FROM cards');
  T('已達 REVIEW（序列有效）', card1.state === 2 && card1.scheduled_days > 10, `state=${card1.state} sched=${card1.scheduled_days}`);

  // ── T2: 與 app 同 seed 端到端對齊（獨立 replay 重算 due） ──
  console.log('T2 seed 式與 app 同構（e2e replay）');
  {
    const anki = { timezoneOffset: 0 };
    const fsrs = new FSRS(null, Math.max(0.7, Math.min(0.99, 0.9)), true, 365);
    const learnSteps = parseStepsStr(undefined, '1,10');
    const relearnSteps = parseStepsStr(undefined, '10');
    // 鏡像重放：cards Map 快照算 futureCounts
    const cardsMap = new Map();
    let card = null;
    for (const dstr of SEQ) {
      const rateNow = new Date(dstr + 'T08:00:00Z').getTime();
      const isNew = !card;
      if (!card) card = { stability: 0, difficulty: 5, elapsedDays: 0, scheduledDays: 0, reps: 0, lapses: 0, state: 0, step: 0, interval: 0, due: new Date(rateNow).toISOString() };
      const lastTs = card.lastReview ? new Date(card.lastReview).getTime() : null;
      const todayStr = getToday(0, 0, rateNow);
      const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), 0, 0) : null;
      const elapsed = lastDay != null ? Math.max(0, (() => { const [y1, m1, d1] = lastDay.split('-').map(Number); const [y2, m2, d2] = todayStr.split('-').map(Number); return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000); })()) : 0;
      const fuzz = generateFuzzFactor('w1_flip', card.reps ?? 0);
      const futureCounts = (!isNew && (card.state === 2 || card.state === 3)) ? computeFutureDueCounts(cardsMap, 90, 0, 0) : null;
      const res = fsrs.review({ ...card, elapsedDays: elapsed }, 2, fuzz, learnSteps, relearnSteps, futureCounts);
      const dueIso = computeDueIso(res.dueDays, res.state, 0, 0, new Date(rateNow).toISOString());
      card = { stability: res.stability, difficulty: res.difficulty, elapsedDays: elapsed, scheduledDays: res.dueDays, reps: res.reps, lapses: res.lapses, state: res.state, step: res.step ?? 0, interval: res.dueDays, due: dueIso, lastReview: new Date(rateNow).toISOString() };
      cardsMap.set('w1', { due: dueIso, state: res.state });
    }
    T('獨立 replay due == CLI 寫入 due', card.due === due1a, `${card.due} vs ${due1a}`);
  }

  // ── T3: fsrsWeights 生效＋audit 零 mismatch（兩儲存格式） ──
  console.log('T3 fsrsWeights 讀取（audit mismatch 真兇）');
  {
    // 21 欄偏移權重（明顯偏離預設）。app 生產儲存＝無 bracket 逗號串（settings.js textarea）
    const wArr = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.37);
    const formats = { bare: wArr.map(x => x.toFixed(4)).join(', '), bracketed: JSON.stringify(wArr) };
    for (const [fmt, w] of Object.entries(formats)) {
      const db3 = mkTmpDb(`t3-${fmt}`, { fsrsWeights: w });
      for (const dstr of SEQ) cli(db3, ['rate', 'w1', '2', '--date', dstr]);
      const cardW = q1(db3, 'SELECT * FROM cards');
      const db3d = mkTmpDb(`t3-${fmt}-default`);   // 無 fsrsWeights
      for (const dstr of SEQ) cli(db3d, ['rate', 'w1', '2', '--date', dstr]);
      const cardD = q1(db3d, 'SELECT * FROM cards');
      T(`[${fmt}] 自訂權重 stability ≠ 預設權重 stability`, Math.abs(cardW.stability - cardD.stability) > 0.01, `${cardW.stability} vs ${cardD.stability}`);
      const auditOut = cli(db3, ['audit']);
      T(`[${fmt}] rate(權重A) 後 audit replay(權重A) 0 差異`, /1 一致, 0 有差異/.test(auditOut), auditOut.split('\n').slice(0, 4).join(' ⏎ '));
    }
  }

  // ── T4: greaterThanLast load-balancing（interval 必須 <90d，官方 futureCounts 窗口） ──
  console.log('T4 futureCounts load-balancing');
  {
    const SEQ4 = SEQ.slice(0, 4);   // 最後 rate 01-20，interval ~2w → 在 90d LB 窗內
    // 基準：孤卡
    const db4 = mkTmpDb('t4');
    for (const dstr of SEQ4) cli(db4, ['rate', 'w1', '2', '--date', dstr]);
    const dueSolo = q1(db4, 'SELECT due FROM cards').due;
    // 對照：在 dueSolo 同日塞 60 張 REVIEW 卡 → 最後一筆 rate 的 due 應被擠開
    const db4b = mkTmpDb('t4b');
    for (const dstr of SEQ4.slice(0, 3)) cli(db4b, ['rate', 'w1', '2', '--date', dstr]);
    {
      const d = new DatabaseSync(db4b);
      for (let i = 0; i < 60; i++) {
        d.prepare(`INSERT INTO words (id, word) VALUES (?, ?)`).run(`x${i}`, `x${i}`);
        d.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, scheduled_days, reps, state)
          VALUES (?,?,5,6,30,5,2)`).run(`x${i}`, dueSolo);
      }
      d.close();
    }
    cli(db4b, ['rate', 'w1', '2', '--date', SEQ4[3]]);
    const dueLoaded = q1(db4b, 'SELECT due FROM cards WHERE word_id=\'w1\'').due;
    T('高負載日 due 被 load-balancing 擠開（date 不同）',
      toLocalDateStr(new Date(dueLoaded), 0, 0) !== toLocalDateStr(new Date(dueSolo), 0, 0),
      `${dueLoaded} vs ${dueSolo}`);
    T('擠開幅度在 fuzz 範圍內（≤ raw+幾日）',
      Math.abs(Math.round((new Date(dueLoaded) - new Date(dueSolo)) / 86400000)) <= 5,
      `${dueLoaded} vs ${dueSolo}`);
    // learning 卡不受影響
    const db4c = mkTmpDb('t4c');
    {
      const d = new DatabaseSync(db4c);
      for (let i = 0; i < 60; i++) {
        d.prepare(`INSERT INTO words (id, word) VALUES (?, ?)`).run(`y${i}`, `y${i}`);
        d.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, scheduled_days, reps, state)
          VALUES (?,?,5,6,30,5,2)`).run(`y${i}`, '2026-03-05T08:00:00Z');
      }
      d.close();
    }
    cli(db4c, ['rate', 'w1', '2', '--date', '2026-03-01']);   // 新卡 learning → futureCounts=null
    const c4c = q1(db4c, 'SELECT * FROM cards WHERE word_id=\'w1\'');
    T('learning 新卡不套 LB（due=+10min step）', c4c.state === 1 &&
      Math.abs((new Date(c4c.due) - (new Date('2026-03-01T08:00:00Z').getTime() + 600000))) < 5000, c4c.due);
  }

  // ── T5: learnSteps from settings（parseStepsStr） ──
  console.log('T5 steps 從 settings＋畸形防護');
  {
    const db5 = mkTmpDb('t5', { learnSteps: '5,20' });
    cli(db5, ['rate', 'w1', '2', '--date', '2026-04-01']);
    const c5 = q1(db5, 'SELECT * FROM cards');
    // GOOD 首步 → steps[1]=20 分鐘（Anki good 推進到下一步；5 是 Again 步）
    T("learnSteps='5,20' → GOOD 步 20 分鐘", c5.state === 1 &&
      Math.abs((new Date(c5.due) - (new Date('2026-04-01T08:00:00Z').getTime() + 1200000))) < 5000, c5.due);
    const db5b = mkTmpDb('t5b', { learnSteps: ',' });
    cli(db5b, ['rate', 'w1', '2', '--date', '2026-04-01']);   // 全畸形段 → [] → A4 畢業 REVIEW 不崩
    const c5b = q1(db5b, 'SELECT * FROM cards');
    T("learnSteps=',' 畸形 → parseStepsStr [] → 畢業 REVIEW（A4 語意）", c5b.state === 2, `state=${c5b.state}`);
  }

  // ── T6: sim --now 凍結時鐘 確定性（v1.2：REVIEW 卡測資＋同 json 管線負控制＝真牙）──
  console.log('T6 sim 確定性（--now 沙箱＋REVIEW digest）');
  {
    const db6 = mkTmpDb('t6');
    {
      const d = new DatabaseSync(db6);
      for (let i = 0; i < 30; i++) d.prepare(`INSERT INTO words (id, word) VALUES (?, ?)`).run(`s${i}`, `s${i}`);
      // E5 v1.2: 預置 REVIEW 卡（state=2 今日到期、各异 stability/reps）——R2 #3 實測
      // 純新卡測資在 ratings 序列下走不到 REVIEW，fuzz 根本不進 interval → digest 對
      // fuzz 無感（R1「無牙」殘根）。REVIEW 卡在場 → FSRS interval±fuzz 進 digest。
      for (let i = 0; i < 4; i++) {
        d.prepare(`INSERT INTO words (id, word) VALUES (?, ?)`).run(`r${i}`, `r${i}`);
        d.prepare(`INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review)
          VALUES (?, '2026-04-01T02:00:00Z', ?, 6.0, 10, 8, ?, 0, 2, 0, '2026-03-22T02:00:00Z')`).run(`r${i}`, 4 + i * 7, 5 + i * 3);
      }
      d.close();
    }
    const NOW = ['--now', '2026-04-01T08:00:00Z'];
    const ARGS = ['sim', '--ratings', '2,2,2,0,2', ...NOW];
    const o1 = cli(db6, ARGS);
    const o2 = cli(cpDb(db6, 't6b'), ARGS);
    const o3 = cli(cpDb(db6, 't6c'), ARGS);
    T('同 DB ×3 凍結時鐘 sim 全輸出逐字一致（json 管線）', o1 === o2 && o2 === o3, 'output diff');
    T('digest 行在場且一致', /digest=[0-9a-f]{16}/.test(o1) &&
      o1.match(/digest=(\w+)/)[1] === o2.match(/digest=(\w+)/)[1], 'digest missing/diff');
    // T6 牙（v1.2）：負控制與正控制**同 --json 管線**（R2 #3 查出 v1.1 負控制走非 json
    // 輸出洩 CMD 牆鐘行、靠時間戳巧合轉紅）→ 現只靠 digest 判別，fuzz 無隨機即恆綠。
    const src6 = readFileSync(CLI, 'utf8');
    const from6 = "const fuzz = generateFuzzFactor(wid + '_flip', card.reps ?? 0);";
    if (!src6.includes(from6)) throw new Error('T6 負控制剝除失敗: cmdSim fuzz 行未命中');
    const buggy6 = src6.split(from6).join('const fuzz = Math.random();');
    const buggyCli6 = join(bugDir, `e5-buggy-sim-${process.pid}.mjs`);
    writeFileSync(buggyCli6, buggy6);
    try {
      const dg = (o) => (o.match(/digest=([0-9a-f]{16})/) || [])[1];
      const g1 = cli(cpDb(db6, 't6d'), ARGS, buggyCli6);
      const g2 = cli(cpDb(db6, 't6e'), ARGS, buggyCli6);
      const g3 = cli(cpDb(db6, 't6f'), ARGS, buggyCli6);
      T('負控制: cmdSim Math.random fuzz → 同凍結時鐘同 json 管線 digest 漂移（有牙）',
        !!dg(g1) && !!dg(g2) && !!dg(g3) && new Set([dg(g1), dg(g2), dg(g3)]).size > 1,
        `digests=${dg(g1)},${dg(g2)},${dg(g3)}`);
      T('clean digest 偏離 buggy 落點（差異源自 fuzz 隨機性、非進程噪音）',
        !!dg(o1) && !!dg(g1) && !!dg(g2) && !!dg(g3) &&
        (dg(o1) !== dg(g1) || dg(o1) !== dg(g2) || dg(o1) !== dg(g3)),
        `clean=${dg(o1)} buggy=${dg(g1)},${dg(g2)},${dg(g3)}`);
    } finally { rmSync(buggyCli6, { force: true }); }
  }

  // ── T7: 負控制 — 剝除後 bug 精準重現 ──
  console.log('T7 負控制（buggy CLI 副本）');
  {
    const src = readFileSync(CLI, 'utf8');
    let buggy = src;
    const strips = [
      ["  const { fsrs, learnSteps, relearnSteps } = fsrsCtx('flip');\n  let card = s.cards.get(w.id);", "  const fsrs = new FSRS();\n  let card = s.cards.get(w.id);"],
      ["  const fuzz = generateFuzzFactor(w.id + '_flip', card.reps ?? 0);\n  const futureCounts = (!isNew && (card.state === 2 || card.state === 3))\n    ? computeFutureDueCounts(s.cards, 90, DAY_CUTOFF, TZ_OFFSET) : null;\n  const res = fsrs.review({ ...card, elapsedDays: elapsed }, rating, fuzz, learnSteps, relearnSteps, futureCounts);",
       "  const res = fsrs.review({ ...card, elapsedDays: elapsed }, rating, Math.random(), [1/1440, 10/1440], [10/1440]);"],
    ];
    for (const [from, to] of strips) {
      if (!buggy.includes(from)) throw new Error(`負控制剝除失敗: ${from.slice(0, 60)}...`);
      buggy = buggy.split(from).join(to);
    }
    // E5 R2: 唯一檔名＋bugDir（tmp 內 symlink 結構，見頂層註解；修前固定名落 repo tools/）
    const buggyCli = join(bugDir, `.e5-buggy-cli-${process.pid}.mjs`);
    writeFileSync(buggyCli, buggy);
    try {
      const runBuggy = (dbPath, argv) => {
        const r = spawnSync('node', [buggyCli, ...argv, '--json'], {
          encoding: 'utf8',
          env: { ...process.env, TENO_DB: dbPath, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log'), TZ: 'UTC' },
          timeout: 60000,
        });
        if (r.status !== 0) throw new Error(`buggy cli exit ${r.status}: ${r.stderr || r.stdout}`);
        return r.stdout;
      };
      // (a) Math.random fuzz → 同序列 8 副本 due 出現多種落點
      const bbase = mkTmpDb('t7base');
      const dues = new Set();
      for (let k = 0; k < 8; k++) {
        const dbk = cpDb(bbase, `t7-${k}`);
        for (const dstr of SEQ) runBuggy(dbk, ['rate', 'w1', '2', '--date', dstr]);
        dues.add(q1(dbk, 'SELECT due FROM cards').due);
      }
      T('負控制: 隨機 fuzz → 同序列 due 落點 >1 種（不可重現重現）', dues.size > 1, `sizes=${dues.size}`);
      // (b) 預設權重 vs settings 權重 → audit mismatch 重現
      const w = JSON.stringify(Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.37));
      const db7 = mkTmpDb('t7w', { fsrsWeights: w });
      for (const dstr of SEQ) runBuggy(db7, ['rate', 'w1', '2', '--date', dstr]);
      const auditOut = cli(db7, ['audit']);   // audit 讀 settings 權重 replay vs 卡（預設權重寫的）
      T('負控制: 預設權重 rate + settings 權重 replay → audit 有差異', / 0 一致| [1-9]\d* 有差異/.test(auditOut) && !/, 1 一致, 0 有差異/.test(auditOut),
        auditOut.split('\n')[0]);
    } finally {
      rmSync(buggyCli, { force: true });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nE5 驗證: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
process.exit(fail ? 1 : 0);
