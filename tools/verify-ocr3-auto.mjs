#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// OCR3 自動前處理驗證 — auto-preprocess.js 純函式＋負控制
//   T1 looksUneven（均勻→false；半暗→true）
//   T2 adaptive 在半暗圖保住暗側（對照 Otsu 暗側全黑）
//   T3 白邊尺寸 +12*2
//   T4 暗底反白
//   T5 去噪（孤點清、實線留）
//   T6 selectPsm（有框/highlight→6；整頁→3）
//   T7 shouldSecondShot（<3→true；≥3→false）
//   T8 autoPreprocess 編排（半暗小字圖 applied 含 adaptive＋upscale）
//   NC1 looksUneven 閾值改 ∞（永不 adaptive）→ T2 類斷言紅（分支敏感）
//   NC2 selectPsm 恆回 3 → T6 紅
// ═══════════════════════════════════════════════════════════════
import {
  quadrantMeans, looksUneven, adaptiveThreshold, detectDarkBackground,
  invertGray, despeckleBinary, addWhiteBorder, shouldSecondShot,
  autoPreprocessPixels,
} from '../src/lib/ocr/auto-preprocess.js';
import { selectPsm, PSM } from '../src/lib/ocr/tesseract-adapter.js';
import { otsuThreshold } from '../src/lib/ocr/upscale.js';

let failures = 0;
const check = (label, got, expect) => {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
};

// T1 looksUneven
{
  const W = 40, H = 40;
  const even = new Uint8ClampedArray(W * H).fill(200);
  check('T1a 均勻灰→false', looksUneven(even, W, H), false);
  // 半暗：左半 200、右半 100（象限差 100>35）
  const half = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) half[y * W + x] = x < W / 2 ? 200 : 100;
  check('T1b 半暗圖→true', looksUneven(half, W, H), true);
  const qm = quadrantMeans(half, W, H).map(Math.round);
  check('T1c 四象限均值 [200,100,200,100]', qm, [200, 100, 200, 100]);
}

// T2 adaptive 保暗側（對照 Otsu 暗側糊成整塊黑）
// 場景：左亮底 210＋暗字 60；右暗底 110＋暗字 30。
// 全域 Otsu 閾值落在中間→右側底(110)與字(30)全在閾值下→整塊黑，字丟失；
// adaptive 用局部均值→暗側底白字黑，字保住。
{
  const W = 60, H = 20;
  const gray = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = x < W / 2 ? 210 : 110;
  // 兩側各一條暗字橫線（y=9..11）
  for (let y = 9; y <= 11; y++) {
    for (let x = 5; x < W / 2 - 5; x++) gray[y * W + x] = 60;
    for (let x = W / 2 + 5; x < W - 5; x++) gray[y * W + x] = 30;
  }
  const t = otsuThreshold(gray);
  // Otsu 二值：暗側字區白像素數（應≈0，全黑糊掉）
  let otsuDarkWhite = 0;
  for (let y = 9; y <= 11; y++) for (let x = W / 2 + 5; x < W - 5; x++) if (gray[y * W + x] > t) otsuDarkWhite++;
  // Otsu 暗側背景是否也被判黑（糊掉證據）
  let otsuDarkBgBlack = 0;
  for (let y = 2; y <= 4; y++) for (let x = W / 2 + 5; x < W - 5; x++) if (gray[y * W + x] <= t) otsuDarkBgBlack++;
  const adapt = adaptiveThreshold(gray, W, H);
  let adaptDarkWhite = 0;   // 暗側字行的字（黑像素數）
  for (let y = 9; y <= 11; y++) for (let x = W / 2 + 5; x < W - 5; x++) if (adapt[y * W + x] === 0) adaptDarkWhite++;
  let adaptDarkBgWhite = 0; // 暗側背景（白像素數）
  for (let y = 2; y <= 4; y++) for (let x = W / 2 + 5; x < W - 5; x++) if (adapt[y * W + x] === 255) adaptDarkBgWhite++;
  console.log(`    T2 debug: otsu t=${t} otsuDarkWhite=${otsuDarkWhite} otsuDarkBgBlack=${otsuDarkBgBlack} adaptDarkBlack=${adaptDarkWhite} adaptDarkBgWhite=${adaptDarkBgWhite}`);
  check('T2a Otsu 暗側糊掉（背景黑像素多）', otsuDarkBgBlack > 30, true);
  check('T2b adaptive 暗側背景保白', adaptDarkBgWhite > 30, true);
  check('T2c adaptive 暗側字保黑', adaptDarkWhite > 30, true);
}

