#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// 驗證: 同一張卡 評分→undo 循環時, 「中間出現的下一張卡」是否相同
// 複製 session-utils.js rateCard/undoRating 的佇列邏輯 (不含 DOM)
// ═══════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { Session } from '../src/engine/session-v4.js';
import { FSRS, generateFuzzFactor, STATE_REVIEW, STATE_LEARNING, STATE_RELEARNING } from '../src/core/fsrs.js';

const DB = process.env.TENO_DB || `${process.env.HOME}/.config/com.teno.app/teno.db`;
const db = new DatabaseSync(DB, { readOnly: true });

// ── 讀取資料 ──
const words = db.prepare('SELECT id, word, definition, part_of_speech, deck, tags, synonym, antonym, derivative, related, forms, examples FROM words').all();
const cardsRaw = db.prepare('SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards').all();
const cards = new Map(cardsRaw.map(r => [r.word_id, {
  due: r.due, stability: r.stability, difficulty: r.difficulty,
  elapsedDays: r.elapsed_days, scheduledDays: r.scheduled_days,
  reps: r.reps, lapses: r.lapses, state: r.state, step: r.step ?? 0,
  lastReview: r.last_review, buried: !!r.buried, suspended: !!r.suspended,
  interval: r.scheduled_days || 0,
  mcData: r.mc_data ? JSON.parse(r.mc_data) : null,
  spellData: r.spell_data ? JSON.parse(r.spell_data) : null,
}]));
const asRow = db.prepare(`SELECT value FROM settings WHERE key='ankiSettings'`).get();
const anki = asRow ? JSON.parse(asRow.value) : {};
const weights = (anki.fsrsWeights || '').split(',').map(Number);
const fsrs = new FSRS(weights.length === 21 ? weights : null, anki.desiredRetention ?? 0.9, false);
const learnSteps = (anki.learnSteps || '1,10').split(',').map(s => parseFloat(s.trim()) / 1440);
const relearnSteps = (anki.relearnSteps || '10').split(',').map(s => parseFloat(s.trim()) / 1440);

// ── 建立 session (卡 A 所在的佇列) ──
// 為了可重現, 手動挑 A 跟佇列裡其他卡, 直接組 session
const aRow = db.prepare("SELECT c.word_id, c.due, c.stability, c.difficulty, c.elapsed_days, c.scheduled_days, c.reps, c.lapses, c.state, c.step, c.last_review, w.word FROM cards c JOIN words w ON w.id=c.word_id WHERE c.state=2 AND c.due IS NOT NULL AND c.due <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY c.stability DESC LIMIT 1").get();   // E2: ISO 對 ISO 字串比較（舊 datetime('now') 對 ISO due 恆「未到期」）
if (!aRow) { console.log('沒有今天到期的 review 卡'); process.exit(1); }
function toCamel(r) {
  return {
    due: r.due, stability: r.stability, difficulty: r.difficulty,
    elapsedDays: r.elapsed_days, scheduledDays: r.scheduled_days,
    reps: r.reps, lapses: r.lapses, state: r.state, step: r.step ?? 0,
    lastReview: r.last_review, buried: !!r.buried, suspended: !!r.suspended,
    interval: r.scheduled_days || 0,
  };
}
const wid = aRow.word_id;
const mode = 'flip';
const s = new Session({
  words, cards, buried: new Set(), suspended: new Set(), fsrs,
  dayCutoff: anki.dayCutoff ?? 0, timezoneOffset: anki.timezoneOffset,
  newPerDay: anki.cardsPerDay ?? 80, ratedNewToday: 0,
  learnSteps: anki.learnSteps || '1,10', relearnSteps: anki.relearnSteps || '10',
  maxReviewsPerDay: anki.maxReviewsPerDay ?? 0, reviewMix: anki.reviewMix ?? 2,
  mode, learnAheadLimit: 20,
});

// 把 A 設為 current, 其餘卡進 mainQueue (依 due 排序, 同 buildQueue)
s.start(null);
// 找到 A 在佇列的位置, 把它拉出來當 current
const idx = s.mainQueue.findIndex(x => x.word.id === wid);
if (idx < 0) { console.log('A 不在佇列 (可能已到期或被 newSlots 截斷)'); process.exit(1); }
s.current = s.mainQueue.splice(idx, 1)[0];
s.current.shownAt = Date.now();

