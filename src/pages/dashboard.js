// ═══════════════════════════════════════════════════════════════
// Dashboard — Hero stats, goal streak, deck grid, retention
// ═══════════════════════════════════════════════════════════════

import { icon } from '../lib/svg.js';
import { computeStreak, countTodayReviews, getToday, toLocalDateStr, computeRetention, getDueCards } from '../core/scheduler.js';
import { barChart, lineChart, pieChart, pieLegend } from '../lib/chart.js';
import { STATE_NEW, STATE_LEARNING, STATE_REVIEW, STATE_RELEARNING } from '../core/fsrs.js';

let _dashboardMode = 'flip'; // 'flip' | 'mc' | 'spell'
let _dashboardRange = '1m'; // '1m' | '3m' | '1y' | 'all' (charts time range)

const RANGE_DAYS = { '1m': 31, '3m': 92, '1y': 365, 'all': null }; // null = 不限

/** Filter reviewLog to the selected time range (by reviewed_at). */
function rangeFilteredLog(reviewLog) {
  const days = RANGE_DAYS[_dashboardRange];
  if (days == null) return reviewLog;
  const cutoff = Date.now() - days * 86400000;
  return reviewLog.filter(e => e && e.reviewed_at && new Date(e.reviewed_at).getTime() >= cutoff);
}

function rangeLabel() {
  return ({ '1m': '最近 1 個月', '3m': '最近 3 個月', '1y': '最近 1 年', 'all': '全部' })[_dashboardRange] || '';
}

function renderRangeTabs() {
  const opts = [
    { key: '1m', label: '1個月' },
    { key: '3m', label: '3個月' },
    { key: '1y', label: '1年' },
    { key: 'all', label: '不限' },
  ];
  return `<div style="display:flex;gap:6px;margin-bottom:var(--s4);flex-wrap:wrap">
    ${opts.map(o => `<button class="chart-range-tab ${_dashboardRange === o.key ? 'active' : ''}" data-dash-range="${o.key}" style="padding:4px 12px;font-size:12px;border-radius:8px;border:1px solid rgba(128,120,153,0.25);background:${_dashboardRange === o.key ? 'var(--accent)' : 'var(--bg-elevated)'};color:${_dashboardRange === o.key ? 'var(--accent-on)' : 'var(--text-secondary)'};cursor:pointer;font-weight:600">${o.label}</button>`).join('')}
  </div>`;
}

