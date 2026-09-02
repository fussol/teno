// verify-f7-splash.mjs v1 — F7: splash 閃爍柔化＋icon cache 前置＋getLauncherIcon 重試
//
// ══ 威脅模型 ══
// 防：無意回歸（transition 丟失/cache 單端/重試消失/鍵字面漂移/雙份 bg 碼复活）、
//     decoy 偽裝（註解/字串內字面混過掃描）、鍵名兩檔失配、殭屍邏輯（只在註解）。
// 不防：對抗性混淆；不驗真實 Android binder 行為（重試語意由 T2 在 _splashDeps
//     注入 seam 實跑真實碼段證明；harness 嚴禁供給被驗證的迴圈本身）。
// 體例：D6 v2 同族——位置保持遮罩＋括號計數器＋模式自判（BUG 態 T0 打真實源碼
//     確認缺陷＋修法腿 N/A＋EXIT=1 必紅；FIXED 態全斷言打真實源碼；漂移 EXIT=2）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0, na = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  PASS ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
const naLeg = (n, w) => { na++; console.log(`  N/A  ${n}（${w}）`); };

function mask(src) {
  const out = src.split('');
  const blank = (i, j) => { for (let k = i; k < j && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(j + 2, n); blank(i, j); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; break; } j++; }
      blank(i + 1, j - 1); i = j; continue;
    }
    i++;
  }
  return out.join('');
}
function extractBlock(masked, anchor) {
  const i = masked.indexOf(anchor);
  if (i === -1) return null;
  const open = masked.indexOf('{', i);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < masked.length; j++) {
    if (masked[j] === '{') depth++;
    else if (masked[j] === '}') { depth--; if (depth === 0) return masked.slice(i, j + 1); }
  }
  return null;
}
// 注解遮罩版（去 // 與 /* */ 但保留字串內容）：鍵字面/theme-color 等「字串值」偵測
// 必須看得到字串內容；此形態仍防註解內 decoy（R1 D6 A1/A7 族）。字串內 decoy 屬
// 低風險面（不影響 runtime 鍵值），威脅模型成文不防。
function commentMask(src) {
  const out = src.split('');
  const blank = (i, j) => { for (let k = i; k < j && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(j + 2, n); blank(i, j); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === c) { j++; break; } j++; }
      i = j; continue; // 跳過字串但不遮
    }
    i++;
  }
  return out.join('');
}
function extractBlockRaw(raw, anchor) {
  const i = raw.indexOf(anchor);
  if (i === -1) return null;
  const open = raw.indexOf('{', i);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < raw.length; j++) {
    if (raw[j] === '{') depth++;
    else if (raw[j] === '}') { depth--; if (depth === 0) return raw.slice(i, j + 1); }
  }
  return null;
}

const ROOT = path.join(import.meta.dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'src/styles/base.css'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(ROOT, 'src/pages/settings.js'), 'utf8');
const MAINM = mask(MAIN), CSSM = mask(CSS), SETM = mask(SETTINGS);
const MAINC = commentMask(MAIN), SETC = commentMask(SETTINGS);

if (!/getLauncherIcon/.test(MAINM) || !/function applySplashIcon/.test(MAINM)) {
  console.error('main.js 找不到 getLauncherIcon/applySplashIcon＝結構漂移'); process.exit(2);
}
const MODE = /readSplashCache/.test(MAINM) ? 'FIXED' : 'BUG';
console.log(`模式判定：${MODE}（斷言對象＝真實源碼遮罩後）`);

