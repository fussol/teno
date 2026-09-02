// G3 驗證工具 — 子頁 nav 無 active 高亮 + setReviewDeckFilter 不入 pageHistory
// 兩半：
//  A) main.js 靜態接線（核心 bug：SUBPAGE_PARENT 算出未用）——
//     sidebar navItemHtml / bottomItems / 運行時 toggle 全要用 resolveNavPage，
//     且不得殘留 raw `${current === n.id ? 'active'}`。
//  B) store.js pageHistory 不變式（navigate/goBack/setReviewDeckFilter 語意）——
//     以 clone 驗證不變式 + 靜態斷言真源碼含 G3 guard（防 clone 自證）。
// 負控制：A 對「前修法（僅算 const navCurrent 未使用）」必須紅（斷言 raw current 不存在 → 前修會留 raw）。
// 全程不修改任何源碼；node tools/verify-g3.mjs 執行。
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

// ────────────────────── A. main.js 靜態接線 ──────────────────────
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(ROOT, 'src/lib/store.js'), 'utf8');

// A1: 子頁→主頁 mapping 全鍵存在
const KEYS = ['study-v4','study-mc','study-spell','exam-flip','exam-mc','exam-spell',
  'deck-browser','tag-manager','import','export','ocr','simulator','app-log'];
console.log('A1 SUBPAGE_PARENT / resolveNavPage 定義');
assert(/const SUBPAGE_PARENT\s*=\s*\{/.test(mainSrc), '模組層定義 SUBPAGE_PARENT');
assert(/const resolveNavPage\s*=\s*\(p\)\s*=>\s*\(SUBPAGE_PARENT\[p\]\s*\|\|\s*p\)/.test(mainSrc),
  '定義 resolveNavPage（回退自身頁）');
for (const k of KEYS) assert(mainSrc.includes(`'${k}':`), `SUBPAGE_PARENT 含 '${k}'`);

// A2: sidebar navItemHtml 用 navCurrent（核心 bug 修處）
console.log('A2 sidebar active 高亮');
const sidebarActiveOk =
  mainSrc.includes(`const navCurrent = resolveNavPage(current);`) &&
  mainSrc.includes(`class="nav-item \${navCurrent === n.id ? 'active' : ''}"`);
assert(sidebarActiveOk, 'renderSidebar 以 navCurrent 判 active（不再 raw current）');

// A3: bottom bar（renderAppShell）用 navCurrent
console.log('A3 bottom-bar active 高亮');
assert(mainSrc.includes(`const navCurrent = resolveNavPage(current);`),
  'renderAppShell 也有 navCurrent');
assert(mainSrc.includes(`class="bottom-item \${navCurrent === n.id ? 'active' : ''}"`),
  'bottom-item 以 navCurrent 判 active');

// A4: 運行時 toggle（store.subscribe 內）用 resolveNavPage
console.log('A4 運行時 toggle');
assert(mainSrc.includes(`el.dataset.page === resolveNavPage(state.currentPage)`),
  '運行時 toggle 走 resolveNavPage');

// A5 負控制：不得殘留 raw current（前修法會留 → 無修法必紅）
console.log('A5 負控制（無修法必紅）');
const leftoverRaw = [
  `class="nav-item \${current === n.id ? 'active' : ''}"`,
  `class="bottom-item \${current === n.id ? 'active' : ''}"`,
].every(s => !mainSrc.includes(s));
assert(leftoverRaw, 'sidebar/bottom 均無 raw current active 殘留');

// ─────────────────── B. store.js pageHistory 不變式 ───────────────────
console.log('B1 store.js G3 guard 存在（靜態）');
assert(
  /\/\/ G3：跳 study-v4 前 push 現頁進 pageHistory/.test(storeSrc) &&
  storeSrc.includes(`const prev = state.currentPage;\n      if (prev && prev !== 'study-v4') {`),
  'setReviewDeckFilter 內含 G3 pageHistory push guard');

// B2: pageHistory 不變式 clone（navigate/goBack/setReviewDeckFilter 語意）
// 不變式：進 study-v4 前已紀錄上一頁 → goBack 能回到原頁；且非重複項不入棧。
console.log('B2 pageHistory 不變式（clone 驗證語意）');
function mkStore() {
  const state = { currentPage: 'dashboard', pageHistory: [], reviewDeckFilter: null };
  let notified = 0;
  const env = {
    state,
    notify() { notified++; },
    navigate(page) {
      const prev = state.currentPage;
      if (prev && prev !== page) {
        const h = state.pageHistory;
        if (h[h.length - 1] !== prev) h.push(prev);
      }
      state.currentPage = page;
    },
    goBack() {
      const prev = state.pageHistory.pop();
      if (prev) { state.currentPage = prev; return true; }
      return false;
    },
    setReviewDeckFilter(deckName) {
      const prev = state.currentPage;
      if (prev && prev !== 'study-v4') {
        const h = state.pageHistory;
        if (h[h.length - 1] !== prev) h.push(prev);
      }
      state.reviewDeckFilter = state.reviewDeckFilter === deckName ? null : deckName;
      state.currentPage = 'study-v4';
    },
  };
  return env;
}

// 情境 1：dashboard → setReviewDeckFilter → study-v4 → back 回到 dashboard
{
  const s = mkStore();
  s.setReviewDeckFilter('考');            // dashboard → study-v4
  assert(s.state.currentPage === 'study-v4', 'setReviewDeckFilter 進入 study-v4');
  assert(s.state.pageHistory.includes('dashboard'), 'study-v4 前已記 dashboard');
  const ret = s.goBack();
  assert(ret === true && s.state.currentPage === 'dashboard', 'goBack 回到 dashboard（不再直接退 app）');
}
// 情境 2：已在 study-v4 再 setReviewDeckFilter → 不重複入棧
{
  const s = mkStore();
  s.setReviewDeckFilter('A');   // dashboard→study-v4, 棧=[dashboard]
  // 中途回到 dashboard
  s.goBack();                    // 棧=[]
  s.setReviewDeckFilter('A');    // dashboard→study-v4, 棧=[dashboard]
  s.setReviewDeckFilter('B');    // 已在 study-v4 → 不 push, 棧仍=[dashboard]
  assert(s.state.currentPage === 'study-v4', '再 setReviewDeckFilter 仍在 study-v4');
  assert(JSON.stringify(s.state.pageHistory) === JSON.stringify(['dashboard']),
    'study-v4 內重複觸發不入重複棧');
}
// 情境 3：普通 navigate 入棧不受影響（回歸）
{
  const s = mkStore();
  s.navigate('study'); s.navigate('study-v4');
  assert(JSON.stringify(s.state.pageHistory) === JSON.stringify(['dashboard', 'study']),
    'navigate 既有 pageHistory 行為不回歸');
}

// ─────────────────────── 總結 ───────────────────────
console.log(`\nG3 驗證：${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('G3 verify FAILED'); process.exit(1); }
console.log('G3 verify ALL PASS');