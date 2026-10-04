// ═══════════════════════════════════════════════════════════════
// Export — Export words as a CSV download, with deck filter + preview.
// ═══════════════════════════════════════════════════════════════

import { icon } from '../lib/svg.js';
import { toast } from '../lib/toast.js';
import { buildCSV, buildShareCSV } from '../core/import.js';
import { exportCsvDialog, exportSharePack, webdavCloudList, webdavCloudGet } from '../lib/api.js';
import { isAndroid, isWeb, downloadBlob, downloadBlobFromArray } from '../lib/platform.js';
import { getSetting, setSetting } from '../lib/db.js';
import {
  BUILTIN_PACKS, importBuiltin, exportBuiltinPackJson, exportOverlayPackJson,
  parsePack, applyPack, cachePack, listCachedPacks, cachedPackJson, dropCachedPack,
} from '../lib/sharepack.js';

let _deckFilter = null;
let _editingShelf = null;

export function shelfWords(words, members) {
  const set = new Set(members || []);
  return (words || []).filter(w => set.has(w.deck || 'Default'))
    .sort((a, b) => (a.word || '').localeCompare(b.word || ''));
}

function getShelves(s) {
  const f = s?.state?.folders;
  return (f && !Array.isArray(f)) ? f : {};
}

export function renderContent(s) {
  const { words, decks } = s.state;
  const filtered = filterWords(words);
  return `
    <div style="display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s4)">
      <span class="muted" style="font-size:12px;font-weight:600">字本：</span>
      <button class="exam-deck-chip ${_deckFilter === null ? 'selected' : ''}" data-deck="">全部</button>
      ${decks.map(d => `
        <button class="exam-deck-chip ${_deckFilter === d.name ? 'selected' : ''}" data-deck="${escapeAttr(d.name)}">
          <span style="width:7px;height:7px;border-radius:50%;background:${d.color};display:inline-block"></span>
          ${escapeHtml(d.name)}
        </button>
      `).join('')}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--s3)">
      <div style="font-size:13px;color:var(--text-secondary)">
        將匯出 <span class="tnum" style="color:var(--accent);font-weight:700">${filtered.length}</span> 詞
        ${_deckFilter ? `· 字本「${escapeHtml(_deckFilter)}」` : '（全部字本）'}
      </div>
      <button class="btn-primary" id="exportRunBtn" ${filtered.length === 0 ? 'disabled' : ''}>
        ${icon('save')} 下載 CSV
      </button>
    </div>
  `;
}