// ── 事實抽樣 ──
const splashCss = extractBlock(CSSM, '#splash');
if (!splashCss) { console.error('#splash 區塊擷取失敗＝結構漂移'); process.exit(2); }
const applyFn = extractBlock(MAINM, 'function applySplashIcon');
if (!applyFn) { console.error('applySplashIcon 擷取失敗＝結構漂移'); process.exit(2); }
const applyFnRaw = extractBlockRaw(MAIN, 'function applySplashIcon');
const cssHasBgTransition = /transition:[^;]*background/.test(splashCss);
const cachePair = /localStorage\.setItem\(/.test(MAINM) && /localStorage\.getItem\(/.test(MAINM);
const countKey = (s) => (s.match(/'_splashIconKey'/g) || []).length + (s.match(/"_splashIconKey"/g) || []).length;
const keyMain = countKey(MAINC), keySet = countKey(SETC);
const retryPin = /attempt\s*<\s*3/.test(MAINM);
const metaPin = /theme-color/.test(applyFnRaw) && /meta\.content\s*=/.test(applyFn) && /theme-injected/.test(applyFnRaw);
// R3 處方① 宣告唯一性釘（D6 M5 同族：ESM function hoisting 後宣告覆蓋前端，
// 檔尾藏 bug 版即可騙過所有「取首個匹配」靜態腿）
const dupFns = ['applySplashIcon', 'resolveSplashIcon', 'readSplashCache', 'writeSplashCache']
  .filter(fn => (MAINM.match(new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${fn}\\s*\\(`, 'g')) || []).length !== 1);
// R3 處方② T1.8 泛化：任何 style.background 賦值全檔僅 splash 一条（去 splash. 前綴
// 殺別名重植入）、setProperty('background…) 與 cssText 零使用（迴避面封死）
const bgAssignCount = (MAINM.match(/\.style\.background\s*=/g) || []).length;
const bgSetProperty = (MAINM.match(/setProperty\(\s*['"`]background/g) || []).length;
const cssTextUse = (MAINM.match(/\.style\.cssText/g) || []).length;
// R3 處方③ seam 本體靜態釘：_splashDeps 四鍵＋真 import 路徑在位（殺「seam 內硬編碼
// mock 應付動態腿」）；錨點 masked 定位＋raw 同 offset 提取（h4 崩潰修正）
const seamBlk = extractBlock(MAINC, 'const _splashDeps = {');
const seamPin = !!seamBlk && /getLauncherIcon/.test(seamBlk) && /initDB/.test(seamBlk) && /getSetting/.test(seamBlk) && /sleep/.test(seamBlk)
  && seamBlk.includes("import('./lib/api.js')") && (seamBlk.match(/import\('\.\/lib\/db\.js'\)/g) || []).length === 2;
// 退場點 persist=false 釘（R1#1②：store init 失敗時 default 'original' 不得污染 cache）
const exitPersistOff = /applySplashIcon\(\s*store\.state\.launcherIcon[^)]*,\s*false\s*\)/.test(MAINC);
const preloadRe = /const _cachedSplashIcon = readSplashCache\(\);/;
const preloadBeforeResolve = preloadRe.test(MAINM) && MAINM.search(preloadRe) < MAINM.indexOf('resolveSplashIcon(_splashDeps)');
const markers = MAIN.includes('// [F7-SPLASH-BEGIN]') && MAIN.includes('// [F7-SPLASH-END]');
const selfContained = !/\$\(/.test(applyFn); // TDZ：module 頂部同步調用不可用後段 const $

console.log('== T1 靜態釘 ＋ T0 bug 態確認 ==');
if (MODE === 'FIXED') {
  ok('T1.1 CSS #splash transition 含 background（柔化）', cssHasBgTransition);
  ok('T1.2 main.js cache 讀寫端成對', cachePair);
  ok('T1.3 cache 同步前置調用 < resolveSplashIcon 啟動', preloadBeforeResolve);
  ok('T1.4 重試釘 attempt<3', retryPin);
  ok('T1.5 applySplashIcon 更新 meta theme-color（含 theme-injected guard：applyTheme 已跑則讓位）', metaPin);
  ok('T1.6 settings.js 鍵字面恰 1（成對端）', keySet === 1);
  ok('T1.7 鍵字面 main+settings 合計恰 2（唯一定義釘）', keyMain + keySet === 2);
  ok('T1.8 .style.background= 全檔恰 1＋setProperty background/cssText 零（雙份碼收斂＋別名重植入封死）',
    bgAssignCount === 1 && bgSetProperty === 0 && cssTextUse === 0);
  ok('T1.9 F7-SPLASH BEGIN/END 錨點在位（提取面凍結）', markers);
  ok('T1.10 applySplashIcon 自含（無 $( 引用＝模塊頂部同步調用零 TDZ）', selfContained);
  ok('T1.11 splash 四函式宣告唯一（D6 M5 hoisting 殭屍釘）', dupFns.length === 0);
  ok('T1.12 seam 本體釘：四鍵＋真 import(api×1,db×2)（殺 seam 內硬編碼 mock）', seamPin);
  ok('T1.13 退場點 persist=false（init 失敗 default 值不污染 cache）', exitPersistOff);
} else {
  ok('T0.1 bug 實錘：CSS transition 無 background', !cssHasBgTransition);
  ok('T0.2 bug 實錘：無 cache 讀寫', !cachePair);
  ok('T0.3 bug 實錘：無 attempt<3 重試', !retryPin);
  ok('T0.4 bug 實錘：applySplashIcon 無 theme-color 更新', !metaPin);
  ok('T0.5 bug 實錘：鍵字面兩檔合計==0', keyMain + keySet === 0);
  ok('T0.6 bug 實錘：splash.style.background 雙份（==2）', bgAssignCount === 2);
  for (const k of ['T1.1','T1.2','T1.3','T1.4','T1.5','T1.6','T1.7','T1.8','T1.9','T1.10','T1.11','T1.12','T1.13']) naLeg(`${k} 修法腿`, '源碼未修');
}

console.log('== T2 提取式動態腿（真實碼段，mock 僅在 _splashDeps seam） ==');
if (MODE === 'FIXED' && markers) {
  const b = MAIN.indexOf('// [F7-SPLASH-BEGIN]'), e = MAIN.indexOf('// [F7-SPLASH-END]');
  const rawSeg = MAIN.slice(b, e);
  // seam：錨點在 masked 上定位＋括號計數（字串內 '}{' 已遮平＝h4 崩潰攻擊無效），
  // 再以同 offset 在 raw 切除本體（遮罩位置保持）。其餘碼逐字＝生產真碼。
  const seamG = MAINM.indexOf('const _splashDeps = {');
  if (seamG === -1 || seamG < b || seamG > e) { console.error('_splashDeps seam 缺失＝結構漂移'); process.exit(2); }
  let depth = 0, endJ = -1;
  for (let j = MAINM.indexOf('{', seamG); j < MAINM.length; j++) {
    if (MAINM[j] === '{') depth++;
    else if (MAINM[j] === '}') { depth--; if (depth === 0) { endJ = j; break; } }
  }
  if (endJ === -1) { console.error('seam 括號不闭合'); process.exit(2); }
  const segJs = rawSeg.slice(0, seamG - b) + 'const _splashDeps = globalThis.__f7makeDeps();' + rawSeg.slice(endJ + 1 - b);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-verify-'));
  let seq = 0;
  const runCase = async (behavior, precache, dbKey = null) => {
    globalThis.__f7dbKey = dbKey;
    const file = path.join(dir, `case-${++seq}.mjs`);
    const header = `
import { ICON_PRESETS, iconImgPath } from '${path.join(ROOT, 'src/lib/icon-presets.js')}';
const nodes = new Map();
function mkNode(id){
  const n = { id, src:'', _bg:'', classList:{ add(){}, remove(){} }, remove(){} };
  Object.defineProperty(n, 'style', { get: () => ({ set background(v){ n._bg = v; globalThis.__f7bgSeq.push(id + ':' + v); }, get background(){ return n._bg; } }) });
  if (!nodes.has(id)) nodes.set(id, n);
  return nodes.get(id);
}
const metas = new Map();
const store = new Map(${JSON.stringify(precache || [])});
const localStorageMock = { getItem: (k) => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.__f7makeDeps = () => ({
  getLauncherIcon: async () => { globalThis.__f7calls.push('glif'); const r = globalThis.__f7behavior(globalThis.__f7calls.filter(x => x === 'glif').length); if (r instanceof Error) throw r; return r; },
  initDB: async () => { globalThis.__f7calls.push('initDB'); },
  getSetting: async () => { globalThis.__f7calls.push('getSetting'); return globalThis.__f7dbKey; },
  sleep: (ms) => { globalThis.__f7calls.push('sleep' + ms); return Promise.resolve(); },
});
globalThis.localStorage = localStorageMock;
// theme-injected 恆 null＝模擬 applyTheme 未跑（splash 期守衛放行）；meta 雙寫者
// 時序由 T1.5 靜態釘 + theme.js:245 單調標記結構保證
globalThis.document = { getElementById: (id) => id === 'theme-injected' ? null : mkNode(id), querySelector: (sel) => { if (!metas.has(sel)) metas.set(sel, { content: '' }); return metas.get(sel); } };
globalThis.__f7state = { nodes, store, metas };
`;
    fs.writeFileSync(file, header + segJs);
    globalThis.__f7behavior = behavior;
    globalThis.__f7calls = [];
    globalThis.__f7bgSeq = [];
    await import('file://' + file + '?v=' + seq);
    await new Promise(r => setTimeout(r, 0));
    return { calls: globalThis.__f7calls.slice(), bgSeq: globalThis.__f7bgSeq.slice(),
      state: globalThis.__f7state,
      bg: globalThis.__f7state.nodes.get('splash')?._bg,
      cache: globalThis.__f7state.store.get('_splashIconKey') || null,
      meta: globalThis.__f7state.metas.get('meta[name="theme-color"]')?.content || null };
  };
  const c1 = await runCase(() => 'ocean', null);
  ok('T2.1 直接成功 → ocean 底色＋cache＋meta 三者一致', c1.bg === '#1E3A5F' && c1.cache === 'ocean' && c1.meta === '#1E3A5F' && c1.calls.filter(x => x === 'glif').length === 1);
  const c2 = await runCase((n) => n === 1 ? new Error('binder 瞬敗') : 'mint', [['_splashIconKey', 'forest']]);
  ok('T2.2 cache 前置同步套 forest→重試第2次成 mint、initDB 零觸發（慢路徑擋下）',
    c2.bgSeq[0] === 'splash:#2E5D3A' && c2.bg === '#A8E6CF' && c2.calls.filter(x => x === 'glif').length === 2 && !c2.calls.includes('initDB') && c2.cache === 'mint');
  const c3 = await runCase(() => { throw new Error('dead'); }, null);
  ok('T2.3 三連敗 → glif×3＋sleep×2＋initDB 恰 1＋original 兜底',
    c3.calls.filter(x => x === 'glif').length === 3 && c3.calls.filter(x => x.startsWith('sleep')).length === 2 && c3.calls.filter(x => x === 'initDB').length === 1 && c3.bg === '#F4C182' && c3.cache === 'original');
  const c4 = await runCase(() => 'ghost-key', null);
  ok('T2.4 幽靈 key → 落 ICON_PRESETS[0]（防御回退語意保留）', c4.bg === '#F4C182' && c4.cache === 'original');
  const c5 = await runCase(() => 'cream', [['_splashIconKey', 'cream']]);
  const c5dedup = c5.bgSeq.filter((v, i) => v !== c5.bgSeq[i - 1]);
  ok('T2.5 cache 與實際一致 → 零跳色（bgSeq 相鄰去重後恰 1 筆）', c5dedup.length === 1 && c5.bg === '#FAF0E6');
  const c6 = await runCase(() => { throw new Error('dead'); }, null, 'graphite');
  ok('T2.6 三連敗但 DB fallback 讀到真 key → graphite（fallback 非只原諒 original）', c6.bg === '#2B2B2B' && c6.cache === 'graphite' && c6.calls.filter(x => x === 'initDB').length === 1);
} else {
  for (const k of ['T2.1', 'T2.2', 'T2.3', 'T2.4', 'T2.5', 'T2.6']) naLeg(k, MODE === 'BUG' ? '源碼無 F7-SPLASH 段（修法落地後解鎖）' : '錨點缺失');
}

console.log('== T3 負控制（bug 態真實源碼即負控制；FIXED 態對照常量保鮮） ==');
{
  if (MODE === 'BUG') {
    ok('T3.1 bug 態 T0 全紅＝負控制完成（真實源碼缺陷確認，非常量重言式）', fail === 0);
  } else {
    // FIXED 態：從真實源碼「等長剝除」→ 順序/結構閘必須紅
    const stripped = MAINM
      .replace(/transition:[^;]*background([^;]*)/g, 'transition:opacity .45s var(--ease-emphasized)')
      .replace(/attempt\s*<\s*3/g, 'attempt < 1');
    ok('T3.1 剝除 transition-background 後 cssHasBgTransition 必假', !/transition:[^;]*background/.test(extractBlock(stripped, '#splash')));
    ok('T3.2 剝除重試計數後 retryPin 必假', !/attempt\s*<\s*3/.test(stripped));
  }
}

console.log(`\nRESULT[${MODE}]: ${pass}/${pass + fail} PASS, ${na} N/A ${fail === 0 ? (MODE === 'BUG' ? '（PRE：bug 確認，修法落地後復跑轉綠）' : 'ALL PASS') : 'HAS FAIL'}`);
process.exit(fail === 0 ? (MODE === 'BUG' ? 1 : 0) : 1);
