// ═══════════════════════════════════════════════════════════════
// Scope DOM — KEEPALIVE1：把頁面模組的全域查詢限制在「自己這一頁」內
// ═══════════════════════════════════════════════════════════════
//
// 背景：主頁預渲染之後，五個主頁（dashboard/study/browser/tools/settings）
// 會同時留在 DOM 裡（換頁只切 .active，見 main.js 的 KEEPALIVE1）。
//
// 但頁面模組的 onMount 是照「此刻 DOM 裡只有自己這一頁」的隱含前提寫的，
// 用的全是 document.querySelectorAll / getElementById。五頁共存之後這個前提
// 不再成立 —— 實測（tools/probe-scope.mjs，真實 5 頁 DOM）會有選擇器撈到別頁：
//
//   browser 的 .exam-deck-chip[data-deck]  → 命中 settings 17 個
//   tools / settings 的 button[onclick]    → 互相命中 4 / 1 個
//
// 若放任不管，會出現「點設定頁的按鈕觸發工具頁 handler」這類難查的 bug。
//
// 這裡不去逐一改寫各頁的選擇器（那樣每次新增選擇器都可能再踩一次），
// 而是在 onMount 期間把 document 的查詢暫時導向本頁圖層，
// 等於把舊語意還原回來。
//
// getElementById 找不到時**回退到全域**：頁面掛載時常會取用圖層外的元素
// （#sidebar / #topbar / #toastContainer / #bottomBar 等），不能讓它們變 null。

/** 取得 id 對應元素，找不到回傳 null（不在文件中的節點查不到，語意與原生一致） */
function byId(root, id) {
  const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/["\\]/g, '\\$&');
  try { return root.querySelector('#' + esc); } catch { return null; }
}

/**
 * 在 fn 執行期間，把 document 的全域查詢限制在 root 之內。
 * 同步執行；fn 拋錯也會還原（finally）。
 * @param {Element|null} root 本頁圖層根；null/文件外 → 直接執行不做限制
 * @param {Function} fn 要執行的掛載邏輯
 */
export function withPageScope(root, fn) {
  if (!root || typeof document === 'undefined' || typeof root.querySelectorAll !== 'function') return fn();
  const d = document;
  // 已經在作用域內（巢狀呼叫）→ 不重複包，避免還原到錯的層
  if (d.__pageScopeRoot) return fn();

  const oQSA = d.querySelectorAll, oQS = d.querySelector, oGEBI = d.getElementById;
  d.__pageScopeRoot = root;
  d.querySelectorAll = function (sel) { return root.querySelectorAll(sel); };
  d.querySelector = function (sel) { return root.querySelector(sel); };
  d.getElementById = function (id) { return byId(root, id) || oGEBI.call(d, id); };
  try {
    return fn();
  } finally {
    d.querySelectorAll = oQSA;
    d.querySelector = oQS;
    d.getElementById = oGEBI;
    delete d.__pageScopeRoot;
  }
}
