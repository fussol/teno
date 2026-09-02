// ═══ 字庫瀏覽顯示上限 — 共享設定（browser.js / deck-browser.js 單一真值源）═══
// 需求（2026-08-31 元首）：搜尋上限可自調，不寫死 500；設定記憶（存 DB settings）。
// 設定鍵：browserDisplayLimit — 0 = 全部（無上限），正整數 = 顯示上限。
// 預設 500（與原寫死行為相容）；壞值/缺值回 500。

export const DISPLAY_LIMIT_KEY = 'browserDisplayLimit';
export const DISPLAY_LIMIT_DEFAULT = 500;

/** 選單可選值（0=全部） */
export const DISPLAY_LIMIT_OPTIONS = [
  { v: 100, label: '100' },
  { v: 200, label: '200' },
  { v: 500, label: '500' },
  { v: 1000, label: '1000' },
  { v: 2000, label: '2000' },
  { v: 0, label: '全部' },
];

/** 讀設定值 → 合法上限（Number.isInteger、>=0；壞值回預設 500） */
export function normalizeDisplayLimit(v) {
  const n = typeof v === 'string' ? parseInt(v, 10) : (v ?? NaN);
  if (!Number.isInteger(n) || n < 0) return DISPLAY_LIMIT_DEFAULT;
  return n;
}

/** 依上限裁切（0 = 全部，回原陣列引用） */
export function capList(words, limit) {
  const L = normalizeDisplayLimit(limit);
  if (L === 0 || words.length <= L) return words;
  return words.slice(0, L);
}

/** 結果列文案 */
export function limitNote(words, limit) {
  const L = normalizeDisplayLimit(limit);
  if (L === 0 || words.length <= L) return `${words.length} 筆結果`;
  return `${words.length} 筆結果，顯示前 ${L} 筆（使用搜尋縮小範圍）`;
}

/** 選單 HTML（class/size 由呼叫端自訂；id 由呼叫端帶入避免雙頁碰撞） */
export function limitSelectHtml(id, current) {
  const cur = normalizeDisplayLimit(current);
  return `<select id="${id}" class="display-limit-select" title="顯示上限" style="font-size:12px;background:var(--bg-surface);color:var(--text-secondary);border:1px solid var(--border);border-radius:6px;padding:2px 6px">
    ${DISPLAY_LIMIT_OPTIONS.map(o => `<option value="${o.v}" ${cur === o.v ? 'selected' : ''}>${o.label}</option>`).join('')}
  </select>`;
}
