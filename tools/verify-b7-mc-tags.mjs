// B7 驗證工具 — exam-mc applyTags 未作答題（_picked=-1）不得被標答錯
// 結論先行：B3（commit 3a4de3f）已覆蓋此 bug — applyTags 的
//   `if (r !== true && r !== false) continue;`（src/pages/exam-mc.js:362）
// 跳過所有非 true/false 的 results 值；且三條寫入路徑保證未作答題
// （_picked=-1）的 results[i] 恆為 undefined：
//   1. startExam :236  e.results = new Array(n).fill(undefined)
//   2. pickOption :307 僅在作答時寫入（_answered=true 先行）
//   3. resumeSession :272 per-word guard（words[i]?._answered ? r : undefined）
//      + fallback :274 顯式 `w._picked >= 0`（_picked=-1 → undefined）
// 本腳本以「真實源碼載入（new Function + DOM stub）」證明上述結論，
// 並含負控制（剝除 B3 guard 行 → bug 必須再現）證明測試對修法敏感。
// 全程不修改任何源碼；node tools/verify-b7-mc-tags.mjs 執行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MC = path.join(ROOT, 'src/pages/exam-mc.js');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

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

// ---------- 頁面載入器（真實源碼 → new Function；stripGuard = 剝除 B3 guard 做負控制） ----------
function loadPage(exportNames, { stripGuard = false } = {}) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub
  let src = fs.readFileSync(MC, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  if (stripGuard) {
    const before = src;
    src = src.replace(/if \(r !== true && r !== false\) continue;.*$/gm, '// [stripGuard]');
    if (src === before) throw new Error(`[harness] stripGuard: 源碼中找不到 B3 guard 行 — ${MC}`);
  }
  const getters = exportNames.map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`).join(',');
  const factory = new Function('icon', 'toast', 'renderSavedSessions', 'buildSession', 'bindSpeakClick', 'splitFieldsHtml', 'fmtExample', 'document', 'window',
    src + `\n;return { ${getters} };`);
  return factory(iconStub, toastStub, renderSavedSessionsStub, (e, mode) => ({
    id: e.id || `exam_${mode}_${Date.now()}`, mode, wordIds: e.words.map(w => w.id),
    settings: { ...e.settings }, results: [...(e.results || [])],
  }), bindSpeakClickStub, splitFieldsHtmlStub, fmtExampleStub, documentStub, windowStub);
}

// ---------- 情境工具 ----------
function baseWords(n, deckName = 'D') {
  return Array.from({ length: n }, (_, i) => ({ id: `w${i + 1}`, word: `word${i + 1}`, deck: deckName, tags: [], pos: '', definition: `def${i + 1}` }));
}
function baseState(words, editLog) {
  return {
    state: { currentPage: 'exam-mc', decks: [{ id: 'd1', name: 'D' }], words,
      examSessions: [], maxExamSessions: 5, systemTags: [{ role: 'correct', name: 'C' }, { role: 'wrong', name: 'W' }], tags: [] },
    actions: {
      navigate() {}, saveExamSession: async () => {}, deleteExamSession: async () => {},
      // editWord 對齊真實 store（state.words[idx] = {...old, ...updates}）— B8 深拷貝後 tags 寫回經 editWord（非活參考直接改）
      editWord: async (id, patch) => {
        editLog.push({ id, ...patch });
        const w = words.find(x => x.id === id);
        if (w) Object.assign(w, patch);
      },
    },
  };
}
function tagsOf(words, id) { return words.find(w => w.id === id)?.tags || []; }

// ---------- T1 全新測驗：交錯作答 [錯, 對, 未答, 對]（B1 語意 + 未答不誤標） ----------
async function scenarioFreshInterleaved() {
  console.log('=== T1 全新測驗交錯作答 [錯,對,未答,對]：未答題不標籤、答對答錯各貼各的 ===');
  const mod = loadPage(['startExam', 'pickOption', 'nextWord', 'applyTags', 'e']);
  const words = baseWords(4);
  const editLog = [];
  const s = baseState(words, editLog);
  mod.e.decks = ['d1'];
  mod.startExam(s);
  mod.e.settings.autoNext = false;   // 手動控制推進（避免 timer）
  assert(mod.e.words.length === 4 && mod.e.words.every(w => w._picked === -1 && !w._answered),
    'startExam 後 4 題皆 _picked=-1 / _answered=false（未作答初態）');
  assert(mod.e.results.every(r => r === undefined), 'startExam 後 results 全為 undefined');

  // 題0 答錯：pick 一個非 correctIdx 的選項
  const id0 = mod.e.words[0].id;   // shuffle 後順序不固定 → 以實際 e.words 的 id 斷言
  const w0 = mod.e.words[0];
  mod.pickOption(s, (w0._correctIdx + 1) % w0._options.length);
  mod.nextWord(s);
  // 題1 答對
  const id1 = mod.e.words[1].id;
  const w1 = mod.e.words[1];
  mod.pickOption(s, w1._correctIdx);
  mod.nextWord(s);
  // 題2 未作答：直接跳過
  const id2 = mod.e.words[2].id;
  mod.nextWord(s);
  // 題3 答對
  const id3 = mod.e.words[3].id;
  const w3 = mod.e.words[3];
  mod.pickOption(s, w3._correctIdx);

  assert(mod.e.results[0] === false && mod.e.results[1] === true && mod.e.results[2] === undefined && mod.e.results[3] === true,
    'results = [false, true, undefined, true]（未答題為 undefined，非 false）');
  assert(mod.e.words[2]._picked === -1 && !mod.e.words[2]._answered, '未答題維持 _picked=-1（bug 載體在場）');

  await mod.applyTags(s);
  assert(tagsOf(words, id0).includes('wrong') && !tagsOf(words, id0).includes('correct'), `答錯題 ${id0} → 只貼 wrong`);
  assert(tagsOf(words, id1).includes('correct') && !tagsOf(words, id1).includes('wrong'), `答對題 ${id1} → 只貼 correct`);
  assert(tagsOf(words, id3).includes('correct') && !tagsOf(words, id3).includes('wrong'), `答對題 ${id3} → 只貼 correct`);
  assert(tagsOf(words, id2).length === 0, `未答題 ${id2}（_picked=-1）→ 零標籤（B7 主斷言）`);
  const touched = editLog.filter(x => x.id === id2);
  assert(touched.length === 0, `未答題 ${id2} 的 editWord 從未被呼叫（含 wrong 標籤寫入）`);
  const wrongCalls = editLog.filter(x => x.id === id0);
  assert(wrongCalls.length === 1 && wrongCalls[0].tags.includes('wrong'), `答錯題 ${id0} editWord 恰 1 次且帶 wrong`);
}

// ---------- T2 resume（有效 results 陣列 + 存檔內未答題位置為 false/null）：per-word guard 必須擋下 ----------
async function scenarioResumeWithResultsArray() {
  console.log('=== T2 resume（results 陣列含未答題 false 殘留 / null round-trip）：guard 擋下不誤標 ===');
  const mod = loadPage(['resumeSession', 'applyTags', 'e']);
  const words = baseWords(3);
  const editLog = [];
  const s = baseState(words, editLog);
  // mcData：w1 答對、w2 答錯、w3 未答（answered=false, picked=-1）
  const session = {
    id: 'exam_mc_legacy', mode: 'mc', wordIds: ['w1', 'w2', 'w3'], idx: 3, correct: 1, wrong: 1, totalTime: 5,
    settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
    results: [true, false, false],   // <-- B3 前舊存檔：未答題位置殘留 false（或 JSON round-trip null）
    mcData: {
      w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 },
      w2: { options: ['x', 'y', 'word2', 'z'], correctIdx: 2, answered: true, picked: 1 },
      w3: { options: ['word3', 'x', 'y', 'z'], correctIdx: 0, answered: false, picked: -1 },
    },
  };
  mod.resumeSession(s, session);
  assert(mod.e.results[0] === true && mod.e.results[1] === false, '答過題 results 正確還原（true/false）');
  assert(mod.e.results[2] === undefined, '未答題（_picked=-1）results 還原為 undefined（per-word guard 擋下存檔 false）');
  assert(mod.e.words[2]._picked === -1 && !mod.e.words[2]._answered, 'w3 維持 _picked=-1 / 未答');

  await mod.applyTags(s);
  assert(tagsOf(words, 'w1').includes('correct') && !tagsOf(words, 'w1').includes('wrong'), '答對題 w1 → correct');
  assert(tagsOf(words, 'w2').includes('wrong') && !tagsOf(words, 'w2').includes('correct'), '答錯題 w2 → wrong');
  assert(tagsOf(words, 'w3').length === 0, '未答題 w3 → 零標籤（B7 主斷言：舊存檔 false 殘留不誤標 wrong）');
  assert(editLog.filter(x => x.id === 'w3').length === 0, '未答題 w3 無 editWord 呼叫');

  // null round-trip 變體：results = [true, false, null]（undefined 序列化後）
  const mod2 = loadPage(['resumeSession', 'applyTags', 'e']);
  const words2 = baseWords(3);
  const editLog2 = [];
  const s2 = baseState(words2, editLog2);
  mod2.resumeSession(s2, { ...session, results: [true, false, null] });
  assert(mod2.e.results[2] === undefined, 'null（round-trip 後）→ undefined');
  await mod2.applyTags(s2);
  assert(tagsOf(words2, 'w3').length === 0, 'null round-trip 未答題 → 零標籤');
}

// ---------- T3 resume（無 results 陣列 → fallback 路徑）：_picked >= 0 顯式檢查 ----------
async function scenarioResumeFallback() {
  console.log('=== T3 resume 無 results 陣列（fallback 路徑）：_picked>=0 檢查擋下未答題 ===');
  const mod = loadPage(['resumeSession', 'applyTags', 'e']);
  const words = baseWords(3);
  const editLog = [];
  const s = baseState(words, editLog);
  const session = {
    id: 'exam_mc_fb', mode: 'mc', wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 0, wrong: 0, totalTime: 2,
    settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
    // 無 results 欄位（舊存檔）→ fallback：words.map(w => w._answered && w._picked >= 0 ? ... : undefined)
    mcData: {
      w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 },
      w2: { options: ['x', 'y', 'word2', 'z'], correctIdx: 2, answered: false, picked: -1 },
      w3: { options: ['word3', 'x', 'y', 'z'], correctIdx: 0, answered: false, picked: -1 },
    },
  };
  mod.resumeSession(s, session);
  assert(mod.e.results[0] === true, '答對題 w1 fallback → true');
  assert(mod.e.results[1] === undefined && mod.e.results[2] === undefined, '未答題（_picked=-1）fallback → undefined（_picked>=0 檢查）');

  await mod.applyTags(s);
  assert(tagsOf(words, 'w1').includes('correct'), '答對題 w1 → correct');
  assert(tagsOf(words, 'w2').length === 0 && tagsOf(words, 'w3').length === 0, '兩未答題 → 零標籤（B7 主斷言）');
  assert(editLog.filter(x => x.id === 'w2' || x.id === 'w3').length === 0, '未答題無 editWord 呼叫');
}

// ---------- T4 resume 無 mcData（資料損壞路徑）：_noScore + _picked=-1 不標籤 ----------
async function scenarioResumeNoMcData() {
  console.log('=== T4 resume 無 mcData（損壞路徑）：_noScore 題不標籤 ===');
  const mod = loadPage(['resumeSession', 'applyTags', 'e']);
  const words = baseWords(3);
  const editLog = [];
  const s = baseState(words, editLog);
  const session = {
    id: 'exam_mc_corrupt', mode: 'mc', wordIds: ['w1', 'w2', 'w3'], idx: 0, correct: 0, wrong: 0, totalTime: 0,
    settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
    results: [false, false, false],   // 長度吻合但 w2/w3 無 mcData → guard 擋下
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 1 } },
  };
  mod.resumeSession(s, session);
  assert(mod.e.words[1]._picked === -1 && mod.e.words[1]._noScore === true, '無 mcData 題 → _picked=-1 + _noScore=true（B3 語意）');
  assert(mod.e.results[0] === false && mod.e.results[1] === undefined && mod.e.results[2] === undefined,
    '有 mcData 題 results 保留 false；無 mcData 題 → undefined（guard 擋下存檔 false）');

  await mod.applyTags(s);
  assert(tagsOf(words, 'w1').includes('wrong'), '答錯題 w1 → wrong');
  assert(tagsOf(words, 'w2').length === 0 && tagsOf(words, 'w3').length === 0, '無 mcData 未答題 → 零標籤（B7 主斷言）');
  assert(editLog.filter(x => x.id === 'w2' || x.id === 'w3').length === 0, '無 mcData 題無 editWord 呼叫');
}

// ---------- T5 全部作答對照組：全答題仍正確貼標 ----------
async function scenarioAllAnswered() {
  console.log('=== T5 對照組：全答（[錯,對,對]）仍正確貼標、不誤標 ===');
  const mod = loadPage(['startExam', 'pickOption', 'nextWord', 'applyTags', 'e']);
  const words = baseWords(3);
  const editLog = [];
  const s = baseState(words, editLog);
  mod.e.decks = ['d1'];
  mod.startExam(s);
  mod.e.settings.autoNext = false;
  const id0 = mod.e.words[0].id;   // shuffle 後順序不固定 → 以實際 e.words 的 id 斷言
  const id1 = mod.e.words[1].id;
  const id2 = mod.e.words[2].id;
  const w0 = mod.e.words[0];
  mod.pickOption(s, (w0._correctIdx + 1) % w0._options.length);
  mod.nextWord(s);
  const w1 = mod.e.words[1];
  mod.pickOption(s, w1._correctIdx);
  mod.nextWord(s);
  const w2 = mod.e.words[2];
  mod.pickOption(s, w2._correctIdx);
  await mod.applyTags(s);
  assert(tagsOf(words, id0).includes('wrong') && tagsOf(words, id1).includes('correct') && tagsOf(words, id2).includes('correct'),
    `[錯,對,對] → [${id0}=wrong, ${id1}=correct, ${id2}=correct]（B1 語意保持）`);
  assert(!tagsOf(words, id0).includes('correct') && !tagsOf(words, id1).includes('wrong') && !tagsOf(words, id2).includes('wrong'),
    '三題皆無對側標籤殘留（無交叉污染）');
}

// ---------- T6 負控制（mutation：剝除 B3 guard 行）→ bug 必須再現 ----------
async function scenarioNegativeControl() {
  console.log('=== T6 負控制（剝除 B3 guard 行）→ 未答題被標 wrong 的 bug 必須再現 ===');
  const mod = loadPage(['startExam', 'pickOption', 'nextWord', 'applyTags', 'e'], { stripGuard: true });
  const words = baseWords(3);
  const editLog = [];
  const s = baseState(words, editLog);
  mod.e.decks = ['d1'];
  mod.startExam(s);
  mod.e.settings.autoNext = false;
  const id0 = mod.e.words[0].id;   // shuffle 後順序不固定 → 以實際 e.words 的 id 斷言
  const id1 = mod.e.words[1].id;
  const w0 = mod.e.words[0];
  mod.pickOption(s, w0._correctIdx);   // 答對
  mod.nextWord(s);
  mod.nextWord(s);                     // 題1 未作答直接跳過 → _picked=-1
  const w2 = mod.e.words[2];
  mod.pickOption(s, w2._correctIdx);   // 答對
  await mod.applyTags(s);
  assert(mod.e.words[1]._picked === -1 && mod.e.results[1] === undefined, '前置：題1 未答且 results undefined（bug 前提）');
  const buggy = tagsOf(words, id1).includes('wrong');
  assert(buggy, '無 guard → undefined 走 falsy 分支貼 wrong（bug 再現 = 測試對修法敏感）');
  const w2calls = editLog.filter(x => x.id === id1);
  assert(w2calls.length === 1 && w2calls[0].tags.includes('wrong'),
    `無 guard → 未答題 ${id1} 被 editWord 寫入 wrong（實錘）`);
}

await scenarioFreshInterleaved();
await scenarioResumeWithResultsArray();
await scenarioResumeFallback();
await scenarioResumeNoMcData();
await scenarioAllAnswered();
await scenarioNegativeControl();

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
