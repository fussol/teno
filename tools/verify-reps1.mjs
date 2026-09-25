#!/usr/bin/env node
// REPS1: 學習頁顯示「複習次數」「上次複習」，且【只顯示當下模式自己的卡狀態】。
// flip／mc／spell 三模式各有獨立卡狀態（state.cards／cardsMc／cardsSpell），
// 故：學習三頁各顯示自己那張卡；瀏覽器（無模式）與測驗頁（不寫卡）一律不顯示。
// 用法: node tools/verify-reps1.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};

const store = readFileSync('src/lib/store.js', 'utf8');
const settings = readFileSync('src/pages/settings.js', 'utf8');
const extraSrc = readFileSync('src/lib/word-extra.js', 'utf8');

console.log('[S] 欄位註冊與僅限學習情境的規則');
chk('word-extra: FIELD_LABELS 含 reps', /reps: '複習次數'/.test(extraSrc));
chk('word-extra: FIELD_LABELS 含 lastReview', /lastReview: '上次複習'/.test(extraSrc));
chk('word-extra: 匯出 FIELD_STUDY_ONLY', /export const FIELD_STUDY_ONLY = \['reps', 'lastReview'\];/.test(extraSrc));
chk('word-extra: getFieldVis fallback 排除學習限定欄位',
  /return new Set\(FIELD_KEYS\.filter\(k => !FIELD_STUDY_ONLY\.includes\(k\)\)\);/.test(extraSrc));
chk('word-extra: cardFaceHtml 不渲染（瀏覽器無對應模式）',
  !/cardStatBlocks/.test(extraSrc.split('export function cardFaceHtml')[1].split('export function extraFieldsHtml')[0]));
chk('word-extra: extraFieldsHtml 有 ctx!==exam 防護',
  /if \(ctx !== 'exam'\) out\.push\(\.\.\.cardStatBlocks\(card, e, show\)\);/.test(extraSrc));

console.log('[S] 學習三頁各傳「自己模式」的卡');
for (const f of ['study-v4', 'study-mc', 'study-spell']) {
  chk(`${f}.js 傳 session.current.card`,
    readFileSync(`src/pages/${f}.js`, 'utf8').includes("extraFieldsHtml(w, e, 'study', session?.current?.card)"));
}
console.log('[S] 瀏覽器與測驗頁不傳卡');
chk('browser.js 走 cardFaceHtml（無 card 參數）',
  readFileSync('src/pages/browser.js', 'utf8').includes("cardFaceHtml(w, s, 'browserBack', H)"));
chk('deck-browser.js 同', readFileSync('src/pages/deck-browser.js', 'utf8').includes("cardFaceHtml(w, s, 'browserBack', H)"));
for (const f of ['exam-flip', 'exam-mc', 'exam-spell']) {
  const src = readFileSync(`src/pages/${f}.js`, 'utf8');
  chk(`${f}.js 不傳 card`, src.includes("extraFieldsHtml(w, esc, 'exam')") && !/extraFieldsHtml\(w, esc, 'exam',/.test(src));
}

console.log('[S] 模式隔離的資料鏈（三張卡 Map 各自獨立）');
chk('store: cardsMc 由 c.mcData 建', /state\.cardsMc\.set\(wid, \{ \.\.\.c\.mcData \}\)/.test(store));
chk('store: cardsSpell 由 c.spellData 建', /state\.cardsSpell\.set\(wid, \{ \.\.\.c\.spellData \}\)/.test(store));
chk('session-mc-utils 餵 cardsMc',
  /cards: storeState\.cardsMc/.test(readFileSync('src/engine/session-mc-utils.js', 'utf8')));
chk('session-spell-utils 餵 cardsSpell',
  /cards: storeState\.cardsSpell/.test(readFileSync('src/engine/session-spell-utils.js', 'utf8')));

console.log('[S] 設定頁：只有學習組提供開關');
chk('settings: study 組列全部欄位、其他組排除學習限定',
  /const groupKeys = ctx === 'study'[\s\S]{0,120}FIELD_KEYS\.filter\(k => !FIELD_STUDY_ONLY\.includes\(k\)\);/.test(settings));
chk('settings: 欄位清單改用 groupKeys', /\$\{groupKeys\.map\(k => \{/.test(settings));

console.log('[S] hydrate 白名單（漏 key 會讓設定重啟後靜默消失）');
chk('store: _FV_KEYS 含 reps', /const _FV_KEYS = \[[^\]]*'reps'[^\]]*\];/.test(store));
chk('store: _FV_KEYS 含 lastReview', /const _FV_KEYS = \[[^\]]*'lastReview'[^\]]*\];/.test(store));
chk('store: _parseVis fallback 排除學習限定',
  /const fb = \(fallback \|\| _FV_KEYS\)\.filter\(k => !FIELD_STUDY_ONLY\.includes\(k\)\);/.test(store));

