import { FSRS, AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, generateFuzzFactor, parseStepsStr } from '../core/fsrs.js';
import { getToday, toLocalDateStr, cmpByRepsThenDue } from '../core/scheduler.js';
import { clampLearnAhead } from '../lib/store.js';

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

export class Session {
  constructor({ words, cards, buried, suspended, fsrs, dayCutoff, newPerDay, ratedNewToday, learnSteps, relearnSteps, maxReviewsPerDay, reviewMix, timezoneOffset, mode, learnAheadLimit }) {
    this.words = words;
    this.cards = cards;
    this.buried = buried;
    this.suspended = suspended;
    this.fsrs = fsrs || new FSRS();
    this.dayCutoff = dayCutoff ?? 0;
    this.timezoneOffset = timezoneOffset;
    this.newPerDay = newPerDay ?? 20;
    this.ratedNewToday = ratedNewToday ?? 0;
    this.maxReviewsPerDay = maxReviewsPerDay ?? 0;
    this.reviewMix = reviewMix ?? 2;
    this.mode = mode || 'flip';
    // NOTE: new 卡 shuffle 的 RNG 不在這裡建立 — buildQueue 每次用
    // (mode + 當天日期) 重新 seed（A7：Anki 每天 salt re-hash 每天不同；
    // 同天內重進 session 順序穩定）。mulberry32 有狀態，若只在 constructor
    // seed 一次，同天第二次 buildQueue 會沿用已推進的 RNG → 順序亂跳。
    this._learnSteps = learnSteps;
    this._relearnSteps = relearnSteps;
    this.learnAheadSecs = clampLearnAhead(learnAheadLimit) * 60;
    this.reset();
  }

  reset() {
    this.intradayLearning = [];
    this.mainQueue = [];
    this.current = null;
    this.results = [];
    this.startedAt = 0;
    this.running = false;
  }

  buildQueue(filter) {
    const learnQueue = [];
    const reviewQueue = [];
    const today = toLocalDateStr(new Date(), this.timezoneOffset, this.dayCutoff);
    let newSlots = Math.max(0, this.newPerDay - this.ratedNewToday);
    const newCards = [];

    for (const w of this.words) {
      if (this.buried.has(w.id) || this.suspended.has(w.id)) continue;
      if (filter && w.deck !== filter) continue;
      const card = this.cards.get(w.id);
      if (!card) {
        newCards.push({ word: w, card: null, type: 'new' });
        continue;
      }
      if (card.state === STATE_NEW) {
        newCards.push({ word: w, card, type: 'new' });
        continue;
      }
      if (!card.due) continue;
      const dueLocal = toLocalDateStr(new Date(card.due), this.timezoneOffset, this.dayCutoff);
      if (dueLocal === 'Invalid Date' || dueLocal > today) continue;
      if (card.state === STATE_LEARNING || card.state === STATE_RELEARNING) {
        learnQueue.push({ word: w, card, type: card.state === STATE_RELEARNING ? 'relearning' : 'learning' });
      } else {
        reviewQueue.push({ word: w, card, type: 'review' });
      }
    }

    // Anki sort_learning = cmp_by_reps_then_due（與 getDueCards 同一 comparator）
    learnQueue.sort((a, b) => cmpByRepsThenDue(a.card, b.card));
    reviewQueue.sort((a, b) => new Date(a.card.due).getTime() - new Date(b.card.due).getTime());

    // A7: new 卡每日順序重洗 — Anki 官方每天用隨機 salt re-hash new 卡排序，
    // 所以每天遇到的 new 卡順序都不同；同一天內（重進 session / 重新 build）
    // 順序必須穩定。seed = mode + 當天日期字串（:53 的 today），每次 build
    // 重新建 RNG：同一天 → 相同 seed → 完全相同順序；跨天（含 app 開著跨
    // 午夜）→ 新日期字串 → 新順序。reviewMix / learning 排序不受影響。
    const rng = mulberry32(hashCode(this.mode + '_' + today));
    for (let i = newCards.length - 1; i > 0; i--) {
      const j = rng() * (i + 1) | 0;
      [newCards[i], newCards[j]] = [newCards[j], newCards[i]];
    }
    if (newCards.length > newSlots) newCards.length = newSlots;
    if (this.maxReviewsPerDay > 0 && reviewQueue.length > this.maxReviewsPerDay) {
      reviewQueue.length = this.maxReviewsPerDay;
    }

    let mainQueue;
    if (this.reviewMix === 1) {
      mainQueue = [...newCards, ...reviewQueue];
    } else if (this.reviewMix === 2) {
      mainQueue = this._intersperse(reviewQueue, newCards);
    } else {
      mainQueue = [...reviewQueue, ...newCards];
    }

    this.intradayLearning = learnQueue.map(item => ({
      ...item,
      due: new Date(item.card.due).getTime(),
      reps: item.card.reps ?? 0,
    }));
    // Anki sort_learning: cmp_by_reps_then_due（與 getDueCards 同一 comparator，
    // 否則 :79 的排序會被這裡覆蓋，預覽與實際學習順序仍會不一致）
    this.intradayLearning.sort((a, b) => cmpByRepsThenDue(a.card, b.card));

    console.log('[build] words=', this.words?.length, 'cards=', this.cards?.size, 'new=', newCards.length, 'learn=', learnQueue.length, 'review=', reviewQueue.length, 'today=', today, 'filter=', filter, 'newSlots=', newSlots, 'learnAheadSecs=', this.learnAheadSecs);

    this.mainQueue = mainQueue;
  }

