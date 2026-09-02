#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-d20-dual-generations.mjs — D20-SR1: exam_history 雙世代孤兒殲滅
//   消除 deleteWordsByDeck:370 / deleteWord:226 各漏一世代問題。
// 用法: node tools/verify-d20-dual-generations.mjs
// 純 tmp SQLite（node:sqlite DatabaseSync），嚴禁碰 ~/.config/com.teno.app/teno.db。
// 雙態：動工前（只蓋一族）RED；修後（雙世代並刪）GREEN。負控制剝除單一族必紅。
// ═══════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_JS = join(REPO, 'src/lib/db.js');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${extra}»`); }
};
const dir = mkdtempSync(join(tmpdir(), 'd20sr1-'));

// ── 真 DDL 沙箱：與實際 schema 一致（exam_history.word TEXT 雙世代混存）──
function mkDb(p) {
  const d = new DatabaseSync(p);
  d.exec(`
    CREATE TABLE words (id TEXT PRIMARY KEY, word TEXT NOT NULL, deck TEXT NOT NULL DEFAULT 'Default');
    CREATE TABLE cards (word_id TEXT PRIMARY KEY);
    CREATE TABLE review_log (id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT NOT NULL, rating INTEGER NOT NULL);
    CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
    CREATE TABLE exam_history (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL, correct INTEGER NOT NULL);
  `);
  // fleets: word w1 (id 世代 exam 存 id 'w1')、word w2 (legacy 世代 exam 存文字 'apple')
  d.prepare("INSERT INTO words(id,word,deck) VALUES ('w1','apple','A'),('w2','banana','A'),('w3','cherry','B')").run();
  d.prepare("INSERT INTO cards(word_id) VALUES ('w1'),('w2'),('w3')").run();
  d.prepare("INSERT INTO review_log(word_id,rating) VALUES ('w1',1),('w2',3)").run();
  // 對 deck A 的 exam_history：id 世代('w1','w2') ＋ legacy 文字世代('apple','banana')
  d.prepare("INSERT INTO exam_history(word,correct) VALUES ('w1',1),('w2',0),('apple',1),('banana',0)").run();
  // 對照組 deck B（不可誤傷）：id 世代('w3') + legacy 文字('cherry')
  d.prepare("INSERT INTO exam_history(word,correct) VALUES ('w3',1),('w3',0),('cherry',1)").run();
  d.close();
  return p;
}
const allExam = (p) => new DatabaseSync(p, { readOnly: true }).prepare('SELECT word FROM exam_history ORDER BY word').all().map(r => r.word);