export function render(store) {
  const s = store.state;
  const { goalStreak, decks, words, retention, reviewLog } = s;

  const modeLog = reviewLog.filter(e => (e.mode || 'flip') === _dashboardMode);
  const modeCards = _dashboardMode === 'mc' ? s.cardsMc : _dashboardMode === 'spell' ? s.cardsSpell : s.cards;

  const stats = computeCombinedStats(words, modeCards, s);
  const pct = stats.total > 0 ? Math.round((stats.learned / stats.total) * 100) : 0;

  const tzOff = _dashboardMode === 'mc' ? s.ankiSettingsMc?.timezoneOffset
    : _dashboardMode === 'spell' ? s.ankiSettingsSpell?.timezoneOffset
    : s.ankiSettings?.timezoneOffset;
  const todayCount = countTodayReviews(modeLog, s.dayCutoff, tzOff);
  const modeDates = goalStreak.dates[_dashboardMode] || [];
  const streakDays = computeStreak(modeDates, s.dayCutoff, tzOff);
  const dailyGoal = goalStreak.dailyGoal || 20;
  const goalPct = dailyGoal > 0 ? Math.min(100, Math.round((todayCount / dailyGoal) * 100)) : 0;
  const modeRetention = computeRetention(modeLog);
  const retentionPct = modeRetention.total > 0 ? Math.round(modeRetention.rate * 100) : null;
  // C6: 「待複習」單一真值源 — 與 store.refreshDerived 逐字同引數呼喚
  // scheduler.getDueCards（權威可學集），再剔除 new 卡（new ≠ due，Anki 語意，
  // hero 另有獨立「新詞」tile）。hero / statTile / 字本 grid 三處共用此 Set，
  // 原第二套平行實作（renderDeckGrid.isDue 含 buried/suspended/超 cap、不含 learning
  // 邊界）即本 bug 根因，現已單源化 → Σ grid == hero 恆成立。
  const ankiM = _dashboardMode === 'mc' ? s.ankiSettingsMc
    : _dashboardMode === 'spell' ? s.ankiSettingsSpell : s.ankiSettings;
  const buriedM = _dashboardMode === 'mc' ? s.buriedMc
    : _dashboardMode === 'spell' ? s.buriedSpell : s.buried;
  const suspM = _dashboardMode === 'mc' ? s.suspendedMc
    : _dashboardMode === 'spell' ? s.suspendedSpell : s.suspended;
  const ratedM = _dashboardMode === 'mc' ? s.newRatedTodayMc
    : _dashboardMode === 'spell' ? s.newRatedTodaySpell : s.newRatedToday;
  const capM = (_dashboardMode === 'mc' ? s.simParamsMc?.maxReviewsPerDay
    : _dashboardMode === 'spell' ? s.simParamsSpell?.maxReviewsPerDay
    : s.simParams?.maxReviewsPerDay) ?? s.simParams?.maxReviewsPerDay ?? 0;
  // tz fallback 鏈與 store.js:495/501 逐字同構：mode 設定缺 tz 時退回 flip 設定 tz
  const tzM = _dashboardMode === 'flip' ? tzOff : (ankiM?.timezoneOffset ?? s.ankiSettings?.timezoneOffset);
  const dueInfo = getDueCards(words, modeCards, buriedM || new Set(), suspM || new Set(),
    ankiM?.cardsPerDay ?? 80, s.dayCutoff, tzM, ratedM ?? 0, null, capM);
  const reviewDueSet = new Set(dueInfo.due.map(w => w.id));
  // 剔 new：無卡 new ＋ state-0 容器卡（跨 mode 評分/undo 承載路徑 store.js:194/323 會
  // 建立 cards 內 state:0 卡，scheduler 歸 newQueue — 同為 new，not due；審查 R1#3）
  for (const w of dueInfo.due) {
    const c = modeCards.get(w.id);
    if (!c || c.state === STATE_NEW) reviewDueSet.delete(w.id);
  }
  const modeDue = reviewDueSet.size;

  if (stats.total === 0) {
    return renderWelcome(store);
  }

  return `
    <div class="page-title">${icon('home')} 儀表板</div>
    <div class="page-subtitle">今日已複習 ${todayCount} 詞 · 連續 ${streakDays} 天</div>

    <!-- Mode switcher -->
    <div class="study-mode-tabs" style="margin-bottom:var(--s4)">
      <button class="study-mode-tab ${_dashboardMode === 'flip' ? 'active' : ''}" data-dash-mode="flip">${icon('galleryHorizontalEnd')} 翻卡</button>
      <button class="study-mode-tab ${_dashboardMode === 'mc' ? 'active' : ''}" data-dash-mode="mc">${icon('form')} 多選</button>
      <button class="study-mode-tab ${_dashboardMode === 'spell' ? 'active' : ''}" data-dash-mode="spell">${icon('edit')} 拼字</button>
    </div>

    <!-- Hero -->
    <div class="hero">
      <div class="hero-glow"></div>
      <div class="hero-glow-2"></div>
      <div class="hero-content">
        <div class="hero-top">
          <div>
            <div class="hero-pct ${pct >= 100 ? 'done' : ''}">${pct}<span class="unit">%</span></div>
            <div class="hero-label">已學習進度</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px;color:var(--text-tertiary);font-weight:600">保留率</div>
            <div style="font-size:26px;font-weight:800;color:${retentionPct != null && retentionPct >= 85 ? 'var(--green)' : 'var(--text-primary)'};font-feature-settings:'tnum'">
              ${retentionPct != null ? retentionPct + '%' : '-'}
            </div>
            <div style="font-size:11px;color:var(--text-tertiary)">${modeRetention.total} 次複習</div>
          </div>
        </div>
        <div class="hero-stats">
          ${heroStat(stats.total, '總詞數', 'var(--accent)')}
          ${heroStat(stats.learned, '已學習', 'var(--green)')}
          ${heroStat(stats.new, '新詞', 'var(--amber)')}
          ${heroStat(modeDue, '待複習', 'var(--rose)')}
          ${heroStat(stats.mature, 'Mature', 'var(--cyan)')}
          ${heroStat(stats.avgDifficulty ? stats.avgDifficulty.toFixed(1) : '-', '平均難度', 'var(--text-primary)')}
        </div>
        <div class="hero-bar">
          <div class="hero-bar-fill ${pct >= 100 ? 'green' : ''}" style="width:${pct}%"></div>
        </div>
        <div class="hero-footer">${stats.learned}/${stats.total} 詞已學 · 保留率 ${retentionPct != null ? retentionPct + '%' : '-'}</div>
      </div>
    </div>

    <!-- Goal Streak + Today -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('flame')} 今日目標</div>
        <span class="muted" style="font-size:12px">最佳 ${goalStreak.best || 0} 天</span>
      </div>
      <div class="card" style="padding:var(--s6)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s4);gap:var(--s4)">
          <div style="display:flex;align-items:baseline;gap:var(--s2)">
            <span style="font-size:36px;font-weight:800;color:var(--amber);font-feature-settings:'tnum';line-height:1">${streakDays}</span>
            <span style="font-size:14px;color:var(--text-tertiary);font-weight:600">天連續</span>
          </div>
          <div style="text-align:right">
            <div style="font-size:22px;font-weight:800;color:${goalPct >= 100 ? 'var(--green)' : 'var(--text-primary)'};font-feature-settings:'tnum';line-height:1">${todayCount}<span style="font-size:13px;color:var(--text-tertiary);font-weight:600"> / ${dailyGoal}</span></div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">今日已複習</div>
          </div>
        </div>
        <div class="hero-bar"><div class="hero-bar-fill ${goalPct >= 100 ? 'green' : 'amber'}" style="width:${goalPct}%"></div></div>
        <div style="display:flex;justify-content:space-between;margin-top:var(--s2);font-size:11px;color:var(--text-tertiary)">
          <span>${goalPct >= 100 ? '已達成今日目標' : `還差 ${Math.max(0, dailyGoal - todayCount)} 詞`}</span>
          <span>${goalPct}%</span>
        </div>
      </div>
    </div>

    <!-- Deck Grid -->
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('book')} 字本</div>
      </div>
      ${renderDeckGrid(decks, words, modeCards, s, reviewDueSet)}
    </div>

    <!-- Quick stats -->
    <div class="section">
      <div class="section-title" style="margin-bottom:var(--s3)">${icon('chart')} 概覽</div>
      <div class="grid grid-stats">
        ${statTile('database', stats.total, '總詞數', 'var(--accent)', 'var(--accent-container)')}
        ${statTile('check', stats.learned, '已學習', 'var(--green)', 'var(--green-container)')}
        ${statTile('galleryHorizontalEnd', stats.new, '新詞', 'var(--amber)', 'var(--amber-container)')}
        ${statTile('clock', modeDue, '待複習', 'var(--rose)', 'var(--rose-container)')}
        ${statTile('brain', stats.mature, 'Mature', 'var(--cyan)', 'var(--cyan-container)')}
        ${statTile('star', stats.avgDifficulty ? stats.avgDifficulty.toFixed(1) : '-', '平均難度', 'var(--text-secondary)', 'var(--bg-elevated)')}
      </div>
    </div>

    <!-- BETA-B charts: daily volume + retention trend -->
    ${renderChartsBlocks(modeLog, modeCards, words, tzOff, s.dayCutoff)}
  `;
}

