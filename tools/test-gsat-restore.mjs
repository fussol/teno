// gsat 整卷進度「存 → 退 → 還原」smoke（Node + jsdom，不碰真 DB/LLM）
// 跑法：node tools/test-gsat-restore.mjs  （非零 exit = 有 FAIL）
// 涵蓋：①還原到第 N 題 ②回首頁不抹存檔 ③重開頁（新 module 實例）還原 ④損檔拒收
//       ⑤無續作按鈕＋同卷自動續作 ⑥整卷題組只存答案 ⑦已批改存檔→錯題報告 ⑧存檔覆蓋規則 ⑨端到端（作答→交卷→報告）
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
register('./raw-loader.mjs', import.meta.url);

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="pageContainer"></div><div id="toastContainer"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
for (const k of ['HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Event', 'CustomEvent', 'Node', 'navigator', 'getComputedStyle', 'requestAnimationFrame']) {
  if (dom.window[k] !== undefined) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }   // Node 26: navigator 為唯讀 getter
  }
}
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return false; }

const GSAT = pathToFileURL(path.join(ROOT, 'src/pages/gsat.js')).href;
const LS_KEY = 'teno:gsat:progress';
const store = { actions: { navigate() {} }, state: {} };

// 題序 = gsat.js 同法重建（mc+tr 合併 → year,no → 篩 97 → no）
const readQ = f => fs.readFileSync(path.join(ROOT, 'src/assets/gsat', f), 'utf8').trim().split('\n').map(JSON.parse);
const qs97 = [...readQ('gsat.jsonl'), ...readQ('gsat_translate.jsonl')]
  .sort((a, b) => Number(a.year) - Number(b.year) || Number(a.no) - Number(b.no))
  .filter(q => Number(q.year) === 97)
  .sort((a, b) => Number(a.no) - Number(b.no));
const IDX = 10;   // 作到第 11 題（idx 0-based）
const seed = () => localStorage.setItem(LS_KEY, JSON.stringify({
  v: 1, year: 97, idx: IDX,
  results: qs97.slice(0, IDX + 1).map((q, i) => ({ qid: q.id, ok: i % 2 === 0, picked: 'A' })),
}));

const mount = async (mod) => {
  const c = document.getElementById('pageContainer');
  c.innerHTML = '';
  c.innerHTML = mod.render();   // main.js 同序：render → onMount
  mod.onMount(store);
  await sleep(300);
  return c.innerHTML;
};

ok(qs97.length >= 50 && qs97.length === 58, `97 年題序重建（${qs97.length} 題）`, '與使用者看到的 58 題不符');

