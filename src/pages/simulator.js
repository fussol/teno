// ═══════════════════════════════════════════════════════════════
// 學習分析 — 基於 app DB (state.cards / reviewLog) 顯示成熟度、複習統計、診斷
// ═══════════════════════════════════════════════════════════════
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { runCli, getAppPaths, simulateFsrs } from '../lib/api.js';
import { barChart, lineChart, pieChart, pieLegend } from '../lib/chart.js';
import { initCustomSelects } from '../lib/custom-select.js';   // G14 同族：renderInPlace 重渲染後重建 custom-select 轉換

let _cliOutput = null;
let _reportData = null;
let _simResults = [];       // 模擬歷史（多筆，Anki 可累加；G8：存活視窗，上限 SIM_HISTORY_MAX）
let _simSelectedIndex = null; // 查看歷史第 N 筆（null = 最新）
let _simSubgraph = 'reviews'; // reviews | cost | memorized
let _workloadResult = null;
let _optimalRetention = null;
let _simLogsDir = '';   // dynamic sim-logs dir (from Rust get_app_paths)
let _simMode = 'flip';  // flip | mc | spell — 學習分析/模擬用的學習模式資料
let _simRunGen = 0;     // G26：模式世代計數器——切模式 ++；async 回調比對世代
                        // （計數器而非值比對：封 A→B→A 切回原值的值相等盲區）
let _simParamsInitialized = false;

// G8：歷史存活上限（砍全詞表快照後每筆＝daily 序列，20 筆最壞 MB 級以下）
const SIM_HISTORY_MAX = 20;

/** 模擬條目統一入列（成功/錯誤雙軌）：超上限丟最舊，選態索引跟隨。
 *  選態語意：null 保持；選中恰被擠出（===0）→ null（回顯示最新）；>0 → 減 1。
 *  註：成功路徑後續立即 _simSelectedIndex = null（顯示最新為既有語意），
 *  本調整保障的是錯誤條目擠出路徑與未來呼叫端。 */
function pushSimEntry(entry) {
  _simResults.push(entry);
  while (_simResults.length > SIM_HISTORY_MAX) {
    _simResults.shift();
    if (_simSelectedIndex === 0) _simSelectedIndex = null;
    else if (_simSelectedIndex > 0) _simSelectedIndex -= 1;
  }
}

// 模擬器參數（對齊 Anki SimulateFsrsReviewRequest；render 時從 DOM 讀寫）
let _simParams = {
  days: 365, dr: 0.9, newLimit: 80, reviewLimit: 1000, maxInterval: 365,
  reviewOrder: 'day', newCardsIgnoreReviewLimit: true, suspendLeeches: false,
  leechThreshold: 8, smooth: true, seed: 1,
  easyDays: [1, 1, 1, 1, 1, 1, 1],  // 週一~週日 0=Minimum 0.5=Reduced 1=Normal（對齊 Anki EasyDay）
};

const MODE_LABELS = { flip: '翻卡', mc: '多選', spell: '拼字' };

/** 依目前學習模式取對應資料（卡 Map / reviewLog / anki 設定）。 */
function modeData(s) {
  const st = s.state;
  const cardMap = _simMode === 'mc' ? st.cardsMc : _simMode === 'spell' ? st.cardsSpell : st.cards;
  const ankiCfg = _simMode === 'mc' ? st.ankiSettingsMc : _simMode === 'spell' ? st.ankiSettingsSpell : st.ankiSettings;
  const words = st.words.filter(w => cardMap.has(w.id));
  const reviewLog = st.reviewLog.filter(e => (e.mode || 'flip') === _simMode);
  return { words, cards: cardMap, reviewLog, ankiCfg, label: MODE_LABELS[_simMode] };
}

// 官方 fsrs-rs 6.6.1 預設 21 權重（ankiCfg.fsrsWeights 為 null 時用）
const FSRS6_DEFAULT_WEIGHTS = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];

/** 從 DOM 讀模擬參數（render 後呼叫）。 */
function readSimParams() {
  const $ = (id) => document.getElementById(id);
  const num = (id, dft) => { const v = parseInt($(id)?.value); return Number.isFinite(v) ? v : dft; };
  _simParams = {
    days: num('simDays', 365),
    dr: Math.max(0.7, Math.min(0.99, (num('simDr', 90)) / 100)),
    newLimit: num('simNewLimit', 80),
    reviewLimit: num('simReviewLimit', 1000),
    maxInterval: num('simMaxIvl', 365),
    reviewOrder: $('simReviewOrder')?.value || 'day',
    newCardsIgnoreReviewLimit: $('simIgnoreLimit')?.checked ?? true,
    suspendLeeches: $('simSuspend')?.checked ?? false,
    leechThreshold: num('simLeechThreshold', 8),
    smooth: $('simSmooth')?.checked ?? true,
    seed: num('simSeed', 1),
    easyDays: Array.from({ length: 7 }, (_, i) => {
      const v = parseFloat($('simEasyDay' + i)?.value);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    }),
  };
  return _simParams;
}

