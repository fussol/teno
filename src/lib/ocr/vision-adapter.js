// ═══════════════════════════════════════════════════════════════
// Vision AI Adapter（E′，OCR-OPTIMIZE-plan §E′）— Ollama 本機視覺 OCR
//
// desktop-only：只在「桌面 Tauri（非 Android/mobile）」列出；手機 available()=false
// → engine.js 自動回退 tesseract，使用者不會誤選到不可用引擎。
//
// 「送圖」走方案 A：前端 fetch 直連 ollama `/api/chat`，把圖 base64 塞進
// `images:["data:image/...;base64,..."]`。Tauri CSP connect-src 已含
// `http://localhost:11434`（tauri.conf.json），故不動 Rust。
//
// ═══ 2026-09-01 實測升級（V2，元首令「把可以放進去的放進去」）═══
// 實測（1884x4080 照片 + 9070 GRE 12.8GB VRAM）證明四個致命缺陷：
//   1. 原圖直送 → Vision context 爆 → 600s+ timeout 掛死（縮 1280 後 46s）
//   2. 預設 qwen3-ocr64k（18.6GB）塞不進常見 12~16GB VRAM → 永遠失敗
//   3. 大頁照片單張餵丟下半暗區內容
//   4. 光照不均暗區（亮度 62）Vision 縮圖後對比歸零讀不出
// 修法（本檔全含）：
//   - shrinkToDataUrl：送圖前 canvas 縮長邊 1280（V2 核心修正）
//   - 預設模型 qwen2.5vl:7b（實測可用；設定鍵尊重使用者覆蓋）
//   - sliceAndRecognize：H>1400 的大圖切 1280 片＋96px 重疊＋行級去重拼合
//   - enhanceDarkBand：暗區（帶 std>25 有字）min-max 對比拉伸+Otsu 二值化
//     — 對比 preprocess.js 手法，DOM canvas 實作
// ═══════════════════════════════════════════════════════════════

/** 可注入組態讀取（harness 覆蓋；預設走 db.js getSetting）— 避免 test seam 污染 db import */
let _cfgOverride = null;

/**
 * 設定測試組態覆蓋（勿在正式使用中呼叫）。
 * @template T
 * @param {{url?: string, model?: string}|null} cfg
 */
export function _setVisionConfig(cfg) { _cfgOverride = cfg; }

/** 解析組態（含 fallback）。 @returns {Promise<{url: string, model: string}>} */
async function resolveConfig() {
  if (_cfgOverride) {
    return {
      url: _cfgOverride.url || 'http://localhost:11434',
      model: _cfgOverride.model || 'qwen2.5vl:7b',
    };
  }
  let getSetting = async () => null;
  try {
    const m = await import('../db.js');
    if (typeof m.getSetting === 'function') getSetting = m.getSetting;
  } catch (_) { /* 非 db 環境（node harness）→ 走 fallback */ }
  const url = (await getSetting('ollamaUrl')) || 'http://localhost:11434';
  // V2：預設 qwen2.5vl:7b（實測 12.8GB VRAM 可跑、46s/頁）。
  // 舊預設 qwen3-ocr64k（18.6GB）在常見消費卡上必然 OOM→CPU 卸載掛死；
  // 使用者設定 ocrVisionModel 明確覆蓋時尊重之。
  const model = (await getSetting('ocrVisionModel')) || 'qwen2.5vl:7b';
  return { url, model };
}

/** 可注入 fetch 實作（harness 替換；預設 global fetch） */
let _fetchImpl = null;
export function _setVisionFetch(fn) { _fetchImpl = fn; }
function doFetch(input, init) {
  return (_fetchImpl || globalThis.fetch)(input, init);
}

/**
 * 桌面 Tauri 環境偵測（非 Android/mobile）。node(harness) 無 globalThis.window
 * 或 navigator → 回 false，不 throw。
 * @returns {boolean}
 */
export function isDesktopEnv() {
  try {
    const ua = globalThis.navigator?.userAgent || '';
    if (/Android|Mobi|iPhone|iPad|iPod/i.test(ua)) return false;
    return !!(globalThis.window && typeof globalThis.window.__TAURI__?.core === 'object');
  } catch (_) {
    return false;
  }
}

