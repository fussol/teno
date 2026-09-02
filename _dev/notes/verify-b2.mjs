// B2 驗證工具 — 從真實源碼抽取控制流（含 onMount guard 同步觸發、renderInPlace→onMount 重入、fake timers id≥1、bottom-nav 切頁）
// 方法：讀取 src/pages/*.js → 移除 import 行 → new Function 執行（stub 外部依賴）→ 附加 export 內部函式。
// 全程不修改任何源碼；node _dev/notes/verify-b2.mjs 執行。
import fs from 'node:fs';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

// ---------- fake timers（id 從 1 起，防 !0 誤判） ----------
let timerSeq = 1;
const timers = new Map();
const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
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
const windowStub = { __esKeyHandler: null, visualViewport: null };
const icon = () => '';
const toast = () => {};
const renderSavedSessions = () => '';
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
function baseState(words) {
  return {
    state: { currentPage: 'exam-flip', decks: [{ id: 'd1', name: 'D' }], words,
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
function startExamX(mod, s) { mod.e.decks = ['d1']; mod.startExam(s); }   // 真實流程由 config 綁定填 e.decks，此處模擬
function jsonRoundTrip(o) { return JSON.parse(JSON.stringify(o)); }

console.log('=== T1 flip：3 題（對/錯/對）autoNext on，timer fire 逐題 flush，無級聯 ===');
{
  const mod = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const words = baseWords(3);
  const s = baseState(words); s.state.currentPage = 'exam-flip';
  startExamX(mod, s);
  assert(mod.e.phase === 'exam' && mod.e.idx === 0, 'startExam 進入 exam');
  assert(mod.e.pendingScore === null && mod.e.correct === 0, '初始 pendingScore=null, correct=0');

  // Q1 對：reveal → 點正確（click handler 先設 judged 再呼叫 answerCorrect — 由 stub click 模擬）
  clickEl(mod, 'efRevealBtn');
  clickEl(mod, 'efCorrectBtn');
  assert(mod.e.idx === 0 && mod.e.phase === 'exam', '作答瞬間不級聯（idx 不跳、phase 仍 exam）');
  assert(mod.e.pendingScore === 'correct' && mod.e.correct === 0 && mod.e.results[0] === true, '延遲窗內 pendingScore 設、未計分、results 即時寫');
  assert(pendingCount() === 1, 'timer 已設 1 個');
  fireAll();
  assert(mod.e.idx === 1 && mod.e.correct === 1 && mod.e.pendingScore === null, 'timer fire → flush → 計分 1、下一題');

  // Q2 錯
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efWrongBtn');
  assert(mod.e.pendingScore === 'wrong' && mod.e.results[1] === false, 'Q2 pendingScore=wrong, results[1]=false');
  fireAll();
  assert(mod.e.idx === 2 && mod.e.wrong === 1, 'Q2 flush → wrong=1');

  // Q3 對（末題）
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn');
  assert(mod.e.pendingScore === 'correct' && mod.e.results[2] === true, 'Q3 pendingScore=correct');
  fireAll();
  assert(mod.e.phase === 'result' && mod.e.correct === 2 && mod.e.wrong === 1 && mod.e.pendingScore === null, '末題 timer → nextWord flush → result, correct=2 wrong=1');
  assert(JSON.stringify(mod.e.results) === JSON.stringify([true, false, true]), 'results=[true,false,true]');
  assert(mod.e.results.length === words.length, 'results 長度不變（無越界寫入）');
}

console.log('=== T2 mc：4 題（對/錯/對/錯）timer 管理化 ===');
{
  const mod = loadPage('src/pages/exam-mc.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'pickOption', 'e']);
  const words = baseWords(4);
  const s = baseState(words); s.state.currentPage = 'exam-mc';
  startExamX(mod, s);
  const seq = [true, false, true, false]; // 依 _correctIdx 選
  for (let q = 0; q < 4; q++) {
    const w = mod.e.words[mod.e.idx];
    mod.pickOption(s, seq[q] ? w._correctIdx : (w._correctIdx + 1) % w._options.length);
    assert(mod.e.pendingScore === (seq[q] ? 'correct' : 'wrong') && mod.e.correct + mod.e.wrong === q, `Q${q + 1} 延遲窗內 pendingScore 設、未計分`);
    fireAll();
  }
  assert(mod.e.phase === 'result' && mod.e.correct === 2 && mod.e.wrong === 2 && pendingCount() === 0, 'result correct=2 wrong=2 無殘留 timer');
}

console.log('=== T3 spell：3 題（對/錯/對）末題統一走 nextWord ===');
{
  const mod = loadPage('src/pages/exam-spell.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'submitSpelling', 'e']);
  const words = baseWords(3);
  const s = baseState(words); s.state.currentPage = 'exam-spell';
  startExamX(mod, s);
  const answers = [mod.e.words[0].word, 'WRONG_ANS', mod.e.words[2].word];   // shuffle 後的真實字序
  for (let q = 0; q < 3; q++) {
    documentStub.getElementById('esInput').value = answers[q];
    mod.submitSpelling(s);
    assert(mod.e.pendingScore === (q === 1 ? 'wrong' : 'correct'), `Q${q + 1} pendingScore=${mod.e.pendingScore}`);
    fireAll();
  }
  assert(mod.e.phase === 'result' && mod.e.correct === 2 && mod.e.wrong === 1 && mod.e.pendingScore === null, 'spell 末題走 nextWord → result correct=2 wrong=1');
  assert(pendingCount() === 0, 'spell 無殘留 timer');
}

console.log('=== T4 flip 延遲窗 exit → flush → JSON round-trip → resume firstUn 續答不雙計 ===');
{
  const mod = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const words = baseWords(3);
  const s = baseState(words); s.state.currentPage = 'exam-flip';
  startExamX(mod, s);
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn');   // Q1 對，pendingScore='correct'
  assert(mod.e.correct === 0, 'exit 前未計分');
  const saved = [];
  s.actions.saveExamSession = async (session) => saved.push(session);
  clickEl(mod, 'efExitBtn');   // exit handler：clear timer → flush → buildSession → save → config
  assert(pendingCount() === 0, 'exit 清 timer');
  assert(saved.length === 1 && saved[0].correct === 1 && saved[0].idx === 0, 'exit flush → session.correct=1、idx 停當前題');
  assert(!('pendingScore' in saved[0]), 'pendingScore 不序列化');
  // round-trip → resume
  const rt = jsonRoundTrip(saved[0]);
  const s2 = baseState(words); s2.state.currentPage = 'exam-flip';
  s2.state.examSessions = [rt];
  mod.resumeSession(s2, rt);
  assert(mod.e.phase === 'exam' && mod.e.idx === 1, 'resume firstUn=1 續答（不重答 Q1）');
  assert(mod.e.correct === 1 && mod.e.results[0] === true, '計數保留、results 完整');
}

console.log('=== T5 三頁 bottom-nav 離開返回 → 補跳恰 1 題（guardFires=1） ===');
{
  for (const [page, setup, trigger] of [
    ['exam-flip', (mod, s) => { clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn'); }, (mod, s) => {}],
    ['exam-mc', (mod, s) => { const w = mod.e.words[0]; mod.pickOption(s, w._correctIdx); }, (mod, s) => {}],
    ['exam-spell', (mod, s) => { documentStub.getElementById('esInput').value = mod.e.words[0].word; mod.submitSpelling(s); }, (mod, s) => {}],
  ]) {
    const mod = loadPage(`src/pages/${page}.js`, ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'pickOption', 'submitSpelling', 'answerCorrect', 'answerWrong', 'e']);
    const words = baseWords(3);
    const s = baseState(words); s.state.currentPage = page;
    startExamX(mod, s);
    setup(mod, s);   // 答 Q1（pendingScore 設、timer 設）
    assert(mod.e.idx === 0, `${page} 作答後 idx=0`);
    s.state.currentPage = 'dashboard';   // bottom-nav 離開
    fireAll();                           // timer fire → page guard 擋
    assert(mod.e.idx === 0 && mod.e.phase === 'exam', `${page} timer fire 被 page guard 擋（不蓋頁、idx 不變）`);
    s.state.currentPage = page;          // 返回
    mod.onMount(s);                      // 補跳 guard
    assert(mod.e.idx === 1 && mod.e.phase === 'exam', `${page} 補跳恰 1 題（idx=1、phase=exam、未直跳 result）`);
    assert(mod.e.pendingScore === null, `${page} 補跳後 flush（pendingScore=null）`);
    mod.onMount(s);                      // 再次 re-render → 不雙跳
    assert(mod.e.idx === 1, `${page} 再次 onMount 不雙跳`);
  }
}

console.log('=== T6 autoNext 關：手動下一題 / 查看結果 flush ===');
{
  timers.clear();   // 情境開頭清空（防跨情境殘留 timer 污染計數）
  const mod = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const words = baseWords(2);
  const s = baseState(words); s.state.currentPage = 'exam-flip';
  documentStub.getElementById('efAutoNext').checked = false;   // startExam 從 DOM 讀取 autoNext（先設再啟動）
  startExamX(mod, s);
  assert(mod.e.settings.autoNext === false, 'autoNext 關（DOM 讀取）');
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn');
  assert(mod.e.correct === 0 && mod.e.pendingScore === 'correct', 'autoNext 關：作答後 pendingScore 未計');
  assert(pendingCount() === 0, 'autoNext 關：無 timer');
  mod.nextWord(s);   // 手動下一題
  assert(mod.e.correct === 1 && mod.e.pendingScore === null && mod.e.idx === 1, '手動下一題 flush 計分');
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efWrongBtn');
  clickEl(mod, 'efNextBtn');   // 末題手動查看結果
  assert(mod.e.phase === 'result' && mod.e.wrong === 1, '末題手動查看結果 flush 再 result');
}

console.log('=== T7 exit 後快轉無殘留副作用（三頁） ===');
{
  for (const [page, setup] of [
    ['exam-flip', (mod, s) => { clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn'); }],
    ['exam-mc', (mod, s) => { const w = mod.e.words[0]; mod.pickOption(s, w._correctIdx); }],
    ['exam-spell', (mod, s) => { documentStub.getElementById('esInput').value = mod.e.words[0].word; mod.submitSpelling(s); }],
  ]) {
    const mod = loadPage(`src/pages/${page}.js`, ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'pickOption', 'submitSpelling', 'answerCorrect', 'answerWrong', 'e']);
    const words = baseWords(3);
    const s = baseState(words); s.state.currentPage = page;
    startExamX(mod, s);
    setup(mod, s);
    clickEl(mod, `${page === 'exam-flip' ? 'ef' : page === 'exam-mc' ? 'em' : 'es'}ExitBtn`);
    const beforeIdx = mod.e.idx, beforePhase = mod.e.phase;
    fireAll();
    assert(mod.e.idx === beforeIdx && mod.e.phase === beforePhase && pendingCount() === 0, `${page} exit 後快轉無副作用`);
  }
}

console.log('=== T8 級聯回歸（a-e） ===');
{
  // c. 第二場：模擬第一場結束殘留 judged=true → startExam 重置 → 作答不級聯
  const mod = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const words = baseWords(3);
  const s = baseState(words); s.state.currentPage = 'exam-flip';
  startExamX(mod, s);
  mod.e.judged = true; mod.e.answeredCorrect = true;   // 模擬殘留
  startExamX(mod, s);
  assert(mod.e.judged === false && mod.e.answeredCorrect === false && mod.e.pendingScore === null, 'startExam 重置 judged/answeredCorrect/pendingScore');
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn');
  assert(mod.e.idx === 0 && mod.e.phase === 'exam', '第二場作答不級聯');
  fireAll();
  assert(mod.e.idx === 1 && mod.e.correct === 1, '第二場正常推進');

  // d. stale judged：timer fire 推進後（judged 已重置）離開再返回不誤跳
  s.state.currentPage = 'dashboard'; fireAll();
  s.state.currentPage = 'exam-flip'; mod.onMount(s);
  assert(mod.e.idx === 1, 'stale judged 不誤跳（nextWord 已重置 judged=false）');

  // a/b/e 已由 T1/T5 覆蓋（作答瞬間不級聯、補跳不級聯、results 長度不變）
  assert(true, 'a/b/e 由 T1/T5 覆蓋（作答不級聯、補跳 guardFires=1、results 長度恆等）');
}

console.log('=== T9 B1 回歸（flip） ===');
{
  // applyTags 亂序標籤
  const mod = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const words = baseWords(3);
  const s = baseState(words); s.state.currentPage = 'exam-flip';
  const edits = [];
  s.actions.editWord = async (id, patch) => edits.push({ id, patch });
  startExamX(mod, s);
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn'); fireAll();   // 對
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efWrongBtn'); fireAll();     // 錯
  clickEl(mod, 'efRevealBtn'); clickEl(mod, 'efCorrectBtn'); fireAll();   // 對 → result
  mod.applyTags(s);
  for (let i = 0; i < 5; i++) await new Promise(r => queueMicrotask(r));   // 排空 async applyTags 的 editWord microtask 鏈（fake timers 下不能用 setTimeout await）
  assert(edits.length === 3, `applyTags 編輯 3 詞（實際 ${edits.length}）`);
  assert(edits[0]?.patch?.tags?.includes('correct') && !edits[0]?.patch?.tags?.includes('wrong'), 'Q1(對) → correct tag');
  assert(edits[1]?.patch?.tags?.includes('wrong') && !edits[1]?.patch?.tags?.includes('correct'), 'Q2(錯) → wrong tag');
  assert(edits[2]?.patch?.tags?.includes('correct'), 'Q3(對) → correct tag');

  // 舊存檔 sentinel：無 results → 'old' 標記 + idx 續答
  const mod2 = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const s2 = baseState(words); s2.state.currentPage = 'exam-flip';
  const oldSession = { id: 's1', mode: 'flip', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 1, correct: 1, wrong: 0, totalTime: 5, wordCount: 3, settings: { autoNext: true, delay: 1.5 } };
  mod2.resumeSession(s2, oldSession);
  assert(mod2.e.phase === 'exam' && mod2.e.idx === 1, '舊存檔 sentinel：idx=min(session.idx) 續答');
  assert(mod2.e.results[0] === 'old' && mod2.e.results[1] === undefined, 'sentinel：前段 old、當前題起 undefined');

  // 全答完 resume → 直接結果頁（firstUn=-1）
  const mod3 = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const s3 = baseState(words); s3.state.currentPage = 'exam-flip';
  const done = jsonRoundTrip({ id: 's2', mode: 'flip', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3'], idx: 2, correct: 3, wrong: 0, totalTime: 9, wordCount: 3, settings: { autoNext: true, delay: 1.5 }, results: [true, true, true] });
  mod3.resumeSession(s3, done);
  assert(mod3.e.phase === 'result', '全答完 resume → 直接結果頁零雙計');

  // 刪字錯位 lockstep：w2 未答即被刪 → filter 後 results 與存活 words 對齊，firstUn 落存活座標
  const mod4 = loadPage('src/pages/exam-flip.js', ['render', 'onMount', 'startExam', 'resumeSession', 'nextWord', 'flushPendingScore', 'applyTags', 'answerCorrect', 'answerWrong', 'e']);
  const words4 = baseWords(4);
  const s4 = baseState(words4.filter(w => w.id !== 'w2'));   // w2 被刪
  s4.state.currentPage = 'exam-flip';
  const delSession = jsonRoundTrip({ id: 's3', mode: 'flip', deckIds: ['d1'], wordIds: ['w1', 'w2', 'w3', 'w4'], idx: 1, correct: 1, wrong: 0, totalTime: 9, wordCount: 4, settings: { autoNext: true, delay: 1.5 }, results: [true, null, null, null] });
  mod4.resumeSession(s4, delSession);
  assert(mod4.e.words.length === 3 && mod4.e.idx === 1 && mod4.e.results[0] === true && mod4.e.results[1] === undefined, '刪字 lockstep：filter 後 results 對齊（firstUn 落存活座標）');
}

// ---------- 還原 timers ----------
global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout;

console.log(`\n===== 結果：${passed} 通過 / ${failed} 失敗 =====`);
process.exit(failed > 0 ? 1 : 0);