/** 組官方模擬器 request（對齊 Anki simulate_request_to_config：existing 卡 + 新詞補 state=0）。 */
function buildSimRequest(s, mode, opts = {}) {
  const st = s.state;
  const { cards, reviewLog, ankiCfg } = modeData(s);
  const p = readSimParams();
  // 該模式詞集合：flip=全詞表；mc/spell=有卡或有複習記錄的詞
  let wordIds;
  if (_simMode === 'flip') {
    wordIds = st.words.map(w => w.id);
  } else {
    wordIds = [...new Set([...cards.keys(), ...reviewLog.map(e => e.wordId)])];
  }
  const cardEntries = wordIds.map(id => {
    const c = cards.get(id);
    if (c && c.state > 0) {
      return {
        stability: c.stability ?? 0, difficulty: c.difficulty ?? 5,
        interval: c.scheduledDays ?? c.interval ?? 0, lapses: c.lapses ?? 0,
        state: c.state, dueMs: c.due ? new Date(c.due).getTime() : null,
      };
    }
    // 新詞（尚無卡）→ state=0 新卡
    return { stability: 0, difficulty: 5, interval: 0, lapses: 0, state: 0, dueMs: null };
  });
  const reviewEntries = reviewLog.map(e => ({
    wordId: e.wordId, rating: e.rating ?? 0,
    durationMs: e.duration ?? 0, cardState: e.state ?? 0,
    reviewedAtMs: new Date(e.reviewed_at).getTime(),
  }));
  let params = null;
  if (ankiCfg.fsrsWeights) {
    try {
      const w = String(ankiCfg.fsrsWeights).replace(/^\[|\]$/g, '').trim();
      params = w ? JSON.parse('[' + w + ']') : null;
    } catch { params = null; }
  }
  return {
    cards: cardEntries,
    reviews: reviewEntries,
    params: params || FSRS6_DEFAULT_WEIGHTS,
    desiredRetention: p.dr,
    maxInterval: p.maxInterval,
    learnLimit: p.newLimit,
    reviewLimit: p.reviewLimit,
    days: opts.days ?? p.days,
    seed: opts.seed ?? p.seed,
    mode,
    fromZero: opts.fromZero ?? false,
    reviewOrder: p.reviewOrder,
    newCardsIgnoreReviewLimit: p.newCardsIgnoreReviewLimit,
    suspendAfterLapseCount: p.suspendLeeches ? p.leechThreshold : null,
    easyDaysPercentages: p.easyDays,
    timezoneOffsetMinutes: ankiCfg.timezoneOffset ?? 480,
    dayCutoffMinutes: st.dayCutoff ?? 0,
  };
}

function computeAnalysis(s) {
  const { cards, words, reviewLog } = modeData(s);
  const total = words.length;
  const cardArr = [...cards.values()];
  const learned = cardArr.filter(c => c.state > 0).length;
  const mature = cardArr.filter(c => c.state === 2 && (c.scheduledDays ?? c.interval ?? 0) >= 21).length;
  const young = cardArr.filter(c => c.state >= 1 && c.state !== 2).length;
  const due = cardArr.filter(c => c.due && new Date(c.due) <= new Date()).length;
  const maturePct = total ? Math.round(mature / total * 100) : 0;

  // 評分分布
  const rating = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const e of reviewLog) if (e.rating >= 0 && e.rating <= 3) rating[e.rating]++;
  const totalRating = Object.values(rating).reduce((a, b) => a + b, 0);
  const retention = totalRating ? Math.round((rating[2] + rating[3]) / totalRating * 100) : 0;

  // 每日複習 (近 30 天)
  const daily = {};
  for (const e of reviewLog) {
    if (!e.reviewed_at) continue;
    const d = new Date(e.reviewed_at).toISOString().slice(0, 10);
    daily[d] = (daily[d] || 0) + 1;
  }
  const last30 = Object.entries(daily).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 30).reverse();

  // 診斷: 卡狀態異常
  const issues = [];
  const badState = cardArr.filter(c => c.state < 0 || c.state > 3).length;
  if (badState) issues.push(`⚠ ${badState} 張卡狀態異常`);
  const negIvl = cardArr.filter(c => (c.scheduledDays ?? 0) < 0).length;
  if (negIvl) issues.push(`⚠ ${negIvl} 張卡間隔為負`);
  const noDue = cardArr.filter(c => c.state > 0 && !c.due).length;
  if (noDue) issues.push(`⚠ ${noDue} 張卡無到期時間`);

  return { total, learned, mature, young, due, maturePct, rating, totalRating, retention, last30, issues };
}

const IVL_COLORS = { '新': 'var(--amber)', '學習中': 'var(--orange)', '年輕': 'var(--cyan)', '成熟': 'var(--green)', '重學': 'var(--red)', '新(無卡)': 'var(--text-tertiary)' };

function sparseLabels(labels, step) {
  return labels.map((l, i) => (i % step === 0 ? String(l) : ''));
}

