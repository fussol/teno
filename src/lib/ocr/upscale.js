// ═══════════════════════════════════════════════════════════════
// OCR 前處理 — 小字超取樣＋對比增強（OCR-SMALLTEXT，2026-09-01）
//
// 病灶：tesseract 對行高 <20px 的小字辨識率斷崖下降。手機拍整頁書
// （~1880px 寬）字常只有 10-22px 高 → 辨識不出來。
//
// 管線（引擎通用、DOM 零依賴純函式層）：
//   1. estimateLineHeight（v3 行黑密度法）：Otsu 二值化 → 每行黑像素密度
//      → 高密度連續帶 = 文字行 → 中位數帶高。光照不均穩定（v1 亮度閾值/v2
//      梯度法均被真實照片陰影擊敗，實測迭代）。
//   2. recommendScale：行高 >=30 不放大；20~29 → 2x；<20 → 3x。
//   3. enhanceForOcrPixels：灰階+min-max 對比拉伸 → 雙線性放大 → Otsu 二值化
//      （先放大後二值化：邊緣平滑、鋸齒不放大）。
//
// DOM wrapper `enhanceSmallText` 走 createImageBitmap→canvas，瀏覽器組裝
//（與 preprocess.js filterHighlighter 同模式）。
// ═══════════════════════════════════════════════════════════════

/**
 * v3 行黑密度法：估文字行高（px）。
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} w @param {number} h
 * @returns {number} 行高 px；無文字/平面回 Infinity
 */
export function estimateLineHeight(data, w, h) {
  if (!data || w <= 0 || h <= 0) return Infinity;
  // 1. 4px 網格灰階抽樣直方圖
  const sw = Math.max(1, Math.floor(w / 4)), sh = Math.max(1, Math.floor(h / 4));
  const hist = new Uint32Array(256);
  const gray = new Uint8ClampedArray(sw * sh);
  for (let sy = 0; sy < sh; sy++) {
    const y = Math.min(h - 1, sy * 4);
    const orow = y * w * 4;
    for (let sx = 0; sx < sw; sx++) {
      const x = Math.min(w - 1, sx * 4);
      const o = orow + x * 4;
      const g = Math.min(255, Math.round(data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114));
      gray[sy * sw + sx] = g;
      hist[g]++;
    }
  }
  // 2. Otsu 門檻
  const total = sw * sh;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  // 3. 每行黑密度
  const dens = new Float64Array(sh);
  for (let sy = 0; sy < sh; sy++) {
    let black = 0;
    for (let sx = 0; sx < sw; sx++) if (gray[sy * sw + sx] <= best) black++;   // <=：Otsu 完全分離雙峰時 t 可能取在文字峰上（30/245 圖 t=30）
    dens[sy] = black / sw;
  }
  // 4. 中位數 ×1.5 門檻；高密度連續帶 = 文字行
  const arr = Array.from(dens).sort((a, b) => a - b);
  const med = arr[Math.floor(sh / 2)];
  const th = Math.max(med * 1.5, 0.01);   // 下限 0.01：行黑密度 >1% 即文字行
  if (arr[Math.floor(sh * 0.95)] <= 0.003) return Infinity;   // 95 分位也近零 = 全平面
  const bands = [];
  let inBand = false, s0 = 0;
  for (let sy = 0; sy < sh; sy++) {
    const hot = dens[sy] > th;
    if (hot && !inBand) { inBand = true; s0 = sy; }
    else if (!hot && inBand) { inBand = false; bands.push((sy - s0) * 4); }
  }
  if (inBand) bands.push((sh - s0) * 4);
  // 5. 帶高 8~150px（回原尺寸）過濾偽帶（陰影大帶/噪點碎帶）；中位數
  const good = bands.filter(b => b >= 8 && b <= 150);
  if (!good.length) return Infinity;
  good.sort((a, b) => a - b);
  return good[Math.floor(good.length / 2)];
}

/** 建議放大倍率：行高 >=30 不放大；20~29 → 2x；<20 → 3x。 */
export function recommendScale(lineHeightPx) {
  if (!Number.isFinite(lineHeightPx) || lineHeightPx >= 30) return 1;
  if (lineHeightPx >= 20) return 2;
  return 3;
}

/** Otsu 自動門檻（256 桶灰階直方圖）。回 0..255。 */
export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  return best;
}

/**
 * 主純函式：RGBA → 增強後 RGBA（灰階化+對比拉伸 → 放大 → Otsu 二值化）。
 * 先放大後二值化（高解析度下 Otsu 更準、邊緣平滑）。
 */
export function enhanceForOcrPixels(img, di = null) {
  const { data, width: w, height: h } = img;
  if (!data || w <= 0 || h <= 0) return { img, scale: 1, note: 'skip-empty' };

  const lineH = estimateLineHeight(data, w, h);
  const scale = recommendScale(lineH);
  const note = `lineH≈${Number.isFinite(lineH) ? lineH.toFixed(0) : '?'}px scale=${scale}x`;

  // 1. 灰階 + min-max 對比拉伸
  const gray = new Uint8ClampedArray(w * h);
  let mn = 255, mx = 0;
  for (let i = 0; i < w * h; i++) {
    const g = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    gray[i] = g;
    if (g < mn) mn = g; if (g > mx) mx = g;
  }
  const range = Math.max(1, mx - mn);
  for (let i = 0; i < w * h; i++) gray[i] = ((gray[i] - mn) / range) * 255;

  // 2. 先放大（雙線性，灰階）
  let W = w, H = h, big;
  if (scale > 1) {
    W = Math.round(w * scale); H = Math.round(h * scale);
    big = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(h - 1, y / scale);
      const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < W; x++) {
        const sx = Math.min(w - 1, x / scale);
        const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
        const v00 = gray[y0 * w + x0], v10 = gray[y0 * w + x1], v01 = gray[y1 * w + x0], v11 = gray[y1 * w + x1];
        big[y * W + x] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      }
    }
  } else {
    big = gray;
  }

  // 3. Otsu 二值化（放大後）
  const t = otsuThreshold(big);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = big[i] > t ? 255 : 0;   // 註：v3 estimateLineHeight 用 <= 黑判定；此處 > 白。Otsu t 取「前景/背景分界」，分離雙峰時 t 落前景峰（30）→ big=245 > 30 → 白正確、big=30 > 30 false → 黑正確。一致。
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return { img: { data: out, width: W, height: H }, scale, note };
}

// ═══ DOM wrapper（瀏覽器組裝層）═══

/**
 * File/Blob → 增強後 File。小字自動放大＋Otsu 二值化。
 * @returns {Promise<{file: File|null, scale: number, note: string}>}
 *   file=null 表示不需增強（行高足夠）；呼叫端回退原圖。
 */
export async function enhanceSmallText(file) {
  if (!file) return { file: null, scale: 1, note: 'no-input' };
  const bitmap = await createImageBitmap(file);
  const w = bitmap.width, h = bitmap.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const imgData = ctx.getImageData(0, 0, w, h);
  const { img, scale, note } = enhanceForOcrPixels({ data: imgData.data, width: w, height: h });
  if (scale === 1) return { file: null, scale: 1, note };
  const cv2 = document.createElement('canvas');
  cv2.width = img.width; cv2.height = img.height;
  const ctx2 = cv2.getContext('2d');
  ctx2.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const blob = await new Promise((res, rej) => cv2.toBlob(b => b ? res(b) : rej(new Error('增強失敗')), 'image/png'));
  return { file: new File([blob], 'ocr-enhanced.png', { type: 'image/png' }), scale, note };
}
