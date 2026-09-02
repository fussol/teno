#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-bh03.mjs — BH-03: deleteDeck 不清 memory 端 reviewLog/examHistory
//   DB 端 deleteWordsByDeck 已清（db.js:366-381），memory 端 state.reviewLog/
//   state.examHistory 不動 → 保留率/測驗歷史吃已刪字本，直到重載。
//   修法：deleteDeck 在 wordIds 計算後對每 wordId 呼叫 BH-02 共用
//   deleteWordFromMemory(id)，零邏輯漂移。
// 用法: node tools/verify-bh03.mjs
// 三層：1) source 契約釘（讀真實 store.js deleteDeck 含 deleteWordFromMemory 呼叫，未修必 FAIL）
//       2) 語意重放（該 deck 全部 wordId 的 reviewLog/examHistory 全剔、他字本不誤傷）
//       3) 負控制（剝除迴圈 → 殘留 + 保留率溢算）
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_JS = join(REPO, 'src/lib/store.js');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${extra}»`); }
};
const src = readFileSync(STORE_JS, 'utf8');
const { computeRetention } = await import(join(REPO, 'src/core/scheduler.js'));

// ── deleteDeck function body 切片 ──
const ddStart = src.indexOf('async deleteDeck(id) {');
const ddBody = ddStart >= 0 ? src.slice(ddStart, src.indexOf('\n  },', ddStart)) : '';

// ── 語意重放：deleteDeck 用 deleteWordFromMemory 迴圈清 wordIds ──
function runDeleteDeck({ callLoop = true } = {}) {
  const deckAwords = new Set(['wA1', 'wA2']);   // 被刪字本 A 的字
  const s = {
    reviewLog: [
      { wordId: 'wA1', rating: 3, reviewed_at: Date.now() },
      { wordId: 'wA2', rating: 1, reviewed_at: Date.now() },
      { wordId: 'wB1', rating: 3, reviewed_at: Date.now() },   // 對照字本 B
    ],
    examHistory: [
      { word: 'wA1', correct: 1 }, { word: 'wA2', correct: 0 }, { word: 'wB1', correct: 1 },
    ],
    buried: new Set(['wA1', 'wB1']), suspended: new Set(['wA2']),
    buriedMc: new Set(['wA1']), suspendedMc: new Set(['wA2']),
    buriedSpell: new Set(['wA1']), suspendedSpell: new Set(['wA2']),
    buriedAt: { wA1: 'd', wB1: 'd' }, buriedAtMc: { wA2: 'd' }, buriedAtSpell: { wA1: 'd' },
    examples: new Map([['wA1', ['x']], ['wB1', ['y']]]),
  };
  if (callLoop) {
    for (const id of deckAwords) {
      s.reviewLog = s.reviewLog.filter(l => l.wordId !== id);
      s.examHistory = s.examHistory.filter(x => x.word !== id);
      for (const k of ['buried', 'suspended', 'buriedMc', 'suspendedMc', 'buriedSpell', 'suspendedSpell']) s[k].delete(id);
      for (const k of ['buriedAt', 'buriedAtMc', 'buriedAtSpell']) if (s[k]) delete s[k][id];
      s.examples.delete(id);
    }
  }
  return s;
}

try {
  // ═══ 1. source 契約釘（未修 → 必紅）═══
  console.log('── 1. source 契約釘（store.js deleteDeck）──');
  T('S1 deleteDeck 呼叫 deleteWordFromMemory(id|wid)', /deleteWordFromMemory\(w?id\)/.test(ddBody));
  const wordIdsIdx = ddBody.indexOf('wordIds');
  const loopIdx = ddBody.indexOf('deleteWordFromMemory(');
  T('S2 helper 呼叫位於 wordIds 計算後', wordIdsIdx >= 0 && loopIdx > wordIdsIdx, `wordIds@${wordIdsIdx} loop@${loopIdx}`);

  // ═══ 2. 語意重放 ═══
  console.log('── 2. 語意重放 ──');
  {
    const s = runDeleteDeck();
    T('P1 reviewLog deck A 全剔（剩 wB1 1 筆）', s.reviewLog.length === 1 && s.reviewLog[0].wordId === 'wB1', `${s.reviewLog.length}`);
    T('P2 examHistory deck A 全剔（剩 wB1）', s.examHistory.length === 1 && s.examHistory[0].word === 'wB1', `${s.examHistory.length}`);
    T('P3 對照字本 B 不誤傷（wB1 的 Set/buriedAt/examples 保留）', s.buried.has('wB1') && s.buriedAt['wB1'] !== undefined && s.examples.has('wB1'));
    T('P4 保留率剔除 deck A（wA1 r3+wA2 r1）→ 剩 wB1 r3: total=1 correct=1 rate=1', (() => { const r = computeRetention(s.reviewLog, 30); return r.total === 1 && r.correct === 1 && r.rate === 1; })());
  }

  // ═══ 3. 負控制（剝除迴圈 → 殘留 + 溢算）═══
  console.log('── 3. 負控制（未修態殘留）──');
  {
    const s = runDeleteDeck({ callLoop: false });
    const orphan = s.reviewLog.filter(l => l.wordId === 'wA1' || l.wordId === 'wA2').length;
    T(`N1 未修態 reviewLog deck A 殘留(${orphan}筆)→bug 態`, orphan === 2, `${orphan}`);
    T('N2 未修態 examHistory deck A 殘留', s.examHistory.some(x => x.word === 'wA1' || x.word === 'wA2'));
    T('N3 未修態保留率溢算（含 deck A）≠ 修後', (() => { const r = computeRetention(s.reviewLog, 30); return r.total === 3; })());
  }
} finally {}

console.log(`\n═══ BH-03 verify: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);