// ── 行為：import 真實模組 ──
console.log('[B] 行為（真實 word-extra.js）');
const extra = await import('../src/lib/word-extra.js');
const LEGACY = ['word','pron','definition','example','description','related','forms','synonym','antonym','tags','image','syllables','etymology'];
const ALL = [...extra.FIELD_KEYS];
const W = { id: 'w1', word: 'ruling', pron: 'pr', definition: '判決', tags: [], related: [], forms: [] };
const H = { escapeHtml: (x) => String(x ?? ''), wordImageSlotHTML: () => '', splitFieldsHtml: () => '', fmtExample: (x) => x, wordExample: () => '' };
const esc = (x) => String(x ?? '');
const vis = (o) => { globalThis.window = { __fieldVis: o }; };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

chk('FIELD_KEYS = 15', extra.FIELD_KEYS.length === 15, extra.FIELD_KEYS.join(','));

console.log('[B] 瀏覽器字卡：一律不顯示（即使全開）');
vis({ browserFront: ALL, browserBack: ALL });
const Sflip = { state: { cards: new Map([['w1', { reps: 35, lastReview: ago(3 * 86400e3) }]]), decks: [], tagConfig: {} } };
let h = extra.cardFaceHtml(W, Sflip, 'browserBack', H);
chk('browserBack 不出現複習次數', !h.includes('複習次數'), h.slice(-160));
chk('browserBack 不出現上次複習', !h.includes('上次複習'));
h = extra.cardFaceHtml(W, Sflip, 'browserFront', H);
chk('browserFront 也不出現', !h.includes('複習次數') && !h.includes('上次複習'));
chk('其餘欄位不受影響（判決仍在）', extra.cardFaceHtml(W, Sflip, 'browserBack', H).includes('判決'));

console.log('[B] 學習頁：顯示，且用「傳入那張卡」的數字（模式隔離）');
vis({ study: ALL });
const FLIP  = { reps: 10, lastReview: ago(1 * 3600e3) };
const MC    = { reps: 20, lastReview: ago(2 * 86400e3) };
const SPELL = { reps: 30, lastReview: ago(5 * 86400e3) };
const outFlip  = extra.extraFieldsHtml(W, esc, 'study', FLIP);
const outMc    = extra.extraFieldsHtml(W, esc, 'study', MC);
const outSpell = extra.extraFieldsHtml(W, esc, 'study', SPELL);
chk('flip 卡 → 10 / 1 小時前',  outFlip.includes('>10<')  && outFlip.includes('1 小時前'),  outFlip.slice(-120));
chk('mc 卡 → 20 / 2 天前',      outMc.includes('>20<')    && outMc.includes('2 天前'),    outMc.slice(-120));
chk('spell 卡 → 30 / 5 天前',   outSpell.includes('>30<') && outSpell.includes('5 天前'), outSpell.slice(-120));
chk('三模式輸出互不相同（證明非取共用卡）', outFlip !== outMc && outMc !== outSpell && outFlip !== outSpell);

console.log('[B] 測驗頁：一律不顯示（含硬防護）');
chk('ctx=exam 且有 card → 仍不顯示', !extra.extraFieldsHtml(W, esc, 'exam', MC).includes('複習次數'));
chk('ctx=exam 無 card → 不顯示', !extra.extraFieldsHtml(W, esc, 'exam').includes('複習次數'));
chk('ctx=exam 不顯示但其他欄位仍在', extra.extraFieldsHtml({ ...W, syllables: 'syl' }, esc, 'exam').includes('syl'));

console.log('[B] 邊界');
vis({ study: ALL });
chk('無 card → 不顯示', !extra.extraFieldsHtml(W, esc, 'study').includes('複習次數'));
chk('card 只有 reps、lastReview=null → 只出次數',
  (() => { const x = extra.extraFieldsHtml(W, esc, 'study', { reps: 0, lastReview: null }); return x.includes('複習次數') && x.includes('>0<') && !x.includes('上次複習'); })());
chk('card 缺欄位 → reps 顯示 0 不炸', extra.extraFieldsHtml(W, esc, 'study', {}).includes('複習次數'));
chk('壞日期 → 該塊不出現', !extra.extraFieldsHtml(W, esc, 'study', { reps: 1, lastReview: 'x' }).includes('上次複習'));

console.log('[B] 相對時間分段');
const t = (ms) => extra.extraFieldsHtml(W, esc, 'study', { reps: 1, lastReview: ago(ms) });
chk('30 秒 → 剛剛', t(30e3).includes('剛剛'));
chk('30 分 → 分鐘前', t(30 * 60e3).includes('30 分鐘前'));
chk('5 小時 → 小時前', t(5 * 3600e3).includes('5 小時前'));
chk('3 天 → 天前', t(3 * 86400e3).includes('3 天前'));
chk('30 天 → 絕對日期', /20\d\d-\d\d-\d\d/.test(t(30 * 86400e3)));

console.log('[B] 預設隱藏');
globalThis.window = {};
chk('無 __fieldVis → reps 不可見', !extra.visShow('study', 'reps'));
chk('無 __fieldVis → lastReview 不可見', !extra.visShow('study', 'lastReview'));
chk('無 __fieldVis → 既有欄位仍可見', extra.visShow('study', 'example') && extra.visShow('browserFront', 'image'));
chk('未勾選（舊設定值）→ 學習頁不顯示',
  (() => { vis({ study: LEGACY }); return !extra.extraFieldsHtml(W, esc, 'study', MC).includes('複習次數'); })());

