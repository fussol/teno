// Toast — notification system, extracted from main.js to break the pages→main.js cycle.
// DOM container is resolved lazily so Node/test harnesses without a DOM are safe (no-op).

export function toast(message, type = '') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  // G-XSS0: sink 走純文字 — 全 repo toast 呼叫皆純文字（零 icon/HTML 用法，
  // 已全量 grep 實錘），innerHTML 即 stored XSS（w.word／deck.name／tag.name 可控）。
  el.textContent = String(message ?? '');
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 300); }, 2600);
}