let _undoSnapshot = null;

function rate(rating) {
  const card = s.cards.get(wid);
  const now = new Date().toISOString();
  const lastTs = card?.lastReview ? new Date(card.lastReview).getTime() : null;
  const elapsed = lastTs ? Math.max(0, Math.round((Date.now() - lastTs) / 86400000)) : 0;
  const currentState = {
    stability: card?.stability ?? 0, difficulty: card?.difficulty ?? 5,
    state: card?.state ?? 0, reps: card?.reps ?? 0, lapses: card?.lapses ?? 0,
    step: card?.step ?? 0, elapsedDays: elapsed, scheduledDays: card?.scheduledDays ?? 0,
  };
  const fuzz = generateFuzzFactor(wid + '_' + mode, currentState.reps);
  const result = fsrs.review(currentState, rating, fuzz, learnSteps, relearnSteps, null);
  const newCard = {
    due: new Date(Date.now() + Math.max(60000, Math.round(result.dueDays * 86400000))).toISOString(),
    stability: result.stability, difficulty: result.difficulty, elapsedDays: elapsed,
    scheduledDays: result.state === STATE_REVIEW ? Math.round(result.dueDays) : result.dueDays,
    reps: result.reps, lapses: result.lapses, state: result.state, step: result.step ?? 0,
    lastReview: now, buried: false, suspended: false,
    interval: result.state === STATE_REVIEW ? Math.round(result.dueDays) : result.dueDays,
  };
  _undoSnapshot = {
    currentCard: s.current ? { ...s.current, card: s.current.card ? { ...s.current.card } : null } : null,
    rating, wordId: wid,
  };
  s.cards.set(wid, newCard);
  s.current.card = newCard;
  s.rate(rating);
  s.requeueIntraday(wid, newCard);
  s.next();
  return { newCard, nextWord: s.current?.word?.word ?? '(無)', nextId: s.current?.word?.id ?? null };
}

function undo() {
  if (!_undoSnapshot) return;
  const { currentCard, wordId } = _undoSnapshot;
  // 還原卡 (模擬 store.undoLastRating: 回到評分前 = 從 DB 重載)
  const orig = db.prepare('SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended FROM cards WHERE word_id=?').get(wordId);
  if (orig) s.cards.set(wordId, toCamel(orig)); else s.cards.delete(wordId);
  s.results.pop();
  s.removeIntraday(wordId);
  if (s.current && s.current !== currentCard) {
    const cur = s.current;
    if (cur.type === 'learning' || cur.type === 'relearning') s.intradayLearning.unshift(cur);
    else s.mainQueue.unshift(cur);
  }
  s.current = currentCard;
  s.running = true;
  if (s.current) s.current.card = s.cards.get(wordId) || s.current.card;
  _undoSnapshot = null;
}

console.log(`卡 A: ${aRow.word} (${wid}) state=${aRow.state} stab=${aRow.stability.toFixed(1)}`);
console.log(`佇列: main=${s.mainQueue.length} 張, intraday=${s.intradayLearning.length} 張`);
console.log('─'.repeat(78));
const seen = {};
for (const [label, rating] of [['Good', 2], ['Again', 0], ['Hard', 1], ['Good', 2], ['Again', 0], ['Hard', 1], ['Good', 2], ['Again', 0], ['Hard', 1]]) {
  const { newCard, nextWord, nextId } = rate(rating);
  const key = label;
  const tag = !seen[key] ? '首次' : (seen[key] === nextId ? '同前 ✅' : `不同!! 前=${seen[key]}`);
  seen[key] = nextId;
  console.log(`A 按 ${label.padEnd(6)} → A: state=${newCard.state} ivl=${String(newCard.scheduledDays).padStart(8)} | 下一張: ${String(nextWord).padEnd(14)} ${tag}`);
  undo();
  console.log(`        ↳ undo → 回到 A (current=${s.current?.word?.word}) queue: main=${s.mainQueue.length} intraday=${s.intradayLearning.length}`);
}
console.log('─'.repeat(78));
console.log('結論: 若「下一張」每輪相同 → undo 機制把 B 正確放回佇列, 與權重無關');