function computeCombinedStats(words, cards, s) {
  const tz = _dashboardMode === 'mc' ? s.ankiSettingsMc?.timezoneOffset
    : _dashboardMode === 'spell' ? s.ankiSettingsSpell?.timezoneOffset
    : s.ankiSettings?.timezoneOffset;
  const today = getToday(s.dayCutoff, tz);
  let learned = 0, due = 0, mature = 0, young = 0;
  let diffSum = 0, diffCount = 0;
  let newCount = 0;
  for (const word of words) {
    const card = cards.get(word.id);
    if (!card) { newCount++; continue; }
    learned++;
    if (card.due && card.state !== 0) {
      const dd = toLocalDateStr(new Date(card.due), tz, s.dayCutoff);
      if (dd <= today) due++;
    }
    const ivl = card.scheduledDays ?? card.interval ?? 0;
    if (card.state === STATE_REVIEW && ivl >= 21) mature++;
    else if (card.state >= STATE_LEARNING) young++;
    if (card.difficulty != null) { diffSum += card.difficulty; diffCount++; }
  }
  return {
    total: words.length, learned, new: words.length - learned,
    due, mature, young,
    avgDifficulty: diffCount > 0 ? diffSum / diffCount : 0,
  };
}

// ─── Analytics helpers (BETA-B) ────────────────
const RATING_GOOD_THRESHOLD = 2;

