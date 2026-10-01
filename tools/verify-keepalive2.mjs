#!/usr/bin/env node
// ═══ VERIFY-KEEPALIVE2：子頁 keep-alive／捲動記憶守門 ═══
// 依據 _dev/notes/KEEPALIVE2-fix-plan.md §4.2-4（v3）＋ round-2 實作差異：
//   R2-1 捲動存點移到 renderPage 起點（樹乾淨時讀 scrollTop；stash 內不再讀 —— 實測髒樹讀 316ms）
//   R2-2 熱子頁 chunk splash 預載（deck 1.57MB 活著時 import 求值 105→455ms）
//   R2-3 stash 重活（refs 快照）交 rIC，k2CacheIdle(name, html, refs) 參數化（holder 建於其內）
//   R2-4 靜態「stash contains('active') 活性 guard」改為 renderPage 起點存點（R2-1 連動）
// 用法: node --experimental-test-module-mocks tools/verify-keepalive2.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src/styles/base.css'), 'utf8');
const CS = fs.readFileSync(path.join(ROOT, 'src/lib/custom-select.js'), 'utf8');

let fail = 0, total = 0;
function ok(label, cond, detail) {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
}
// 負控制：mutation 必須被偵測（fn 內的斷言拋錯才算過）
function expectDetect(label, fn) {
  total++;
  try { fn(); fail++; console.log(`FAIL ${label} :: mutation 未被偵測`); }
  catch { console.log(`PASS ${label}`); }
}
const sliceRp = () => {
  const a = MAIN.indexOf('async function renderPage()');
  const b = MAIN.indexOf('// ─── Subscribe store');
  return a >= 0 && b > a ? MAIN.slice(a, b) : '';
};

// ════════ 靜態 ════════
const rp = sliceRp();