  _intersperse(reviews, news) {
    if (news.length === 0) return reviews;
    if (reviews.length === 0) return news;
    const total = news.length + reviews.length;
    const out = [];
    let ri = 0, ni = 0;
    while (ri < reviews.length && ni < news.length) {
      const targetNi = Math.round((ni + ri + 1) * news.length / total);
      if (targetNi > ni) {
        out.push(news[ni++]);
      } else {
        out.push(reviews[ri++]);
      }
    }
    while (ni < news.length) out.push(news[ni++]);
    while (ri < reviews.length) out.push(reviews[ri++]);
    return out;
  }

  start(filter) {
    this.reset();
    this.buildQueue(filter);
    this.running = true;
    this.startedAt = Date.now();
    return this._next();
  }

  _next() {
    const now = Date.now();

    // 1. Intraday cards due now (strict — no learnAhead)
    //    Anki: intraday_now_iter 掃整佇列 (due <= cutoff), 不只 [0]
    if (this.intradayLearning.length > 0) {
      const dueIdx = this.intradayLearning.findIndex(c => c.due <= now);
      if (dueIdx >= 0) {
        this.current = this.intradayLearning.splice(dueIdx, 1)[0];
        this.current.shownAt = now;
        console.log('[next] step1 intraday-now:', this.current.word?.id, 'type=', this.current.type);
        return this.current;
      }
    }

    // 2. Main queue (review + new) — Anki order
    if (this.mainQueue.length > 0) {
      this.current = this.mainQueue.shift();
      this.current.shownAt = now;
      console.log('[next] step2 main:', this.current.word?.id, 'type=', this.current.type);
      return this.current;
    }

    // 3. Intraday ahead (within learnAhead) — Anki: intraday_ahead_iter 掃整佇列
    //    (due > cutoff && due <= ahead_cutoff), 依序處理全部, 不需 mainQueue 空。
    if (this.intradayLearning.length > 0) {
      const aheadIdx = this.intradayLearning.findIndex(c => c.due <= now + this.learnAheadSecs * 1000);
      if (aheadIdx >= 0) {
        const picked = this.intradayLearning[aheadIdx];
        this.current = this.intradayLearning.splice(aheadIdx, 1)[0];
        this.current.shownAt = now;
        console.log('[next] step3 intraday-ahead:', this.current.word?.id, 'type=', this.current.type, '| due in', Math.round((picked.due-now)/1000), 's, ahead', this.learnAheadSecs, 's');
        return this.current;
      }
      console.log('[next] step3 SKIP: no card within learnAhead', this.learnAheadSecs, 's');
    }

    // Rebuild queue from store before declaring done — a card that left the queue
    // without being requeued (rate→requeue gap) must not be lost.
    if (this._resyncIntraday() > 0) {
      return this._next();
    }

    this.current = null;
    if (this.intradayLearning.length > 0) {
      console.log('[next] null: main empty, intraday=', this.intradayLearning.length, 'next due in', Math.round((this.intradayLearning[0].due - Date.now())/1000), 's, learnAhead=', this.learnAheadSecs, 's');
      const pending = this.intradayLearning.filter(c => c.due > Date.now() + this.learnAheadSecs * 1000);
      console.log('[next] pending intraday detail:', pending.map(c => `${c.word?.id}(${c.type},due+${Math.round((c.due-Date.now())/1000)}s)`).join(', '));
      console.log('[next] intraday all:', this.intradayLearning.map(c => `${c.word?.id}(${c.type},due+${Math.round((c.due-Date.now())/1000)}s)`).join(', '));
    } else {
      console.log('[next] null: all queues empty (DONE)');
    }
    this.running = false;
    return null;
  }