// T3 白邊
{
  const bin = new Uint8ClampedArray(10 * 8).fill(0);
  const r = addWhiteBorder(bin, 10, 8);
  check('T3a 白邊寬=10+24', r.w, 34);
  check('T3b 白邊高=8+24', r.h, 32);
  check('T3c 邊角為白', r.bin[0], 255);
  check('T3d 內容保留黑', r.bin[(12 + 1) * r.w + (12 + 1)], 0);
}

// T4 暗底反白
{
  const dark = new Uint8ClampedArray(100).fill(40);
  check('T4a 暗底判定 true', detectDarkBackground(dark), true);
  const bright = new Uint8ClampedArray(100).fill(210);
  check('T4b 亮底判定 false', detectDarkBackground(bright), false);
  const inv = invertGray(new Uint8ClampedArray([40]));
  check('T4c 反白 40→215', inv[0], 215);
}

// T5 去噪
{
  const W = 9, H = 9;
  const bin = new Uint8ClampedArray(W * H).fill(255);
  bin[4 * W + 4] = 0;                       // 孤點
  for (let x = 1; x <= 5; x++) bin[7 * W + x] = 0;  // 橫實線
  const out = despeckleBinary(bin, W, H);
  check('T5a 孤點清除', out[4 * W + 4], 255);
  check('T5b 實線中段保留', out[7 * W + 3], 0);
}

// T6 selectPsm
{
  check('T6a 有框→6', selectPsm({ hasCrop: true, mode: 'scan' }), 6);
  check('T6b highlight→6', selectPsm({ hasCrop: false, mode: 'highlight' }), 6);
  check('T6c 整頁 scan→3', selectPsm({ hasCrop: false, mode: 'scan' }), 3);
  check('T6d PSM 常數', [PSM.AUTO, PSM.SINGLE_BLOCK], [3, 6]);
}

// T7 shouldSecondShot
{
  check('T7a 0字→true', shouldSecondShot({ finalCount: 0 }), true);
  check('T7b 2字→true', shouldSecondShot({ finalCount: 2 }), true);
  check('T7c 3字→false', shouldSecondShot({ finalCount: 3 }), false);
  check('T7d 10字→false', shouldSecondShot({ finalCount: 10 }), false);
}

// T8 編排：半暗小字圖
{
  const W = 120, H = 60;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const base = x < W / 2 ? 200 : 90;   // 右半暗
    data[o] = data[o + 1] = data[o + 2] = base; data[o + 3] = 255;
  }
  // 暗側加幾行亮字（模擬文字行，觸發行高估計＋adaptive）
  for (let r = 0; r < 4; r++) {
    const y0 = 8 + r * 12;
    for (let y = y0; y < y0 + 6 && y < H; y++)
      for (let x = W / 2 + 5; x < W - 5; x++) {
        const o = (y * W + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 170;
      }
  }
  const { applied, scale, img } = autoPreprocessPixels({ data, width: W, height: H });
  check('T8a applied 含 adaptive', applied.includes('adaptive'), true);
  check('T8b applied 含 border', applied.includes('border'), true);
  check('T8c 輸出寬>輸入寬（放大或白邊）', img.width > W, true);
  console.log(`    note: scale=${scale} applied=${applied.join('+')} out=${img.width}x${img.height}`);
}

// ── NC 負控制 ──
{
  // NC1：閾值 ∞ → 永不 adaptive（分支敏感：同圖回 false）
  const W = 40, H = 40;
  const half = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) half[y * W + x] = x < W / 2 ? 200 : 100;
  check('NC1 閾值∞→false（分支存在才紅）', looksUneven(half, W, H, Infinity), false);
  // NC2：寫死 PSM 3 的反事實 → 有框也回 3 ≠ 真實 6（選擇邏輯敏感）
  const hardThree = 3;
  check('NC2 寫死3 vs 真實6 不等（選擇敏感）', hardThree === selectPsm({ hasCrop: true, mode: 'scan' }), false);
}

console.log(failures === 0 ? '═══ ALL PASS ═══' : `═══ ${failures} FAILURES ═══`);
process.exit(failures === 0 ? 0 : 1);
