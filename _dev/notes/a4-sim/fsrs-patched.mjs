// Port of fsrs-rs (https://github.com/open-spaced-repetition/fsrs-rs), MIT licensed.
// Copyright (c) Open Spaced Repetition contributors.
// Rating: 0=Again, 1=Hard, 2=Good, 3=Easy (Rust uses 1-indexed).

export const FSRS_PARAMS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133,
  0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483,
  0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
]);

const S_MIN = 0.001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;
const AGAIN = 0, HARD = 1, GOOD = 2, EASY = 3;

export { AGAIN, HARD, GOOD, EASY };
export const STATE_NEW = 0, STATE_LEARNING = 1, STATE_REVIEW = 2, STATE_RELEARNING = 3;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// A4 修法 2: 分鐘逗號字串 → 天數陣列；NaN/負值/空段丟棄；全丟 → []（fsrs.js 判 [] 畢業）
export function parseStepsStr(str, fallback) {
  const src = (str == null || String(str).trim() === '') ? (fallback ?? '') : String(str);
  const out = src.split(',').map(s => parseFloat(s.trim()) / 1440)
    .filter(v => Number.isFinite(v) && v > 0);
  return out;
}

// ─── free functions (mirror Rust top-level fns) ───

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

function init_stability(w, rating) {
  return w[rating]; // Rust: w[rating.saturating_sub(1).min(3)]; rating 1-idx → idx 0-idx
}

function init_difficulty(w, rating) {
  // Rust: w[4] - exp(w[5] * (rating-1)) + 1, rating 1-idx
  // JS:   w[4] - exp(w[5] * rating) + 1,       rating 0-idx
  return w[4] - Math.exp(w[5] * rating) + 1;
}

function mean_reversion(w, new_d) {
  return w[7] * (init_difficulty(w, EASY) - new_d) + new_d;
}

function linear_damping(delta_d, old_d) {
  return (10 - old_d) * delta_d / 9;
}

function next_difficulty(w, difficulty, rating) {
  // Rust: delta_d = -w[6] * (rating - 3), rating 1-idx
  // JS:   delta_d = -w[6] * (rating - 2), rating 0-idx
  const delta_d = -w[6] * (rating - 2);
  return difficulty + linear_damping(delta_d, difficulty);
}

function stability_after_success(w, last_s, last_d, r, rating) {
  const hard_penalty = rating === HARD ? w[15] : 1;
  const easy_bonus = rating === EASY ? w[16] : 1;
  return last_s * (
    Math.exp(w[8]) * (11 - last_d) *
    Math.pow(last_s, -w[9]) *
    (Math.exp((1 - r) * w[10]) - 1) *
    hard_penalty * easy_bonus +
    1
  );
}

function stability_after_failure(w, last_s, last_d, r) {
  const new_s = w[11] *
    Math.pow(last_d, -w[12]) *
    (Math.pow(last_s + 1, w[13]) - 1) *
    Math.exp((1 - r) * w[14]);
  const new_s_min = last_s / Math.exp(w[17] * w[18]);
  return Math.min(new_s, new_s_min);
}

function stability_short_term(w, last_s, rating) {
  const sinc = Math.exp(w[17] * (rating - 2 + w[18])) * Math.pow(last_s, -w[19]);
    // Official fsrs-rs 6.6.1 (model.rs): floor applies to rating >= 2.0 (Rust 1-idx) = Hard+
    // JS 0-idx: HARD = 1
    return last_s * (rating >= HARD ? Math.max(sinc, 1) : sinc);
}

