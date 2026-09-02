#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G26 防回歸驗證 v1.1 — 學習分析頁 async 回調幽靈渲染＋切模式競態髒入列
//                     ＋ renderInPlace custom-select 轉換遺失（G14 同族）
//
// v1.1（R1 三委員全採納）：
//  FIX-1 needle `末天記憶`→`總時間成本`（前者撞 :598 靜態文案＝永真字串，
//        T2f 修法後物理不可達——R1A必修1/R1B基線發現，同 G8 R1#1 T2e 同族）
//  FIX-2 拋棄語意辨證全面改「可觀察面」：丟棄必發『已切換模式』toast 正釘
//        （M6 靜默丟棄與守衛不發 toast 由正釘斃——計畫 §7 取捨入法）
//  FIX-3 M7 狀態面釘：放閘後重進頁 renderPage 重渲染數歷史（DOM 滯留幨破）
//  FIX-4 新 mock：可放 reject（catch 路徑世代守衛腿，殺 M3）＋app-log spy
//  FIX-5 A→B→A 值相等盲區採納（R1A 建議）：世代計數器 _simRunGen（單檔零
//        成本，R1A 糾正『需 store 配合』誤宣）——值守衛升級計數器守衛
//  FIX-6 T4c toast 快照化（R1A：全域 some 永真傾向）
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-g26-render-lifecycle.mjs
//       → 修法後期望 ALL PASS
//   node --experimental-test-module-mocks /tmp/g26nc/tools/verify-g26-render-lifecycle.mjs --expect-legacy
//       → 負控制（HEAD 未修碼）ALL PASS
// 注入：simulateFsrs mock 回「手動放閘」promise（resolve/reject 雙閘），
//       持有 resolve/reject 親手在 in-flight 窗口導航/切模式——零計時器競態。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';

