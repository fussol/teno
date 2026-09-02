// Anki-style learning session engine.
// Independent from the existing study system.
// Manages card queue, state transitions, and rating flow.

import { AGAIN, HARD, GOOD, EASY, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../core/fsrs.js';
import { getToday, toLocalDateStr } from '../core/scheduler.js';

const RATING_LABEL = ['Again', 'Hard', 'Good', 'Easy'];
const RATING_COLOR = ['var(--red)', 'var(--orange)', 'var(--green)', 'var(--cyan)'];

export class Session {
  constructor({ words, cards, reviewLog, buried, suspended, scheduler, dayCutoff, timezoneOffset }) {
    this.words = words;
    this.cards = cards;
    this.reviewLog = reviewLog;
    this.buried = buried;
    this.suspended = suspended;
    this.scheduler = scheduler;
    this.dayCutoff = dayCutoff ?? 0;
    this.timezoneOffset = timezoneOffset;
    this.reset();
  }

  reset() {
    this.queue = [];       // [{word, card, type}]
    this.idx = 0;
    this.current = null;
    this.results = [];
    this.startedAt = 0;
    this.running = false;
  }

  // Build queue: learning → review → new (Anki order)
  buildQueue(filter) {
    const learn = [], review = [], fresh = [];
    const today = getToday(this.dayCutoff, this.timezoneOffset);

    for (const w of this.words) {
      if (this.buried.has(w.id) || this.suspended.has(w.id)) continue;
      if (filter && w.deck !== filter) continue;
      const card = this.cards.get(w.id);
      if (!card) { fresh.push({ word: w, card: null, type: 'new' }); continue; }
      if (toLocalDateStr(new Date(card.due), this.timezoneOffset, this.dayCutoff) > today) continue;
      if (card.state === STATE_LEARNING) learn.push({ word: w, card, type: 'learning' });
      else if (card.state === STATE_RELEARNING) learn.push({ word: w, card, type: 'relearning' });
      else if (card.state === STATE_REVIEW) review.push({ word: w, card, type: 'review' });
      else fresh.push({ word: w, card: null, type: 'new' });
    }

    learn.sort((a, b) => (a.card.lastReview || '').localeCompare(b.card.lastReview || ''));
    review.sort((a, b) => (a.card.due || '').localeCompare(b.card.due || ''));

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

  previewIntervals(wordId) {
    try { return this.scheduler.previewIntervals(wordId); } catch { return {}; }
  }

  formatInterval(d) {
    if (d == null) return '';
    if (d < 1 / 1440) return '<1m';
    if (d < 1) return Math.round(d * 1440) + 'm';
    if (d < 30) return Math.round(d) + 'd';
    if (d < 365) return Math.round(d / 30) + 'mo';
    return (d / 365).toFixed(1) + 'y';
  }
}