function renderReportCharts(r) {
  if (!r) return '<div style="font-size:12px;color:var(--text-tertiary)">尚未生成報告</div>';
  if (r.error) return `<div style="font-size:12px;color:var(--red)">${r.error}</div>`;
  const step = Math.max(1, Math.ceil(r.labels.length / 12));
  const dl = sparseLabels(r.labels, step);
  const map = (arr) => r.labels.map((l, i) => ({ label: dl[i], value: arr[i] }));
  const ivl = (r.ivlDist || []).map(d => ({ label: d.g, value: d.n, color: IVL_COLORS[d.g] || '#94a3b8' }));
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--s3);margin-bottom:var(--s3)">
      <div><div style="font-size:22px;font-weight:800;color:var(--accent)">${r.matureCumulative ?? '?'}</div><div style="font-size:11px;color:var(--text-tertiary)">最終成熟</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--green)">${r.maturePct ?? '?'}%</div><div style="font-size:11px;color:var(--text-tertiary)">成熟率</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--cyan)">${r.days}</div><div style="font-size:11px;color:var(--text-tertiary)">模擬天數</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--orange)">${r.totalReviews.toLocaleString()}</div><div style="font-size:11px;color:var(--text-tertiary)">總評分</div></div>
    </div>
    <div class="chart-block"><div class="chart-title">每日複習量</div>${barChart(map(r.dailyReviews), { height: 130, color: 'var(--accent)' })}</div>
    <div class="chart-block" style="margin-top:var(--s4)"><div class="chart-title">成熟卡每日新增</div>${lineChart(map(r.matureDaily), { height: 120, color: 'var(--green)' })}</div>
    <div class="chart-block" style="margin-top:var(--s4)"><div class="chart-title">成熟卡累計</div>${lineChart(map(r.matureCumulativeSeries), { height: 120, color: 'var(--green)' })}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--s3);margin-top:var(--s4)">
      <div class="chart-block"><div class="chart-title">每日 Again 率</div>${lineChart(map(r.againPct), { min: 0, max: 100, height: 120, color: 'var(--red)' })}</div>
      <div class="chart-block"><div class="chart-title">每日 Good 率</div>${lineChart(map(r.goodPct), { min: 0, max: 100, height: 120, color: 'var(--green)' })}</div>
    </div>
    ${ivl.length ? `<div class="chart-block" style="margin-top:var(--s4)"><div class="chart-title">卡片狀態分布</div><div style="display:flex;align-items:center;gap:var(--s4);flex-wrap:wrap">${pieChart(ivl)}${pieLegend(ivl)}</div></div>` : ''}
    <div style="margin-top:var(--s3);font-size:11px;color:var(--text-tertiary)">${r.dateFrom} ~ ${r.dateTo}</div>
  `;
}

// Anki 同款平滑（windowSize = ceil(days/365)）
function movingAverage(y, windowSize) {
  const result = [];
  for (let i = 0; i < y.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - windowSize + 1); j <= i; j++) { sum += y[j]; count++; }
    result.push(sum / count);
  }
  return result;
}

function renderSimCharts(r, smooth = true) {
  if (!r || r.error) return `<div style="font-size:12px;color:var(--red)">${r?.error || '尚無模擬結果'}</div>`;
  const daily = r.daily;
  const step = Math.max(1, Math.ceil(daily.length / 12));
  const dl = daily.map((x, i) => (i % step === 0 ? String(x.day) : ''));
  const reviews = daily.map(x => x.reviews);
  const costs = daily.map(x => x.cost);
  const mems = daily.map(x => x.memorized);
  const win = smooth ? Math.max(1, Math.ceil(daily.length / 365)) : 1;
  const sReviews = movingAverage(reviews, win);
  const sCosts = movingAverage(costs, win);
  const sMems = movingAverage(mems, win);
  const last = daily[daily.length - 1];
  const map = (arr) => arr.map((v, i) => ({ label: dl[i], value: Math.round(v) }));
  const sub = _simSubgraph;
  const chart = sub === 'cost'
    ? `<div class="chart-block"><div class="chart-title">每日時間成本（秒）${smooth ? '· 平滑' : ''}</div>${barChart(map(sCosts), { height: 130, color: 'var(--orange)' })}</div>`
    : sub === 'memorized'
      ? `<div class="chart-block"><div class="chart-title">每日記憶量（Σ 留存率）${smooth ? '· 平滑' : ''}</div>${lineChart(map(sMems), { height: 130, color: 'var(--green)' })}</div>`
      : `<div class="chart-block"><div class="chart-title">每日複習量${smooth ? '· 平滑' : ''}</div>${barChart(map(sReviews), { height: 130, color: 'var(--accent)' })}</div>`;
  const rows = daily.map((x, i) => `
    <tr>
      <td style="padding:2px 8px;font-size:11px;color:var(--text-tertiary)">${x.day}</td>
      <td style="padding:2px 8px;font-size:11px;text-align:right">${x.reviews}</td>
      <td style="padding:2px 8px;font-size:11px;text-align:right">${Math.round(x.cost)}</td>
      <td style="padding:2px 8px;font-size:11px;text-align:right">${Math.round(x.memorized)}</td>
    </tr>`).join('');
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--s3);margin-bottom:var(--s3)">
      <div><div style="font-size:22px;font-weight:800;color:var(--green)">${Math.round(last?.memorized ?? 0)}</div><div style="font-size:11px;color:var(--text-tertiary)">末天記憶量</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--accent)">${last?.day ?? 0}</div><div style="font-size:11px;color:var(--text-tertiary)">模擬天數</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--orange)">${(r.totalReviews ?? 0).toLocaleString()}</div><div style="font-size:11px;color:var(--text-tertiary)">總評分</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--accent)">${Math.round((r.totalCost ?? 0) / 60)} 分</div><div style="font-size:11px;color:var(--text-tertiary)">總時間成本</div></div>
    </div>
    ${chart}
    <div style="margin-top:var(--s3);max-height:180px;overflow:auto;border:1px solid var(--border-subtle);border-radius:6px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--bg-base)">
          <th style="padding:4px 8px;font-size:11px;text-align:left;color:var(--text-tertiary)">天</th>
          <th style="padding:4px 8px;font-size:11px;text-align:right;color:var(--text-tertiary)">複習</th>
          <th style="padding:4px 8px;font-size:11px;text-align:right;color:var(--text-tertiary)">成本(秒)</th>
          <th style="padding:4px 8px;font-size:11px;text-align:right;color:var(--text-tertiary)">記憶量</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderWorkloadCharts(r) {
  if (!r || r.error) return `<div style="font-size:12px;color:var(--red)">${r?.error || '尚未執行負載模擬'}</div>`;
  const step = Math.max(1, Math.ceil(r.drs.length / 10));
  const dl = r.drs.map((x, i) => (i % step === 0 ? x.dr + '%' : ''));
  const costPerDay = r.drs.map((x, i) => ({ label: dl[i], value: Math.round(x.cost / r.days) }));
  const reviewsPerDay = r.drs.map((x, i) => ({ label: dl[i], value: Math.round(x.reviewCount / r.days) }));
  const memorized = r.drs.map((x, i) => ({ label: dl[i], value: x.memorized }));
  const minCost = [...r.drs].sort((a, b) => a.cost - b.cost)[0];
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--s3);margin-bottom:var(--s3)">
      <div><div style="font-size:22px;font-weight:800;color:var(--text-secondary)">${r.reviewlessEndMemorized.toLocaleString()}</div><div style="font-size:11px;color:var(--text-tertiary)">完全不複習的末天記憶</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--accent)">${r.days}</div><div style="font-size:11px;color:var(--text-tertiary)">模擬天數</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--green)">${r.totalWords}</div><div style="font-size:11px;color:var(--text-tertiary)">總詞數</div></div>
      <div><div style="font-size:22px;font-weight:800;color:var(--cyan)">${minCost?.dr ?? '-'}%</div><div style="font-size:11px;color:var(--text-tertiary)">成本最低留存率</div></div>
    </div>
    <div class="chart-block"><div class="chart-title">期望留存比率 vs 每日平均成本</div>${barChart(costPerDay, { height: 130, color: 'var(--orange)' })}</div>
    <div class="chart-block" style="margin-top:var(--s4)"><div class="chart-title">期望留存比率 vs 每日複習次數</div>${barChart(reviewsPerDay, { height: 130, color: 'var(--accent)' })}</div>
    <div class="chart-block" style="margin-top:var(--s4)"><div class="chart-title">期望留存比率 vs 末天記憶卡數</div>${lineChart(memorized, { height: 120, color: 'var(--green)' })}</div>
  `;
}

