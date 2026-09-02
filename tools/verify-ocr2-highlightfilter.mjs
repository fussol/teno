#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR-OPTIMIZE A 段（A-1′）— 實體螢光筆 HSV 過濾 驗證
// 檔案: tools/verify-ocr2-highlightfilter.mjs
//
// 測 src/lib/ocr/preprocess.js 純函式層（零 DOM，直接 import）：
//   T1 rgbToHsv 標準 HSV 換算（黃/綠/粉/灰/白/黑）
//   T2 isHighlightHsv / hueInRange：黃像素在黃範圍、灰白背景在範圍外
//   T3 buildMask：合成圖（黃高亮 + 灰白背景）→ count>0、mask 限黃區
//   T4 findRegions + computeLayout：ROI 限定在黃色區、併圖尺寸正確
//   T5 resolveColor / HIGHLIGHTER_KEYS：色卡鍵盤與非法鍵回退
//   NC 負控制：色相段設成不匹配（300 紫）→ buildMask count=0、
//      filterHighlighter 回 {file:null} → 精準重現「未偵測＝整張辨識」
//   NC2 剝離 minSat 門檻（越界）→ 灰背景誤入 → 偵測門檻敏感
// 用法: node tools/verify-ocr2-highlightfilter.mjs
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rgbToHsv, isHighlightHsv, hueInRange, buildMask,
  findRegions, computeLayout, resolveColor, HIGHLIGHTER_KEYS,
  filterHighlighter,
} from '../src/lib/ocr/preprocess.js';

