// B8 驗證工具 — 測驗暫存 _ 欄位不得污染 state.words 活參考（跨頁殘留 / editWord 保留污染）
// Bug 事實（audit）：exam-mc startExam/resumeSession 直接對 pool 的 word 物件加
//   _options/_correctIdx/_answered/_picked/_noScore；exam-spell submitSpelling 寫 w._correct —
//   這些 word 來自 s.state.words 的同一物件（活參考）→ 測驗結束後 state.words 仍帶殘留；
//   且 store.editWord 的 `{...state.words[idx], ...updates}` spread 會保留 _ 欄位於新物件。
// 修法（B8 決策：深拷貝 — startExam/resumeSession 對 pool/wordMap 結果做 {...w} 淺拷貝，
//   測驗操作全部落在副本；spell 舊場 _correct 改由 session.spellData 序列化還原（B4 語意保持））：
//   src/pages/exam-mc.js   :214 startExam `pool.map(w => ({...w}))`、:249 resumeSession 同
//   src/pages/exam-spell.js :217 startExam 同、:241 resumeSession 同＋spellData 還原、
//                            collectSpellData() 於 saveOnLeave/exit 序列化進 session
//   負控制（mutation）：剝除 `.map(w => ({ ...w }))` 兩處 → 污染必須再現（測試對修法敏感）。
// 全程不修改任何源碼；node tools/verify-b8-temp-fields.mjs 執行。
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

// ---------- DOM / 依賴 stub（對齊 verify-b5/b6/b7 既有 harness） ----------
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

