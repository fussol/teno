// ═══════════════════════════════════════════════════════════════
// Scheduler — Pure scheduling logic for due cards, bury/suspend.
// No window, no DOM, no DB.
//
// BETA-B: Anki-style due-card queue.
//   1. Learning / Relearning cards due today (intraday, oldest first)
//   2. Review cards due today (by due date ascending)
//   3. New cards up to newPerDay (appended after reviews, Anki default)
// ═══════════════════════════════════════════════════════════════

import { GOOD, STATE_REVIEW, STATE_RELEARNING, STATE_LEARNING, STATE_NEW } from './fsrs.js';

/** A review is "correct" (retained) when rated GOOD or EASY (>= 2). */
const CORRECT_THRESHOLD = GOOD;

/**
 * Compute future due counts for the next N days.
 * @param {Map<string,object>} cards - Map of word_id → card state
 * @param {number} days - Number of days to look ahead
 * @param {number} dayCutoff - Minutes after midnight for day rollover
 * @returns {number[]} Array of card counts per day (index 0 = today)
 */
export function computeFutureDueCounts(cards, days = 90, dayCutoff = 0, timezoneOffset) {
  const today = getToday(dayCutoff, timezoneOffset);
  const todayParts = today.split('-').map(Number);
  const todayDate = new Date(todayParts[0], todayParts[1] - 1, todayParts[2]);
  const counts = new Array(days).fill(0);
  
  for (const [, card] of cards) {
    if (!card.due || card.state !== STATE_REVIEW) continue;
    const dueDate = new Date(card.due);
    const dueStr = toLocalDateStr(dueDate, timezoneOffset, dayCutoff);
    if (dueStr < today) continue;
    
    // Normalize both dates to midnight using consistent timezoneOffset
    const dueParts = dueStr.split('-').map(Number);
    const dueLocal = new Date(dueParts[0], dueParts[1] - 1, dueParts[2]);
    const diffDays = Math.round((dueLocal - todayDate) / 86400000);
    if (diffDays >= 0 && diffDays < days) {
      counts[diffDays]++;
    }
  }
  
  return counts;
}

/**
 * Return the current "today" date string, optionally shifted by dayCutoff
 * (minutes after midnight). For example, dayCutoff=240 means the day rolls
 * over at 4 AM instead of midnight.
 */