const LEGACY = process.argv.includes('--expect-legacy');

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="pageContainer"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let failures = 0;
function check(label, got, expect) {
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
// 圖表渲染專用 needle：'總時間成本' 唯 renderSimCharts stat 區（:252）所有；
// 舊 needle '末天記憶' 撞 :598 負載區靜態文案＝永真（FIX-1，R1 實測）。
const CHART = '總時間成本';

// ── mock 層（custom-select/chart 用真模組） ──
const toasts = [];
mock.module('../src/main.js', { exports: { toast: (m, t) => toasts.push([m, t]) } });
mock.module('../src/lib/svg.js', { exports: { icon: () => '<svg></svg>' } });
// FIX-4：app-log spy——留痕呼叫計數可釘（模式競態=不該留痕）
const simRuns = [];
mock.module('../src/lib/app-log.js', { exports: { addSimRun: async (r) => { simRuns.push(r); } } });
const gates = [];
mock.module('../src/lib/api.js', {
  exports: {
    runCli: async () => '(stub)',
    getAppPaths: async () => ({ simLogsDir: '/tmp/sim-logs' }),
    simulateFsrs: async (req) => new Promise((resolve, reject) => {
      gates.push({ req, resolve, reject });
    }),
  },
});
function shapeFor(mode) {
  if (mode === 'workload') {
    return {
      drs: [70, 85, 99].map(dr => ({ dr, cost: dr * 100, reviewCount: dr * 10, memorized: dr * 20 })),
      reviewlessEndMemorized: 1234,
    };
  }
  if (mode === 'optimal') return { optimalRetention: 0.873 };
  return { memorizedPerDay: [7, 7], reviewPerDay: [3, 3], learnPerDay: [0, 0], costPerDay: [1, 1] };
}
function releaseLast() {
  const g = gates.pop();
  if (!g) throw new Error('no in-flight gate');
  g.resolve(shapeFor(g.req?.mode));
  return g.req;
}
function rejectLast(e = new Error('engine boom')) {
  const g = gates.pop();
  if (!g) throw new Error('no in-flight gate');
  g.reject(e);
  return g.req;
}
function inFlight() { return gates.length; }

const sim = await import('../src/pages/simulator.js');
const { initCustomSelects } = await import('../src/lib/custom-select.js');

const container = () => document.getElementById('pageContainer');
const s = {
  state: {
    words: Array.from({ length: 30 }, (_, i) => ({ id: 'w' + i, word: 'w' + i })),
    cards: new Map(), cardsMc: new Map(), cardsSpell: new Map(),
    ankiSettings: { fsrsWeights: null, desiredRetention: 0.9, cardsPerDay: 80, maxReviewsPerDay: 1000, maxIvl: 365 },
    ankiSettingsMc: {}, ankiSettingsSpell: {},
    reviewLog: [], dayCutoff: 0, devMode: false,
    currentPage: 'simulator',
  },
  actions: { navigate: () => {}, updateAnkiSettings: async () => {} },
};
// 鏡像 main.js renderPage 三步曲（render → onMount → initCustomSelects）
function renderPage() {
  container().innerHTML = sim.render(s);
  sim.onMount(s);
  initCustomSelects(container());
}
const historyBtns = () => [...container().querySelectorAll('[data-sim-history]')];
function click(sel) {
  const el = container().querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  el.click();
}
const staleToast = (from = toasts.length) =>
  toasts.slice(from).some(([m]) => /已切換模式/.test(m));

const SRC = readFileSync(new URL('../src/pages/simulator.js', import.meta.url), 'utf8');

// ═══ 靜態源釘 ═══
if (LEGACY) {
  check('S1-legacy renderInPlace 無 currentPage 守衛（bug 在場）',
    /renderInPlace[\s\S]{0,120}currentPage/.test(SRC), false);
  check('S2-legacy 無 initCustomSelects import（G14 同族缺口在場）',
    /initCustomSelects/.test(SRC), false);
  check('S3-legacy 前端模擬函式無世代機制', /_simRunGen/.test(SRC), false);
  // FIX-4 spy 釘鏡像：HEAD 舊 mc 競態必留痕（見 T2-legacy）
} else {
  const rip = SRC.slice(SRC.indexOf('function renderInPlace'));
  check('S1 renderInPlace 頭部有 currentPage 守衛',
    /currentPage/.test(rip.slice(0, 240)), true);
  check('S2 renderInPlace 呼叫 initCustomSelects',
    /renderInPlace[\s\S]{0,400}initCustomSelects\(/.test(rip), true);
  check('S2b import initCustomSelects',
    /import\s*\{[^}]*initCustomSelects[^}]*\}\s*from\s*'\.\.\/lib\/custom-select\.js'/.test(SRC), true);
  check('S3 世代計數器存在（FIX-5：A→B→A 值相等盲區封堵）',
    /_simRunGen/.test(SRC) && /_simRunGen\+\+|_simRunGen\s*\+=|_simRunGen\s*=\s*_simRunGen\s*\+\+/.test(SRC), true);
  const fns = ['runFrontendSim', 'runFrontendWorkload', 'runFrontendOptimal']
    .map(n => {
      const i = SRC.indexOf(`async function ${n}`);
      if (i < 0) return `${n}:MISSING`;
      return `${n}:${/_simRunGen/.test(SRC.slice(i, i + 2600)) ? 'ok' : 'NOGENERATION'}`;
    }).join(',');
  check('S3b 三前端模擬函式皆用世代守衛', fns,
    'runFrontendSim:ok,runFrontendWorkload:ok,runFrontendOptimal:ok');
  // R2B-N3：計數釘（包含檢核會被 success 守衛命中而漏判 catch 缺失）——每函式恰 2 席
  const guardCounts = ['runFrontendSim', 'runFrontendWorkload', 'runFrontendOptimal']
    .map(n => {
      const i = SRC.indexOf(`async function ${n}`);
      const j = SRC.indexOf('async function', i + 10);
      const body = SRC.slice(i, j > 0 ? j : SRC.length);
      return `${n}:${(body.match(/_simRunGen !== genAtStart/g) || []).length}`;
    }).join(',');
  check('S3c 每函式 success+catch 雙守衛（殺 N3 catch 裸奔）', guardCounts,
    'runFrontendSim:2,runFrontendWorkload:2,runFrontendOptimal:2');
}

// ═══ T1 幽靈渲染（導航離頁 → in-flight 放閘） ═══
renderPage();
check('T0 掛載基線：模擬鈕在場', !!document.getElementById('cliSimulate'), true);
check('T1a custom-select 首次掛載已包裝（renderPage 三步曲基準）',
  !!container().querySelector('.cs-wrap'), true);

