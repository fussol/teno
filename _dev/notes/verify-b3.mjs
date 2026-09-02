// B3 驗證工具 — 從真實源碼抽取控制流（含 onMount guard 同步觸發、renderInPlace→onMount 重入、fake timers id≥1、bottom-nav 切頁、JSON round-trip）
// 方法：讀取 src/pages/exam-mc.js → 移除 import 行 → new Function 執行（stub 外部依賴）→ 附加 export 內部函式。
// 依賴註記：buildSession stub 之 results 序列化與 src/core/exam-session.js:61 一致（B1 實錘）；mcData 序列化由真實 emExitBtn 源碼（:390-396）自然產生。
// 全程不修改任何源碼；node _dev/notes/verify-b3.mjs 執行。
import fs from 'node:fs';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

// ---------- fake timers（id 從 1 起，防 !0 誤判） ----------
let timerSeq = 1;
const timers = new Map();
global.setTimeout = (fn, ms) => { const id = timerSeq++; timers.set(id, { fn, ms }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
function pendingCount() { return timers.size; }
function fire(id) { const t = timers.get(id); if (t) { timers.delete(id); t.fn(); } }
function fireAll() { for (const id of [...timers.keys()]) fire(id); }

// ---------- DOM / 依賴 stub ----------
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
// 忠實模擬真實 DOM：pageContainer.innerHTML 賦值 = 子節點重建 → 其餘 id 的 el 全部失效（下次 getElementById 建新 el，listener 不累積）
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
const icon = () => '';
const toast = () => {};
const renderSavedSessions = () => '';
// buildSession stub：results 序列化對照 src/core/exam-session.js:61（B1 實錘）
const buildSessionStub = (e, mode) => ({
  id: e.id || `exam_${mode}_${Date.now()}`, mode, timestamp: Date.now(),
  deckIds: [...e.decks], wordIds: e.words.map(w => w.id), idx: e.idx,
  correct: e.correct, wrong: e.wrong, totalTime: e.totalTime,
  wordCount: e.words.length, settings: { ...e.settings }, results: [...(e.results || [])],
});
const bindSpeakClick = () => {};
const splitFieldsHtml = () => '';
const fmtExample = () => '';

function loadPage(file, exportNames) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub（保留 accessor 版 pageContainer — 防 listener 累積）
  const src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  const getters = exportNames.map(n => `get ${n}() { return typeof ${n} !== 'undefined' ? ${n} : undefined; }`).join(',');
  const factory = new Function('icon', 'toast', 'renderSavedSessions', 'buildSession', 'bindSpeakClick', 'splitFieldsHtml', 'fmtExample', 'document', 'window',
    src + `\n;return { ${getters} };`);
  return factory(icon, toast, renderSavedSessions, buildSessionStub, bindSpeakClick, splitFieldsHtml, fmtExample, documentStub, windowStub);
}

// ---------- 情境 ----------
function baseWords(n, deckName = 'D') {
  return Array.from({ length: n }, (_, i) => ({ id: `w${i + 1}`, word: `word${i + 1}`, deck: deckName, tags: [], pos: '', definition: `def${i + 1}` }));
}
function baseState(words, currentPage = 'exam-mc') {
  return {
    state: { currentPage, decks: [{ id: 'd1', name: 'D' }], words,
      examSessions: [], maxExamSessions: 5, systemTags: [{ role: 'correct', name: 'C' }, { role: 'wrong', name: 'W' }], tags: [] },
    actions: {
      navigate() {}, saveExamSession: async () => {}, deleteExamSession: async () => {},
      editWord: async (id, fields) => { const w = words.find(x => x.id === id); if (w && fields.tags) w.tags = fields.tags; },
    },
  };
}
function clickEl(mod, id, ...args) {
  const el = documentStub.getElementById(id);
  const fns = el.listeners.click || [];
  for (const fn of [...fns]) fn(...args);
  return fns.length;
}
function startExamX(mod, s) { mod.e.decks = ['d1']; mod.startExam(s); }   // 真實流程由 config 綁定填 e.decks，此處模擬
function jsonRoundTrip(o) { return JSON.parse(JSON.stringify(o)); }
async function awaitP(p) { if (p && typeof p.then === 'function') await p; }
// 真實 emExitBtn exit：觸發 handler → 捕獲 saveExamSession 的 session → JSON round-trip
function exitAndCapture(mod, s) {
  let captured = null;
  const orig = s.actions.saveExamSession;
  s.actions.saveExamSession = async (session) => { captured = jsonRoundTrip(session); };
  clickEl(mod, 'emExitBtn');
  s.actions.saveExamSession = orig;
  return captured;
}

console.log('=== T1 正常作答回歸：3 題（對/錯/對）autoNext on，timer fire 逐題 flush，無級聯 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  startExamX(mod, s);
  assert(mod.e.phase === 'exam' && mod.e.idx === 0, 'startExam 進入 exam');
  assert(mod.e.results.length === 3 && mod.e.results.every(r => r === undefined), 'startExam results 全 undefined');
  assert(mod.e.words.every(w => w._noScore === false), 'startExam _noScore 全 false（跨場洩漏堵點）');

  // Q1 對：選正確選項（options 內找 word 的位置）— 直接呼叫 pickOption 模擬 click handler（先設狀態再呼叫 — 真實 handler 語意）
  const opt1 = mod.e.words[0]._options.indexOf(mod.e.words[0].word);
  mod.pickOption(s, opt1);
  assert(mod.e.idx === 0 && mod.e.phase === 'exam', '作答瞬間不級聯（idx 不跳）');
  assert(mod.e.pendingScore === 'correct' && mod.e.correct === 0 && mod.e.results[0] === true, '延遲窗內 pendingScore 設、未計分、results 即時寫');
  assert(pendingCount() === 1, 'timer 已設 1 個');
  fireAll();
  assert(mod.e.idx === 1 && mod.e.correct === 1 && mod.e.pendingScore === null, 'timer fire → flush → 計分 1、下一題');

  // Q2 錯
  const opt2 = (mod.e.words[1]._options.indexOf(mod.e.words[1].word) + 1) % mod.e.words[1]._options.length;
  mod.pickOption(s, opt2);
  assert(mod.e.pendingScore === 'wrong' && mod.e.results[1] === false, 'Q2 pendingScore=wrong, results[1]=false');
  fireAll();
  assert(mod.e.idx === 2 && mod.e.wrong === 1, 'Q2 flush → wrong=1');

  // Q3 對（末題）
  const opt3 = mod.e.words[2]._options.indexOf(mod.e.words[2].word);
  mod.pickOption(s, opt3);
  fireAll();
  assert(mod.e.phase === 'result' && mod.e.correct === 2 && mod.e.wrong === 1, 'Q3 末題 → 結果頁 correct=2 wrong=1');
  assert(JSON.stringify(mod.e.results) === JSON.stringify([true, false, true]), 'results=[true,false,true]');
  assert(pendingCount() === 0, '無殘留 timer');
}

console.log('=== T2 延遲窗 exit → resume 續跳（核心）：不重答不雙計、round-trip 正規化、applyTags skip ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  startExamX(mod, s);
  // 答第 1 題（正確），不 fire timer 即 exit。注意 startExam 的 shuffle 打亂 e.words 順序 → 用動態 id 辨識作答題
  const answeredId = mod.e.words[0].id;
  const opt1 = mod.e.words[0]._options.indexOf(mod.e.words[0].word);
  mod.pickOption(s, opt1);
  const session = exitAndCapture(mod, s);
  assert(session.correct === 1 && session.idx === 0, 'exit flush → 計分入 session、idx 停當前題（延遲窗 exit 語意）');
  assert(JSON.stringify(session.results) === JSON.stringify([true, null, null]), 'round-trip 序列化 results=[true,null,null]（undefined→null）');
  assert(session.mcData && session.mcData[answeredId] && session.mcData[answeredId].answered === true, 'exit 重存 mcData 含已答題');
  assert(pendingCount() === 0, 'exit 清 timer');

  // resume（session.wordIds = shuffle 後順序 → e.words[0] 即作答題）
  mod.resumeSession(s, session);
  assert(mod.e.idx === 0 && mod.e.phase === 'exam', 'resume 停在已答題（延遲窗停點）');
  assert(mod.e.words[0].id === answeredId && mod.e.words[0]._answered === true, '當前題已答還原');
  assert(mod.e.pendingNext !== null, 'resume 續跳 timer 已設');
  assert(mod.e.results[0] === true && mod.e.results[1] === undefined && mod.e.results[2] === undefined, 'round-trip 後 results[0] 保留、results[1/2] null→undefined 正規化');
  fireAll();
  assert(mod.e.idx === 1 && mod.e.correct === 1 && mod.e.pendingScore === null, '續跳 fire → idx=1、correct=1（不重答不雙計）');

  // applyTags：未答題 skip、已答題照標（動態 id）
  awaitP(mod.applyTags(s));
  const restIds = ['w1', 'w2', 'w3'].filter(id => id !== answeredId);
  assert(words.find(w => w.id === answeredId).tags.includes('correct'), '已答對題標 tc');
  assert(restIds.every(id => words.find(w => w.id === id).tags.length === 0), '未答題不標籤（不標 wrong — #4 額外 bug）');
}

console.log('=== T3 無 mcData 損壞存檔 resume：當未作答＋不計分＋續跳＋applyTags ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 0, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 } };
  mod.resumeSession(s, session);
  assert(mod.e.words.every(w => w._answered === false), '無 mcData → 全部當未作答');
  assert(mod.e.words.every(w => w._noScore === true), '無 mcData → 全部 _noScore=true（不計分）');
  assert(mod.e.pendingNext === null, '當前題未答 → 不設續跳 timer');
  // 作答（單選必對）
  mod.pickOption(s, 0);
  assert(mod.e.pendingScore === null && mod.e.correct === 0 && mod.e.wrong === 0, '作答不計分（pendingScore 不設、計數不變）');
  assert(mod.e.results[1] === true, 'results 照常寫入');
  assert(pendingCount() === 1, '作答後 autoNext timer 已設');
  fireAll();
  assert(mod.e.idx === 2 && mod.e.correct === 0 && mod.e.wrong === 0, '續跳後計數仍不變（零雙計）');
  awaitP(mod.applyTags(s));
  assert(words[1].tags.includes('correct') && words[0].tags.length === 0 && words[2].tags.length === 0, '作答過的無 mcData 題照標 tc、其餘未答 skip');
}

console.log('=== T4 applyTags 未答 skip（resume 後混合已答/未答） ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: false, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, null, null] };
  mod.resumeSession(s, session);
  assert(mod.e.results[0] === true && mod.e.results[1] === undefined, '序列化分支還原（guard：w1 已答保留、w2 未答棄值）');
  awaitP(mod.applyTags(s));
  assert(words[0].tags.includes('correct') && words[1].tags.length === 0 && words[2].tags.length === 0, '已答題標 tc、未答題不標 wrong');
}

console.log('=== T5 resume timer × onMount 補跳交互：guard 不 fire、fire 後恰跳 1 題 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 0, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, null, null] };
  mod.resumeSession(s, session);
  assert(mod.e.idx === 0, 'resume 後 idx 未跳（onMount 補跳 guard 因 pendingNext 非 null 不 fire）');
  fireAll();
  assert(mod.e.idx === 1, 'timer fire 續跳恰 1 題');
}

console.log('=== T6 末題 resume：timer fire → 結果頁、計數正確、零雙計 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(2);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2'], idx: 1, correct: 1, wrong: 1, totalTime: 0, wordCount: 2, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 }, w2: { options: ['word2', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 1 } },
    results: [true, false] };
  mod.resumeSession(s, session);
  assert(mod.e.pendingNext !== null, '末題已答 → 續跳 timer 設');
  fireAll();
  assert(mod.e.phase === 'result' && mod.e.correct === 1 && mod.e.wrong === 1, '末題 resume → 結果頁、計數 = session 還原值（零雙計）');
  assert(pendingCount() === 0, '末題後不 re-arm（e.words[idx] undefined）');
}

