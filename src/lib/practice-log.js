// 插件練習紀錄的快取層：DB（可備份）為準，DB 不可用（web-demo／未就緒）退 localStorage。
// 首次載入會把 localStorage 的舊紀錄搬進 DB（同 ts|qid 視為已搬），搬完不刪本地當緩存。
import { isReady, insertPractice, selectPractice } from './db.js';

const LS_KEY = (plugin) => `teno:${plugin}:log`;
const cache = {};   // plugin -> rows（舊→新）

const readLs = (plugin) => {
  try { return JSON.parse(localStorage.getItem(LS_KEY(plugin)) || '[]'); } catch { return []; }
};

const pushLs = (plugin, row) => {
  try {
    const ls = readLs(plugin);
    ls.push(row);
    localStorage.setItem(LS_KEY(plugin), JSON.stringify(ls.slice(-2000)));
  } catch { /* 無 localStorage（非瀏覽器）→ 忽略 */ }
};

/** 同步取快取（render 用）；未載入時是空陣列，呼叫端在 onMount 後 loadPractice。 */
export function practiceRows(plugin) {
  return cache[plugin] || [];
}

/** 寫一筆（先進快取立刻可見，DB／localStorage 背景寫）。 */
export function logPractice(plugin, row) {
  const full = { ...row, ts: row.ts || Date.now(), plugin };
  const rows = cache[plugin] || (cache[plugin] = []);
  rows.push(full);
  pushLs(plugin, full);
  insertPractice(full).catch(() => {});
}

/** 載入（含 localStorage → DB 一次性搬移）。 */
export async function loadPractice(plugin) {
  if (cache[plugin]) return cache[plugin];
  const ls = readLs(plugin);
  let dbRows = isReady() ? await selectPractice(plugin) : null;

  if (dbRows) {
    const seen = new Set(dbRows.map(r => `${r.ts}|${r.qid}`));
    for (const r of ls) {
      if (seen.has(`${r.ts}|${r.qid}`)) continue;
      await insertPractice({ ...r, plugin });
      dbRows = [{ ...r, plugin, ok: !!r.ok }, ...dbRows];
    }
    // DB 已存在但本地較新（DB 寫入失敗期間產生的）→ 補上
    const seen2 = new Set(dbRows.map(r => `${r.ts}|${r.qid}`));
    for (const r of ls) if (!seen2.has(`${r.ts}|${r.qid}`)) dbRows.push({ ...r, plugin, ok: !!r.ok });
    dbRows.sort((a, b) => a.ts - b.ts);
    cache[plugin] = dbRows;
  } else {
    cache[plugin] = ls;
  }
  return cache[plugin];
}