/** Median of a numeric array; null for empty. */
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Bucket the last `days` of review logs by ISO date. */
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function dailyReviewBuckets(reviewLog, days = 14, now = new Date(), timezoneOffset = null, dayCutoff = 0, bucketDays = 1) {
  const buckets = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Bucket boundaries: align so the last bucket ends today.
  for (let i = days - 1; i >= 0; i -= bucketDays) {
    const end = new Date(today);
    end.setDate(end.getDate() - i);
    const start = new Date(end);
    start.setDate(start.getDate() - (bucketDays - 1));
    buckets.push({ date: localDateStr(start), endDate: localDateStr(end), count: 0, correct: 0, sumMs: 0, nMs: 0 });
  }
  const idx = new Map();
  for (let bi = 0; bi < buckets.length; bi++) {
    const b = buckets[bi];
    const cursor = new Date(b.date + 'T00:00:00');
    const stop = new Date(b.endDate + 'T00:00:00');
    while (cursor <= stop) {
      idx.set(localDateStr(cursor), bi);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const e of reviewLog) {
    if (!e || !e.reviewed_at) continue;
    const d = new Date(e.reviewed_at);
    const key = timezoneOffset != null ? toLocalDateStr(d, timezoneOffset, dayCutoff) : localDateStr(d);
    const i = idx.get(key);
    if (i == null) continue;
    const b = buckets[i];
    b.count++;
    if (e.rating >= RATING_GOOD_THRESHOLD) b.correct++;
    if (typeof e.duration === 'number' && e.duration >= 0) { b.sumMs += e.duration; b.nMs++; }
  }
  return buckets;
}

/** Compute a rolling retention rate over each bucket window. */
function retentionTrend(buckets, windowDays = 1) {
  return buckets.map((_, i) => {
    const start = Math.max(0, i - windowDays + 1);
    let total = 0, correct = 0;
    for (let j = start; j <= i; j++) {
      total += buckets[j].count;
      correct += buckets[j].correct;
    }
    return { total, rate: total > 0 ? correct / total : null };
  });
}

function renderChartsBlocks(reviewLog, cards, words, timezoneOffset, dayCutoff) {
  if (!reviewLog || reviewLog.length === 0) {
    return `<div class="section"><div class="section-title">${icon('chart')} 統計圖表</div>
      <div class="empty-state" style="padding:var(--s6)">${icon('chart')}<h3>尚無複習資料</h3><p>開始複習後這裡會顯示完整統計分析</p></div>
    </div>`;
  }
  // Time-range filtering (1m/3m/1y/all), matching Anki's chart period switch.
  const rangeLog = rangeFilteredLog(reviewLog);
  const days = RANGE_DAYS[_dashboardRange] ?? Math.max(1, Math.ceil((Date.now() - Math.min(...rangeLog.map(e => new Date(e.reviewed_at).getTime()))) / 86400000) + 1);
  // Aggregate daily bars when the range is long (1y → weekly buckets, all → monthly).
  const bucketDays = _dashboardRange === '1m' ? 1 : _dashboardRange === '3m' ? 1 : _dashboardRange === '1y' ? 7 : 30;
  const buckets = dailyReviewBuckets(rangeLog, days, new Date(), timezoneOffset, dayCutoff, bucketDays);
  const maxCount = Math.max(1, ...buckets.map(b => b.count));
  const barData = buckets.map(b => {
    const lbl = bucketDays > 1
      ? (b.date.slice(5).replace('-', '/') + (b.endDate !== b.date ? `-${b.endDate.slice(8)}` : ''))
      : b.date.slice(5).replace('-', '/');
    return { label: lbl, value: b.count };
  });
  const trend = retentionTrend(buckets, Math.max(1, Math.round(3 / bucketDays)));
  const trendData = trend.map((t, i) => ({
    label: buckets[i].date.slice(5).replace('-', '/'),
    value: t.rate != null ? Math.round(t.rate * 100) : null,
  }));
  const avgMs = buckets.reduce((a, b) => a + (b.sumMs || 0), 0) / Math.max(1, buckets.reduce((a, b) => a + b.nMs, 0));
  const totalReviews = buckets.reduce((a, b) => a + b.count, 0);

  return `
    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('chart')} 統計圖表</div>
        <span class="muted" style="font-size:12px">${rangeLabel()} · ${totalReviews} 次複習</span>
      </div>
      ${renderRangeTabs()}
      <div class="card" style="padding:var(--s5)">
        <div class="chart-block">
          <div class="chart-title">${icon('clock')} 每日複習量</div>
          ${barChart(barData, { max: maxCount, color: 'var(--accent)', height: 130 })}
        </div>
        <div class="chart-block" style="margin-top:var(--s5)">
          <div class="chart-title">${icon('check')} 正確率趨勢（${bucketDays > 1 ? `${bucketDays} 日` : '3 日'}滑動）</div>
          ${lineChart(trendData, { min: 0, max: 100, color: 'var(--green)', height: 130 })}
        </div>
        ${avgMs > 0 ? `<div style="margin-top:var(--s4);font-size:12px;color:var(--text-tertiary)">平均作答時間：<b style="color:var(--text-primary)">${(avgMs / 1000).toFixed(2)}s</b></div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('plus')} 新增</div>
        <span class="muted" style="font-size:12px">新增卡片數量</span>
      </div>
      <div class="card" style="padding:var(--s5)">
        ${renderAddedChart(words, days, bucketDays)}
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('target')} 回答分析</div>
        <span class="muted" style="font-size:12px">${rangeLog.length} 次回答</span>
      </div>
      <div class="grid grid-2" style="gap:var(--s4)">
        <div class="card" style="padding:var(--s5)">
          <div class="chart-title">${icon('target')} 按鈕使用分布</div>
          ${renderButtonDistChart(rangeLog)}
        </div>
        <div class="card" style="padding:var(--s5)">
          <div class="chart-title">${icon('clock')} 時段分布</div>
          ${renderHourDistChart(rangeLog)}
        </div>
      </div>
      <div class="card" style="padding:var(--s5);margin-top:var(--s4)">
        <div class="chart-title">${icon('chart')} 按狀態的回答按鈕</div>
        <div class="muted" style="font-size:11px;margin-bottom:var(--s4)">依複習當下的卡片狀態分組：學習中／未熟練（間隔&lt;21天）／熟練</div>
        ${renderButtonByStateChart(rangeLog)}
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('check')} 留存比率</div>
        <span class="muted" style="font-size:12px">間隔大於 1 天的卡片通過率</span>
      </div>
      <div class="card" style="padding:var(--s5)">
        ${renderRetentionTable(rangeLog, timezoneOffset, dayCutoff)}
        <div class="muted" style="font-size:11px;margin-top:var(--s3)">未熟練 = 複習間隔 &lt; 21 天；熟練 = ≥ 21 天。時間窗為累計（上一年包含上個月）。通過 = Good 以上。</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('brain')} 卡片狀態分析</div>
        <span class="muted" style="font-size:12px">${cards ? cards.size : 0} 張卡片</span>
      </div>
      <div class="grid grid-2" style="gap:var(--s4)">
        <div class="card" style="padding:var(--s5)">
          <div class="chart-title">${icon('database')} 卡片狀態分布</div>
          ${renderCardCountsChart(cards, words)}
        </div>
        <div class="card" style="padding:var(--s5)">
          <div class="chart-title">${icon('galleryHorizontalEnd')} 難度分布</div>
          ${renderDifficultyDistChart(cards)}
        </div>
      </div>
      <div class="grid grid-2" style="gap:var(--s4);margin-top:var(--s4)">
        <div class="card" style="padding:var(--s5)">
          <div class="chart-title">${icon('calendar')} 間隔分布</div>
          ${renderIntervalDistChart(cards)}
        </div>
        <div class="card" style="padding:var(--s5)">
          <div class="chart-title">${icon('layers')} 穩定性分布</div>
          ${renderStabilityDistChart(cards)}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-title">${icon('trendingUp')} 預測與趨勢</div>
      </div>
      <div class="card" style="padding:var(--s5)">
        <div class="chart-title">${icon('calendar')} 未來 30 天到期預測</div>
        ${renderFutureDueChart(cards, timezoneOffset, dayCutoff)}
      </div>
      <div class="card" style="padding:var(--s5);margin-top:var(--s4)">
        <div class="chart-title">${icon('flame')} 學習日曆（最近 ${_dashboardRange === 'all' ? '52' : RANGE_DAYS[_dashboardRange] / 7 | 0} 週）</div>
        ${renderCalendarHeatmap(rangeLog, timezoneOffset, dayCutoff, _dashboardRange === 'all' ? 52 : Math.max(6, Math.round((RANGE_DAYS[_dashboardRange] ?? 365) / 7)))}
      </div>
      <div class="card" style="padding:var(--s5);margin-top:var(--s4)">
          <div class="chart-title">${icon('trendingDn')} 遺忘曲線（FSRS）</div>
        ${renderForgettingCurveChart(cards)}
      </div>
    </div>
  `;
}

function buttonDist(reviewLog) {
  const counts = [0, 0, 0, 0];
  for (const e of reviewLog) {
    if (e && e.rating >= 0 && e.rating <= 3) counts[e.rating]++;
  }
  return counts;
}

function renderButtonDistChart(reviewLog) {
  const counts = buttonDist(reviewLog);
  const labels = ['Again', 'Hard', 'Good', 'Easy'];
  const colors = ['var(--red)', 'var(--orange)', 'var(--green)', 'var(--cyan)'];
  const data = labels.map((l, i) => ({ label: l, value: counts[i] }));
  return barChart(data, { max: Math.max(1, ...counts), color: '#b69dff', height: 110 });
}

// 按複習當下的卡片狀態分組的按鈕分布（Anki-style Answer Buttons）。
// 用 review log 自帶的 state/ivl，不用「當前 reps」去分類歷史 review
// （那會把同一張卡過去的所有 review 全塞進現在的 reps 桶，完全失真）。
function buttonDistByState(reviewLog) {
  const groups = {
    learning: [0, 0, 0, 0], // NEW / LEARNING / RELEARNING
    young: [0, 0, 0, 0],    // REVIEW, ivl < 21
    mature: [0, 0, 0, 0],   // REVIEW, ivl >= 21
  };
  for (const e of reviewLog) {
    if (!e || e.rating < 0 || e.rating > 3) continue;
    const ivl = e.ivl ?? e.scheduledDays ?? 0;
    if (e.state === STATE_REVIEW) {
      groups[ivl >= 21 ? 'mature' : 'young'][e.rating]++;
    } else {
      groups.learning[e.rating]++;
    }
  }
  return groups;
}

// ─── Retention table (Anki-style) ──────────────
// 間隔 > 1 天的複習，依複習當下的卡片狀態（未熟練/熟練）分組，
// 統計累計時間窗（今天/昨天/上週/上個月/上一年）的通過率（rating >= Good）。
function retentionTableData(reviewLog, timezoneOffset, dayCutoff) {
  const today = getToday(dayCutoff, timezoneOffset);
  const daysAgoStr = n => {
    const p = today.split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const windows = [
    { key: 'today', label: '今天', from: daysAgoStr(0) },
    { key: 'yesterday', label: '昨天', from: daysAgoStr(1) },
    { key: 'week', label: '上週', from: daysAgoStr(7) },
    { key: 'month', label: '上個月', from: daysAgoStr(30) },
    { key: 'year', label: '上一年', from: daysAgoStr(365) },
  ];
  const rows = windows.map(w => ({ ...w, young: { total: 0, correct: 0 }, mature: { total: 0, correct: 0 } }));
  for (const e of reviewLog) {
    if (!e || e.rating < 0 || e.rating > 3) continue;
    const ivl = e.ivl ?? e.scheduledDays ?? 0;
    if (ivl <= 1) continue; // 間隔 > 1 天
    const date = toLocalDateStr(new Date(e.reviewed_at), timezoneOffset, dayCutoff);
    for (const r of rows) {
      if (date >= r.from) {
        const bucket = ivl >= 21 ? r.mature : r.young;
        bucket.total++;
        if (e.rating >= RATING_GOOD_THRESHOLD) bucket.correct++;
      }
    }
  }
  return rows;
}

function pctCell(bucket) {
  if (bucket.total === 0) return '<td class="muted" style="text-align:center">無</td>';
  const pct = Math.round((bucket.correct / bucket.total) * 100);
  const color = pct >= 85 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';
  return `<td style="text-align:center;font-weight:600;color:${color}">${pct}%</td>`;
}

function renderRetentionTable(reviewLog, timezoneOffset, dayCutoff) {
  const rows = retentionTableData(reviewLog, timezoneOffset, dayCutoff);
  const body = rows.map(r => {
    const all = { total: r.young.total + r.mature.total, correct: r.young.correct + r.mature.correct };
    return `<tr>
      <td style="padding:6px 10px;color:var(--text-secondary)">${r.label}</td>
      ${pctCell(r.young)}
      ${pctCell(r.mature)}
      ${pctCell(all)}
      <td style="padding:6px 10px;text-align:center;color:var(--text-tertiary)">${all.total}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:1px solid rgba(128,120,153,0.2)">
      <th style="padding:6px 10px;text-align:left;color:var(--text-tertiary);font-weight:600">時間窗</th>
      <th style="padding:6px 10px;text-align:center;color:var(--text-tertiary);font-weight:600">未熟練</th>
      <th style="padding:6px 10px;text-align:center;color:var(--text-tertiary);font-weight:600">熟練</th>
      <th style="padding:6px 10px;text-align:center;color:var(--text-tertiary);font-weight:600">總計</th>
      <th style="padding:6px 10px;text-align:center;color:var(--text-tertiary);font-weight:600">計數</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

