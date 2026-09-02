import { invoke } from '@tauri-apps/api/core'

const ua = navigator.userAgent;
export const isAndroid = /Android/i.test(ua);
export const isTauri = typeof window.__TAURI__?.core === 'object';
export const isMobile = isAndroid || /Mobi|iPhone|iPad|iPod/i.test(ua);

function b64(bytes) {
  let bin = '';
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
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
