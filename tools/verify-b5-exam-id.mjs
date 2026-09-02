// B5 驗證工具 — startExam 重置 e.id，防新測驗覆蓋已存 session
// 方法：讀取 src/pages/exam-{flip,mc,spell}.js → 移除 import 行 → new Function 執行（stub 外部依賴）
//       → 注入「真實 buildSession」（src/core/exam-session.js 同法載入，非手抄 stub — B5 的 id 產生邏輯必須測真品）。
// FakeStore 依 store.js:1658-1666 saveExamSession 逐行複刻（filter 同 id → push → sort desc → cap max）。
// 情境：場1 全新測驗退出存 session1 → resumeSession（設 e.id=session1.id）→ 場2 新測驗 startExam → 退出存 session2
//       → 斷言 session2.id ≠ session1.id 且兩筆並存（舊 session 不被覆蓋）。
// 負控制（mutation）：將 B5 重置行從源碼剝除後重跑同流程 → bug 必須再現（session2 沿用舊 id、舊 session 被覆蓋）
//       — 證明本測試對 B5 修法敏感（無修法必紅）。
// 全程不修改任何源碼；node tools/verify-b5-exam-id.mjs 執行。
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

// ---------- 可控時鐘（buildSession id/timestamp 用 Date.now；counter 遞增保證產生 id 不碰撞、排序確定） ----------
let _now = 1_000_000;
const realDateNow = Date.now;
Date.now = () => _now++;

// ---------- DOM / 依賴 stub（對齊 verify-b3 既有 harness） ----------
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
const windowStub = {};
const iconStub = () => '';
const toastStub = () => {};
const renderSavedSessionsStub = () => '';
const bindSpeakClickStub = () => {};
const splitFieldsHtmlStub = () => '';
const fmtExampleStub = () => '';

// ---------- 真實 buildSession（src/core/exam-session.js — B5 關鍵：id = e.id || `exam_${mode}_${Date.now()}`） ----------
function loadBuildSession() {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/exam-session.js'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function');
  const factory = new Function('icon', src + '\n;return { buildSession };');
  return factory(iconStub).buildSession;
}
const buildSessionReal = loadBuildSession();