/** Uint8Array → base64（node 與瀏覽器皆走 global btoa）。純函式供 harness。 */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * File/Blob → base64 data URL。純函式（僅依 file.arrayBuffer + type）。
 * @param {File|Blob|{arrayBuffer:Function, type?:string}} file
 * @returns {Promise<string>}  e.g. data:image/png;base64,xxxxx
 */
export async function fileToDataUrl(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Vision OCR: 無效影像輸入');
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const mime = file.type || 'image/png';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

// ═══ V2：送圖前縮圖（掛死→46s 的核心修正）═══

/** Vision 甜蜜區長邊上限（實測 4096 context 下的安全值） */
export const VISION_MAX_DIM = 1280;

/** 大圖切片門檻：高超過此值走切片拼合（單張縮圖會讓小字過小） */
export const SLICE_TRIGGER_H = 1400;

/**
 * File → ImageBitmap 尺寸量測（不觸發辨識）。純組裝層。
 * @returns {Promise<{width:number, height:number, bitmap: ImageBitmap}>}
 */
async function loadBitmap(file) {
  const bitmap = await createImageBitmap(file);
  return { width: bitmap.width, height: bitmap.height, bitmap };
}

/**
 * 縮圖：bitmap → data URL（長邊 <= VISION_MAX_DIM）。已小於則原樣（PNG 無損轉存）。
 * canvas drawImage 縮放質量優於 CSS/canvas 一步大縮。
 * @returns {Promise<string>} data URL（image/jpeg quality .92 — b64 體積減半、Vision 無感差）
 */
export async function shrinkToDataUrl(bitmap, w, h) {
  const scale = Math.min(1, VISION_MAX_DIM / Math.max(w, h));
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, W, H);
  return new Promise((res, rej) => cv.toBlob(b => b ? res(blobToDataUrl(b)) : rej(new Error('縮圖失敗')), 'image/jpeg', 0.92));
}

/** Blob → data URL */
function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('Blob 讀取失敗'));
    fr.readAsDataURL(blob);
  });
}

// ═══ V2：暗區增強（實測 y>2600 亮度 62 區挖出隱藏題組）═══

/**
 * 暗帶偵測：逐 200px 帶掃灰階亮度/標準差，std>25 視為有字帶。
 * @returns {{bands: Array<{y1:number,y2:number}>, minMean:number}} 純函式
 */
export function detectDarkTextBands(gray, w, h) {
  const bands = [];
  let sum = 0, sum2 = 0, minMean = 255;
  const BAND = 200;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    sum = 0; sum2 = 0;
    const yEnd = Math.min(h, y0 + BAND);
    let n = 0;
    for (let y = y0; y < yEnd; y += 2) {
      // 行交錯起點（y%16 輪轉）：抗規律紋理混疊 — 等距抽樣在規律網格
      // （印刷字網）下可能全撞同相位（實測合成 %32 紋理 std 腰斬）
      const xStart = y % 16;
      for (let x = xStart; x < w; x += 16) {
        const g = gray[y * w + x];
        sum += g; sum2 += g * g; n++;
      }
    }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    if (mean < minMean) minMean = mean;
    if (std > 25) bands.push({ y1: y0, y2: yEnd });   // 有字帶
  }
  return { bands, minMean };
}

/**
 * 暗帶增強：min-max 對比拉伸 + Otsu 二值化（等效 upscale.js v3 手法）。
 * canvas 版：讀 bitmap 灰階 → 增強 → data URL。
 * @param {ImageBitmap} bitmap
 * @param {number} y1 帶起（原圖座標） @param {number} y2 帶迄
 * @returns {Promise<string>} 增強帶的 data URL
 */