async function runFrontendWorkload(s, opts) {
  toast('負載模擬中（30 組留存率 × 模擬天數）...', '');
  const genAtStart = _simRunGen; // G26：世代守衛
  try {
    await new Promise(res => setTimeout(res, 10));
    const req = buildSimRequest(s, 'workload', opts);
    const res = await simulateFsrs(req);
    if (_simRunGen !== genAtStart) { toast('已切換模式，舊模式結果不記錄', ''); return; } // G26
    _workloadResult = {
      drs: res.drs, reviewlessEndMemorized: res.reviewlessEndMemorized,
      totalWords: req.cards.length, days: req.days,
    };
    _cliOutput = `✅ 負載模擬完成 (${MODE_LABELS[_simMode]}): 70~99% 留存率 × ${req.days} 天, 完全不複習末天記憶 ${Math.round(res.reviewlessEndMemorized)} 詞`;
    console.log('[sim] 負載模擬完成', res.drs.length, '組留存率');
    renderInPlace(s);
    toast('負載模擬完成', 'toast-success');
  } catch (e) {
    if (_simRunGen !== genAtStart) { toast('已切換模式，舊模式結果不記錄', ''); return; } // G26
    console.error('[sim] 負載模擬失敗:', e);
    _workloadResult = { error: String(e) };
    renderInPlace(s);
    toast('負載模擬失敗: ' + e, 'toast-error');
  }
}

async function runFrontendOptimal(s, opts) {
  toast('計算最佳留存率中（Brent 優化 × 30 組模擬）...', '');
  const genAtStart = _simRunGen; // G26：世代守衛
  try {
    await new Promise(res => setTimeout(res, 10));
    const req = buildSimRequest(s, 'optimal', opts);
    const res = await simulateFsrs(req);
    if (_simRunGen !== genAtStart) { toast('已切換模式，舊模式結果不記錄', ''); return; } // G26
    const dr = Math.round((res.optimalRetention ?? 0.9) * 1000) / 1000;
    _optimalRetention = dr;
    _cliOutput = `✅ 最佳留存率 (${MODE_LABELS[_simMode]}): ${(dr * 100).toFixed(1)}% — 在記憶量與成本間取得最佳平衡`;
    console.log('[sim] 最佳留存率 =', dr);
    renderInPlace(s);
    toast(`建議留存率 ${(dr * 100).toFixed(1)}%`, 'toast-success');
  } catch (e) {
    if (_simRunGen !== genAtStart) { toast('已切換模式，舊模式結果不記錄', ''); return; } // G26
    console.error('[sim] 最佳留存率失敗:', e);
    _cliOutput = `❌ ${e}`;
    renderInPlace(s);
    toast('最佳留存率計算失敗: ' + e, 'toast-error');
  }
}

async function runFrontendSim(s, opts) {
  toast('模擬中...', '');
  const genAtStart = _simRunGen; // G26：世代守衛——切模式即作廢本回調
  try {
    await new Promise(res => setTimeout(res, 10));
    const req = buildSimRequest(s, 'simulate', opts);
    const res = await simulateFsrs(req);
    // G26 模式競態：遲到結果屬舊模式資料，整個丟棄（不入列/不留痕/不渲染/不誤報 toast）
    if (_simRunGen !== genAtStart) { toast('已切換模式，舊模式結果不記錄', ''); return; }
    const daily = (res.memorizedPerDay || []).map((m, i) => ({
      day: i + 1,
      reviews: ((res.reviewPerDay || [])[i] ?? 0) + ((res.learnPerDay || [])[i] ?? 0),
      memorized: m,
      cost: (res.costPerDay || [])[i] ?? 0,
    }));
    const totalReviews = ((res.reviewPerDay || []).reduce((a, b) => a + b, 0))
      + ((res.learnPerDay || []).reduce((a, b) => a + b, 0));
    const totalCost = (res.costPerDay || []).reduce((a, b) => a + b, 0);
    const entry = {
      daily, totalReviews, totalCost, totalWords: req.cards.length,
      meta: { mode: _simMode, days: req.days, seed: req.seed },
    };
    pushSimEntry(entry);
    _simSelectedIndex = null; // 顯示最新
    const lastMem = Math.round(daily[daily.length - 1]?.memorized ?? 0);
    _cliOutput = `✅ 模擬完成 (${MODE_LABELS[_simMode]}): ${daily.length} 天, 末天記憶 ${lastMem} 詞, ${totalReviews} 次評分（#${_simResults.length}）`;
    console.log('[sim] 官方引擎模擬完成', daily.length, '天');
    renderInPlace(s);
    toast(`模擬完成 (#${_simResults.length}, 末天記憶 ${lastMem})`, 'toast-success');
    // 寫入模擬歷史 (隔離 DB)——fire-and-forget：不阻塞渲染，
    // 亦消除 await 窗口中切模式導致 toast/#N 誤報的二次競態（G26 審查採納）
    import('../lib/app-log.js').then(({ addSimRun }) => addSimRun({
      kind: 'simulate',
      days: daily.length, targetPct: null,
      seed: req.seed, fromZero: req.fromZero, totalReviews,
      matureCards: Math.round(lastMem), maturePct: req.cards.length ? Math.round(lastMem / req.cards.length * 100) : 0,
    })).catch(e => console.warn('[sim] addSimRun 失敗:', e));
  } catch (e) {
    if (_simRunGen !== genAtStart) { toast('已切換模式，舊模式結果不記錄', ''); return; }
    console.error('[sim] 模擬失敗:', e);
    pushSimEntry({ error: String(e) });
    renderInPlace(s);
    toast('模擬失敗: ' + e, 'toast-error');
  }
}