console.log('=== T7 刪字 lockstep：wordIds 含被刪單字 → 值對齊 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  // w2 被刪除（state.words 只有 w1/w3）
  const words = baseWords(3).filter(w => w.id !== 'w2');
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 2, correct: 2, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: false, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 }, w3: { options: ['word3', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, false, true] };
  mod.resumeSession(s, session);
  assert(mod.e.words.length === 2 && mod.e.results.length === 2, '長度對齊（words.length === results.length）');
  assert(mod.e.results[0] === true && mod.e.results[1] === true, '逐題值對齊（w1→true、w3→true；刪字後 fallback per-word 推斷免疫錯位）');
  assert(mod.e.idx === 1 && mod.e.words[mod.e.idx].id === 'w3', 'idx clamp 落存活座標（w3 已答）');
  mod.nextWord(s);
  assert(mod.e.phase === 'result', '已答落點續跳 → 結果頁閉合');
}

console.log('=== T8 autoNext 關 resume：不設 timer、手動下一題 flush null 不雙計 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(2);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2'], idx: 0, correct: 1, wrong: 0, totalTime: 0, wordCount: 2, settings: { count: 0, autoNext: false, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, null] };
  mod.resumeSession(s, session);
  assert(mod.e.pendingNext === null, 'autoNext 關 → 不設續跳 timer（emNextBtn 手動）');
  mod.nextWord(s);
  assert(mod.e.idx === 1 && mod.e.correct === 1, '手動下一題 → flush null 不雙計、續跳正常');
}

