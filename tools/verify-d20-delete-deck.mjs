#!/usr/bin/env node
// verify-d20-delete-deck.mjs — D20: CLI delete-deck 幽靈 decks 列＋exam/review 孤兒＋rename 不同步 decks 表。
// 修法＝事務化＋註冊面(decks/deckOrder)/歷史面(exam 雙世代/review_log 顯式)穷举清理；rename 補 decks.name 同步。
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
const dir = mkdtempSync(join(tmpdir(), 'd20-verify-'));

const D20_MARK_DEL = '// D20: 事務＋註冊面/歷史面穷举清理';
const D20_MARK_REN = '// D20: words＋decks.name 同步';
const SEC_START = 'function cmdRenameDeck() {';
const SEC_END = 'function cmdTags() {';
// HEAD (2026-08-28, commit 47227de) 兩函式逐字原文（負控制反換用）
const ORIGINAL_BLOCK = `function cmdRenameDeck() {
  const [from, to] = args;
  if (!from || !to) return console.log('需: rename-deck <舊名> <新名>');
  backupDb();
  const w = dbw();
  w.prepare('UPDATE words SET deck=? WHERE deck=?').run(to, from);
  w.close();
  log('WRITE', \`rename-deck "\${from}" → "\${to}"\`);
  audit('rename-deck', \`\${from} → \${to}\`);
  console.log(\`已將 deck "\${from}" 改名 "\${to}"\`);
}

function cmdDeleteDeck() {
  const deck = args[0];
  if (!deck) return console.log('需 deck 名');
  if (!args.includes('--yes')) return console.log(\`確定刪除 deck "\${deck}" 及其中所有單字? 加 --yes\`);
  backupDb();
  const w = dbw();
  w.prepare('DELETE FROM cards WHERE word_id IN (SELECT id FROM words WHERE deck=?)').run(deck);
  w.prepare('DELETE FROM words WHERE deck=?').run(deck);
  w.close();
  log('WRITE', \`delete-deck "\${deck}"\`);
  audit('delete-deck', \`刪除牌組 \${deck}\`);
  console.log(\`已刪除 deck "\${deck}"\`);
}

`;