export async function enhanceDarkBand(bitmap, w, h, y1, y2) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = y2 - y1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, -y1);
  const imgData = ctx.getImageData(0, 0, w, y2 - y1);
  const d = imgData.data;
  const n = w * (y2 - y1);
  const gray = new Uint8ClampedArray(n);
  let mn = 255, mx = 0;
  for (let i = 0; i < n; i++) {
    const g = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    gray[i] = g;
    if (g < mn) mn = g; if (g > mx) mx = g;
  }
  if (mx - mn < 8) throw new Error('暗帶無對比');
  // min-max 拉伸
  const range = Math.max(1, mx - mn);
  for (let i = 0; i < n; i++) gray[i] = ((gray[i] - mn) / range) * 255;
  // Otsu（256 桶）
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > bestVar) { bestVar = v; best = t; }
  }
  // 二值化寫回 RGBA
  for (let i = 0; i < n; i++) {
    const v = gray[i] > best ? 255 : 0;
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  // 縮到 Vision 甜蜜區
  const out = document.createElement('canvas');
  const scale = Math.min(1, VISION_MAX_DIM / Math.max(cv.width, cv.height));
  out.width = Math.round(cv.width * scale); out.height = Math.round(cv.height * scale);
  const ctx2 = out.getContext('2d');
  ctx2.imageSmoothingQuality = 'high';
  ctx2.drawImage(cv, 0, 0, out.width, out.height);
  return new Promise((res, rej) => out.toBlob(b => b ? res(blobToDataUrl(b)) : rej(new Error('暗帶轉存失敗')), 'image/jpeg', 0.92));
}

// ═══ V2：辨識主流程 ═══

/** 單張 data URL → ollama chat → 文字（不含 parse 包裝） */
async function chatOnce(url, model, dataUrl, prompt) {
  const res = await doFetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt, images: [dataUrl] }],
      stream: false,
    }),
  });
  if (!res?.ok) throw new Error(`Vision OCR: ollama 回傳 HTTP ${res?.status ?? '?'}`);
  const data = await res.json();
  return String((data?.message?.content) || data?.response || '').trim();
}

/** 預設提取 prompt（V2：中英混排頁面支援 — 實測考卷含「四、篇章結構」） */
const DEFAULT_PROMPT = 'Extract ALL text visible in this image (English and Chinese). Output ONLY the text content, preserving reading order and line structure. No explanations, no markdown.';

/**
 * 解析 ollama /api/chat 回應 → OcrResult（typedef §engine）。純函式供 harness。
 */
export function parseChatToOcrResult(data, fallbackConf = 1) {
  const raw = (data?.message?.content) || data?.response || data?.text || '';
  const text = String(raw || '').trim();
  if (!text) return { text: '', blocks: [], confidence: 0 };
  return {
    text,
    blocks: [{ text, confidence: fallbackConf, bbox: [0, 0, 0, 0] }],
    confidence: fallbackConf,
  };
}

/** @returns {Promise<boolean>} 能力偵測（不 throw）：desktop + ollama 可連 + vision model 存在 */
async function available() {
  if (!isDesktopEnv()) return false;
  try {
    const { url, model } = await resolveConfig();
    if (!url) return false;
    const tagsRes = await doFetch(`${url}/api/tags`);
    if (!tagsRes?.ok) return false;
    const tags = await tagsRes.json();
    const names = (Array.isArray(tags?.models) ? tags.models : []).map(m => m.name || m.model || '');
    const base = String(model).split(':')[0];
    return names.some(n => String(n).split(':')[0] === base);
  } catch (_) {
    return false;
  }
}

/**
 * V2 行級去重拼合（純函式供 harness）：相鄰片重疊區的重複行移除。
 * @param {string[]} texts 每片文字
 * @param {number} tailLines 比對上片尾行數（重疊 96px ≈ 2~3 行，取 3）
 * @returns {string} 拼合全文
 */
export function mergeSliceTexts(texts, tailLines = 3) {
  const out = [];
  let prevTail = new Set();
  for (const text of texts) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const dedup = [];
    let skipping = true;
    for (const l of lines) {
      if (skipping && prevTail.has(l)) continue;   // 片頭連續重複（重疊區）跳過
      skipping = false;
      dedup.push(l);
    }
    prevTail = new Set(lines.slice(-tailLines));
    out.push(...dedup);
  }
  return out.join('\n');
}