console.log('=== T9 二度 resume：續答 → 重存 → 再 resume → 零雙計 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session1 = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 0, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 }, w2: { options: ['word2', 'x', 'y', 'z'], correctIdx: 0, answered: false, picked: -1 } },
    results: [true, null, null] };
  mod.resumeSession(s, session1);
  fireAll();  // 續跳至 w2（未答）
  const opt2 = mod.e.words[1]._options.indexOf(mod.e.words[1].word);
  mod.pickOption(s, opt2);
  const session2 = exitAndCapture(mod, s);
  assert(session2.correct === 2 && session2.idx === 1, '二度 exit：correct=2（w1 還原＋w2 作答）、idx=1');
  mod.resumeSession(s, session2);
  assert(mod.e.pendingNext !== null && mod.e.results[0] === true && mod.e.results[1] === true, '二度 resume：續跳 timer 設、results 還原');
  fireAll();
  assert(mod.e.idx === 2 && mod.e.correct === 2, '續跳至 w3、計數不變（零雙計）');
}

console.log('=== T9b 尾窗 exit（resume timer 殘留防護）：exit 後無殘留、再 resume 正常 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 0, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, null, null] };
  mod.resumeSession(s, session);
  assert(pendingCount() === 1, 'resume 設續跳 timer（1 個）');
  const re = exitAndCapture(mod, s);   // timer 未 fire 即 exit（真實 emExitBtn handler）
  assert(pendingCount() === 0, 'exit 後 pendingCount()===0（:388 已清 — 主斷言）');
  fireAll();
  assert(mod.e.idx === 0, '快轉 delay*2 無 callback fire（idx 不變）');
  mod.resumeSession(s, re);
  assert(mod.e.pendingNext !== null, '再次 resume 正常續跳');
  fireAll();
  assert(mod.e.idx === 1, '再次 resume 續跳成功');
}

