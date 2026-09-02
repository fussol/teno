// ═══════════════════════════════════════════════════════════════
// FSRS Optimizer — 用歷史複習資料最佳化 21 個 FSRS 權重
// 演算法：Adam optimizer + binary cross-entropy loss
// ═══════════════════════════════════════════════════════════════

import { FSRS, FSRS_PARAMS } from './fsrs.js';

const S_MIN = 0.001;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── FSRS core functions (純函數，方便 optimizer 多次呼叫) ───

function power_forgetting_curve(w, t, s) {
  const decay = -w[20];
  const factor = Math.exp(Math.log(0.9) / decay) - 1;
  return Math.pow(t / s * factor + 1, decay);
}

function init_stability(w, rating) {
  return w[rating];
}

function init_difficulty(w, rating) {
  return w[4] - Math.exp(w[5] * rating) + 1;
}

function linear_damping(delta_d, old_d) {
  return (10 - old_d) * delta_d / 9;
}

function next_difficulty(w, difficulty, rating) {
  const delta_d = -w[6] * (rating - 2);
  return difficulty + linear_damping(delta_d, difficulty);
}

function stability_after_success(w, last_s, last_d, r, rating) {
  const HARD = 1, EASY = 3;
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
  const new_s = w[11] *
    Math.pow(last_d, -w[12]) *
    (Math.pow(last_s + 1, w[13]) - 1) *
    Math.exp((1 - r) * w[14]);
  const new_s_min = last_s / Math.exp(w[17] * w[18]);
  return Math.min(new_s, new_s_min);
}

function stability_short_term(w, last_s, rating) {
  const GOOD = 2;
  const sinc = Math.exp(w[17] * (rating - 2 + w[18])) * Math.pow(last_s, -w[19]);
  return last_s * (rating >= GOOD ? Math.max(sinc, 1) : sinc);
}

function step(w, delta_t, rating, state, nth) {
  let last_s = clamp(state.stability, S_MIN, S_MAX);
  let last_d = clamp(state.difficulty, D_MIN, D_MAX);

  const r = power_forgetting_curve(w, delta_t, last_s);
  const s_recall = stability_after_success(w, last_s, last_d, r, rating);
  const s_fail = stability_after_failure(w, last_s, last_d, r);
  const s_short = stability_short_term(w, last_s, rating);

  const AGAIN = 0;
  let new_s = rating === AGAIN ? s_fail : s_recall;
  if (delta_t === 0) new_s = s_short;

  let new_d = next_difficulty(w, last_d, rating);
  const EASY = 3;
  const d0 = init_difficulty(w, EASY);
  new_d = w[7] * (d0 - new_d) + new_d;

  if (nth === 0 && state.stability === 0) {
    const init_r = clamp(rating, 0, 3);
    new_s = init_stability(w, init_r);
    new_d = clamp(init_difficulty(w, init_r), D_MIN, D_MAX);
  }

  return {
    stability: isFinite(new_s) ? clamp(new_s, S_MIN, S_MAX) : S_MIN,
    difficulty: isFinite(new_d) ? clamp(new_d, D_MIN, D_MAX) : D_MIN,
  };
}

// ─── Optimizer ───

/**
 * Adam optimizer state
 */
class Adam {
  constructor(n, lr = 0.01, beta1 = 0.9, beta2 = 0.999, eps = 1e-8) {
    this.lr = lr;
    this.beta1 = beta1;
    this.beta2 = beta2;
    this.eps = eps;
    this.t = 0;
    this.m = new Float64Array(n);
    this.v = new Float64Array(n);
  }

  step(params, grads) {
    this.t++;
    const n = params.length;
    for (let i = 0; i < n; i++) {
      const g = grads[i];
      this.m[i] = this.beta1 * this.m[i] + (1 - this.beta1) * g;
      this.v[i] = this.beta2 * this.v[i] + (1 - this.beta2) * g * g;
      const m_hat = this.m[i] / (1 - Math.pow(this.beta1, this.t));
      const v_hat = this.v[i] / (1 - Math.pow(this.beta2, this.t));
      params[i] -= this.lr * m_hat / (Math.sqrt(v_hat) + this.eps);
    }
  }
}

/**
 * 數值梯度 (finite difference)
 */
function numericalGradient(fn, params, eps = 1e-5) {
  const n = params.length;
  const grads = new Float64Array(n);
  const orig = new Float64Array(params);

  for (let i = 0; i < n; i++) {
    params[i] = orig[i] + eps;
    const loss_plus = fn(params);
    params[i] = orig[i] - eps;
    const loss_minus = fn(params);
    grads[i] = (loss_plus - loss_minus) / (2 * eps);
  }

  // Restore
  for (let i = 0; i < n; i++) params[i] = orig[i];
  return grads;
}

/**
 * 計算 loss：binary cross-entropy
 * 依卡片分組、按時間序模擬 memory state 序列，再算每步的 loss。
 * predicted = 預測保留率 (0~1)，actual = 1 if rating >= 2
 * loss = -[actual * log(pred) + (1-actual) * log(1-pred)]
 */