// ⓪ 統計雷達：混合對錯 → 數值＝真實比率；文字全在畫布內且互不重疊（回報「都100」＋標籤被裁）
localStorage.setItem('teno:gsat:log', JSON.stringify([
  { ts: 1, qid: 'gsat-97-1', mode: 'mc', axis: '詞彙', ok: true, scores: { picked: 'C' } },
  { ts: 2, qid: 'gsat-97-2', mode: 'mc', axis: '一、詞彙題（占10分）', ok: false, scores: { picked: 'A' } },
  { ts: 3, qid: 'gsat-97-3', mode: 'mc', axis: '一、詞彙題（占10分）', ok: false, scores: { picked: 'B' } },
  { ts: 4, qid: 'gsat-97-16', mode: 'mc', axis: '二、綜合測驗（占10分）', ok: false, scores: { picked: 'C' } },
  { ts: 5, qid: 'gsat-97-31', mode: 'mc', axis: '三、文意選填（占10分）', ok: false, scores: { picked: 'A' } },
  { ts: 6, qid: 'gsat-111-31', mode: 'mc', axis: '四、篇章結構（占8分）', ok: true, scores: { picked: 'B' } },
  { ts: 7, qid: 'gsat-97-44', mode: 'mc', axis: '五、閱讀測驗（占24分）', ok: false, scores: { picked: 'C' } },
  { ts: 8, qid: 'gsat-97-47', mode: 'tr', axis: '中譯英', ok: false, scores: {} },
]));
const checkRadar = (html, size, expect, name) => {
  const svg = (html.match(new RegExp(`<svg[^>]*viewBox="0 0 ${size} ${size}"[\\s\\S]*?<\\/svg>`)) || [''])[0];
  ok(svg.startsWith('<svg'), `${name}：渲染雷達圖`);
  const texts = [...svg.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="(\w+)" dominant-baseline="middle" font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)]
    .map(m => ({ x: +m[1], y: +m[2], anchor: m[3], fs: +m[4], t: m[5] }));
  const vals = texts.filter(t => t.fs === 10).map(t => t.t);
  ok(vals.join() === expect, `${name}：數值＝真實比率（${expect}）`, `實得 [${vals}]`);
  // 文字外框估算（CJK≈1em、ASCII≈0.6em）→ 不出畫布、不互疊
  const boxes = texts.map(t => {
    const w = [...t.t].reduce((s, ch) => s + (ch.charCodeAt(0) > 127 ? t.fs : t.fs * 0.6), 0);
    const x0 = t.anchor === 'start' ? t.x : t.anchor === 'end' ? t.x - w : t.x - w / 2;
    return { t: t.t, x0, x1: x0 + w, y0: t.y - t.fs / 2, y1: t.y + t.fs / 2 };
  });
  const oob = boxes.filter(b => !(b.x0 >= -1 && b.x1 <= size + 1 && b.y0 >= -1 && b.y1 <= size + 1));
  ok(!oob.length, `${name}：文字全在畫布內（不被裁切）`, '超出: ' + oob.map(b => b.t).join(','));
  const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  let ov = '';
  for (let i = 0; i < boxes.length && !ov; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i], boxes[j])) { ov = `${boxes[i].t}×${boxes[j].t}`; break; }
  ok(!ov, `${name}：文字互不重疊`, ov);
};
const gStats = await import(GSAT + '?stats=1');
await mount(gStats);
document.getElementById('pageContainer').querySelector('[data-stats]')?.click();
await sleep(50);
checkRadar(document.getElementById('pageContainer').innerHTML, 280, '33,0,0,100,0,0', '⓪ 統計雷達');
// 錯題本「弱點分析」＝錯題密度雷達（多個100＋側軸四字標籤＝實機回報現場）
document.getElementById('pageContainer').querySelector('[data-home]')?.click();
await sleep(30);
document.getElementById('pageContainer').querySelector('[data-wrong]')?.click();
await sleep(50);
checkRadar(document.getElementById('pageContainer').innerHTML, 250, '67,100,100,0,100,100', '⓪ 弱點雷達');

// ① 還原：存檔 → 進頁 → 直接跳第 11 題
seed();
const g1 = await import(GSAT);
const h1 = await mount(g1);
ok(h1.includes('已恢復上次進度'), '① 還原：顯示恢復橫幅');
ok(h1.includes(`第 ${IDX + 1}/${qs97.length} 題`), `① 還原：落在第 ${IDX + 1} 題`, h1.match(/第 \d+\/\d+ 題/)?.[0] || '無題號');

// ② 回首頁（quiz 頁頭返回）不抹存檔
document.getElementById('pageContainer').querySelector('[data-home]')?.click();
await sleep(50);
let p = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p && p.idx === IDX && Array.isArray(p.results) && p.results.length === IDX + 1, '② 回首頁：存檔仍在（不被當棄卷清掉）', JSON.stringify(p));

// ⑤ 續作：首頁無「繼續上次」按鈕；整卷入口＋同年份＝自動續作（同卷不問 confirm）
const homeHtml = document.getElementById('pageContainer').innerHTML;
ok(!homeHtml.includes('data-resume') && !homeHtml.includes('繼續上次'), '⑤ 首頁無「繼續上次」按鈕');
document.getElementById('pageContainer').querySelector('[data-full]')?.click();
await sleep(30);
let confirmAsked = false;
globalThis.confirm = () => { confirmAsked = true; return false; };
document.getElementById('pageContainer').querySelector('[data-year="97"]')?.click();
await sleep(150);
const h5 = document.getElementById('pageContainer').innerHTML;
ok(h5.includes(`第 ${IDX + 1}/${qs97.length} 題`) && !confirmAsked, `⑤ 整卷入口同年份＝自動續作到第 ${IDX + 1} 題`, h5.match(/第 \d+\/\d+ 題/)?.[0] || '無題號');

// ③ 重開頁（新 module 實例＝換頁/重啟）→ 再度還原
const g2 = await import(GSAT + '?fresh=1');
const h2 = await mount(g2);
ok(h2.includes('已恢復上次進度') && h2.includes(`第 ${IDX + 1}/${qs97.length} 題`), '③ 重進頁：從存檔還原到第 11 題');

