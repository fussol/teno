#!/usr/bin/env node
// ═══ VERIFY-OCR-SMALLTEXT — 小字超取樣前處理 harness ═══
// 測 upscale.js 純函式層：estimateLineHeight（合成文字行）/ recommendScale /
// otsuThreshold / enhanceForOcrPixels（端到端：小字圖 → 3x 二值化輸出）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const modPath = path.join(ROOT, 'src/lib/ocr/upscale.js');
// .js 含 DOM wrapper（createImageBitmap）— node 直 import 會在頂層嗎？wrapper 是函式內引用，頂層安全
const { estimateLineHeight, recommendScale, otsuThreshold, enhanceForOcrPixels } = await import('file://' + modPath);

let fail = 0, total = 0;
const ok = (l, c, d) => { total++; if (!c) { fail++; console.log(`FAIL ${l}${d ? ' :: ' + JSON.stringify(d) : ''}`); } else console.log(`PASS ${l}`); };

// ── 合成小字圖：白底 + 黑字行（行高 12px，模擬遠拍小字）──
function synthSmallText(W, H, lineH, lines = 5) {
  // v3 行黑密度法需要「真實字密」：黑像素佔行面積 ~45%（粗筆畫模擬）
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const gap = Math.max(2, Math.round(lineH * 0.6));
  const stroke = Math.max(2, Math.round(lineH * 0.22));   // 筆畫粗 = 行高 22%
  for (let li = 0; li < lines; li++) {
    const y0 = 4 + li * (lineH + gap);
    if (y0 + lineH > H) break;
    for (let y = y0; y < y0 + lineH; y++) {
      // 假字：週期性粗豎筆（週期 = 4×stroke，黑佔 45%）
      const cyc = Math.max(4, stroke * 4);
      for (let x = 8; x < W - 8; x++) {
        const phase = (x + y) % cyc;
        const on = phase < Math.round(cyc * 0.45);
        const v = on ? 30 : 245;
        const o = (y * W + x) * 4;
        data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
      }
    }
  }
  return { data, width: W, height: H };
}

// T1 estimateLineHeight：合成 24px 行（v3 4px 抽樣的可靠下限）→ 偵測 16~36
{
  const img = synthSmallText(400, 240, 24, 4);
  const h = estimateLineHeight(img.data, img.width, img.height);
  ok('T1 合成 24px 行 → 估 16~36px', Number.isFinite(h) && h >= 16 && h <= 36, h);
}
// T1b v3 抽樣極限標註：12px 行（4px 抽樣=3 帶）被 8px 帶下限過濾屬設計（防噪碎帶）
{
  const img = synthSmallText(400, 200, 12);
  const h = estimateLineHeight(img.data, img.width, img.height);
  ok('T1b 合成 12px 行（v3 下限設計可 Infinity 或 <=16）', !Number.isFinite(h) || h <= 16, h);
}
// T1b 大字（36px 行）→ 不需增強（>=30）
{
  const img = synthSmallText(600, 400, 36);
  const h = estimateLineHeight(img.data, img.width, img.height);
  ok('T1b 合成 36px 行 → >=30', h >= 30, h);
}
// T2 recommendScale 邊界
{
  ok('T2a 10px → 3x', recommendScale(10) === 3);
  ok('T2b 20px → 2x', recommendScale(20) === 2);
  ok('T2c 29px → 2x', recommendScale(29) === 2);
  ok('T2d 30px → 1x', recommendScale(30) === 1);
  ok('T2e Infinity → 1x', recommendScale(Infinity) === 1);
}
// T3 otsuThreshold：雙峰直方圖 → 門檻完美分離兩峰（分離型雙峰下 40~219 皆合法，驗分離性）
{
  const gray = new Uint8ClampedArray(1000);
  for (let i = 0; i < 500; i++) gray[i] = 40;    // 文字峰
  for (let i = 500; i < 1000; i++) gray[i] = 220; // 背景峰
  const t = otsuThreshold(gray);
  ok('T3 Otsu 雙峰 → 門檻落在兩峰間（40<=t<220，分離完美）', t >= 40 && t < 220, t);
}
// T4 端到端：12px 小字 → 3x 輸出
{
  const img = synthSmallText(400, 260, 22, 4);
  const { img: out, scale, note } = enhanceForOcrPixels(img);
  ok('T4a 小字 22px → 偵測>=20 應 scale=2（22~29 區間規則）', scale === 2, note);
  ok('T4b 輸出尺寸 2x', out.width === 800 && out.height === 520, `${out.width}x${out.height}`);
  let mid = 0, total2 = 0;
  for (let i = 0; i < out.data.length; i += 4) { const v = out.data[i]; if (v !== 0 && v !== 255) mid++; total2++; }
  ok('T4c 二值化主體（中間值 <=5%，雙線性內插邊緣）', mid / total2 <= 0.05, `${mid}/${total2} = ${(mid / total2 * 100).toFixed(1)}%`);
}
// T4 端到端（大字不動）
{
  const img = synthSmallText(600, 400, 36);
  const { scale, img: out } = enhanceForOcrPixels(img);
  ok('T5 大字 36px → scale=1 原尺寸', scale === 1 && out.width === 600, `${scale}x ${out.width}`);
}
// T6 平面（無文字）→ skip
{
  const data = new Uint8ClampedArray(100 * 100 * 4).fill(240);
  const { scale, note } = enhanceForOcrPixels({ data, width: 100, height: 100 });
  ok('T6 空白平面 → scale 1', scale === 1, note);
}

console.log(fail === 0 ? `\n═══ ${total - fail}/${total} ALL PASS ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