// ─── Added cards (Anki-style "新增") ───────────
// 依 words.createdAt 統計每天新增的單字數（最近 N 天）。
function addedBuckets(words, days = 14, now = new Date(), bucketDays = 1) {
  const buckets = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = days - 1; i >= 0; i -= bucketDays) {
    const end = new Date(today);
    end.setDate(end.getDate() - i);
    const start = new Date(end);
    start.setDate(start.getDate() - (bucketDays - 1));
    buckets.push({ date: localDateStr(start), endDate: localDateStr(end), count: 0 });
  }
  const idx = new Map();
  for (let bi = 0; bi < buckets.length; bi++) {
    const b = buckets[bi];
    const cursor = new Date(b.date + 'T00:00:00');
    const stop = new Date(b.endDate + 'T00:00:00');
    while (cursor <= stop) {
      idx.set(localDateStr(cursor), bi);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const w of words || []) {
    if (!w || !w.createdAt) continue;
    const key = localDateStr(new Date(w.createdAt));
    const i = idx.get(key);
    if (i != null) buckets[i].count++;
  }
  return buckets;
}

function renderAddedChart(words, days = 14, bucketDays = 1) {
  const buckets = addedBuckets(words, days, new Date(), bucketDays);
  const maxCount = Math.max(1, ...buckets.map(b => b.count));
  const data = buckets.map(b => ({
    label: b.date.slice(5).replace('-', '/'),
    value: b.count,
  }));
  const total = buckets.reduce((a, b) => a + b.count, 0);
  return `
    <div class="chart-block">
      <div class="chart-title">${icon('plus')} 新增卡片（${rangeLabel()}）</div>
      ${barChart(data, { max: maxCount, color: '#34d399', height: 130 })}
      <div class="muted" style="font-size:11px;margin-top:var(--s2)">共 ${total} 個單字</div>
    </div>`;
}