// ⑥ 文意選填：10 空一頁作答（整卷只存答案、無立即交卷）→ 下一題整組跳 → 不顯示對錯
const gi0 = qs97.findIndex(q => q.section.includes('文意選填'));
const mem = [];
for (let i = gi0; i < qs97.length && qs97[i].passage === qs97[gi0].passage; i++) mem.push(qs97[i]);
ok(gi0 > 0 && mem.length === 10, `⑥ 題組定位（idx=${gi0}, ${mem.length} 題）`);
localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, year: 97, idx: gi0,
  results: qs97.slice(0, gi0).map(q => ({ qid: q.id, ok: true, picked: 'A' })) }));
const g6 = await import(GSAT + '?group=1');
const c = document.getElementById('pageContainer');
c.innerHTML = ''; c.innerHTML = g6.render(); g6.onMount(store); await sleep(300);
let h = c.innerHTML;
ok(!h.includes('data-gsubmit') && h.includes('data-next') && (h.match(/data-gsel=/g) || []).length === 10, '⑥ 整卷題組：10 空一頁＋導航（無立即交卷）');
ok(!h.includes('<select'), '⑥ 下拉＝自訂浮層（非原生 select）');
ok(mem.every(m => h.includes(m.stem.slice(0, 10))), '⑥ 10 題題幹都在同頁');
ok((h.match(/gsat-fill/g) || []).length >= 10, '⑥ 題號空位統一成底線空格槽');
// 數字鍵 1 開第 1 空浮層，再點選項（其餘逐空：開→選）
c.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
ok(!c.querySelector('.gsat-dd[data-gsel="0"] .gsat-dd-menu').hidden, '⑥ 數字鍵 1 開啟第 1 空浮層');
c.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
ok(c.querySelector('.gsat-dd[data-gsel="0"] .gsat-dd-menu').hidden, '⑥ 點浮層外關閉選單');
c.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'C', bubbles: true }));
await sleep(20);
const p6c = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p6c?.results?.[gi0]?.picked === 'C', '⑥ 字母鍵 C 直填第一個未填空（無滑鼠填組）', p6c && JSON.stringify(p6c.results[gi0]));
for (let k = 0; k < 10; k++) {
  const dd = [...c.querySelectorAll('.gsat-dd')].find(x => !x.dataset.value);
  if (!dd) break;
  const mk = mem[+dd.dataset.gsel];
  const key = k === 0 ? mk.options.find(o => o[0] !== mk.answer)[0] : mk.answer;
  if (dd.querySelector('.gsat-dd-menu').hidden) dd.querySelector('.gsat-dd-btn').click();
  dd.querySelector(`[data-v="${key}"]`).click();
  await sleep(15);
}
await sleep(30);
h = c.innerHTML;
let p6 = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p6 && p6.idx === gi0 && p6.results.length === gi0 + 10, '⑥ 選取即存：整組 10 筆對齊佇列', p6 && `idx=${p6.idx} len=${p6.results.length}`);
ok(!h.includes('✗') && !h.includes('答對') && !h.includes('答錯'), '⑥ 作答中不顯示對錯（交卷才判）');
c.querySelector('[data-next]').click();
await sleep(60);
p6 = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p6 && p6.idx === gi0 + 10, '⑥ 下一題：跳過整組', p6 && `idx=${p6.idx}`);

// ⑥b 累積式 passage：綜合測驗組2只顯示本段（組1全文不黏進來）
const idx16 = qs97.findIndex(q => q.no === 16);
const idx21 = qs97.findIndex(q => q.no === 21);
ok(qs97[idx21].passage.startsWith(qs97[idx16].passage), '⑥b 資料前提：綜合 passage 累積式');
localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, year: 97, idx: idx21,
  results: qs97.slice(0, idx21).map(q => ({ qid: q.id, ok: true, picked: 'A' })) }));