// ── 沙箱：真 DDL（review_log FK 可關＝legacy schema 世代模擬）──
function mkDeckDb(p, { fk = true } = {}) {
  const d = new DatabaseSync(p);
  d.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, definition TEXT, part_of_speech TEXT,
      pronunciation TEXT, example TEXT, deck TEXT NOT NULL DEFAULT 'Default', tags TEXT DEFAULT '',
      image TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), description TEXT DEFAULT '',
      related TEXT DEFAULT '[]', forms TEXT DEFAULT '[]', synonym TEXT NOT NULL DEFAULT '',
      antonym TEXT NOT NULL DEFAULT '', derivative TEXT NOT NULL DEFAULT '', examples TEXT NOT NULL DEFAULT '');
    CREATE TABLE cards (word_id TEXT PRIMARY KEY${fk ? ' REFERENCES words(id) ON DELETE CASCADE' : ''},
      due TEXT NOT NULL DEFAULT (datetime('now')), stability REAL NOT NULL DEFAULT 2.5,
      difficulty REAL NOT NULL DEFAULT 0.0, elapsed_days INTEGER NOT NULL DEFAULT 0,
      scheduled_days INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, last_review TEXT,
      buried INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0,
      step INTEGER NOT NULL DEFAULT 0, mc_data TEXT, spell_data TEXT);
    CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
      word_id TEXT NOT NULL${fk ? ' REFERENCES words(id) ON DELETE CASCADE' : ''}, rating INTEGER NOT NULL,
      elapsed_days INTEGER, scheduled_days INTEGER, stability REAL, difficulty REAL,
      reviewed_at TEXT DEFAULT (datetime('now')), duration INTEGER, mode TEXT NOT NULL DEFAULT 'flip',
      card_state INTEGER, new_state INTEGER);
    CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT '#5e6ad2');
    CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL,
      correct INTEGER NOT NULL, question_type TEXT, examined_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
    INSERT INTO decks VALUES ('dA','Alpha','#111111'),('dB','Beta','#222222');
    INSERT INTO settings VALUES ('deckOrder','["dA","dB"]');
    INSERT INTO words(id,word,deck) VALUES ('w1','apple','Alpha'),('w2','banana','Beta');
    INSERT INTO cards(word_id) VALUES ('w1'),('w2');
    INSERT INTO review_log(word_id,rating) VALUES ('w1',1),('w1',3),('w2',3);
    INSERT INTO exam_history(word,correct) VALUES ('w1',1),('w1',0),('apple',1),('w2',1),('banana',0);
  `);
  d.close();
  return p;
}
const q1 = (p, sql, ...a) => { try { return new DatabaseSync(p, { readOnly: true }).prepare(sql).get(...a)?.n; } catch { return undefined; } }
function run(cliPath, argv, targetDb) {
  return spawnSync('node', [cliPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: targetDb, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
function mkTarget(tag, opts) { const d2 = join(dir, tag); mkdirSync(d2); return mkDeckDb(join(d2, 'teno.db'), opts); }
// 逐面試測
const probe = (p) => ({
  alphaWords: q1(p, "SELECT count(*) n FROM words WHERE deck='Alpha'"),
  betaWords: q1(p, "SELECT count(*) n FROM words WHERE deck='Beta'"),
  alphaCards: q1(p, "SELECT count(*) n FROM cards WHERE word_id='w1'"),
  betaCards: q1(p, "SELECT count(*) n FROM cards WHERE word_id='w2'"),
  alphaLog: q1(p, "SELECT count(*) n FROM review_log WHERE word_id='w1'"),
  betaLog: q1(p, "SELECT count(*) n FROM review_log WHERE word_id='w2'"),
  logOrphans: q1(p, "SELECT count(*) n FROM review_log WHERE word_id NOT IN (SELECT id FROM words)"),
  examAlpha: q1(p, "SELECT count(*) n FROM exam_history WHERE word IN ('w1','apple')"),
  examBeta: q1(p, "SELECT count(*) n FROM exam_history WHERE word IN ('w2','banana')"),
  decks: (() => { try { return new DatabaseSync(p, { readOnly: true }).prepare('SELECT group_concat(name) g FROM decks').get().g; } catch { return undefined; } })(),
  deckOrder: (() => { try { return new DatabaseSync(p, { readOnly: true }).prepare("SELECT value FROM settings WHERE key='deckOrder'").get().value; } catch { return undefined; } })(),
});

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(D20_MARK_DEL) && src.includes(D20_MARK_REN);

  console.log('T1 主鏈（現行 schema）：穷举清理＋對照組不誤傷');
  {
    const tgt = mkTarget('t1');
    const r = run(CLI, ['delete-deck', 'Alpha', '--yes'], tgt);
    const a = probe(tgt);
    T('T1a 刪除成功回報', r.stdout.includes('已刪除 deck "Alpha"') && r.status === 0, r.stdout.trim().split('\n').pop());
    T('T1b Alpha words/cards 全清', a.alphaWords === 0 && a.alphaCards === 0);
    T('T1c decks 幽靈列已刪（佇列核心）', a.decks === 'Beta', `decks=${a.decks}`);
    T('T1d exam 雙世代（id 族＋legacy 文字族）皆清', a.examAlpha === 0, `examAlpha=${a.examAlpha}`);
    T('T1e review_log 全清', a.alphaLog === 0 && a.logOrphans === 0);
    T('T1f deckOrder 清 dA 留 dB', a.deckOrder === '["dB"]', `deckOrder=${a.deckOrder}`);
    T('T1g Beta 對照組逐項原封', a.betaWords === 1 && a.betaCards === 1 && a.betaLog === 1 && a.examBeta === 2);
  }

  console.log('T2 legacy schema（review_log 無 FK 約束世代）：顯式刪封堵級聯依賴（佇列「review_log 孤兒」真牙）');
  {
    const tgt = mkTarget('t2', { fk: false });
    const r = run(CLI, ['delete-deck', 'Alpha', '--yes'], tgt);
    const a = probe(tgt);
    T('T2a 無 FK 世代刪除成功', r.stdout.includes('已刪除') && r.status === 0, r.stdout.trim().split('\n').pop());
    T('T2b 顯式刪零孤兒（CASCADE 不在亦清）', a.alphaLog === 0 && a.logOrphans === 0, `log=${a.alphaLog} orphans=${a.logOrphans}`);
  }

  console.log('T5 words-only deck（decks 表無行）：不 crash、跳註冊面清理');
  {
    const tgt = mkTarget('t5');
    const d5 = new DatabaseSync(tgt);
    d5.exec("INSERT INTO words(id,word,deck) VALUES ('g1','fig','Gamma'); INSERT INTO cards(word_id) VALUES ('g1')");
    d5.close();
    const r = run(CLI, ['delete-deck', 'Gamma', '--yes'], tgt);
    const a = probe(tgt);
    T('T5a 不 crash＋成功回報＋exit 0', r.status === 0 && r.stdout.includes('已刪除 deck "Gamma"'), r.stdout.trim().split('\n').pop());
    T('T5b words 照刪＋decks/deckOrder 不误傷', a.alphaWords === 1 && a.decks === 'Alpha,Beta' && a.deckOrder === '["dA","dB"]');
  }

  console.log('T6 閘門與不存在 deck（回歸釘）');
  {
    const tgt = mkTarget('t6');
    const r1 = run(CLI, ['delete-deck', 'Alpha'], tgt);
    const a1 = probe(tgt);
    T('T6a 無 --yes 拒絕且零刪除', r1.stdout.includes('加 --yes') && a1.alphaWords === 1);
    const r2 = run(CLI, ['delete-deck', 'Zeta', '--yes'], tgt);
    const a2 = probe(tgt);
    T('T6b 不存在 deck 不 crash 不误刪', r2.status === 0 && a2.betaWords === 1 && a2.alphaWords === 1);
  }

  console.log('T7 rename-deck 同類修復＋UNIQUE 回滾釘');
  {
    const tgt = mkTarget('t7');
    const r = run(CLI, ['rename-deck', 'Alpha', 'Alpha2'], tgt);
    const a = probe(tgt);
    T('T7a rename 成功＋decks.name 同步', r.stdout.includes('改名') && a.decks === 'Alpha2,Beta', `decks=${a.decks}`);
    T('T7b words.deck 同步', q1(tgt, "SELECT count(*) n FROM words WHERE deck='Alpha2'") === 1 && a.alphaWords === 0);
    T('T7c Beta 對照不動', a.betaWords === 1);
    // UNIQUE 衝突：Beta → Alpha2（已存在）→ 整個回滾零部分寫入
    const r2 = run(CLI, ['rename-deck', 'Beta', 'Alpha2'], tgt);
    T('T7d UNIQUE 衝突拒絕＋exit 1', r2.stdout.includes('改名失敗') && r2.status === 1, r2.stdout.trim().split('\n').pop());
    const a2 = probe(tgt);
    T('T7e 回滾零部分寫入（words 未先行掛新名）', a2.betaWords === 1 && a2.decks === 'Alpha2,Beta', `betaWords=${a2.betaWords} decks=${a2.decks}`);
  }

  console.log('T8 負控制：HEAD 版兩函式逐字反換 → 幽靈列/孤兒/不同步精準重現');
  {
    const s0 = src.indexOf(SEC_START), s1 = src.indexOf(SEC_END);
    let buggySrc;
    if (fixed) {
      buggySrc = src.slice(0, s0) + ORIGINAL_BLOCK + src.slice(s1);
      T('T8a 反換真實性（剝後無 D20 標記＋區段在位）',
        !buggySrc.includes('D20:') && s0 >= 0 && s1 > s0 && buggySrc !== src);
    } else {
      buggySrc = src;
      T('T8a 反換真實性（工作區即原版）', !buggySrc.includes('D20:'));
    }
    const bugDir = join(dir, 'bugsub'); mkdirSync(bugDir);
    if (!existsSync(join(dir, 'src'))) symlinkSync(join(REPO, 'src'), join(dir, 'src'), 'dir');
    writeFileSync(join(bugDir, 'cli.mjs'), buggySrc);
    const BCLI = join(bugDir, 'cli.mjs');
    { // 現行 schema：幽靈 decks 列＋exam 孤兒重現
      const tgt = mkTarget('t8');
      const r = run(BCLI, ['delete-deck', 'Alpha', '--yes'], tgt);
      const a = probe(tgt);
      T('T8b 負控制幽靈 decks 列留存（佇列核心重現）', a.decks === 'Alpha,Beta' && r.stdout.includes('已刪除'), `decks=${a.decks}`);
      T('T8c 負控制 exam 孤兒留存（兩族皆留）', a.examAlpha === 3, `examAlpha=${a.examAlpha}`);
      T('T8d 負控制 deckOrder 髒值留存', a.deckOrder === '["dA","dB"]');
    }
    { // legacy schema：review_log 孤兒重現（級聯不在場＝舊世代真災情）
      const tgt = mkTarget('t8b', { fk: false });
      run(BCLI, ['delete-deck', 'Alpha', '--yes'], tgt);
      const a = probe(tgt);
      T('T8e 負控制 legacy 世代 review_log 孤兒×2', a.logOrphans === 2, `orphans=${a.logOrphans}`);
    }
    { // rename：decks.name 停留旧名
      const tgt = mkTarget('t8c');
      run(BCLI, ['rename-deck', 'Alpha', 'Alpha2'], tgt);
      const a = probe(tgt);
      T('T8f 負控制 rename 後 decks.name 舊名（GUI 仍列旧名）', a.decks === 'Alpha,Beta', `decks=${a.decks}`);
    }
  }

  console.log('T9 結構釘（源碼級契約）');
  if (fixed) {
    const sec0 = src.indexOf(SEC_START), secE = src.indexOf(SEC_END);
    const sec = src.slice(sec0, secE);
    T('T9a 兩函式皆事務包裹（BEGIN/COMMIT/ROLLBACK ×2）',
      (sec.match(/w\.exec\('BEGIN'\)/g) || []).length === 2 &&
      (sec.match(/w\.exec\('COMMIT'\)/g) || []).length === 2 &&
      (sec.match(/w\.exec\('ROLLBACK'\)/g) || []).length === 2);
    const examIdx = sec.indexOf('DELETE FROM exam_history'), wordsIdx = sec.indexOf("DELETE FROM words WHERE deck=?");
    const reviewIdx = sec.indexOf('DELETE FROM review_log'), cardsIdx = sec.indexOf('DELETE FROM cards');
    T('T9b 刪除順序釘：exam/review/cards 皆在 DELETE words 前（子查詢依賴）',
      examIdx > 0 && reviewIdx > examIdx && cardsIdx > reviewIdx && wordsIdx > cardsIdx,
      `exam=${examIdx} review=${reviewIdx} cards=${cardsIdx} words=${wordsIdx}`);
    T('T9c exam 雙世代 OR 條在位（word＋id 兩族）',
      sec.includes('word IN (SELECT word FROM words WHERE deck=?) OR word IN (SELECT id FROM words WHERE deck=?)'));
    T('T9d decks 行刪除＋deckOrder 清理在 rec 守衛内（words-only deck 路徑）',
      sec.includes('if (rec)') && sec.includes('DELETE FROM decks WHERE id=?'));
  } else {
    console.log('  ⏭ SKIPPED T9（fixed 標記不在場，負控制態）');
  }
  console.log('T10 deckOrder 髒值容忍（R1#3 m9 無牙防線補釘：髒值跳過清理不擋刪除主路徑）');
  {
    const tgt = mkTarget('t10');
    const d10 = new DatabaseSync(tgt);
    d10.prepare("UPDATE settings SET value='not-json-broken{{{' WHERE key='deckOrder'").run();
    d10.close();
    const r = run(CLI, ['delete-deck', 'Alpha', '--yes'], tgt);
    const a = probe(tgt);
    T('T10a 髒 deckOrder 不炸主路徑（exit 0＋刪除成功）', r.status === 0 && r.stdout.includes('已刪除 deck "Alpha"'), `status=${r.status} | ${r.stdout.trim().split('\n').pop()}`);
    T('T10b 刪除照完成（words/decks 行全清）', a.alphaWords === 0 && a.decks === 'Beta', `decks=${a.decks}`);
    T('T10c 髒值原封不覆寫（跳過清理＝不假修）', a.deckOrder === 'not-json-broken{{{', `deckOrder=${a.deckOrder}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ verify-d20: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
