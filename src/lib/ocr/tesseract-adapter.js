// ═══════════════════════════════════════════════════════════════
// Tesseract Adapter (P1, 計畫 v1.3 §6.6 Adapter A)
//
// tesseract.js WASM，完全離線：worker/core/lang 三路徑全指向
// public/assets/ocr/（建置期 ocr:assets 打包，執行期零下載）。
//
// 載入方式（一手查證 tesseract.js@7.0.0）：
//   - 套件 main = src/index.js（CJS）＋ exports undefined → bundler bare
//     import 在 optimizeDeps.exclude 下必炸（vite 對策 = 靜態 ESM dist）。
//   - 因此本檔不用 bare `import 'tesseract.js'`，改以 /assets/ocr/ 靜態
//     URL 動態 import 官方 ESM dist（default export = 完整 Tesseract API）。
//   - worker 內部核心由 corePath 目錄 + wasm-feature-detect 選變體
//     （src/worker-script/browser/getCore.js 一手查證，lstmOnly=1 → 三個
//     *-lstm.wasm.js 變體已全數隨附）。
// 本檔只在瀏覽器執行（engine.js lazy factory），node 只准靜態檢查。
// ═══════════════════════════════════════════════════════════════

/**
 * PSM 頁面分割模式（tesseract.js 官方 API 文件 PSM 枚舉子集）。
 * 3=AUTO 整頁自動；6=SINGLE_BLOCK 單一文字塊（框選/螢光筆）；
 * 11=SPARSE_TEXT 稀疏文字。
 * 參考：naptha/tesseract.js docs/api.md＋index.d.ts PSM enum。
 */
export const PSM = { AUTO: 3, SINGLE_BLOCK: 6, SPARSE_TEXT: 11 };

/**
 * 依情境選 PSM（OCR3）：有框選或 highlight 聚焦→6；整頁 scan→3。
 * @param {{hasCrop:boolean, mode:string}} a
 */
export function selectPsm(a) {
  if (a?.hasCrop) return PSM.SINGLE_BLOCK;
  if (a?.mode === 'highlight') return PSM.SINGLE_BLOCK;
  return PSM.AUTO;
}

/** @type {number|null} worker 已設 PSM（追蹤，變化才 setParameters） */
let _workerPsm = null;
/** @type {number|null} worker 已設 DPI */
let _workerDpi = null;
/** @type {Promise<any>|null} window.Tesseract API（UMD 注入） */
let _apiP = null;
/** @type {any} worker 單例（tesseract.js worker） */
let _workerP = null;
/** @type {string} 目前 worker 已載入語言（逗号分隔），切換語言才重建 */
let _workerLangs = '';

function api() {
  if (!_apiP) {
    // 載入方式（兩條實測死路的對策）：
    //   1) bare `import 'tesseract.js'`：main=CJS＋exports undefined，
    //      optimizeDeps.exclude 下 vite 直出 CJS → 瀏覽器炸。
    //   2) import('/assets/ocr/*.esm.min.js')：public/ JS 被 vite
    //      import-analysis 附加 ?import → dev 500（@vite-ignore/拼接無效）。
    // 對策：注入官方 UMD dist（<script src> 同網域，script-src 'self' 兼容
    // Tauri 生產 CSP；blob: 方案會被 CSP 擋故不採），掛 window.Tesseract。
    _apiP = new Promise((resolve, reject) => {
      if (window.Tesseract?.createWorker) return resolve(window.Tesseract);
      const sc = document.createElement('script');
      sc.src = new URL('assets/ocr/tesseract.min.js', location.origin).href;
      sc.onload = () => window.Tesseract?.createWorker
        ? resolve(window.Tesseract)
        : reject(new Error('OCR 資產載入但 Tesseract API 缺失'));
      sc.onerror = () => reject(new Error('OCR 資產載入失敗（tesseract.min.js）'));
      document.head.appendChild(sc);
    });
  }
  return _apiP;
}