const g6b = await import(GSAT + '?seg=1');
c.innerHTML = ''; c.innerHTML = g6b.render(); g6b.onMount(store); await sleep(300);
h = c.innerHTML;
const tail21 = qs97[idx21].passage.slice(qs97[idx16].passage.length);
ok(!h.includes(qs97[idx16].passage.slice(0, 40)), '⑥b 組2頁不含組1開頭（不黏篇）', h.slice(0, 0));
ok(h.includes(tail21.slice(0, 40)), '⑥b 組2頁顯示本段文章');
ok(h.includes('<span class="gsat-fill">21</span>'), '⑥b 綜合裸題號轉空格槽');

// ⑦ 已批改存檔（g:1）→ 還原直接進本卷錯題報告（配分/計時/錯題列）
localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, year: 97, idx: gi0, g: 1, t: 123000,
  results: qs97.map((q, i) => ({ qid: q.id, ok: i !== gi0 + 1, picked: i !== gi0 + 1 ? (q.answer || 'A') : 'Z' })) }));
const g7 = await import(GSAT + '?graded=1');
c.innerHTML = ''; c.innerHTML = g7.render(); g7.onMount(store); await sleep(300);
h = c.innerHTML;
ok(h.includes('97 年整卷錯題報告'), '⑦ 已批改存檔 → 本卷錯題報告頁');
ok(h.includes(`${qs97.length - 1}/${qs97.length}`), `⑦ 報告：答對題數 ${qs97.length - 1}/${qs97.length}（1 題故意錯）`, h.match(/font-size:40px[^>]*>[^<]*/)?.[0]);
ok(h.includes('用時 2:03'), '⑦ 報告：計時凍結顯示');
ok(h.includes('你選 Z'), '⑦ 報告：錯題列出所選選項');

// ④ 損檔拒收（qid 對不上）→ 留在首頁、不留垃圾
localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, year: 97, idx: IDX, results: [{ qid: 'BOGUS-1' }] }));
const g3 = await import(GSAT + '?bad=1');
const h3 = await mount(g3);
ok(!h3.includes('已恢復上次進度'), '④ 損檔：不誤還原', h3.slice(0, 80));

// ⑧ 存檔規則：只在「放棄（confirm 點頭）」被覆蓋；非整卷狀態不動存檔；題組子題一起答一起批
localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, year: 97, idx: IDX, results: qs97.slice(0, IDX + 1).map((q, i) => ({ qid: q.id, ok: i % 2 === 0, picked: 'A' })) }));
const g8 = await import(GSAT + '?pol=1');
const c8 = document.getElementById('pageContainer');
c8.innerHTML = ''; c8.innerHTML = g8.render(); g8.onMount(store); await sleep(300);
ok(c8.innerHTML.includes(`第 ${IDX + 1}/${qs97.length} 題`), '⑧ 掛載即還原存檔');
c8.querySelector('[data-home]')?.click(); await sleep(30);
ok(!c8.querySelector('[data-resume]') && !c8.innerHTML.includes('繼續上次'), '⑧ 首頁無「繼續上次」按鈕（續作改走整卷入口）');
// a) 分類練習（非整卷）不得動存檔；綜合測驗題組也是一頁一起批
c8.querySelector('[data-cat="綜合測驗"]')?.click(); await sleep(30);
c8.querySelector('[data-year="97"]')?.click(); await sleep(60);
ok(c8.innerHTML.includes('一起批改') && c8.innerHTML.includes('題組'), '⑧ 綜合測驗題組一頁（子題一起答）', c8.innerHTML.slice(0, 60));
p = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p && p.year === 97 && p.idx === IDX && p.results.length === IDX + 1, '⑧ 分類練習不清整卷存檔', JSON.stringify(p));
// 非整卷題組交卷＝立即批改（舊行為保留）；批改也不得動整卷存檔（自訂浮層逐空選）
for (let k = 0; k < 10; k++) {
  const dd = [...c8.querySelectorAll('.gsat-dd')].find(x => !x.dataset.value);
  if (!dd) break;
  dd.querySelector('.gsat-dd-btn').click();
  dd.querySelectorAll('.gsat-dd-opt')[1]?.click();   // 第一個真選項
  await sleep(15);
}
c8.querySelector('[data-gsubmit]')?.click(); await sleep(60);
ok(c8.innerHTML.includes('data-next') && !c8.innerHTML.includes('data-gsubmit'), '⑧ 非整卷題組交卷 → 立即批改＋下一題');
p = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p && p.year === 97 && p.idx === IDX, '⑧ 題組批改也不動整卷存檔', JSON.stringify(p));
// b) 換新卷：confirm＝否 → 攔下，存檔原封
c8.querySelector('[data-home]')?.click(); await sleep(30);
globalThis.confirm = () => false;
c8.querySelector('[data-full]')?.click(); await sleep(30);
c8.querySelector('[data-year="111"]')?.click(); await sleep(60);
p = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p && p.year === 97 && p.idx === IDX, '⑧ 放棄確認＝否：存檔不被覆蓋', JSON.stringify(p));
// c) confirm＝是（＝使用者點頭放棄）→ 換新卷
globalThis.confirm = () => true;
c8.querySelector('[data-year="111"]')?.click(); await sleep(60);
p = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p && p.year === 111 && p.idx === 0, '⑧ 放棄確認＝是：開新卷寫新檔', JSON.stringify(p));