const PRE = 'src/lib/ocr/preprocess.js';

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
};
const near = (label, got, expect, tol = 0.015) => {
  const pass = Math.abs(got - expect) <= tol;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${got.toFixed(4)} expect≈${expect}`);
};

console.log('═══ OCR2-A 螢光筆 HSV 過濾 驗證 ═══');

// T1 HSV 換算（jsh 標準）
{
  const y = rgbToHsv(245, 215, 92);   // 螢光黃 → h 約 47
  near('T1a 黃 hue≈47', y.h, 47, 3);
  near('T1b 黃 sat>0.6', y.s, 0.63, 0.08);
  near('T1c 黃 val≈0.96', y.v, 0.96, 0.03);
  const g = rgbToHsv(110, 224, 107);  // 螢光綠 → h 約 118
  near('T1d 綠 hue≈118', g.h, 118, 5);
  const p = rgbToHsv(240, 128, 182);  // 粉 → h 約 330
  near('T1e 粉 hue≈330', p.h, 331, 6);
  const gray = rgbToHsv(128, 128, 128);
  near('T1f 灰 sat=0', gray.s, 0, 0.001);
  const white = rgbToHsv(255, 255, 255);
  near('T1g 白 sat=0', white.s, 0, 0.001);
  check('T1h 黑 v=0', rgbToHsv(0, 0, 0).v, 0);
  near('T1i 純紅 hue≈0（h0 邊界）', rgbToHsv(255, 2, 2).h, 0, 1);
}

// T2 hueInRange / isHighlightHsv（含迴繞）
{
  const ys = resolveColor('yellow');
  check('T2a 黃 40 在 30-62', hueInRange(40, ys.hue[0], ys.hue[1]), true);
  check('T2b 黃 80 不在', hueInRange(80, ys.hue[0], ys.hue[1]), false);
  const pk = resolveColor('pink');
  check('T2c 粉迴繞 355 在 340-20', hueInRange(355, pk.hue[0], pk.hue[1]), true);
  check('T2d 粉迴繞 10 在 340-20', hueInRange(10, pk.hue[0], pk.hue[1]), true);
  check('T2e 粉迴繞 180 不在', hueInRange(180, pk.hue[0], pk.hue[1]), false);
  check('T2f 黃飽和低於 minSat 排除', isHighlightHsv({ h: 40, s: 0.1, v: 0.9 }, ys), false);
  check('T2g 黃飽和足＋色相合 → 命中', isHighlightHsv({ h: 40, s: 0.8, v: 0.9 }, ys), true);
  check('T2h null spec 安全', isHighlightHsv({ h: 40, s: 0.8, v: 0.9 }, null), false);
}

// T3 buildMask 合成圖：200x60，左半黃高亮(80..160, 10..40) + 背景灰
{
  const W = 200, H = 60;
  const data = new Uint8ClampedArray(W * H * 4);
  const fill = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const o = (y * W + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  };
  fill(0, 0, W - 1, H - 1, 205, 205, 205);             // 灰背景
  fill(80, 10, 160, 40, 245, 215, 92);                 // 黃高亮塊
  const yellow = buildMask({ data, w: W, h: H }, resolveColor('yellow'));
  check('T3a 黃 mask count = 81*31=2511', yellow.count, (160 - 80 + 1) * (40 - 10 + 1));
  // 抽樣：黃區內 mask=1、灰區 mask=0
  check('T3b 黃中心 mask=1', yellow.mask[(25 * W + 120)], 1);
  check('T3c 灰左上 mask=0', yellow.mask[(5 * W + 5)], 0);
}

// T4 findRegions + computeLayout：ROI 僅黃區
{
  const W = 200, H = 60;
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b) => { const o = (y * W + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 205, 205, 205);
  for (let y = 10; y <= 40; y++) for (let x = 80; x <= 160; x++) put(x, y, 245, 215, 92);
  const { mask } = buildMask({ data, w: W, h: H }, resolveColor('yellow'));
  const boxes = findRegions(mask, W, H);
  check('T4a 一個黃區塊 (81x31)', boxes.length, 1);
  if (boxes[0]) check('T4b ROI = {80,10,81,31}', [boxes[0].x, boxes[0].y, boxes[0].w, boxes[0].h], [80, 10, 81, 31]);
  const lay = computeLayout(boxes, W, H);
  check('T4c 併圖 = 81x31（非原圖 200x60）', [lay.outW, lay.outH], [81, 31]);
  check('T4d draw source = 黃區', [lay.draws[0].sx, lay.draws[0].sw], [80, 81]);
  // 多塊併圖：再加另一黃塊
  for (let y = 4; y <= 8; y++) for (let x = 5; x <= 20; x++) put(x, y, 250, 220, 100);
  const { mask: m2 } = buildMask({ data, w: W, h: H }, resolveColor('yellow'));
  const boxes2 = findRegions(m2, W, H, { mergeGap: 2 });
  check('T4e 兩黃塊（無併 mergeGap=2）', boxes2.length, 2);
  const b2 = boxes2.map(b => [b.x, b.y, b.w, b.h]).sort((a, b) => a[0] - b[0]);
  check('T4f 塊1=(5,4,16,5)', b2[0], [5, 4, 16, 5]);
  check('T4g 塊2=(80,10,81,31)', b2[1], [80, 10, 81, 31]);
  const lay2 = computeLayout(boxes2, W, H);
  check('T4h 兩塊併圖寬=16+81=97', lay2.outW, 16 + 81);
  // gap merge：設 mergeGap≥ 下拉兩塊成一塊
  const boxes3 = findRegions(m2, W, H, { mergeGap: 200 });
  check('T4i mergeGap 大 → 併成一塊', boxes3.length, 1);
}

// T4.5 scanBands 尾端不吞尾隙（A4 修復釘）：內容 y=10..14，H=20，尾隙5≤merge 8
{
  const W = 60, H = 20;
  const data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, r, g, b) => { const o = (y * W + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 205, 205, 205);
  for (let y = 10; y <= 14; y++) for (let x = 10; x <= 50; x++) put(x, y, 245, 215, 92);
  const { mask } = buildMask({ data, w: W, h: H }, resolveColor('yellow'));
  const boxes = findRegions(mask, W, H, { mergeGap: 8 });
  check('T4.5a ROI h=5（不吞尾隙 5px 純背景）', boxes[0] && boxes[0].h, 5);
  check('T4.5b ROI y=10', boxes[0] && boxes[0].y, 10);
}

// T5 resolveColor / 鍵
{
  check('T5a 色卡鍵 = [yellow,green,pink]', HIGHLIGHTER_KEYS, ['yellow', 'green', 'pink']);
  check('T5b resolve 非法鍵 null', resolveColor('blue'), null);
  check('T5c 黃規格 hue [30,62]', resolveColor('yellow').hue, [30, 62]);
}

// T6 filterHighlighter 依賴注入 mock canvas 端到端（負控制併入）
{
  // mock File + decodeImg 回合成 ImageData（含單一黃塊）+ createCanvas 可裁可 toBlob
  const makeCanvas = (w, h) => {
    const px = new Uint8ClampedArray(w * h * 4);
    const cv = {
      width: w, height: h,
      getContext: () => ({
        _px: px, _w: w, _h: h,
        putImageData: (imgData, dx0, dy0) => {
          // 契約：imageData 必是 {data,width,height}（getImageData 型別）
          if (!imgData || !imgData.data) throw new TypeError('putImageData: 非 ImageData');
          for (let yy = 0; yy < imgData.height; yy++) for (let xx = 0; xx < imgData.width; xx++) {
            const so = (yy * imgData.width + xx) * 4;
            const do2 = ((dy0 + yy) * cv.width + (dx0 + xx)) * 4;
            px[do2] = imgData.data[so]; px[do2 + 1] = imgData.data[so + 1];
            px[do2 + 2] = imgData.data[so + 2]; px[do2 + 3] = imgData.data[so + 3];
          }
        },
        drawImage: (src, sx, sy, sw, sh, dx, dy, dw, dh) => {
          // 契約：src 必是合法 CanvasImageSource 形（ImageData 應已由 putImageData 落地成 {getContext} canvas）
          if (!src || typeof src.getContext !== 'function') throw new TypeError(`drawImage: 非 CanvasImageSource (got ${typeof src})`);
          const sctx = src.getContext('2d');
          const sw2 = sctx._w || (src.width || 0);
          if (!sw2) throw new TypeError('drawImage: source canvas 未有尺寸');
          for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
            const so = ((sy + yy) * sw2 + (sx + xx)) * 4;
            const dstX = dx + xx, dstY = dy + yy;
            if (dstX >= 0 && dstX < w && dstY >= 0 && dstY < h) {
              const do2 = (dstY * w + dstX) * 4;
              px[do2] = sctx._px[so]; px[do2 + 1] = sctx._px[so + 1];
              px[do2 + 2] = sctx._px[so + 2]; px[do2 + 3] = 255;
            }
          }
        },
        getImageData: () => ({ data: px, width: w, height: h }),
      }),
      toBlob: (cb) => cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })),
    };
    return cv;
  };
  const W = 200, H = 60;
  const srcpx = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { srcpx[i * 4] = 205; srcpx[i * 4 + 1] = 205; srcpx[i * 4 + 2] = 205; srcpx[i * 4 + 3] = 255; }
  for (let y = 10; y <= 40; y++) for (let x = 80; x <= 160; x++) { const o = (y * W + x) * 4; srcpx[o] = 245; srcpx[o + 1] = 215; srcpx[o + 2] = 92; }
  const fakeFile = new File(['x'], 't.png', { type: 'image/png' });
  const deps = {
    createImageBitmap: async () => ({ width: W, height: H, close() {} }),
    decodeImg: async () => ({ data: srcpx, width: W, height: H }),
    createCanvas: makeCanvas,
  };
  const out = await filterHighlighter(fakeFile, resolveColor('yellow'), deps);
  check('T6a 偵測黃 → file 非 null', out.file !== null, true);
  check('T6b count = 2511', out.count, 2511);
  check('T6c boxes 1 塊', out.boxes.length, 1);
  check('T6d 併圖 file type png', out.file.type, 'image/png');
}

// NC 負控制：色相不匹配 → 回原圖（未偵測）
{
  const W = 200, H = 60;
  const srcpx = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { srcpx[i * 4] = 205; srcpx[i * 4 + 1] = 205; srcpx[i * 4 + 2] = 205; srcpx[i * 4 + 3] = 255; }
  for (let y = 10; y <= 40; y++) for (let x = 80; x <= 160; x++) { const o = (y * W + x) * 4; srcpx[o] = 245; srcpx[o + 1] = 215; srcpx[o + 2] = 92; }
  // 用紫（hue 285, 完全不含黃 30-62）當 spec
  const purple = { name: '紫', hue: [280, 300], minSat: 0.3, minVal: 0.3 };
  const m = buildMask({ data: srcpx, w: W, h: H }, purple);
  check('NC1 紫 spec → mask count=0', m.count, 0);
  const fakeFile = new File(['x'], 't.png', { type: 'image/png' });
  const out = await filterHighlighter(fakeFile, purple, {
    createImageBitmap: async () => ({ width: W, height: H, close() {} }),
    decodeImg: async () => ({ data: srcpx, width: W, height: H }),
    createCanvas: () => { throw new Error('負控制不得呼叫 canvas'); },
  });
  check('NC2 mask 空 → file=null（回退整張辨識）', out.file, null);
}

// NC2 剝離 minSat 門檻 → 灰背景誤入（偵測敏感）
{
  const W = 10, H = 10;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const o = i * 4; data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = 255; }
  const specNoMin = { name: '破', hue: [0, 60], minSat: 0 };
  const m = buildMask({ data, w: W, h: H }, specNoMin);
  check('NC2a 灰（sat=0）+minSat=0 → 誤入 count=100', m.count, 100);
  const specWith = resolveColor('yellow'); // minSat=0.30
  const m2 = buildMask({ data, w: W, h: H }, specWith);
  check('NC2b 同灰＋minSat=0.30 → 排除 count=0', m2.count, 0);
}

// NC3（第3席）粉迴繞卡的灰階防線釘：灰 h=0 恰落粉迴繞區[340,20]內，
// minSat 是唯一防線。剝離 → 灰 100% 誤入（粉卡是唯一需釘的迴繞組合）。
{
  const W = 10, H = 10;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const o = i * 4; data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = 255; }
  const mPink = buildMask({ data, w: W, h: H }, resolveColor('pink'));
  check('NC3 灰×粉迴繞 minSat=0.26 擋下 count=0', mPink.count, 0);
  const pinkNoMin = { name: '粉破', hue: [340, 20], minSat: 0 };
  const mPinkBrk = buildMask({ data, w: W, h: H }, pinkNoMin);
  check('NC3b 剝 minSat → 灰 100% 誤入（一刀測出防線）', mPinkBrk.count, 100);
}

console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);