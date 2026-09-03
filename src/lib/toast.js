// Toast — notification system, extracted from main.js to break the pages→main.js cycle.
// DOM container is resolved lazily so Node/test harnesses without a DOM are safe (no-op).

export function toast(message, type = '') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 300); }, 2600);
}
