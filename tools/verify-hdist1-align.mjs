#!/usr/bin/env node
// HDIST1: 「時段分布」折線疊圖的 x 軸標籤錯位重疊。
//
// 根因：barChart 標籤在柱心 pad.l + i*(innerW/n) + bw/2，
//       lineChart 標籤在端點式 pad.l + innerW*i/(n-1)。
//       兩層都畫標籤 → 同一組數字被畫在差 2~9px 的位置 → 視覺上糊在一起。
// 修法：lineChart 加 band（對齊柱心）＋ xLabels:false（外層不重畫），
//       dashboard 的疊圖傳入兩者。
// 用法: node tools/verify-hdist1-align.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${name}${extra ? '  → ' + extra : ''}`); }
};

// 相對 import（測試檔在 tools/）——避免 repo 路徑含空白被 percent-encode
const chart = await import('../src/lib/chart.js');
const { barChart, lineChart } = chart;
const dash = readFileSync('src/pages/dashboard.js', 'utf8');

console.log('[S] 接線');
chk('dashboard 疊圖傳 band:true', /lineChart\(lineData, \{[^}]*band: true[^}]*\}\)/.test(dash));
chk('dashboard 疊圖傳 xLabels:false', /lineChart\(lineData, \{[^}]*xLabels: false[^}]*\}\)/.test(dash));
chk('barChart 仍負責畫 x 標籤', /barChart\(barData, \{ max:/.test(dash));

// 24 小時桶，與 renderHourDistChart 同型
const counts = [3,0,0,1,0,0,7,12,4,0,2,9,15,8,3,1,0,0,5,11,6,2,0,1];
const barData = counts.map((v, i) => ({ label: i % 3 === 0 ? `${i}` : '', value: v }));
const correct = counts.map(c => Math.round(c * 0.8));
const lineData = counts.map((v, i) => ({ label: i % 3 === 0 ? `${i}` : '', value: v > 0 ? Math.round((correct[i] / v) * 100) : null }));

// x 軸標籤在 y = height-6；barChart 另有一個 max 值標註在 y = pad.t-3（頂端），要排除
const xOfText = (svg) => [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)]
  .map(m => ({ x: +m[1], y: +m[2], s: m[3] }))
  .filter(o => o.y > 50);            // 只留 x 軸那一排
const xOfDots = (svg) => [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map(m => +m[1]);

const W = 460, PAD_L = 4, INNER = 452, N = 24;
const barCenters = Array.from({ length: N }, (_, i) => PAD_L + i * (INNER / N) + (INNER / N) / 2);

console.log('[B] 修好之後：兩層 x 完全同位');
const barNew = barChart(barData, { max: 15, height: 110 });
const lineNew = lineChart(lineData, { min: 0, max: 100, height: 110, band: true, xLabels: false });
const barLabels = xOfText(barNew).filter(o => o.s !== '');
const lineLabels = xOfText(lineNew);
chk('bar 層有 x 標籤', barLabels.length === 8, `實際 ${barLabels.length}`);
chk('line 層不再畫 x 標籤（xLabels:false）', lineLabels.length === 0, `實際 ${lineLabels.length}`);
chk('∴ 不會再有兩層標籤錯位', lineLabels.length === 0);

console.log('[B] band:true 讓折線點對齊柱心');
const dotsNew = xOfDots(lineNew).map(x => +x.toFixed(1));
const centersRounded = barCenters.map(x => +x.toFixed(1));
chk('折線點數 = 桶數（有值的點）', dotsNew.length === counts.filter(v => v > 0).length, `點=${dotsNew.length}`);
const centersWithValue = counts.map((v, i) => v > 0 ? centersRounded[i] : null).filter(v => v !== null);
const maxDelta = Math.max(...dotsNew.map((x, i) => Math.abs(x - centersWithValue[i])));
chk('每個折線點 x 都等於對應柱心（位元級重合）', maxDelta <= 0.001, `最大誤差 ${maxDelta}`);

console.log('[B] 其他 lineChart 呼叫端不受影響（預設仍是端點式）');
const lineDefault = lineChart(lineData, { min: 0, max: 100, height: 110 });
const dLabels = xOfText(lineDefault);
chk('預設仍會畫 x 標籤', dLabels.length === 8, `實際 ${dLabels.length}`);
chk('預設第一點在 pad.l（端點式）', xOfDots(lineDefault)[0] === PAD_L, String(xOfDots(lineDefault)[0]));
chk('預設最後一點在 pad.l+innerW', xOfDots(lineDefault).at(-1) === W - PAD_L, String(xOfDots(lineDefault).at(-1)));

console.log('[NEG] 負控制：不修（預設端點式）確實會錯位');
const lineBad = lineChart(lineData, { min: 0, max: 100, height: 110 });
const badLabels = xOfText(lineBad).filter(o => o.s !== '');
const badDelta = badLabels.map((o, i) => Math.abs(o.x - barLabels[i].x));
const worst = Math.max(...badDelta);
chk('未修時兩層同索引標籤最大錯位 > 2px（重現 bug）', worst > 2, `最大錯位 ${worst.toFixed(1)}px`);
chk('未修時首個標籤錯位明顯（bar 柱心 vs line 端點）',
  Math.abs(barLabels[0].x - badLabels[0].x) > 5,
  `bar=${barLabels[0].x} line=${badLabels[0].x}`);
console.log(`     （實測：0 號標籤 bar@${barLabels[0].x} vs line@${badLabels[0].x}，21 號 bar@${barLabels.at(-1).x} vs line@${badLabels.at(-1).x}）`);

console.log(`\nHDIST1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
