#!/usr/bin/env node
// EXAMGEST 防回歸 — 測驗手勢改版（2026-10-02 使用者裁示總包）
// 範圍：翻卡去按鈕改手勢、多選空白拖曳選項、拼字內建鍵盤（手機）、B 字本預設不選、
//       G′ 標籤升主角（config 上移＋結果頁套用鈕帶數量）、無手勢操作提示。
// 用法: node tools/verify-examgest.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`); }
};
const R = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const gest = R('src/lib/gesture.js');
const flip = R('src/pages/exam-flip.js');
const mc = R('src/pages/exam-mc.js');
const esp = R('src/pages/exam-spell.js');
const ssp = R('src/pages/study-spell.js');
const kbd = R('src/lib/spell-kbd.js');
const pages = [['flip', flip], ['mc', mc], ['esp', esp]];

console.log('[G1] gesture.js 共用手勢模組');
ok('dragTrack/dirOf 匯出', gest.includes('export function dragTrack') && gest.includes('export function dirOf'));
ok('pan-y 捲動分工註解', gest.includes('pan-y'));
ok('when 守門（非本頁活頁不擷 capture）', gest.includes('cb.when && !cb.when(ev)'));
ok('base.css #contentArea pan-y（背景區捲動分工）', R('src/styles/base.css').includes('#contentArea{touch-action:pan-y}'));

