#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G8 防回歸驗證 v1.1 — _simResults 無上限＋每筆全詞表快照 → 記憶體線性成長
//
// 用法:
//   node --experimental-test-module-mocks tools/verify-g8-simhistory-cap.mjs
//       → 修法後期望（cap 20＋無快照＋索引修正）ALL PASS
//   node --experimental-test-module-mocks /tmp/g8nc/tools/verify-g8-simhistory-cap.mjs --expect-legacy
//       → 負控制（HEAD 未修碼）ALL PASS
//
// v1.1（R1 三委員採納）:
//   FIX-1 mock 指紋僅計成功輪（R1#1-C2/#3-D1：原 simCalls++ 計失敗輪→T6 帳本必紅）
//   FIX-2 T2d/e/f 重寫：禁裸 push 時摳除 pushSimEntry 函式體再測（R1#1-C1/#2-⑥/#3-D2）
//   FIX-3 T2b 擴寬殺別名快照 params:req / Object.assign / structuredClone（R1#3-V10）
//   FIX-4 補 T9 成功輪自動顯示最新釘（殺 :333 選態 null 化漂移，R1#3-V7）
//   FIX-5 補 T10 stale DOM ref 邊界守衛釘（殺守衛漏裝，R1#3-V9）
//   FIX-6 補 T8 切模式選態重置釘＋T2g 靜態計數釘＋T8L 負控制辨證腿（R1#1-C4 REPRO）
// 注入（確定態）：simulateFsrs mock 成功第 N 輪回指紋 memorizedPerDay=[N]；
//   武裝開關 __simFail → 拋 boom-sim（錯誤條目路徑，不消耗指紋）。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';

const LEGACY = process.argv.includes('--expect-legacy');

// ── jsdom ──
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="pageContainer"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── mock 層 ──
let simCalls = 0;             // 僅成功計數（FIX-1：指紋帳本＝成功輪序）
globalThis.__simFail = false;
const toasts = [];
mock.module('../src/main.js', { exports: { toast: (m, t) => toasts.push([m, t]) } });
mock.module('../src/lib/svg.js', { exports: { icon: () => '<svg></svg>' } });
mock.module('../src/lib/app-log.js', { exports: { addSimRun: async () => {} } });
mock.module('../src/lib/api.js', {
  exports: {
    runCli: async () => '(stub)',
    getAppPaths: async () => ({ simLogsDir: '/tmp/sim-logs' }),
    simulateFsrs: async (req) => {
      if (globalThis.__simFail) throw new Error('boom-sim');
      simCalls++;
      return {
        memorizedPerDay: [simCalls],
        reviewPerDay: [simCalls],
        learnPerDay: [0],
        costPerDay: [simCalls],
      };
    },
  },
});

const sim = await import('../src/pages/simulator.js');

// ── 假 store（最小面） ──
function mkState() {
  const words = Array.from({ length: 50 }, (_, i) => ({ id: 'w' + i, word: 'w' + i }));
  const ankiCfg = { fsrsWeights: null, desiredRetention: 0.9, cardsPerDay: 80, maxReviewsPerDay: 1000, maxIvl: 365 };
  return {
    state: {
      words, cards: new Map(), cardsMc: new Map(), cardsSpell: new Map(),
      ankiSettings: ankiCfg, ankiSettingsMc: { ...ankiCfg }, ankiSettingsSpell: { ...ankiCfg },
      reviewLog: [], dayCutoff: 0, devMode: false,
    },
    actions: { navigate: () => {}, updateAnkiSettings: async () => {} },
  };
}
const s = mkState();
const container = () => document.getElementById('pageContainer');

function mount() {
  container().innerHTML = sim.render(s);
  sim.onMount(s);
}
const flush = () => new Promise(r => setTimeout(r, 60));

async function clickSimulate() {
  const btn = document.getElementById('cliSimulate');
  if (!btn) throw new Error('no #cliSimulate');
  btn.click();
  await flush();
}
async function clickSimulateFail() {
  globalThis.__simFail = true;
  await clickSimulate();
  globalThis.__simFail = false;
}
function setDays(n) { const el = document.getElementById('simDays'); if (el) el.value = String(n); }