console.log('=== T9c 尾窗 bottom-nav（timer 消費後補跳）：guard 消費不 re-arm、返回補跳恰 1 題 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 0, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, null, null] };
  mod.resumeSession(s, session);
  s.state.currentPage = 'dashboard';   // bottom-nav 切走
  fireAll();                            // timer fire → page guard 消費（idx 不變、不 re-arm、清 pendingNext）
  assert(mod.e.idx === 0 && pendingCount() === 0, 'page guard 消費：idx 不變、timer 清（不 re-arm — e.idx===before）');
  s.state.currentPage = 'exam-mc';      // 返回
  mod.onMount(s);                        // onMount 補跳 guard fire
  assert(mod.e.idx === 1, '返回補跳恰 1 題');
  mod.onMount(s);                        // 再 onMount
  assert(mod.e.idx === 1, '再 onMount 不雙跳（下一題未答）');
}

console.log('=== T9d 尾窗作答嘗試（:272 guard）：不重答、timer 不被重置 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 0, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },
    results: [true, null, null] };
  mod.resumeSession(s, session);
  const t0 = mod.e.pendingNext;
  mod.pickOption(s, 1);   // 已答題上點選項 → :272 guard 擋
  assert(mod.e.words[0]._picked === 0 && mod.e.words[0]._answered === true && mod.e.results[0] === true, '不重答（_picked/_answered/results 不變）');
  assert(mod.e.pendingNext === t0, 'timer 未被防禦性 clear 重置');
  fireAll();
  assert(mod.e.idx === 1, 'fire timer 後恰跳 1 題');
}