function step(w, delta_t, rating, state, nth) {
  let last_s = clamp(state.stability, S_MIN, S_MAX);
  let last_d = clamp(state.difficulty, D_MIN, D_MAX);

  const r = power_forgetting_curve(w, delta_t, last_s);
  const s_recall = stability_after_success(w, last_s, last_d, r, rating);
  const s_fail = stability_after_failure(w, last_s, last_d, r);
  const s_short = stability_short_term(w, last_s, rating);

  // Rust: new_s = if rating==1 { s_fail } else { s_recall }
  let new_s = rating === AGAIN ? s_fail : s_recall;
  // Rust: if delta_t == 0 { new_s = s_short }
  if (delta_t === 0) new_s = s_short;

  let new_d = next_difficulty(w, last_d, rating);
  new_d = clamp(mean_reversion(w, new_d), D_MIN, D_MAX);

  // Rust: if nth == 0 && state.stability == 0 { init }
  if (nth === 0 && state.stability === 0) {
    const init_r = clamp(rating, 0, 3);
    new_s = init_stability(w, init_r);
    new_d = clamp(init_difficulty(w, init_r), D_MIN, D_MAX);
  }

  // Rust: if rating == 0 { noop } — not applicable (JS 0 = Again)
  return {
    stability: isFinite(new_s) ? clamp(new_s, S_MIN, S_MAX) : S_MIN,
    difficulty: isFinite(new_d) ? clamp(new_d, D_MIN, D_MAX) : D_MIN,
  };
}

// ─── Fuzz (port from Anki's rslib/src/scheduler/states/fuzz.rs) ───

const FUZZ_RANGES = [
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Infinity, factor: 0.05 },
];

/**
 * Compute the fuzz delta (±days) for a given interval.
 * Short intervals (< 2.5 days) get no fuzz. All others get 1 day base
 * plus proportional fuzz from each range band.
 */
function fuzzDelta(interval) {
  if (interval < 2.5) return 0;
  return FUZZ_RANGES.reduce((delta, range) => {
    return delta + range.factor * Math.max(0, Math.min(interval, range.end) - range.start);
  }, 1.0);
}

/** Return unclamped (lower, upper) fuzz bounds for an interval. */
function fuzzBounds(interval) {
  const delta = fuzzDelta(interval);
  return [Math.round(interval - delta), Math.round(interval + delta)];
}

/** Return clamped fuzz bounds respecting minimum and maximum. */
function constrainedFuzzBounds(interval, minimum, maximum) {
  minimum = Math.min(minimum, maximum);
  const clamped = Math.max(minimum, Math.min(maximum, interval));
  let [lower, upper] = fuzzBounds(clamped);
  lower = Math.max(minimum, Math.min(maximum, lower));
  upper = Math.max(minimum, Math.min(maximum, upper));
  if (upper === lower && upper > 2 && upper < maximum) {
    upper = lower + 1;
  }
  return [lower, upper];
}

/**
 * Anki greaterThanLast：回傳該 rating 的 fuzz 下限（min）。
 * branch 1：raw 四捨五入後已大於 prevIvl → 下限 = prevIvl+1（fuzz 可下偏，強制至少 +1）
 * branch 2：prevIvl 落在 fuzz 範圍內 → 下限 = prevIvl+1
 *           （R1 修正：v3 原為 prevIvl，但 fuzz=0 等值點與短間隔退化區間會產出
 *             == prevIvl，違反「嚴格大於」；Anki 原文 branch2 為 prevIvl（允許等值），
 *             本計畫刻意採 +1 以滿足 §1 嚴格大於 — 計畫語意下 H/G/E 永不 == prevIvl）
 * branch 3（shrunk）：prevIvl 超出 fuzz 範圍（間隔縮水，FSRS 參數變動/早複習所致）→ 0（不設下限）
 */
function minReviewFuzzInterval(raw, prevIvl, maxIvl) {
  const rounded = Math.round(raw);
  if (rounded > prevIvl) return prevIvl + 1;
  const [, upper] = constrainedFuzzBounds(raw, 1, maxIvl);
  if (prevIvl <= upper) return prevIvl + 1;
  return 0;
}

/**
 * 唯一 fuzz 執行點（供 greaterThanLast 鏈式迴圈使用）。結果保證 ≥ min 且為整數。
 * fuzz 停用（enableFuzzing=false 或 fuzzFactor==null）時走 clamp 路徑但仍尊重 min（鏈式保留）。
 */
