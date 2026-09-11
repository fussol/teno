// ═══════════════════════════════════════════════════════════════
// 圖片 URL 正規化（2026-09-08，IMG-HOTFIX2）
//
// 背景：庫裡 436 張圖全是 Google Drive 分享連結（drive.google.com/uc?id=）。
// curl 看全活（200 image/jpeg），但瀏覽器 <img> 全破圖——原因實錘：
// uc 回 303 跳到 drive.usercontent.google.com/download，而終點回：
//   cross-origin-resource-policy: same-site
//   cross-origin-embedder-policy: require-corp
// 跨站（預覽隧道／App WebView）嵌入直接被擋。curl 不受 CORP 管，
// 所以「curl 活、瀏覽器死」。教訓：curl-alive ≠ browser-loadable，
// 下次圖片破圖先看終點 response headers 有無 CORP/COEP。
//
// 解法：Drive 圖片統一轉 lh3.googleusercontent.com/d/{id}=w800 直連形
// （實測 200 image/jpeg、無 CORP、可跨站嵌；=w800 順手限 800px 寬，
// 實測 730KB→126KB，carousel 最寬 440px 完全夠）。
// data: URL 與非 Google 連結原樣放行；DB 不動，只動顯示層＋快照。
// 無依賴，node 可直接 import（harness 用）。
// ───────────────────────────────────────────────────────────────
// IMGURL1（2026-09-11）：編輯器支援「貼圖片連結」
// 實錘：tenor.com/xxx.gif 這類分享 URL 回的是 text/html（301→view 頁），
// <img> 直接嵌必破圖；正解是抓頁面 og:image（media*.tenor.com 直連）。
// 但 Tenor 直連帶時效簽名（AAAAC…實測數分鐘後 404），hotlink 會爛，
// 所以 UI 會提醒「Tenor 宜下載後上傳」。本檔只放純函式（harness 可測）。
// ═══════════════════════════════════════════════════════════════

const IMG_EXT_RE = /\.(gif|jpe?g|png|webp|bmp|avif|svg)([?#]|$)/i;

// 頁面型 host（就算路徑長得像圖也不是直連圖）：tenor 分享頁、giphy 詳情頁、
// imgur 相簿頁。對應的直連 host（media*.tenor.com / media*.giphy.com /
// i.imgur.com）不在此列。
const PAGE_HOST_RE = /^(tenor\.com|giphy\.com|imgur\.com|www\.tenor\.com|www\.giphy\.com|www\.imgur\.com)$/i;

/** 是否 http(s) URL（hotlink 只收 https；http 僅放行 localhost 測試）。 */
export function isHttpUrl(u) {
  const s = String(u ?? '').trim();
  try {
    const url = new URL(s);
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') {
      const h = (url.hostname || '').toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
    }
    return false;
  } catch { return false; }
}

/** 是否「可直接餵 <img>」的直連圖 URL（data: 視為直連）。 */
export function isDirectImageUrl(u) {
  const s = String(u ?? '').trim();
  if (!s || s.startsWith('data:')) return !!s;
  let host = '';
  try { host = new URL(s).hostname || ''; } catch { return false; }
  if (PAGE_HOST_RE.test(host)) return false;   // 分享頁≠圖（即使路徑尾是 .gif）
  if (!isHttpUrl(s)) return false;
  return IMG_EXT_RE.test(s);
}

/** 從 HTML 抓 og:image／twitter:image（取第一個 http(s) 值）。 */
export function extractOgImage(html) {
  const s = String(html ?? '');
  const m = s.match(/<meta[^>]+(?:property=["']og:image["']|name=["']twitter:image["'])[^>]*>/i)
    || s.match(/<meta[^>]+content=["']https?:\/\/[^"']+["'][^>]*(?:property=["']og:image["']|name=["']twitter:image["'])/i);
  if (!m) return '';
  const c = m[0].match(/content=["'](https?:\/\/[^"']+)["']/i);
  return c ? c[1] : '';
}

/**
 * 把使用者貼的連結解成直連圖 URL。
 * @param {string} url 使用者輸入
 * @param {(url:string)=>Promise<string>} fetchText 抓頁面 HTML（呼叫端傳 fetchGet；harness 傳 stub）
 * @returns {Promise<{direct:string, resolved:boolean}|{error:string}>}
 */
export async function resolvePageImageUrl(url, fetchText) {
  const s = String(url ?? '').trim();
  if (!s) return { error: 'empty' };
  if (s.startsWith('data:')) return { direct: s, resolved: false };
  if (!isHttpUrl(s)) return { error: 'not-http' };
  if (isDirectImageUrl(s)) return { direct: s, resolved: false };
  // 非直連：只對已知頁面型 host 嘗試 og:image 解析，其餘直接拒（避免亂抓全網頁）
  let host = '';
  try { host = new URL(s).hostname || ''; } catch { return { error: 'bad-url' }; }
  if (!PAGE_HOST_RE.test(host)) return { error: 'not-image' };
  try {
    const html = await fetchText(s);
    const og = extractOgImage(html);
    if (og) return { direct: og, resolved: true };
    return { error: 'no-og-image' };
  } catch {
    return { error: 'fetch-failed' };
  }
}

/** 從 URL 生預設檔名（尾段路徑；無尾段用 host）。 */
export function filenameForUrl(u) {
  const s = String(u ?? '').trim();
  try {
    const url = new URL(s);
    const tail = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
    if (tail && tail.length <= 80) return tail;
    return url.hostname || 'remote-image';
  } catch { return 'remote-image'; }
}

/**
 * 把使用者貼的多連結文字併入既有圖清單（純函式：去重＋略過非法）。
 * @param {Array<{filename:string,data:string}>} existing
 * @param {string} text 空白/逗號/換行分隔的多個 URL
 * @returns {{list:Array, added:number, skipped:number}}
 */
export function mergeImageUrls(existing, text) {
  const base = [...(existing || [])];
  const have = new Set(base.map(im => im.data));
  let added = 0, skipped = 0;
  for (const tok of String(text ?? '').split(/[\s,，]+/).map(t => t.trim()).filter(Boolean)) {
    if (!isHttpUrl(tok) || have.has(tok)) { skipped++; continue; }
    have.add(tok);
    base.push({ filename: filenameForUrl(tok), data: tok });
    added++;
  }
  return { list: base, added, skipped };
}
// ═══════════════════════════════════════════════════════════════

export function normalizeImageUrl(u) {
  const s = String(u ?? '').trim();
  if (!s || s.startsWith('data:')) return s;
  let host = '';
  try { host = new URL(s).hostname || ''; } catch { return s; }
  if (!/google(usercontent)?\.com$/.test(host)) return s;
  if (host.startsWith('lh3.')) return /=w\d/.test(s) ? s : `${s}=w800`;
  const m = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)
    || s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/)
    || s.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return `https://lh3.googleusercontent.com/d/${m[1]}=w800`;
  return s;
}