  next() {
    if (!this.running) return null;
    return this._next();
  }

  rate(rating) {
    if (!this.current) return null;
    const { word, card, type } = this.current;
    const timeMs = Date.now() - (this.current.shownAt || this.startedAt);
    const result = { word: word.word, wordId: word.id, type, rating, timeMs };
    this.results.push(result);
    return result;
  }

  get isDone() {
    if (!this.running) return true;
    if (this.mainQueue.length > 0) return false;
    if (this._resyncIntraday() > 0) return false;
    const now = Date.now();
    if (this.intradayLearning.length > 0) {
      const ahead = this.intradayLearning.some(c => c.due <= now + this.learnAheadSecs * 1000);
      if (ahead) return false;
    }
    return this.intradayLearning.length === 0;
  }

  get pendingIntradayInfo() {
    if (this.intradayLearning.length === 0) return null;
    const now = Date.now();
    const pending = this.intradayLearning.filter(c => c.due > now + this.learnAheadSecs * 1000);
    if (pending.length === 0) return null;
    const secsUntilNext = Math.max(0, Math.round((pending[0].due - now) / 1000));
    return { count: pending.length, nextDueSecs: secsUntilNext };
  }

  /** Learning/relearning cards still due today (from cards map), even if beyond learn-ahead. */
  pendingLearningToday() {
    const now = Date.now();
    const today = toLocalDateStr(new Date(), this.timezoneOffset, this.dayCutoff);
    const list = [];
    for (const [, card] of this.cards) {
      if (!card?.due) continue;
      if (card.state !== STATE_LEARNING && card.state !== STATE_RELEARNING) continue;
      const due = new Date(card.due).getTime();
      if (due <= now) continue;
      if (toLocalDateStr(new Date(due), this.timezoneOffset, this.dayCutoff) !== today) continue;
      list.push({ due });
    }
    list.sort((a, b) => a.due - b.due);
    if (list.length === 0) return null;
    return { count: list.length, nextDueSecs: Math.max(0, Math.round((list[0].due - now) / 1000)) };
  }  // Pull any learning/relearning card that is due today but missing from the queue
  // back into intradayLearning (guards against a requeue gap ending the session early).
  _resyncIntraday() {
    const today = toLocalDateStr(new Date(), this.timezoneOffset, this.dayCutoff);
    const now = Date.now();
    const inQueue = new Set(this.intradayLearning.map(c => c.word?.id));
    let added = 0;
    for (const w of this.words) {
      if (this.buried.has(w.id) || this.suspended.has(w.id)) continue;
      const card = this.cards.get(w.id);
      if (!card) continue;
      if (card.state !== STATE_LEARNING && card.state !== STATE_RELEARNING) continue;
      if (inQueue.has(w.id)) continue;
      if (!card.due) continue;
      const dueMs = new Date(card.due).getTime();
      // 只撈「已到期」的卡 (Anki: intraday_now_iter 用 due <= cutoff), 避免
      // 把未來幾分鐘到期、正待在佇列的卡誤判為遺漏而重複 requeue。
      if (isNaN(dueMs) || dueMs > now) continue;
      if (toLocalDateStr(new Date(card.due), this.timezoneOffset, this.dayCutoff) !== today) continue;
      this.requeueIntraday(w.id, card);
      inQueue.add(w.id);
      added++;
    }
    if (added > 0) console.log('[resync] added', added, 'stray learning cards');
    return added;
  }

