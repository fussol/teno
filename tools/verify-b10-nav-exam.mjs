// B10 驗證工具 — sidebar 導航離開測驗頁：存檔 on leave + module state 重置（回頁不跳中途）
// 方法：讀取 src/pages/exam-{flip,mc,spell}.js → 移除 import 行 → new Function 執行（stub 外部依賴）
//       → 注入「真實 buildSession」（src/core/exam-session.js，非手抄 stub）。
//       情境：startExam → 模擬測驗中途進度 → 模擬 sidebar 離開（main.js bindNav 設 window.__navFromSidebar=true
//       → renderPage 呼叫頁面註冊的 window.__pageCleanup）→ 斷言 saveExamSession 收到完整 session（含 mcData/pendingScore flush/timer 清理）
//       + e.phase='config'（state 重置）→ 模擬回頁 render/onMount → config UI（無測驗工具列 = 不跳中途）。
//       反向情境：bottom-nav 離開（無標記）→ 不存檔 + phase 殘留 exam → B1/B2「離開續答」語意保留。
//       既有行為：exit 按鈕仍存檔回 config（未動）。
// 負控制（mutation）：剝除三頁 B10 的 __pageCleanup 註冊行後重跑 → bug 必須再現
//       （無 cleanup、不存檔、phase 殘留 exam、回頁 render 直接測驗中途）— 證明本測試對 B10 修法敏感（無修法必紅）。
// main.js 接線（標記設定/清除）以靜態斷言驗證（main.js 為 app 入口無法在 harness 執行）。
// 全程不修改任何源碼；node tools/verify-b10-nav-exam.mjs 執行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

// ---------- 可控時鐘（buildSession id/timestamp 用 Date.now；counter 遞增消除同毫秒碰撞） ----------
let _now = 2_000_000;
const realDateNow = Date.now;
Date.now = () => _now++;

// ---------- clearTimeout spy（驗證 saveOnLeave 清理殘留 autoNext timer） ----------
const realClearTimeout = globalThis.clearTimeout;
let clearedTimers = [];
globalThis.clearTimeout = (id) => { clearedTimers.push(id); };

// ---------- DOM / 依賴 stub（對齊 verify-b5 既有 harness） ----------
function makeEl(id) {
  return {
    id,
    listeners: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    value: '', checked: true,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    remove() {}, focus() {}, scrollIntoView() {},
    innerHTML: '',
  };
}
const els = {};
// pageContainer.innerHTML 賦值 = 子節點重建 → 其餘 id 的 el 全部失效（下次 getElementById 建新 el，listener 不累積）
const pageContainerEl = makeEl('pageContainer');
let _pcHtml = '';
Object.defineProperty(pageContainerEl, 'innerHTML', {
  get() { return _pcHtml; },
  set(v) { _pcHtml = v; for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k]; },
});
els.pageContainer = pageContainerEl;
const documentStub = {
  getElementById(id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
  querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
  activeElement: null,
};
const windowStub = {};   // __navFromSidebar / __pageCleanup 都掛這（頁面讀寫 window.*）
const iconStub = () => '';
const toastStub = () => {};
const renderSavedSessionsStub = () => '';
const bindSpeakClickStub = () => {};
const splitFieldsHtmlStub = () => '';
const fmtExampleStub = () => '';

// ---------- 真實 buildSession（src/core/exam-session.js） ----------
function loadBuildSession() {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/exam-session.js'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function');
  const factory = new Function('icon', src + '\n;return { buildSession };');
  return factory(iconStub).buildSession;
}
const buildSessionReal = loadBuildSession();

