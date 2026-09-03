#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G4b 防回歸驗證 — 里程碑/學習訊息終生制＋持久化（重啟不歸零不重播）
//
// 用法（需 mock.module 旗標）:
//   node --experimental-test-module-mocks tools/verify-g4b-milestone-persist.mjs
//       → 修法後 ALL PASS
//   node --experimental-test-module-mocks tools/verify-g4b-milestone-persist.mjs --expect-legacy
//       → 負控制 ALL PASS
//
// 重啟模擬：以新 query 重 import easter-eggs（模組級記憶體態歸零），
// 持久化正確性＝重啟後對同生涯計數不再重播。
// 語意釘（v1.1 定案 §3.3/3.4）：訊息=降序最高已達節點＋lastMsgAt 跳頂（中間永久跳過）；
// 里程碑=升序逐條補放。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';

const LEGACY = process.argv.includes('--expect-legacy');

// ── localStorage stub（全鍵可控）──
let LS = new Map();
globalThis.localStorage = {
  getItem: (k) => (LS.has(k) ? LS.get(k) : null),
  setItem: (k, v) => { LS.set(k, String(v)); },
  removeItem: (k) => { LS.delete(k); },
};

const { JSDOM } = await import('jsdom');
let dom = null;
function mkDoc() {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
}
mkDoc();
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

let toasts = [];
mock.module('../src/lib/toast.js', { exports: { toast(msg, cls) { toasts.push(msg); } } });

let failures = 0;
function check(label, got, expect) {
  const pass = got === expect;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}
let eeN = 0;
const importEE = () => import(`../src/lib/easter-eggs.js?g4b${eeN++}`); // 新模組實例＝重啟
const setRated = (n) => LS.set('_totalRated', JSON.stringify(n));
const overlayN = () => document.querySelectorAll('.milestone-overlay').length;
// 隔離調用（R1#3 必補#4）：實裝崩潰（讀寫態 .has TypeError 之類）只紅該釘＋標記錯誤，
// 不以 HARNESS ERROR 中止遮蔽後續 13 釘。
let lastErr = null;
function safe(fn) { lastErr = null; try { fn(); } catch (e) { lastErr = e; } }
const noThrow = (label) => check(`${label} 無異常`, lastErr && String(lastErr.message).slice(0, 60), null);