const coldAdj = /const rendered = mod\.render\(store\);[^\n]*\n\s*if \(tryWarmEnter\(page, rendered, gen, mod\)\) return;\n\s*stashSubpage\(\);\n\s*if \(gen !== _renderGen\) return;\n\s*container\.innerHTML = rendered/.test(rp);
const rpRenderCalls = (rp.match(/mod\.render\(/g) || []).length;
const rpStartCount = (MAIN.match(/async function renderPage\(\)/g) || []).length;
const stashBody = (m) => { const i = m.indexOf('function stashSubpage()'); const j = m.indexOf('function k2CacheIdle'); return i >= 0 && j > i ? m.slice(i, j) : ''; };
const sb = stashBody(MAIN);
const warmBody = (() => { const i = MAIN.indexOf('function tryWarmEnter'); const j = MAIN.indexOf('function applySub'); return i >= 0 && j > i ? MAIN.slice(i, j) : ''; })();
const applyBody = (() => { const i = MAIN.indexOf('function applySub'); const j = MAIN.indexOf('// [K2-END]'); return i >= 0 && j > i ? MAIN.slice(i, j) : ''; })();
const k2Body = (() => { const a = MAIN.indexOf('// [K2-BEGIN]'); const b = MAIN.indexOf('// [K2-END]'); return a >= 0 && b > a ? MAIN.slice(a, b) : ''; })();

ok('S1 cold 序 render→tryWarm→stash→guard→innerHTML 相鄰', coldAdj);
ok('S2 rpBody 字面 async function renderPage() 全檔恰 1 處', rpStartCount === 1, `n=${rpStartCount}`);
ok('S3 stash 五呼叫點（onRootDeactivate/tryWarm/cold/no-render/catch）', [
  /\{ stashSubpage\(\); return; \}/.test(MAIN),          // onRootDeactivate
  /\n\s*stashSubpage\(\);\n\s*container\.replaceChildren/.test(MAIN),
  /if \(tryWarmEnter[\s\S]{0,80}return;\n\s*stashSubpage\(\);/.test(rp),
  /\} else \{\n\s*stashSubpage\(\);/.test(rp),
  /console\.error\('Page load error:'[\s\S]{0,120}stashSubpage\(\);/.test(rp),
].every(Boolean));
ok('S4 stash try/finally 清空（innerHTML 空字串在 finally）', /\} finally \{\s*\n[\s\S]*?container\.innerHTML = '';/m.test(sb));
ok('S5 const html = _activeSubHtml 快照', /const html = _activeSubHtml;/.test(sb));
ok('S6 _subCache.set 參數化（該行無 _activeSub）', (() => { const l = MAIN.split('\n').find(x => x.includes('_subCache.set(')); return l && !l.includes('_activeSub'); })());
ok('S7 holder 由 k2CacheIdle 區域 createElement', /function k2CacheIdle[\s\S]*?document\.createElement\('div'\)/.test(k2Body));
ok('S8 _activeSubRoot 身分比對（投毒防護）', /container\.firstElementChild === _activeSubRoot/.test(sb));
ok('S9 applySub 記帳三件＋typeof mod.onMount', /_activeSub = page;/.test(applyBody) && /_activeSubHtml = html;/.test(applyBody) && /_activeSubRoot = container\.firstElementChild;/.test(applyBody) && /typeof mod\.onMount === 'function'/.test(applyBody));
ok('S10 warm：同頁短路＋html 指紋比對＋命中刪 entry', /page === _activeSub/.test(warmBody) && /\(rendered \?\? ''\) !== entry\.html/.test(warmBody) && /_subCache\.delete\(page\);\n\s*applySub/.test(warmBody));
ok('S11 rpBody mod.render( 恰 1 次', rpRenderCalls === 1, `n=${rpRenderCalls}`);
ok('S12 rIC 排程＋FIFO≤6', /requestIdleCallback\(idle/.test(sb) && /_subCache\.size > 6/.test(MAIN));
const arCalls = MAIN.split('\n').filter(l => /^\s*setActiveRoot\(/.test(l));
ok('S13 setActiveRoot 4 呼叫全帶頁名', arCalls.length === 4 && arCalls.every(l => /setActiveRoot\([^)]+, /.test(l)), `n=${arCalls.length}`);
const arDef = (() => { const i = MAIN.indexOf('function setActiveRoot(el, name)'); return i >= 0 ? MAIN.slice(i, MAIN.indexOf('\nfunction ', i + 10) > 0 ? MAIN.indexOf('\nfunction ', i + 10) : i + 2000) : ''; })();
ok('S14 存點先於 remove(active)＋無 id 條件＋_activeRootName != null guard', arDef.includes('_scrollPos.set') && arDef.indexOf('_scrollPos.set') < arDef.indexOf(".remove('active')") && !/id ===|\.id\b/.test(arDef.split('_scrollPos.set')[0]) && arDef.includes('_activeRootName != null'));
ok('S14b setScrollNow 瞬時捲動（area.scrollTop = y 在 auto 窗內）', /function setScrollNow\(area, y\) \{[\s\S]*?scrollBehavior = 'auto';[\s\S]*?area\.scrollTop = y;/.test(MAIN));
ok('R2-1 存點在 renderPage 起點、先於 leaving（stash 內不讀 scrollTop）', (() => {
  const i = MAIN.indexOf('async function renderPage()');
  const j = MAIN.indexOf("classList.add('leaving')", i);
  const k = MAIN.indexOf('_scrollPos.set(_activeSub, a.scrollTop)', i);
  return k > i && k < j && !/\.scrollTop/.test(sb);
})());
ok('S16 deferRefresh 內補 restoreScroll', /function deferRefresh[\s\S]*?restoreScroll\(name\)/.test(MAIN));
ok('S17 catch 首行 gen guard', /catch \(e\) \{\s*\n\s*if \(gen !== _renderGen\) return;/.test(rp));
ok('S18 import 含 closeAll', /import \{ initCustomSelects, closeAll \}/.test(MAIN));
ok('S19 css pageIn 200ms var(--ease-standard)', CSS.includes('animation:pageIn 200ms var(--ease-standard)'));
ok('S20 css #pageContainer.leaving pointer-events:none', CSS.includes('#pageContainer.leaving{pointer-events:none}'));
ok('S21 closeAll export', /export function closeAll\(\)/.test(CS));
ok('S22 leaving remove ≥4 路徑', (MAIN.match(/container\.classList\.remove\('leaving'\)/g) || []).length >= 4, `n=${(MAIN.match(/container\.classList\.remove\('leaving'\)/g) || []).length}`);
ok('R2-2 熱子頁 splash 預載（4 頁 loadPage）', /for \(const p of \['deck-browser', 'ocr', 'import', 'app-log'\]\) await loadPage\(p\)/.test(MAIN));
// 18+ 頁有 export function render 且 render 主體零 document.
const pagesDir = path.join(ROOT, 'src/pages');
const pageFiles = fs.readdirSync(pagesDir).filter(f => f.endsWith('.js'));
let withRender = 0, docInRender = [];
for (const f of pageFiles) {
  const src = fs.readFileSync(path.join(pagesDir, f), 'utf8');
  const i = src.indexOf('export function render');
  if (i < 0) continue;
  withRender++;
  let d = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { d++; started = true; }
    else if (src[k] === '}') { d--; if (started && d === 0) { const body = src.slice(i, k); if (/^\s*document\./m.test(body)) docInRender.push(f); break; } }
  }
}
ok('S25 ≥18 頁有 export function render 且 render 主體零 document.', withRender >= 18 && docInRender.length === 0, `pages=${withRender} docIn=${docInRender.join(',')}`);

// ════════ 動態（jsdom，抽真碼）══════════
const STATE = (() => {
  const a = MAIN.indexOf('// ─── KEEPALIVE2：子頁 keep-alive');
  const b = MAIN.indexOf('const _scrollPos = new Map();');
  return a >= 0 && b > a ? MAIN.slice(a, b + 'const _scrollPos = new Map();'.length) : '';
})();

function makeCtx(mutate) {
  const dom = new JSDOM('<!doctype html><html><body><div id="pageContainer" class="page active"></div><div id="contentArea"></div></body></html>');
  const doc = dom.window.document;
  const container = doc.getElementById('pageContainer');
  const idleQ = [];
  const mocks = {
    $: (id) => doc.getElementById(id),
    closeAll: () => {},
    initCustomSelects: () => {},
    setActiveRoot: (el, name) => { mocks._lastRoot = name; },
    restoreScroll: () => {},
    requestIdleCallback: (cb) => { idleQ.push(cb); return idleQ.length; },
    store: { state: {} },
    document: doc,
  };
  let code = `let _renderGen = 1;\n${STATE}\n${k2Body}\nreturn { stashSubpage, k2CacheIdle, tryWarmEnter, applySub, k2SyncSelectOptions, k2StripSelects, subCache: _subCache, readActive: () => _activeSub, readHtml: () => _activeSubHtml, setHtml: (v) => { _activeSubHtml = v; }, setRoot: (v) => { _activeSubRoot = v; }, setSub: (v) => { _activeSub = v; } };`;
  if (mutate) code = mutate(code);
  const api = new Function('$', 'closeAll', 'initCustomSelects', 'setActiveRoot', 'restoreScroll', 'requestIdleCallback', 'store', 'document', code)(
    mocks.$, mocks.closeAll, mocks.initCustomSelects, mocks.setActiveRoot, mocks.restoreScroll, mocks.requestIdleCallback, mocks.store, mocks.document);
  const flushIdle = () => { const q = idleQ.splice(0); q.forEach(cb => cb()); };
  return { doc, container, api, flushIdle, mocks };
}
const mod = { onMount: () => {} };

// (a) 指紋快照：stash 後改模組變數，flush 仍須收當時 rendered
{
  const { container, api, flushIdle } = makeCtx();
  container.innerHTML = '<div id="r1">OCR</div>';
  api.applySub('ocr', 'RENDER_A', mod);
  api.stashSubpage();
  api.setHtml('POISON');                       // 模擬後續頁改寫模組變數
  flushIdle();
  ok('(a) idle 收到的是 stash 當時 html 快照', api.subCache.get('ocr')?.html === 'RENDER_A', `got=${api.subCache.get('ocr')?.html}`);
  expectDetect('(a) 負控制：idle 改讀模組變數 → 偵測', () => {
    const c = makeCtx(code => code.replace('k2CacheIdle(name, html, refs)', 'k2CacheIdle(name, _activeSubHtml, refs)'));
    c.container.innerHTML = '<div id="r1">OCR</div>';
    c.api.applySub('ocr', 'RENDER_A', mod);
    c.api.stashSubpage();
    c.api.setHtml('POISON');
    c.flushIdle();
    if (c.api.subCache.get('ocr')?.html !== 'RENDER_A') throw new Error('poisoned');
  });
}

// (b) 投毒：stash 前容器內容被換 → 不入快取
{
  const { container, api, flushIdle } = makeCtx();
  container.innerHTML = '<div id="r1">OCR</div>';
  api.applySub('ocr', 'RENDER_A', mod);
  container.innerHTML = '<div id="ghost">OTHER</div>';   // ghost 蓋版，身分不符
  api.stashSubpage();
  flushIdle();
  ok('(b) 投毒內容不入 _subCache', !api.subCache.has('ocr'));
  expectDetect('(b) 負控制：抽掉 _activeSubRoot 比對 → 偵測', () => {
    const c = makeCtx(code => code.replace('container.firstElementChild === _activeSubRoot', 'true'));
    c.container.innerHTML = '<div id="r1">OCR</div>';
    c.api.applySub('ocr', 'RENDER_A', mod);
    c.container.innerHTML = '<div id="ghost">OTHER</div>';
    c.api.stashSubpage();
    c.flushIdle();
    if (c.api.subCache.has('ocr')) throw new Error('poisoned accepted');
  });
}

// (c) 子→主：stash 後容器必須空（id 影遮守門）
{
  const { container, api, flushIdle } = makeCtx();
  container.innerHTML = '<div id="r1">OCR</div>';
  api.applySub('ocr', 'RENDER_A', mod);
  api.stashSubpage();
  flushIdle();
  ok('(c) stash 後 container.childNodes 为空', container.childNodes.length === 0, `n=${container.childNodes.length}`);
  expectDetect('(c) 負控制：抽掉 finally 清空 → 偵測', () => {
    const c = makeCtx(code => code.replace(/\n\s*container\.innerHTML = '';/, ''));
    c.container.innerHTML = '<div id="r1">OCR</div>';
    c.api.applySub('ocr', 'RENDER_A', mod);
    c.api.stashSubpage();
    if (c.container.childNodes.length !== 0) throw new Error('not cleared');
  });
}

// (d) 離場→回訪全流程：不拋＋warm 命中後 leaving=false＋stale idle 不覆蓋新頁
{
  const { container, api, flushIdle, doc } = makeCtx();
  container.innerHTML = '<div id="r1">OCR</div>';
  api.applySub('ocr', 'RENDER_A', mod);
  api.stashSubpage();
  flushIdle();                                        // entry 就緒
  const hit = api.tryWarmEnter('ocr', 'RENDER_A', 1, mod);   // 回訪（暖命中）
  ok('(d) 暖命中：hit、leaving=false、_activeSub 記帳', hit === true && !container.classList.contains('leaving') && api.readActive() === 'ocr');
  container.classList.add('leaving');
  api.stashSubpage();                                 // 再離場：stale idle 已排隊
  container.innerHTML = '<div id="fresh">NEWPAGE</div>';
  api.applySub('deck-browser', 'DECK_HTML', { onMount: () => {} });  // 新頁上屏
  flushIdle();                                        // stale flush 事後才跑
  ok('(d) stale idle flush 不覆蓋新頁', container.innerHTML.includes('NEWPAGE'), `html=${container.innerHTML.slice(0, 60)}`);
}

// (e) select round-trip：property 選取 → sync → clone → strip → 重建
{
  const { container, api, flushIdle, doc } = makeCtx();
  container.innerHTML = '<div id="root"><div class="cs-wrap"></div><select data-cs><option value="1">A</option><option value="2">B</option></select></div>';
  api.applySub('settings', 'SETTINGS_HTML', mod);
  const sel = container.querySelector('select');
  sel.value = '2';                                    // 使用者選取（property 級）
  api.stashSubpage();
  flushIdle();                                        // sync→clone→strip→快取
  const entry = api.subCache.get('settings');
  ok('(e) 快取存在', !!entry);
  if (entry) {
    container.replaceChildren(...entry.nodes);        // 暖重建
    const sels = container.querySelectorAll('select');
    const wraps = container.querySelectorAll('.cs-wrap');
    const attrSel = container.querySelectorAll('option[selected]');
    ok('(e) 重建後無 data-cs、無 .cs-wrap、select 保留', sels.length === 1 && wraps.length === 0 && !container.querySelector('select[data-cs]'), `sels=${sels.length} wraps=${wraps.length}`);
    ok('(e) option[selected] 恰 1 個且＝使用者選項(value=2)', attrSel.length === 1 && attrSel[0].value === '2', `n=${attrSel.length} v=${attrSel[0]?.value}`);
  } else { ok('(e) 重建後檢查', false, 'no entry'); ok('(e) option[selected]', false, 'no entry'); }
}

// ════════ 負控制（靜態字串層）══════════
// 慣例：fn 若「檢查對 mutation 仍成立」= 不拋 → expectDetect FAIL；檢查抓住 mutation → 拋 = PASS
const cssCheck = (s) => s.includes('animation:pageIn 200ms var(--ease-standard)');
const coldAdjCheck = (s) => /const rendered = mod\.render\(store\);[^\n]*\n\s*if \(tryWarmEnter\(page, rendered, gen, mod\)\) return;\n\s*stashSubpage\(\);\n\s*if \(gen !== _renderGen\) return;\n\s*container\.innerHTML = rendered/.test(s);

expectDetect('N4 負控制：css 改回 var(--t-slow) → 偵測', () => {
  const m = CSS.replace('animation:pageIn 200ms var(--ease-standard)', 'animation:pageIn var(--t-slow)');
  if (cssCheck(m)) return;                           // 檢查沒抓住 mutation → 不拋 → FAIL
  throw new Error('detected');
});
expectDetect('N5 負控制：cold 序（stash↔guard 之間）插入早清 → 偵測', () => {
  const rp2 = rp.replace("stashSubpage();\n      if (gen !== _renderGen) return;",
    "stashSubpage();\n      container.innerHTML = '';\n      if (gen !== _renderGen) return;");
  if (rp2 === rp) return;                            // mutation 沒套上（模板漂移）→ 不拋 → FAIL 提示
  if (coldAdjCheck(rp2)) return;
  throw new Error('detected');
});

console.log(fail === 0 ? `\n═══ verify-keepalive2: ${total}/${total} ALL PASS ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