// ---------- 頁面載入器（真實源碼 → new Function；可選 stripB10 = 剝除 B10 註冊行做負控制） ----------
function loadPage(file, exportNames, { stripB10 = false } = {}) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub
  delete windowStub.__pageCleanup;      // 重置跨 scenario 的 window 殘留
  delete windowStub.__navFromSidebar;
  let src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  if (stripB10) {
    const before = src;
    src = src.replace(/^[ \t]*window\.__pageCleanup[ \t]*=[ \t]*\(\)[ \t]*=>[ \t]*saveOnLeave\(s\);.*$/gm, '');
    if (src === before) throw new Error(`[harness] stripB10: 源碼中找不到 __pageCleanup 註冊行 — ${file}`);
  }
  const getters = exportNames.map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`).join(',');
  const factory = new Function('icon', 'toast', 'renderSavedSessions', 'buildSession', 'bindSpeakClick', 'splitFieldsHtml', 'fmtExample', 'document', 'window',
    src + `\n;return { ${getters} };`);
  return factory(iconStub, toastStub, renderSavedSessionsStub, buildSessionReal, bindSpeakClickStub, splitFieldsHtmlStub, fmtExampleStub, documentStub, windowStub);
}

// ---------- FakeStore：store.js:1777-1784 saveExamSession 逐行複刻 + 呼叫紀錄 ----------
function makeFakeStore(max = 5) {
  let list = [];
  const calls = [];
  return {
    list: () => list,
    calls,
    async saveExamSession(session) {
      calls.push(session);
      list = list.filter(s => s.id !== session.id);
      list.push(session);
      list.sort((a, b) => b.timestamp - a.timestamp);
      if (list.length > max) list.length = max;
    },
  };
}

// ---------- 情境工具 ----------
function baseWords(n, deckName = 'D') {
  return Array.from({ length: n }, (_, i) => ({ id: `w${i + 1}`, word: `word${i + 1}`, deck: deckName, tags: [], pos: '', definition: `def${i + 1}` }));
}
function baseState(words, currentPage) {
  return {
    state: { currentPage, decks: [{ id: 'd1', name: 'D' }], words,
      examSessions: [], maxExamSessions: 5, systemTags: [{ role: 'correct', name: 'C' }, { role: 'wrong', name: 'W' }], tags: [] },
    actions: { navigate() {}, saveExamSession: async () => {}, deleteExamSession: async () => {}, editWord: async () => {}, recordExam: async () => {} },
  };
}
function clickEl(mod, id, ...args) {
  const el = documentStub.getElementById(id);
  const fns = el.listeners.click || [];
  for (const fn of [...fns]) fn(...args);
  return fns.length;
}

const MODES = ['flip', 'mc', 'spell'];
const MODE_IDS = { flip: 'ef', mc: 'em', spell: 'es' };

// ---------- T1：sidebar 離開測驗中途 → 存檔 + state 重置（B10 主斷言） ----------
async function scenarioSidebarLeave(mode) {
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  const page = `exam-${mode}`;
  const mod = loadPage(file, ['render', 'onMount', 'startExam', 'e']);
  const prefix = MODE_IDS[mode];
  const s = baseState(baseWords(3), page);
  const fake = makeFakeStore();
  s.actions.saveExamSession = async (session) => { await fake.saveExamSession(session); };

  mod.e.decks = ['d1'];
  mod.startExam(s);
  assert(mod.e.phase === 'exam', `[${mode}] startExam 後 phase='exam'`);
  assert(typeof windowStub.__pageCleanup === 'function', `[${mode}] onMount(exam) 註冊 window.__pageCleanup（B10 掛鉤存在）`);

  // 模擬測驗中途進度（startExam 已 shuffle → wordIds 是排列，用排序後比較；mcData 以 word.id 為鍵 → 對 w1 物件設 _options）
  mod.e.idx = 2;
  mod.e.correct = 1;
  mod.e.wrong = 1;
  mod.e.results = [true, false, undefined];
  mod.e.pendingScore = 'correct';   // B2 延遲窗暫存 → leave 時必須 flush（correct 1→2）
  if (mode === 'mc') { mod.e.pendingNext = 777; } else { mod.e.autoNextTimer = 777; }
  if (mode === 'mc') {
    const w1 = mod.e.words.find(w => w.id === 'w1');
    w1._options = ['a', 'b', 'c', 'd'];
    w1._correctIdx = 2;
    w1._answered = true;
    w1._picked = 2;
  }
  clearedTimers = [];

  // 模擬 sidebar 點擊：main.js bindNav 設標記 → renderPage 跑上一頁的 __pageCleanup
  windowStub.__navFromSidebar = true;
  const cleanup = windowStub.__pageCleanup;
  cleanup();

  // ── 斷言 A：session 已存（內容完整）
  assert(fake.calls.length === 1, `[${mode}] sidebar 離開 → saveExamSession 被呼叫 1 次`);
  const session = fake.calls[0];
  assert(session.mode === mode && session.id && session.id.startsWith(`exam_${mode}_`), `[${mode}] session mode/id 正確（id=${session.id}）`);
  assert([...session.wordIds].sort().join() === 'w1,w2,w3', `[${mode}] session.wordIds 完整（3 字，順序為 shuffle 排列）`);
  assert(session.idx === 2 && session.correct === 2 && session.wrong === 1,
    `[${mode}] session idx=2/correct=2/wrong=1（pendingScore flush 生效：correct 1→2）`);
  assert(session.results[0] === true && session.results[1] === false && session.results[2] === undefined, `[${mode}] session.results 序列化完整`);
  assert(mod.e.pendingScore === null, `[${mode}] leave 後 pendingScore 已 flush 為 null`);
  assert(clearedTimers.includes(777), `[${mode}] leave 時殘留 timer 已 clearTimeout`);
  if (mode === 'mc') {
    const md = session.mcData && session.mcData['w1'];
    assert(md && md.options.join() === 'a,b,c,d' && md.correctIdx === 2 && md.answered === true && md.picked === 2,
      `[${mode}] session.mcData 收集完整（resume 可還原選項）`);
  }

  // ── 斷言 B：module state 重置（回頁不跳中途）
  assert(mod.e.phase === 'config', `[${mode}] sidebar 離開後 e.phase='config'（state 重置 — 回頁不跳中途）`);
  const html = mod.render(s);
  assert(html.includes(`${prefix}StartBtn`) && !html.includes('study-toolbar') && !html.includes(`${prefix}ExitBtn`),
    `[${mode}] 回頁 render → config UI（無測驗工具列/退出鈕 = 不跳中途）`);
  mod.onMount(s);
  assert(windowStub.__pageCleanup === undefined, `[${mode}] config onMount 後無 stale __pageCleanup`);

  // ── 斷言 C：冪等（phase guard — 重複觸發不雙存）
  windowStub.__navFromSidebar = true;
  if (windowStub.__pageCleanup) windowStub.__pageCleanup();
  assert(fake.calls.length === 1, `[${mode}] phase guard：重複觸發不雙存`);
  delete windowStub.__navFromSidebar;
}

// ---------- T2：bottom-nav 離開（無 sidebar 標記）→ 不存檔 + 續答語意保留（B1/B2 不受影響） ----------
function scenarioBottomNav(mode) {
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  const mod = loadPage(file, ['onMount', 'startExam', 'e']);
  const s = baseState(baseWords(3), `exam-${mode}`);
  const fake = makeFakeStore();
  s.actions.saveExamSession = async (session) => { await fake.saveExamSession(session); };

  mod.e.decks = ['d1'];
  mod.startExam(s);
  assert(typeof windowStub.__pageCleanup === 'function', `[${mode}] cleanup 已註冊`);
  windowStub.__navFromSidebar = false;   // bottom-nav 不設標記
  windowStub.__pageCleanup();
  assert(fake.calls.length === 0, `[${mode}] bottom-nav 離開 → 不存檔（B1/B2 續答語意保留）`);
  assert(mod.e.phase === 'exam', `[${mode}] bottom-nav 離開 → phase 仍 exam（回頁續答不受影響）`);
  delete windowStub.__navFromSidebar;
}

// ---------- T3：exit 按鈕既有行為不變（存檔 + 回 config） ----------
async function scenarioExitButton(mode) {
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  const mod = loadPage(file, ['onMount', 'startExam', 'e']);
  const s = baseState(baseWords(3), `exam-${mode}`);
  const fake = makeFakeStore();
  s.actions.saveExamSession = async (session) => { await fake.saveExamSession(session); };

  mod.e.decks = ['d1'];
  mod.startExam(s);
  clickEl(mod, `${MODE_IDS[mode]}ExitBtn`);
  await new Promise(r => setTimeout(r, 0));   // flush exit handler 的 await saveExamSession
  assert(fake.calls.length === 1, `[${mode}] exit 按鈕仍存檔（既有行為不變）`);
  assert(mod.e.phase === 'config', `[${mode}] exit 按鈕仍回 config（既有行為不變）`);
  assert(windowStub.__pageCleanup === undefined, `[${mode}] exit 後 stale __pageCleanup 已清`);
}

// ---------- T4：負控制（mutation：剝除三頁 B10 註冊行）→ bug 必須再現 ----------
function scenarioNegControl(mode) {
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  const mod = loadPage(file, ['render', 'onMount', 'startExam', 'e'], { stripB10: true });
  const s = baseState(baseWords(3), `exam-${mode}`);
  const fake = makeFakeStore();
  s.actions.saveExamSession = async (session) => { await fake.saveExamSession(session); };

  mod.e.decks = ['d1'];
  mod.startExam(s);
  assert(windowStub.__pageCleanup === undefined, `[${mode}] 負控制：無 B10 註冊 → 無 __pageCleanup（bug 前提再現）`);
  windowStub.__navFromSidebar = true;
  if (windowStub.__pageCleanup) windowStub.__pageCleanup();
  assert(fake.calls.length === 0, `[${mode}] 負控制：sidebar 離開不存檔（bug 再現）`);
  assert(mod.e.phase === 'exam', `[${mode}] 負控制：phase 殘留 exam（bug 再現）`);
  const html = mod.render(s);
  assert(html.includes('study-toolbar') && html.includes(`${MODE_IDS[mode]}ExitBtn`),
    `[${mode}] 負控制：回頁 render → 直接測驗中途（bug 實錘）`);
  delete windowStub.__navFromSidebar;
}

// ---------- 執行 ----------
console.log('=== T1 sidebar 導航離開測驗中途 → session 已存 + state 重置（回頁不跳中途） ===');
for (const mode of MODES) await scenarioSidebarLeave(mode);

console.log('=== T2 bottom-nav 離開 → 不存檔 + 續答語意保留（B1/B2 既有行為不受影響） ===');
for (const mode of MODES) scenarioBottomNav(mode);

console.log('=== T3 exit 按鈕既有行為不變 ===');
for (const mode of MODES) await scenarioExitButton(mode);

console.log('=== T4 負控制（mutation：剝除 B10 註冊行）→ bug 必須再現 ===');
for (const mode of MODES) scenarioNegControl(mode);

console.log('=== T5 main.js sidebar 標記接線（靜態檢查 — bindNav 設標記 / renderPage 清除） ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  assert(/window\.__navFromSidebar\s*=\s*true/.test(src), 'bindNav 設定 __navFromSidebar（sidebar 導航來源標記）');
  assert(/dataset\.page\s*!==\s*store\.state\.currentPage/.test(src), 'self-nav 不設標記（防 stale 標記 → 之後 bottom-nav 誤觸發）');
  assert(/delete window\.__navFromSidebar/.test(src), 'renderPage 消費後清除標記（防跨頁殘留）');
}

Date.now = realDateNow;
globalThis.clearTimeout = realClearTimeout;
console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
