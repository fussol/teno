// ═══════════════════════════════════════════════════════════════
// OCR Engine 註冊表 — 介面抽象＋可插拔 Adapter（計畫 v1.3 §3/§6.6）
//
// 統一 OcrEngine 介面（JSDoc typedef，純 JS 專案）＋ registerEngine/
// getActiveEngine。設定讀取 getSetting('ocr_engine')（db.js 原生，不经
// store 避免循環依賴），任何異常回退 'tesseract'。
// 引擎切換＝無痛：getActiveEngine 每次現讀 setting，下次辨識即用新 adapter。
// ═══════════════════════════════════════════════════════════════
import { getSetting } from '../db.js';

/**
 * @typedef {Object} OcrBlock   一個辨識出的文字塊
 * @property {string} text      塊內文字（未過濾）
 * @property {number} confidence 0..1 區塊信心分數
 * @property {number[]} bbox     [x, y, w, h]（P3 才消費，P1 僅留存）
 */
/**
 * @typedef {Object} OcrResult
 * @property {string} text        全文（行以 \n 串接）
 * @property {OcrBlock[]} blocks  區塊清單
 * @property {number} confidence  整體信心 0..1（各塊加權平均）
 */
/**
 * @typedef {Object} OcrEngine
 * @property {string} id                        如 'tesseract' | 'paddle'
 * @property {() => Promise<boolean>} available 環境能力偵測（不throw）
 * @property {(file: File, opts?: {langTags?: string[]}) => Promise<OcrResult>} recognize
 *            辨識失敗一律 reject Error（訊息供 UI 呈現）；不自定義錯誤碼
 */

const DEFAULT_ENGINE_ID = 'tesseract';

/** @type {Map<string, () => Promise<OcrEngine>>} */
const registry = new Map();

/**
 * 註冊（或覆蓋）引擎。factory 惰性動態 import，模組載入零成本。
 * @param {string} id
 * @param {() => Promise<OcrEngine>} factory
 */
export function registerEngine(id, factory) {
  if (typeof id !== 'string' || !id) throw new Error('[ocr] registerEngine: id 需非空字串');
  if (typeof factory !== 'function') throw new Error('[ocr] registerEngine: factory 需為函式');
  registry.set(id, factory);
}

/** 已註冊引擎清單（供 UI 選單動態生成） @returns {{id: string}[]} */
export function listEngines() {
  return [...registry.keys()].map(id => ({ id }));
}

export function hasEngine(id) { return registry.has(id); }

/**
 * 解析啟用引擎 id（含回退），可注入 getSetting 實作供單元斷言。
 * 回退鏈：setting 讀取拋錯/值非法/未註冊/目標 unavailable → tesseract。
 * @param {(key: string) => Promise<any>} getSettingImpl
 * @param {() => Promise<OcrEngine>} [defaultFactory] 僅測試用覆蓋
 * @returns {Promise<{id: string, engine: OcrEngine}>}
 */
export async function _getActiveEngine(getSettingImpl, defaultFactory) {
  let id = DEFAULT_ENGINE_ID;
  try {
    const raw = await getSettingImpl('ocr_engine');
    if (typeof raw === 'string' && registry.has(raw)) id = raw;
  } catch (_) { /* setting 讀不到 → 預設 tesseract */ }

  const factory = registry.get(id) || (id === DEFAULT_ENGINE_ID ? defaultFactory : null);
  if (!factory) {
    // 未註冊 id 已被上面 registry.has 擋掉；此處理論不可達，保險回退
    return _loadDefault(defaultFactory);
  }
  let engine;
  try {
    engine = await factory();
  } catch (e) {
    if (id === DEFAULT_ENGINE_ID) throw e;
    return _loadDefault(defaultFactory);
  }
  let ok = false;
  try { ok = await engine.available(); } catch (_) { ok = false; }
  if (!ok) {
    if (id === DEFAULT_ENGINE_ID) {
      throw new Error(`[ocr] 預設引擎 '${id}' 在此環境不可用`);
    }
    return _loadDefault(defaultFactory);
  }
  return { id, engine };
}

async function _loadDefault(defaultFactory) {
  const f = registry.get(DEFAULT_ENGINE_ID) || defaultFactory;
  if (!f) throw new Error(`[ocr] 預設引擎 '${DEFAULT_ENGINE_ID}' 未註冊`);
  const engine = await f();
  let ok = false;
  try { ok = await engine.available(); } catch (_) { ok = false; }
  if (!ok) throw new Error(`[ocr] 預設引擎 '${DEFAULT_ENGINE_ID}' 在此環境不可用`);
  return { id: DEFAULT_ENGINE_ID, engine };
}

/**
 * 取得當前啟用引擎（現讀 ocr_engine setting → 無痛切換）。
 * @returns {Promise<{id: string, engine: OcrEngine}>}
 */
export function getActiveEngine() {
  return _getActiveEngine(getSetting);
}

// ── 內建引擎註冊（lazy factory；模組載入不觸發 adapter import）──
registerEngine('tesseract', async () => (await import('./tesseract-adapter.js')).default);
registerEngine('paddle', async () => (await import('./paddle-adapter.js')).default);
// E′ Vision AI（Ollama 本機視覺 OCR，desktop-only）：available() 在手機 false → 自動回退
registerEngine('vision-ai', async () => (await import('./vision-adapter.js')).default);