export function render(s) {
  const { words } = s.state;
  const content = renderContent(s);
  const share = renderShareContent(s);
  return `
    <div class="page-title">${icon('save')} 匯出</div>
    <div class="page-subtitle">將單字庫匯出為 CSV 檔案 · 共 ${words.length} 詞</div>
    <div class="section">
      <div class="section-title">${icon('filter')} 範圍</div>
      <div class="config-section">
        ${renderContent(s)}
      </div>
    </div>
    <div class="section">
      <div class="section-title">${icon('book')} 書櫃</div>
      <div class="config-section">
        ${renderShelfBlock(s)}
      </div>
    </div>
    <div class="section">
      <div class="section-title">${icon('upload')} 分享</div>
      <div class="config-section">
        ${share}
      </div>
    </div>
    <!-- SHAREPACK2: 分享包＝公開資料專區（零個人化；隨附包預存不預載，點匯入才寫題庫） -->
    <div class="section">
      <div class="section-title">${icon('box')} 分享包</div>
      <div class="config-section">
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s2)">
          公開題包專區 · 不含進度／批改／自建題 · 隨附包檔案跟著 App 走，點「匯入」才寫進題庫；「圖書館」下載＝預儲存，再到下面匯入
        </div>
        ${BUILTIN_PACKS.map(p => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border-subtle)">
          <span style="flex:1;font-size:13px;color:var(--text-primary)">${escapeHtml(p.title)}<br><span style="font-size:11px;color:var(--text-tertiary)">${escapeHtml(p.desc)}</span></span>
          <button class="btn btn-xs" data-sp-export="${p.id}" style="font-size:11px">${icon('upload')} 匯出</button>
          <button class="btn btn-primary btn-xs" data-sp-import="${p.id}" style="font-size:11px">匯入</button>
        </div>`).join('')}
        <div style="margin-top:12px;font-size:12px;font-weight:600;color:var(--text-secondary)">已下載（預儲存）</div>
        <div id="spCache"><span style="font-size:12px;color:var(--text-tertiary)">讀取中…</span></div>
        <div style="margin-top:12px;font-size:12px;font-weight:600;color:var(--text-secondary)">公開圖書館（WebDAV 資料夾，同備份系統設定）</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
          <input id="spLibPath" type="text" placeholder="/Teno-Library/" style="flex:1;min-width:0;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box">
          <button class="btn btn-xs" id="spLibBrowse">${icon('search')} 瀏覽</button>
        </div>
        <div id="spLibList" style="margin-top:6px"></div>
      </div>
    </div>
    <!-- SHAREPACK2: 我的題目＝個人覆蓋層單獨匯出（進度不走這裡，.db 全包） -->
    <div class="section">
      <div class="section-title">${icon('pencil')} 我的題目</div>
      <div class="config-section">
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s2)">
          個人自建／編輯的文法題（覆蓋層）· 不含任何進度 · 匯入＝併入現有自建題，不互相覆蓋
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn" id="spOvExport">${icon('upload')} 匯出我的題目</button>
          <button class="btn" id="spOvImport">從檔案匯入</button>
          <input type="file" id="spOvFile" accept=".json,application/json" style="display:none">
        </div>
      </div>
    </div>
  `;
}

function filterWords(words) {
  const list = _deckFilter ? words.filter(w => w.deck === _deckFilter) : words;
  return [...list].sort((a, b) => (a.word || '').localeCompare(b.word || ''));
}

export function onMount(s, renderFn) {
  const _renderInPlace = renderFn || renderInPlace;
  document.querySelectorAll('.exam-deck-chip[data-deck]').forEach(el => {
    el.addEventListener('click', () => {
      _deckFilter = el.dataset.deck || null;
      _renderInPlace(s);
    });
  });

  const runBtn = document.getElementById('exportRunBtn');
  if (runBtn) runBtn.addEventListener('click', () => runExport(s));

  const shareBtn = document.getElementById('shareRunBtn');
  if (shareBtn) shareBtn.addEventListener('click', () => runShareExport(s));

  // SHAREPACK1: 含圖打包接線
  const sharePackBtn = document.getElementById('sharePackRunBtn');
  if (sharePackBtn) sharePackBtn.addEventListener('click', async () => {
    const filtered = filterWords(s.state.words);
    if (filtered.length === 0) { toast('沒有資料可分享', 'toast-error'); return; }
    await runSharePackDeck(s, null, sharePackBtn);
  });

  document.querySelectorAll('[data-share-deck]').forEach(btn => {
    btn.addEventListener('click', () => runShareDeck(s, btn.dataset.shareDeck || null, btn));
  });

  document.querySelectorAll('[data-share-pack-deck]').forEach(btn => {
    btn.addEventListener('click', () => runSharePackDeck(s, btn.dataset.sharePackDeck || null, btn));
  });

  document.querySelectorAll('[data-shelf-dl]').forEach(btn => {
    btn.addEventListener('click', () => runShareShelf(s, btn.dataset.shelfDl, btn));
  });

  document.querySelectorAll('[data-shelf-pack]').forEach(btn => {
    btn.addEventListener('click', () => runSharePackShelf(s, btn.dataset.shelfPack, btn));
  });
  document.querySelectorAll('[data-shelf-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      _editingShelf = _editingShelf === btn.dataset.shelfEdit ? null : btn.dataset.shelfEdit;
      _renderInPlace(s);
    });
  });
  document.querySelectorAll('[data-shelf-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.shelfDel;
      if (!confirm(`確定刪除書櫃「${name}」？（字本本身不受影響）`)) return;
      btn.disabled = true;
      try { await s.actions.shelfDelete(name); } catch (e) { toast('刪除失敗: ' + e.message, 'toast-error'); }
      if (_editingShelf === name) _editingShelf = null;
      _renderInPlace(s);
    });
  });
  document.querySelectorAll('[data-shelf-ren]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const old = btn.dataset.shelfRen;
      const input = document.getElementById('shelfRenInput');
      const v = (input?.value || '').trim();
      if (!v) { toast('請輸入新名稱', 'toast-warn'); return; }
      try {
        await s.actions.shelfRename(old, v);
        _editingShelf = v;
        _renderInPlace(s);
      } catch (e) { toast('改名失敗: ' + e.message, 'toast-error'); }
    });
  });
  document.querySelectorAll('[data-shelf-toggle]').forEach(cb => {
    cb.addEventListener('change', async () => {
      try { await s.actions.shelfToggleDeck(cb.dataset.shelfToggle, cb.dataset.deck); } catch (e) { toast('更新失敗: ' + e.message, 'toast-error'); }
      _renderInPlace(s);
    });
  });
  const shelfNewBtn = document.getElementById('shelfNewBtn');
  const shelfNewInput = document.getElementById('shelfNewInput');
  const createShelf = async () => {
    const v = (shelfNewInput?.value || '').trim();
    if (!v) { toast('請輸入書櫃名稱', 'toast-warn'); return; }
    try {
      await s.actions.shelfCreate(v);
      _editingShelf = v;
      _renderInPlace(s);
    } catch (e) { toast('新增失敗: ' + e.message, 'toast-error'); }
  };
  if (shelfNewBtn) shelfNewBtn.addEventListener('click', createShelf);
  if (shelfNewInput) shelfNewInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createShelf(); });

  // ── SHAREPACK2: 分享包（隨附包匯入/匯出、已下載預儲存、圖書館瀏覽下載）＋我的題目 ──
  const spErr = (e) => (e?.message || e);
  const renderSpCache = async () => {
    const box = document.getElementById('spCache');
    if (!box) return;
    try {
      const list = await listCachedPacks();
      if (!list.length) { box.innerHTML = '<span style="font-size:12px;color:var(--text-tertiary)">尚無</span>'; return; }
      box.innerHTML = list.map(c => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border-subtle)">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--text-primary)" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</span>
          <span class="muted" style="font-size:11px">${new Date(c.at).toLocaleDateString('zh-TW')}</span>
          <button class="btn btn-primary btn-xs" data-sp-cache-import="${escapeAttr(c.name)}" style="font-size:11px">匯入</button>
          <button class="btn btn-xs" data-sp-cache-del="${escapeAttr(c.name)}" style="font-size:11px;color:var(--red)">刪除</button>
        </div>`).join('');
      box.querySelectorAll('[data-sp-cache-import]').forEach(b => b.addEventListener('click', async () => {
        try {
          const json = await cachedPackJson(b.dataset.spCacheImport);
          if (!json) throw new Error('找不到預儲存');
          await applyPack(json);
          toast('已匯入', 'toast-success');
        } catch (e) { toast('匯入失敗：' + spErr(e), 'toast-error'); }
      }));
      box.querySelectorAll('[data-sp-cache-del]').forEach(b => b.addEventListener('click', async () => {
        await dropCachedPack(b.dataset.spCacheDel);
        renderSpCache();
      }));
    } catch (e) { box.innerHTML = `<span style="font-size:12px;color:var(--red)">${escapeHtml(spErr(e))}</span>`; }
  };
  document.querySelectorAll('[data-sp-import]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await importBuiltin(b.dataset.spImport);
      toast('已匯入題庫', 'toast-success');
    } catch (e) { toast('匯入失敗：' + spErr(e), 'toast-error'); b.disabled = false; }
  }));
  document.querySelectorAll('[data-sp-export]').forEach(b => b.addEventListener('click', async () => {
    try {
      const json = await exportBuiltinPackJson(b.dataset.spExport);
      const d = new Date().toISOString().slice(0, 10);
      await downloadBlob(json, `teno-pack-${b.dataset.spExport}-${d}.json`, 'application/json');
      toast('已匯出題包', 'toast-success');
    } catch (e) { toast('匯出失敗：' + spErr(e), 'toast-error'); }
  }));
  const spPath = document.getElementById('spLibPath');
  if (spPath) {
    getSetting('webdavLibraryPath').then(v => { spPath.value = v || '/Teno-Library/'; }).catch(() => { spPath.value = '/Teno-Library/'; });
    spPath.addEventListener('change', () => setSetting('webdavLibraryPath', spPath.value.trim() || '/Teno-Library/').catch(() => {}));
  }
  document.getElementById('spLibBrowse')?.addEventListener('click', async () => {
    const box = document.getElementById('spLibList');
    if (!box) return;
    const p = (spPath?.value || '').trim().replace(/^\/+|\/+$/g, '');
    box.innerHTML = '<span style="font-size:12px;color:var(--text-tertiary)">讀取中…</span>';
    try {
      const data = JSON.parse(await webdavCloudList(p || null));
      const es = (Array.isArray(data.entries) ? data.entries : []).filter(e => !e.isdir && /\.json$/i.test(e.name));
      if (!es.length) { box.innerHTML = '<span style="font-size:12px;color:var(--text-tertiary)">此目錄沒有題包檔（.json）</span>'; return; }
      box.innerHTML = es.map((e, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border-subtle)">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--text-primary)">${escapeHtml(e.name)}</span>
          <span class="muted" style="font-size:11px">${e.size >= 1048576 ? (e.size / 1048576).toFixed(1) + ' MB' : e.size >= 1024 ? Math.round(e.size / 1024) + ' KB' : e.size + ' B'}</span>
          <button class="btn btn-xs" data-sp-lib-dl="${i}" style="font-size:11px">下載</button>
        </div>`).join('');
      box.querySelectorAll('[data-sp-lib-dl]').forEach(b => b.addEventListener('click', async () => {
        const e = es[parseInt(b.dataset.spLibDl, 10)];
        if (!e) return;
        b.disabled = true;
        try {
          const json = await webdavCloudGet((p ? p + '/' : '') + e.name);
          parsePack(json);                 // 預儲存前先驗格式（壞包不落地）
          await cachePack(e.name, json);
          toast(`已預儲存 ${e.name}，到上面「已下載」匯入`, 'toast-success');
          renderSpCache();
        } catch (err) { toast('下載失敗：' + spErr(err), 'toast-error'); b.disabled = false; }
      }));
    } catch (e) {
      box.innerHTML = `<span style="font-size:12px;color:var(--red)">${escapeHtml(spErr(e))}</span>`;
    }
  });
  document.getElementById('spOvExport')?.addEventListener('click', async () => {
    try {
      const json = await exportOverlayPackJson();
      const d = new Date().toISOString().slice(0, 10);
      await downloadBlob(json, `teno-pack-grammar-overlay-${d}.json`, 'application/json');
      toast('已匯出自建題', 'toast-success');
    } catch (e) { toast('匯出失敗：' + spErr(e), 'toast-error'); }
  });
  const ovFile = document.getElementById('spOvFile');
  document.getElementById('spOvImport')?.addEventListener('click', () => ovFile?.click());
  ovFile?.addEventListener('change', async () => {
    const f = ovFile.files?.[0];
    ovFile.value = '';
    if (!f) return;
    try {
      await applyPack(await f.text());
      toast('已併入我的題目', 'toast-success');
    } catch (e) { toast('匯入失敗：' + spErr(e), 'toast-error'); }
  });
  renderSpCache();
}

export function renderShelfBlock(s) {
  const shelves = getShelves(s);
  const names = Object.keys(shelves).sort((a, b) => a.localeCompare(b, 'zh-TW'));
  const deckNames = (s.state.decks || []).map(d => d.name).sort((a, b) => a.localeCompare(b, 'zh-TW'));
  const rows = names.map(name => {
    const members = shelves[name] || [];
    const n = shelfWords(s.state.words, members).length;
    const editing = _editingShelf === name;
    const memberChips = members.length
      ? members.map(m => `<span style="font-size:11px;padding:1px 8px;border-radius:8px;background:var(--bg-hover);color:var(--text-secondary)">${escapeHtml(m)}</span>`).join('')
      : '<span class="muted" style="font-size:11px">尚未選字本，點編輯加入</span>';
    const editBox = editing ? `
      <div style="margin-top:var(--s2);padding:var(--s2);border:1px dashed var(--border);border-radius:var(--r-md)">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:var(--s2);flex-wrap:wrap">
          <input id="shelfRenInput" type="text" value="${escapeAttr(name)}" style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
          <button class="btn btn-xs" data-shelf-ren="${escapeAttr(name)}" style="font-size:11px">改名</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${deckNames.map(d => `
            <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);padding:3px 9px;border:1px solid var(--border-subtle);border-radius:12px;cursor:pointer">
              <input type="checkbox" data-shelf-toggle="${escapeAttr(name)}" data-deck="${escapeAttr(d)}" ${members.includes(d) ? 'checked' : ''}>
              ${escapeHtml(d)}
            </label>`).join('') || '<span class="muted" style="font-size:12px">尚無字本，先去設定頁字本管理新增</span>'}
        </div>
      </div>` : '';
    return `
    <div style="padding:8px 0;border-top:1px solid var(--border-subtle)">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="flex:1;font-size:13px;font-weight:700">${escapeHtml(name)}</span>
        <span class="muted" style="font-size:11px;width:64px">${n} 詞</span>
        <button class="btn btn-xs" data-shelf-dl="${escapeAttr(name)}" style="font-size:11px" ${n === 0 ? 'disabled' : ''}>${icon('upload')} 整櫃下載</button>
        <button class="btn btn-xs" data-shelf-pack="${escapeAttr(name)}" style="font-size:11px" ${n === 0 ? 'disabled' : ''} title="含圖打包（words.csv＋media/＋manifest.json）">含圖打包</button>
        <button class="btn btn-xs" data-shelf-edit="${escapeAttr(name)}" style="font-size:11px">${editing ? '完成' : '編輯'}</button>
        <button class="btn btn-xs" data-shelf-del="${escapeAttr(name)}" style="font-size:11px;color:var(--red)">${icon('x')}</button>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">${memberChips}</div>
      ${editBox}
    </div>`;
  }).join('');
  return `
    <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s2)">
      書櫃＝N 個字本的集合包 · 一櫃一點整包下載（內容不含 tag）· 刪櫃不動字本
    </div>
    ${rows || '<div class="muted" style="font-size:12px">尚無書櫃，下面建一個</div>'}
    <div style="display:flex;gap:6px;align-items:center;margin-top:var(--s2)">
      <input id="shelfNewInput" type="text" placeholder="新書櫃名稱，如 TOEFL 系列" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-surface);color:var(--text-primary);font-size:13px">
      <button class="btn btn-sm" id="shelfNewBtn">${icon('plus')} 新增書櫃</button>
    </div>
  `;
}

async function runShareShelf(s, shelfName, btn) {
  const members = getShelves(s)[shelfName] || [];
  const list = shelfWords(s.state.words, members);
  if (list.length === 0) { toast('這櫃沒有單字', 'toast-warn'); return; }
  if (btn) btn.disabled = true;
  try {
    await saveShareCSV(list, '書櫃-' + shelfName);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// SHAREPACK1: 整櫃含圖打包（words.csv＋media/＋manifest.json；圖走 word_images 表，CSV 的 image 欄不帶）
async function runSharePackShelf(s, shelfName, btn) {
  const members = getShelves(s)[shelfName] || [];
  const list = shelfWords(s.state.words, members);
  if (list.length === 0) { toast('這櫃沒有單字', 'toast-warn'); return; }
  if (btn) btn.disabled = true;
  try {
    await saveSharePack(list, '書櫃-' + shelfName);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderShareContent(s) {
  const words = s.state.words || [];
  const counts = new Map();
  for (const w of words) counts.set(w.deck || 'Default', (counts.get(w.deck || 'Default') || 0) + 1);
  const decks = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-TW'));
  const rows = decks.map(([name, n]) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border-subtle)">
      <span style="flex:1;font-size:13px;color:var(--text-primary)">${escapeHtml(name)}</span>
      <span class="muted" style="font-size:11px;width:60px">${n} 詞</span>
      <button class="btn btn-xs" data-share-deck="${escapeAttr(name)}" style="font-size:11px">${icon('upload')} 下載</button>
      <button class="btn btn-xs" data-share-pack-deck="${escapeAttr(name)}" style="font-size:11px" title="含圖打包（words.csv＋media/＋manifest.json）">打包</button>
    </div>`).join('');
  return `
    <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:var(--s2)">
      內容資料 only，不含 tag · 點下面任何一本直接存成 <span style="font-family:var(--mono)">teno-share-*.csv</span>，丟給別人匯入就吃得到
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0">
      <span style="flex:1;font-size:13px;font-weight:700">全部字本</span>
      <span class="muted" style="font-size:11px;width:60px">${words.length} 詞</span>
      <button class="btn btn-xs" data-share-deck="" style="font-size:11px">${icon('upload')} 下載</button>
    </div>
    ${rows || '<div class="muted" style="font-size:12px">尚無單字</div>'}
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--s3);margin-top:var(--s2);padding-top:var(--s2);border-top:1px solid var(--border-subtle)">
      <div style="font-size:12px;color:var(--text-tertiary)">
        上面篩選（${_deckFilter ? '「' + escapeHtml(_deckFilter) + '」' : '全部'} · ${filterWords(words).length} 詞）另外存一份
      </div>
      <button class="btn-primary" id="shareRunBtn" ${filterWords(words).length === 0 ? 'disabled' : ''}>
        ${icon('upload')} 分享下載
      </button>
      <button class="btn" id="sharePackRunBtn" ${filterWords(words).length === 0 ? 'disabled' : ''} title="含圖打包（words.csv＋media/＋manifest.json）">
        含圖打包
      </button>
    </div>
  `;
}