async function main() {
  const { readFileSync } = await import('node:fs');
  console.log(`\n═══ G4b 里程碑終生制＋持久化（${LEGACY ? '負控制：單 session 制＋重歸零必須重現' : '修法後'}）═══`);

  // ── T1 終生制觸發：_totalRated=10 → 最高已達節點「10 cards」toast（LEGACY 無參→零觸發）──
  LS = new Map(); mkDoc(); toasts = [];
  setRated(10);
  let ee = await importEE();
  safe(() => ee.checkStudyMessages()); noThrow('T1');
  check('T1 終生 10 卡 → 訊息觸發（修前=0 修後=1）', toasts.length, LEGACY ? 0 : 1);
  if (!LEGACY) check('T1 放最高節點文案（跳頂語意釘）', /10 cards/.test(toasts[0] || ''), true);
  safe(() => ee.checkStudyMessages());
  check('T1 同模組重複呼叫不重播', toasts.length, LEGACY ? 0 : 1);

  // ── T2 跨重啟不重播（封「吃終生數但不持久化」假修法；LEGACY 歸零無靶恆零）──
  ee = await importEE(); // 重啟（記憶體態歸零）
  safe(() => ee.checkStudyMessages()); noThrow('T2');
  check('T2 重啟後不重播（封無持久化假修法）', toasts.length, LEGACY ? 0 : 1);

  // ── T3 里程碑：終生 100 → overlay＋持久化；重啟不重播 ──
  LS = new Map(); mkDoc(); toasts = [];
  setRated(100);
  ee = await importEE();
  safe(() => ee.checkMilestone()); noThrow('T3 首觸發（封讀寫態 .has 崩潰遮蔽）');
  check('T3 終生 100 → 里程碑 overlay（修前=0 修後=1）', overlayN(), LEGACY ? 0 : 1);
  safe(() => ee.checkMilestone());
  check('T3 同模組不重播', overlayN(), LEGACY ? 0 : 1);
  ee = await importEE(); // 重啟
  safe(() => ee.checkMilestone()); noThrow('T3 重啟');
  check('T3 重啟後里程碑不重播（封無持久化假修法）', overlayN(), LEGACY ? 0 : 1);

  // ── T4 呼叫端 session 計數解耦 ＋ 簽名釘 ──
  const eng = readFileSync(new URL('../src/engine/session-utils.js', import.meta.url), 'utf8');
  check('T4a engine 呼叫點零參數（吃函式自取終生數）',
    /checkStudyMessages\(\);/.test(eng) && /checkMilestone\(\);/.test(eng) && !/checkMilestone\(session/.test(eng) ? 1 : 0,
    LEGACY ? 0 : 1);
  LS = new Map(); mkDoc(); toasts = [];
  setRated(0);
  ee = await importEE();
  check('T4b 簽名零形參（封「留預設參遮蔽」變體，§7 定案）',
    ee.checkStudyMessages.length === 0 && ee.checkMilestone.length === 0 ? 1 : 0, LEGACY ? 0 : 1);
  safe(() => { ee.checkStudyMessages(); ee.checkMilestone(); });
  check('T4c 終生 0 → 零觸發（兩態=0）', toasts.length + overlayN(), 0);

  // ── T5 髒資料降級不 crash ──
  LS = new Map(); mkDoc(); toasts = [];
  LS.set('_totalRated', 'abc');
  LS.set('_eggsShown', '{壞json');
  ee = await importEE();
  safe(() => { ee.checkStudyMessages(); ee.checkMilestone(); }); noThrow('T5 髒資料');
  check('T5 髒計數視為 0 → 零觸發（兩態）', toasts.length + overlayN(), 0);
  LS.set('_totalRated', JSON.stringify(5)); // 計數恢復、_eggsShown 仍壞
  safe(() => ee.checkStudyMessages()); noThrow('T5b 壞持久化＋有效計數');
  check('T5c 壞持久化降級預設 → FIXED 觸發/LEGACY 無靶', toasts.length, LEGACY ? 0 : 1);

  // ── T6 無 localStorage 環境不 throw（範圍限本單兩函式；checkAchievement 裸讀必拋屬
  //     既存缺陷 §6 另單域——納入即混單假紅，誠實排除實測登記）──
  mkDoc(); toasts = [];
  const savedLS = globalThis.localStorage;
  delete globalThis.localStorage;
  ee = await importEE();
  safe(() => { ee.checkStudyMessages(); ee.checkMilestone(); });
  globalThis.localStorage = savedLS;
  noThrow('T6 無 localStorage');

  // ── T7 靜態標記 ──
  const eeSrc = readFileSync(new URL('../src/lib/easter-eggs.js', import.meta.url), 'utf8');
  check('T7 easter-eggs G4b 標記', eeSrc.includes('// G4b:') ? 1 : 0, LEGACY ? 0 : 1);

  // ── T8 單調漸進＋最高節點語意＋重啟接續非重播（文字斷言封計數同形，R1#3 必補#2）──
  LS = new Map(); mkDoc(); toasts = [];
  setRated(5);
  ee = await importEE();
  safe(() => ee.checkStudyMessages());
  check('T8 @5 → 第一條', toasts.length, LEGACY ? 0 : 1);
  setRated(25); // 跳 10 → 最高已達=25 放 25 條（中間 10 永久跳過，v1.1 §3.3 定案）
  safe(() => ee.checkStudyMessages());
  check('T8 @25 → 放最高節點 25 cards 一條（LEGACY 無靶=零觸發）',
    LEGACY ? (toasts.length === 0 ? 1 : 0) : (toasts.length === 2 && /25 cards/.test(toasts[1]) ? 1 : 0), 1);
  ee = await importEE(); // 重啟（lastMsgAt=25 持久化）
  setRated(50);
  safe(() => ee.checkStudyMessages()); noThrow('T8 重啟');
  const joined = toasts.join('|');
  check('T8 重啟後 @50 → 第三條', toasts.length, LEGACY ? 0 : 3);
  if (!LEGACY) {
    check('T8 末條=50 cards（接續非重播文字釘）', /50 cards/.test(toasts[2] || ''), true);
    // 封計數同形：無持久化假修法重啟後會重播低節點 → '🌱 5'/'⚡ 25' 必恰好各出現一次
    check('T8 每低節點恰一次（重播偵測文字釘）',
      (joined.match(/🌱 5 cards/g) || []).length === 1 && (joined.match(/⚡ 25 cards/g) || []).length === 1, true);
  }

  // ── T9 中間帶探針（R2#1 缺項 2）：非節點 total 遞進零放——封「字面直譯無守衛」
  //     同節點轟炸重放版（26 釘全綠漏洞實錘）──
  LS = new Map(); mkDoc(); toasts = [];
  setRated(5);
  ee = await importEE();
  safe(() => ee.checkStudyMessages());
  check('T9 @5 第一條', toasts.length, LEGACY ? 0 : 1);
  setRated(7);
  safe(() => ee.checkStudyMessages());
  check('T9 @7 非節點零新增（守衛釘：無 m.at>lastMsgAt 條件版在此重放轉紅）',
    toasts.length, LEGACY ? 0 : 1);
  setRated(10);
  safe(() => ee.checkStudyMessages());
  check('T9 @10 恰一條「10 cards」',
    LEGACY ? (toasts.length === 0 ? 1 : 0) : (toasts.length === 2 && /10 cards/.test(toasts[1]) ? 1 : 0), 1);

  console.log(failures === 0 ? `\n=== G4b ${LEGACY ? '負控制' : ''} ALL PASS ===` : `\n=== ${failures} FAILURES ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(err => { console.error('HARNESS ERROR:', err); process.exit(1); });
