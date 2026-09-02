#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-bh02.mjs — BH-02: deleteWord memory 端清理不全（動保留率）
//   deleteWord 只清 words/cardsMc/cardsSpell，memory 端 reviewLog/examHistory
//   /六 Set/三 buriedAt/examples 全殘留 → 保留率 computeRetention 吃已刪字髒資料。
// 用法: node tools/verify-bh02.mjs
// 四層：1) 源碼契約釘（讀真實 store.js deleteWord + deleteWordFromMemory，未修必 FAIL）
//       2) 保留率實測（import 真實 computeRetention：含已刪字溢算 vs 剔除後正確）
//       3) 語意重放 deleteWordFromMemory（剔除正確、存活字不誤傷）
//       4) 負控制（剝除 helper 呼叫 → 殘留 + 保留率溢算）
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

// ℹ 真實 computeRetention（scheduler.js 純函式，window內 total/correct）
const { computeRetention } = await import(join(REPO, 'src/core/scheduler.js'));

// ── deleteWord function body 切片 ──
const dwStart = src.indexOf('async deleteWord(id) {');
const dwBody = dwStart >= 0 ? src.slice(dwStart, src.indexOf('\n  },', dwStart)) : '';
// ── deleteWordFromMemory helper body 切片 ──
const hStart = src.indexOf('function deleteWordFromMemory(id) {');
const hBody = hStart >= 0 ? src.slice(hStart, src.indexOf('\n}', hStart)) : '';

// ── 語意重放 deleteWordFromMemory ──
function runPurge({ callHelper = true } = {}) {
  const s = {
    reviewLog: [
      { wordId: 'gone', rating: 3, reviewed_at: Date.now() }, { wordId: 'gone', rating: 1, reviewed_at: Date.now() },
      { wordId: 'alive', rating: 3, reviewed_at: Date.now() }, { wordId: 'alive', rating: 3, reviewed_at: Date.now() },
    ],
    examHistory: [{ word: 'gone', correct: 1 }, { word: 'alive', correct: 1 }],
    buried: new Set(['gone', 'alive']), suspended: new Set(['gone']),
    buriedMc: new Set(['gone']), suspendedMc: new Set(['alive']),
    buriedSpell: new Set(['gone']), suspendedSpell: new Set(['gone']),
    buriedAt: { gone: '2026-08-01' }, buriedAtMc: { gone: '2026-08-01' }, buriedAtSpell: { gone: '2026-08-01' },
    examples: new Map([['gone', ['a']], ['alive', ['b']]]),
  };
  if (callHelper) {
    s.reviewLog = s.reviewLog.filter(l => l.wordId !== 'gone');
    s.examHistory = s.examHistory.filter(x => x.word !== 'gone');
    for (const k of ['buried', 'suspended', 'buriedMc', 'suspendedMc', 'buriedSpell', 'suspendedSpell']) s[k].delete('gone');
    for (const k of ['buriedAt', 'buriedAtMc', 'buriedAtSpell']) delete s[k]['gone'];
    s.examples.delete('gone');
  }
  return s;
}