console.log('[G2] 翻卡：手勢取代正確/錯誤按鈕');
ok('無 efCorrectBtn/efWrongBtn', !flip.includes('efCorrectBtn') && !flip.includes('efWrongBtn'));
ok('import dragTrack', flip.includes("import { dragTrack } from '../lib/gesture.js'"));
ok('typeof 守門（測試 harness 會剝 import）', flip.includes("typeof dragTrack === 'function'"));
ok('卡片 #efCard + .exam-gest', flip.includes('id="efCard"') && flip.includes('exam-gest'));
ok('手勢綁 contentArea（含卡片外背景）＋ when efCard', flip.includes("getElementById('contentArea')") && flip.includes('_efGestBound') && flip.includes('when: () => !!card()'));
ok('紅綠光罩 #efTint', flip.includes('id="efTint"'));
ok('answer* 收斂 judged/answeredCorrect', /function answerCorrect\(s\) \{[\s\S]{0,300}?e\.judged = true/.test(flip) && flip.includes('e.answeredCorrect = true'));
ok('改判不重加時間（首判計時）', (flip.match(/if \(!e\.judged\) e\.totalTime \+=/g) || []).length === 2);
ok('_throw 飛出動畫消費', flip.includes("classList.add('ef-throw-' + e._throw)"));
ok('判分門檻 70px', flip.includes('Math.hypot(dx, dy) < 70'));
ok('下一題鈕＝fixed .study-buttons（免滑到底）', flip.includes('<div class="study-buttons">') && !flip.includes('class="study-buttons" style='));
ok('無門檻 toast（操作提示不進 app）', !flip.includes('再多滑一點'));
ok('b11 timer callback 原文保留', flip.includes('setTimeout(() => { nextWord(s); e.autoNextTimer = null; }, e.settings.delay * 1000)'));

console.log('[G3] 多選：空白拖曳即時移動選擇');
ok('import dragTrack', mc.includes("import { dragTrack } from '../lib/gesture.js'"));
ok('typeof 守門', mc.includes("typeof dragTrack === 'function'"));
ok('卡片 #emCard + .exam-gest', mc.includes('id="emCard"') && mc.includes('exam-gest'));
ok('手勢綁 contentArea（含卡片外背景）＋ when emCard', mc.includes("getElementById('contentArea')") && mc.includes('_emGestBound') && mc.includes("when: () => !!document.getElementById('emCard')"));
ok('綁一次跨 render：lastW 換題重置 gSel', mc.includes('if (w !== lastW) { lastW = w; gSel = -1; setGlow(-1); }'));
ok('STEP=54 每格位移', mc.includes('const STEP = 54'));
ok('軸 dy-dx 方向式', mc.includes('Math.round((dy - dx) / STEP)'));
ok('選項上不啟動手勢（ignore）', mc.includes("ignore: '.study-opt, button'"));
ok('點空白確認（gSel>=0 才作答）', mc.includes('if (gSel >= 0) pickOption(s, gSel)'));
ok('下一題鈕＝fixed .study-buttons（免滑到底）', mc.includes('<div class="study-buttons">') && !mc.includes('class="study-buttons" style='));
ok('列表不位移（不加 transform 跟手）', !mc.includes('mOpts') && !/translateY\(.*axis/.test(mc));
ok('b11 timer callback 原文保留', mc.includes('setTimeout(() => { nextWord(s); e.pendingNext = null; }, e.settings.delay * 1000)'));

console.log('[G4] B：字本預設不選（start 有 toast guard）');
for (const [name, src] of pages) {
  ok(`${name} 無自動全選殘留`, !src.includes('if (!e.decks.length) e.decks = s.state.decks.map'));
  ok(`${name} startExam 有空選 toast`, src.includes("請至少選擇一個字本"));
}

console.log('[G5] G′：標籤升主角 — config 上移、結果頁套用鈕帶數量');
for (const [name, src] of pages) {
  const tagId = name === 'esp' ? 'esTagCorrect' : name === 'mc' ? 'emTagCorrect' : 'efTagCorrect';
  const tagBtn = name === 'esp' ? 'esTagBtn' : name === 'mc' ? 'emTagBtn' : 'efTagBtn';
  ok(`${name} tag select 在設定(sliders)之前`, src.indexOf(tagId) < src.indexOf("icon('sliders')"));
  ok(`${name} tag 區塊有 accent 強調框`, src.includes('答對／答錯自動標籤'));
  ok(`${name} 結果頁 ${tagBtn} 為套用鈕帶數量`, src.includes(`套用：`) && src.includes(`${tagBtn}`) && !src.includes('加上標籤'));
}

console.log('[G6] 拼字內建鍵盤（手機限定，exam＋study 共用）');
ok('spell-kbd 三函式皆 isMobile 門', ['function spellKbdHtml', 'function spellInputAttr', 'function bindSpellKbd'].every(f => {
  const i = kbd.indexOf(f);
  return i > 0 && kbd.slice(i, i + 200).includes('isMobile');
}));
ok('exam-spell import＋模板插鍵盤＋readonly', esp.includes("spellKbdHtml()") && esp.includes("spellInputAttr()") && esp.includes("bindSpellKbd('esInput')") && esp.includes("typeof bindSpellKbd === 'function'"));
ok('study-spell import＋模板插鍵盤', ssp.includes("spellKbdHtml()") && ssp.includes("spellInputAttr()") && ssp.includes("bindSpellKbd('spellInput')") && ssp.includes("typeof bindSpellKbd === 'function'"));
ok('鍵盤含 ⌫ 退格', kbd.includes('__bs') && kbd.includes('⌫'));
ok('鍵盤原生鍵位 ⇧/空格/⏎', ['__shift', '__space', '__ret'].every(k => kbd.includes(k)));
ok('⌫ 長按連刪（pointerdown→450ms→interval70ms、抬起即停）', kbd.includes("btn.addEventListener('pointerdown'") && kbd.includes('setInterval') && kbd.includes('450') && kbd.includes('stopBs'));
ok('鍵盤 CSS fixed 貼底＋鍵帽＋fn 鍵', (() => { const c = R('src/styles/base.css'); return c.includes('.spell-kbd{position:fixed') && c.includes('.sk-fn') && c.includes('.sk-space'); })());
ok('鍵帽小寫預設＋.sk-up 才翻大寫（⇧ 視覺生效）', (() => { const c = R('src/styles/base.css'); return c.includes('.sk-up .sk-key{text-transform:uppercase}') && !/^\.sk-key\{[^}]*text-transform:uppercase/m.test(c); })());
ok('鍵盤色票 light/dark 雙覆寫', ['--kbd-tray', '--kbd-key-fn'].every(v => R('src/lib/theme.js').includes(v)) && R('src/styles/base.css').includes('--kbd-tray'));
ok('exam-spell：鍵盤只在輸入態＋下一題鈕 fixed', esp.includes('spellKbdHtml()') && esp.includes('<div class="study-buttons">') && !esp.includes('class="study-buttons" style='));

console.log('[G7] 無手勢操作提示（app 端）');
for (const [name, src] of pages) {
  ok(`${name} 無教學字串`, !src.includes('再多滑一點') && !src.includes('拖曳中＝') && !src.includes('滑動＝移動選擇'));
}

console.log(`\nEXAMGEST 驗證: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