/**
 * 計算 log-loss。接收「已按卡片分組且排序」的 reviews (Array of Arrays)。
 * 分組與排序在 optimizeWeights 做一次, 避免每次 loss 評估 (含數值梯度 42 次) 重做。
 */
function computeLoss(weights, groupedReviews) {
  const w = weights;

  let totalLoss = 0;
  let count = 0;

  for (const reviews of groupedReviews) {
    let stability = 0;
    let difficulty = 5;
    let nth = 0;

    const n = reviews.length;
    // 對齊 fsrs-rs 6.6.1 (analytic.rs): 只對「最後一筆」計算 loss, 前面用於推演 state。
    // 單筆卡 (只有一次複習) 無法推演, 不計算。
    if (n < 2) continue;

    for (let i = 0; i < n; i++) {
      const entry = reviews[i];
      const { rating, elapsedDays } = entry;
      if (elapsedDays == null || isNaN(elapsedDays)) continue;

      const delta_t = Math.max(0, elapsedDays);

      if (i === n - 1) {
        // 最後一筆: 用推演出的 state 預測 R, 計算 loss
        const predicted = stability === 0 ? 1 : power_forgetting_curve(w, delta_t, stability);
        // label = rating==Again ? 0 : 1 (Hard 也算記住, 對齊 fsrs-rs 6.6.1)
        const actual = rating >= 1 ? 1 : 0;
        const eps = 1e-9;
        const p = clamp(predicted, eps, 1 - eps);
        totalLoss += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
        count++;
        // 最後一筆之後不需再 step (6.6.1 同樣)
        break;
      }

      const state = { stability, difficulty };
      const result = step(w, delta_t, rating, state, nth);
      stability = result.stability;
      difficulty = result.difficulty;
      nth++;
    }
  }

  return count > 0 ? totalLoss / count : 0;
}

/**
 * 主最佳化函數
 * @param {Array} reviewLog - 歷史複習記錄
 * @param {object} options - { epochs, lr, batchSize, progressCallback }
 * @returns {object} { weights, initialLoss, finalLoss, epochs }
 */
export function optimizeWeights(reviewLog, options = {}) {
  const {
    epochs = 50,
    lr = 0.005,
    batchSize = 32,
    progressCallback = null,
  } = options;

  if (!reviewLog || reviewLog.length < 10) {
    throw new Error('需要至少 10 筆複習記錄才能最佳化');
  }

  const cardReviews = new Map();
  for (const entry of reviewLog) {
    const wid = entry.wordId;
    if (!wid) continue;
    if (!cardReviews.has(wid)) cardReviews.set(wid, []);
    cardReviews.get(wid).push(entry);
  }
  for (const reviews of cardReviews.values()) {
    reviews.sort((a, b) => {
      const ta = a.reviewed_at || 0;
      const tb = b.reviewed_at || 0;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  }
  const cardIds = [...cardReviews.keys()];

  // 修復3: 先切分 Train/Test (避免優化器看過測試集 → Data Leakage)
  const shuffledIds = [...cardIds];
  for (let i = shuffledIds.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [shuffledIds[i], shuffledIds[j]] = [shuffledIds[j], shuffledIds[i]];
  }
  const split = Math.floor(shuffledIds.length * 0.8);
  const trainIds = shuffledIds.slice(0, split);
  const testIds = shuffledIds.slice(split);
  const trainGroups = trainIds.map(id => cardReviews.get(id));
  const testGroups = testIds.map(id => cardReviews.get(id));

  const weights = Array.from(FSRS_PARAMS);
  const initialLoss = computeLoss(weights, trainGroups);

  const adam = new Adam(weights.length, lr);

  let bestLoss = initialLoss;
  let bestWeights = Array.from(weights);

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = trainIds.length - 1; i > 0; i--) {
      const j = Math.random() * (i + 1) | 0;
      [trainIds[i], trainIds[j]] = [trainIds[j], trainIds[i]];
    }

    for (let i = 0; i < trainIds.length; i += batchSize) {
      const batchCards = trainIds.slice(i, i + batchSize);
      // 修復1: 傳分組陣列 (不展開), computeLoss 不再重複分組/排序
      const batch = batchCards.map(id => cardReviews.get(id));
      if (batch.length === 0) continue;

      const lossFn = (w) => computeLoss(w, batch);
      const grads = numericalGradient(lossFn, weights);
      adam.step(weights, grads);

      for (let j = 0; j < weights.length; j++) {
        weights[j] = clamp(weights[j], 0.001, 100);
      }
    }

    const currentLoss = computeLoss(weights, trainGroups);

    if (currentLoss < bestLoss) {
      bestLoss = currentLoss;
      bestWeights = Array.from(weights);
    }

    if (progressCallback) {
      progressCallback({
        epoch: epoch + 1,
        totalEpochs: epochs,
        currentLoss,
        bestLoss,
        improvement: ((initialLoss - bestLoss) / initialLoss * 100).toFixed(2) + '%',
      });
    }
  }

  const trainLoss = computeLoss(bestWeights, trainGroups);
  const testLoss = testGroups.length > 0 ? computeLoss(bestWeights, testGroups) : null;

  return {
    weights: bestWeights,
    initialLoss,
    finalLoss: bestLoss,
    trainLoss,
    testLoss,
    epochs,
    reviewCount: reviewLog.length,
  };
}