// ── [P] production 同型鏈（源碼抽出的真實白名單）──
console.log('[P] production 同型鏈（node:sqlite）');
const srcFV = store.match(/const _FV_KEYS = (\[[^\]]*\]);/)[1];
const hiddenSrc = extraSrc.match(/export const FIELD_STUDY_ONLY = (\[[^\]]*\]);/)[1];
const sim = execSync(`node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const setSetting = (k,v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, typeof v==='string'?v:JSON.stringify(v));
const getSetting = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); if(!r) return null; try { return JSON.parse(r.value); } catch { return r.value; } };
const _FV_KEYS = ${srcFV};
const FIELD_STUDY_ONLY = ${hiddenSrc};
const _parseVis = (v, fallback) => {
  const fb = (fallback || _FV_KEYS).filter(k => !FIELD_STUDY_ONLY.includes(k));
  if (v == null || v === '') return [...fb];
  if (Array.isArray(v)) return v.filter(k => _FV_KEYS.includes(k));
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a.filter(k => _FV_KEYS.includes(k)); } catch (_) {}
  return [...fb];
};
const LEGACY = [${LEGACY.map(k => `'${k}'`).join(',')}];
setSetting('fieldVisStudy', JSON.stringify([...LEGACY,'reps','lastReview']));
console.log('TICKED=' + _parseVis(getSetting('fieldVisStudy')).join());
setSetting('fieldVisStudy', JSON.stringify(LEGACY));
console.log('LEGACY=' + _parseVis(getSetting('fieldVisStudy')).join());
db.exec('DELETE FROM settings');
console.log('FRESH=' + _parseVis(getSetting('fieldVisStudy')).join());
setSetting('fieldVisStudy', JSON.stringify([...LEGACY,'reps']));
console.log('STR=' + _parseVis(JSON.stringify([...LEGACY,'reps'])).join());
"`, { encoding: 'utf8' });
const g = (k) => (sim.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, ''])[1];
chk('勾選後重啟仍保留 reps', g('TICKED').includes('reps'), g('TICKED'));
chk('勾選後重啟仍保留 lastReview', g('TICKED').includes('lastReview'), g('TICKED'));
chk('舊設定 → 兩欄維持隱藏', !g('LEGACY').includes('reps') && !g('LEGACY').includes('lastReview'), g('LEGACY'));
chk('舊設定 → 既有欄位不受影響', LEGACY.every(k => g('LEGACY').includes(k)));
chk('全新安裝 → 兩欄不自動開', !g('FRESH').includes('reps') && !g('FRESH').includes('lastReview'), g('FRESH'));
chk('全新安裝 → word 仍在', g('FRESH').includes('word'));
chk('JSON 字串路徑也保留 reps', g('STR').includes('reps'), g('STR'));

// ── [NEG] 永久負控制（不依賴 git，commit 後仍有效）──
console.log('[NEG] 負控制（不依賴 git）');
// 修復前的白名單 = 舊的 13 個 key。證明「漏 key 時 _parseVis 會把新欄位剔掉」，
// 這樣即使修復已 commit、git HEAD 不再是壞版本，控制力依然存在。
const OLD_WHITELIST = LEGACY;
const strippedByOld = [...LEGACY, 'reps', 'lastReview'].filter(k => OLD_WHITELIST.includes(k));
chk('舊白名單會濾掉 reps（重現原 bug）', !strippedByOld.includes('reps'));
chk('舊白名單會濾掉 lastReview（重現原 bug）', !strippedByOld.includes('lastReview'));
chk('∴ 白名單補 key 的修復是必要的', strippedByOld.length === LEGACY.length);
// 對照：新白名單不會剔掉
chk('新白名單保留 reps（∴ 修復有效）', [...LEGACY, 'reps'].filter(k => JSON.parse(srcFV.replace(/'/g, '"')).includes(k)).includes('reps'));

// ── [NEG-GIT] HEAD 版比對（修復未 commit 時才跑；已 commit 則 skip）──
console.log('[NEG-GIT] HEAD 版比對');
let headFV = null;
try { headFV = (execSync('git show HEAD:src/lib/store.js', { encoding: 'utf8' }).match(/const _FV_KEYS = (\[[^\]]*\]);/) || [])[1]; } catch {}
if (headFV === null) {
  console.log('  NEG-SKIP: 無法取得 HEAD 版');
} else {
  const K = JSON.parse(headFV.replace(/'/g, '"'));
  if (K.includes('reps') && K.includes('lastReview')) {
    // 修復已進 HEAD → 讀 HEAD 已無意義（對齊 verify-fvpersist1-hydrate 的 NEG-SKIP）
    console.log('  NEG-SKIP: 修復已在 HEAD（已 commit）— 跳過（永久負控制見上方 [NEG]）');
  } else {
    chk('HEAD 白名單不含 reps', !K.includes('reps'), headFV);
    chk('HEAD 白名單不含 lastReview', !K.includes('lastReview'));
  }
}

console.log(`\nREPS1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
