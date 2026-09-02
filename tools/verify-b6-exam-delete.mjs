// B6 驗證工具 — 測驗完成時刪除已存 session（resume 場），防 resume 重答剩餘題目、applyTags 重複套標籤
// 方法：讀取 src/pages/exam-{flip,mc,spell}.js → 移除 import 行 → new Function 執行（stub 外部依賴）
//       → 注入「真實 buildSession」（src/core/exam-session.js 同法載入，非手抄 stub）。
// 完成路徑（三頁皆收斂到 recordExamResult helper，B6 刪除邏輯集中於該 helper 尾端）：
//   flip：resume 全答完（resumeSession firstUn===-1）/ nextWord 末題 / 手動查看結果按鈕 — 3 路徑
//   mc  ：nextWord 末題（含 B3 armJump 收斂）/ 手動查看結果按鈕 — 2 路徑
//   spell：nextWord 末題 / 手動查看結果按鈕 — 2 路徑
// 情境（每 mode）：
//   T1a nextWord 末題收斂（autoNext timer fire 等效）→ resume 場完成 → session 刪除
//   T1b 手動查看結果按鈕（逐題真實作答 + 末題按鈕）→ resume 場完成 → session 刪除
//   T1c flip 專屬：resume 全答完 → resumeSession 直接進 result → session 刪除
//   T2  新場（startExam，e.id=undefined）完成 → 不誤刪他人 session、deleteExamSession 零呼叫
//   T3  deleteExamSession 失敗 → 不噴錯、session 保留、e.id 保留（config 列表仍可手動刪）
//   T4  防重：同場 recordExamResult 兩次 → deleteExamSession 只呼叫一次
//   T5  負控制（mutation：剝除三頁 B6 區塊）→ bug 必須再現（session 未刪除、delete 零呼叫）
// 全程不修改任何源碼；node tools/verify-b6-exam-delete.mjs 執行。
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

// ---------- 可控時鐘（buildSession id/timestamp 用 Date.now；counter 遞增保證 id 不碰撞） ----------
let _now = 1_000_000;
const realDateNow = Date.now;
Date.now = () => _now++;

// ---------- DOM / 依賴 stub（對齊 verify-b3/b5 既有 harness） ----------
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

// ---------- 真實 buildSession（src/core/exam-session.js） ----------
function loadBuildSession() {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/exam-session.js'), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function');
  const factory = new Function('icon', src + '\n;return { buildSession };');
  return factory(iconStub).buildSession;
}
const buildSessionReal = loadBuildSession();