function renderButtonByStateChart(reviewLog) {
  const g = buttonDistByState(reviewLog);
  const labels = ['學習中', '未熟練', '熟練'];
  const keys = ['learning', 'young', 'mature'];
  const colors = ['var(--red)', 'var(--orange)', 'var(--green)', 'var(--cyan)'];
  const totals = keys.map(k => g[k][0] + g[k][1] + g[k][2] + g[k][3]);
  if (totals.every(t => t === 0)) return '<div class="muted" style="font-size:12px">尚無資料</div>';
  const max = Math.max(1, ...totals);
  const groupW = 120, barW = 18, gap = 4, h = 110;
  const svgs = keys.map((k, gi) => {
    const bars = colors.map((c, bi) => {
      const v = g[k][bi];
      const bh = Math.max(v > 0 ? (v / max) * h : 0, 0);
      const x = gi === 0 ? 0 : 0;
      return `<rect x="${(x + bi * (barW + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" rx="2" fill="${c}" opacity="${v > 0 ? 0.9 : 0.15}"><title>${labels[gi]} ${['Again','Hard','Good','Easy'][bi]}: ${v}</title></rect>`;
    }).join('');
    const total = totals[gi];
    return `<div style="flex:1;min-width:120px;text-align:center">
      <svg viewBox="0 0 ${barW * 4 + gap * 3} ${h}" style="width:100%;height:auto;max-height:${h}px;display:block">
        ${bars}
      </svg>
      <div style="font-size:11px;color:var(--text-primary);font-weight:600;margin-top:4px">${labels[gi]}</div>
      <div style="font-size:10px;color:var(--text-tertiary)">${total} 次</div>
    </div>`;
  }).join('');
  return `
    <div style="margin-top:var(--s2)">
      <div style="display:flex;gap:var(--s3);flex-wrap:wrap">${svgs}</div>
      <div style="display:flex;gap:var(--s4);font-size:11px;color:var(--text-tertiary);margin-top:var(--s3);flex-wrap:wrap">
        <span><span style="color:var(--red)">■</span> Again</span>
        <span><span style="color:var(--orange)">■</span> Hard</span>
        <span><span style="color:var(--green)">■</span> Good</span>
        <span><span style="color:var(--cyan)">■</span> Easy</span>
      </div>
    </div>`;
}

function hourDist(reviewLog) {
  const counts = new Array(24).fill(0);
  const correct = new Array(24).fill(0);
  for (const e of reviewLog) {
    if (e && e.reviewed_at && e.rating >= 0 && e.rating <= 3) {
      const h = new Date(e.reviewed_at).getHours();
      counts[h]++;
      if (e.rating >= RATING_GOOD_THRESHOLD) correct[h]++;
    }
  }
  return { counts, correct };
}

function renderHourDistChart(reviewLog) {
  const { counts, correct } = hourDist(reviewLog);
  const barData = counts.map((v, i) => ({ label: i % 3 === 0 ? `${i}` : '', value: v }));
  // Anki-style success-rate line overlay (right axis 0-100%).
  const lineData = counts.map((v, i) => ({
    label: i % 3 === 0 ? `${i}` : '',
    value: v > 0 ? Math.round((correct[i] / v) * 100) : null,
  }));
  return `
    <div style="position:relative">
      ${barChart(barData, { max: Math.max(1, ...counts), color: '#fbbf24', height: 110 })}
      <div style="position:absolute;top:0;left:0;right:0;pointer-events:none">
        ${lineChart(lineData, { min: 0, max: 100, color: 'var(--green)', height: 110 })}
      </div>
    </div>
    <div style="display:flex;gap:var(--s4);font-size:11px;color:var(--text-tertiary);margin-top:var(--s1)">
      <span><span style="color:#fbbf24">■</span> 複習次數</span>
      <span><span style="color:var(--green)">-</span> 成功率（Good 以上，無資料不顯示）</span>
    </div>`;
}

function intervalDist(cards) {
  const buckets = { '1d': 0, '2-3d': 0, '4-7d': 0, '1-2w': 0, '2-4w': 0, '1-3m': 0, '3m+': 0 };
  const vals = [];
  if (!cards) return { buckets, median: null };
  for (const [, c] of cards) {
    const ivl = c.scheduledDays ?? c.interval ?? 0;
    if (ivl <= 0) continue;
    vals.push(ivl);
    if (ivl <= 1) buckets['1d']++;
    else if (ivl <= 3) buckets['2-3d']++;
    else if (ivl <= 7) buckets['4-7d']++;
    else if (ivl <= 14) buckets['1-2w']++;
    else if (ivl <= 30) buckets['2-4w']++;
    else if (ivl <= 90) buckets['1-3m']++;
    else buckets['3m+']++;
  }
  return { buckets, median: median(vals) };
}

function renderIntervalDistChart(cards) {
  const { buckets, median: med } = intervalDist(cards);
  const data = Object.entries(buckets).map(([k, v]) => ({ label: k, value: v }));
  const medLine = med != null ? `<div class="muted" style="font-size:11px;margin-top:var(--s2)">間隔中位數：<b style="color:var(--text-primary)">${med} 天</b></div>` : '';
  return barChart(data, { color: '#a78bfa', height: 110 }) + medLine;
}

function difficultyDist(cards) {
  const buckets = new Array(10).fill(0);
  const vals = [];
  if (!cards) return { buckets, median: null };
  for (const [, c] of cards) {
    const d = c.difficulty ?? 0;
    if (d >= 1 && d <= 10) { buckets[Math.round(d) - 1]++; vals.push(d); }
  }
  return { buckets, median: median(vals) };
}

function renderDifficultyDistChart(cards) {
  const { buckets, median: med } = difficultyDist(cards);
  const data = buckets.map((v, i) => ({ label: `${i + 1}`, value: v }));
  const medLine = med != null ? `<div class="muted" style="font-size:11px;margin-top:var(--s2)">難度中位數：<b style="color:var(--text-primary)">${med.toFixed(1)}</b>（1-10）</div>` : '';
  return barChart(data, { color: '#f87171', height: 110 }) + medLine;
}

function stabilityDist(cards) {
  const labels = ['<1d', '1-3d', '3-7d', '1-2w', '2w-1m', '1-3m', '3m+'];
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  const vals = [];
  if (!cards) return { labels, buckets, median: null };
  for (const [, c] of cards) {
    const s = c.stability ?? 0;
    if (s <= 0) continue;
    vals.push(s);
    if (s < 1) buckets[0]++;
    else if (s < 3) buckets[1]++;
    else if (s < 7) buckets[2]++;
    else if (s < 14) buckets[3]++;
    else if (s < 30) buckets[4]++;
    else if (s < 90) buckets[5]++;
    else buckets[6]++;
  }
  return { labels, buckets, median: median(vals) };
}