try {
  // ═══ T1+T2: 重放 deleteWordsByDeck 修後語意（雙世代雙 DELETE）═══
  console.log('── T1/T2 deleteWordsByDeck 雙世代刪除語意重放 ──');
  {
    const p = mkDb(join(dir, 't1.db'));
    const d = new DatabaseSync(p);
    // 精確重現修後 db.js deleteWordsByDeck 的兩條 exam 語意（order 取決 words 在場）
    const deckA = 'A';
    d.prepare('DELETE FROM review_log WHERE word_id IN (SELECT id FROM words WHERE deck = ?)').run(deckA);
    d.prepare('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = ?)').run(deckA);   // B4 後 id 世代
    d.prepare('DELETE FROM exam_history WHERE word IN (SELECT word FROM words WHERE deck = ?)').run(deckA);  // B4 前 legacy 文字
    d.prepare('DELETE FROM cards WHERE word_id IN (SELECT id FROM words WHERE deck = ?)').run(deckA);
    d.prepare('DELETE FROM words WHERE deck = ?').run(deckA);
    d.close();
    const left = allExam(p);
    // deck A exam 該剩 0（w1/w2/apple/banana 全屬 A）；deck B 對照 3 筆（w3×2 + cherry）原封
    T(`T1 deck A 雙世代 exam_history 皆清（剩 ${left.length}）`,
      left.filter(w => w === 'w1' || w === 'w2' || w === 'apple' || w === 'banana').length === 0, left.join(','));
    T('T1b 對照組 deck B 零誤傷（w3×2+cherry 仍在）',
      left.filter(w => w === 'w3' || w === 'cherry').length === 3, left.join(','));
  }

  // ═══ T3+T4: 重放 deleteWord 修後語意（wordText + id 雙族）═══
  console.log('── T3/T4 deleteWord 雙世代刪除語意重放 ──');
  {
    const p = mkDb(join(dir, 't3.db'));
    const d = new DatabaseSync(p);
    const id = 'w1';
    const wr = d.prepare('SELECT word FROM words WHERE id = ?').get(id);
    const wordText = wr ? wr.word : undefined;
    d.prepare('DELETE FROM cards WHERE word_id = ?').run(id);
    d.prepare('DELETE FROM review_log WHERE word_id = ?').run(id);
    d.prepare('DELETE FROM exam_history WHERE word = ?').run(String(id));                              // D20-SR1: B4 後 id 世代
    if (wordText) d.prepare('DELETE FROM exam_history WHERE word = ?').run(wordText);                   // D14: legacy 文字世代
    d.prepare('DELETE FROM words WHERE id = ?').run(id);
    d.close();
    const left = allExam(p);
    // w1 的 exam = id 世代('w1') + legacy('apple') 皆清；w2/banana/cherry/w3 對照原封
    T(`T3 deleteWord 清 w1 雙世代 exam（剩 ${left.length}）`,
      left.filter(w => w === 'w1' || w === 'apple').length === 0, left.join(','));
    T('T4 對照組（w2/banana for deck B 不誤傷）',
      left.filter(w => w === 'w2' || w === 'banana' || w === 'w3' || w === 'cherry').length === 5, left.join(','));
  }

  // ═══ T5/T6: source-level 契約釘（防未來回歸）═══
  console.log('── T5/T6 source 契約釘（db.js 同時含兩世代 DELETE）──');
  const dbSrc = readFileSync(DB_JS, 'utf8');
  {
    const dwbd = dbSrc.match(/export async function deleteWordsByDeck[\s\S]*?\n}/)?.[0] || '';
    const hasIdOnly = /DELETE FROM exam_history WHERE word IN \(SELECT id FROM words WHERE deck = \$1\)/.test(dwbd);
    const hasWordAlso = /DELETE FROM exam_history WHERE word IN \(SELECT word FROM words WHERE deck = \$1\)/.test(dwbd);
    T('T5 deleteWordsByDeck 含 id 世代 DELETE', hasIdOnly);
    T('T5b deleteWordsByDeck 含 legacy 文字世代 DELETE', hasWordAlso);
    // 順序：兩條 exam DELETE 都在 words DELETE 前（子查詢依賴）
    const wordsIdx = dwbd.indexOf("DELETE FROM words WHERE deck = $1");
    const examIdx1 = dwbd.indexOf('DELETE FROM exam_history WHERE word IN (SELECT id');
    const examIdx2 = dwbd.indexOf('DELETE FROM exam_history WHERE word IN (SELECT word');
    T('T5c 兩條 exam DELETE 在 DELETE words 之前',
      examIdx1 > 0 && examIdx2 > examIdx1 && wordsIdx > examIdx2, `examId=${examIdx1} examWord=${examIdx2} words=${wordsIdx}`);
    const dw = dbSrc.match(/export async function deleteWord[\s\S]*?\n}/)?.[0] || '';
    const hasIdDel = /DELETE FROM exam_history WHERE word = \$1'\s*,\s*\[String\(id\)\]/.test(dw);
    const hasTextDel = /DELETE FROM exam_history WHERE word = \$1'\s*,\s*\[wordText\]/.test(dw);
    T('T6 deleteWord 含 word_id 世代 DELETE（String(id)）', hasIdDel);
    T('T6b deleteWord 含 legacy 文字世代 DELETE（wordText）', hasTextDel);
  }

  // ═══ T7 負控制：剝除 one 世代 → 該世代孤兒留存 → 判別翻紅 ═══
  console.log('── T7 負控制（剝除單一族 → 孤兒留 → harness 能抓）──');
  {
    const p = mkDb(join(dir, 't7.db'));
    const d = new DatabaseSync(p);
    // 模擬「未修 bug 版」：只跑 id 世代（deleteWordsByDeck:370 原樣）
    d.prepare('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = ?)').run('A');
    d.close();
    const left = allExam(p);
    // legacy 文字世代('apple','banana') 應遭留（= bug 態）
    const legacyOrphan = left.filter(w => w === 'apple' || w === 'banana').length;
    console.log(`  INFO  剝除 legacy 族 → 孤兒留 ${legacyOrphan} 筆`);
    T('T7 未修版僅清 id 族、legacy 文字孤兒留存（bug 多被 source 釘抓到）', legacyOrphan === 2, `orphans=${legacyOrphan}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ D20-SR1 verify: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);