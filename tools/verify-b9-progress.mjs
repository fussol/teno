// B9 驗證工具 — 測驗進度條以「已答題數」為準（非 idx 制）
// Bug 事實（audit）：三頁 renderExam `const pct = Math.round((e.idx / total) * 100)`：
//   1. 第一題 idx=0 → 0%（可以）；最後一題 idx=total-1 → (total-1)/total 永遠不到 100%
//   2. 答完最後一題進結果頁時才「看到」100%（結果頁 pct 是 correct+wrong 分數制，非進度）
//   3. 答題後落後一題：idx 是「當前題號」，答完才 nextWord(idx++) → 進度條反映落後
// 修法（B9 決策：已答題數語意 — 測驗中到 100% = 全答完）：
//   src/pages/exam-flip.js  :133 `answered = e.results 非 undefined 數`（undefined=未答；true/false/'old'=已答）
//   src/pages/exam-mc.js    :131 同（results 即時寫 B3）
//   src/pages/exam-spell.js :131 `answered = e.words 中 w._correct !== undefined 數`（spell 無 e.results，B1/B4 同源）
//   結果頁 renderResult pct（correct+wrong 分數制）語意正確 → 不動。
// 負控制（mutation）：三頁 pct 行換回 `(e.idx / total)` → 舊 bug 必須再現（測試對修法敏感）。
// 全程不修改任何源碼；node tools/verify-b9-progress.mjs 執行。
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

// ---------- DOM / 依賴 stub（對齊 verify-b5/b6/b7/b8 既有 harness） ----------
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

// ---------- 頁面載入器（真實源碼 → new Function；legacyPct = 剝除 B9 修法做負控制） ----------
const EXTRA_EXPORTS = {
  'flip': ['answerCorrect', 'answerWrong'],
  'mc': ['pickOption'],
  'spell': ['submitSpelling'],
};
function loadPage(mode, { legacyPct = false } = {}) {
  for (const k of Object.keys(els)) if (k !== 'pageContainer') delete els[k];   // 重置共享 DOM stub
  const file = path.join(ROOT, `src/pages/exam-${mode}.js`);
  let src = fs.readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/\bexport function/g, 'function')
    .replace(/\bexport async function/g, 'async function');
  if (legacyPct) {
    const before = src;
    // 剝除 B9 修法（已答題數 pct 行）→ 回到 idx 制（bug 前提）
    src = src.replace(/const pct = Math\.round\(\(answered \/ total\) \* 100\);/, 'const pct = Math.round((e.idx / total) * 100);');
    if (src === before) throw new Error(`[harness] legacyPct: 源碼中找不到 B9 pct 行 — ${file}`);
  }
  const exportNames = ['render', 'onMount', 'startExam', 'resumeSession', 'e', 'nextWord', 'recordExamResult', 'renderInPlace', 'flushPendingScore', ...(EXTRA_EXPORTS[mode] || [])];
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
const flushAsync = () => new Promise(r => setTimeout(r, 0));

