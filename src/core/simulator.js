import { FSRS_PARAMS, STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING, AGAIN, HARD, GOOD, EASY } from './fsrs.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function power_forgetting_curve(w, t, s) {
  const decay = -w[20];
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return Math.pow(t / s * factor + 1, decay);
}

function next_interval(w, stability, desired_retention) {
  const decay = -w[20];
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return stability / factor * (Math.pow(desired_retention, 1 / decay) - 1);
}

function stability_after_success(w, last_s, last_d, r, rating) {
  const hard_penalty = rating === HARD ? w[15] : 1;
  const easy_bonus = rating === EASY ? w[16] : 1;
  return last_s * (
    Math.exp(w[8]) * (11 - last_d) *
    Math.pow(last_s, -w[9]) *
    (Math.exp((1 - r) * w[10]) - 1) *
    hard_penalty * easy_bonus + 1
  );
}

function stability_after_failure(w, last_s, last_d, r) {
  const new_s = w[11] * Math.pow(last_d, -w[12]) * (Math.pow(last_s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
  const new_s_min = last_s / Math.exp(w[17] * w[18]);
  return Math.min(new_s, new_s_min);
}

function stability_short_term(w, last_s, rating) {
  const sinc = Math.exp(w[17] * (rating - 2 + w[18])) * Math.pow(last_s, -w[19]);
  return last_s * (rating >= GOOD ? Math.max(sinc, 1) : sinc);
}

function next_difficulty(w, difficulty, rating) {
  const delta_d = -w[6] * (rating - 2);
  const linear = (10 - difficulty) * delta_d / 9;
  const new_d = difficulty + linear;
  const mrev = w[7] * (w[4] - Math.exp(w[5] * 3) + 1 - new_d) + new_d;
  return clamp(mrev, 1, 10);
}

function init_stability(w, rating) { return w[rating]; }

function init_difficulty(w, rating) {
  return clamp(w[4] - Math.exp(w[5] * rating) + 1, 1, 10);
}

function weightedSample(probs, rng) {
  if (!probs || probs.length === 0) return 0;
  const r = rng() * probs.reduce((a, b) => a + b, 0);
  let cum = 0;
  for (let i = 0; i < probs.length; i++) {
    cum += probs[i];
    if (r < cum) return i;
  }
  return probs.length - 1;
}

function memoryStateShortTerm(w, s, d, initRating, ratingCosts, stepTransitions, stepCount, rng) {
  let consecutive = 0;
  let rating = initRating ?? 0;
  let cost = initRating != null ? ratingCosts[Math.min(rating, ratingCosts.length - 1)] : 0;
  const consecutiveMax = rating > 1 ? stepCount - 1 : stepCount;
  for (let step = 0; step < 5; step++) {
    if (consecutive >= consecutiveMax || rating >= 3) break;
    if (rating >= stepTransitions.length) break;
    const probs = stepTransitions[rating];
    if (!probs) break;
    rating = weightedSample(probs, rng);
    s = stability_short_term(w, s, rating);
    d = next_difficulty(w, d, rating);
    cost += ratingCosts[rating];
    if (rating > 1) consecutive++;
    else if (rating === 0) consecutive = 0;
  }
  return { stability: s, difficulty: d, cost };
}

export const DEFAULT_SIM_PARAMS = {
  maxReviewsPerDay: 200,
  maxCostPerDay: 1800,
  newCardsIgnoreReviewLimit: true,
  learningStepCount: 2,
  relearningStepCount: 1,
  humanSkipRate: 8,
  humanJitter: 30,
  humanWeekendMod: 90,
  humanAccRange: 15,
  humanFatigueProb: 0.003,
  first_rating_prob: [0.24, 0.094, 0.495, 0.171],
  review_rating_prob: [0.224, 0.631, 0.145],
  learningStepTransitions: [
    [0.3686, 0.0628, 0.5108, 0.0577],
    [0.0442, 0.4553, 0.4457, 0.0549],
    [0.0519, 0.047, 0.8462, 0.055],
  ],
  relearningStepTransitions: [
    [0.2157, 0.0643, 0.6595, 0.0604],
    [0.05, 0.4638, 0.4475, 0.0387],
    [0.1057, 0.1434, 0.7266, 0.0244],
  ],
  state_rating_costs: [
    [19.58, 18.79, 13.78, 10.71],
    [19.38, 17.59, 12.38, 8.94],
    [16.44, 15.25, 12.32, 8.03],
  ],
};

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function runSimulation({
  days = 365,
  words,
  cards,
  fsrsParams,
  newPerDay = 20,
  simParams = DEFAULT_SIM_PARAMS,
  humanMode = false,
  ankiSettings = {},
  reviewLog,
  seed,
} = {}) {
  const rng = seed != null ? mulberry32(seed) : Math.random;

  const w = fsrsParams?.weights ?? FSRS_PARAMS;
  const desiredRetention = fsrsParams?.desiredRetention ?? 0.9;
  const maxIvl = ankiSettings.maxIvl ?? 36500;
  const maxRevDay = simParams.maxReviewsPerDay ?? 99999;
  const maxCostDay = simParams.maxCostPerDay ?? 1800;
  const safeNewPerDay = newPerDay != null ? Math.max(0, newPerDay) : 20;
  const newCardsIgnoreReviewLimit = simParams.newCardsIgnoreReviewLimit ?? true;
  const learnLimit = simParams.learnLimit ?? safeNewPerDay;

  const fp = simParams.first_rating_prob ?? [0.24, 0.094, 0.495, 0.171];
  const rp = simParams.review_rating_prob ?? [0.224, 0.631, 0.145];
  const lst = simParams.learningStepTransitions ?? [[0.3686, 0.0628, 0.5108, 0.0577], [0.0442, 0.4553, 0.4457, 0.0549], [0.0519, 0.047, 0.8462, 0.055]];
  const rst = simParams.relearningStepTransitions ?? [[0.2157, 0.0643, 0.6595, 0.0604], [0.05, 0.4638, 0.4475, 0.0387], [0.1057, 0.1434, 0.7266, 0.0244]];
  const src = simParams.state_rating_costs ?? [[19.58, 18.79, 13.78, 10.71], [19.38, 17.59, 12.38, 8.94], [16.44, 15.25, 12.32, 8.03]];
  const learnStepCount = simParams.learningStepCount ?? 2;
  const relearnStepCount = simParams.relearningStepCount ?? 1;
  const suspendAfterLapses = simParams.suspendAfterLapses ?? null;

  const now = new Date();
  const totalWords = words.length;

  const newWords = [];
  const existingCards = [];

  for (const wd of words) {
    const c = cards.get(wd.id);
    if (!c) {
      newWords.push(wd.id);
    } else {
      existingCards.push({ wordId: wd.id, ...c });
    }
  }

  const daySlots = Array.from({ length: days }, () => []);

  let newIdx = 0;
  for (let d = 0; d < days; d++) {
    let n = safeNewPerDay;
    if (humanMode) {
      const dayOfWeek = (now.getDay() + d) % 7;
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        n = Math.round(n * (simParams.humanWeekendMod ?? 90) / 100);
      }
      const jitter = (simParams.humanJitter ?? 30) / 100;
      n = Math.max(1, Math.round(n * (1 - jitter + rng() * jitter * 2)));
    }
    const take = Math.min(n, newWords.length - newIdx);
    for (let i = 0; i < take; i++) {
      daySlots[d].push({
        wordId: newWords[newIdx++],
        stability: null,
        difficulty: null,
        state: STATE_NEW,
        interval: 0,
        lapses: 0,
        reps: 0,
        step: 0,
      });
    }
  }

  for (const c of existingCards) {
    const offset = Math.max(0, Math.round(((new Date(c.due ?? now)) - now) / 86400000));
    if (offset < days) {
      daySlots[offset].push({
        wordId: c.wordId,
        stability: c.stability ?? 2.5,
        difficulty: c.difficulty ?? 5,
        state: c.state ?? STATE_REVIEW,
        interval: c.scheduledDays ?? c.interval ?? 1,
        lapses: c.lapses ?? 0,
        reps: c.reps ?? 1,
        step: 0,
        lastReview: c.lastReview ? Math.round(((new Date(c.lastReview) - now) / 86400000)) : null,
      });
    }
  }

  const learnCnt = new Array(days).fill(0);
  const reviewCnt = new Array(days).fill(0);
  const memorizedCnt = new Array(days).fill(0);
  const costPerDay = new Array(days).fill(0);

  const cardTracker = new Map();
  for (const c of existingCards) {
    if (c.state === STATE_REVIEW && (c.stability ?? 0) > 0) {
      const offset = Math.max(0, Math.round(((new Date(c.due ?? now)) - now) / 86400000));
      const interval = c.scheduledDays ?? c.interval ?? 1;
      cardTracker.set(c.wordId, { lastReviewDay: offset - interval, stability: c.stability, difficulty: c.difficulty ?? 5 });
    }
  }

  for (let day = 0; day < days; day++) {
    let todayCards = [...daySlots[day]];
    let dayReviewCnt = 0;
    let dayLearnCnt = 0;
    let dayCost = 0;

    const skipped = humanMode && rng() < (simParams.humanSkipRate ?? 8) / 100;

    if (skipped) {
      if (day + 1 < days) daySlots[day + 1] = [...(daySlots[day + 1] || []), ...daySlots[day]];
    } else {
      todayCards.sort((a, b) => {
        if (a.state === b.state) return (a.interval ?? 0) - (b.interval ?? 0);
        const aLearn = a.state === STATE_LEARNING || a.state === STATE_RELEARNING || a.state === STATE_NEW;
        const bLearn = b.state === STATE_LEARNING || b.state === STATE_RELEARNING || b.state === STATE_NEW;
        if (aLearn !== bLearn) return aLearn ? -1 : 1;
        return (a.interval ?? 0) - (b.interval ?? 0);
      });

      for (let ci = 0; ci < todayCards.length; ci++) {
        const card = todayCards[ci];
        const isLearn = card.state === STATE_NEW || card.state === STATE_LEARNING || card.state === STATE_RELEARNING;
        const cardCost = src[isLearn ? 0 : 1][0];

        if (dayCost + cardCost > maxCostDay) {
          if (day + 1 < days) daySlots[day + 1].push({ ...card });
          continue;
        }

        if (!isLearn && dayReviewCnt >= maxRevDay) {
          if (day + 1 < days) daySlots[day + 1].push({ ...card });
          continue;
        }

        if (suspendAfterLapses != null && card.lapses >= suspendAfterLapses) {
          continue;
        }

        dayCost += cardCost;

        let stability, difficulty, costDelta;

        if (isLearn) {
          const initR = weightedSample(fp, rng);
          stability = init_stability(w, initR);
          difficulty = init_difficulty(w, initR);
          const result = memoryStateShortTerm(w, stability, difficulty, initR, src[0], lst, learnStepCount, rng);
          stability = result.stability;
          difficulty = result.difficulty;
          costDelta = result.cost;
          dayLearnCnt++;
        } else {
          const elapsed = typeof card.lastReview === 'number' ? Math.max(1, day - card.lastReview) : (card.interval || 1);
          const retrievability = power_forgetting_curve(w, elapsed, card.stability);
          const accRange = humanMode ? (simParams.humanAccRange ?? 15) / 100 : 0;
          const forgot = rng() > (retrievability + (rng() - 0.5) * 2 * accRange);

          if (forgot) {
            const failS = stability_after_failure(w, card.stability, card.difficulty, retrievability);
            const failD = next_difficulty(w, card.difficulty, AGAIN);
            const result = memoryStateShortTerm(w, failS, failD, null, src[2], rst, relearnStepCount, rng);
            stability = result.stability;
            difficulty = result.difficulty;
            costDelta = src[1][0] + result.cost;
            card.lapses++;
          } else {
            const rating = weightedSample(rp, rng);
            const ratingIdx = rating + 1;
            stability = stability_after_success(w, card.stability, card.difficulty, retrievability, ratingIdx);
            difficulty = next_difficulty(w, card.difficulty, ratingIdx);
            costDelta = src[1][rating];
          }

          dayReviewCnt++;
        }

        costPerDay[day] += costDelta;

        const ivl = Math.round(clamp(next_interval(w, stability, desiredRetention), 1, maxIvl));

        if (stability > 0) {
          cardTracker.set(card.wordId, { lastReviewDay: day, stability, difficulty });
        }

        const nextDay = Math.ceil(day + ivl);
        if (nextDay < days) {
          daySlots[nextDay].push({
            wordId: card.wordId,
            stability,
            difficulty,
            state: STATE_REVIEW,
            interval: ivl,
            lapses: card.lapses,
            reps: (card.reps ?? 0) + 1,
            step: 0,
            lastReview: day,
            due: nextDay,
          });
        }

        if (humanMode && dayReviewCnt > 3 && rng() < (simParams.humanFatigueProb ?? 0.003)) {
          for (let rj = ci + 1; rj < todayCards.length; rj++) {
            if (day + 1 < days) daySlots[day + 1].push({ ...todayCards[rj] });
          }
          break;
        }
      }
    }

    learnCnt[day] = dayLearnCnt;
    reviewCnt[day] = dayReviewCnt;
    costPerDay[day] = dayCost;

    let retentionSum = 0;
    for (const [, info] of cardTracker) {
      const elapsed = Math.max(0, day - info.lastReviewDay);
      retentionSum += power_forgetting_curve(w, elapsed, info.stability);
    }
    memorizedCnt[day] = Math.round(retentionSum);
  }

  const cumReviews = reviewCnt.reduce((acc, v, i) => { acc.push((acc[i - 1] || 0) + v); return acc; }, []);

  return reviewCnt.map((cnt, i) => ({
    day: i,
    date: new Date(now.getTime() + i * 86400000).toISOString().slice(0, 10),
    reviews: cnt,
    cumulative: cumReviews[i],
    matureCount: memorizedCnt[i],
    maturePct: totalWords > 0 ? Math.round((memorizedCnt[i] / totalWords) * 100) : 0,
    totalCards: totalWords,
  }));
}
