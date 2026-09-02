#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// VERIFY-OCR2-VISION（E′）— Vision AI 引擎（Ollama 本機視覺 OCR）
//
// 測 E′（OCR-OPTIMIZE-plan §E′）：
//   V0 靜態釘：vision-adapter 存在＋engine.js 註冊 'vision-ai'＋ocr.js 選單桌面限定
//   V1 純函式：bytesToBase64 / fileToDataUrl 正確（base64 圖底生成）
//   V2 parseChatToOcrResult 結構：text/blocks[{text,confidence,bbox}]/confidence
//   V3 recognize()：mock fetch 送出 正確 /api/chat body（model＋images 帶 data URL）→ 回 OcrResult
//   V4 available() desktop-only：android UA → false；桌面 Tauri → 依 ollama 可連
//   V5 負控制 A：mock ollama 不可連（fetch reject/!ok）→ available()=false → 選單不出現
//   V6 負控制 B（PRE）：剝除 isDesktopEnv 的 Android 檢查 → android UA 下 available
//      仍走 ollama 判定（＝對手機誤開 vision-ai），重現「非 desktop 卻可用」原缺陷
//
// 用法: node tools/verify-ocr2-vision.mjs
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTER = path.join(ROOT, 'src/lib/ocr/vision-adapter.js');
const ENGINE = path.join(ROOT, 'src/lib/ocr/engine.js');
const OCR = path.join(ROOT, 'src/pages/ocr.js');