/** 清除最後一次模擬（對齊 Anki Clear Last Simulation） */
function clearLastSimulation(s) {
  if (_simResults.length === 0) { toast('沒有可清除的模擬', ''); return; }
  _simResults.pop();
  _simSelectedIndex = null;
  _cliOutput = `🗑️ 已清除最後一次模擬（剩餘 ${_simResults.length} 筆）`;
  renderInPlace(s);
}

/** 把模擬參數套用到該模式的 Anki 設定（對齊 Anki Save Options to Preset） */
async function saveParamsToPreset(s) {
  const p = readSimParams();
  const upd = _simMode === 'mc' ? s.actions.updateAnkiSettingsMc
    : _simMode === 'spell' ? s.actions.updateAnkiSettingsSpell
    : s.actions.updateAnkiSettings;
  try {
    await upd({
      desiredRetention: p.dr,
      cardsPerDay: p.newLimit,
      maxReviewsPerDay: p.reviewLimit,
      maxIvl: p.maxInterval,
      easyDaysPercentages: p.easyDays,
    });
    _cliOutput = `✅ 已套用到 ${MODE_LABELS[_simMode]} 設定: 留存率 ${(p.dr * 100).toFixed(1)}%, 每日新卡 ${p.newLimit}, 複習上限 ${p.reviewLimit}, 最大間隔 ${p.maxInterval}, Easy Days ${p.easyDays.join('/')}`;
    toast(`已套用到 ${MODE_LABELS[_simMode]} 設定`, 'toast-success');
  } catch (e) {
    _cliOutput = `❌ ${e}`;
    toast('套用失敗: ' + e, 'toast-error');
  }
  renderInPlace(s);
}