function renderStabilityDistChart(cards) {
  const { labels, buckets, median: med } = stabilityDist(cards);
  const data = labels.map((l, i) => ({ label: l, value: buckets[i] }));
  const medLine = med != null ? `<div class="muted" style="font-size:11px;margin-top:var(--s2)">穩固期中位數：<b style="color:var(--text-primary)">${med < 1 ? Math.round(med * 24) + ' 小時' : med.toFixed(1) + ' 天'}</b></div>` : '';
  return barChart(data, { color: '#38bdf8', height: 110 }) + medLine;
}

function futureDue(cards, days = 30, timezoneOffset = null, dayCutoff = 0) {
  const today = getToday(dayCutoff, timezoneOffset);
  const result = new Array(days).fill(0);
  if (!cards) return result;
  for (const [, c] of cards) {
    if (!c.due) continue;
    const dueDate = new Date(c.due);
    const dueStr = timezoneOffset != null ? toLocalDateStr(dueDate, timezoneOffset, dayCutoff) : localDateStr(dueDate);
    if (dueStr < today) continue;
    const diff = Math.floor((dueDate - Date.now()) / 86400000);
    if (diff >= 0 && diff < days) result[diff]++;
  }
  return result;
}

function renderFutureDueChart(cards, timezoneOffset, dayCutoff) {
  const data = futureDue(cards, 30, timezoneOffset, dayCutoff);
  const chartData = data.map((v, i) => ({ label: i % 5 === 0 ? `D${i}` : '', value: v }));
  return barChart(chartData, { color: '#fb923c', height: 120 });
}

function cardStateCounts(cards) {
  // Anki card_counts 邏輯: New/Learn/Young/Mature/Relearn
  const counts = { new: 0, learning: 0, young: 0, mature: 0, relearning: 0 };
  if (!cards) return counts;
  for (const [, c] of cards) {
    if (c.state === STATE_NEW) counts.new++;
    else if (c.state === STATE_LEARNING) counts.learning++;
    else if (c.state === STATE_REVIEW) {
      const ivl = c.scheduledDays ?? c.interval ?? 0;
      if (ivl < 21) counts.young++;
      else counts.mature++;
    }
    else if (c.state === STATE_RELEARNING) counts.relearning++;
  }
  return counts;
}

function renderCardCountsChart(cards, words) {
  const counts = cardStateCounts(cards);
  const totalWords = cards ? cards.size : 0;
  const unlearned = Math.max(0, (words ? words.length : 0) - totalWords);
  const data = [
    { label: '新', value: unlearned, color: '#fbbf24' },
    { label: '學習中', value: counts.learning, color: 'var(--orange)' },
    { label: '年輕', value: counts.young, color: 'var(--cyan)' },
    { label: '成熟', value: counts.mature, color: 'var(--green)' },
    { label: '重學', value: counts.relearning, color: 'var(--red)' },
  ];
  return `<div>${pieChart(data, { width: 200, height: 200, noLegend: true })}<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:4px">${pieLegend(data)}</div></div>`;
}