function fuzzInterval(raw, min, fuzzFactor, futureCounts, maxIvl, enableFuzzing) {
  if (!enableFuzzing || fuzzFactor == null) {
    // min 先 clamp 到 maxIvl，避免 min > maxIvl 時產出 maxIvl+1..+3（破 cap）
    const m = Math.min(min, maxIvl);
    return Math.round(Math.max(m, Math.min(maxIvl, raw)));
  }
  const [lower, upper] = constrainedFuzzBounds(raw, min, maxIvl);
  if (futureCounts && futureCounts.length > Math.round(raw)) {
    // 先整數化再進 load balancing（避免早退回傳未 round 的浮點 raw）
    const day = Math.max(lower, Math.min(upper, Math.round(raw)));
    return selectIntervalWithLoadBalancing(day, [lower, upper], futureCounts, fuzzFactor);
  }
  return withReviewFuzz(fuzzFactor, raw, min, maxIvl);
}

/**
 * Apply fuzz to an interval using a fuzzFactor ∈ [0, 1].
 * Returns an integer interval clamped to [minimum, maximum].
 */
function withReviewFuzz(fuzzFactor, interval, minimum, maximum) {
  if (fuzzFactor != null) {
    const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
    return Math.floor(lower + fuzzFactor * (1 + upper - lower));
  }
  return Math.round(Math.max(minimum, Math.min(maximum, interval)));
}

/**
 * Generate a deterministic fuzz factor for a card review.
 * Uses a simple hash of wordId + reps to produce a value in [0, 1).
 */
export function generateFuzzFactor(wordId, reps) {
  const str = String(wordId) + ':' + String(reps);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  // Normalize to [0, 1)
  return (Math.abs(hash) % 10000) / 10000;
}

/**
 * Select the best interval within fuzz range to minimize future load.
 * @param {number} interval - Raw interval in days
 * @param {number[]} fuzzRange - [min, max] fuzz bounds
 * @param {number[]} futureCounts - Array of future due counts
 * @param {number} fuzzFactor - Random factor ∈ [0, 1] for tie-breaking
 * @returns {number} Adjusted interval
 */
function selectIntervalWithLoadBalancing(interval, fuzzRange, futureCounts, fuzzFactor) {
  const [minIvl, maxIvl] = fuzzRange;
  if (interval < minIvl || interval > maxIvl) return interval;
  let minLoad = Infinity;
  let bestDays = [];
  for (let day = minIvl; day <= maxIvl; day++) {
    const load = futureCounts[day] ?? 0;
    if (load < minLoad) { minLoad = load; bestDays = [day]; }
    else if (load === minLoad) { bestDays.push(day); }
  }
  if (bestDays.length === 1) return bestDays[0];
  const idx = Math.floor(fuzzFactor * bestDays.length);
  return bestDays[Math.min(idx, bestDays.length - 1)];
}

// ─── FSRS class ───

export class FSRS {
  constructor(weights, desiredRetention = 0.9, enableFuzzing = true, maximumInterval = 36500) {
    this.w = weights ?? FSRS_PARAMS;
    this.desiredRetention = desiredRetention;
    this.enableFuzzing = enableFuzzing;
    this.maximumInterval = maximumInterval;
  }

  /** Pure step (mirrors Rust `FSRS::step`). */
  step(delta_t, rating, state, nth) {
    return step(this.w, delta_t, rating, state, nth);
  }

  /** Forgetting curve: predicted recall probability after t days with stability s. */
  forgettingCurve(t, s) {
    return power_forgetting_curve(this.w, t, s);
  }

  /** Pre-compute all 4 buttons. Optionally apply fuzz for review-state intervals. */
  nextStates(memoryState, daysElapsed, fuzzFactor) {
    const state = memoryState ?? { stability: 0, difficulty: 0 };
    const nth = (memoryState && memoryState.stability) ? 1 : 0;
    const out = {};
    for (const r of [AGAIN, HARD, GOOD, EASY]) {
      const mem = step(this.w, daysElapsed, r, state, nth);
      const ivl = next_interval(this.w, mem.stability, this.desiredRetention);
      const rawIvl = Math.round(clamp(ivl, 1, this.maximumInterval));
      // Apply fuzz only for review intervals (>= 2.5 days threshold built into withReviewFuzz)
      const fuzzed = (this.enableFuzzing && fuzzFactor != null && rawIvl >= 3)
        ? withReviewFuzz(fuzzFactor, rawIvl, 1, this.maximumInterval)
        : rawIvl;
      out[r] = { memory: mem, interval: fuzzed };
    }
    return out;
  }