// ---------- 頁面載入器（真實源碼 → new Function；stripB8 = 剝除深拷貝做負控制） ----------
const EXTRA_EXPORTS = {
  'flip': ['answerCorrect', 'answerWrong'],
  'mc': ['pickOption', 'saveOnLeave'],
  'spell': ['submitSpelling', 'saveOnLeave'],
};
function loadPage(mode, { stripB8 = false } = {}) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  let src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  if (stripB8) {
    const before = src;
    // 剝除 B8 深拷貝（兩處 `.map(w => ({ ...w }))`）→ 回到活參考（bug 前提）
    src = src.replace(/\.map\(w => \(\{ \.\.\.w \}\)\)/g, '');
    if (src === before) throw new Error(`[harness] stripB8: 源碼中找不到深拷貝 — ${file}`);
  }
  const exportNames = ['render', 'onMount', 'startExam', 'resumeSession', 'e', 'nextWord', 'recordExamResult', 'renderInPlace', 'applyTags', 'flushPendingScore', ...(EXTRA_EXPORTS[mode] || [])];
  const getters = exportNames.map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`).join(',');
  const factory = new Function('icon', 'toast', 'renderSavedSessions', 'buildSession', 'bindSpeakClick', 'splitFieldsHtml', 'fmtExample', 'document', 'window',
    src + `\n;return { ${getters} };`);
  return factory(iconStub, toastStub, renderSavedSessionsStub, buildSessionReal, bindSpeakClickStub, splitFieldsHtmlStub, fmtExampleStub, documentStub, windowStub);
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
function clickEl(mod, id) {
  const el = documentStub.getElementById(id);
  const fns = el.listeners.click || [];
  for (const fn of [...fns]) fn();
  return fns.length;
}
const flushAsync = () => new Promise(r => setTimeout(r, 0));

// B8 主斷言：state.words 的 word 物件不得帶任何 _ 前綴欄位
function leaky(words) { return words.filter(w => Object.keys(w).some(k => k.startsWith('_'))); }
function assertNoLeak(words, label) {
  const l = leaky(words);
  let detail = '無';
  if (l.length) {
    detail = JSON.stringify(l.map(w => ({ id: w.id, keys: Object.keys(w).filter(k => k.startsWith('_')) })));
  }
  assert(l.length === 0, `${label}（污染=${detail}）`);
}

// ---------- T1 mc 全新測驗：startExam/作答/exit 全程 state.words 零污染 ----------
async function t1McFresh() {
  console.log('=== T1 mc 全新測驗：startExam/作答/exit 全程 state.words 零 _ 污染 ===');
  const mod = loadPage('mc');
  const words = baseWords(4);
  let saved = null;
  const s = baseState(words, 'exam-mc', { saveExamSession: async (session) => { saved = session; } });
  mod.e.decks = ['d1'];
  mod.startExam(s);
  assert(mod.e.phase === 'exam', 'startExam → phase=exam');
  assertNoLeak(words, 'startExam 後 state.words 零 _ 欄位');
  assert(mod.e.words.length === 4 && mod.e.words.every(w => !words.includes(w)),
    'e.words 為 pool 深拷貝（非 state.words 活參考）');
  assert(mod.e.words.every(w => w._options && w._picked === -1 && !w._answered),
    '副本具備 _options/_picked/-1/_answered=false（暫存欄位在副本上）');
  assert(words.every(w => w._options === undefined), '活參考無 _options（未污染）');

  mod.e.settings.autoNext = false;   // 手動推進（避免 timer）
  const w0 = mod.e.words[0];
  mod.pickOption(s, (w0._correctIdx + 1) % w0._options.length);   // 答錯
  assertNoLeak(words, 'pickOption 作答後 state.words 零 _ 欄位');
  assert(mod.e.words[0]._answered === true && mod.e.words[0]._picked !== -1, '副本保留作答狀態');

  mod.renderInPlace(s);              // 綁定 exit 按鈕
  clickEl(mod, 'emExitBtn');
  await flushAsync();
  assert(mod.e.phase === 'config', 'exit → phase=config');
  assert(saved && saved.mcData && saved.mcData[w0.id] && saved.mcData[w0.id].picked === mod.e.words[0]._picked,
    'exit 存檔 mcData 完整（從副本收集）');
  assertNoLeak(words, 'exit 後 state.words 零 _ 欄位（跨頁殘留已堵）');
}

// ---------- T2 mc resume：mcData 還原在副本上，saveOnLeave 後仍零污染 ----------
async function t2McResume() {
  console.log('=== T2 mc resume：mcData 還原到副本 + saveOnLeave 零污染 ===');
  const mod = loadPage('mc');
  const words = baseWords(3);
  let saved = null;
  const s = baseState(words, 'exam-mc', { saveExamSession: async (session) => { saved = session; } });
  const session = {
    id: 'seed_mc', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 1, wrong: 0, totalTime: 3, wordCount: 3,
    settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
    results: [true, undefined, undefined],
    mcData: {
      w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 },
      w2: { options: ['x', 'word2', 'y', 'z'], correctIdx: 1, answered: false, picked: -1 },
      w3: { options: ['word3', 'x', 'y', 'z'], correctIdx: 0, answered: false, picked: -1 },
    },
  };
  mod.resumeSession(s, session);
  assert(mod.e.phase === 'exam', 'resumeSession → phase=exam');
  assertNoLeak(words, 'resumeSession 後 state.words 零 _ 欄位');
  assert(mod.e.words.every(w => !words.includes(w)), 'resume 的 e.words 亦為深拷貝');
  assert(mod.e.words[0]._answered === true && mod.e.words[0]._picked === 0, '副本還原 mcData（w1 已答）');
  assert(words[0]._answered === undefined && words[0]._picked === undefined, '活參考 w1 無殘留');

  mod.e.settings.autoNext = false;
  const w2 = mod.e.words[1];
  mod.pickOption(s, w2._correctIdx);   // 續答 w2
  assertNoLeak(words, 'resume 續答後 state.words 零 _ 欄位');

  windowStub.__navFromSidebar = true;
  mod.saveOnLeave(s);                  // B10 sidebar 離開路徑
  delete windowStub.__navFromSidebar;
  assert(mod.e.phase === 'config', 'saveOnLeave → phase=config');
  assert(saved && saved.mcData && saved.mcData['w2'] && saved.mcData['w2'].answered === true,
    'saveOnLeave 存檔 mcData 完整（w2 續答已收）');
  assertNoLeak(words, 'saveOnLeave 後 state.words 零 _ 欄位');
}

// ---------- T3 spell 全新測驗：submitSpelling 寫副本；exit 存 spellData ----------
async function t3SpellFresh() {
  console.log('=== T3 spell 全新測驗：_correct 只寫副本 + exit 序列化 spellData ===');
  const mod = loadPage('spell');
  const words = baseWords(3);
  let saved = null;
  const s = baseState(words, 'exam-spell', { saveExamSession: async (session) => { saved = session; } });
  mod.e.decks = ['d1'];
  mod.startExam(s);
  assertNoLeak(words, 'spell startExam 後 state.words 零 _ 欄位');
  assert(mod.e.words.every(w => !words.includes(w)), 'spell e.words 為深拷貝');

  mod.e.settings.autoNext = false;
  documentStub.getElementById('esInput').value = mod.e.words[0].word;
  mod.submitSpelling(s);
  assertNoLeak(words, 'submitSpelling 後 state.words 零 _ 欄位（w._correct 只寫在副本）');
  assert(mod.e.words[0]._correct === true, '副本 _correct=true');
  assert(words[0]._correct === undefined, '活參考無 _correct 殘留');

  mod.renderInPlace(s);                // 綁定 exit 按鈕
  clickEl(mod, 'esExitBtn');
  await flushAsync();
  assert(mod.e.phase === 'config', 'spell exit → phase=config');
  assert(saved && saved.spellData && saved.spellData[mod.e.words[0].id] === true,
    'exit 存檔含 spellData（已答題 _correct 序列化，供 resume 還原）');
  assertNoLeak(words, 'spell exit 後 state.words 零 _ 欄位');
}

// ---------- T4 spell resume：spellData 還原舊場（B4 語意保持）+ 完成記錄整場 ----------
async function t4SpellResume() {
  console.log('=== T4 spell resume：spellData 還原舊場 _correct（B4 語意）+ 完成零污染 ===');
  const mod = loadPage('spell');
  const words = baseWords(3);
  const recordLog = [];
  const s = baseState(words, 'exam-spell', {
    recordExam: async ({ mode, entries }) => { recordLog.push({ mode, entries }); },
  });
  const seed = {
    id: 'seed_spell', mode: 'spell', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 1, wrong: 0, totalTime: 3, wordCount: 3,
    settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
    results: [],
    spellData: { w1: true },   // w1 舊場已答對（B8 前靠活參考殘留；B8 後靠 session 序列化）
  };
  mod.resumeSession(s, seed);
  assertNoLeak(words, 'spell resumeSession 後 state.words 零 _ 欄位');
  assert(mod.e.words.every(w => !words.includes(w)), 'spell resume 的 e.words 為深拷貝');
  assert(mod.e.words[0]._correct === true, '副本還原 spellData（w1 舊場答對）');
  assert(words[0]._correct === undefined, '活參考 w1 無 _correct 殘留（不再依賴污染傳遞）');

  mod.e.settings.autoNext = false;
  documentStub.getElementById('esInput').value = mod.e.words[1].word;
  mod.submitSpelling(s);
  mod.nextWord(s);
  documentStub.getElementById('esInput').value = mod.e.words[2].word;
  mod.submitSpelling(s);
  mod.nextWord(s);                       // 末題 → phase=result → recordExamResult
  assert(mod.e.phase === 'result', '完成 → phase=result');
  await flushAsync(); await flushAsync();
  assert(recordLog.length === 1 && recordLog[0].entries.length === 3,
    'B4 語意保持：完成記錄＝整場答過之題（spellData 舊場 w1＋新答 w2/w3，共 3 筆）');
  assert(recordLog[0].entries[0].wordId === 'w1' && recordLog[0].entries[0].correct === true,
    '舊場 w1 的對錯正確還原（true）');
  assertNoLeak(words, 'spell resume 完成後 state.words 零 _ 欄位');
}

// ---------- T5 applyTags 回歸：深拷貝後 tags 經 editWord 寫回（真實 store 語意）＋editWord 不保留污染 ----------
async function t5ApplyTags() {
  console.log('=== T5 applyTags 回歸：tags 經 editWord 寫回活參考、editWord spread 不保留 _ 欄位 ===');
  // mc：答對 1 題 + 未答 1 題
  {
    const mod = loadPage('mc');
    const words = baseWords(3);
    const editLog = [];
    const s = baseState(words, 'exam-mc', {
      // editWord 對齊真實 store：state.words[idx] = {...old, ...updates}
      editWord: async (id, patch) => {
        editLog.push({ id, ...patch });
        const w = words.find(x => x.id === id);
        if (w) Object.assign(w, patch);
      },
    });
    mod.e.decks = ['d1'];
    mod.startExam(s);
    mod.e.settings.autoNext = false;
    const id0 = mod.e.words[0].id;
    const id1 = mod.e.words[1].id;   // 未答題（直接跳過）
    const id2 = mod.e.words[2].id;
    mod.pickOption(s, mod.e.words[0]._correctIdx);   // 答對 word[0]
    mod.nextWord(s);                                  // idx→1
    mod.nextWord(s);                                  // word[1] 未答跳過 → idx→2
    mod.pickOption(s, mod.e.words[2]._correctIdx);    // 答對 word[2]
    await mod.applyTags(s);
    assert(words.find(w => w.id === id0).tags.includes('correct') && words.find(w => w.id === id2).tags.includes('correct'),
      'mc applyTags 正常：答對題 tags 經 editWord 寫回活參考');
    assert(words.find(w => w.id === id1).tags.length === 0, 'mc applyTags 正常：未答題零標籤');
    assertNoLeak(words, 'mc applyTags＋editWord 寫回後 state.words 零 _ 欄位（editWord spread 不保留污染）');
  }
  // spell：答對 1 題
  {
    const mod = loadPage('spell');
    const words = baseWords(3);
    const editLog = [];
    const s = baseState(words, 'exam-spell', {
      editWord: async (id, patch) => {
        editLog.push({ id, ...patch });
        const w = words.find(x => x.id === id);
        if (w) Object.assign(w, patch);
      },
    });
    mod.e.decks = ['d1'];
    mod.startExam(s);
    mod.e.settings.autoNext = false;
    documentStub.getElementById('esInput').value = mod.e.words[0].word;
    mod.submitSpelling(s);
    await mod.applyTags(s);
    const id0 = mod.e.words[0].id;
    assert(words.find(w => w.id === id0).tags.includes('correct'), 'spell applyTags 正常：答對題 tags 寫回活參考');
    assertNoLeak(words, 'spell applyTags 後 state.words 零 _ 欄位');
  }
}

// ---------- T6 flip：對照組 — flip 本就零 _ 寫入（防回歸） ----------
async function t6Flip() {
  console.log('=== T6 flip 對照組：作答全程 state.words 零 _ 欄位 ===');
  const mod = loadPage('flip');
  const words = baseWords(3);
  const s = baseState(words, 'exam-flip');
  mod.e.decks = ['d1'];
  mod.startExam(s);
  mod.e.settings.autoNext = false;
  mod.answerCorrect(s);
  mod.nextWord(s);
  mod.answerWrong(s);
  assertNoLeak(words, 'flip startExam/作答/推進後 state.words 零 _ 欄位');
  assert(mod.e.results[0] === true && mod.e.results[1] === false, 'flip 作答記錄在 e.results（module 層，非 word 物件）');
}

// ---------- T7 負控制（mutation：剝除 B8 深拷貝）→ 污染必須再現 ----------
async function t7NegativeControl() {
  console.log('=== T7 負控制（剝除深拷貝）→ state.words 被 _ 欄位污染必須再現 ===');
  const mod = loadPage('mc', { stripB8: true });
  const words = baseWords(3);
  const s = baseState(words, 'exam-mc');
  mod.e.decks = ['d1'];
  mod.startExam(s);
  mod.e.settings.autoNext = false;
  mod.pickOption(s, mod.e.words[0]._correctIdx);
  const l = leaky(words);
  assert(l.length === 3 && l.every(w => w._options !== undefined && w._answered !== undefined),
    `無深拷貝 → startExam/作答後 state.words 全被 _options/_answered 污染（bug 前提再現，got=${l.length}）`);
  mod.renderInPlace(s);
  clickEl(mod, 'emExitBtn');
  await flushAsync();
  assert(leaky(words).length === 3, '無深拷貝 → exit 後污染跨頁殘留（bug 實錘）');
}

await t1McFresh();
await t2McResume();
await t3SpellFresh();
await t4SpellResume();
await t5ApplyTags();
await t6Flip();
await t7NegativeControl();

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