try {
  // ═══ 1. 源碼契約釘（未修 → 必紅）═══
  console.log('── 1. source 契約釘（store.js deleteWord + helper）──');
  T('S1 deleteWord 呼叫 deleteWordFromMemory(id)', /deleteWordFromMemory\(id\)/.test(dwBody));
  // helper 本體欄位
  T('S2 helper 存在', hStart >= 0);
  if (hStart >= 0) {
    T('S3 helper 含 reviewLog filter', /state\.reviewLog\s*=/.test(hBody));
    T('S4 helper 含 examHistory filter', /state\.examHistory\s*=/.test(hBody));
    let setDel = 0;
    // helper 用動態 for (const k of [...]) state[k].delete(id)——驗 state[k].delete + 六 Set 名齊
    for (const k of ['buried', 'suspended', 'buriedMc', 'suspendedMc', 'buriedSpell', 'suspendedSpell'])
      if (hBody.includes(`'${k}'`)) setDel++;
    const hasDynamicSetDel = /state\[k\]\.delete\(id\)/.test(hBody);
    T('S5 六 Set 清洗（state[k].delete + 六名齊）', hasDynamicSetDel && setDel === 6, `n=${setDel} dynamic=${hasDynamicSetDel}`);
    const hasBuriedAtClean = /state\[k\]\[id\]/.test(hBody) && /'buriedAt'/.test(hBody) && /'buriedAtMc'/.test(hBody) && /'buriedAtSpell'/.test(hBody);
    T('S6 三 buriedAt 清洗（state[k][id] + 三名齊）', hasBuriedAtClean, String(hasBuriedAtClean));
    T('S7 helper 含 examples.delete(id)', /state\.examples\.delete\(id\)/.test(hBody));
  }

  // ═══ 2. 保留率實測（動保留率核心）═══
  console.log('── 2. 保留率實測（computeRetention）──');
  {
    const buggy = runPurge({ callHelper: false });   // 未修：已刪字仍留 reviewLog
    const fixed = runPurge({ callHelper: true });     // 修後：已刪字剔除
    const rb = computeRetention(buggy.reviewLog, 30);
    const rf = computeRetention(fixed.reviewLog, 30);
    console.log(`  INFO  buggy(含已刪字)=rate ${rb.rate} (${rb.correct}/${rb.total})   fixed(剔除)=rate ${rf.rate} (${rf.correct}/${rf.total})`);
    T('P1 修後保留率剔已刪字 → total=2 correct=2', rf.total === 2 && rf.correct === 2, JSON.stringify(rf));
    T('P2 修後 rate=1.0（全對）', rf.rate === 1);
    T('P3 bug 態(未剔) rate 被拉低 0.75', rb.rate === 0.75, String(rb.rate));
    T('P4 兩態數字不同（harness 能抓「保留率溢算」）', rb.rate !== rf.rate && rb.total !== rf.total, `${rb.total} vs ${rf.total}`);
  }

  // ═══ 3. 語意重放（剔除正確、不誤傷）═══
  console.log('── 3. 語意重放 ──');
  {
    const s = runPurge();
    T('L1 reviewLog 已刪字剔除、存活字保留', s.reviewLog.length === 2 && s.reviewLog.every(l => l.wordId === 'alive'), `${s.reviewLog.length}`);
    T('L2 examHistory 已刪字剔除', s.examHistory.length === 1 && s.examHistory[0].word === 'alive');
    T('L3 六 Set 已刪 id 全剔、存活字維持', [...s.buried].includes('alive') && !s.buried.has('gone') && !s.suspended.has('gone') && !s.buriedSpell.has('gone') && s.suspendedMc.has('alive'), JSON.stringify({buried:[...s.buried], suspendedMc:[...s.suspendedMc]}));
    T('L4 三 buriedAt 已刪 key 刪除', s.buriedAt['gone'] === undefined && s.buriedAtMc['gone'] === undefined && s.buriedAtSpell['gone'] === undefined);
    T('L5 examples 已刪 id delete、存活字維持', !s.examples.has('gone') && s.examples.has('alive'));
  }

  // ═══ 4. 負控制（剝除 helper → 殘留 + 溢算）═══
  console.log('── 4. 負控制（未修態殘留 + 溢算）──');
  {
    const s = runPurge({ callHelper: false });
    const orphanReview = s.reviewLog.filter(l => l.wordId === 'gone').length;
    T(`N1 未修態 reviewLog 已刪字殘留(${orphanReview}筆)→bug 態`, orphanReview === 2, `${orphanReview}`);
    T('N2 未修態 examHistory 殘留', s.examHistory.some(x => x.word === 'gone'));
    T('N3 未修態 Set/buriedAt/examples 殘留', s.buried.has('gone') && s.buriedAt['gone'] !== undefined && s.examples.has('gone'));
  }
} finally {}

console.log(`\n═══ BH-02 verify: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);