async function runShareDeck(s, deckName, btn) {
  const list = (deckName ? s.state.words.filter(w => (w.deck || 'Default') === deckName) : [...s.state.words])
    .sort((a, b) => (a.word || '').localeCompare(b.word || ''));
  if (list.length === 0) { toast('這本沒有單字', 'toast-warn'); return; }
  if (btn) btn.disabled = true;
  try {
    await saveShareCSV(list, deckName || '全部字本');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// SHAREPACK1: 單本／全部含圖打包（與 runShareDeck 同名單，改走 zip）
async function runSharePackDeck(s, deckName, btn) {
  const list = (deckName ? s.state.words.filter(w => (w.deck || 'Default') === deckName) : [...s.state.words])
    .sort((a, b) => (a.word || '').localeCompare(b.word || ''));
  if (list.length === 0) { toast('這本沒有單字', 'toast-warn'); return; }
  if (btn) btn.disabled = true;
  try {
    await saveSharePack(list, deckName || '全部字本');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// SHAREPACK1: 打包存檔（CSV image 欄留空避開舊欄遷移副作用；圖以 manifest 為準）
// 回傳 Rust JSON {path, images, skipped}；Android 回檔名（MediaStore 直寫）。
async function saveSharePack(list, packLabel) {
  const csv = buildShareCSV(list.map(w => ({
    word: w.word, definition: w.definition, pos: w.pos, pron: w.pron,
    example: w.example, deck: w.deck, image: '',
    description: w.description, related: w.related, forms: w.forms,
    synonym: w.synonym, antonym: w.antonym, derivative: w.derivative, examples: w.examples,
    etymology: w.etymology, syllables: w.syllables, phrases: w.phrases,
  })));

  const stamp = new Date().toISOString().slice(0, 10);
  const packTag = '-' + String(packLabel).replace(/[^\w\u4e00-\u9fff]/g, '_').slice(0, 24);
  const fname = `teno-pack${packTag}-${stamp}.zip`;
  const wordIds = list.map(w => w.id).filter(Boolean);

  try {
    const raw = await exportSharePack(csv, fname, wordIds);
    let info = null;
    try { info = JSON.parse(raw); } catch (_) {}
    // 網站版回 {b64,...} → 解碼瀏覽器下載（桌面 dialog 路不變）
    if (info && info.b64) {
      const bin = atob(info.b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      await downloadBlobFromArray(u8, fname, 'application/zip');
    }
    const detail = info
      ? `${list.length} 詞${info.images ? `＋${info.images} 圖` : '（無圖）'}${info.skipped ? `（${info.skipped} 張跳過）` : ''} → ${info.path}${info.b64 ? '（已下載）' : ''}`
      : `${list.length} 詞 → ${raw}`;
    toast(`已打包 ${detail}`, 'toast-success');
  } catch (e) {
    if (e !== '使用者取消') toast('打包失敗: ' + e, 'toast-error');
  }
}

async function saveShareCSV(list, deckLabel) {
  const csv = buildShareCSV(list.map(w => ({
    word: w.word, definition: w.definition, pos: w.pos, pron: w.pron,
    example: w.example, deck: w.deck, image: w.image,
    description: w.description, related: w.related, forms: w.forms,
    synonym: w.synonym, antonym: w.antonym, derivative: w.derivative, examples: w.examples,
    etymology: w.etymology, syllables: w.syllables, phrases: w.phrases,
  })));

  const stamp = new Date().toISOString().slice(0, 10);
  const deckTag = '-' + String(deckLabel).replace(/[^\w\u4e00-\u9fff]/g, '_').slice(0, 24);
  const fname = `teno-share${deckTag}-${stamp}.csv`;

  try {
    if (isAndroid || isWeb) {
      downloadBlob('\uFEFF' + csv, fname, 'text/csv');
      toast(`已分享 ${list.length} 詞（不含 tag）`, 'toast-success');
    } else {
      const path = await exportCsvDialog(csv, fname);
      toast(`已分享 ${list.length} 詞（不含 tag） → ${path}`, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('分享失敗: ' + e, 'toast-error');
  }
}

async function runShareExport(s) {
  const filtered = filterWords(s.state.words);
  if (filtered.length === 0) { toast('沒有資料可分享', 'toast-error'); return; }
  await saveShareCSV(filtered, _deckFilter || '全部字本');
}

async function runExport(s) {
  const words = s.state.words;
  const filtered = filterWords(words);
  if (filtered.length === 0) { toast('沒有資料可匯出', 'toast-error'); return; }

  const csv = buildCSV(filtered.map(w => ({
    word: w.word, definition: w.definition, pos: w.pos, pron: w.pron,
    example: w.example, deck: w.deck, image: w.image, tags: w.tags,
    description: w.description, related: w.related, forms: w.forms,
    synonym: w.synonym, antonym: w.antonym, derivative: w.derivative, examples: w.examples,
    etymology: w.etymology, syllables: w.syllables, phrases: w.phrases,
  })));

  const stamp = new Date().toISOString().slice(0, 10);
  const deckTag = _deckFilter ? '-' + _deckFilter.replace(/[^\w\u4e00-\u9fff]/g, '_') : '';
  const fname = `teno-export${deckTag}-${stamp}.csv`;

  try {
    if (isAndroid || isWeb) {
      downloadBlob('\uFEFF' + csv, fname, 'text/csv');
      toast(`已匯出 ${filtered.length} 詞`, 'toast-success');
    } else {
      const path = await exportCsvDialog(csv, fname);
      toast(`已匯出 ${filtered.length} 詞 → ${path}`, 'toast-success');
    }
  } catch (e) {
    if (e !== '使用者取消') toast('匯出失敗: ' + e, 'toast-error');
  }
}

function renderInPlace(s) {
  const container = document.getElementById('pageContainer');
  if (container) {
    container.innerHTML = render(s);
    onMount(s);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