  requeueIntraday(wordId, updatedCard) {
    if (!updatedCard) return;
    console.log('[requeue] word=', wordId, 'state=', updatedCard.state, 'due=', updatedCard.due, 'interval=', updatedCard.interval, 'step=', updatedCard.step);
    if (updatedCard.state !== STATE_LEARNING && updatedCard.state !== STATE_RELEARNING) return;

    let due = new Date(updatedCard.due).getTime();
    // ponytail: toLocalDateStr check instead of _getNextDayAt() — reuses existing code
    const today = toLocalDateStr(new Date(), this.timezoneOffset, this.dayCutoff);
    if (toLocalDateStr(new Date(due), this.timezoneOffset, this.dayCutoff) !== today) return;

    // ponytail: if card would be shown again immediately, push it behind the next card
    // (Anki's learning_collapsed pattern)
    if (this.mainQueue.length === 0 && this.intradayLearning.length > 0) {
      const cutoff = Date.now() + this.learnAheadSecs * 1000;
      const nextDue = this.intradayLearning[0].due;
      if (due <= cutoff && due <= nextDue && nextDue + 1000 < cutoff) {
        due = nextDue + 1000;
      }
    }

    const word = this.words.find(w => w.id === wordId);
    if (!word) return;

    // Anki sort_learning: cmp_by_reps_then_due — (reps==0, due)
    // 已學過的卡 (reps>0) 優先, due 相同時順序穩定, 避免卡在佇列尾輪不到。
    this.intradayLearning.push({ word, card: updatedCard, due, reps: updatedCard.reps ?? 0, type: updatedCard.state === STATE_RELEARNING ? 'relearning' : 'learning' });
    this.intradayLearning.sort((a, b) => (a.reps === 0 ? 1 : 0) - (b.reps === 0 ? 1 : 0) || a.due - b.due);
  }

  removeIntraday(wordId) {
    for (let i = 0; i < this.intradayLearning.length; i++) {
      if (this.intradayLearning[i].word?.id === wordId) {
        this.intradayLearning.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  computeIntervals(wordId) {
    const card = this.cards.get(wordId);
    const lastTs = card?.lastReview ? new Date(card.lastReview).getTime() : null;
    const todayStr = toLocalDateStr(new Date(), this.timezoneOffset, this.dayCutoff);
    const lastDay = lastTs != null ? toLocalDateStr(new Date(lastTs), this.timezoneOffset, this.dayCutoff) : null;
    const elapsed = lastDay != null
      ? Math.round((new Date(todayStr) - new Date(lastDay)) / 86400000)
      : 0;
    const currentState = {
      stability: card?.stability ?? 0,
      difficulty: card?.difficulty ?? 5,
      state: card?.state ?? STATE_NEW,
      reps: card?.reps ?? 0,
      lapses: card?.lapses ?? 0,
      step: card?.step ?? 0,
      elapsedDays: elapsed,
      scheduledDays: card?.scheduledDays ?? 0,
    };
    const fuzzFactor = generateFuzzFactor(wordId + '_' + this.mode, currentState.reps);
    const learnSteps = parseStepsStr(this._learnSteps, '1,10');
    const relearnSteps = parseStepsStr(this._relearnSteps, '10');
    const futureCounts = (currentState.state === STATE_REVIEW || currentState.state === STATE_RELEARNING)
      ? this._computeFutureCounts() : null;
    const out = {};
    for (const r of [AGAIN, HARD, GOOD, EASY]) {
      const result = this.fsrs.review(currentState, r, fuzzFactor, learnSteps, relearnSteps, futureCounts);
      out[r] = this.formatInterval(result.dueDays);
    }
    return out;
  }

  _computeFutureCounts() {
    const countMap = {};
    for (const w of this.words) {
      if (this.buried.has(w.id) || this.suspended.has(w.id)) continue;
      const c = this.cards.get(w.id);
      if (!c?.due) continue;
      if (c.state !== STATE_REVIEW && c.state !== STATE_RELEARNING) continue;
      const dueDay = toLocalDateStr(new Date(c.due), this.timezoneOffset, this.dayCutoff);
      countMap[dueDay] = (countMap[dueDay] || 0) + 1;
    }
    const today = toLocalDateStr(new Date(), this.timezoneOffset, this.dayCutoff);
    const results = [];
    for (let i = 0; i < 90; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      results.push(countMap[toLocalDateStr(d, this.timezoneOffset, this.dayCutoff)] || 0);
    }
    return results;
  }

  formatInterval(days) {
    if (days == null || days <= 0) return '';
    if (days < 1) return Math.round(days * 1440) + 'm';
    if (days < 30) return Math.round(days) + 'd';
    if (days < 365) return (days / 30).toFixed(1) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }
}