// 圖表指紋 = 「末天記憶」stat（renderSimCharts 首 block，唯一錨點）
function chartFingerprint() {
  const m = container().innerHTML.match(/color:var\(--green\)">(\d+)<\/div><div style="font-size:11px;color:var\(--text-tertiary\)">末天記憶/);
  return m ? parseInt(m[1]) : null;
}
function chartError() {
  return /color:var\(--red\)">Error: boom-sim</.test(container().innerHTML);
}
function staleRedShown() {
  return container().innerHTML.includes('尚無模擬結果');
}
function historyBtns() {
  return [...container().querySelectorAll('[data-sim-history]')];
}
function clickHistory(i) {
  const b = historyBtns()[i];
  if (!b) throw new Error(`no history btn[${i}] (have ${historyBtns().length})`);
  b.click();
}
function clickMode(m) {
  const b = container().querySelector(`[data-sim-mode="${m}"]`);
  if (!b) throw new Error(`no mode btn ${m}`);
  b.click();
}
function clearLast() { document.getElementById('cliClearLast').click(); }

let failures = 0;
function check(label, got, expect) {
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

const SRC = readFileSync(new URL('../src/pages/simulator.js', import.meta.url), 'utf8');
const CAP = 20;

// ═══ 靜態源釘 T2 ═══
if (LEGACY) {
  check('T2a-legacy 源碼含全詞表快照（bug 在場）',
    /params:\s*\{\s*\.\.\.req\s*\}/.test(SRC), true);
  check('T2b-legacy 源碼無 SIM_HISTORY_MAX/pushSimEntry（防混入）',
    /SIM_HISTORY_MAX|pushSimEntry/.test(SRC), false);
} else {
  check('T2a entry 構造不含 params:{...req} 全詞表快照',
    /params:\s*\{\s*\.\.\.req\s*\}/.test(SRC), false);
  // FIX-3：別名/複製型快照全禁（V10 反規避）——entry 域禁裸 req（.cards/.days/.seed 標量讀除外）
  const aliasHit = /const entry\s*=\s*\{[^}]*\breq\b(?!\s*\.\s*(?:cards|days|seed)\b)/.test(SRC)
    || /entry\.params\s*=/.test(SRC)
    || /params:\s*req\b/.test(SRC)
    || /Object\.assign\([^)]*\breq\b/.test(SRC)
    || /structuredClone\(\s*req\b/.test(SRC);
  check('T2b entry 域無 req 展開/別名/深拷貝快照', aliasHit, false);
  check('T2c SIM_HISTORY_MAX 常數在場', /SIM_HISTORY_MAX\s*=/.test(SRC), true);
  // FIX-2：成功/錯誤條目雙軌釘＋裸 push 釘（摳除 pushSimEntry 函式體再測）
  check('T2d 成功條目走 pushSimEntry', /pushSimEntry\(\s*entry\s*\)/.test(SRC), true);
  check('T2e 錯誤條目同軌 pushSimEntry', /pushSimEntry\(\s*\{\s*error/.test(SRC), true);
  const hi = SRC.search(/function pushSimEntry\b/);
  const helper = hi >= 0 ? SRC.slice(hi, SRC.indexOf('\n}', hi) + 2) : '';
  check('T2f pushSimEntry 以外無裸 _simResults.push',
    SRC.replace(helper, '').includes('_simResults.push('), false);
  // FIX-6 靜態腿：選態 null 化出現 ≥4 處（宣告/:333/clearLast/切模式重置）
  check('T2g 選態 null 化靜態計數 ≥4（含切模式重置）',
    (SRC.match(/_simSelectedIndex\s*=\s*null/g) || []).length >= 4, true);
}

// ═══ T1 主鏈：25 輪成功模擬 ═══
mount();
setDays(1);
for (let i = 0; i < 25; i++) await clickSimulate();
check('T1a 指紋=最新輪(25)', chartFingerprint(), 25);

if (LEGACY) {
  check('T1b-legacy 無 cap → 歷史鈕 25 顆（bug 在場）', historyBtns().length, 25);
  check('T6L 錨定：指紋 25', chartFingerprint(), 25);
  clickHistory(historyBtns().length - 1); // 選中末筆(#25)
  clearLast();                            // pop → HEAD :361 置 null
  check('T6L clearLast 現行語意＝顯示最新（無紅字；cap 改造須保留）', staleRedShown(), false);
  // T8L-legacy 辨證：切模式選態殘留（HEAD :598 不重置）→ 錯誤輪 stale 紅字
  clickMode('mc');
  await clickSimulate();
  await clickSimulate();
  clickHistory(1);                  // mc 域選中 idx 1
  await clickSimulateFail();        // 錯誤條目入列，選態存活（界內）
  clickMode('flip');                // :598 清空，HEAD 不重置選態（殘留 1）
  await clickSimulateFail();        // flip=[error]，:571 讀 _simResults[1]=undefined
  check('T8L-legacy 切模式殘留選態→stale 紅字（bug 在場）', staleRedShown(), true);
} else {
  check('T1b cap 生效 → 歷史鈕 20 顆', historyBtns().length, CAP);
  check('T1c 「20 筆」標籤在場', container().innerHTML.includes(`${CAP} 筆`), true);

  // ═══ T5 錯誤條目計入 cap（錯誤輪不消耗指紋） ═══
  for (let i = 0; i < 3; i++) await clickSimulateFail();
  check('T5a 錯誤輪圖表=紅字（最新條目為 error）', chartError(), true);
  check('T5b cap 對錯誤條目同樣生效（20 顆）', historyBtns().length, CAP);
  check('T5c 選態預設=最新（error 條目無末天記憶 stat）', chartFingerprint(), null);

  // 帳本（指紋 N＝成功輪序）：[S9..S25,E1,E2,E3]（3 錯擠出 S6,S7,S8）
  // ═══ T3 選態跟隨 shift（錯誤擠出路徑；成功輪必 null 化＝:333 既有語意，另有 T9 釘） ═══
  clickHistory(2); // S11
  check('T3a 選中 #3=S11 指紋釘', chartFingerprint(), 11);
  await clickSimulateFail(); // E4 擠出 S9
  check('T3b shift 後選態跟隨同一条目（仍 S11，非 S12）', chartFingerprint(), 11);
  check('T3c 鈕數恆 20', historyBtns().length, CAP);

  // ═══ T4 選態恰被擠出 → 回退最新 ═══
  clickHistory(0); // S10
  check('T4a 選中頭部=S10 指紋釘', chartFingerprint(), 10);
  await clickSimulateFail(); // E5 擠出 S10（正被選中）
  check('T4b 選態跌出→回退顯示最新（E5 紅字，非 S11）', chartError(), true);
  check('T4c 回退態指紋非數字（非誤掛他條）', chartFingerprint(), null);

  // ═══ T6 clearLast 語意回歸釘（HEAD :361 已置 null，雙態恆綠） ═══
  await clickSimulate(); // S26 → 選態 null、最新=S26
  check('T6a 錨定：成功輪指紋 26', chartFingerprint(), 26);
  clickHistory(historyBtns().length - 1); // 選中末筆 S26
  check('T6b 選中末筆指紋 26', chartFingerprint(), 26);
  clearLast(); // pop S26 → 選態 null（HEAD 語意）
  check('T6c pop 後無「尚無模擬結果」紅字', staleRedShown(), false);
  check('T6d pop 後回退顯示最新有效條目（E5 紅字）', chartError(), true);

  // ═══ T10 stale DOM ref 邊界守衛釘（FIX-5，殺 V9） ═══
  clickHistory(historyBtns().length - 1);   // 選中末筆（此刻末筆=E5）
  const staleBtn = historyBtns()[historyBtns().length - 1]; // 捕過期 ref（索引 19）
  clearLast();                              // pop → 舊索引 19 越界（現長 19）
  staleBtn.click();                         // 過期 ref 以越界舊索引打進
  check('T10a 越界舊索引不採納（無 stale 紅字）', staleRedShown(), false);
  check('T10b 越界點擊後仍顯示最新有效條目（紅字域）', chartError(), true);

  // ═══ T9 成功輪必自動顯示最新（FIX-4，殺 :333 選態 null 化漂移 V7） ═══
  clickHistory(3); // 選中介條目
  const preFp = chartFingerprint();
  check('T9a 錨定：選中介條目指紋為數字', Number.isInteger(preFp), true);
  await clickSimulate(); // 成功輪 → 必須跳顯示最新
  check('T9b 成功輪自動顯示最新（選態 null 化語意釘）', chartFingerprint(), simCalls);

  // ═══ T7 模式切換清空（既有語意回歸釘） ═══
  clickMode('mc');
  check('T7 切 mc 後歷史清空→報告佔位', container().innerHTML.includes('尚未生成報告'), true);

  // ═══ T8 切模式選態重置釘（FIX-6，R1#1 REPRO 序列：選態→切模式→錯誤輪→stale 讀） ═══
  await clickSimulate();
  await clickSimulate();
  clickHistory(1);           // mc 域選中介條目（idx 1）
  await clickSimulateFail(); // 錯誤條目入列，選態存活（idx 1 界內）
  clickMode('flip');         // :598 清空——若選態未重置，下輪錯誤讀 stale → 紅字
  await clickSimulateFail();
  check('T8a 切模式+錯誤輪後無 stale 紅字（選態重置）', staleRedShown(), false);
  check('T8b flip 錯誤輪顯示最新條目（紅字 boom）', chartError(), true);
}

console.log(failures === 0 ? `ALL PASS (${LEGACY ? 'legacy 負控制' : '修法後'})` : `${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
