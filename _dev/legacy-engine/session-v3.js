// Study V3 — FSRS-powered learning session engine.
// Queue: learning → review (sorted by retrievability, lowest first) → new.
import { FSRS, AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../core/fsrs.js';

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysElapsed(lastReviewDate) {
  if (!lastReviewDate) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(lastReviewDate).getTime()) / 86400000));
}

function retrievability(stability, elapsed) {
  return (1 + elapsed / (9 * Math.max(stability, 0.001))) ** -0.5;
}

export class Session {
  constructor({ words, cards, buried, suspended, fsrs }) {
    this.words = words;
    this.cards = cards;
    this.buried = buried;
    this.suspended = suspended;
    this.fsrs = fsrs || new FSRS();
    this.reset();
  }

  reset() {
    this.queue = [];
    this.idx = 0;
    this.current = null;
    this.results = [];
    this.startedAt = 0;
    this.running = false;
  }

  buildQueue(filter) {
    const learn = [], review = [], fresh = [];
    const today = getToday();

    for (const w of this.words) {
      if (this.buried.has(w.id) || this.suspended.has(w.id)) continue;
      if (filter && w.deck !== filter) continue;
      const card = this.cards.get(w.id);
      if (!card) { fresh.push({ word: w, card: null, type: 'new' }); continue; }
      if (toLocalDateStr(new Date(card.due)) > today) continue;
      if (card.state === STATE_LEARNING) learn.push({ word: w, card, type: 'learning' });
      else if (card.state === STATE_RELEARNING) learn.push({ word: w, card, type: 'relearning' });
      else if (card.state === STATE_REVIEW) review.push({ word: w, card, type: 'review' });
      else if (card.state === STATE_NEW) fresh.push({ word: w, card, type: 'new' });
      else fresh.push({ word: w, card: null, type: 'new' });
    }

    learn.sort((a, b) => (a.card.lastReview || '').localeCompare(b.card.lastReview || ''));

    review.sort((a, b) => {
      const ra = retrievability(a.card.stability, daysElapsed(a.card.lastReview));
      const rb = retrievability(b.card.stability, daysElapsed(b.card.lastReview));
      return ra - rb;
    });

    this.queue = [...learn, ...review, ...fresh];
    this.idx = 0;
  }

  start(filter) {
    this.reset();
    this.buildQueue(filter);
    this.running = true;
    this.startedAt = Date.now();
    return this.next();
  }

  next() {
    if (this.idx >= this.queue.length) {
      this.current = null;
      this.running = false;
      return null;
    }
    this.current = this.queue[this.idx];
    this.current.shownAt = Date.now();
    return this.current;
  }

  rate(rating) {
    if (!this.current) return null;
    const { word, card, type } = this.current;
    const timeMs = Date.now() - (this.current.shownAt || this.startedAt);
    const result = { word: word.word, wordId: word.id, type, rating, timeMs };
    this.results.push(result);
    this.idx++;
    return result;
  }

  get progress() {
    return { done: this.results.length, total: this.queue.length };
  }

  get isDone() {
    return !this.running || this.idx >= this.queue.length;
  }

  computeIntervals(wordId) {
    const card = this.cards.get(wordId);
    const elapsed = card ? daysElapsed(card.lastReview) : 0;
    const memoryState = card ? { stability: card.stability ?? 0, difficulty: card.difficulty ?? 5 } : null;
    const states = this.fsrs.nextStates(memoryState, elapsed);
    return {
      [AGAIN]: this.formatInterval(states[AGAIN].interval),
      [HARD]: this.formatInterval(states[HARD].interval),
      [GOOD]: this.formatInterval(states[GOOD].interval),
      [EASY]: this.formatInterval(states[EASY].interval),
    };
  }

  formatInterval(days) {
    if (days == null || days < 0.001) return '';
    if (days < 1) return Math.round(days * 1440) + 'm';
    if (days < 30) return Math.round(days) + 'd';
    if (days < 365) return (days / 30).toFixed(1) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }
}