// ---------- 頁面載入器（真實源碼 → new Function；可選 stripB5 = 剝除 B5 重置行做負控制） ----------
function loadPage(file, exportNames, { stripB5 = false } = {}) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub
  let src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  if (stripB5) {
    const before = src;
    src = src.replace(/^[ \t]*e\.id[ \t]*=[ \t]*(?:undefined|null)[ \t]*;.*$/gm, '');
    if (src === before) throw new Error(`[harness] stripB5: 源碼中找不到 e.id 重置行 — ${file}`);
  }
  const getters = exportNames.map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`).join(',');
  const factory = new Function('icon', 'toast', 'renderSavedSessions', 'buildSession', 'bindSpeakClick', 'splitFieldsHtml', 'fmtExample', 'document', 'window',
    src + `\n;return { ${getters} };`);
  return factory(iconStub, toastStub, renderSavedSessionsStub, buildSessionReal, bindSpeakClickStub, splitFieldsHtmlStub, fmtExampleStub, documentStub, windowStub);
}

// ---------- FakeStore：store.js:1658-1666 saveExamSession 逐行複刻 ----------
function makeFakeStore(max = 5) {
  let list = [];
  return {
    list: () => list,
    async saveExamSession(session) {
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
    actions: { navigate() {}, saveExamSession: async () => {}, deleteExamSession: async () => {}, editWord: async () => {} },
  };
}
function clickEl(mod, id, ...args) {
  const el = documentStub.getElementById(id);
  const fns = el.listeners.click || [];
  for (const fn of [...fns]) fn(...args);
  return fns.length;
}
// 真實 exit handler：click 退出鈕 → handler await saveExamSession（走 FakeStore 真邏輯）→ flush microtask
async function exitAndSave(mod, s, fake) {
  s.actions.saveExamSession = async (session) => { await fake.saveExamSession(session); };
  clickEl(mod, mod.__exitBtn);
  s.actions.saveExamSession = async () => {};
  await new Promise(r => setTimeout(r, 0));
  return fake.list()[0];   // sort desc by timestamp → 最新 = 剛存的
}

// ---------- B5 情境（每 mode 一輪） ----------
async function runScenario(mode, { stripB5 = false } = {}) {
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  const page = `exam-${mode}`;
  const mod = loadPage(file, ['render', 'onMount', 'startExam', 'resumeSession', 'e'], { stripB5 });
  mod.__exitBtn = mode === 'flip' ? 'efExitBtn' : mode === 'mc' ? 'emExitBtn' : 'esExitBtn';
  const words = baseWords(3);
  const s = baseState(words, page);
  const fake = makeFakeStore();
  mod.e.decks = ['d1'];

  // 場 1：全新測驗（e.id 初始 undefined）→ 退出 → 存 session1（buildSession 產生新 id）
  mod.startExam(s);
  assert(mod.e.id === undefined, `[${mode}] 場1 startExam 後 e.id 為 undefined（初始無 session id）`);
  const session1 = await exitAndSave(mod, s, fake);
  assert(session1.id && session1.id.startsWith(`exam_${mode}_`), `[${mode}] session1.id 由 buildSession 產生（exam_${mode}_* = ${session1.id}）`);
  assert(fake.list().length === 1, `[${mode}] 場1 退出 → 存 1 筆`);

  // resume：真實 resumeSession 設 e.id = session.id（既有行為，不變）
  mod.resumeSession(s, session1);
  assert(mod.e.id === session1.id, `[${mode}] resumeSession 設 e.id = session.id（既有行為保留）`);

  // 場 2：新測驗 startExam
  mod.startExam(s);
  if (!stripB5) {
    assert(mod.e.id === undefined, `[${mode}] 場2 startExam 重置 e.id（B5 主斷言 — 舊 id 不殘留）`);
  } else {
    assert(mod.e.id === session1.id, `[${mode}] 負控制：無 B5 重置 → 舊 id 殘留在 e（bug 前提再現）`);
  }
  const session2 = await exitAndSave(mod, s, fake);

  if (!stripB5) {
    assert(session2.id !== session1.id, `[${mode}] session2.id ≠ session1.id（新場產生新 id：${session2.id} vs ${session1.id}）`);
    assert(fake.list().length === 2, `[${mode}] 兩筆 session 並存（舊 session 未被覆蓋）`);
    assert(fake.list().some(x => x.id === session1.id) && fake.list().some(x => x.id === session2.id), `[${mode}] 兩筆 id 各自存在於 store`);
    const old = fake.list().find(x => x.id === session1.id);
    assert(old.idx === session1.idx && old.correct === session1.correct && old.wrong === session1.wrong,
      `[${mode}] 舊 session（id=${session1.id}）內容保留場1 資料（idx/correct/wrong 未被新場覆寫）`);
  } else {
    assert(session2.id === session1.id, `[${mode}] 負控制：無重置 → session2 沿用舊 id（覆蓋機制再現）`);
    assert(fake.list().length === 1, `[${mode}] 負控制：舊 session 被新場覆蓋（僅剩 1 筆 = bug 實錘）`);
  }
}

// ---------- 核心層契約：buildSession 的 id 產生 ----------
console.log('=== T0 buildSession id 契約（src/core/exam-session.js 真品） ===');
{
  const e0 = { decks: ['d1'], words: [{ id: 'a' }, { id: 'b' }], idx: 0, correct: 0, wrong: 0, totalTime: 0, settings: {} };
  const s1 = buildSessionReal(e0, 'flip');
  const s2 = buildSessionReal(e0, 'flip');
  assert(s1.id !== s2.id, 'e.id 為空 → 每次產生新 id（Date.now 遞增下不碰撞）');
  assert(s1.id.startsWith('exam_flip_') && s2.id.startsWith('exam_flip_'), '產生格式 exam_<mode>_<ts>');
  const e1 = { ...e0, id: 'exam_flip_123' };
  assert(buildSessionReal(e1, 'flip').id === 'exam_flip_123', 'e.id 有值 → 沿用（resume 語意 — 這是 bug 的載體，必須被 startExam 重置）');
}

console.log('=== T1 flip：resume 後開新測驗 → 舊 session 不被覆蓋 ===');
await runScenario('flip');

console.log('=== T2 mc：resume 後開新測驗 → 舊 session 不被覆蓋 ===');
await runScenario('mc');

console.log('=== T3 spell：resume 後開新測驗 → 舊 session 不被覆蓋 ===');
await runScenario('spell');

console.log('=== T4 負控制（mutation：剝除三頁 B5 重置行）→ bug 必須再現 ===');
await runScenario('flip', { stripB5: true });
await runScenario('mc', { stripB5: true });
await runScenario('spell', { stripB5: true });

Date.now = realDateNow;
console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