// ---------- 頁面載入器（真實源碼 → new Function；stripB6 = 剝除 B6 區塊做負控制） ----------
const EXTRA_EXPORTS = {
  'flip': ['answerCorrect', 'answerWrong'],
  'mc': ['pickOption'],
  'spell': ['submitSpelling'],
};
function loadPage(mode, { stripB6 = false } = {}) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  let src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  if (stripB6) {
    const before = src;
    // B6 區塊 = recordExamResult 尾端「// B6:」註解至 `if (e.id) {...}` 的 2-space closing `  }`（其後為函數 closing `}` + 空行 + nextWord）
    src = src.replace(/\n  \/\/ B6:[\s\S]*?\n  \}\n/, '\n');
    if (src === before) throw new Error(`[harness] stripB6: 源碼中找不到 B6 區塊 — ${file}`);
  }
  const exportNames = ['render', 'onMount', 'startExam', 'resumeSession', 'e', 'nextWord', 'recordExamResult', 'renderInPlace', 'applyTags', 'flushPendingScore', ...(EXTRA_EXPORTS[mode] || [])];
  const getters = exportNames.map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`).join(',');
  const factory = new Function('icon', 'toast', 'renderSavedSessions', 'buildSession', 'bindSpeakClick', 'splitFieldsHtml', 'fmtExample', 'document', 'window',
    src + `\n;return { ${getters} };`);
  return factory(iconStub, toastStub, renderSavedSessionsStub, buildSessionReal, bindSpeakClickStub, splitFieldsHtmlStub, fmtExampleStub, documentStub, windowStub);
}

// ---------- FakeStore：store.js saveExamSession/deleteExamSession 語意複刻 + 呼叫計數 ----------
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
    async deleteExamSession(id) {
      list = list.filter(s => s.id !== id);
    },
  };
}

// ---------- 情境工具 ----------
function baseWords(n, deckName = 'D') {
  return Array.from({ length: n }, (_, i) => ({ id: `w${i + 1}`, word: `word${i + 1}`, deck: deckName, tags: [], pos: '', definition: `def${i + 1}` }));
}
function baseState(words, currentPage, actions) {
  return {
    state: { currentPage, decks: [{ id: 'd1', name: 'D' }], words,
      examSessions: [], maxExamSessions: 5, systemTags: [{ role: 'correct', name: 'C' }, { role: 'wrong', name: 'W' }], tags: [] },
    actions: {
      navigate() {}, saveExamSession: async () => {}, deleteExamSession: async () => {},
      recordExam: async () => {}, editWord: async () => {}, ...(actions || {}),
    },
  };
}
function clickEl(mod, id, ...args) {
  const el = documentStub.getElementById(id);
  const fns = el.listeners.click || [];
  for (const fn of [...fns]) fn(...args);
  return fns.length;
}
const flushAsync = () => new Promise(r => setTimeout(r, 0));

// seed session：resume 的輸入（三 mode 通用；mc 附 mcData；spell 無 results）
function makeSeedSession(mode, words, { answered = [true, undefined, undefined], idx = 1, autoNext = false } = {}) {
  const s = {
    id: `seed_${mode}_1`,
    mode,
    timestamp: 1,
    deckIds: ['d1'],
    wordIds: words.map(w => w.id),
    idx,
    correct: 1,
    wrong: 0,
    totalTime: 3,
    wordCount: words.length,
    settings: { count: 0, autoNext, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
  };
  if (mode !== 'spell') s.results = [...answered];
  if (mode === 'mc') {
    s.mcData = {};
    words.forEach((w, i) => {
      s.mcData[w.id] = {
        options: words.map(x => x.word), correctIdx: 0,
        answered: answered[i] === true, picked: answered[i] === true ? 0 : -1,
      };
    });
  }
  return s;
}

// ---------- T1a：resume → nextWord 末題收斂 → session 刪除 ----------
async function t1a(mode) {
  const page = `exam-${mode}`;
  const mod = loadPage(mode);
  const words = baseWords(3);
  const seed = makeSeedSession(mode, words);
  const fake = makeFakeStore();
  await fake.saveExamSession(seed);
  let deleteCalls = 0;
  const s = baseState(words, page, {
    deleteExamSession: async (id) => { deleteCalls++; await fake.deleteExamSession(id); },
  });

  mod.resumeSession(s, seed);                       // e.id = seed.id，phase='exam'
  assert(mod.e.id === seed.id, `[${mode}] T1a resumeSession 設 e.id = seed.id（resume 場前提）`);
  mod.e.idx = mod.e.words.length - 1;               // 末題（timer fire / 手動下一題收斂等效）
  mod.nextWord(s);
  assert(mod.e.phase === 'result', `[${mode}] T1a nextWord 末題 → phase='result'`);
  await flushAsync(); await flushAsync();
  assert(deleteCalls === 1, `[${mode}] T1a deleteExamSession 恰呼叫 1 次（got=${deleteCalls}）`);
  assert(!fake.list().some(x => x.id === seed.id), `[${mode}] T1a 已存 session 被刪除（resume 場完成即清理）`);
  assert(mod.e.id === undefined, `[${mode}] T1a 刪成功後 e.id 清為 undefined`);
}

// ---------- T1b：resume → 逐題真實作答 → 末題手動「查看結果」按鈕 → session 刪除 ----------
async function t1b(mode) {
  const page = `exam-${mode}`;
  const mod = loadPage(mode);
  const words = baseWords(3);
  const seed = makeSeedSession(mode, words, { answered: [undefined, undefined, undefined], idx: 0, autoNext: false });
  const fake = makeFakeStore();
  await fake.saveExamSession(seed);
  let deleteCalls = 0;
  const s = baseState(words, page, {
    deleteExamSession: async (id) => { deleteCalls++; await fake.deleteExamSession(id); },
  });

  mod.resumeSession(s, seed);
  const nextBtn = mode === 'flip' ? 'efNextBtn' : mode === 'mc' ? 'emNextBtn' : 'esNextBtn';
  for (let i = 0; i < 3; i++) {
    if (mode === 'flip') mod.answerCorrect(s);
    else if (mode === 'mc') mod.pickOption(s, 0);
    else {
      documentStub.getElementById('esInput').value = mod.e.words[mod.e.idx].word;
      mod.submitSpelling(s);
    }
    clickEl(mod, nextBtn);                           // i<2 → nextWord；i===2 → 手動完成（查看結果）
  }
  assert(mod.e.phase === 'result', `[${mode}] T1b 末題按鈕 → phase='result'`);
  await flushAsync(); await flushAsync();
  assert(deleteCalls === 1, `[${mode}] T1b 手動完成 → deleteExamSession 恰 1 次（got=${deleteCalls}）`);
  assert(!fake.list().some(x => x.id === seed.id), `[${mode}] T1b 手動完成 → 已存 session 被刪除`);
}

// ---------- T1c（flip 專屬）：resume 全答完 → resumeSession 直接進 result → session 刪除 ----------
async function t1cFlip() {
  const mod = loadPage('flip');
  const words = baseWords(3);
  const seed = makeSeedSession('flip', words, { answered: [true, false, true], idx: 2 });
  const fake = makeFakeStore();
  await fake.saveExamSession(seed);
  let deleteCalls = 0;
  const s = baseState(words, 'exam-flip', {
    deleteExamSession: async (id) => { deleteCalls++; await fake.deleteExamSession(id); },
  });

  mod.resumeSession(s, seed);                        // firstUn === -1 → 直接結果頁
  assert(mod.e.phase === 'result', `[flip] T1c resume 全答完 → resumeSession 直接 phase='result'`);
  await flushAsync(); await flushAsync();
  assert(deleteCalls === 1, `[flip] T1c resume 全答完 → deleteExamSession 恰 1 次（got=${deleteCalls}）`);
  assert(!fake.list().some(x => x.id === seed.id), `[flip] T1c resume 全答完 → 已存 session 被刪除`);
}

// ---------- T2：新場（startExam，e.id=undefined）完成 → 不誤刪、delete 零呼叫 ----------
async function t2(mode) {
  const page = `exam-${mode}`;
  const mod = loadPage(mode);
  const words = baseWords(3);
  const fake = makeFakeStore();
  const otherSameMode = { ...makeSeedSession(mode, words, { idx: 0 }), id: `other_${mode}_x` };
  const otherDiffMode = { ...makeSeedSession(mode === 'flip' ? 'mc' : 'flip', words, { idx: 0 }), id: `other_${mode === 'flip' ? 'mc' : 'flip'}_x` };
  await fake.saveExamSession(otherSameMode);
  await fake.saveExamSession(otherDiffMode);
  let deleteCalls = 0;
  const s = baseState(words, page, {
    deleteExamSession: async (id) => { deleteCalls++; await fake.deleteExamSession(id); },
  });

  mod.e.decks = ['d1'];
  mod.startExam(s);                                  // B5: e.id = undefined
  assert(mod.e.id === undefined, `[${mode}] T2 startExam 後 e.id 為 undefined（新場無 session 可刪）`);
  mod.e.idx = mod.e.words.length - 1;
  mod.nextWord(s);
  assert(mod.e.phase === 'result', `[${mode}] T2 新場完成 → phase='result'`);
  await flushAsync(); await flushAsync();
  assert(deleteCalls === 0, `[${mode}] T2 新場完成 → deleteExamSession 零呼叫（got=${deleteCalls}）`);
  assert(fake.list().some(x => x.id === otherSameMode.id) && fake.list().some(x => x.id === otherDiffMode.id),
    `[${mode}] T2 他人 session（同 mode / 異 mode）皆未誤刪`);
}

// ---------- T3：deleteExamSession 失敗 → 不噴錯、session 保留、e.id 保留 ----------
async function t3(mode) {
  const page = `exam-${mode}`;
  const mod = loadPage(mode);
  const words = baseWords(3);
  const seed = makeSeedSession(mode, words);
  const fake = makeFakeStore();
  await fake.saveExamSession(seed);
  let deleteCalls = 0;
  const s = baseState(words, page, {
    deleteExamSession: async (id) => { deleteCalls++; throw new Error('simulated delete failure'); },
  });

  mod.resumeSession(s, seed);
  mod.e.phase = 'result';
  let threw = false;
  try { await mod.recordExamResult(s); } catch (err) { threw = true; }
  assert(!threw, `[${mode}] T3 deleteExamSession 失敗 → recordExamResult 不噴錯（catch + warn）`);
  assert(deleteCalls === 1, `[${mode}] T3 失敗路徑仍嘗試刪除 1 次（got=${deleteCalls}）`);
  assert(fake.list().some(x => x.id === seed.id), `[${mode}] T3 刪除失敗 → session 保留在 store（config 列表可手動刪）`);
  assert(mod.e.id === seed.id, `[${mode}] T3 刪除失敗 → e.id 保留（不誤清）`);
}

// ---------- T4：防重 — 同場 recordExamResult 兩次 → deleteExamSession 只呼叫一次 ----------
async function t4(mode) {
  const page = `exam-${mode}`;
  const mod = loadPage(mode);
  const words = baseWords(3);
  const seed = makeSeedSession(mode, words);
  const fake = makeFakeStore();
  await fake.saveExamSession(seed);
  let deleteCalls = 0;
  const s = baseState(words, page, {
    deleteExamSession: async (id) => { deleteCalls++; await fake.deleteExamSession(id); },
  });

  mod.resumeSession(s, seed);
  mod.e.phase = 'result';
  await mod.recordExamResult(s);
  await mod.recordExamResult(s);                     // 第二次：examRecorded 旗標 → early return
  assert(deleteCalls === 1, `[${mode}] T4 重複 recordExamResult → deleteExamSession 仍只 1 次（got=${deleteCalls}）`);
  assert(!fake.list().some(x => x.id === seed.id), `[${mode}] T4 session 已刪除`);
}

// ---------- T5：負控制（stripB6）→ bug 必須再現（session 未刪除、delete 零呼叫） ----------
async function t5(mode) {
  const page = `exam-${mode}`;
  const mod = loadPage(mode, { stripB6: true });
  const words = baseWords(3);
  const seed = makeSeedSession(mode, words);
  const fake = makeFakeStore();
  await fake.saveExamSession(seed);
  let deleteCalls = 0;
  const s = baseState(words, page, {
    deleteExamSession: async (id) => { deleteCalls++; await fake.deleteExamSession(id); },
  });

  mod.resumeSession(s, seed);
  mod.e.idx = mod.e.words.length - 1;
  mod.nextWord(s);
  await flushAsync(); await flushAsync();
  assert(deleteCalls === 0, `[${mode}] T5 負控制：無 B6 → deleteExamSession 零呼叫（bug 前提再現）`);
  assert(fake.list().some(x => x.id === seed.id), `[${mode}] T5 負控制：無 B6 → session 未被刪除（可無限 resume 重答 = bug 實錘）`);
}

// ---------- T0 靜態：三頁源碼皆含 B6 刪除區塊 ----------
console.log('=== T0 B6 修法在場（三頁 recordExamResult 尾端皆有刪除區塊） ===');
for (const mode of ['flip', 'mc', 'spell']) {
  const src = fs.readFileSync(path.join(ROOT, `src/pages/exam-${mode}.js`), 'utf8');
  assert(src.includes('// B6: 完成後刪除已存 session'), `[${mode}] 源碼含 B6 註解`);
  assert(src.includes('await s.actions.deleteExamSession(e.id)'), `[${mode}] 源碼含 deleteExamSession(e.id) 呼叫`);
  assert((src.match(/await s\.actions\.deleteExamSession\(e\.id\)/g) || []).length === 1, `[${mode}] 刪除呼叫恰 1 處（集中於 recordExamResult）`);
}

console.log('=== T1a nextWord 末題收斂 → resume 場完成 → session 刪除 ===');
await t1a('flip'); await t1a('mc'); await t1a('spell');

console.log('=== T1b 手動查看結果按鈕（逐題真實作答）→ resume 場完成 → session 刪除 ===');
await t1b('flip'); await t1b('mc'); await t1b('spell');

console.log('=== T1c flip 專屬：resume 全答完 → 直接結果頁 → session 刪除 ===');
await t1cFlip();

console.log('=== T2 新場完成 → 不誤刪他人 session、delete 零呼叫 ===');
await t2('flip'); await t2('mc'); await t2('spell');

console.log('=== T3 deleteExamSession 失敗 → 不噴錯、session/e.id 保留 ===');
await t3('flip'); await t3('mc'); await t3('spell');

console.log('=== T4 防重：重複 recordExamResult → delete 只呼叫一次 ===');
await t4('flip'); await t4('mc'); await t4('spell');

console.log('=== T5 負控制（mutation：剝除三頁 B6 區塊）→ bug 必須再現 ===');
await t5('flip'); await t5('mc'); await t5('spell');

Date.now = realDateNow;
console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
