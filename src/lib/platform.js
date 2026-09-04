import { invoke } from '@tauri-apps/api/core'

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
export const isWindows = /Windows/i.test(ua);
export const isTauri = typeof window.__TAURI__?.core === 'object';
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
