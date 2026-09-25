import { invoke } from '@tauri-apps/api/core'

// CLI（tools/cli.mjs）經 import 鏈拉進本模組，node 無 navigator/window → 直接 ReferenceError
// 讓 CLI 完全無法執行。故此處對非瀏覽器環境做防護（瀏覽器行為不變）。
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isAndroid = /Android/i.test(ua);
export const isWindows = /Windows/i.test(ua);
// TAURIGATE1: 原本用 window.__TAURI__?.core 判斷，但本專案 tauri.conf.json 的
// withGlobalTauri=false（Tauri v2 預設）→ 該全域「從來不存在」→ 桌面/Android 上
// 一律判成「非 Tauri」。Tauri v2 恆注入的是 __TAURI_INTERNALS__（npm 模組 invoke 走它），
// 故以它為準。WEB-DEMO（純瀏覽器）下確實不存在 → 仍正確判為非 Tauri。
export const isTauri = typeof window !== 'undefined'
  && !!(window.__TAURI_INTERNALS__ || window.__TAURI__?.core);
export const isMobile = isAndroid || /Mobi|iPhone|iPad|iPod/i.test(ua);

// 分塊 base64（與 ocr/vision-adapter.js bytesToBase64 同法）：逐 byte 串接在大檔
// （15MB+ 含操作日誌匯出）會在 Android WebView 炸 RangeError/OOM — 2026-09-04 實測。
function b64(bytes) {
  const u8 = new Uint8Array(bytes);
  const CH = 0x8000;
  let bin = '';
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}

export async function downloadBlob(content, filename, mime = 'text/plain') {
  if (isAndroid) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const buf = await blob.arrayBuffer();
    await invoke('save_export_file', {
      filename, dataB64: b64(new Uint8Array(buf)), mime,
    });
    return;
  }
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadBlobFromArray(bytes, filename, mime = 'application/octet-stream') {
  if (isAndroid) {
    await invoke('save_export_file', {
      filename, dataB64: b64(bytes), mime,
    });
    return;
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