/**
 * 辨識圖片（V2 主流程）：
 *   1. 量尺寸；H <= SLICE_TRIGGER_H → 單張縮圖直送（46s 實測路徑）
 *   2. H > SLICE_TRIGGER_H → 切 1280 片 + 96px 重疊逐片辨識 + 行級去重拼合
 *      ＋ 暗帶偵測：整體 minMean < 90（有暗區）→ 暗帶增強片補辨識
 * @param {File|Blob|{arrayBuffer:Function, type?:string}} file
 * @param {{prompt?: string}} [opts]
 * @returns {Promise<import('./engine.js').OcrResult>}
 */
async function recognize(file, opts = {}) {
  if (!file) throw new Error('Vision OCR: 無效影像輸入');
  const { url, model } = await resolveConfig();
  if (!url) throw new Error('Vision OCR: ollama URL 未設定');
  const prompt = opts.prompt || DEFAULT_PROMPT;

  const { width: w, height: h, bitmap } = await loadBitmap(file);
  let fullText = '';

  if (h <= SLICE_TRIGGER_H) {
    // ── 單張路徑：縮圖直送 ──
    const dataUrl = await shrinkToDataUrl(bitmap, w, h);
    fullText = await chatOnce(url, model, dataUrl, prompt);
  } else {
    // ── 切片路徑（大頁）：1280 片 + 96 重疊 ──
    const SLICE_H = 1280, OVERLAP = 96;
    const pieceTexts = [];
    // 灰階抽樣（暗帶偵測用）
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const grayData = ctx.getImageData(0, 0, w, h).data;
    const gw = w, gh = h;
    const grayArr = new Uint8ClampedArray(gw * gh);
    for (let i = 0; i < gw * gh; i++) grayArr[i] = grayData[i * 4] * 0.299 + grayData[i * 4 + 1] * 0.587 + grayData[i * 4 + 2] * 0.114;
    const { bands, minMean } = detectDarkTextBands(grayArr, gw, gh);
    const hasDarkText = minMean < 90 && bands.length > 0;

    let y = 0, idx = 0;
    while (y < h) {
      const y2 = Math.min(h, y + SLICE_H);
      // 片裁切 → 縮圖 → 辨識
      const pc = document.createElement('canvas');
      pc.width = w; pc.height = y2 - y;
      const pctx = pc.getContext('2d');
      pctx.drawImage(bitmap, 0, -y);
      const pieceUrl = await canvasToDataUrl(pc);
      pieceTexts.push(await chatOnce(url, model, pieceUrl, prompt));
      if (hasDarkText && y >= bands[0].y1 && y < bands[bands.length - 1].y2) {
        // 本片範圍內的暗帶 → 增強重辨（增強版只補，不覆蓋原片）
        for (const b of bands) {
          if (b.y1 >= y && b.y2 <= y2 && b.y2 - b.y1 >= 200) {
            try {
              const enhUrl = await enhanceDarkBand(bitmap, w, h, b.y1, b.y2);
              const enhText = await chatOnce(url, model, enhUrl, prompt);
              if (enhText && enhText.length > 20) {
                pieceTexts[pieceTexts.length - 1] = pieceTexts[pieceTexts.length - 1] + '\n' + enhText;
              }
            } catch (_) { /* 暗帶增強失敗不擋主流程 */ }
          }
        }
      }
      if (y2 >= h) break;
      y = y2 - OVERLAP;
      idx++;
    }
    fullText = mergeSliceTexts(pieceTexts);
  }

  bitmap.close?.();
  if (!fullText) return { text: '', blocks: [], confidence: 0 };
  return {
    text: fullText,
    blocks: [{ text: fullText, confidence: 1, bbox: [0, 0, 0, 0] }],
    confidence: 1,
  };
}

/** canvas → data URL（縮到 Vision 甜蜜區） */
async function canvasToDataUrl(cv) {
  const scale = Math.min(1, VISION_MAX_DIM / Math.max(cv.width, cv.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cv.width * scale));
  out.height = Math.max(1, Math.round(cv.height * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cv, 0, 0, out.width, out.height);
  return new Promise((res, rej) => out.toBlob(b => b ? res(blobToDataUrl(b)) : rej(new Error('轉存失敗')), 'image/jpeg', 0.92));
}

export default { id: 'vision-ai', available, recognize };
