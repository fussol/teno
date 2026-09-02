// ═══════════════════════════════════════════════════════════════
// OCR 前處理 — 實體螢光筆 HSV 顏色過濾（OCR-OPTIMIZE-plan A 段，A-1′）
//
// 需求（總統裁示 2026-08-30）：highlight 模式「只辨識被實體螢光筆
// 劃線標記的文字」，其餘背景/內文忽略。路線一：拍照 → HSV 顏色過濾
// 找出螢光筆（黃/綠/粉）mask → 投影掃描連通區 → 裁出螢光 ROI →
// 把 ROI 併成新圖餵 OCR 引擎（對任何引擎通用，front of engine.recognize）。
//
// 本檔＝「純函式層」（零 DOM／零 canvas），全部邏輯可被 node harness
// 無頭測試；DOM wrapper `filterHighlighter` 走依賴注入，只在瀏覽器組裝。
// 匯入安全：頂層不觸發任何瀏覽器 API（對齊 tesseract-adapter.js 模式）。
// ═══════════════════════════════════════════════════════════════

/**
 * 內建螢光筆色卡（常見實體螢光筆色調）＋各自 HSV 可調範圍。
 * hue 單位度 0..360（wrap-aware：lo>hi 表迴繞區，如 pink 350~20）。
 * minSat/minVal 0..1 — 用飽和/明度下限排除灰白背景與泛黃紙張。
 */
export const HIGHLIGHTER_COLORS = {
  yellow: { name: '黃', hue: [30, 62], minSat: 0.30, minVal: 0.35 },
  green:  { name: '綠', hue: [62, 140], minSat: 0.28, minVal: 0.30 },
  pink:   { name: '粉', hue: [340, 20], minSat: 0.26, minVal: 0.32 }, // 迴繞
};

/** 顏色鍵白名單（供 UI 選單 + 設定還原校驗） */
export const HIGHLIGHTER_KEYS = Object.keys(HIGHLIGHTER_COLORS);

/** 依鍵取色規格；非法鍵回 null（供還原校驗） */
export function resolveColor(key) {
  return HIGHLIGHTER_COLORS[key] || null;
}

/**
 * RGB(0..255) → HSV。h 0..360，s/v 0..1。純函式（供 harness 精確斷言）。
 * 標準公式（與 OpenCV cvtColor 同構，除 h 換算）。
 */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

/** hue 是否落在 [lo,hi]，支援迴繞（lo>hi → h>=lo || h<=hi） */
export function hueInRange(h, lo, hi) {
  if (lo <= hi) return h >= lo && h <= hi;
  return h >= lo || h <= hi;
}

/**
 * 單像素是否為「指定螢光筆色」。
 * @param {{h:number,s:number,v:number}} hsv
 * @param {{hue:[number,number],minSat?:number,minVal?:number}} spec
 * @returns {boolean}
 */
export function isHighlightHsv(hsv, spec) {
  if (!spec) return false;
  const [lo, hi] = spec.hue;
  if (!hueInRange(hsv.h, lo, hi)) return false;
  if (typeof spec.minSat === 'number' && hsv.s < spec.minSat) return false;
  if (typeof spec.minVal === 'number' && hsv.v < spec.minVal) return false;
  return true;
}

/**
 * 對像素陣列建 HSV mask。
 * @param {{data:Uint8ClampedArray|number[], w:number, h:number}} img  RGBA 平面
 * @param {object} spec  色規格（resolveColor 產出）
 * @returns {{count:number, mask:Uint8Array}} mask[i]=1 表該像素為螢光色
 */
export function buildMask(img, spec) {
  const { data } = img;
  // 同時支援 canvas.getImageData 標準形（{width,height}）與純樸 ({w,h})
  const w = img.width ?? img.w;
  const h = img.height ?? img.h;
  if (!w || !h) throw new Error('[ocr] buildMask: 無效影像尺寸');
  const n = w * h;
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (a === 0) continue;                       // 透明跳過
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    if (isHighlightHsv(hsv, spec)) { mask[i] = 1; count++; }
  }
  return { count, mask };
}

/**
 * 投影式連通區掃描：先找「有螢光像素的行」x-band，再對每個 x-band
 * 找「有螢光像素的列」y-band → 得 ROI 矩形。附 gap 合併（把間隙小於
 * merge 的分散區域併成一塊，降低單字被螢光筆畫分造成的碎片）。
 *
 * @param {Uint8Array} mask  buildMask 輸出（mask[i]=1）
 * @param {number} w
 * @param {number} h
 * @param {{mergeGap?:number}} [opts]
 * @returns {{x,y,w,h}[]} 螢光 ROI（原圖座標系）
 */
export function findRegions(mask, w, h, opts = {}) {
  const gap = opts.mergeGap ?? 8;
  const boxes = [];
  // ── x 投影：哪些 column 有螢光像素 ──
  const colOcc = new Array(w).fill(false);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { colOcc[x] = true; }
    }
  }
  // ── 分 x-band（含 gap 合併）──
  const xBands = scanBands(colOcc, w, gap);
  for (const [x0, x1] of xBands) {
    // ── 在 x-band 內做 y 投影 ──
    const rowOcc = new Array(h).fill(false);
    for (let y = 0; y < h; y++) {
      for (let x = x0; x <= x1; x++) {
        if (mask[y * w + x]) { rowOcc[y] = true; break; }
      }
    }
    const yBands = scanBands(rowOcc, h, gap);
    for (const [y0, y1] of yBands) {
      // 重新精算此 ROI 的實際 min/max x（band 可能含空白 row-gap 已併）
      let minX = x1, maxX = x0;
      let found = false;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (mask[y * w + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            found = true;
          }
        }
      }
      if (found) boxes.push({ x: minX, y: y0, w: maxX - minX + 1, h: y1 - y0 + 1 });
    }
  }
  return boxes;
}