console.log('=== T9e B1-era 存檔（results=[] 空陣列＋mcData 有值）：fallback 推斷、零雙計 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 1, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 }, w2: { options: ['word2', 'x', 'y', 'z'], correctIdx: 0, answered: false, picked: -1 } },
    results: [] };   // B1-era：空陣列（合法 Array）
  mod.resumeSession(s, session);
  assert(mod.e.results[0] === true && mod.e.results[1] === undefined && mod.e.results[2] === undefined, 'B1-era → fallback 推斷（w1 true、w2/w3 未答 undefined）');
  assert(mod.e.pendingNext === null, 'idx=1 未答 → 不設續跳 timer');
  const opt2 = mod.e.words[1]._options.indexOf(mod.e.words[1].word);
  mod.pickOption(s, opt2);
  fireAll();
  assert(mod.e.correct === 2 && mod.e.idx === 2, '續答計分正確（w1 還原 1＋w2 作答 1，零雙計）');
}

console.log('=== T9f 損壞存檔 NaN idx（round-trip NaN→null）：clamp 0、不白畫面 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(2);
  const s = baseState(words);
  const session = jsonRoundTrip({ id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2'], idx: NaN, correct: 0, wrong: 0, totalTime: 0, wordCount: 2, settings: { count: 0, autoNext: true, delay: 1.5 } });
  mod.resumeSession(s, session);
  assert(mod.e.idx === 0, 'NaN（round-trip 後 null）→ clamp 0');
  assert(mod.e.words[mod.e.idx] !== undefined, 'renderExam 不白畫面（w0 存在）');
  const opt = mod.e.words[0]._options.indexOf(mod.e.words[0].word);
  mod.pickOption(s, opt);
  assert(mod.e.results[0] === true, '可正常作答');
}

console.log('=== T9g 方案 A 全生命週期：作答不計分 → exit 重存全量 mcData → 二度 resume 全 if 分支 → 新場恢復計分 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(3);
  const s = baseState(words);
  const session1 = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 0, wrong: 0, totalTime: 0, wordCount: 3, settings: { count: 0, autoNext: true, delay: 1.5 } };
  mod.resumeSession(s, session1);
  mod.pickOption(s, 0);   // 作答 w2（不計分）
  const session2 = exitAndCapture(mod, s);
  assert(session2.mcData && session2.mcData.w1 && session2.mcData.w2 && session2.mcData.w3, 'exit 重存 mcData 含全部題（含未答題 — emExitBtn 全量序列化）');
  assert(session2.mcData.w2.answered === true && session2.mcData.w1.answered === false, '已答題 answered=true、未答題 answered=false');
  assert(session2.correct === 0 && session2.wrong === 0, '該題從未計分（重存後 correct/wrong 不含它）');
  // 二度 resume：全走 if 分支（_noScore 全 false）
  mod.resumeSession(s, session2);
  assert(mod.e.words.every(w => w._noScore === false), '二度 resume 所有題 _noScore=false（計分語意恢復）');
  assert(mod.e.results[1] === true && mod.e.results[0] === undefined, 'results 還原（該題 true、未答題 undefined）');
  assert(mod.e.correct === 0 && mod.e.wrong === 0, '計數仍不含該題（零雙計）');
  awaitP(mod.applyTags(s));
  assert(words[1].tags.includes('correct'), 'applyTags 對該題標 tc');
  // 再考新場：_noScore=false、作答正常計分（跨場洩漏已堵）
  startExamX(mod, s);
  const w2 = mod.e.words.find(w => w.id === 'w2');
  assert(w2 && w2._noScore === false, '新場該單字 _noScore=false（跨場洩漏已堵）');
  // 對當前題作答（真實流程：作答的是 e.words[e.idx]，不指定 w2 位置）
  const cur = mod.e.words[mod.e.idx];
  const optCur = cur._options.indexOf(cur.word);
  mod.pickOption(s, optCur);
  fireAll();
  assert(mod.e.correct + mod.e.wrong === 1 && mod.e.pendingScore === null, '新場作答正常計分（該題計入 correct/wrong、flush 完成）');
}

console.log('=== T9h 損壞存檔 re-arm 遞迴：3 題連續已答逐層續跳至未答題 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(4);
  const s = baseState(words);
  // 含當前題共 3 題連續已答（w1/w2/w3 answered:true、w4 未答），settings 完整
  const mcData = {};
  for (const [id, picked] of [['w1', 0], ['w2', 1], ['w3', 0]]) {
    const w = words.find(x => x.id === id);
    mcData[id] = { options: [w.word, 'x', 'y', 'z'], correctIdx: 0, answered: true, picked };
  }
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3', 'w4'], idx: 0, correct: 2, wrong: 1, totalTime: 0, wordCount: 4,
    settings: { count: 0, autoNext: true, delay: 1.5 }, mcData, results: [true, false, true, null] };
  mod.resumeSession(s, session);
  assert(mod.e.pendingNext !== null && pendingCount() === 1, 'resume 設首層 timer');
  for (let step = 0; step < 3; step++) {
    assert(pendingCount() === 1, `第 ${step + 1} 層 fire 前 pendingCount()===1`);
    fireAll();
    assert(mod.e.idx === step + 1, `第 ${step + 1} 層 fire → idx=${step + 1}`);
    if (step < 2) assert(mod.e.pendingNext !== null, `第 ${step + 1} 層後 re-arm 續設（下一題仍已答）`);
  }
  assert(mod.e.pendingNext === null, '到達未答題（w4）→ 停止 re-arm（pendingNext===null）');
  assert(mod.e.correct === 2 && mod.e.wrong === 1, '計數零雙計（flush 全 no-op）');
  assert(pendingCount() === 0, '無殘留 timer');
}

