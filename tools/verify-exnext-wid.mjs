// ELOOP1: 「下一組」字不跨頁串字 —— bindExNext 吃卡片 data-wid → store 找字，
// 不吃 getWord 閉包（#pageContainer 常駐 → 舊頁閉包會拿上一頁的字）。
import { readFileSync } from 'fs';

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) fail++;
};

const src = readFileSync(new URL('../src/lib/svg.js', import.meta.url), 'utf8');

// 1) studyExampleHtml 有 data-wid；bindExNext 不再收 getWord
ok('studyExampleHtml 輸出 data-wid', /class="study-example" style="width:100%" data-wid="\$\{w\.id\}"/.test(src));
ok('bindExNext 無 getWord 參數', /export function bindExNext\(root\)/.test(src));
ok('bindExNext 用 box.dataset.wid 對 store 找字', /store\.state\.words\s*\|\|\s*\[\]\)\.find\(x => x\.id === box\.dataset\.wid\)/.test(src));
ok('六頁 bindExNext 不帶 getWord 閉包', ['study-v4', 'study-mc', 'study-spell', 'exam-flip', 'exam-mc', 'exam-spell']
  .every(p => readFileSync(new URL(`../src/pages/${p}.js`, import.meta.url), 'utf8')
    .includes("bindExNext(document.getElementById('pageContainer'));")));

// 2) 行為模擬：stale 第二參數存在也不生效 —— 點擊刷新的是卡片 data-wid 那個字
globalThis.window = { __maxExampleLines: 2 };
const stripped = src.replace(/^import .*;$/gm, '').replace(/export /g, '');
const words = [
  { id: 'w1', word: 'ephemeral', example: 'Ephemeral one.\nEphemeral two.\nEphemeral three.\nEphemeral four.' },
  { id: 'w2', word: 'inspection', example: 'Inspection one.\nInspection two.\nInspection three.\nInspection four.' },
];
const store = { state: { words } };
const pickNextExamples = (lines, max, prev, counts) => {
  const pool = lines.filter(l => !new Set(prev || []).has(l));
  const picked = pool.slice(0, max);
  for (const p of picked) counts[p] = (counts[p] || 0) + 1;
  return picked;
};
const api = new Function('store', 'pickNextExamples', `${stripped}
  return { bindExNext, studyExampleHtml };`)(store, pickNextExamples);

let handler = null;
const root = { addEventListener: (t, fn) => { if (t === 'click') handler = fn; } };
api.bindExNext(root);                       // 第一參數 only（第二參數閉包已拔）
ok('handler 已綁', typeof handler === 'function');

const box = { dataset: { wid: 'w1' }, innerHTML: 'INITIAL' };
const btn = {
  outerHTML: '<button class="ex-corner">X</button>',
  classList: { contains: (c) => c === 'ex-corner' },
  closest: (sel) => sel.includes('.study-example') ? box : null,
};
handler({
  target: { closest: (sel) => sel.includes('.ex-corner') ? btn : null },
  stopPropagation: () => {},
});
ok('刷新後是卡片自己的字（ephemeral）', box.innerHTML.includes('Ephemeral'), box.innerHTML.slice(0, 120));
ok('不會吃到別字（inspection）', !box.innerHTML.includes('Inspection'));
ok('下一組按鈕保留', box.innerHTML.includes('ex-corner'));

console.log(`\nEXNEXT-WID 驗證: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