click('#cliSimulate');
await tick();
check('T1b 模擬 in-flight（閘門 1 個）', inFlight(), 1);
// 用戶導航去 dashboard：main.js 語意 = currentPage 變 + renderPage 重寫 container
s.state.currentPage = 'dashboard';
container().innerHTML = '<div id="dash">DASHBOARD-PAGE</div>';
await tick();
releaseLast();
await tick(80);
if (LEGACY) {
  check('T1c-legacy 幽靈渲染：dashboard 被學習分析轟掉（bug 在場）',
    container().innerHTML.includes('DASHBOARD-PAGE'), false);
  check('T1d-legacy 轟後 page-title 為學習分析',
    container().innerHTML.includes('學習分析'), true);
} else {
  check('T1c 守衛生效：dashboard 內容存活（幽靈渲染被擋）',
    container().innerHTML.includes('DASHBOARD-PAGE'), true);
  check('T1d 未偷渡學習分析 DOM', container().innerHTML.includes('學習分析'), false);
  check('T1d2 導航路徑留痕保留（渲染丟棄≠留痕丟棄）', simRuns.length, 1);
}
// 回頁：結果應已入列（丟棄的是畫面，不是資料）
s.state.currentPage = 'simulator';
renderPage();
check('T1e 回頁歷史 1 筆', historyBtns().length, 1);

// ═══ T2 切模式競態髒入列（audit 原句：切換模式時舊 render 失效） ═══
{
  const toastAt = toasts.length;
  click('[data-sim-mode="mc"]');   // 切模式：既有語意清空 _simResults
  check('T2a 切模式清空歷史（既有語意）', historyBtns().length, 0);
  check('T2b 切模式後 select 仍 custom 包裝（G14 同族：修前掉回原生）',
    !!container().querySelector('.cs-wrap'), !LEGACY);
  const runsAt = simRuns.length;
  click('#cliSimulate');            // mc 模式起模擬
  await tick();
  check('T2c mc 模擬 in-flight', inFlight(), 1);
  click('[data-sim-mode="spell"]'); // 中途切走 → 又清空
  releaseLast();                    // 舊 mc 模擬放閘
  await tick(80);
  if (LEGACY) {
    check('T2d-legacy 髒入列：舊 mc 結果進了 spell 歷史（bug 在場）',
      historyBtns().length, 1);
    check('T2e-legacy spell 頁渲染舊結果圖表（幽靈舊 render）',
      container().innerHTML.includes(CHART), true);
  } else {
    // FIX-3 狀態面：重進頁重渲染觀察（DOM 滯留幨破 M7）
    s.state.currentPage = 'simulator';
    renderPage();
    check('T2d 世代守衛：重進頁歷史 0 筆（舊 mc 結果未入列）', historyBtns().length, 0);
    check('T2e 拋棄 toast 正釘（FIX-2：靜默丟棄 M6 斃）', staleToast(toastAt), true);
    check('T2f 無完成 toast 誤報', toasts.slice(toastAt).some(([m]) => /模擬完成/.test(m)), false);
    check('T2g 無舊結果圖表', container().innerHTML.includes(CHART), false);
    // FIX-4 spy 釘：模式競態不留痕（addSimRun 須在守衛之後）
    check('T2h 競態零留痕（app-log spy）', simRuns.length, runsAt);
  }
}

// ═══ T3 workload / optimal 世代守衛同構 ═══
{
  const toastAt = toasts.length;
  click('#cliWorkload');
  await tick();
  check('T3a workload in-flight', inFlight(), 1);
  click('[data-sim-mode="flip"]');
  releaseLast();
  await tick(80);
  check('T3b flip 頁無「成本最低留存率」（舊 workload 未覆寫）',
    container().innerHTML.includes('成本最低留存率'), LEGACY);
  if (!LEGACY) check('T3b2 workload 拋棄 toast 正釘', staleToast(toastAt), true);
  const tAt2 = toasts.length;
  click('#cliOptimal');
  await tick();
  click('[data-sim-mode="mc"]');
  releaseLast();
  await tick(80);
  check('T3c mc 頁無「建議留存率」卡（舊 optimal 未覆寫）',
    container().innerHTML.includes('建議留存率'), LEGACY);
  if (!LEGACY) check('T3c2 optimal 拋棄 toast 正釘', staleToast(tAt2), true);
}