let failures = 0;
function check(label, got, expect) {
  const pass = JSON.stringify(got) === JSON.stringify(expect);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: got=${JSON.stringify(got)} expect=${JSON.stringify(expect)}`);
}

const VISION_URL = 'http://localhost:11434';
const VISION_MODEL = 'qwen3-ocr64k';

/** node 的 globalThis.navigator 是 getter-only → 用 defineProperty 覆寫 */
function setUA(ua) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, language: 'en' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: { __TAURI__: { core: {} } },
    configurable: true, writable: true,
  });
}
function cleanupGlobals() {
  if ('navigator' in globalThis) delete globalThis.navigator;
  if ('window' in globalThis) delete globalThis.window;
}

/** 把 vision-adapter 硬拷到 /tmp，剝除 isDesktopEnv 的 Android 段後 dynamic import（PRE 負控制） */
async function importStripped(uAOverride) {
  const src = fs.readFileSync(ADAPTER, 'utf8');
  const stripped = src.replace(/if \(\/Android\|Mobi\|iPhone\|iPad\|iPod\/i\.test\(ua\)\) return false;/, '// NEG: Android 檢查剝除（保留 default export）');
  const tmp = path.join(ROOT, `src/lib/ocr/.vision-adapter-neg-${process.pid}.mjs`);
  fs.writeFileSync(tmp, stripped);
  try {
    // 用 before-dynamic-import 設定 uA（QQ/Android→desktop 環境）
    setUA(uAOverride);
    const m = await import('file://' + tmp);
    // capture
    return { m, tmp };
  } catch (e) {
    fs.unlinkSync(tmp);
    throw e;
  }
}

async function main() {
  console.log('═══ VERIFY-OCR2-VISION E′ 驗證 ═══');

  // ── V0 靜態釘 ──
  {
    const engineSrc = fs.readFileSync(ENGINE, 'utf8');
    check('V0a engine.js 註冊 vision-ai（lazy factory）',
      /registerEngine\('vision-ai', async \(\) => \(await import\('\.\/vision-adapter\.js'\)\)\.default\)/.test(engineSrc), true);

    const ocrSrc = fs.readFileSync(OCR, 'utf8');
    check('V0b ocr.js 引擎選單有 vision-ai 桌面標示',
      /'vision-ai': 'Vision AI/.test(ocrSrc), true);

    // desktop-only 過濾邏輯存在（手機不出現）
    check('V0c ocr.js 有 desktop-only 過濾（含 isDesktopEnv 判斷或等效）',
      /isDesktop|listEngines\(\)\.filter|desktop/.test(ocrSrc), true);
  }

  // ── V1 純函式：base64 ──
  {
    const { bytesToBase64, fileToDataUrl } = await import('file://' + ADAPTER);
    const b64 = bytesToBase64(new Uint8Array([1, 2, 3]));
    check('V1a bytesToBase64 正確', b64, btoa(String.fromCharCode(1, 2, 3)));
    const file = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, type: 'image/png' };
    const url = await fileToDataUrl(file);
    check('V1b fileToDataUrl 產生 data URL', url, `data:image/png;base64,${b64}`);
  }

  // ── V2 parseChatToOcrResult 結構 ──
  {
    const { parseChatToOcrResult } = await import('file://' + ADAPTER);
    const r = parseChatToOcrResult({ message: { content: 'Hello World' } });
    check('V2 text', r.text, 'Hello World');
    check('V2 blocks 結構（text/confidence/bbox 陣列）',
      JSON.stringify(r.blocks), JSON.stringify([{ text: 'Hello World', confidence: 1, bbox: [0, 0, 0, 0] }]));
    check('V2 confidence', r.confidence, 1);
    const empty = parseChatToOcrResult({});
    check('V2 空回應 → text 空串＋blocks 空陣列＋conf0', JSON.stringify({ t: empty.text, b: empty.blocks.length, c: empty.confidence }), JSON.stringify({ t: '', b: 0, c: 0 }));
  }

  // ── V3 recognize()：mock fetch ──
  {
    const mod = await import('file://' + ADAPTER);
    const adapter = mod.default;
    mod._setVisionConfig({ url: VISION_URL, model: VISION_MODEL });
    let sentBody = null;
    mod._setVisionFetch(async (url, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ message: { content: 'cat cafe neon' } }) };
    });
    const file = { arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer, type: 'image/png' };
    const r = await adapter.recognize(file);
    check('V3 送出 /api/chat + model', sentBody?.model, VISION_MODEL);
    check('V3 messages[0].images 為 data URL（含 base64）',
      typeof sentBody?.messages?.[0]?.images?.[0] === 'string'
        && sentBody.messages[0].images[0].startsWith('data:image/png;base64,'), true);
    check('V3 回 OcrResult text', r.text, 'cat cafe neon');
    mod._setVisionFetch(null); mod._setVisionConfig(null);
  }

  // ── V3b recognize 非 ok → reject（補測：錯誤處理不吞、回 HTTP 訊息）──
  {
    const mod = await import('file://' + ADAPTER + '?v3b');
    const adapter = mod.default;
    mod._setVisionConfig({ url: VISION_URL, model: VISION_MODEL });
    mod._setVisionFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const file = { arrayBuffer: async () => new Uint8Array([7, 7, 7]).buffer, type: 'image/png' };
    let errMsg = null;
    try { await adapter.recognize(file); } catch (e) { errMsg = e.message; }
    check('V3b recognize ollama 回非 ok → reject（含 HTTP 訊息）',
      typeof errMsg === 'string' && errMsg.includes('ollama 回傳 HTTP 500'), true);
    mod._setVisionFetch(null); mod._setVisionConfig(null);
  }

  // ── V4 available()：desktop-only ──
  {
    // 手機：即使 ollama 可連也 false
    setUA('Mozilla/5.0 (Linux; Android 14; SM-A5560)');
    
    const mod = await import('file://' + ADAPTER + '?v4');
    const adapter = mod.default;
    mod._setVisionConfig({ url: VISION_URL, model: VISION_MODEL });
    let called = false;
    mod._setVisionFetch(async () => { called = true; return { ok: true, json: async () => ({ models: [{ name: 'qwen3-ocr64k:latest' }] }) }; });
    const andAvail = await adapter.available();
    check('V4 手機(Android UA) available()=false（即便 ollama 可連）', andAvail, false);
    check('V4 手機時不發 ollama 請求（短路）', called, false);

    // 桌面：ollama 可連＋model 存在 → true
    setUA('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
    mod._setVisionFetch(async (url) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'qwen3-ocr64k:latest' }] }) };
      return { ok: false };
    });
    const deskAvail = await adapter.available();
    check('V4 桌面＋ollama 可連＋model 在 → true', deskAvail, true);
    mod._setVisionFetch(null); mod._setVisionConfig(null);
  }

  // ── V5 負控制：ollama 不可連 → available()=false ──
  {
    setUA('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
    
    const mod = await import('file://' + ADAPTER + '?v5');
    const adapter = mod.default;
    mod._setVisionConfig({ url: VISION_URL, model: VISION_MODEL });
    mod._setVisionFetch(async () => { throw new Error('connection refused'); });
    const a = await adapter.available();
    check('V5 桌面但 ollama 不可連 → available()=false（不會誤啟用）', a, false);
    mod._setVisionFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    const b = await adapter.available();
    check('V5 ollama 回非 ok → available()=false', b, false);
    mod._setVisionFetch(null); mod._setVisionConfig(null);
  }

  // ── V6 PRE 負控制：剝除 Android 檢查 → 手機誤開 vision-ai ──
  {
    const { m, tmp } = await importStripped('Mozilla/5.0 (Linux; Android 14; SM-A5560)');
    try {
      const adapter = m.default;
      m._setVisionConfig({ url: VISION_URL, model: VISION_MODEL });
      m._setVisionFetch(async () => ({ ok: true, json: async () => ({ models: [{ name: 'qwen3-ocr64k:latest' }] }) }));
      const a = await adapter.available();
      check('V6 PRE 剝除 Android 檢查後 → 手機 available() 誤為 true（重現非 desktop 卻可用）', a, true);
    } finally {
      if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  // 還原全局
  cleanupGlobals();

  console.log(failures === 0 ? '\n═══ ALL PASS ═══' : `\n═══ ${failures} FAILURES ═══`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('[harness error]', e); process.exit(2); });