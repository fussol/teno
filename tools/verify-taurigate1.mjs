#!/usr/bin/env node
// TAURIGATE1：Tauri 後端判定錯誤 → 操作日誌從 2026-09-09 起靜默不寫
//
// 根因：5 處用 `window.__TAURI__?.core` 判斷「是否在 Tauri 內」，
//   但本專案 withGlobalTauri=false（Tauri v2 預設）→ 該全域從來不存在
//   → 桌面/Android 一律被判成「非 Tauri」。
//   最痛的是 app-log.js 的 noBackend()：日誌直接進記憶體、永不入 app-log.db，
//   而且不報錯（無 INSERT 失敗 → 無 warn）→ 靜默 16 天。
//
//   [S] 源碼：正確設定值、無程式碼再用舊全域、5 處都改用 isTauri
//   [B] 行為：isTauri 在兩種環境下判定正確（模擬 window）
//   [NEG] 負控制：證明舊閘門在 withGlobalTauri=false 下必為「無後端」
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, ok, extra = '') => {
  if (ok) { pass++; }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
};

// ── [B] isTauri 行為（先設 window 再 import，模組載入時即求值）──
async function isTauriUnder(win) {
  // 每次用新的 query 參數避開 ESM 快取
  globalThis.window = win;
  const url = `../src/lib/platform.js?t=${Math.random()}`;
  const m = await import(url);
  return m.isTauri;
}

console.log('[B] isTauri 判定（模擬環境）');
{
  // Tauri v2 真實情形：注入 __TAURI_INTERNALS__，無 __TAURI__
  chk('__TAURI_INTERNALS__ 存在 → true', (await isTauriUnder({ __TAURI_INTERNALS__: {} })) === true);
  // 純瀏覽器 / WEB-DEMO：什麼都沒有
  chk('空 window → false', (await isTauriUnder({})) === false);
  // 若日後有人開 withGlobalTauri=true：只有舊全域也要認得
  chk('只有舊全域 __TAURI__.core → 仍判 true（向後相容）', (await isTauriUnder({ __TAURI__: { core: {} } })) === true);
  // node（無 window）
  delete globalThis.window;
  chk('無 window → false（node harness 安全）', (await import(`../src/lib/platform.js?t=${Math.random()}`)).isTauri === false);
}

// ── [S] 源碼 ──
console.log('[S] 源碼接線');
const conf = JSON.parse(readFileSync('src-tauri/gen/android/app/src/main/assets/tauri.conf.json', 'utf8'));
chk('withGlobalTauri = false（這就是根因的前提）', conf.app.withGlobalTauri === false);

const FILES = ['src/lib/app-log.js', 'src/lib/tts.js', 'src/pages/ocr.js', 'src/lib/ocr/vision-adapter.js'];
const codeOnly = (p) => readFileSync(p, 'utf8').split('\n')
  .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); }).join('\n');

for (const f of FILES) {
  chk(`${f}: 程式碼不再用 window.__TAURI__`, !codeOnly(f).includes('__TAURI__'));
}
// platform.js 是唯一允許引用舊全域的地方（向後相容分支），但不得只用舊全域
{
  const pc = codeOnly('src/lib/platform.js');
  chk('platform.js: 以 __TAURI_INTERNALS__ 為主', pc.includes('__TAURI_INTERNALS__'));
  chk('platform.js: 舊全域僅作 fallback（不單獨使用）', /__TAURI_INTERNALS__\s*\|\|\s*window\.__TAURI__\?\.core/.test(pc));
}

chk('platform.js 定義 isTauri（含 __TAURI_INTERNALS__）',
  /export const isTauri[\s\S]{0,120}__TAURI_INTERNALS__/.test(readFileSync('src/lib/platform.js', 'utf8')));

// 4 個消費端都 import 並使用 isTauri
const appLog = readFileSync('src/lib/app-log.js', 'utf8');
chk('app-log.js: noBackend() = !isTauri（單一來源）', /const noBackend = \(\) => !isTauri;/.test(appLog));
chk('app-log.js: 已 import isTauri', /import \{ isTauri \} from '\.\/platform\.js'/.test(appLog));
chk('tts.js: 用 !isTauri 判無原生 TTS', /if \(!isTauri && typeof speechSynthesis !== 'undefined'\)/.test(readFileSync('src/lib/tts.js', 'utf8')));
chk('ocr.js: _isDesktop 用 isTauri', /return isTauri;/.test(readFileSync('src/pages/ocr.js', 'utf8')));
chk('vision-adapter.js: isDesktopEnv 用 isTauri', /return isTauri;/.test(readFileSync('src/lib/ocr/vision-adapter.js', 'utf8')));
chk('initAppLog 顯性化後端判定（window.__logBackend）', /window\.__logBackend = !noBackend\(\)/.test(appLog));

// ── [NEG] 負控制：舊閘門必錯 ──
console.log('[NEG] 負控制');
{
  const oldGate = (win) => typeof win !== 'undefined' && typeof win.__TAURI__?.core !== 'object';
  chk('舊閘門在 withGlobalTauri=false 下誤判為「無後端」（＝bug 成立）',
    oldGate({ __TAURI_INTERNALS__: {} }) === true);
  chk('新閘門在同樣環境下正確判為「有後端」',
    (await isTauriUnder({ __TAURI_INTERNALS__: {} })) === true);
}

console.log(`\nTAURIGATE1: ${fail ? 'FAIL' : 'PASS'} (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