function calendarData(reviewLog, weeks = 12, timezoneOffset = null, dayCutoff = 0) {
  const today = new Date();
  // Align the window to the week containing today: start on Monday of
  // `weeks` weeks ago (GitHub-style contribution graph). Without this,
  // (weeks*7 - 1) % 7 != 0 shifts every row by a non-integer week and
  // the weekday labels (一/三/五) no longer match the actual columns.
  const dow = (today.getDay() + 6) % 7; // 0=Mon .. 6=Sun
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - dow - (weeks - 1) * 7);
  const map = new Map();
  for (const e of reviewLog) {
    if (!e || !e.reviewed_at) continue;
    const key = timezoneOffset != null
      ? toLocalDateStr(new Date(e.reviewed_at), timezoneOffset, dayCutoff)
      : localDateStr(new Date(e.reviewed_at));
    map.set(key, (map.get(key) || 0) + 1);
  }
  const cells = [];
  const cursor = new Date(startDate);
  while (cursor <= today) {
    const key = localDateStr(cursor);
    cells.push({ date: key, count: map.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

function renderCalendarHeatmap(reviewLog, timezoneOffset, dayCutoff, weeks = 12) {
  const cells = calendarData(reviewLog, weeks, timezoneOffset, dayCutoff);
  const maxCount = Math.max(1, ...cells.map(c => c.count));
  const cellSize = 14;
  const gap = 2;
  const numWeeks = Math.ceil(cells.length / 7);
  const width = numWeeks * (cellSize + gap) + 30;
  const height = 7 * (cellSize + gap) + 20;

  const rects = cells.map((c, i) => {
    const week = Math.floor(i / 7);
    const day = i % 7;
    const x = 24 + week * (cellSize + gap);
    const y = day * (cellSize + gap);
    const intensity = c.count > 0 ? 0.2 + (c.count / maxCount) * 0.8 : 0.05;
    const color = c.count > 0 ? `rgba(167,139,250,${intensity})` : 'rgba(128,120,153,0.08)';
    return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${color}"><title>${c.date}: ${c.count} 次</title></rect>`;
  }).join('');

  const dayLabels = ['一', '三', '五'].map((l, idx) => {
    const day = idx * 2;
    const y = day * (cellSize + gap) + cellSize / 2;
    return `<text x="18" y="${y + 3}" text-anchor="end" font-size="8" fill="rgba(128,120,153,0.6)">${l}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:${height}px;display:block">
    ${dayLabels}
    ${rects}
  </svg>`;
}

function forgettingCurve(cards) {
  const points = [];
  for (let t = 0; t <= 30; t += 0.5) {
    let sumR = 0, n = 0;
    if (cards) {
      for (const [, c] of cards) {
        const s = c.stability ?? 0;
        if (s <= 0) continue;
        const decay = -0.1542;
        const factor = Math.exp(Math.log(0.9) / decay) - 1;
        const r = Math.pow(t / s * factor + 1, decay);
        sumR += r;
        n++;
      }
    }
    points.push({ t, r: n > 0 ? sumR / n : 0 });
  }
  return points;
}

function renderForgettingCurveChart(cards) {
  const points = forgettingCurve(cards);
  const data = points.filter((_, i) => i % 2 === 0).map(p => ({
    label: Number.isInteger(p.t) ? `${p.t}d` : '',
    value: Math.round(p.r * 100),
  }));
  return lineChart(data, { min: 0, max: 100, color: '#f87171', height: 120 });
}

function heroStat(val, lbl, color) {
  return `<div class="hero-stat">
    <div class="hero-stat-val" style="color:${color}">${val}</div>
    <div class="hero-stat-lbl">${lbl}</div>
  </div>`;
}

function renderWelcome(store) {
  return `
    <div class="page-title">${icon('home')} 儀表板</div>
    <div class="page-subtitle">歡迎使用 Teno，開始你的間隔重複學習</div>
    <div class="hero" style="text-align:center">
      <div class="hero-glow"></div>
      <div class="hero-content">
        <div style="font-size:40px;margin-bottom:var(--s4)">${icon('book')}</div>
        <h2 style="font-size:22px;font-weight:800;color:var(--text-primary);margin-bottom:var(--s2)">字庫是空的</h2>
        <p style="font-size:14px;color:var(--text-tertiary);max-width:420px;margin:0 auto var(--s6)">
          匯入 CSV 單字表，或手動新增單字，即可開始間隔重複複習。
        </p>
        <div style="display:flex;gap:var(--s3);justify-content:center;flex-wrap:wrap">
          <button class="btn-primary" data-goto="settings">${icon('upload')} 匯入 CSV</button>
          <button class="btn" data-goto="browser">${icon('plus')} 新增單字</button>
          <button class="btn" data-goto="settings">${icon('settings')} 設定字本</button>
        </div>
      </div>
    </div>
  `;
}

function statTile(ic, val, lbl, color, bg) {
  return `<div class="stat-tile">
    <div class="stat-tile-top">
      <span class="stat-tile-val">${val}</span>
      <span class="stat-tile-ic" style="color:${color};background:${bg}">${icon(ic)}</span>
    </div>
    <div class="stat-tile-lbl">${lbl}</div>
  </div>`;
}

function renderDeckGrid(decks, words, cards, s, dueSet) {
  if (decks.length === 0) {
    return `<div class="empty-state">
      ${icon('box')}
      <h3>尚無字本</h3>
      <p>在設定中新增字本或匯入 CSV</p>
      <button class="btn-primary btn-sm" data-goto="settings">${icon('plus')} 前往設定</button>
    </div>`;
  }

  function hasCard(wordId) {
    return cards.has(wordId);
  }

  // C6: 待複習＝hero/statTile 同一 Set（getDueCards 權威可學集剔 new）—
  // 原平行實作（self-compute due<=today、含 buried/suspended/超 cap、含 new 歧異）已廢除
  function isDue(wordId) {
    return dueSet ? dueSet.has(wordId) : false;
  }

  return `<div class="grid">
    ${decks.map(d => {
      const deckWords = words.filter(w => w.deck === d.name);
      const total = deckWords.length;
      const learned = deckWords.filter(w => hasCard(w.id)).length;
      const due = deckWords.filter(w => isDue(w.id)).length;
      const pct = total > 0 ? Math.round((learned / total) * 100) : 0;
      return `
        <div class="deck-card" data-deck="${d.name}">
          <div class="deck-card-accent" style="background:${d.color}"></div>
          <div class="deck-card-header">
            <div class="deck-card-name">${d.name}</div>
            <div class="deck-card-header-right">
              <div class="deck-card-count">${total} 詞</div>
              ${due > 0 ? `<div class="deck-card-badge">${due} 待複習</div>` : ''}
            </div>
          </div>
          <div class="deck-card-meta">
            <div class="deck-card-meta-item">
              <div class="deck-card-meta-val">${learned}</div>
              <div class="deck-card-meta-lbl">已學</div>
            </div>
            <div class="deck-card-meta-item">
              <div class="deck-card-meta-val" style="color:var(--rose)">${due}</div>
              <div class="deck-card-meta-lbl">待複習</div>
            </div>
            <div class="deck-card-meta-item">
              <div class="deck-card-meta-val">${total - learned}</div>
              <div class="deck-card-meta-lbl">新</div>
            </div>
          </div>
          <div class="deck-card-bar">
            <div class="deck-card-bar-fill" style="width:${pct}%;background:${d.color}"></div>
          </div>
        </div>
      `;
    }).join('')}
  </div>`;
}

export function onMount(store) {
  document.querySelectorAll('.deck-card[data-deck]').forEach(el => {
    el.addEventListener('click', () => {
      store.state.browserDeckFilter = el.dataset.deck;
      store.state.browserDeckLock = true;
      store.actions.navigate('deck-browser');
    });
  });
  document.querySelectorAll('[data-goto]').forEach(el => {
    el.addEventListener('click', () => store.actions.navigate(el.dataset.goto));
  });
  document.querySelectorAll('[data-dash-mode]').forEach(el => {
    el.addEventListener('click', () => {
      _dashboardMode = el.dataset.dashMode;
      const c = document.getElementById('pageContainer');
      if (c) { c.innerHTML = render(store); onMount(store); }
    });
  });
  document.querySelectorAll('[data-dash-range]').forEach(el => {
    el.addEventListener('click', () => {
      _dashboardRange = el.dataset.dashRange;
      const c = document.getElementById('pageContainer');
      if (c) { c.innerHTML = render(store); onMount(store); }
    });
  });
}