  /** Backward compat: used by store.js — mirrors Anki's step logic.
   *  Optional fuzzFactor ∈ [0,1] applies fuzz to review-state intervals.
   *  Optional learnSteps / relearnSteps arrays (in days) override defaults.
   *  Optional futureCounts enables load balancing. */
  review(card, rating, fuzzFactor, learnSteps, relearnSteps, futureCounts) {
    const { stability, difficulty, state, reps, lapses, elapsedDays, scheduledDays, step: stepIdx } = card;
    const delta_t = Math.max(0, elapsedDays ?? scheduledDays ?? 0);
    const nth = (state === STATE_NEW || !stability || stability === 0) ? 0 : 1;
    const mem = step(this.w, delta_t, rating,
      { stability: stability ?? 0, difficulty: difficulty ?? 5 }, nth);

    let newState = state, newReps = (reps || 0) + 1, newLapses = lapses || 0, newStep = stepIdx ?? 0, interval = 0;

    // Default learning steps: [1 min, 10 min] in days
    const defaultLearnSteps = [1/1440, 10/1440];
    // Default relearning steps: [10 min] in days
    const defaultRelearnSteps = [10/1440];
    
    const actualLearnSteps = learnSteps ?? defaultLearnSteps;
    const actualRelearnSteps = relearnSteps ?? defaultRelearnSteps;

    // Anki: hard_delay_secs(remaining) → hard interval based on step position
    // A4 修法 1: 空/無效 steps 回 null（Anki Option 語意 → 呼叫端判畢業）
    function hardDelay(steps, stp) {
      if (!steps || steps.length === 0) return null;
      const v = (steps.length === 1) ? steps[0] * 1.5
        : (stp === 0 && steps.length >= 2) ? (steps[0] + steps[1]) / 2
        : (steps[stp] ?? steps[0] ?? 0);
      return (v == null || !Number.isFinite(v) || v <= 0) ? null : v;
    }

    // Anki: again_delay → always step[0]；A4 修法 1: 空/無效回 null（Anki again_delay_secs_learn() -> Option）
    function againDelay(steps) {
      const first = steps?.[0];
      if (first == null || !Number.isFinite(first) || first <= 0) return null;
      return first;
    }

    if (state === STATE_NEW) {
      if (rating === AGAIN) {
        const d = againDelay(actualLearnSteps);
        if (d == null) { newState = STATE_REVIEW; newStep = 0; interval = next_interval(this.w, mem.stability, this.desiredRetention); }
        else { newState = STATE_LEARNING; newStep = 0; interval = d; }
      } else if (rating === HARD) {
        const d = hardDelay(actualLearnSteps, 0);
        if (d == null) { newState = STATE_REVIEW; newStep = 0; interval = next_interval(this.w, mem.stability, this.desiredRetention); }
        else { newState = STATE_LEARNING; newStep = 0; interval = d; }
      } else if (rating === GOOD) {
        if (actualLearnSteps.length > 1) {
          newState = STATE_LEARNING; newStep = 1; interval = actualLearnSteps[1] ?? actualLearnSteps[0] ?? 0;
        } else {
          newState = STATE_REVIEW; newStep = 0;
          interval = next_interval(this.w, mem.stability, this.desiredRetention);
        }
      } else {
        newState = STATE_REVIEW; newStep = 0;
        interval = next_interval(this.w, mem.stability, this.desiredRetention);
      }
    } else if (state === STATE_LEARNING || state === STATE_RELEARNING) {
      const steps = state === STATE_RELEARNING ? actualRelearnSteps : actualLearnSteps;
      if (rating === AGAIN) {
        newStep = 0;
        const d = againDelay(steps);
        if (d == null) { newState = STATE_REVIEW; newStep = 0; interval = next_interval(this.w, mem.stability, this.desiredRetention); }
        else { interval = d; }
      } else if (rating === HARD) {
        const d = hardDelay(steps, stepIdx ?? 0);
        if (d == null) { newState = STATE_REVIEW; newStep = 0; interval = next_interval(this.w, mem.stability, this.desiredRetention); }
        else { interval = d; }
      } else if (rating === GOOD) {
        newStep = (stepIdx ?? 0) + 1;
        if (newStep >= steps.length) {
          newState = STATE_REVIEW; newStep = 0;
          interval = next_interval(this.w, mem.stability, this.desiredRetention);
        } else {
          interval = steps[newStep];
        }
      } else {
        newState = STATE_REVIEW; newStep = 0;
        interval = next_interval(this.w, mem.stability, this.desiredRetention);
      }
    } else {
      if (rating === AGAIN) {
        newLapses++;
        newStep = 0;
        const d = againDelay(actualRelearnSteps);
        if (d == null) { newState = STATE_REVIEW; newStep = 0; interval = next_interval(this.w, mem.stability, this.desiredRetention); }
        else { newState = STATE_RELEARNING; newStep = 0; interval = d; }
      } else {
        newState = STATE_REVIEW; newStep = 0;
        interval = next_interval(this.w, mem.stability, this.desiredRetention);
      }
    }

    if (newState === STATE_REVIEW) {
      if (state === STATE_REVIEW && rating >= HARD) {
        // A1: greaterThanLast 三態鏈式 — 依 rating 依序算 HARD → GOOD → EASY，
        // 前一 rating 用 fuzz 後值（Anki rslib review.rs passing_fsrs_review_intervals 同構）。
        const prevIvl = Math.round(card.scheduledDays ?? card.interval ?? 0);
        let prevFuzzed = 0;   // 前一 rating 的 fuzz 後值（鏈式下限）
        let goodRaw = 0;      // GOOD raw（A2 EASY ≥ good+1 預留）
        for (const r of [HARD, GOOD, EASY]) {
          const m = step(this.w, delta_t, r,
            { stability: stability ?? 0, difficulty: difficulty ?? 5 }, nth);
          const raw = next_interval(this.w, m.stability, this.desiredRetention);
          if (r === GOOD) goodRaw = raw;
          let min = Math.max(1, minReviewFuzzInterval(raw, prevIvl, this.maximumInterval));
          if (r === GOOD) min = Math.max(min, prevFuzzed + 1);
          // A2: EASY ≥ round(goodRaw)+1（Anki min=good+1 下限；raw 值，非 fuzz 後值）
          if (r === EASY) min = Math.max(min, prevFuzzed + 1, Math.round(goodRaw) + 1);
          prevFuzzed = fuzzInterval(raw, min, fuzzFactor, futureCounts,
            this.maximumInterval, this.enableFuzzing);
          if (r === rating) { interval = prevFuzzed; break; }
        }
      } else {
        // 非 review 卡（new/learning/relearning 畢業）
        let minIvl = 1;
        if (rating === EASY) {
          // A2: EASY ≥ round(goodRaw)+1；goodRaw = 連按 GOOD 走完剩餘 steps 的畢業 interval（raw）
          const gsteps = state === STATE_RELEARNING ? actualRelearnSteps : actualLearnSteps;
          let gs = stability ?? 0, gd = difficulty ?? 5;
          let gi = stepIdx ?? 0;
          // 連按 GOOD：非最後一步不畢業，只推進 step（delta_t=0 短間隔語意）
          while (gi < gsteps.length - 1) {
            const gm = step(this.w, 0, GOOD, { stability: gs, difficulty: gd }, nth);
            gs = gm.stability; gd = gm.difficulty;
            gi++;
          }
          // 最後一步 GOOD → 畢業（與頂部 mem 同 delta_t 基準）
          const gm = step(this.w, delta_t, GOOD, { stability: gs, difficulty: gd }, nth);
          const goodRaw = next_interval(this.w, gm.stability, this.desiredRetention);
          minIvl = Math.round(goodRaw) + 1;
        }
        // A2: 統一走 A1 fuzzInterval（唯一 fuzz 點）— LB 前 clamp、fuzz-off 尊重 min
        interval = fuzzInterval(interval, minIvl, fuzzFactor, futureCounts,
          this.maximumInterval, this.enableFuzzing);
      }
    }

    return {
      stability: mem.stability, difficulty: mem.difficulty,
      state: newState, reps: newReps, lapses: newLapses,
      step: newStep, interval, dueDays: interval,
    };
  }
}