/** 對一維 boolean array 掃出 1 的連續段，gap<merge 者併段。回 [start,end][] */
function scanBands(occ, len, merge) {
  const bands = [];
  let start = -1, last = -1;
  for (let i = 0; i < len; i++) {
    if (occ[i]) { if (start === -1) start = i; last = i; }
    else if (start !== -1) {
      let gapLen = 0, j = i;
      while (j < len && !occ[j]) { gapLen++; j++; }
      if (gapLen > merge) { bands.push([start, last]); start = -1; }
      i = j - 1;               // 跳過整個 gap（不論切不切），免重掃＋免尾隙吞段
    }
  }
  if (start !== -1) bands.push([start, last]);   // 段尾=最後真像素，不吞尾隙
  return bands;
}

/**
 * 由 ROI boxes + 原圖尺寸，計算「併圖」layout。
 * 各 ROI 從原圖 (x,y,w,h) 依序並排到一張新畫布（高度取最高）。
 * @param {{x,y,w,h}[]} boxes
 * @param {number} imgW 原圖寬
 * @param {number} imgH 原圖高
 * @returns {{outW:number,outH:number,draws:{sx,sy,sw,sh}[]}}
 *          outW/outH=併圖目標尺寸；draws[i].sx.. = 原圖擷取範圍
 */
export function computeLayout(boxes, imgW, imgH, opts = {}) {
  if (!boxes.length) return { outW: 0, outH: 0, draws: [] };
  // ROI 放大（2026-09-01 元首令 v2）：螢光區局部放大再辨識 — 螢光帶通常只涵蓋
  // 一兩行字（ROI 高度小），原尺寸小字辨識差。每 ROI 目標寬 >= TARGET_W
  // （寬小就放大，scale = TARGET_W/sw，上限 3x 防大 ROI 爆記憶體）。
  // 回傳 draws 帶 scale，呼叫端 drawImage 以 (dx,0,scale*sw,scale*sh) 落地。
  const TARGET_W = opts.targetW || 600;
  const MAX_SCALE = opts.maxScale || 3;
  let outW = 0, outH = 0;
  const draws = [];
  for (const b of boxes) {
    const sx = Math.max(0, Math.min(b.x, imgW));
    const sy = Math.max(0, Math.min(b.y, imgH));
    // 來源矩形完全在圖片外 → 跳過（避免 1px 幻影 draw）；findRegions 產出必在界內，
    // 此為防禦層。
    if (sx >= imgW || sy >= imgH) continue;
    const sw = Math.max(1, Math.min(b.w, imgW - sx));
    const sh = Math.max(1, Math.min(b.h, imgH - sy));
    const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_W / sw));
    draws.push({ sx, sy, sw, sh, scale });
    outW += Math.round(sw * scale);
    outH = Math.max(outH, Math.round(sh * scale));
  }
  return { outW, outH, draws };
}

/**
 * 端到端前處理（DOM wrapper，依賴注入）：讀 File → 解碼成 ImageData →
 * buildMask + findRegions → 併圖 → toBlob → 新 File。
 *
 * 不變式（計畫 A.5）：mask 全空（count=0）→ 回 { file: null, count, boxes: [] }，
 * 呼叫端（ocr.js）保留原圖 → 精準重現「未偵測到螢光區域＝整張辨識」。
 *
 * @param {File|Blob} file       原圖（OCR cropFile）
 * @param {object} spec          色規格
 * @param {object} [deps]        注入 createImageBitmap / createCanvas / decodeImg
 * @returns {Promise<{file:File|null,count:number,boxes:{x,y,w,h}[]}>}
 */
export async function filterHighlighter(file, spec, deps = {}) {
  const {
    createImageBitmap: cib = globalThis.createImageBitmap,
    createCanvas = () => document.createElement('canvas'),
    decodeImg = async (f) => {
      const bmp = await cib(f);
      const cv = createCanvas(bmp.width, bmp.height);
      cv.width = bmp.width; cv.height = bmp.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const imgData = ctx.getImageData(0, 0, cv.width, cv.height);
      if (bmp.close) try { bmp.close(); } catch (_) {}
      return imgData;
    },
  } = deps;

  if (!file) throw new Error('OCR: 無影像輸入');
  const img = await decodeImg(file);
  const { count, mask } = buildMask(img, spec);
  if (!count) return { file: null, count, boxes: [] };

  const boxes = findRegions(mask, img.width, img.height);
  const { outW, outH, draws } = computeLayout(boxes, img.width, img.height);
  const cv = createCanvas(outW, outH);
  cv.width = outW; cv.height = outH;
  const ctx = cv.getContext('2d');
  // ImageData 不是合法 CanvasImageSource（drawImage 只吃 Image/Video/Canvas/
  // ImageBitmap/OffscreenCanvas/VideoFrame）——真瀏覽器直接 drawImage(ImageData)
  // 必 throw。先 putImageData 落地成 canvas 當 source，再併圖。
  const srcCv = createCanvas(img.width, img.height);
  srcCv.width = img.width; srcCv.height = img.height;
  srcCv.getContext('2d').putImageData(img, 0, 0);
  let dx = 0;
  for (const d of draws) {
    // v2：ROI 放大落地（draws.scale；1 = 原尺寸行為不變）
    const dw = Math.round(d.sw * d.scale), dh = Math.round(d.sh * d.scale);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCv, d.sx, d.sy, d.sw, d.sh, dx, 0, dw, dh);
    dx += dw;
  }
  const blob = await new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('螢光區域併圖失敗'))), 'image/png');
  });
  return { file: new File([blob], 'ocr-highlight.png', { type: 'image/png' }), count, boxes };
}