// ⑨ 端到端：整卷作答 → 無即時回饋/可回上一題/計時 → 全答完才交卷 → 報告＋配分＋入帳
localStorage.removeItem(LS_KEY);
let ask9 = false;
globalThis.confirm = () => { ask9 = true; return false; };
const g9 = await import(GSAT + '?e2e=1');
const c9 = document.getElementById('pageContainer');
c9.innerHTML = ''; c9.innerHTML = g9.render(); g9.onMount(store); await sleep(300);
c9.querySelector('[data-full]')?.click(); await sleep(30);
c9.querySelector('[data-year="97"]')?.click(); await sleep(150);
let h9 = c9.innerHTML;
ok(!ask9 && h9.includes('第 1/'), '⑨ 全新卷：不問 confirm、從第 1 題開始');
ok(/id="paperTimer">\d+:\d{2}/.test(h9), '⑨ 計時器在作答頁');
ok(!c9.querySelector('[data-submit]'), '⑨ 未答完：交卷鈕不出現');
// 第一題作答：無對錯回饋、中性高亮（可改答）
c9.querySelector('[data-pick]')?.click(); await sleep(20);
h9 = c9.innerHTML;
ok(h9.includes('第 1/') && !h9.includes('答對') && !h9.includes('答錯') && !h9.includes('正解'), '⑨ 作答中：不顯示對錯（交卷才判）');
ok(c9.querySelector('[data-pick][style*="var(--cyan)"]') != null, '⑨ 已選項中性高亮');
// 上一題導航：第 2 題可退回第 1 題、答案保留
c9.querySelector('[data-next]')?.click(); await sleep(20);
ok(c9.innerHTML.includes('第 2/') && !!c9.querySelector('[data-prev]'), '⑨ 第 2 題：有上一題鈕');
c9.querySelector('[data-prev]')?.click(); await sleep(20);
const p9 = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(c9.innerHTML.includes('第 1/') && p9?.results?.[0]?.picked, '⑨ 上一題回到第 1 題且答案保留', p9 && JSON.stringify(p9.results[0]));
// 快捷鍵：→/← 切題、Enter 下一題、Esc 首頁、數字選答、同卷續作
const key = (k) => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })); };
key('ArrowRight'); await sleep(20);
ok(c9.innerHTML.includes('第 2/'), '⑨ 快捷鍵 → 切下一題');
key('ArrowLeft'); await sleep(20);
ok(c9.innerHTML.includes('第 1/'), '⑨ 快捷鍵 ← 回上一題');
key('Enter'); await sleep(20);
ok(c9.innerHTML.includes('第 2/'), '⑨ 快捷鍵 Enter 下一題');
key('Escape'); await sleep(30);
ok(c9.innerHTML.includes('97–115 年'), '⑨ 快捷鍵 Esc 回首頁');
c9.querySelector('[data-full]')?.click(); await sleep(30);
c9.querySelector('[data-year="97"]')?.click(); await sleep(150);
ok(c9.innerHTML.includes('第 2/') && !ask9, '⑨ Esc 後同卷再進＝自動續作到第 2 題');
key('2'); await sleep(20);
const p9b = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(p9b?.results?.[1]?.picked === qs97[1].options[1][0], '⑨ 數字鍵 2 選第 2 個選項', p9b && JSON.stringify(p9b.results[1]));
// 答完全部（MC 點選、題組逐空點填、中譯英自動 focus＋Ctrl+Enter 送出）
let guard = 0;
let trFoc = null;
while (!c9.querySelector('[data-submit]') && guard++ < 400) {
  const dd = [...c9.querySelectorAll('.gsat-dd')].find(x => !x.dataset.value);
  if (dd) { dd.querySelector('.gsat-dd-btn').click(); dd.querySelectorAll('.gsat-dd-opt')[1]?.click(); await sleep(15); continue; }
  if (c9.querySelector('.gsat-dd')) { c9.querySelector('[data-next]')?.click(); await sleep(15); continue; }
  if (c9.querySelector('#gsatTrInput')) {
    if (trFoc === null) trFoc = document.activeElement?.id === 'gsatTrInput';
    const ti9 = c9.querySelector('#gsatTrInput');
    ti9.value = 'I go to school every day.';
    ti9.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await sleep(40); continue;
  }
  const pb = c9.querySelector('[data-pick]');
  if (pb) { pb.click(); await sleep(15); c9.querySelector('[data-next]')?.click(); await sleep(15); continue; }
  break;
}
ok(!!c9.querySelector('[data-submit]'), `⑨ 全部作答完（${guard} 步）→ 交卷鈕出現`);
ok(trFoc === true, '⑨ 中譯英頁進場自動 focus（免滑鼠直接打字）');
const p9end = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
ok(!!p9end?.results?.some(r => r?.tr), '⑨ Ctrl+Enter 送出 tr（tr 結果入隊，整卷唯一 tr 路徑）', p9end && JSON.stringify(p9end.results.filter(r => r?.tr).slice(0, 2)));
const logBefore = JSON.parse(localStorage.getItem('teno:gsat:log') || '[]').length;
c9.querySelector('[data-submit]')?.click(); await sleep(80);
h9 = c9.innerHTML;
ok(h9.includes('97 年整卷錯題報告'), '⑨ 交卷 → 本卷錯題報告');
const big = h9.match(/font-size:40px[^>]*>(\d+)\/(\d+)/);
ok(big && +big[2] === qs97.length, `⑨ 報告題數齊（${qs97.length} 題全入帳）`, big && big[0]);
ok(/配分 \d+ 分 → 你得 \d+ 分/.test(h9), '⑨ 報告：官方配分計分');
ok(/用時 \d+:\d{2}/.test(h9), '⑨ 報告：用時');
const logAfter = JSON.parse(localStorage.getItem('teno:gsat:log') || '[]').length;
ok(logAfter - logBefore >= 50, `⑨ 交卷入帳（+${logAfter - logBefore} 筆＝MC 只在交卷記）`);

