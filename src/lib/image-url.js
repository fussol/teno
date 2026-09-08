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