export function render(s) {
  // 首次進入頁面時用該模式 ankiCfg 帶入參數預設值
  if (!_simParamsInitialized) {
    const { ankiCfg } = modeData(s);
    _simParams = {
      days: 365,
      dr: ankiCfg.desiredRetention ?? 0.9,
      newLimit: ankiCfg.cardsPerDay ?? 80,
      reviewLimit: ankiCfg.maxReviewsPerDay ?? 1000,
      maxInterval: ankiCfg.maxIvl ?? 365,
      reviewOrder: 'day',
      newCardsIgnoreReviewLimit: true,
      suspendLeeches: false,
      leechThreshold: 8,
      smooth: true,
      seed: 1,
      easyDays: Array.isArray(ankiCfg.easyDaysPercentages) && ankiCfg.easyDaysPercentages.length === 7
        ? ankiCfg.easyDaysPercentages.map(v => Math.max(0, Math.min(1, Number(v) || 0)))
        : [1, 1, 1, 1, 1, 1, 1],
    };
    _simParamsInitialized = true;
  }
  const a = computeAnalysis(s);
  console.log('[sim] render: total=', a.total, 'mature=', a.mature, 'learned=', a.learned, 'rating=', a.totalRating);
  const isAns = false;

  const bars = [a.rating[0], a.rating[1], a.rating[2], a.rating[3]];
  const maxBar = Math.max(1, ...bars);
  const barColors = ['var(--red)', 'var(--orange)', 'var(--green)', 'var(--cyan)'];
  const barNames = ['Again', 'Hard', 'Good', 'Easy'];
  const barHtml = bars.map((v, i) => `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="width:50px;font-size:11px;color:var(--text-tertiary)">${barNames[i]}</div>
      <div style="flex:1;height:12px;background:var(--bg-elevated);border-radius:4px;overflow:hidden">
        <div style="width:${v / maxBar * 100}%;height:100%;background:${barColors[i]}"></div>
      </div>
      <div style="width:40px;font-size:11px;color:var(--text-secondary);text-align:right">${v}</div>
    </div>`).join('');

  const dailyHtml = a.last30.map(([d, n]) => {
    const maxD = Math.max(1, ...a.last30.map(x => x[1]));
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
      <div style="width:80px;font-size:10px;color:var(--text-tertiary)">${d.slice(5)}</div>
      <div style="flex:1;height:10px;background:var(--bg-elevated);border-radius:3px;overflow:hidden">
        <div style="width:${n / maxD * 100}%;height:100%;background:var(--accent)"></div>
      </div>
      <div style="width:30px;font-size:10px;color:var(--text-secondary)">${n}</div>
    </div>`;
  }).join('');

  return `
    <div class="page-title">${icon('chart')} 學習分析</div>
    <div class="page-subtitle">基於目前資料庫 · ${a.total} 詞 · ${MODE_LABELS[_simMode]}模式</div>

    <div style="display:flex;gap:var(--s2);margin-bottom:var(--s4)">
      ${['flip', 'mc', 'spell'].map(m => `
        <button class="btn-sm ${_simMode === m ? 'btn-primary' : 'btn-secondary'}" data-sim-mode="${m}" style="padding:6px 14px">${MODE_LABELS[m]}</button>
      `).join('')}
    </div>

    <div class="config-section" style="margin-bottom:var(--s4)">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--s3)">
        <div><div style="font-size:24px;font-weight:800;color:var(--accent)">${a.maturePct}%</div><div style="font-size:11px;color:var(--text-tertiary)">成熟卡</div></div>
        <div><div style="font-size:24px;font-weight:800;color:var(--green)">${a.learned}</div><div style="font-size:11px;color:var(--text-tertiary)">已學習</div></div>
        <div><div style="font-size:24px;font-weight:800;color:var(--orange)">${a.young}</div><div style="font-size:11px;color:var(--text-tertiary)">學習中</div></div>
        <div><div style="font-size:24px;font-weight:800;color:var(--red)">${a.due}</div><div style="font-size:11px;color:var(--text-tertiary)">到期</div></div>
        <div><div style="font-size:24px;font-weight:800;color:var(--cyan)">${a.retention}%</div><div style="font-size:11px;color:var(--text-tertiary)">保留率</div></div>
      </div>
      <div style="margin-top:var(--s3);font-size:12px;color:var(--text-tertiary)">
        ${a.mature} 張成熟卡 / ${a.total} 詞 · ${a.totalRating} 次複習
      </div>
    </div>

    <div class="section">
      <div class="section-title">${icon('target')} 評分分布 (${a.totalRating} 次)</div>
      <div class="card" style="padding:var(--s4)">${barHtml}</div>
    </div>

    <div class="section">
      <div class="section-title">${icon('clock')} 最近 30 天複習量</div>
      <div class="card" style="padding:var(--s4)">${a.last30.length ? dailyHtml : '<div class="muted" style="font-size:12px">尚無複習資料</div>'}</div>
    </div>

    ${s.state.devMode ? `
    <div class="section">
      <div class="section-title">${icon('activity')} 診斷</div>
      <div class="card" style="padding:var(--s4)">
        ${a.issues.length ? a.issues.map(x => `<div style="font-size:13px;margin-bottom:4px">${x}</div>`).join('') : '<div style="color:var(--green);font-size:13px">✅ 資料正常，無異常</div>'}
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-title">${icon('chart')} FSRS 模擬器（對齊 Anki SimulateFsrsReview / Workload / ComputeOptimalRetention）</div>
      <div class="card" style="padding:var(--s4)">
        <div style="display:flex;gap:var(--s2);flex-wrap:wrap;margin-bottom:var(--s3)">
          <button class="btn btn-sm" id="cliSimulate">${icon('play')} 模擬</button>
          <button class="btn btn-sm" id="cliWorkload">${icon('chart')} 負載模擬</button>
          <button class="btn btn-sm" id="cliOptimal">${icon('sparkle')} 幫我選擇</button>
          <button class="btn btn-sm" id="cliClearLast">${icon('trash')} 清除最後一次</button>
          <button class="btn btn-sm" id="cliSavePreset">${icon('save')} 套用設定</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--s2) var(--s3);margin-bottom:var(--s3);font-size:12px;color:var(--text-secondary)">
          <label>天數 <input type="number" id="simDays" value="${_simParams.days}" min="1" max="3650" style="width:100%;text-align:center;padding:2px 4px"></label>
          <label>留存率 % <input type="number" id="simDr" value="${Math.round(_simParams.dr * 100)}" min="70" max="99" style="width:100%;text-align:center;padding:2px 4px"></label>
          <label>每日新卡 <input type="number" id="simNewLimit" value="${_simParams.newLimit}" min="0" max="9999" style="width:100%;text-align:center;padding:2px 4px"></label>
          <label>每日複習上限 <input type="number" id="simReviewLimit" value="${_simParams.reviewLimit}" min="0" max="9999" style="width:100%;text-align:center;padding:2px 4px"></label>
          <label>最大間隔(天) <input type="number" id="simMaxIvl" value="${_simParams.maxInterval}" min="1" max="36500" style="width:100%;text-align:center;padding:2px 4px"></label>
          <label>複習排序
            <select id="simReviewOrder" style="width:100%;padding:2px 4px">
              <option value="day" ${_simParams.reviewOrder === 'day' ? 'selected' : ''}>到期日</option>
              <option value="retrievability_asc" ${_simParams.reviewOrder === 'retrievability_asc' ? 'selected' : ''}>可提取性 ↑（最可能忘的先）</option>
              <option value="retrievability_desc" ${_simParams.reviewOrder === 'retrievability_desc' ? 'selected' : ''}>可提取性 ↓</option>
              <option value="random" ${_simParams.reviewOrder === 'random' ? 'selected' : ''}>隨機</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;margin-top:4px">
            <input type="checkbox" id="simIgnoreLimit" ${_simParams.newCardsIgnoreReviewLimit ? 'checked' : ''}> 新卡忽略複習上限
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;margin-top:4px">
            <input type="checkbox" id="simSuspend" ${_simParams.suspendLeeches ? 'checked' : ''}> suspend leeches
          </label>
          <label id="simLeechWrap" style="display:${_simParams.suspendLeeches ? 'flex' : 'none'};align-items:center;gap:4px;margin-top:4px">
            閾值 <input type="number" id="simLeechThreshold" value="${_simParams.leechThreshold}" min="1" max="9999" style="width:60px;text-align:center;padding:2px 4px">
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;margin-top:4px">
            <input type="checkbox" id="simSmooth" ${_simParams.smooth ? 'checked' : ''}> 平滑圖
          </label>
          <label>種子 <input type="number" id="simSeed" value="${_simParams.seed}" min="1" style="width:100%;text-align:center;padding:2px 4px"></label>
          <div style="grid-column:1/-1;margin-top:var(--s2);padding-top:var(--s2);border-top:1px solid var(--border-subtle)">
            <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">Easy Days（負載分散，0=最少 0.5=減少 1=正常，對齊 Anki load balancer）</div>
            <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:var(--s1);font-size:10px;color:var(--text-secondary)">
              ${['一','二','三','四','五','六','日'].map((d, i) => `
                <div style="text-align:center">
                  <div>週${d}</div>
                  <input type="range" id="simEasyDay${i}" min="0" max="1" step="0.5" value="${_simParams.easyDays[i]}" style="width:100%">
                  <div id="simEasyDayLabel${i}" style="font-size:9px;color:var(--text-tertiary)">${_simParams.easyDays[i] === 1 ? '正常' : _simParams.easyDays[i] === 0 ? '最少' : '減少'}</div>
                </div>`).join('')}
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;margin-top:4px">
            <input type="checkbox" id="simFromZero"> 從零開始
          </label>
        </div>
        ${s.state.devMode ? `
          <div style="display:flex;gap:var(--s2);flex-wrap:wrap;margin-bottom:var(--s3);border-top:1px solid var(--border-subtle);padding-top:var(--s3)">
            <button class="btn btn-sm" id="cliDiagnose">${icon('activity')} 診斷</button>
          </div>
          <div style="display:flex;gap:var(--s2);align-items:center;margin-bottom:var(--s3)">
            <div style="font-size:12px;color:var(--text-tertiary)">log 目錄:</div>
            <input id="cliLogDir" type="text" value="${_simLogsDir}" placeholder="預設為 app 設定目錄 sim-logs" style="flex:1;font-size:11px">
            <button class="btn btn-sm" id="cliReport">${icon('file')} 生成圖表報告</button>
          </div>
        ` : ``}
        ${_cliOutput ? `
          <div style="margin-top:var(--s2);background:var(--bg-base);border-radius:8px;padding:var(--s3);max-height:300px;overflow:auto;font-family:monospace;font-size:11px;white-space:pre-wrap">${_cliOutput}</div>
        ` : '<div style="font-size:11px;color:var(--text-tertiary)">點擊按鈕執行模擬，輸出顯示於此</div>'}
      </div>
    </div>

    ${_optimalRetention != null ? `
      <div style="font-size:13px;margin-bottom:var(--s3);padding:8px 10px;background:var(--bg-base);border-radius:8px;border:1px solid var(--border-subtle)">
        💡 <b>建議留存率 ${(_optimalRetention * 100).toFixed(1)}%</b>（對齊 Anki「幫我選擇」ComputeOptimalRetention，成本/記憶量平衡點）
      </div>
    ` : ''}

    <div class="section">
      <div class="section-title">${icon('chart')} 模擬結果</div>
      <div class="card" style="padding:var(--s4)">
        ${_simResults.length === 0 ? renderReportCharts(_reportData) : `
          <div style="display:flex;gap:var(--s3);align-items:center;margin-bottom:var(--s3);flex-wrap:wrap">
            <span style="font-size:12px;color:var(--text-tertiary)">顯示:</span>
            ${[['reviews', '每日複習量'], ['cost', '時間成本'], ['memorized', '記憶量']].map(([v, l]) => `
              <label style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:4px;cursor:pointer">
                <input type="radio" name="simSubgraph" value="${v}" ${_simSubgraph === v ? 'checked' : ''}> ${l}
              </label>
            `).join('')}
            ${_simResults.length > 1 ? `<span style="font-size:11px;color:var(--text-tertiary)">（${_simResults.length} 筆，顯示最近一筆，可點擊歷史切換）</span>` : ''}
          </div>
          ${_simResults.map((r, idx) => `
            <button class="btn btn-xs ${idx === _simResults.length - 1 ? 'btn-primary' : 'btn-secondary'}" data-sim-history="${idx}" style="margin:0 4px 4px 0">#${idx + 1}</button>
          `).join('')}
          ${renderSimCharts(_simResults[_simSelectedIndex ?? _simResults.length - 1], _simParams.smooth)}
        `}
      </div>
    </div>

    <div class="section">
      <div class="section-title">${icon('chart')} 負載模擬（對齊 Anki SimulateFsrsWorkload）</div>
      <div class="card" style="padding:var(--s4)">
        <div style="font-size:11px;color:var(--text-tertiary)">掃描期望留存比率 70%~99%（30 組，共用上方參數），輸出每日成本 / 複習次數 / 末天記憶量，與 Anki「FSRS 模擬器」的負載視圖相同</div>
        <div style="margin-top:var(--s3)">${_workloadResult ? renderWorkloadCharts(_workloadResult) : '<div style="font-size:11px;color:var(--text-tertiary)">尚未執行負載模擬，點擊「負載模擬」按鈕開始</div>'}</div>
      </div>
    </div>
  `;
}

export function onMount(s) {
  console.log('[sim] onMount 載入, 綁定 CLI 按鈕');
  document.querySelectorAll('[data-goto]').forEach(el =>
    el.addEventListener('click', () => s.actions.navigate(el.dataset.goto)));

  // 學習模式切換：換資料來源並重算統計/模擬結果
  document.querySelectorAll('[data-sim-mode]').forEach(el =>
    el.addEventListener('click', () => {
      const m = el.dataset.simMode;
      if (m === _simMode) return;
      console.log('[sim] 切換學習模式:', _simMode, '→', m);
      _simMode = m;
      _simRunGen++; // G26：作廢所有 in-flight 模擬回調（含 A→B→A 切回原值）
      _simResults = [];
      _simSelectedIndex = null; // G8：清空歷史須同批作廢選態（防 stale 索引讀 undefined）
      _workloadResult = null;
      _optimalRetention = null;
      _simParamsInitialized = false;
      renderInPlace(s);
    }));

  const run = async (cmd, label) => {
    console.log('[sim] CLI 開始:', label, cmd.join(' '));
    toast(`${label}執行中...`, '');
    try {
      const out = await runCli(cmd);
      _cliOutput = out || '(無輸出)';
      console.log('[sim] CLI 完成:', label, '輸出', (out || '').length, '字元');
      renderInPlace(s);
      toast(`${label}完成`, 'toast-success');
    } catch (e) {
      _cliOutput = `❌ ${e}`;
      console.error('[sim] CLI 失敗:', label, e);
      renderInPlace(s);
      toast(`${label}失敗: ${e}`, 'toast-error');
    }
  };

  const b = (id, cmd, label) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { console.log('[sim] 點擊按鈕:', label); run(cmd, label); });
  };
  // Dynamic sim-logs dir from Rust (no hardcoded /home/jupiter paths)
  getAppPaths().then(p => {
    _simLogsDir = p.simLogsDir || '';
    const input = document.getElementById('cliLogDir');
    if (input && !input.value) input.value = _simLogsDir;
  }).catch(() => {});
  const simBtn = document.getElementById('cliSimulate');
  if (simBtn) simBtn.addEventListener('click', () => {
    console.log('[sim] 點擊按鈕: 模擬');
    runFrontendSim(s, {});
  });
  const wlBtn = document.getElementById('cliWorkload');
  if (wlBtn) wlBtn.addEventListener('click', () => {
    console.log('[sim] 點擊按鈕: 負載模擬');
    runFrontendWorkload(s, {});
  });
  const optBtn = document.getElementById('cliOptimal');
  if (optBtn) optBtn.addEventListener('click', () => {
    console.log('[sim] 點擊按鈕: 幫我選擇');
    runFrontendOptimal(s, {});
  });
  const clearBtn = document.getElementById('cliClearLast');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    console.log('[sim] 點擊按鈕: 清除最後一次');
    clearLastSimulation(s);
  });
  const saveBtn = document.getElementById('cliSavePreset');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    console.log('[sim] 點擊按鈕: 套用設定');
    saveParamsToPreset(s);
  });
  // suspend leeches 開關 → 顯示/隱藏閾值輸入
  const suspendCb = document.getElementById('simSuspend');
  if (suspendCb) suspendCb.addEventListener('change', () => {
    const wrap = document.getElementById('simLeechWrap');
    if (wrap) wrap.style.display = suspendCb.checked ? 'flex' : 'none';
  });
  // Easy Days slider → 即時更新標籤（0=最少 0.5=減少 1=正常，對齊 Anki EasyDay）
  for (let i = 0; i < 7; i++) {
    const slider = document.getElementById('simEasyDay' + i);
    if (slider) slider.addEventListener('input', () => {
      const lbl = document.getElementById('simEasyDayLabel' + i);
      const v = parseFloat(slider.value);
      if (lbl) lbl.textContent = v === 1 ? '正常' : v === 0 ? '最少' : '減少';
    });
  }
  // 圖表 subgraph radio（對齊 Anki 圖表切換）
  document.querySelectorAll('input[name="simSubgraph"]').forEach(el =>
    el.addEventListener('change', () => {
      _simSubgraph = el.value;
      renderInPlace(s);
    }));
  // 歷史切換（查看第 N 筆模擬）
  document.querySelectorAll('[data-sim-history]').forEach(el =>
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.simHistory);
      // G8 邊界守衛：renderInPlace 後舊 DOM ref 的封閉索引可能已越界（pop/cap/切模式），越界不採納
      if (!Number.isInteger(i) || i < 0 || i >= _simResults.length) return;
      _simSelectedIndex = i;
      renderInPlace(s);
    }));
  b('cliDiagnose', ['diagnose'], '診斷');
  const reportBtn = document.getElementById('cliReport');
  if (reportBtn) reportBtn.addEventListener('click', async () => {
    const dir = document.getElementById('cliLogDir')?.value || _simLogsDir;
    console.log('[sim] 點擊按鈕: 生成圖表報告, 目錄=', dir);
    toast('生成圖表報告中...', '');
    try {
      const out = await runCli(['report', dir, '--json']);
      _reportData = JSON.parse(out);
      _cliOutput = `✅ 報告資料已載入 (${_reportData.days} 天, ${_reportData.totalReviews} 次評分)`;
      renderInPlace(s);
      toast('圖表已生成', 'toast-success');
    } catch (e) {
      _reportData = { error: String(e) };
      _cliOutput = `❌ ${e}`;
      console.error('[sim] 圖表報告失敗:', e);
      renderInPlace(s);
      toast('圖表生成失敗', 'toast-error');
    }
  });
}

function renderInPlace(s) {
  // G26：幽靈渲染守衛——async 完成回調可能晚於導航，無條件覆寫會把新頁轟成學習分析頁。
  // 語意＝渲染丟棄、資料保留（結果仍入列，回頁可見）。守衛放入口＝全呼叫點覆蓋。
  if (s?.state?.currentPage && s.state.currentPage !== 'simulator') return;
  const c = document.getElementById('pageContainer');
  if (c) {
    c.innerHTML = render(s);
    onMount(s);
    if (typeof initCustomSelects === 'function') initCustomSelects(c); // G14 同族：三步曲補第三步
  }
}