// ═══ T5 catch 路徑世代守衛（FIX-4，殺 M3：舊模式報錯不髒入列不貼新標籤） ═══
{
  const toastAt = toasts.length;
  const runsAt = simRuns.length;
  click('#cliSimulate');
  await tick();
  check('T5a in-flight', inFlight(), 1);
  click('[data-sim-mode="spell"]');
  rejectLast();                     // 舊 mc 模擬失敗放閘
  await tick(80);
  if (LEGACY) {
    check('T5b-legacy 舊模式錯誤髒入列＋渲染（pushSimEntry error 條目）',
      historyBtns().length >= 1, true);
    check('T5c-legacy 失敗照貼新模式標籤',
      toasts.slice(toastAt).some(([m]) => /模擬失敗/.test(m)), true);
  } else {
    s.state.currentPage = 'simulator';
    renderPage();
    check('T5b catch 世代守衛：spell 歷史 0 筆（舊錯誤不採納）', historyBtns().length, 0);
    check('T5c 無失敗 toast 誤報', toasts.slice(toastAt).some(([m]) => /模擬失敗/.test(m)), false);
    check('T5d 拋棄 toast 正釘（catch 路徑）', staleToast(toastAt), true);
    check('T5e catch 競態零留痕', simRuns.length, runsAt);
  }
}

// ═══ T5w/T5o workload/optimal catch 路徑（R2B-N3：三胞胎 catch 補齊） ═══
{
  const toastAt = toasts.length;
  click('#cliWorkload');
  await tick();
  click('[data-sim-mode="mc"]');
  rejectLast();
  await tick(80);
  if (LEGACY) {
    check('T5w-legacy 舊 workload 錯誤誤標失敗 toast（bug 在場）',
      toasts.slice(toastAt).some(([m]) => /失敗/.test(m)), true);
  } else {
    check('T5w workload catch 守衛：無失敗誤報＋拋棄正釘＋無舊錯誤落 DOM',
      [toasts.slice(toastAt).some(([m]) => /失敗/.test(m)), staleToast(toastAt),
        container().innerHTML.includes('engine boom')].join(','), 'false,true,false');
  }
  const tAt2 = toasts.length;
  click('#cliOptimal');
  await tick();
  click('[data-sim-mode="flip"]');
  rejectLast();
  await tick(80);
  if (LEGACY) {
    check('T5o-legacy 舊 optimal 錯誤誤標失敗 toast（bug 在場）',
      toasts.slice(tAt2).some(([m]) => /失敗/.test(m)), true);
  } else {
    check('T5o optimal catch 守衛：無失敗誤報＋拋棄正釘＋無舊錯誤落 DOM',
      [toasts.slice(tAt2).some(([m]) => /失敗/.test(m)), staleToast(tAt2),
        container().innerHTML.includes('engine boom')].join(','), 'false,true,false');
  }
}

// ═══ T6 正常路徑不傷釘（同模式完成必須入列＋渲染） ═══
{
  const toastAt = toasts.length;
  const runsAt = simRuns.length;
  click('#cliSimulate');
  await tick();
  releaseLast();
  await tick(80);
  // T5w 的切模式已依既有語意清空歷史（含 legacy 的 T5 error 條目）→ 雙態皆 1
  check('T6a 同模式完成 → 入列（守衛非一刀切）', historyBtns().length, 1);
  check('T6b 同模式完成 → 渲染結果圖表', container().innerHTML.includes(CHART), true);
  check('T6c 完成 toast 在場（快照化 FIX-6）', toasts.slice(toastAt).some(([m]) => /模擬完成/.test(m)), true);
  check('T6d 同模式正常留痕 +1', simRuns.length, runsAt + 1);
  // R2B-N6b：留痕 payload 資料面釘（only-count spy 對靜默壞欄全盲——補形狀觀察）
  const last = simRuns[simRuns.length - 1];
  check('T6e 留痕 payload 形狀（kind/days/seed 在場/totalReviews=6）',
    [last?.kind, last?.days, last?.seed !== undefined, last?.totalReviews].join(','),
    'simulate,2,true,6');
}

console.log(failures === 0
  ? `ALL PASS (${LEGACY ? 'legacy 負控制' : '修法後'})`
  : `${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
