import { STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../core/fsrs.js';
import { getToday } from '../core/scheduler.js';

export const GUIDES = [
  {
    id: 'standard',
    label: '標準學習',
    icon: 'book',
    desc: 'Anki 標準：學習中 → 複習 → 新卡（遵守每日上限）',
    longDesc: '依 Anki 預設順序出牌：先處理學習中與重新學習的卡片，再排今日到期複習卡，最後發新卡直到每日上限。',
  },
  {
    id: 'pure-review',
    label: '純複習',
    icon: 'refresh',
    desc: '只複習到期卡片，不發新卡',
    longDesc: '今日新卡上限設為 0，只顯示學習中、重新學習、與到期複習卡。適合考前衝刺或只想維持進度時使用。',
  },
  {
    id: 'new-sprint',
    label: '新卡衝刺',
    icon: 'galleryHorizontalEnd',
    desc: '只學新卡，衝刺每日上限',
    longDesc: '只顯示從未學過的新卡片，直到達到每日新卡上限。適合想快速累積字量時使用。',
  },
  {
    id: 'weak-spot',
    label: '弱點攻克',
    icon: 'target',
    desc: '優先處理容易忘記的卡片',
    longDesc: '依 lapse 次數排序，先出最容易忘記的卡片（多次 Again 的卡優先）。新卡暫不發。',
  },
  {
    id: 'custom',
    label: '自訂篩選',
    icon: 'filter',
    desc: '最短間隔優先衝刺',
    longDesc: '所有到期卡片依間隔長短排序（間隔最短的先出）。適合想盡快回收短間隔卡片時使用。',
  },
];

export function buildQueue(guideId, words, cards, buried, suspended, filter, newPerDay, ratedNewToday, dayCutoff = 0, dailyGoal = 0, timezoneOffset) {
  const today = getToday(dayCutoff, timezoneOffset);
  const learn = [];
  const review = [];
  const fresh = [];

  for (const w of words) {
    if (buried.has(w.id) || suspended.has(w.id)) continue;
    if (filter && w.deck !== filter) continue;
    const card = cards.get(w.id);
    if (!card) { fresh.push(w); continue; }
    if (String(card.due).slice(0, 10) > today) continue;
    if (card.state === STATE_LEARNING) learn.push({ word: w, card, type: 'learning' });
    else if (card.state === STATE_RELEARNING) learn.push({ word: w, card, type: 'relearning' });
    else if (card.state === STATE_REVIEW) review.push({ word: w, card, type: 'review' });
    else fresh.push(w);
  }

  learn.sort((a, b) => (a.card.lastReview || '').localeCompare(b.card.lastReview || ''));
  review.sort((a, b) => (a.card.due || '').localeCompare(b.card.due || ''));

  const usedNewToday = Math.max(0, ratedNewToday);
  const newAllowed = Math.max(0, newPerDay - usedNewToday);

  let queue = [];

  switch (guideId) {
    case 'pure-review': {
      queue = [...learn, ...review.map(e => ({ ...e, type: 'review' }))];
      break;
    }
    case 'new-sprint': {
      const slice = fresh.slice(0, newAllowed || Infinity);
      queue = slice.map(w => ({ word: w, card: null, type: 'new' }));
      break;
    }
    case 'weak-spot': {
      const byLapses = [...learn, ...review.map(e => ({ ...e, type: 'review' }))]
        .sort((a, b) => (b.card?.lapses || 0) - (a.card?.lapses || 0));
      queue = byLapses;
      break;
    }
    case 'custom': {
      const mixed = [...learn, ...review.map(e => ({ ...e, type: 'review' }))]
        .sort((a, b) => {
          const ia = a.card.scheduledDays ?? a.card.interval ?? 999;
          const ib = b.card.scheduledDays ?? b.card.interval ?? 999;
          return ia - ib;
        });
      queue = [...mixed];
      const slice = fresh.slice(0, newAllowed || Infinity);
      queue.push(...slice.map(w => ({ word: w, card: null, type: 'new' })));
      break;
    }
    case 'standard':
    default: {
      queue = [...learn, ...review.map(e => ({ ...e, type: 'review' }))];
      const slice = fresh.slice(0, newAllowed || Infinity);
      queue.push(...slice.map(w => ({ word: w, card: null, type: 'new' })));
      break;
    }
  }

  // Cap total queue to dailyGoal if set (so the session matches user's target)
  if (dailyGoal > 0 && queue.length > dailyGoal) {
    queue = queue.slice(0, dailyGoal);
  }

  const actualNew = queue.filter(q => q.type === 'new').length;
  return { queue, newCount: actualNew };
}
