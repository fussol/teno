// ═══════════════════════════════════════════════════════════════
// OCR3 自動前處理 — 全自動條件式管線（OCR3-optimize-plan §3.1）
//
// 參考（出处記名）：
//   1. Tesseract 官方《Improving the quality of the output》
//      （tesseract-ocr.github.io/tessdoc/ImproveQuality.html）：
//      DPI≥300、背景不均時內部 Otsu 次優、緊裁切加白邊（issue 398）、
//      小區域換 PSM。→ 白邊＋條件分支的直接來源。
//   2. Multigrid《OCR Pipelines: The Preprocessing That Decides Your
//      Accuracy》（multigrid.ai/learn/ocr-pipeline）：looks_uneven 四象限
//      均值差>40 才用 adaptive（Gaussian blockSize 31／C 10），乾淨圖硬套
//      反而變差；旋轉/去噪同樣 gate。→ 全自動條件式架構＋參數照抄
//      （閾值 40→35，手機拍照陰影更常見）。
//   3. Otsu, N. (1979), IEEE TSMC → otsuThreshold 沿用 upscale.js，不重寫。
//
// 本檔＝純函式層（零 DOM／零 canvas），node harness 直測；DOM wrapper
// `autoEnhanceSmallText` 走依賴注入（同 preprocess.js filterHighlighter
// 模式）。舊 `enhanceForOcrPixels` 一字不動（既有 harness 保住）。
// ═══════════════════════════════════════════════════════════════
import { otsuThreshold, estimateLineHeight, recommendScale } from './upscale.js';

/** 四象限灰階均值（Multigrid looks_uneven 同構）。@returns {[number,number,number,number]} */
export function quadrantMeans(gray, w, h) {
  const out = [0, 0, 0, 0];
  const cnt = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    const qy = y < h / 2 ? 0 : 2;
    for (let x = 0; x < w; x++) {
      const q = qy + (x < w / 2 ? 0 : 1);
      out[q] += gray[y * w + x];
      cnt[q]++;
    }
  }
  return out.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
}

/**
 * 光照是否不均（Multigrid 同構：四象限最大均值差>thr）。
 * @param {number} [thr=35] 官方文 40；手機拍照陰影常見，降 35。
 */
export function looksUneven(gray, w, h, thr = 35) {
  if (!gray || w <= 0 || h <= 0) return false;
  const m = quadrantMeans(gray, w, h);
  return Math.max(...m) - Math.min(...m) > thr;
}

/** 積分圖（adaptive box-mean 加速用）。@returns {Float64Array} (w+1)*(h+1) */
export function integralImage(gray, w, h) {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return ii;
}

/** 積分圖矩形和：[x0,x1)×[y0,y1)。 */
function rectSum(ii, w, x0, y0, x1, y1) {
  const W = w + 1;
  return ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
}

/**
 * 局部自適應二值化（Multigrid 參數照抄：Gaussian 近似以 box-mean 代，
 * blockSize=31／C=10；block 須奇數且大於一個字）。
 * @returns {Uint8ClampedArray} 0/255 二值灰階
 */
export function adaptiveThreshold(gray, w, h, block = 31, C = 10) {
  const half = Math.floor(block / 2);
  const ii = integralImage(gray, w, h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
      const n = (x1 - x0) * (y1 - y0);
      const mean = rectSum(ii, w, x0, y0, x1, y1) / n;
      out[y * w + x] = gray[y * w + x] > mean - C ? 255 : 0;
    }
  }
  return out;
}

/** 暗底判定（均值<100 → 白底黑字假設不成立，需反白）。@returns {boolean} */
export function detectDarkBackground(gray) {
  if (!gray || !gray.length) return false;
  let s = 0;
  const step = Math.max(1, Math.floor(gray.length / 4096)); // 抽樣加速
  let n = 0;
  for (let i = 0; i < gray.length; i += step) { s += gray[i]; n++; }
  return s / n < 100;
}

/** 灰階反白（就地回新陣列）。 */
export function invertGray(gray) {
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = 255 - gray[i];
  return out;
}

/**
 * 去孤點噪（單遍：黑像素 3×3 鄰居黑<2 → 轉白；實線保留）。
 * @param {Uint8ClampedArray} bin 0/255 二值
 * @returns {Uint8ClampedArray} 新陣列
 */
export function despeckleBinary(bin, w, h) {
  const out = new Uint8ClampedArray(bin);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (bin[i] !== 0) continue;
      let nb = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (bin[(y + dy) * w + (x + dx)] === 0) nb++;
        }
      }
      if (nb < 2) out[i] = 255;
    }
  }
  return out;
}

/**
 * 白邊填充（Tesseract issue 398：緊裁切掉字邊，加白邊救回）。
 * @returns {{bin:Uint8ClampedArray, w:number, h:number}}
 */
export function addWhiteBorder(bin, w, h, pad = 12) {
  const W = w + pad * 2, H = h + pad * 2;
  const out = new Uint8ClampedArray(W * H).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[(y + pad) * W + (x + pad)] = bin[y * w + x];
  }
  return { bin: out, w: W, h: H };
}

/**
 * 自動第二槍觸發判定（tesseract confidence 灌水嚴重，主判據用字數）。
 * @param {{finalCount:number}} a
 */
export function shouldSecondShot(a) {
  return (a?.finalCount ?? 0) < 3;
}

