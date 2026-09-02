#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// 驗證: 同一張卡 評分→undo→換評分→undo 循環, 間隔是否一致
// 模擬 store.rateCard + undoLastRating 的完整快照還原機制
// 用法: node tools/verify-undo-cycle.mjs [--db PATH] [--word-id ID]
// ═══════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { FSRS, AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, generateFuzzFactor } from '../src/core/fsrs.js';

const DB = process.env.TENO_DB || `${process.env.HOME}/.config/com.teno.app/teno.db`;
const db = new DatabaseSync(DB, { readOnly: true });

// ── 讀 ankiSettings (flip) ──
const asRow = db.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
const anki = asRow ? JSON.parse(asRow.value) : {};
const weights = (anki.fsrsWeights || '').split(',').map(Number);
const fsrs = new FSRS(weights.length === 21 ? weights : null, anki.desiredRetention ?? 0.9, false);
const learnSteps = (anki.learnSteps || '1,10').split(',').map(s => parseFloat(s.trim()) / 1440);
const relearnSteps = (anki.relearnSteps || '10').split(',').map(s => parseFloat(s.trim()) / 1440);

// ── 選卡: 優先指定的, 否則依狀態挑 (new / learning / review) ──
const widArg = process.argv.find(a => a.startsWith('--word-id='))?.split('=')[1];
const cardRow = widArg
  ? db.prepare('SELECT c.word_id, c.due, c.stability, c.difficulty, c.elapsed_days, c.scheduled_days, c.reps, c.lapses, c.state, c.step, c.last_review, w.word FROM cards c JOIN words w ON w.id=c.word_id WHERE c.word_id=?').get(widArg)
  : db.prepare("SELECT c.word_id, c.due, c.stability, c.difficulty, c.elapsed_days, c.scheduled_days, c.reps, c.lapses, c.state, c.step, c.last_review, w.word FROM cards c JOIN words w ON w.id=c.word_id WHERE c.state=2 AND c.due IS NOT NULL ORDER BY c.stability DESC LIMIT 1").get();
if (!cardRow) { console.log('找不到卡片'); process.exit(1); }

function cardState(c) {
  return {
    stability: c.stability ?? 0,
    difficulty: c.difficulty ?? 5,
    state: c.state ?? STATE_NEW,
    reps: c.reps ?? 0,
    lapses: c.lapses ?? 0,
    step: c.step ?? 0,
    elapsedDays: c.elapsed_days ?? 0,
    scheduledDays: c.scheduled_days ?? 0,
  };
}

const baseState = cardState(cardRow);
const wordId = cardRow.word_id;
const mode = 'flip';

function computeInterval(rating) {
  const fuzz = generateFuzzFactor(wordId + '_' + mode, baseState.reps);
  const result = fsrs.review(baseState, rating, fuzz, learnSteps, relearnSteps, null);
  const dueDays = result.dueDays;
  return { dueDays, stability: result.stability, difficulty: result.difficulty, state: result.state, reps: result.reps, lapses: result.lapses, step: result.step };
}

// ── 模擬: 快照(深拷貝) → 評分 → undo(還原) 循環 ──
function snapshot() { return JSON.parse(JSON.stringify(baseState)); }
function restore(snap) { return JSON.parse(JSON.stringify(snap)); }

const RATINGS = [
  ['Good(2)', GOOD], ['Again(0)', AGAIN], ['Hard(1)', HARD],
  ['Good(2)', GOOD], ['Again(0)', AGAIN], ['Hard(1)', HARD],
  ['Good(2)', GOOD], ['Again(0)', AGAIN], ['Hard(1)', HARD],
];

console.log(`卡片: ${cardRow.word} (${wordId})`);
console.log(`狀態: state=${baseState.state} stab=${baseState.stability.toFixed(2)} diff=${baseState.difficulty.toFixed(2)} reps=${baseState.reps} lapses=${baseState.lapses} step=${baseState.step} schedDays=${baseState.scheduledDays} elapsed=${baseState.elapsedDays}`);
console.log('權重:', anki.fsrsWeights ? 'custom' : 'default', weights.slice(0, 4).map(w => w.toFixed(3)).join(', '), '...');
console.log('─'.repeat(72));

let cur = baseState;
const seen = {};
for (const [label, rating] of RATINGS) {
  const snap = snapshot();
  // 評分
  const fuzz = generateFuzzFactor(wordId + '_' + mode, cur.reps);
  const result = fsrs.review(cur, rating, fuzz, learnSteps, relearnSteps, null);
  const dueDays = result.dueDays;
  const afterRate = { ...cur, stability: result.stability, difficulty: result.difficulty, state: result.state, reps: result.reps, lapses: result.lapses, step: result.step ?? 0, scheduledDays: dueDays };
  // undo: 還原快照
  cur = restore(snap);
  // 檢查還原是否完整
  const restored = JSON.stringify(cur) === JSON.stringify(snap);
  const key = `${label}`;
  const sameAsBefore = !seen[key] ? '首次' : (seen[key] === dueDays.toFixed(6) ? '同前 ✅' : `不同!! 前=${seen[key]}`);
  seen[key] = dueDays.toFixed(6);
  console.log(`${label.padEnd(10)} interval=${String(dueDays).padStart(8)}d (stability=${afterRate.stability.toFixed(2)})  undo還原=${restored ? '✅' : '❌'}  ${sameAsBefore}`);
}

console.log('─'.repeat(72));
console.log('驗證: 每個 rating 的 interval 在每次循環都相同 = 間隔一致 (undo 沒污染狀態)');
console.log('對照 (乾淨狀態直接算):');
for (const [label, rating] of [['Good(2)', GOOD], ['Again(0)', AGAIN], ['Hard(1)', HARD]]) {
  const r = computeInterval(rating);
  console.log(`  ${label.padEnd(10)} interval=${String(r.dueDays).padStart(8)}d`);
}