// ⑩ 中譯英草稿/回頭：按鈕 prev/next 換題字不丟、送出後回頭顯示送出的字（trText 單值 → drafts per-qid 根治）
const c10 = document.getElementById('pageContainer');
const trIdx10 = qs97.findIndex(q => q.type === 'translate');   // 97：56/57 兩題相鄰 tr
localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, year: 97, idx: trIdx10,
  results: qs97.slice(0, trIdx10).map(q => ({ qid: q.id, ok: true, picked: 'A' })) }));
const g10 = await import(GSAT + '?seg=10');
c10.innerHTML = ''; c10.innerHTML = g10.render(); g10.onMount(store); await sleep(300);
ok(c10.querySelector('#gsatTrInput')?.dataset.qid === qs97[trIdx10].id, '⑩ 還原進度落到中譯英第 1 題');
const tiA = c10.querySelector('#gsatTrInput');
tiA.value = 'my draft translation';
c10.querySelector('[data-prev]').click(); await sleep(40);
c10.querySelector('[data-next]').click(); await sleep(40);
const tiB = c10.querySelector('#gsatTrInput');
ok(tiB && tiB.value === 'my draft translation', '⑩ 草稿：prev/next 換題回頭字不丟', tiB ? JSON.stringify(tiB.value) : 'no textarea');
tiB.value = 'submitted sentence.';
c10.querySelector('[data-ggrade]').click(); await sleep(60);
ok(c10.querySelector('#gsatTrInput')?.dataset.qid === qs97[trIdx10 + 1]?.id, '⑩ 送出跳到中譯英第 2 題');
c10.querySelector('[data-prev]').click(); await sleep(40);
const tiC = c10.querySelector('#gsatTrInput');
ok(tiC && tiC.value === 'submitted sentence.', '⑩ 送出後回頭顯示送出的字', tiC ? JSON.stringify(tiC.value) : 'no textarea');

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