/** RGBA → 灰階（0.299/0.587/0.114）＋ min-max 對比拉伸。 */
export function toStretchedGray(data, w, h) {
  const gray = new Uint8ClampedArray(w * h);
  let mn = 255, mx = 0;
  for (let i = 0; i < w * h; i++) {
    const g = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    gray[i] = g;
    if (g < mn) mn = g; if (g > mx) mx = g;
  }
  const range = Math.max(1, mx - mn);
  for (let i = 0; i < w * h; i++) gray[i] = ((gray[i] - mn) / range) * 255;
  return gray;
}

/** 灰階雙線性放大。@returns {{big:Uint8ClampedArray,w:number,h:number}} */
export function upscaleGray(gray, w, h, scale) {
  if (scale <= 1) return { big: gray, w, h };
  const W = Math.round(w * scale), H = Math.round(h * scale);
  const big = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, y / scale);
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, x / scale);
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      big[y * W + x] =
        gray[y0 * w + x0] * (1 - fx) * (1 - fy) + gray[y0 * w + x1] * fx * (1 - fy) +
        gray[y1 * w + x0] * (1 - fx) * fy + gray[y1 * w + x1] * fx * fy;
    }
  }
  return { big, w: W, h: H };
}

/**
 * 主編排：RGBA → 自動條件管線 → RGBA。
 * @returns {{img:{data:Uint8ClampedArray,width:number,height:number},scale:number,applied:string[],note:string}}
 */
export function autoPreprocessPixels(img) {
  const { data, width: w, height: h } = img;
  if (!data || w <= 0 || h <= 0) return { img, scale: 1, applied: [], note: 'skip-empty' };
  const applied = [];
  // 1. 灰階＋拉伸
  let gray = toStretchedGray(data, w, h);
  // 2. 暗底反白（Tesseract 4+ 只吃黑字白底）
  if (detectDarkBackground(gray)) { gray = invertGray(gray); applied.push('invert'); }
  // 3. 行高估計（拉伸後灰階上估，與舊管線同輸入等級）
  const lineH = estimateLineHeight(
    (() => { const rgba = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray[i]; rgba[i * 4 + 3] = 255; } return rgba; })(),
    w, h,
  );
  const scale = recommendScale(lineH);
  if (scale > 1) applied.push(`upscale${scale}x`);
  // 4. 條件二值化：不均→局部自適應，乾淨→全域 Otsu（Multigrid 核心結論）
  const uneven = looksUneven(gray, w, h);
  let bin;
  if (uneven) { bin = adaptiveThreshold(gray, w, h); applied.push('adaptive'); }
  else {
    const t = otsuThreshold(gray);
    bin = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) bin[i] = gray[i] > t ? 255 : 0;
    applied.push('otsu');
  }
  // 5. 去孤點（單遍輕量，常開）
  bin = despeckleBinary(bin, w, h);
  applied.push('despeckle');
  // 6. 放大（二值後放大？不——先放大灰階再二值化邊緣更平滑。為保本波改動最小，
  //    此處維持「先二值後放大最近鄰級」會鋸齒；故重排：放大走灰階路徑。）
  //    實作：若 scale>1，對 gray 放大後重跑一次二值化＋去噪。
  let W = w, H = h, final = bin;
  if (scale > 1) {
    const up = upscaleGray(gray, w, h, scale);
    W = up.w; H = up.h;
    if (uneven) final = adaptiveThreshold(up.big, W, H);
    else {
      const t2 = otsuThreshold(up.big);
      final = new Uint8ClampedArray(W * H);
      for (let i = 0; i < W * H; i++) final[i] = up.big[i] > t2 ? 255 : 0;
    }
    final = despeckleBinary(final, W, H);
  }
  // 7. 白邊
  const bordered = addWhiteBorder(final, W, H);
  applied.push('border');
  const out = new Uint8ClampedArray(bordered.w * bordered.h * 4);
  for (let i = 0; i < bordered.w * bordered.h; i++) {
    const v = bordered.bin[i];
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  const note = `lineH≈${Number.isFinite(lineH) ? lineH.toFixed(0) : '?'}px ${applied.join('+')}`;
  return { img: { data: out, width: bordered.w, height: bordered.h }, scale, applied, note };
}

// ═══ DOM wrapper（瀏覽器組裝層；與 upscale.js enhanceSmallText 同模式）═══

/**
 * File/Blob → 自動前處理後 File。大字＋均勻＋亮底仍走全套（白邊恆加，
 * 故 scale===1 也不回 null；呼叫端一律用回傳 file）。
 * @returns {Promise<{file: File|null, scale:number, applied:string[], note:string}>}
 */
export async function autoEnhanceSmallText(file) {
  if (!file) return { file: null, scale: 1, applied: [], note: 'no-input' };
  const bitmap = await createImageBitmap(file);
  const w = bitmap.width, h = bitmap.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const imgData = ctx.getImageData(0, 0, w, h);
  const { img, scale, applied, note } = autoPreprocessPixels({ data: imgData.data, width: w, height: h });
  const cv2 = document.createElement('canvas');
  cv2.width = img.width; cv2.height = img.height;
  cv2.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const blob = await new Promise((res, rej) => cv2.toBlob(b => b ? res(b) : rej(new Error('自動前處理失敗')), 'image/png'));
  return { file: new File([blob], 'ocr-auto.png', { type: 'image/png' }), scale, applied, note };
}