/**
 * Health check — analyze card deck and review history for issues.
 * @param {Map<string,object>} cards - Card map from store state (any mode)
 * @param {object[]} reviewLog - Review history entries (filtered by mode)
 * @param {object} ankiSettings - Anki settings for the mode
 * @param {object[]} words - All words (for word lookup)
 * @param {object} [ankiSettingsMc]
 * @param {object} [ankiSettingsSpell]
 * @returns {object} Health report
 */
export function healthCheck(cards, reviewLog, ankiSettings, words) {
  let newCount = 0, learnCount = 0, reviewCount = 0, relearnCount = 0;
  let totalStab = 0, stabCount = 0, totalDiff = 0, diffCount = 0;
  const leeches = [];
  const lowStab = [];
  const highDiff = [];

  for (const [wordId, card] of cards) {
    if (card.state === 0) newCount++;
    else if (card.state === 1) learnCount++;
    else if (card.state === 2) reviewCount++;
    else if (card.state === 3) relearnCount++;

    if (card.stability != null && card.stability > 0) {
      totalStab += card.stability;
      stabCount++;
      if (card.stability < 0.5) lowStab.push(wordId);
    }
    if (card.difficulty != null) {
      totalDiff += card.difficulty;
      diffCount++;
      if (card.difficulty > 8) highDiff.push(wordId);
    }
    if (card.lapses >= (ankiSettings?.leechThreshold || 8)) {
      leeches.push({ wordId, lapses: card.lapses });
    }
  }

  const avgStab = stabCount > 0 ? totalStab / stabCount : 0;
  const avgDiff = diffCount > 0 ? totalDiff / diffCount : 0;

  // Compute overall retention
  let correct = 0;
  for (const e of reviewLog) {
    if (e.rating >= 2) correct++;
  }
  const retention = reviewLog.length > 0 ? correct / reviewLog.length : 0;

  // Compute predicted retention of currently due cards
  const now = new Date();
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let predictedCorrect = 0;
  let predictedTotal = 0;
  const fsrs = new FSRS(parseWeights(ankiSettings?.fsrsWeights), ankiSettings?.desiredRetention ?? 0.9, false);
  for (const [wordId, card] of cards) {
    if (card.state !== 2 && card.state !== 3) continue;
    if (!card.due) continue;
    const due = new Date(card.due);
    const dueMidnight = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    if (dueMidnight > nowMidnight) continue;
    predictedTotal++;
    // 修復2: 延遲天數用午夜對齊, 過期 2 小時不算延遲 1 天
    const elapsed = Math.max(0, Math.round((nowMidnight - dueMidnight) / 86400000) + (card.scheduledDays || 0));
    const r = fsrs.forgettingCurve(elapsed, card.stability);
    if (r >= (ankiSettings?.desiredRetention ?? 0.9)) predictedCorrect++;
  }
  const dueRetention = predictedTotal > 0 ? predictedCorrect / predictedTotal : null;

  // Predict workload for next 30 days
  const workload = { daily: new Array(30).fill(0), totalDue: 0 };
  // 修復2: 用前面定義的 nowMidnight (午夜對齊), 避免把「明天凌晨到期」誤判為今天
  for (const [wordId, card] of cards) {
    if (card.state !== 2 && card.state !== 3) continue;
    if (!card.due) continue;
    const due = new Date(card.due);
    const dueMidnight = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    const offset = Math.max(0, Math.round((dueMidnight - nowMidnight) / 86400000));
    if (offset < 30) {
      workload.daily[offset]++;
      workload.totalDue++;
    }
  }
  // Also count learning/new cards as due today
  for (const [wordId, card] of cards) {
    if (card.state === 0 || card.state === 1) {
      workload.daily[0]++;
      workload.totalDue++;
    }
  }

  // Top word references
  const wordMap = new Map(words.map(w => [w.id, w]));
  const topLeeches = leeches.sort((a, b) => b.lapses - a.lapses).slice(0, 8).map(l => ({
    word: wordMap.get(l.wordId)?.word ?? '?',
    lapses: l.lapses,
  }));

  return {
    totalCards: cards.size,
    states: { new: newCount, learning: learnCount, review: reviewCount, relearning: relearnCount },
    avgStability: avgStab,
    avgDifficulty: avgDiff,
    retention,
    dueRetention,
    leeches: leeches.length,
    topLeeches,
    lowStabilityCards: lowStab.length,
    highDifficultyCards: highDiff.length,
    workload,
  };
}

function parseWeights(str) {
  if (!str) return null;
  try {
    const arr = str.split(',').map(Number);
    return arr.length === 21 ? arr : null;
  } catch { return null; }
}