console.log('=== T9i 畸形存檔「全長 results＋部分 mcData 缺失」：guard 棄值、applyTags 不標 wrong ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'pickOption', 'flushPendingScore', 'applyTags', 'e']);
  const words = baseWords(2);
  const s = baseState(words);
  const session = { id: 'x', mode: 'mc', deckIds: ['d1'], wordIds: ['w1', 'w2'], idx: 0, correct: 0, wrong: 0, totalTime: 0, wordCount: 2,
    settings: { count: 0, autoNext: false, delay: 1.5 },
    mcData: { w1: { options: ['word1', 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 } },   // w2 無 mcData（畸形）
    results: [true, false] };   // 全長 results：w2 偽 false
  mod.resumeSession(s, session);
  assert(mod.e.results[0] === true && mod.e.results[1] === undefined, '序列化分支 + per-word guard：w1 保留、w2 未答棄值 undefined');
  assert(mod.e.words[1]._answered === false && mod.e.words[1]._noScore === true, 'w2 當未作答（_answered=false、_noScore=true）');
  mod.nextWord(s);   // 手動下一題（autoNext 關）
  mod.nextWord(s);   // 至結果頁
  assert(mod.e.phase === 'result', '結果頁可達');
  awaitP(mod.applyTags(s));
  assert(words[0].tags.includes('correct'), 'w1（已答）照標 tc');
  assert(words[1].tags.length === 0, 'w2（未答）不標 wrong（guard 防禦 F1）');
}

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