/**
 * worker 單例：同語言重用好；語言集變化 → terminate 重建。
 * @param {string[]} langTags
 */
async function getWorker(langTags) {
  const langs = (langTags && langTags.length ? langTags : ['eng']).join('+');
  if (_workerP && _workerLangs === langs) return _workerP;
  const prev = _workerP;
  _workerLangs = langs;
  _workerP = (async () => {
    const Tesseract = await api();
    const worker = await Tesseract.createWorker(langs.split('+'), 1, {
      workerPath: '/assets/ocr/worker.min.js',
      corePath: '/assets/ocr/core',
      langPath: '/assets/ocr/lang',
      gzip: true,
      // 防範性：離線部署不允許任何遠端下載
      cacheMethod: 'none',
    });
    return worker;
  })();
  if (prev) {
    try { (await prev).terminate(); } catch (_) { /* 舊 worker 已死 */ }
  }
  return _workerP;
}

/** tesseract block bbox {x0,y0,x1,y1} → [x, y, w, h]（typedef §3） */
function toBBox(b) {
  return [b.x0, b.y0, (b.x1 || b.x0) - b.x0, (b.y1 || b.y0) - b.y0];
}

/** block confidence 0..100 → 0..1，缺值回 null */
function normConf(c) {
  return (typeof c === 'number' && Number.isFinite(c)) ? Math.max(0, Math.min(1, c / 100)) : null;
}

/**
 * @returns {Promise<boolean>} 能力偵測（不 throw）：Web Worker＋WASM＋資產路由環境
 */
async function available() {
  return typeof Worker !== 'undefined'
    && typeof WebAssembly === 'object'
    && typeof document !== 'undefined';  // /assets/ 靜態路由需 origin
}

/**
 * 辨識圖片。失敗一律 reject Error（訊息供 UI）。
 * @param {File|Blob} file
 * @param {{langTags?: string[], psm?: number, dpi?: number}} [opts]
 *   psm: tesseract PSM（3/6/11；OCR3 情境選擇）；dpi: user_defined_dpi
 *   （官方建議≥300；手機拍照常無內嵌 DPI，預設 300）。v7 setParameters
 *   若不存在/改名 → try/catch 回退無參辨識（零炸）。
 * @returns {Promise<import('./engine.js').OcrResult>}
 */
async function recognize(file, opts = {}) {
  if (!file) throw new Error('OCR: 無影像輸入');
  const worker = await getWorker(opts.langTags);
  const wantPsm = Number.isFinite(opts.psm) ? opts.psm : null;
  const wantDpi = Number.isFinite(opts.dpi) ? opts.dpi : 300;
  try {
    const params = {};
    if (wantPsm !== null && wantPsm !== _workerPsm) params.tessedit_pageseg_mode = String(wantPsm);
    if (wantDpi !== _workerDpi) params.user_defined_dpi = String(wantDpi);
    if (Object.keys(params).length && typeof worker.setParameters === 'function') {
      await worker.setParameters(params);
      if (params.tessedit_pageseg_mode) _workerPsm = wantPsm;
      if (params.user_defined_dpi) _workerDpi = wantDpi;
    }
  } catch (_) { /* 參數透傳失敗 → 回退預設辨識，不炸 */ }
  // blocks 輸出供 bbox/區塊信心（P1 僅留存，UI 只消費 text+confidence）
  const { data } = await worker.recognize(file, {}, { text: true, blocks: true });
  const rawBlocks = Array.isArray(data.blocks) ? data.blocks : [];
  const blocks = rawBlocks.map(b => ({
    text: b.text || '',
    confidence: normConf(b.confidence) ?? (typeof data.confidence === 'number' ? normConf(data.confidence) ?? 0 : 0),
    bbox: b.bbox ? toBBox(b.bbox) : [0, 0, 0, 0],
  }));
  const conf = normConf(data.confidence) ?? 0;
  return {
    text: (data.text || '').trim(),
    blocks,
    confidence: conf,
  };
}

export default { id: 'tesseract', available, recognize };
