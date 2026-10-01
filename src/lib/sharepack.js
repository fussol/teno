// SHAREPACK2：分享包＝公開資料專區（零個人化）——隨附包、圖書館預儲存、題包包格式。
// 個人資歷/進度不走這裡（.db 一檔全包）；個人題目（文法覆蓋層）用 pack-grammar-overlay 獨立匯出匯入。
// 隨附包檔案在 public/packs/*（隨 App 發行、不預載）——使用者點「匯入」才寫進真正的 DB key。
import { getSetting, setSetting } from './db.js';
import { icon } from './svg.js';

export const PACK_KINDS = ['pack-gsat', 'pack-grammar-core', 'pack-grammar-overlay'];
const TARGET_KEY = { 'pack-gsat': 'gsat_bank', 'pack-grammar-core': 'grammar_bank_core' };
const CACHE_KEY = 'share_pack_cache';

export const BUILTIN_PACKS = [
  { id: 'gsat', kind: 'pack-gsat', title: '學測題庫 97–115 年', desc: '官方 5 大題整卷＋中譯英 · 隨 App 附帶' },
  { id: 'grammar', kind: 'pack-grammar-core', title: '文法核心題庫', desc: '16 章句型多選與翻譯 · 隨 App 附帶' },
];

const fetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`讀包失敗（HTTP ${r.status}）`);
  return r.text();
};
const parseJsonl = (t) => t.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

/** 抓隨附包原始資料：gsat→{mc,tr}／grammar→{qs,topics}（node 測試走 fs，頁面走 fetch） */
export async function fetchBuiltinData(id) {
  if (id === 'gsat') {
    const [mc, tr] = await Promise.all([
      fetchText('/packs/gsat/gsat.jsonl'),
      fetchText('/packs/gsat/gsat_translate.jsonl'),
    ]);
    return { mc: parseJsonl(mc), tr: parseJsonl(tr) };
  }
  if (id === 'grammar') {
    const [qs, topics] = await Promise.all([
      fetchText('/packs/grammar/questions.jsonl'),
      fetchText('/packs/grammar/pattern_titles.json'),
    ]);
    return { qs: parseJsonl(qs), topics: JSON.parse(topics) };
  }
  throw new Error('未知隨附包：' + id);
}

/** 點「匯入」→ 抓隨附包 → 寫 DB → 回資料給頁面 hydrate */
export async function importBuiltin(id) {
  const meta = BUILTIN_PACKS.find(p => p.id === id);
  if (!meta) throw new Error('未知隨附包：' + id);
  const data = await fetchBuiltinData(id);
  await setSetting(TARGET_KEY[meta.kind], data);
  return data;
}

/** 題包包格式：單檔 JSON {v:1, kind, title, data} */
export function packToJson(kind, data, title) {
  return JSON.stringify({ v: 1, kind, title: title || '', data });
}
export function parsePack(text) {
  let p;
  try { p = JSON.parse(text); } catch { throw new Error('不是 JSON 檔'); }
  if (!p || p.v !== 1 || !PACK_KINDS.includes(p.kind)) throw new Error('不是支援的題包格式');
  if (p.kind === 'pack-gsat' && !(p.data && Array.isArray(p.data.mc))) throw new Error('學測題包缺 mc 陣列');
  if (p.kind === 'pack-grammar-core' && !(p.data && Array.isArray(p.data.qs))) throw new Error('文法題包缺 qs 陣列');
  if (p.kind === 'pack-grammar-overlay' && !(p.data && typeof p.data === 'object' && !Array.isArray(p.data))) throw new Error('覆蓋層題包缺 data 物件');
  return p;
}
export const packCount = (p) =>
  p.kind === 'pack-gsat' ? p.data.mc.length + (Array.isArray(p.data.tr) ? p.data.tr.length : 0)
  : p.kind === 'pack-grammar-core' ? p.data.qs.length
  : Object.keys(p.data.up || {}).length + (Array.isArray(p.data.rm) ? p.data.rm.length : 0);

// —— 預儲存（分享包專用；只收公開包，壞包不落地）——
export async function cachePack(name, json) {
  const p = parsePack(json);
  if (p.kind === 'pack-grammar-overlay') throw new Error('個人題包不進分享包');
  const cur = (await getSetting(CACHE_KEY)) || {};
  cur[name] = { json, at: Date.now() };
  await setSetting(CACHE_KEY, cur);
}
export async function listCachedPacks() {
  const cur = (await getSetting(CACHE_KEY)) || {};
  return Object.entries(cur)
    .map(([name, v]) => ({ name, at: v?.at || 0 }))
    .sort((a, b) => b.at - a.at);
}
export async function cachedPackJson(name) {
  const cur = (await getSetting(CACHE_KEY)) || {};
  return cur[name]?.json || null;
}
export async function dropCachedPack(name) {
  const cur = (await getSetting(CACHE_KEY)) || {};
  delete cur[name];
  await setSetting(CACHE_KEY, cur);
}

/** 點「匯入」才寫真正的 key。回寫入的 key（頁面據此 hydrate）。 */
export async function applyPack(pack) {
  const p = typeof pack === 'string' ? parsePack(pack) : pack;
  if (p.kind === 'pack-grammar-overlay') {
    const cur = (await getSetting('grammar_bank_overlay')) || {};
    const up = { ...(cur.up || {}), ...(p.data.up || {}) };
    const rm = [...new Set([...(cur.rm || []), ...(p.data.rm || [])])];
    await setSetting('grammar_bank_overlay', { up, rm });
    return 'grammar_bank_overlay';
  }
  await setSetting(TARGET_KEY[p.kind], p.data);
  return TARGET_KEY[p.kind];
}

/** 匯出：隨附包 → 單檔 JSON（給別人） */
export async function exportBuiltinPackJson(id) {
  const meta = BUILTIN_PACKS.find(p => p.id === id);
  if (!meta) throw new Error('未知隨附包：' + id);
  return packToJson(meta.kind, await fetchBuiltinData(id), meta.title);
}
/** 匯出：個人文法自建題（覆蓋層）→ 單檔 JSON */
export async function exportOverlayPackJson() {
  const ov = (await getSetting('grammar_bank_overlay')) || {};
  const data = { up: ov.up || {}, rm: ov.rm || [] };
  if (!Object.keys(data.up).length && !data.rm.length) throw new Error('沒有自建題可匯出');
  return packToJson('pack-grammar-overlay', data, '文法自建題（覆蓋層）');
}

/** 未匯入 gate 卡（學測/文法頁共用外觀）；頁面自己接 data-gate-import */
export function packGateHtml({ page, title, iconName, back = 'topics', desc }) {
  return `<span data-page="${page}" hidden></span>
    <div class="page-title">
      ${back ? `<button class="btn btn-sm" data-back="${back}" style="margin-right:8px">${icon('arrowLeft')} 返回</button>` : ''}
      ${icon(iconName)} ${title}
    </div>
    <div class="page-subtitle">${desc}</div>
    <div style="max-width:600px;margin:24px auto 0;border:1px solid var(--border);border-radius:var(--r-lg);background:var(--bg-surface);padding:24px;text-align:center">
      <div style="font-size:15px;font-weight:600;color:var(--text-primary);margin-bottom:6px">題庫尚未匯入</div>
      <div style="font-size:13px;color:var(--text-tertiary);margin-bottom:16px">題包檔案隨 App 附帶（預儲存）· 點下面按鈕匯入後才可使用</div>
      <button class="btn btn-primary" data-gate-import>${icon('download')} 匯入題庫</button>
    </div>`;
}
