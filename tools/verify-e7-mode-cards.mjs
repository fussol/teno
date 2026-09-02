#!/usr/bin/env node
// verify-e7-mode-cards.mjs — E7: cmdStudy mc/spell 用 base card 評分覆寫 → 污染 flip。
// 修復：mode 化卡圖（modeCardMap）＋容器欄存檔分流（mc_data/spell_data，flip 欄不動）。
// 全部跑 tmp DB 副本，嚴禁碰 ~/.config/com.teno.app/teno.db。
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

const dir = mkdtempSync(join(tmpdir(), 'e7-verify-'));
const bugDir = join(dir, 'bugsub');
mkdirSync(bugDir);
symlinkSync(new URL('../src', import.meta.url).pathname, join(dir, 'src'));

function mkTmpDb(name) {
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
  d.prepare("INSERT INTO settings (key,value) VALUES ('ankiSettings',?)").run(JSON.stringify({ timezoneOffset: 0 }));
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
  d.prepare(`INSERT INTO cards (word_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,step,mc_data,spell_data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(wid, o.due ?? '2026-08-20T01:00:00Z', o.stability ?? 10, o.difficulty ?? 6,
      o.elapsedDays ?? 0, o.scheduledDays ?? 8, o.reps ?? 5, o.lapses ?? 0, o.state ?? 2,
      o.lastReview ?? null, o.step ?? 0, o.mcData ?? null, o.spellData ?? null);
  d.close();
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
const study = (db, mode, n, keys, bin = CLI) => cli(db, ['study', mode, String(n)], bin, keys.map(k => k + '\n').join(''));
const q1 = (db, sql, ...a) => { const d = new DatabaseSync(db, { readOnly: true }); const r = d.prepare(sql).get(...a); d.close(); return r; };
const qAll = (db, sql, ...a) => { const d = new DatabaseSync(db, { readOnly: true }); const r = d.prepare(sql).all(...a); d.close(); return r; };
const NOW = new Date();
const isoAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

// mode 卡 JSON（mcData/spellData）應有的欄名集（store {...newCard} 形）
const MODE_KEYS = ['due','stability','difficulty','elapsedDays','scheduledDays','reps','lapses','state','lastReview','buried','suspended','step','interval'];
const BASE_COLS = ['due','stability','difficulty','elapsed_days','scheduled_days','reps','lapses','state','last_review','buried','suspended','step'];
const baseSnap = (db, wid) => {
  const r = q1(db, `SELECT ${BASE_COLS.join(',')} FROM cards WHERE word_id=?`, wid);
  if (!r) return null;
  return BASE_COLS.map(c => `${c}=${r[c]}`).join('|');
};

try {
  // ── T1: 污染封堵（base flip 欄逐欄不變）＋ mc_data 承載 ──
  console.log('T1 mc 作答不污染 base flip 欄');
  const db1 = mkTmpDb('t1');
  addWords(db1, ['wm']);
  seedCard(db1, 'wm', { due: '2099-01-01T00:00:00Z', stability: 10, reps: 5, state: 2, lastReview: isoAgo(3) });
  // mc 無狀態 → 新卡路徑；base due 未來（flip 不到期），queue 從 mc 視圖取新卡
  const out1 = study(db1, 'mc', 5, ['a', 'q']);
  T('T1 study mc 完成 1 張（新卡經 mode 視圖入隊）', /完成 1 張/.test(out1), out1.split('\n').filter(l => /完成|共:/.test(l)).join(' '));
  const c1 = q1(db1, 'SELECT * FROM cards WHERE word_id=?', 'wm');
  const seeded = `due=2099-01-01T00:00:00Z|stability=10|difficulty=6|elapsed_days=0|scheduled_days=8|reps=5|lapses=0|state=2|last_review=${isoAgo(3)}|buried=0|suspended=0|step=0`;
  T('T1 base flip 欄 12 欄逐欄與 seed 前逐字相同（flip 零污染）',
    baseSnap(db1, 'wm') === seeded, baseSnap(db1, 'wm'));
  T('T1 mc_data 承載 mode 卡（state=1 learning, reps=1, due 非空）',
    (() => { const m = c1.mc_data && JSON.parse(c1.mc_data); return m && m.state === 1 && m.reps === 1 && !!m.due; })(),
    c1.mc_data || 'NULL');
  T('T1 spell_data 未被波及（NULL）', c1.spell_data === null);
  const lg1 = q1(db1, 'SELECT * FROM review_log');
  T('T1 review_log mode=mc card_state=0(mode 視圖新卡) 非 base state 2',
    lg1 && lg1.mode === 'mc' && lg1.card_state === 0 && lg1.new_state === 1,
    JSON.stringify(lg1 && { m: lg1.mode, cs: lg1.card_state, ns: lg1.new_state }));

  // ── T2: mc 進度接續（mode 卡為起點，非 base）──
  console.log('T2 mc 第二次 study 以 mode 卡為狀態源');
  // T1 Again → learning step0（due=+60s，study :3415 60s 下限）；等過期再續
  spawnSync('sleep', ['61']);
  const out2 = study(db1, 'mc', 5, ['g', 'q']);
  T('T2 第二次 mc study 完成 1 張（mode 卡 due=learning 分鐘級→稍後已到期）', /完成 1 張/.test(out2), out2.split('\n').filter(l => /完成|沒有/.test(l)).join(' '));
  const m2raw = q1(db1, 'SELECT mc_data d FROM cards WHERE word_id=?', 'wm').d;
  const m2 = m2raw ? JSON.parse(m2raw) : {};
  const lg2 = qAll(db1, 'SELECT * FROM review_log ORDER BY id');
  T('T2 mc_data reps 遞增至 2、第二筆 log card_state=1(mode 卡) 非 base 2',
    m2.reps === 2 && lg2.length === 2 && lg2[1].card_state === 1, JSON.stringify({ r: m2.reps, cs: lg2[1]?.card_state }));
  T('T2 base flip 欄仍逐欄未動', baseSnap(db1, 'wm') === seeded, baseSnap(db1, 'wm'));

  // ── T3: 容器新建＋flip queue 免疫 ──
  console.log('T3 spell 容器模板＋flip 語意隔離');
  const db3 = mkTmpDb('t3');
  addWords(db3, ['ws']);
  study(db3, 'spell', 5, ['g', 'q']);
  const c3 = q1(db3, 'SELECT * FROM cards WHERE word_id=?', 'ws');
  T('T3 新建容器行 due==""(鏡像 store 模板) state=0 reps=0 S=0 D=5（R1#2 補欄值）',
    c3 && c3.due === '' && c3.state === 0 && c3.reps === 0 && c3.stability === 0 && c3.difficulty === 5,
    JSON.stringify(c3 && { d: c3.due, s: c3.state, r: c3.reps, st: c3.stability, df: c3.difficulty }));
  T('T3 spell_data 有值', !!c3.spell_data);
  const out3f = study(db3, 'flip', 5, ['q']);
  T('T3 flip queue 不含容器卡（非到期也非新卡 — app 容器語意）', /沒有待複習卡片/.test(out3f), out3f.split('\n').find(l => /待複習|共:/.test(l)) || '');

  // ── T4: app 兼容 round-trip ──
  console.log('T4 mode JSON 欄名集 ⊇ store hydrate 所需');
  const keys = Object.keys(JSON.parse(q1(db3, 'SELECT spell_data d FROM cards WHERE word_id=?', 'ws').d));
  T('T4 欄名集齊全', MODE_KEYS.every(k => keys.includes(k)), keys.join(','));

  // ── T5: 已有 mcData 卡（mode state=2）起點真值 ──
  console.log('T5 log 起點=mode 卡真值');
  const db5 = mkTmpDb('t5');
  addWords(db5, ['wx']);
  const mcCard = { due: isoAgo(1), stability: 20, difficulty: 4, elapsedDays: 3, scheduledDays: 12, reps: 7, lapses: 1, state: 2, lastReview: isoAgo(3), step: 0, buried: false, suspended: false, interval: 12 };
  seedCard(db5, 'wx', { due: '2099-01-01T00:00:00Z', stability: 3, difficulty: 7, reps: 1, state: 0, mcData: JSON.stringify(mcCard) });
  study(db5, 'mc', 5, ['g', 'q']);
  const lg5 = q1(db5, 'SELECT * FROM review_log');
  T('T5 card_state=2(mcData) 而非 base state 0；elapsed=3(mcData lastReview)',
    lg5 && lg5.card_state === 2 && lg5.elapsed_days === 3, JSON.stringify(lg5 && { cs: lg5.card_state, e: lg5.elapsed_days }));
  const m5 = JSON.parse(q1(db5, 'SELECT mc_data d FROM cards WHERE word_id=?', 'wx').d);
  T('T5 mcData 更新(reps 8) 且 base 欄未動(state=0 reps=1)', m5.reps === 8 && q1(db5, 'SELECT state,reps FROM cards WHERE word_id=?', 'wx').state === 0,
    JSON.stringify({ m: m5.reps, b: q1(db5, 'SELECT state b, reps r FROM cards WHERE word_id=?', 'wx') }));

  // ── T6: flip 存檔不抹容器資料 ──
  console.log('T6 flip 存檔容器中性');
  const db6 = mkTmpDb('t6');
  addWords(db6, ['wy']);
  const mcJson = JSON.stringify(mcCard);
  seedCard(db6, 'wy', { due: isoAgo(1), lastReview: isoAgo(3), mcData: mcJson });
  study(db6, 'flip', 5, ['g', 'q']);
  T('T6 flip 作答後 mc_data 逐字不變（ON CONFLICT 不含容器欄）',
    q1(db6, 'SELECT mc_data d FROM cards WHERE word_id=?', 'wy').d === mcJson);

  // ── T7: audit/optimize 面 ──
  console.log('T7 audit 零差異＋optimize WHERE 可視');
  const audit7 = cli(db1, ['audit']);
  T('T7 flip audit 0 差異（base 未動、mc log 不入 flip replay）', /0 有差異/.test(audit7),
    audit7.split('\n').find(l => /稽核/.test(l)) || '');
  T('T7 mc 行 optimize 同款 WHERE 可視（2 筆）',
    qAll(db1, `SELECT id FROM review_log WHERE COALESCE(mode,'flip')='mc'`).length === 2);

  // ── T8: 負控制 ──
  console.log('T8 負控制');
  const src = readFileSync(CLI, 'utf8');
  // (a) 修前全形＝卡圖＋存檔雙還原（只剝卡圖則容器存檔仍在、非修前行為）→
  //     對「到期 base 卡」做 mc 評分 → flip 欄覆寫主斷言直擊（R1#3-F 測資）
  {
    let buggy = src.replace('const cardMap = modeCardMap(s, mode);', 'const cardMap = s.cards;');
    if (buggy === src) throw new Error('T8a 卡圖剝除失敗');
    const saveOld = src.slice(src.indexOf('  } else {\n    // E7:'), src.indexOf('  // E6: review_log 修前全程零寫入'));
    if (!saveOld.startsWith('  } else {')) throw new Error('T8a 存檔段定位失敗');
    const saveNew = `  } else {
    for (const [wid, card] of cardMap) {
      w.prepare(\`INSERT INTO cards (word_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,buried,suspended,step)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(word_id) DO UPDATE SET due=excluded.due,stability=excluded.stability,difficulty=excluded.difficulty,elapsed_days=excluded.elapsed_days,scheduled_days=excluded.scheduled_days,reps=excluded.reps,lapses=excluded.lapses,state=excluded.state,last_review=excluded.last_review,buried=excluded.buried,suspended=excluded.suspended,step=excluded.step\`)
        .run(wid, card.due, card.stability, card.difficulty, card.elapsedDays ?? 0, card.scheduledDays ?? 0, card.reps ?? 0, card.lapses ?? 0, card.state ?? 0, card.lastReview, card.buried ? 1 : 0, card.suspended ? 1 : 0, card.step ?? 0);
    }
  }
`;
    if (!src.includes(saveOld)) throw new Error('T8a 存檔段剝除失敗');
    buggy = buggy.replace(saveOld, saveNew);
    const bin = join(bugDir, `e7-a-${process.pid}.mjs`);
    writeFileSync(bin, buggy);
    try {
      // R1#3-F 採納：seed 改「base 到期卡」（非未來 due）——修前 s.cards 視圖會把
      // 它當 flip 到期卡取走評分＋統一存檔覆寫 → 污染主斷言 dirty===true 直擊，
      // 不再靠「新卡不入隊」逃生口
      const dbA = mkTmpDb('t8a');
      addWords(dbA, ['wm']);
      seedCard(dbA, 'wm', { due: isoAgo(1), stability: 10, reps: 5, state: 2, lastReview: isoAgo(3) });
      const seededA = `due=${isoAgo(1)}|stability=10|difficulty=6|elapsed_days=0|scheduled_days=8|reps=5|lapses=0|state=2|last_review=${isoAgo(3)}|buried=0|suspended=0|step=0`;
      const outA = study(dbA, 'mc', 5, ['g', 'q'], bin);
      const dirtyA = baseSnap(dbA, 'wm') !== seededA;
      T('T8a 修前(s.cards) 對到期 base 卡做 mc 評分 → flip 欄覆寫（污染主斷言）',
        dirtyA === true, `dirty=${dirtyA} snap=${baseSnap(dbA, 'wm')} out=${outA.split('\n').filter(l => /完成|沒有/.test(l))[0] || ''}`);
      T('T8a mc_data 從未寫入（修前丟失面）', q1(dbA, 'SELECT mc_data d FROM cards WHERE word_id=?', 'wm').d === null);
    } finally { rmSync(bin, { force: true }); }
  }
  // (b) 存檔分流還原成統一 base upsert（卡圖保持 mode-aware）→ spell_data 恆 NULL
  {
    const saveOld = src.slice(src.indexOf('  } else {\n    // E7:'), src.indexOf('  // E6: review_log 修前全程零寫入'));
    const saveNew = `  } else {
    for (const [wid, card] of cardMap) {
      w.prepare(\`INSERT INTO cards (word_id,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,state,last_review,buried,suspended,step)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(word_id) DO UPDATE SET due=excluded.due,stability=excluded.stability,difficulty=excluded.difficulty,elapsed_days=excluded.elapsed_days,scheduled_days=excluded.scheduled_days,reps=excluded.reps,lapses=excluded.lapses,state=excluded.state,last_review=excluded.last_review,buried=excluded.buried,suspended=excluded.suspended,step=excluded.step\`)
        .run(wid, card.due, card.stability, card.difficulty, card.elapsedDays ?? 0, card.scheduledDays ?? 0, card.reps ?? 0, card.lapses ?? 0, card.state ?? 0, card.lastReview, card.buried ? 1 : 0, card.suspended ? 1 : 0, card.step ?? 0);
    }
  }
`;
    if (!saveOld.startsWith('  } else {') || !src.includes(saveOld)) throw new Error('T8b 剝除失敗');
    const buggy = src.replace(saveOld, saveNew);
    const bin = join(bugDir, `e7-b-${process.pid}.mjs`);
    writeFileSync(bin, buggy);
    try {
      const dbB = mkTmpDb('t8b');
      addWords(dbB, ['ws']);
      study(dbB, 'spell', 5, ['g', 'q'], bin);
      const cB = q1(dbB, 'SELECT * FROM cards WHERE word_id=?', 'ws');
      T('T8b 統一 base upsert → spell_data 恆 NULL＋base 欄被 mode 覆寫',
        cB.spell_data === null && cB.reps === 1 && cB.state === 1,
        JSON.stringify({ sp: cB.spell_data, r: cB.reps, s: cB.state }));
    } finally { rmSync(bin, { force: true }); }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nE7 驗證: ${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAIL` : ' ALL PASS'}`);
process.exit(fail ? 1 : 0);