export function getToday(dayCutoff = 0, timezoneOffset, now) {
  let d = now ? new Date(now) : new Date(Date.now());
  if (typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now)) {
    const parts = now.split('-').map(Number);
    d = new Date(parts[0], parts[1] - 1, parts[2]);
  }

  if (timezoneOffset != null) {
    const ms = d.getTime() + timezoneOffset * 60000;
    const local = new Date(ms);
    const minutesSinceMidnight = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (dayCutoff > 0 && minutesSinceMidnight < dayCutoff) {
      local.setUTCDate(local.getUTCDate() - 1);
    }
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const day = String(local.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  if (dayCutoff > 0) {
    const minutesSinceMidnight = d.getHours() * 60 + d.getMinutes();
    if (minutesSinceMidnight < dayCutoff) {
      d.setDate(d.getDate() - 1);
    }
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Anki sort_learning comparator: cmp_by_reps_then_due.
 * Learning/relearning cards due today are ordered by reps ascending (fewer reps
 * first), then due ascending (earliest first). Both the dashboard preview
 * (getDueCards) and the session queue (Session.buildQueue → intradayLearning)
 * MUST use this exact comparator so the previewed order matches the actual
 * study order. (Anki rslib: b.reps.cmp(&a.reps).then_with(|| a.due.cmp(&b.due)))
 * @param {object} a - card object ({ reps, due })
 * @param {object} b - card object ({ reps, due })
 * @returns {number}
 */
export function cmpByRepsThenDue(a, b) {
  const repsA = a?.reps ?? 0;
  const repsB = b?.reps ?? 0;
  if (repsA !== repsB) return repsA - repsB;
  const msA = a?.due ? new Date(a.due).getTime() : NaN;
  const msB = b?.due ? new Date(b.due).getTime() : NaN;
  return (Number.isFinite(msA) ? msA : 0) - (Number.isFinite(msB) ? msB : 0);
}

/**
 * Get cards that are due for review today, ordered Anki-style.
 *
 * @param {object[]} words - All words
 * @param {Map<string,object>} cards - Map of word_id → card state
 * @param {Set<string>} buried - Set of buried word IDs
 * @param {Set<string>} suspended - Set of suspended word IDs
 * @param {number} newPerDay - Max new cards per day
 * @param {number} [dayCutoff] - Minutes after midnight for day rollover
 * @param {string} [now] - ISO date string (for testing)
 * @returns {{ due: object[], newCount: number }}
 */
export function getDueCards(words, cards, buried, suspended, newPerDay, dayCutoff = 0, timezoneOffset, ratedNewToday = 0, now, maxReviewsPerDay = 0, countsOnly = false) {
  const today = getToday(dayCutoff, timezoneOffset, now);
  const learnQueue = []; // Learning / Relearning due today
  const reviewQueue = []; // Review due today
  const newQueue = [];

  for (const word of words) {
    if (buried.has(word.id)) continue;
    if (suspended.has(word.id)) continue;

    const card = cards.get(word.id);
    if (!card) {
      newQueue.push(word);
      continue;
    }
    if (card.state === STATE_NEW) {
      newQueue.push(word);
      continue;
    }
    if (!card.due) continue;
    if (toLocalDateStr(new Date(card.due), timezoneOffset, dayCutoff) > today) continue;

    // Due today: route by state.
    if (card.state === STATE_REVIEW) {
      reviewQueue.push({ word, card });
    } else {
      // STATE_LEARNING or STATE_RELEARNING (and any unknown → treat as learning)
      learnQueue.push({ word, card });
    }
  }

  // Learning/relearning: Anki sort_learning = cmp_by_reps_then_due
  // (reps 小→大，再 due 早→晚) — 與 Session.buildQueue 同一 comparator，
  // 確保 dashboard 預覽順序 = 實際 session 學習順序。
  learnQueue.sort((a, b) => cmpByRepsThenDue(a.card, b.card));
  // Review: earliest due first.
  reviewQueue.sort((a, b) => String(a.card.due || '').localeCompare(String(b.card.due || '')));

  const due = [];
  // Learning first (uncapped, like session intradayLearning)
  for (const { word } of learnQueue) due.push({ ...word });

  // C5: cap 僅套 review 卡 — 與 session buildQueue（session-v4.js:97-98）同語意。
  // 原實作把 cap 打在 review+new 的 combined 總和上且註解謊稱 matches session：
  // new 卡排擠 review 額度 → dashboard 少報（例 cap=50：顯示 50、session 實發 60+額度）。
  // learning 不 cap（已 intro 必發）、new 走各自 cardsPerDay 額度，不占 review 預算。
  if (maxReviewsPerDay > 0 && reviewQueue.length > maxReviewsPerDay) {
    reviewQueue.length = maxReviewsPerDay;
  }
  // G7: counts-only fast path — mc/spell dashboard badges need the number,
  // not the word list. Admission counted with the SAME loop as the full path
  // below (verbatim) so boundary semantics (newPerDay 0/NaN/negative) can
  // never diverge. Skips all {...word} spreads.
  if (countsOnly) {
    let nt = Math.max(0, ratedNewToday);
    for (let i = 0; i < newQueue.length; i++) {
      if (nt >= newPerDay) break;
      nt++;
    }
    return { due: null, count: learnQueue.length + reviewQueue.length + (nt - Math.max(0, ratedNewToday)), newCount: nt - Math.max(0, ratedNewToday) };
  }
  const combined = [];
  for (const { word } of reviewQueue) combined.push({ ...word });
  let newToday = Math.max(0, ratedNewToday);
  for (const word of newQueue) {
    if (newToday >= newPerDay) break;
    combined.push({ ...word });
    newToday++;
  }
  due.push(...combined);

  return { due, newCount: newToday - Math.max(0, ratedNewToday) };
}

/**
 * Check if a card is a leech based on lapse count.
 * Official Anki (rslib review_複習狀態機.rs): a card is a leech when
 * lapses >= threshold && (lapses - threshold) % max(1, ceil(threshold/2)) === 0.
 * threshold=8 fires at 8, 12, 16, 20, ...
 *
 * @param {number} lapses
 * @param {number} [threshold=8]
 * @returns {boolean}
 */
export function isLeech(lapses, threshold = 8) {
  if (threshold <= 0 || lapses <= 0) return false;
  const halfThreshold = Math.max(1, Math.ceil(threshold / 2));
  return lapses >= threshold && (lapses - threshold) % halfThreshold === 0;
}

/**
 * Count stats for dashboard.
 *
 * "due" = cards in today's review queue = (learned cards with due<=today)
 * plus new cards up to the daily new-card limit. This matches the
 * sidebar badge / review-page queue length.
 *
 * @param {object[]} words
 * @param {Map<string,object>} cards
 * @param {Set<string>} buried
 * @param {Set<string>} suspended
 * @param {number} [newPerDay=Infinity] - daily new-card cap
 * @returns {{ total: number, learned: number, new: number, due: number, mature: number, avgDifficulty: number, young: number }}
 */
export function computeStats(words, cards, buried, suspended, newPerDay = Infinity, dayCutoff = 0, timezoneOffset, ratedNewToday = 0) {
  const today = getToday(dayCutoff, timezoneOffset);
  let learned = 0, due = 0, mature = 0, young = 0;
  let diffSum = 0, diffCount = 0;
  let newCount = 0;

  for (const word of words) {
    if (buried.has(word.id) || suspended.has(word.id)) continue;
    const card = cards.get(word.id);
    if (!card) { newCount++; continue; }
    learned++;
    if (card.due && toLocalDateStr(new Date(card.due), timezoneOffset, dayCutoff) <= today) due++;
    // Mature = Review-state card with a scheduled interval >= 21 days
    // (Anki's definition). Relearning cards are not counted as mature.
    const ivl = card.scheduledDays ?? card.interval ?? 0;
    if (card.state === STATE_REVIEW && ivl >= 21) mature++;
    else if (card.state === STATE_REVIEW || card.state === STATE_LEARNING || card.state === STATE_RELEARNING) young++;
    if (card.difficulty != null) {
      diffSum += card.difficulty;
      diffCount++;
    }
  }

  // New cards in today's queue (up to the daily cap) also count as due.
  due += Math.max(0, Math.min(newCount, newPerDay - ratedNewToday));

  return {
    total: words.length,
    learned,
    new: words.length - learned,
    due,
    mature,
    young,
    avgDifficulty: diffCount > 0 ? diffSum / diffCount : 0,
  };
}

/**
 * Compute the current consecutive-day streak from a list of date strings.
 * A streak counts consecutive days ending today (or yesterday if today
 * has no activity yet, so the streak doesn't reset until a day is missed).
 *
 * @param {string[]} dates - ISO date strings (YYYY-MM-DD)
 * @returns {number}
 */
export function toLocalDateStr(d, timezoneOffset, dayCutoff) {
  if (timezoneOffset != null) {
    const ms = d.getTime() + timezoneOffset * 60000;
    const local = new Date(ms);
    if (dayCutoff > 0) {
      const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
      if (mins < dayCutoff) local.setUTCDate(local.getUTCDate() - 1);
    }
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, '0');
    const day = String(local.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (dayCutoff > 0) {
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins < dayCutoff) {
      d = new Date(d);
      d.setDate(d.getDate() - 1);
    }
  }
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/**
 * A10: 下一個日界線時刻（epoch ms）— 對齊 Anki rslib `SchedTimingToday.next_day_at`
 * （scheduler/timing.rs sched_timing_today_v2_new：`next_day_at = 今天日界線
 * 若未過，否則明天日界線`）。日界線 = dayCutoff 分鐘（例 480 = 08:00）的本地時刻；
 * 「今天」的起點 = 最近一次日界線，下一個日界線 = 今天起點 + 1 天。
 * timezoneOffset 為 null 時用系統本地時區（與 getToday/toLocalDateStr 一致）。
 * 一致性保證：`nextDayAtMs() - 86400000` 的 toLocalDateStr == getToday()，
 * 故 `nextDayAtMs + (X-1)天` 的到期日 == getToday + X（Anki review due day 語意）。
 *
 * @param {number} [dayCutoff=0] - 日界線分鐘（480 = 08:00；0 = 午夜）
 * @param {number} [timezoneOffset] - UTC 偏移分鐘（UTC+8 = 480）；null = 系統本地
 * @param {string|number|Date} [now] - 基準時刻（測試注入；預設 Date.now()）
 * @returns {number} 下一個日界線的 epoch ms
 */
export function nextDayAtMs(dayCutoff = 0, timezoneOffset, now) {
  const t = now != null ? new Date(now).getTime() : Date.now();
  const tz = timezoneOffset != null ? timezoneOffset : -new Date(t).getTimezoneOffset();
  const cutoff = dayCutoff > 0 ? dayCutoff : 0;
  const local = new Date(t + tz * 60000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const todayRoll = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    Math.floor(cutoff / 60), cutoff % 60
  );
  // 日界線已過 → 下一個是明天；未過 → 今天（Anki timing.rs 同判：rollover <= now）
  const next = mins < cutoff ? todayRoll : todayRoll + 86400000;
  return next - tz * 60000;
}

/**
 * A10: Anki 日界線錨定的 due（ISO 字串）— 修掉「due 錨定作答時刻」bug。
 *
 * Anki rslib 官方模型（查證 2026-08-15 main）：
 *   - Review 卡作答後 `card.due = days_elapsed + scheduled_days`（天數制，
 *     scheduler/answering/review.rs:20），到期日 = 今天日界線 + interval 天，
 *     與作答時刻無關 → 23:50 與 00:10（同日界線）作答得到相同 due，無抖動。
 *     等價時間戳 = next_day_at + (scheduled_days - 1) * 86400 秒。
 *   - 學習卡 sub-day step：due = now + step 秒（intraday 時間戳，
 *     answering/learning.rs fuzzed_next_learning_timestamp / intraday_due.sql
 *     `queue IN (1,4) AND due <= next_day_at`）。
 *   - 學習卡 ≥ 1 天 step：Anki 轉 DayLearn 天數制（maybe_as_days → InDays →
 *     `due = days_elapsed + days`）→ 同 review 日界線錨定。
 *
 * @param {number} dueDays - fsrs.review() 的 dueDays（天數；學習 step 可為小數）
 * @param {number} state - STATE_REVIEW / STATE_LEARNING / STATE_RELEARNING
 * @param {number} [dayCutoff] - 日界線分鐘（480 = 08:00）
 * @param {number} [timezoneOffset] - 分鐘；null = 系統本地
 * @param {string|number|Date} [now] - 作答時刻（測試注入；預設 Date.now()）
 * @returns {string} ISO due 時間戳
 */
export function computeDueIso(dueDays, state, dayCutoff, timezoneOffset, now) {
  const intervalDays = state === STATE_REVIEW ? Math.round(dueDays) : dueDays;
  if (intervalDays >= 1) {
    // 日界線錨定：今天日界線 + interval 天（= next_day_at + (interval-1) 天）
    const nextDay = nextDayAtMs(dayCutoff, timezoneOffset, now);
    return new Date(nextDay + (Math.round(intervalDays) - 1) * 86400000).toISOString();
  }
  // sub-day 學習 step：intraday（now + step），保留既有 60s 下限
  const t = now != null ? new Date(now).getTime() : Date.now();
  return new Date(t + Math.max(60000, Math.round(dueDays * 86400000))).toISOString();
}

export function computeStreak(dates, dayCutoff = 0, timezoneOffset) {
  if (!dates || dates.length === 0) return 0;
  const set = new Set(dates);
  const parts = getToday(dayCutoff, timezoneOffset).split('-').map(Number);
  const today = new Date(parts[0], parts[1] - 1, parts[2]);
  let cursor = new Date(today);
  if (!set.has(toLocalDateStr(cursor, timezoneOffset, dayCutoff))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (set.has(toLocalDateStr(cursor, timezoneOffset, dayCutoff))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * Compute the longest consecutive-day streak ever from a list of date
 * strings. Used for the "best streak" record.
 *
 * @param {string[]} dates - ISO date strings (YYYY-MM-DD)
 * @returns {number}
 */
export function computeBestStreak(dates, dayCutoff = 0, timezoneOffset) {
  if (!dates || dates.length === 0) return 0;
  const set = new Set(dates);
  let best = 0;
  for (const d of set) {
    const prev = new Date(d + 'T12:00:00');
    prev.setDate(prev.getDate() - 1);
    if (set.has(toLocalDateStr(prev, timezoneOffset, dayCutoff))) continue;
    let len = 0;
    const cur = new Date(d + 'T12:00:00');
    while (set.has(toLocalDateStr(cur, timezoneOffset, dayCutoff))) {
      len++;
      cur.setDate(cur.getDate() + 1);
    }
    if (len > best) best = len;
  }
  return best;
}

/**
 * Count reviews that happened today (YYYY-MM-DD match on reviewed_at).
 *
 * @param {object[]} reviewLog
 * @returns {number}
 */
export function countTodayReviews(reviewLog, dayCutoff = 0, timezoneOffset) {
  const today = getToday(dayCutoff, timezoneOffset);
  const tz = timezoneOffset;
  return reviewLog.filter(e => {
    if (!e || !e.reviewed_at) return false;
    const d = new Date(e.reviewed_at);
    if (tz != null) {
      return toLocalDateStr(d, tz, dayCutoff) === today;
    }
    return toLocalDateStr(d, null, dayCutoff) === today;
  }).length;
}

/**
 * Compute retention rate from review log.
 *
 * @param {object[]} reviewLog
 * @param {number} [lookbackDays=30]
 * @returns {{ rate: number, total: number, correct: number }}
 */
export function computeRetention(reviewLog, lookbackDays = 30) {
  const cutoff = Date.now() - lookbackDays * 86400000;
  // G7: reverse scan with early break. reviewLog is loaded ORDER BY
  // reviewed_at, id (db.js:493) and rateCard only appends at the tail ⇒
  // chronological. Entries missing reviewed_at are excluded (same as the
  // old forward filter). O(lookback window) instead of O(full log).
  let total = 0, correct = 0;
  for (let i = reviewLog.length - 1; i >= 0; i--) {
    const e = reviewLog[i];
    if (!e.reviewed_at) continue;
    if (new Date(e.reviewed_at).getTime() <= cutoff) break;
    total++;
    if (e.rating >= CORRECT_THRESHOLD) correct++;
  }
  if (total === 0) return { rate: 0, total: 0, correct: 0 };
  return { rate: correct / total, total, correct };
}

/**
 * Compute rating distribution by card state.
 *
 * @param {object[]} reviewLog
 * @returns {object}
 */
export function computeRatingProfile(reviewLog) {
  const groups = { new: [], young: [], mature: [] };
  for (const e of reviewLog) {
    const ivl = e.ivl ?? e.scheduledDays ?? 0;
    const g = e.state != null
      ? (e.state === STATE_REVIEW && ivl >= 21 ? 'mature'
        : e.state === STATE_REVIEW ? 'young'
        : 'new')
      : 'new';
    if (groups[g]) groups[g].push(e.rating);
  }

  const result = { total: reviewLog.length, states: {} };
  for (const [state, ratings] of Object.entries(groups)) {
    if (ratings.length < 5) continue;
    const n = ratings.length;
    result.states[state] = {
      count: n,
      again: (ratings.filter(r => r === 0).length / n) * 100,
      hard: (ratings.filter(r => r === 1).length / n) * 100,
      good: (ratings.filter(r => r === 2).length / n) * 100,
      easy: (ratings.filter(r => r === 3).length / n) * 100,
    };
  }
  return result;
}