// ---------- 進度條 pct 提取（renderExam HTML 的 study-progress-fill width） ----------
function progressPct(html) {
  const m = html.match(/study-progress-fill" style="width:(\d+)%"/);
  return m ? Number(m[1]) : null;
}
// 結果頁 pct 提取（renderResult HTML 的 48px 大數字）
function resultPct(html) {
  const m = html.match(/font-size:48px;font-weight:800;color:[^>]*>(\d+)<span/);
  return m ? Number(m[1]) : null;
}

// ---------- 每頁作答一步（答對） ----------
function answerCurrent(mod, s) {
  const mode = s.state.currentPage.replace('exam-', '');
  if (mode === 'flip') mod.answerCorrect(s);
  else if (mode === 'mc') mod.pickOption(s, mod.e.words[mod.e.idx]._correctIdx);
  else {
    documentStub.getElementById('esInput').value = mod.e.words[mod.e.idx].word;
    mod.submitSpelling(s);
  }
}
// 每頁答錯一步
function answerCurrentWrong(mod, s) {
  const mode = s.state.currentPage.replace('exam-', '');
  if (mode === 'flip') mod.answerWrong(s);
  else if (mode === 'mc') {
    const w = mod.e.words[mod.e.idx];
    const wrongIdx = (w._correctIdx + 1) % w._options.length;
    mod.pickOption(s, wrongIdx);
  } else {
    documentStub.getElementById('esInput').value = 'WRONG_ANSWER';
    mod.submitSpelling(s);
  }
}

// ---------- T1 主流程：10 題，第 1 題 0%、答題後立即反映、全答完 100% ----------
function t1MainFlow() {
  console.log('=== T1 主流程（10 題）：已答 n → n/10；第 1 題 0%、全答完 100%、答題不落後 ===');
  for (const mode of ['flip', 'mc', 'spell']) {
    const mod = loadPage(mode);
    const words = baseWords(10);
    const s = baseState(words, `exam-${mode}`);
    mod.e.decks = ['d1'];
    mod.startExam(s);
    mod.e.settings.autoNext = false;   // 手動推進（避免 timer）
    assert(mod.e.phase === 'exam', `${mode}: startExam → phase=exam`);

    const pct0 = progressPct(mod.render(s));
    assert(pct0 === 0, `${mode}: 第 1 題（已答 0）→ pct=0%（got ${pct0}%）`);

    // 依序答 n 題（每題答完、尚未 nextWord 時 render → 已答 n → n/10，不落後）
    for (let n = 1; n <= 10; n++) {
      answerCurrent(mod, s);
      const pct = progressPct(mod.render(s));
      assert(pct === n * 10, `${mode}: 已答 ${n}/10 → pct=${n * 10}%（got ${pct}%）`);
      if (n < 10) mod.nextWord(s);
    }
    // 全部答完仍在 exam phase（尚未 nextWord 到結果頁）→ 100%
    assert(mod.e.phase === 'exam', `${mode}: 答完 10 題仍在 exam phase（未進結果頁）`);
  }
}

// ---------- T2 resume：續答場已答題數延續（前場答過的也算已答） ----------
function t2Resume() {
  console.log('=== T2 resume：前場已答題計入進度（flip results / mc results / spell spellData）===');
  {
    // flip：results [true,false,'old',undefined...] → 已答 3
    const mod = loadPage('flip');
    const words = baseWords(10);
    const s = baseState(words, 'exam-flip');
    const session = {
      id: 'seed_flip', mode: 'flip', deckIds: ['d1'], wordIds: words.map(w => w.id), idx: 3, correct: 2, wrong: 1, totalTime: 3, wordCount: 10,
      settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
      results: [true, false, 'old', undefined, undefined, undefined, undefined, undefined, undefined, undefined],
    };
    mod.resumeSession(s, session);
    const pct = progressPct(mod.render(s));
    assert(pct === 30, `flip resume（已答 3/10）→ pct=30%（got ${pct}%）`);
  }
  {
    // mc：results 前 2 有值 → 已答 2
    const mod = loadPage('mc');
    const words = baseWords(10);
    const s = baseState(words, 'exam-mc');
    const mcData = {};
    for (let i = 0; i < 2; i++) mcData[words[i].id] = { options: [words[i].word, 'x', 'y', 'z'], correctIdx: 0, answered: true, picked: 0 };
    const session = {
      id: 'seed_mc', mode: 'mc', deckIds: ['d1'], wordIds: words.map(w => w.id), idx: 2, correct: 2, wrong: 0, totalTime: 3, wordCount: 10,
      settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
      results: [true, true, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
      mcData,
    };
    mod.resumeSession(s, session);
    const pct = progressPct(mod.render(s));
    assert(pct === 20, `mc resume（已答 2/10）→ pct=20%（got ${pct}%）`);
  }
  {
    // spell：spellData 前 4 題 → 已答 4
    const mod = loadPage('spell');
    const words = baseWords(10);
    const s = baseState(words, 'exam-spell');
    const spellData = {};
    for (let i = 0; i < 4; i++) spellData[words[i].id] = i % 2 === 0;
    const session = {
      id: 'seed_spell', mode: 'spell', deckIds: ['d1'], wordIds: words.map(w => w.id), idx: 4, correct: 2, wrong: 2, totalTime: 3, wordCount: 10,
      settings: { count: 0, autoNext: false, delay: 1.5, tagCorrect: 'correct', tagWrong: 'wrong' },
      results: [], spellData,
    };
    mod.resumeSession(s, session);
    const pct = progressPct(mod.render(s));
    assert(pct === 40, `spell resume（spellData 已答 4/10）→ pct=40%（got ${pct}%）`);
  }
}

// ---------- T3 結果頁 pct 不變：分數制（correct+wrong）語意保留 ----------
async function t3ResultPage() {
  console.log('=== T3 結果頁 pct 不變：renderResult 仍是 correct/(correct+wrong) 分數制 ===');
  for (const mode of ['flip', 'mc', 'spell']) {
    const mod = loadPage(mode);
    const words = baseWords(10);
    const s = baseState(words, `exam-${mode}`);
    mod.e.decks = ['d1'];
    mod.startExam(s);
    mod.e.settings.autoNext = false;
    // 前 6 題答對、後 4 題答錯 → correct=6 wrong=4 → 結果頁 pct=60%
    for (let i = 0; i < 10; i++) {
      if (i < 6) answerCurrent(mod, s);
      else answerCurrentWrong(mod, s);
      mod.nextWord(s);
    }
    assert(mod.e.phase === 'result', `${mode}: 完成 → phase=result`);
    await flushAsync(); await flushAsync();   // recordExamResult async 落定
    const rp = resultPct(mod.render(s));
    assert(rp === 60, `${mode}: 結果頁 pct=60%（6/10 分數制，got ${rp}%）`);
    assert(mod.e.correct === 6 && mod.e.wrong === 4, `${mode}: correct=6 wrong=4（got ${mod.e.correct}/${mod.e.wrong}）`);
  }
}

// ---------- T4 三頁一致性：同已答數 → 同 pct ----------
function t4Consistency() {
  console.log('=== T4 三頁一致性：相同已答數 → 相同進度 pct ===');
  const seqs = {};
  for (const mode of ['flip', 'mc', 'spell']) {
    const mod = loadPage(mode);
    const words = baseWords(10);
    const s = baseState(words, `exam-${mode}`);
    mod.e.decks = ['d1'];
    mod.startExam(s);
    mod.e.settings.autoNext = false;
    const seq = [];
    for (let n = 0; n <= 10; n++) {
      seq.push(progressPct(mod.render(s)));   // 已答 n 時的 pct
      if (n < 10) { answerCurrent(mod, s); if (n < 9) mod.nextWord(s); }   // 答完第 10 題不推進（維持 exam phase）
    }
    seqs[mode] = seq;
  }
  const a = seqs.flip, b = seqs.mc, c = seqs.spell;
  assert(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
    `三頁 pct 序列一致 [${a.join(',')}]`);
  assert(a[0] === 0 && a[10] === 100, `序列起點 0% / 終點 100%（got ${a[0]}% → ${a[10]}%）`);
}

// ---------- T5 負控制（mutation：剝除 B9 修法）→ 舊 bug 必須再現 ----------
function t5NegativeControl() {
  console.log('=== T5 負控制（剝除 B9 pct 修法）→ idx 制舊 bug 必須再現 ===');
  for (const mode of ['flip', 'mc', 'spell']) {
    const mod = loadPage(mode, { legacyPct: true });
    const words = baseWords(10);
    const s = baseState(words, `exam-${mode}`);
    mod.e.decks = ['d1'];
    mod.startExam(s);
    mod.e.settings.autoNext = false;
    answerCurrent(mod, s);   // 已答 1
    const pctAfter1 = progressPct(mod.render(s));
    assert(pctAfter1 === 0, `${mode}（legacy）: 答完第 1 題仍 0%（落後一題 — got ${pctAfter1}%）`);
    for (let n = 2; n <= 10; n++) { mod.nextWord(s); answerCurrent(mod, s); }
    const pctLast = progressPct(mod.render(s));
    assert(pctLast === 90, `${mode}（legacy）: 答完 10 題只到 90%（到不了 100% — got ${pctLast}%）`);
  }
}

await (() => { t1MainFlow(); t2Resume(); t4Consistency(); t5NegativeControl(); })();
await t3ResultPage();

console.log(`\n結果：${passed} 通過 / ${failed} 失敗`);
process.exit(failed ? 1 : 0);
