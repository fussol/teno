// Toast — notification system, extracted from main.js to break the pages→main.js cycle.
// DOM container is resolved lazily so Node/test harnesses without a DOM are safe (no-op).
//
// TOAST1 (2026-09-12): 右上角堆疊，從右滑入＋底部進度條＋型別色左框。
// 型別：toast-success / toast-error / toast-warn / toast-info（預設）/ toast-easter。
// error 停留較久（4.2s），其餘 2.6s；最多疊 4 顆，新的在上。
export function toast(message, type = '') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  // 型別正規化：''／null → toast-info；裸字 success → toast-success
  let t = String(type || '').trim();
  if (!t) t = 'toast-info';
  else if (!t.startsWith('toast-')) t = `toast-${t}`;
  const el = document.createElement('div');
  el.className = `toast ${t}`;
  // G-XSS0: sink 走純文字 — 全 repo toast 呼叫皆純文字（零 icon/HTML 用法，
  // 已全量 grep 實錘），innerHTML 即 stored XSS（w.word／deck.name／tag.name 可控）。
  el.textContent = String(message ?? '');
  const life = t === 'toast-error' ? 4200 : 2600;
  el.style.setProperty('--toast-life', `${life}ms`);
  el.title = '單擊保留十秒，雙擊關閉';
  container.prepend(el);
  while (container.children.length > 4) container.lastChild?.remove();
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  // 單擊：凍結進度條＋邊框高亮，再留十秒；雙擊：立刻縮回去
  el.addEventListener('click', () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains('out')) return;
    el.classList.add('held');
    timer = setTimeout(dismiss, 10000);
  });
  el.addEventListener('dblclick', (e) => { e.preventDefault(); dismiss(); });
  timer = setTimeout(dismiss, life);
}
