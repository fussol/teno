# Teno 程式碼快照（唯讀，tools/main/db/api 全文＋store/lib.rs 重點節錄）

## 檔案樹
src/core/exam-session.js
src/core/filterEngine.js
src/core/fsrs.js
src/core/fsrs-optimizer.js
src/core/import.js
src/core/scheduler.js
src/core/simulator.js
src/engine/guides-v3.js
src/engine/session-mc-utils.js
src/engine/session-spell-utils.js
src/engine/session-utils.js
src/engine/session-v4.js
src/lib/api.js
src/lib/app-log.js
src/lib/backup-scheduler.js
src/lib/chart.js
src/lib/custom-select.js
src/lib/db.js
src/lib/deprecated/sim-behavior.js
src/lib/dictionary.js
src/lib/easter-eggs.js
src/lib/human-data.js
src/lib/icon-presets.js
src/lib/platform.js
src/lib/rng.js
src/lib/store.js
src/lib/svg.js
src/lib/theme.js
src/lib/tts.js
src/main.js
src/pages/app-log.js
src/pages/browser.js
src/pages/dashboard.js
src/pages/deck-browser.js
src/pages/exam-flip.js
src/pages/exam.js
src/pages/exam-mc.js
src/pages/exam-spell.js
src/pages/export.js
src/pages/import.js
src/pages/settings.js
src/pages/simulator.js
src/pages/study.js
src/pages/study-mc.js
src/pages/study-spell.js
src/pages/study-v4.js
src/pages/tag-manager.js
src/pages/tools.js
src-tauri/capabilities/default.json
src-tauri/src/drive_sync.rs
src-tauri/src/icon_android.rs
src-tauri/src/lib.rs
src-tauri/src/main.rs
src-tauri/src/tts_android.rs

## FILE: index.html
''
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0911">
<title>Teno - Era 5</title>
<link rel="stylesheet" href="/src/styles/base.css">
</head>
<body>
<div id="splash">
  <div class="splash-inner">
    <img class="splash-icon" id="splashIcon" src="/icons/icon-original.png" alt="Teno">
    <div class="splash-name">Teno</div>
    <div class="splash-spinner"></div>
  </div>
</div>
<div id="app"></div>
<div class="sidebar-backdrop" id="sidebarBackdrop"></div>
<div class="toast-container" id="toastContainer"></div>
<script type="module" src="/src/main.js"></script>
</body>
</html>
''

## FILE: src/main.js
''
// ═══════════════════════════════════════════════════════════════
// Main — Entry point. Creates store, mounts app shell, routes pages.
// v05.01.00.0010
// ═══════════════════════════════════════════════════════════════

import { createStore } from './lib/store.js';
import { icon } from './lib/svg.js';
import { computeStreak } from './core/scheduler.js';
import { initCustomSelects } from './lib/custom-select.js';
import { invoke } from '@tauri-apps/api/core';
import { logToDb } from './lib/app-log.js';
import { ICON_PRESETS, iconImgPath } from './lib/icon-presets.js';

// ─── Splash：至少顯示 SPLASH_MIN_MS（蓋住久一點）+ 跟隨目前 launcher icon ───
const SPLASH_MIN_MS = 1600;
const _splashStart = Date.now();

/** 把 splash 背景 + 圖示切到指定 icon preset。 */
function applySplashIcon(key) {
  try {
    const splash = $('splash');
    if (!splash) return;
    const preset = ICON_PRESETS.find(p => p.key === key) || ICON_PRESETS[0];
    splash.style.background = preset.bg;
    const img = document.getElementById('splashIcon');
    if (img) img.src = iconImgPath(preset.key);
  } catch (e) { console.error('[main] splash icon:', e); }
}

// Splash 一進場就立刻讀 launcherIcon（不等完整 init — 冷啟動時 init
// 可能超過 SPLASH_MIN_MS，等 init 完 splash 早就 fade 了）。
// 第一優先：Rust getLauncherIcon（resolve LAUNCHER intent，最準最快）
// 第二優先：DB setting（非 Android 或 plugin 未註冊時 fallback）
(async () => {
  try {
    const { getLauncherIcon } = await import('./lib/api.js');
    const key = await getLauncherIcon();
    if (key) { applySplashIcon(key); return; }
  } catch { /* fallthrough to DB */ }
  try {
    const { initDB, getSetting } = await import('./lib/db.js');
    await initDB(2);
    const key = await getSetting('launcherIcon');
    applySplashIcon(key || 'original');
  } catch { applySplashIcon('original'); }
})();

// ─── Debug: forward console.log to file (via Rust) + DB (app_log) ───
try {
  const fwd = (level) => (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    invoke('log_msg', { msg: `[${level}] ${msg}` }).catch(() => {});
    logToDb(level, msg);
  };
  console.log = fwd('log');
  console.warn = fwd('warn');
  console.error = fwd('error');
  invoke('log_msg', { msg: '[boot] console forwarding enabled' }).catch(() => {});
  logToDb('log', '[boot] console forwarding enabled');
} catch (_) {}

// ─── Create store (single source of truth) ───
export const store = createStore();

// ─── Lazy page imports ───
const pages = {};

async function loadPage(name) {
  if (!pages[name]) {
    pages[name] = await import(`./pages/${name}.js`);
  }
  return pages[name];
}

// ─── Mount app ───
const $ = (id) => document.getElementById(id);
const app = $('app');

const PAGE_NAMES = {
  dashboard: '儀表板', study: '學習',
  'study-v4': '翻卡學習', 'study-mc': '多選學習', 'study-spell': '拼字學習',
  exam: '測驗',
  'exam-flip': '翻卡測驗', 'exam-mc': '多選測驗', 'exam-spell': '拼字測驗',
  simulator: '模擬', settings: '設定', tools: '工具', browser: '字庫',
  'deck-browser': '字本', 'app-log': '操作日誌',
};

function renderSidebar() {
  const s = store.state;
  const decks = s.decks;
  const due = s.dueCount;
  const current = s.currentPage;
  const total = s.stats.total;
  const activeDeck = s.reviewDeckFilter;

  const homeItem = { id: 'dashboard', label: '儀表板', icon: 'home' };

  const totalDue = due + s.dueCountMc + s.dueCountSpell;
  const deckCounts = {};
  for (const w of s.words) {
    deckCounts[w.deck] = (deckCounts[w.deck] || 0) + 1;
  }

  const navItems = [
    homeItem,
    { id: 'study', label: '學習', icon: 'bookOpen', badge: totalDue > 0 ? totalDue : null },
    { id: 'exam', label: '測驗', icon: 'scrollText' },
    { id: 'browser',   label: '字庫', icon: 'list' },
    { id: 'settings', label: '設定', icon: 'settings' },
    { id: 'tools',    label: '工具', icon: 'tools',
      badge: (s.backgroundTasks || []).filter(t => t.status === 'running').length || null },
  ];

  const navItemHtml = (n) => `
    <div class="nav-item ${current === n.id ? 'active' : ''}" data-page="${n.id}">
      ${icon(n.icon)}
      <span>${n.label}</span>
      ${n.badge != null ? `<span class="badge">${n.badge}</span>` : ''}
    </div>
  `;

  let html = `
    <div class="sidebar-header">
      <div class="sidebar-logo">T</div>
      <h1>Teno</h1>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-group">
        ${navItems.map(navItemHtml).join('')}
      </div>
      <div class="deck-section">
        <div class="deck-section-header">
          <span class="deck-section-title">字本</span>
          <div class="deck-section-tools">
            <button id="sidebarAddDeck" title="管理字本">
              ${icon('plus')}
            </button>
          </div>
        </div>
        ${decks.length > 0 ? `
          <div style="font-size:11px;color:var(--text-tertiary);padding:0 var(--s3) var(--s2);font-weight:500">
            ${total} 詞 · ${decks.length} 字本
          </div>
          ${decks.map(d => {
            const count = deckCounts[d.name] || 0;
            const isActive = activeDeck === d.name;
            return `
              <div class="deck-item ${isActive ? 'active' : ''}" data-deck="${d.name}" title="${d.name}">
                <span class="dot" style="color:${d.color};background:${d.color}"></span>
                <span>${d.name}</span>
                <span class="count">${count}</span>
              </div>
            `;
          }).join('')}
        ` : `
          <div style="padding:var(--s4) var(--s3);font-size:12px;color:var(--text-tertiary);text-align:center">
            尚無字本
          </div>
        `}
      </div>
    </nav>
  `;

  return html;
}

function allStreakDates() {
  const d = store.state.goalStreak.dates || {};
  const all = [...(d.flip || []), ...(d.mc || []), ...(d.spell || [])];
  return [...new Set(all)].sort();
}

function renderTopbar() {
  const streak = computeStreak(allStreakDates(), store.state.dayCutoff);
  return `
    <div class="topbar-left">
      <button class="sidebar-reopen" id="sidebarReopen">${icon('menu')}</button>
    </div>
    <div class="topbar-right">
      <span class="topbar-streak">${icon('flame')} <span id="streakDisplay">${streak}</span></span>
    </div>
  `;
}

function renderAppShell() {
  const current = store.state.currentPage;
  const s = store.state;
  const totalDue = (s.dueCount || 0) + (s.dueCountMc || 0) + (s.dueCountSpell || 0);
  const bottomItems = [
    { id: 'dashboard', icon: 'home' },
    { id: 'study', icon: 'galleryHorizontalEnd', badge: totalDue > 0 ? totalDue : null },
    { id: 'browser', icon: 'list' },
    { id: 'tools', icon: 'tools' },
    { id: 'settings', icon: 'settings' },
  ];
  app.innerHTML = `
    <div class="sidebar${window.innerWidth < 768 ? ' hidden' : ''}" id="sidebar">${renderSidebar()}</div>
    <div class="main">
      <div class="topbar" id="topbar">${renderTopbar()}</div>
      <div class="content-area" id="contentArea">
        <div class="page active" id="pageContainer"></div>
      </div>
    </div>
    <div class="bottom-bar" id="bottomBar">
      ${bottomItems.map(n => `
        <div class="bottom-item ${current === n.id ? 'active' : ''}" data-page="${n.id}">
          ${icon(n.icon)}
          ${n.badge != null ? `<span class="bottom-badge">${n.badge}</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;

  // Sidebar toggle — delegation on topbar (re-rendered on nav)
  document.getElementById('topbar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('#sidebarReopen');
    if (!btn) return;
    if (document.getElementById('deckCardPreview') || document.getElementById('cardPreviewModal')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
    const sidebar = $('sidebar');
    const backdrop = $('sidebarBackdrop');
    const isNowHidden = sidebar.classList.toggle('hidden');
    backdrop.classList.toggle('show', !isNowHidden && window.innerWidth < 768);
  });

  $('sidebarBackdrop').addEventListener('click', () => {
    $('sidebar').classList.add('hidden');
    $('sidebarBackdrop').classList.remove('show');
  });

  // Nav clicks
  bindNav();
  // Bottom bar clicks
  document.querySelectorAll('.bottom-item[data-page]').forEach(el => {
    el.addEventListener('click', () => store.actions.navigate(el.dataset.page));
  });
}

function bindNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => {
      // B10: 標記本次導航來自 sidebar（exam 頁的 __pageCleanup 消費後，renderPage 清除）
      //      self-nav（點目前所在頁）不設標記 — 無 page change → renderPage 不跑 → 標記若殘留
      //      之後 bottom-nav 離開測驗會誤觸發存檔（bottom-nav 續答是 B1/B2 既有行為）
      if (el.dataset.page !== store.state.currentPage) window.__navFromSidebar = true;
      store.actions.navigate(el.dataset.page);
    });
  });
  // Deck clicks → go to deck-browser locked to that deck
  document.querySelectorAll('.deck-item[data-deck]').forEach(el => {
    el.addEventListener('click', () => {
      store.state.browserDeckFilter = el.dataset.deck;
      store.state.browserDeckLock = true;
      if (store.state.currentPage === 'deck-browser') {
        _forceRender = true;
      }
      window.__navFromSidebar = true;   // B10: sidebar deck-item 導航（renderPage 一律清除，_forceRender 亦會跑 renderPage）
      store.actions.navigate('deck-browser');
    });
  });
  const addDeck = $('sidebarAddDeck');
  if (addDeck) addDeck.addEventListener('click', () => {
    store.state._pendingDeckModal = true;
    window.__navFromSidebar = true;   // B10: sidebar「管理字本」導航
    store.actions.navigate('settings');
  });
}

// ─── Toast system ───
export function toast(message, type = '') {
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; setTimeout(() => el.remove(), 300); }, 2600);
}

// ─── Render current page ───
async function renderPage() {
  const page = store.state.currentPage;
  const container = $('pageContainer');
  container.className = 'page active';

  // Update sidebar active state + topbar
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  $('topbar').innerHTML = renderTopbar();

  // Run cleanup from previous page (keyboard shortcuts, etc.)
  if (window.__pageCleanup) {
    try { window.__pageCleanup(); } catch (e) { console.warn('Page cleanup error:', e); }
    delete window.__pageCleanup;
  }
  delete window.__navFromSidebar;   // B10: 清除 sidebar 導航標記（防跨頁殘留 → 誤觸發 exam saveOnLeave）

  // Load and render page
  try {
    const mod = await loadPage(page);
    if (typeof mod.render === 'function') {
      const rendered = mod.render(store);
      container.innerHTML = rendered ?? '';
      if (typeof mod.onMount === 'function') mod.onMount(store);
      initCustomSelects(container);
    }
  } catch (e) {
    console.error('Page load error:', e);
    container.innerHTML = `<div class="empty-state">
      ${icon('info')}
      <h3>載入失敗</h3>
      <p>${e.message}</p>
    </div>`;
  }
}

// ─── Subscribe store — keep sidebar/topbar in sync ───
let _prevSidebarKey = '';
store.subscribe((state) => {
  const key = JSON.stringify([state.decks, state.dueCount, state.dueCountMc, state.dueCountSpell, state.currentPage, state.stats.total, state.reviewDeckFilter, state.backgroundTasks?.length, state.words?.length, state.dayCutoff, allStreakDates()]);
  if (key === _prevSidebarKey) return;
  _prevSidebarKey = key;

  const sidebar = $('sidebar');
  if (sidebar) {
    const nav = sidebar.querySelector('.sidebar-nav');
    const st = nav?.scrollTop || 0;
    sidebar.innerHTML = renderSidebar();
    const nn = sidebar.querySelector('.sidebar-nav');
    if (nn) nn.scrollTop = st;
    bindNav();
  }

  const streakEl = $('streakDisplay');
  if (streakEl) streakEl.textContent = computeStreak(allStreakDates(), state.dayCutoff);

  // Update bottom bar active state
  const bottomBar = $('bottomBar');
  if (bottomBar) {
    bottomBar.querySelectorAll('.bottom-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === state.currentPage);
    });
  }
});

// ─── Watch for page navigation — only re-render on page change ───
let _lastPage = 'dashboard';
let _forceRender = false;
store.subscribe((state) => {
  if (state.currentPage !== _lastPage || _forceRender) {
    _forceRender = false;
    _lastPage = state.currentPage;
    cancelAnimationFrame(renderPage._raf);
    renderPage._raf = requestAnimationFrame(renderPage);
    // Auto-close sidebar on navigation for narrow screens
    if (window.innerWidth < 768) {
      $('sidebar')?.classList.add('hidden');
      $('sidebarBackdrop')?.classList.remove('show');
    }
    // Track page navigation for human mode
    import('./lib/human-data.js').then(hd => hd.track('page:' + state.currentPage));
  }
});

// ─── Init ───
(async () => {
  import('./lib/easter-eggs.js').then(m => m.initKonami());
  renderAppShell();

  // Show a loading state while the store boots (DB load + seed)
  const boot = $('pageContainer');
  if (boot) boot.innerHTML = `
    <div class="boot-state">
      <div class="boot-spinner"></div>
      <div class="boot-label">載入中…</div>
    </div>`;

  // Seed data from DB (lazy import so main.js stays small)
  try {
    await store.actions.init();
  } catch (e) {
    console.error('[main] init error:', e);
  }

  renderPage();

  // Splash 退場：首頁 render 完成後 fade out（至少顯示 SPLASH_MIN_MS）
  const splash = $('splash');
  if (splash) {
    // 背景色 + 圖片跟隨目前 launcher icon
    try {
      const key = store.state.launcherIcon || 'original';
      const preset = ICON_PRESETS.find(p => p.key === key) || ICON_PRESETS[0];
      splash.style.background = preset.bg;
      const img = document.getElementById('splashIcon');
      if (img) img.src = iconImgPath(key);
    } catch (e) { console.error('[main] splash icon:', e); }
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - _splashStart));
    setTimeout(() => {
      splash.classList.add('fade-out');
      setTimeout(() => splash.remove(), 500);
    }, wait);
  }

  // Apply saved theme (mode + accent) after settings are fully loaded
  const { applyTheme } = await import('./lib/theme.js');
  applyTheme(store.state.themeMode, store.state.themeAccent, store.state.themeAccentIntensity);

  // Show a non-blocking toast if DB isn't available
  if (!(await import('./lib/db.js')).isReady()) {
    toast('資料庫無法連線，部分功能可能受限', 'toast-error');
  }
})();

// ─── F11 fullscreen ───
document.addEventListener('keydown', async (e) => {
  if (e.key === 'F11') {
    e.preventDefault();
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  }
});

// ─── A5: 跨天自動 unbury — Android 背景化過夜 resume 的補檢查（guard 一天一次）───
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    store._autoUnburyIfNewDay?.().catch(e => console.warn('[main] autoUnbury:', e));
  }
});

// ─── Make actions globally available for inline handlers ───
window.toast = toast;
window.actions = {
  navigate: (page) => store.actions.navigate(page),
};

// ─── Android back：原生層（MainActivity）攔截後呼叫這裡 ───
// 有上一頁就回去；沒有就退出 app（F1：invoke('finish_app') → Rust → Kotlin finishAndRemoveTask。
// 舊 getCurrentWindow().close() 在 Android WebView 無 Activity finish 語意 → back 退不出去）
window.__handleAndroidBack = async () => {
  try {
    if (store.actions.goBack()) return;
    await invoke('finish_app');
  } catch (e) {
    console.error('[main] android back:', e);
  }
};
''

## FILE: src/pages/tools.js
''
import { icon } from '../lib/svg.js';
import { toast } from '../main.js';
import { fetchGet, fetchLLM, lookupCambridge } from '../lib/api.js';

export function render(s) {
  const tasks = s.state.backgroundTasks || [];
  const running = tasks.filter(t => t.status === 'running');
  const done = tasks.filter(t => t.status !== 'running');
  const _selHtml = (id, opts, fallback) => `<div class="cs" id="${id}Cs"><button class="cs-t" data-id="${id}" data-value="${fallback}">${opts.find(o=>o[1]===fallback)[0]}<svg class="cs-a" width="10" height="6" viewBox="0 0 10 6"><path d="M0 0l5 6 5-6z" fill="#888"/></svg></button><div class="cs-m">${opts.map(o=>`<div class="cs-o${o[1]===fallback?' s':''}" data-value="${o[1]}">${o[0]}</div>`).join('')}</div></div>`;
  return `
    <style>
      .tool-progress{display:flex;align-items:center;gap:var(--s2);margin-top:var(--s2)}
      .tool-progress-bar{height:6px;background:var(--accent);border-radius:3px;transition:width .2s;max-width:100%}
      .tool-progress span{font-size:12px;color:var(--text-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
      .task-item{display:flex;align-items:center;gap:var(--s2);padding:6px 8px;margin-bottom:4px;background:var(--bg-secondary);border-radius:var(--r1);font-size:13px}
      .task-item .task-label{flex:1;color:var(--text-primary)}
      .task-item .task-status{font-size:11px;color:var(--text-tertiary)}
      .task-item .task-dismiss{cursor:pointer;color:var(--text-tertiary);font-size:16px;line-height:1;padding:0 4px}
      .task-item .task-dismiss:hover{color:var(--text-primary)}
      .tool-row{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
      .cs{position:relative;font-size:12px;min-height:30px;flex-shrink:0}
      .cs-t{display:flex;align-items:center;gap:6px;width:100%;height:100%;padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);cursor:pointer;white-space:nowrap;transition:border-color .15s;font-family:inherit;font-size:inherit}
      .cs-t:hover,.cs.o .cs-t{border-color:var(--accent)}
      .cs-a{margin-left:auto;transition:transform .15s;flex-shrink:0}
      .cs.o .cs-a{transform:rotate(180deg)}
      .cs-m{display:none;position:absolute;top:100%;left:0;right:0;margin-top:2px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);overflow:hidden;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3)}
      .cs.o .cs-m{display:block}
      .cs-o{padding:6px 10px;cursor:pointer;color:var(--text-primary);transition:background .1s}
      .cs-o:hover{background:var(--bg-hover)}
      .cs-o.s{color:var(--accent);font-weight:600}
    </style>
    <div class="page-title">${icon('tools')} 工具</div>
    <div class="page-subtitle">輔助工具，幫你整理單字庫</div>

    <div class="section">
      <div class="section-title">${icon('chart')} 學習分析</div>
      <div class="card card-interactive" id="toolsGoSimulator" style="cursor:pointer">
        <div style="display:flex;align-items:center;gap:var(--s3)">
          <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--accent-container);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--accent);flex-shrink:0">${icon('chart')}</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary)">學習分析</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">成熟度、複習統計、評分分布、模擬圖表</div>
          </div>
          <span style="margin-left:auto;color:var(--text-tertiary);font-size:18px">${icon('chevron-right')}</span>
        </div>
      </div>
      ${s.state.devMode ? `
      <div class="card card-interactive" id="toolsGoAppLog" style="cursor:pointer;margin-top:var(--s3)">
        <div style="display:flex;align-items:center;gap:var(--s3)">
          <div style="width:40px;height:40px;border-radius:var(--r-md);background:var(--green-container, var(--accent-container));display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--green, var(--accent));flex-shrink:0">${icon('list')}</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-primary)">操作日誌</div>
            <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">操作記錄與模擬歷史 (隔離 DB)</div>
          </div>
          <span style="margin-left:auto;color:var(--text-tertiary);font-size:18px">${icon('chevron-right')}</span>
        </div>
      </div>
      ` : ''}
    </div>

    <div class="section" id="bgTaskSection">
      <div class="section-title">${icon('activity')} 背景任務</div>
      <div class="config-section" id="bgTaskConfig">
        ${running.map(t => `
          <div class="task-item" data-task-id="${t.id}">
            <span class="task-label">${t.label}</span>
            <div style="flex:1;max-width:200px">
              <div style="display:flex;align-items:center;gap:6px">
                <div style="flex:1;height:6px;background:var(--bg-base);border-radius:3px;overflow:hidden">
                  <div class="task-progress-fill" style="width:${t.total > 0 ? (t.done / t.total * 100) : 0}%;height:100%;background:var(--accent);border-radius:3px;transition:width .3s"></div>
                </div>
                <span class="task-status">${t.done}/${t.total}</span>
              </div>
            </div>
            <span style="color:var(--accent);font-size:11px">進行中...</span>
          </div>
        `).join('')}
        ${done.map(t => `
          <div class="task-item" data-task-id="${t.id}" style="opacity:.7">
            <span class="task-label">${t.label}</span>
            <span class="task-status" style="color:${t.status === 'failed' ? 'var(--red)' : 'var(--green)'}">${t.status === 'failed' ? '失敗' : '完成'} (${t.total} 筆)</span>
            <span class="task-dismiss" data-dismiss="${t.id}">×</span>
          </div>
          ${t.result && t.result.type === 'spellcheck' ? renderSpellResult(t.result) : ''}
          ${t.result && t.result.type === 'summary' ? `
          <div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r1);font-size:12px;color:var(--text-secondary)">${t.result.message}</div>
          ` : ''}
        `).join('')}
      </div>
    </div>

    <!-- Duplicate Finder -->
    <div class="section">
      <div class="section-title">${icon('search')} 尋找重複</div>
      <div class="config-section">
        <button class="btn" onclick="window.__findIssues()">${icon('search')} 開始掃描</button>
        <div class="tool-output" id="issuesResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Spell Check -->
    <div class="section">
      <div class="section-title">${icon('edit')} 拼字檢查</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 檢查單字拼字是否正確
        </div>
        <button class="btn" onclick="window.__spellCheckLLM()">${icon('edit')} 開始檢查</button>
        <div class="tool-output" id="spellResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Part of Speech -->
    <div class="section">
      <div class="section-title">${icon('hash')} 自動產生詞性</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          為缺少詞性的單字自動補上
        </div>
        <div class="tool-row" style="margin-bottom:var(--s2)">
          ${_selHtml('posMethod', [['Cambridge 字典','cambridge'],['本地 LLM','llm']], 'cambridge')}
          <button class="btn" onclick="window.__genPos()">${icon('hash')} 開始產生</button>
        </div>
        <div class="tool-output" id="posResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Examples -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生例句</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          為沒有例句的單字產生例句，或翻譯現有例句為中文
        </div>
          <div style="display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s2);flex-wrap:wrap">
          ${_selHtml('exampleMethod', [['字典 API','dictionary-api'],['Cambridge 字典','cambridge'],['Tatoeba 例句','tatoeba'],['本地 LLM','llm']], 'dictionary-api')}
          <button class="btn" onclick="window.__genExamples()">${icon('sparkle')} 開始產生</button>
        </div>
        <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2);align-items:center;flex-wrap:wrap">
          <label style="font-size:12px;white-space:nowrap;flex-shrink:0">少於</label>
          <input id="exampleThreshold" type="number" value="2" min="1"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句就新增</label>
          <input id="exampleCount" type="number" value="2" min="1"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句＆顯示最多</label>
          <input id="exampleDisplayMax" type="number" value="0" min="0"
            style="width:50px;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);text-align:center">
          <label style="font-size:12px;white-space:nowrap">句(0=全顯示)</label>
        </div>
        <div id="llmUrlRow" style="display:none;margin-bottom:var(--s2)">
          <div style="display:flex;gap:var(--s2);margin-bottom:4px">
            <input id="llmUrl" type="text" value="http://localhost:11434/api/generate" placeholder="Ollama API 網址"
              style="flex:2;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
            <input id="llmModel" type="text" value="" placeholder="模型名稱 (留空自動偵測)"
              style="flex:1;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary)">
          </div>
        </div>
        <div class="tool-output" id="examplesResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Fetch Pronunciation -->
    <div class="section">
      <div class="section-title">${icon('mic')} 自動抓取發音</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          為缺少音標的單字自動補上
        </div>
        <div class="tool-row" style="margin-bottom:var(--s2)">
          ${_selHtml('pronMethod', [['Cambridge 字典','cambridge']], 'cambridge')}
          <button class="btn" onclick="window.__genPronunciations()">${icon('mic')} 開始抓取</button>
        </div>
        <div class="tool-output" id="pronResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Related Words -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生相關詞</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 為缺少相關詞（同義詞、近似詞）的單字自動生成
        </div>
        <button class="btn" onclick="window.__genRelatedLLM()">${icon('sparkle')} 開始產生</button>
        <div class="tool-output" id="relatedResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Generate Forms -->
    <div class="section">
      <div class="section-title">${icon('sparkle')} 自動產生詞形變化</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          用 LLM 為缺少詞形變化（過去式、-ing、-ed、派生名詞等）的單字自動生成
        </div>
        <button class="btn" onclick="window.__genFormsLLM()">${icon('sparkle')} 開始產生</button>
        <div class="tool-output" id="formsResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>

    <!-- Cambridge Dictionary -->
    <div class="section">
      <div class="section-title">${icon('book')} Cambridge 字典查詢</div>
      <div class="config-section">
        <div style="margin-bottom:var(--s2);font-size:13px;color:var(--text-tertiary)">
          從 Cambridge Dictionary 查詢單字定義、IPA、例句
        </div>
         <div style="display:flex;gap:var(--s2);margin-bottom:var(--s2)">
           ${_selHtml('cambridgeDict', [['英英','en'],['英中','zh']], 'en')}
            <input id="cambridgeWord" type="text" placeholder="輸入英文單字"
              style="flex:1;min-width:0;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);box-sizing:border-box">
           <button class="btn" onclick="window.__lookupCambridge()">${icon('search')} 查詢</button>
         </div>
        <div class="tool-output" id="cambridgeResult" style="margin-top:var(--s3);display:none"></div>
      </div>
    </div>
  `;
}

function renderSpellResult(r) {
  if (!r.entries || !r.entries.length) return `<div style="padding:6px 8px;margin:4px 0 4px 24px;background:var(--bg-base);border-radius:var(--r1);font-size:12px;color:var(--green)">${icon('check')} 所有單字拼字正確！</div>`;
  let html = `<div style="margin:4px 0 4px 24px;padding:6px 8px;background:var(--bg-base);border-radius:var(--r1)"><div style="margin-bottom:4px;font-size:12px;color:var(--text-secondary)">發現 ${r.entries.length} 個可能拼錯的單字：</div>`;
  for (const e of r.entries) {
    html += `<div style="display:flex;align-items:center;gap:var(--s2);padding:4px 6px;margin-bottom:2px;background:var(--bg-secondary);border-radius:var(--r1);font-size:13px">
      <span style="flex:1;color:var(--red);text-decoration:line-through">${e.wrong}</span>
      <span style="font-size:12px;color:var(--text-tertiary)">→</span>
      <span style="flex:1;color:var(--green);font-weight:600">${e.right}</span>
      <span style="font-size:11px;color:var(--text-quaternary)">${e.count} 筆</span>
      <button class="btn btn-sm spell-apply" data-wrong="${e.wrong}" data-right="${e.right}" style="font-size:11px;padding:2px 10px">套用</button>
    </div>`;
  }
  html += `<button class="btn" id="spellApplyAll" style="margin-top:4px;font-size:11px">${icon('check')} 全部套用</button></div>`;
  return html;
}

export function onMount(s) {
  document.getElementById('toolsGoSimulator')?.addEventListener('click', () => s.actions.navigate('simulator'));
  document.getElementById('toolsGoAppLog')?.addEventListener('click', () => s.actions.navigate('app-log'));
  window.__dismissTask = (id) => s.actions.dismissBackgroundTask(id);
  document.getElementById('bgTaskConfig')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.task-dismiss');
    if (btn) window.__dismissTask(btn.dataset.dismiss);
  });
  window.__toolsOnMountStatus = 'onMount_started';

  const tasks = s.state.backgroundTasks || [];
  const spellTask = tasks.find(t => t.status === 'done' && t.result && t.result.type === 'spellcheck');
  if (spellTask) {
    const container = document.getElementById('spellResult');
    if (container) {
      container.innerHTML = renderSpellResult(spellTask.result);
      container.style.display = 'block';
      container.querySelectorAll('.spell-apply').forEach(btn => btn.addEventListener('click', () => __applyOne(btn.dataset.wrong, btn.dataset.right, btn)));
      document.getElementById('spellApplyAll')?.addEventListener('click', () => container.querySelectorAll('.spell-apply').forEach(b => b.click()));
    }
  }

  let _prevBgTasks = '';
  const _unsub = s.subscribe((state) => {
    const tasks = state.backgroundTasks || [];
    const now = JSON.stringify(tasks.map(t => ({ id: t.id, done: t.done, total: t.total, status: t.status })));
    if (now === _prevBgTasks) return;
    _prevBgTasks = now;
    requestAnimationFrame(() => {
      const section = document.getElementById('bgTaskConfig');
      const taskIds = new Set(tasks.map(t => t.id));
      document.querySelectorAll('.task-item').forEach(el => { if (!taskIds.has(el.dataset.taskId)) el.remove(); });
      for (const t of tasks) {
        let el = document.querySelector(`.task-item[data-task-id="${t.id}"]`);
        if (!el && t.status === 'running') {
          const div = document.createElement('div');
          div.className = 'task-item';
          div.dataset.taskId = t.id;
          div.innerHTML = `<span class="task-label">${t.label}</span><div style="flex:1;max-width:200px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:6px;background:var(--bg-base);border-radius:3px;overflow:hidden"><div class="task-progress-fill" style="width:0%;height:100%;background:var(--accent);border-radius:3px;transition:width .3s"></div></div><span class="task-status">0/${t.total}</span></div></div><span style="color:var(--accent);font-size:11px">進行中...</span>`;
          section?.prepend(div);
        } else if (el) {
          if (t.status !== 'running') {
            el.innerHTML = `<span class="task-label">${t.label}</span><span class="task-status" style="color:${t.status === 'failed' ? 'var(--red)' : 'var(--green)'}">${t.status === 'failed' ? '失敗' : '完成'} (${t.total} 筆)</span><span class="task-dismiss" data-dismiss="${t.id}">×</span>`;
          } else {
            const bar = el.querySelector('.task-progress-fill');
            const label = el.querySelector('.task-status');
            if (bar) bar.style.width = t.total > 0 ? `${(t.done / t.total) * 100}%` : '0%';
            if (label) label.textContent = `${t.done}/${t.total}`;
          }
        }
      }
    });
  });
  window.__pageCleanup = () => { _unsub(); delete window.__pageCleanup; };

  const _posCN = {noun:'名詞',verb:'動詞',adjective:'形容詞',adverb:'副詞',preposition:'介係詞',conjunction:'連接詞',pronoun:'代名詞',interjection:'感嘆詞',exclamation:'感嘆詞',determiner:'限定詞',article:'冠詞',phrase:'片語',idiom:'慣用語',suffix:'後綴',prefix:'前綴',abbreviation:'縮寫','plural noun':'複數名詞'};
  const _normalizePos = (pos) => (pos || '').split(',').map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(Boolean).join(', ');
  const _normalizePron = (pron) => (pron || '').trim();

  // ponytail: shared LLM model detection
  async function detectModel(resultElId) {
    const llmRow = document.getElementById('llmUrlRow');
    if (llmRow) llmRow.style.display = 'block';
    const baseUrl = (document.getElementById('llmUrl')?.value || '').trim().replace(/\/api\/generate$/, '') || 'http://localhost:11434';
    let model = (document.getElementById('llmModel')?.value || '').trim();
    if (model) return { baseUrl, model };
    const el = document.getElementById(resultElId);
    if (!el) return null;
    el.style.display = 'block';
    try {
      el.innerHTML = `<div>偵測 Ollama 模型...</div>`;
      const resp = await fetchGet(`${baseUrl}/api/tags`);
      const list = (JSON.parse(resp).models || []).map(m => m.name);
      if (!list.length) { el.innerHTML = `<div style="color:var(--orange)">${icon('info')} 無可用模型</div>`; return null; }
      model = list[0];
      document.getElementById('llmModel').value = model;
      return { baseUrl, model };
    } catch (e) {
      el.innerHTML = `<div style="color:var(--orange)">${icon('info')} 無法連線 Ollama，請確認 http://localhost:11434 有在運作</div>`;
      return null;
    }
  }

  function hideLlmRow() {
    const r = document.getElementById('llmUrlRow');
    if (r) r.style.display = 'none';
  }

  // ponytail: read method selector value
  function _getMethod(id, fallback) {
    const el = document.getElementById(id + 'Cs');
    return el ? el.querySelector('.cs-t').dataset.value : fallback;
  }

  function _initCustomSelects() {
    document.addEventListener('click', e => {
      const t = e.target.closest('.cs-t');
      document.querySelectorAll('.cs.o').forEach(c => { if (c !== t?.closest('.cs')) c.classList.remove('o'); });
      if (t) { t.closest('.cs').classList.toggle('o'); return; }
      const o = e.target.closest('.cs-o');
      if (o) {
        const p = o.closest('.cs');
        const t = p.querySelector('.cs-t');
        t.dataset.value = o.dataset.value;
        t.childNodes[0].textContent = o.textContent;
        p.querySelectorAll('.cs-o').forEach(c => c.classList.toggle('s', c === o));
        p.classList.remove('o');
      }
    });
  }

  // ─── Duplicate Finder ─────────────────────────
  window.__findIssues = () => {
    const words = s.state.words;
    const container = document.getElementById('issuesResult');
    if (!container) return;
    const issues = [];
    const seen = new Map();
    for (const w of words) {
      const lower = w.word?.toLowerCase().trim();
      if (!lower) continue;
      if (seen.has(lower)) issues.push(`${icon('info')} 重複: 「${lower}」(${seen.get(lower)} / ${w.id})`);
      seen.set(lower, w.id);
    }
    const noDef = words.filter(w => !w.definition || w.definition.trim() === '');
    if (noDef.length > 0) {
      issues.push(`${icon('edit')} 缺少定義: ${noDef.length} 詞`);
      noDef.forEach(w => issues.push(`<span style="padding-left:1.5em;font-size:11px;color:var(--text-tertiary)">${w.word}</span>`));
    }
    const noPos = words.filter(w => !w.pos);
    if (noPos.length > 0) {
      issues.push(`${icon('hash')} 缺少詞性: ${noPos.length} 詞`);
      noPos.forEach(w => issues.push(`<span style="padding-left:1.5em;font-size:11px;color:var(--text-tertiary)">${w.word}</span>`));
    }
    container.style.display = 'block';
    if (issues.length === 0) {
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} 沒發現問題！</div>`;
      toast('掃描完成，無問題', 'toast-success');
    } else {
      container.innerHTML = issues.map(i => `<div style="padding:2px 0;font-size:12px">${i}</div>`).join('');
      toast(`發現 ${issues.length} 個問題`, '');
    }
  };

  // ─── Part of Speech Generator ────────────────
  window.__genPos = async () => {
    const method = _getMethod('posMethod', 'cambridge');
    if (method === 'llm') {
      const llm = await detectModel('posResult');
      if (!llm) return;
      await genPosViaLLM(s, llm);
    } else {
      await genPosViaCambridge(s);
    }
  };
  document.querySelector('button.btn[onclick*="__genPos"]')?.addEventListener('click', e => { console.log('click', e); });

  async function genPosViaCambridge(s) {
    hideLlmRow();
    const words = s.state.words;
    const taskId = 'gen-pos-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Cambridge 搜尋詞性', words.length);
    let count = 0, fail = 0;
    const CON = 2;
    const queue = [...words.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
          const data = JSON.parse(json);
          const newRaw = [...new Set((data.senses || []).flatMap(s => (s.part_of_speech || '').split(',').map(p => p.trim()).filter(Boolean)))];
          const existing = new Set((w.pos || '').split(',').map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(Boolean));
          const toAdd = newRaw.map(p => _posCN[p.trim().toLowerCase()] || p.trim()).filter(p => !existing.has(p));
          if (toAdd.length) {
            const merged = [...existing, ...toAdd].filter(Boolean).join(', ');
            await s.actions.editWord(w.id, { pos: merged }); count++;
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, count + fail, words.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已更新詞性${fail ? `，${fail} 詞無新詞性` : ''}` });
    const container = document.getElementById('posResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已更新詞性${fail ? `，${fail} 詞無新詞性` : ''}</div>`;
    }
    toast(`詞性查詢完成：${count} 更新${fail ? `，${fail} 無新詞性` : ''}`, fail ? '' : 'toast-success');
  }

  async function genPosViaLLM(s, llm) {
    const { baseUrl, model } = llm;
    const words = s.state.words;
    const noPos = words.filter(w => !w.pos || !w.pos.trim());
    if (noPos.length === 0) {
      const c = document.getElementById('posResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">所有單字都有詞性了！</div>`; }
      return;
    }
    const taskId = 'gen-pos-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生詞性', noPos.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noPos.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, `What is/are the part(s) of speech of "${w.word}"? If multiple, list them comma-separated. Return ONLY English POS labels (e.g. noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, determiner, article, plural noun), nothing else.`);
          const pos = _normalizePos(text);
          if (pos) { await s.actions.editWord(w.id, { pos }); count++; }
          else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noPos.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加詞性${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('posResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加詞性${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 詞性完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  function _exampleConfig() {
    const threshold = parseInt(document.getElementById('exampleThreshold')?.value, 10) || 1;
    const count = parseInt(document.getElementById('exampleCount')?.value, 10) || 1;
    return { threshold, count };
  }

  function _countSentences(text) {
    if (!text || !text.trim()) return 0;
    return text.split('\n').filter(l => l.trim().length > 2).length;
  }

  function _dedupSentences(text, newLines) {
    const existing = new Set(
      (text || '').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
    );
    return [...new Set(newLines)].filter(l => !existing.has(l.trim().toLowerCase()));
  }

  window.__genExamples = async () => {
    const method = _getMethod('exampleMethod', 'dictionary-api');
    const { threshold, count } = _exampleConfig();
    if (method === 'llm') {
      const llm = await detectModel('examplesResult');
      if (!llm) return;
      await genExamplesViaLLM(s, llm, count);
    } else if (method === 'cambridge') {
      await genExamplesViaCambridge(s, threshold);
    } else if (method === 'tatoeba') {
      await genExamplesViaTatoeba(s, threshold);
    } else {
      await genExamplesViaDictApi(s, threshold);
    }
  };

  async function genExamplesViaDictApi(s, threshold) {
    hideLlmRow();
    const words = s.state.words;
    const need = words.filter(w => _countSentences(w.example) < threshold);
    if (need.length === 0) {
      const container = document.getElementById('examplesResult');
      if (container) { container.style.display = 'block'; container.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${threshold} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-' + Date.now();
    s.actions.startBackgroundTask(taskId, '字典 API 抓取例句', need.length);
    let ok = 0, fail = 0;
    const CON = 3;
    const queue = need.map(w => ({ w }));
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const { w } = queue.shift();
        try {
          const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w.word)}`);
          if (res.ok) {
            const data = await res.json();
            const fresh = [];
            for (const entry of data) {
              for (const m of entry.meanings || []) {
                for (const d of m.definitions || []) {
                  if (d.example) fresh.push(d.example.trim());
                }
              }
            }
            const unique = _dedupSentences(w.example, fresh);
            if (unique.length) {
              const merged = [(w.example || '').trim(), ...unique].filter(Boolean).join('\n');
              await s.actions.editWord(w.id, { example: merged }); ok++;
            } else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 300));
        s.actions.updateBackgroundTask(taskId, ok + fail, need.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}</div>`;
    }
    toast(`例句查詢完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genExamplesViaTatoeba(s, threshold) {
    hideLlmRow();
    const words = s.state.words;
    const need = words.filter(w => _countSentences(w.example) < threshold);
    if (need.length === 0) {
      const c = document.getElementById('examplesResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${threshold} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-tat-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Tatoeba 抓取例句', need.length);
    let ok = 0, fail = 0;
    const CON = 3;
    const queue = [...need.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const res = await fetch(`https://api.tatoeba.org/unstable/sentences?q=${encodeURIComponent(w.word)}&lang=eng`);
          if (res.ok) {
            const body = await res.json();
            const fresh = (body.data || []).map(s => s.text).filter(Boolean);
            const unique = _dedupSentences(w.example, fresh);
            if (unique.length) {
              const merged = [(w.example || '').trim(), ...unique].filter(Boolean).join('\n');
              await s.actions.editWord(w.id, { example: merged }); ok++;
            } else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, ok + fail, need.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`Tatoeba 例句完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genExamplesViaCambridge(s, threshold) {
    hideLlmRow();
    const words = s.state.words;
    const need = words.filter(w => _countSentences(w.example) < threshold);
    if (need.length === 0) {
      const c = document.getElementById('examplesResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${threshold} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-cam-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Cambridge 抓取例句', need.length);
    let ok = 0, fail = 0;
    const CON = 2;
    const queue = [...need.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
          const data = JSON.parse(json);
          const fresh = [];
          for (const sense of data.senses || []) {
            for (const ex of sense.examples || []) {
              if (ex) fresh.push(ex.trim());
            }
          }
          const unique = _dedupSentences(w.example, fresh);
          if (unique.length) {
            const merged = [(w.example || '').trim(), ...unique].filter(Boolean).join('\n');
            await s.actions.editWord(w.id, { example: merged }); ok++;
          } else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, ok + fail, need.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞查無例句` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`Cambridge 例句完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genExamplesViaLLM(s, llm, count) {
    const { baseUrl, model } = llm;
    const words = s.state.words;
    const existing = [];
    const queue = [];
    for (const w of words) {
      const n = _countSentences(w.example);
      if (n < count) {
        queue.push(w);
        existing.push(w.example || '');
      }
    }
    if (queue.length === 0) {
      const c = document.getElementById('examplesResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都已達 ${count} 句門檻！</div>`; }
      return;
    }
    const taskId = 'gen-examples-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生例句', queue.length);
    let ok = 0, fail = 0;
    const CON = 5;
    const entries = queue.map((w, i) => ({ w, existing: existing[i] }));
    const q = [...entries.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, q.length) }, async () => {
      while (q.length > 0) {
        const [, { w, existing }] = q.shift();
        try {
          const prompt = `Create ${count} short example sentences using the word "${w.word}". Format: one sentence per line, each ending with proper punctuation (. ! ?). Only output the sentences, nothing else.`;
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
          const lines = text.split('\n').filter(Boolean).map(l => l.trim()).filter(l => l.length > 5).slice(0, count);
          if (lines.length) {
            const unique = _dedupSentences(existing, lines);
            if (unique.length) {
              const merged = [(existing || '').trim(), ...unique].filter(Boolean).join('\n');
              await s.actions.editWord(w.id, { example: merged }); ok++;
            } else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, ok + fail, queue.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('examplesResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${ok} 詞已添加例句${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 例句完成：${ok} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  window.__spellCheckLLM = async () => {
    const llm = await detectModel('spellResult');
    if (!llm) return;
    const { baseUrl, model } = llm;

    const words = s.state.words;
    const unique = [...new Set(words.map(w => w.word.toLowerCase().trim()).filter(Boolean))];

    const sc = document.getElementById('spellResult');
    if (sc) { sc.style.display = 'block'; sc.innerHTML = `<div>載入字典...</div>`; }

    let dict, isKnownWord;
    try {
      const mod = await import('../lib/dictionary.js');
      dict = await mod.loadDictionary();
      isKnownWord = mod.isKnownWord;
      if (sc) sc.innerHTML = `<div>字典已載入 (${dict.size} 詞)，過濾中...</div>`;
    } catch (e) {
      if (sc) sc.innerHTML = `<div style="color:var(--orange)">${icon('info')} 字典載入失敗: ${e.message}</div>`;
      toast('字典載入失敗，跳過字典檢查', 'toast-error');
    }
    const unknown = [];
    for (const w of unique) {
      if (w.length <= 1) continue;
      if (!dict || !isKnownWord(w)) unknown.push(w);
    }
    const skipped = unique.length - unknown.length;
    const taskId = 'spellcheck-' + Date.now();
    s.actions.startBackgroundTask(taskId, `LLM 拼字檢查 (字典過濾 ${skipped} 詞)`, unknown.length);
    let corrections = {};
    let checked = 0;
    const CON = 3;
    const batchSize = 50;
    const batches = [];
    for (let i = 0; i < unknown.length; i += batchSize) batches.push(unknown.slice(i, i + batchSize));
    await Promise.all(Array.from({ length: Math.min(CON, batches.length) }, async () => {
      while (batches.length > 0) {
        const batch = batches.shift();
        try {
          const prompt = `You are a spell checker. Only flag words that are ACTUALLY MISSPELLED (typos, wrong letters, missing letters). Rules: (1) DO NOT flag British/American spelling variants (e.g. favour/favor, fulfil/fulfill, anaesthetic/anesthetic, offence/offense, honour/honor, paralyse/paralyze, practise/practice). (2) DO NOT suggest different tenses or plural forms (e.g. choke→choking, stare→stares, theory→theories, trauma→traumas). (3) DO NOT suggest synonyms or rephrase expressions, only fix actual typos. (4) Multiple-word expressions (phrases, collocations) should only be flagged if they contain a real typo. (5) Return ONLY a JSON object where keys are misspelled words and values are corrections. Skip everything that is correctly spelled. List: ${JSON.stringify(batch)}`;
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, prompt);
          const cleaned = text.replace(/```json|```/g, '').trim();
          const result = JSON.parse(cleaned);
          if (typeof result === 'object' && !Array.isArray(result)) Object.assign(corrections, result);
        } catch (e) {}
        checked += batch.length;
        s.actions.updateBackgroundTask(taskId, checked, unknown.length);
      }
    }));

    const entries = Object.entries(corrections).filter(([k, v]) => k.toLowerCase() !== v.toLowerCase());
    const spellResultData = { type: 'spellcheck', entries: entries.map(([w, r]) => ({ wrong: w, right: r, count: words.filter(x => x.word.toLowerCase().trim() === w).length })) };
    s.actions.completeBackgroundTask(taskId, spellResultData);
    const container = document.getElementById('spellResult');
    if (!container) return;
    container.style.display = 'block';

    if (!entries.length) {
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字拼字正確！</div>`;
      return;
    }
    container.innerHTML = renderSpellResult(spellResultData);
    container.querySelectorAll('.spell-apply').forEach(btn => btn.addEventListener('click', () => __applyOne(btn.dataset.wrong, btn.dataset.right, btn)));
    document.getElementById('spellApplyAll')?.addEventListener('click', () => container.querySelectorAll('.spell-apply').forEach(b => b.click()));
  };

  function __applyOne(wrong, right, btn) {
    const matches = s.state.words.filter(w => w.word.toLowerCase().trim() === wrong.toLowerCase().trim());
    if (!matches.length) { toast(`找不到 ${wrong}`, ''); return; }
    Promise.all(matches.map(w => s.actions.editWord(w.id, { word: right })))
      .then(() => {
        btn.closest('div')?.remove();
        toast(`已修正 ${matches.length} 筆: ${wrong} → ${right}`, 'toast-success');
      })
      .catch(() => toast('套用失敗', ''));
  }

  window.__genPronunciations = async () => {
    const method = _getMethod('pronMethod', 'cambridge');
    if (method === 'llm') {
      const llm = await detectModel('pronResult');
      if (!llm) return;
      await genPronViaLLM(s, llm);
    } else {
      await genPronViaCambridge(s);
    }
  };

  async function genPronViaCambridge(s) {
    hideLlmRow();
    const words = s.state.words;
    const noPron = words.filter(w => !w.pron || !w.pron.trim());
    if (noPron.length === 0) {
      const container = document.getElementById('pronResult');
      if (container) { container.style.display = 'block'; container.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有發音了！</div>`; }
      return;
    }
    const taskId = 'pron-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'Cambridge 字典抓取發音', noPron.length);
    let count = 0, fail = 0;
    const CON = 2;
    const queue = noPron.map(w => ({ w }));
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const { w } = queue.shift();
        try {
          const json = await lookupCambridge(w.word);
          const data = JSON.parse(json);
          const pron = _normalizePron(data.uk_ipa || data.us_ipa);
          if (pron) { await s.actions.editWord(w.id, { pron }); count++; }
          else { fail++; }
        } catch (e) { fail++; }
        await new Promise(r => setTimeout(r, 500));
        s.actions.updateBackgroundTask(taskId, count + fail, noPron.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加發音${fail ? `，${fail} 詞查無發音` : ''}` });
    const container = document.getElementById('pronResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加發音${fail ? `，${fail} 詞查無發音` : ''}</div>`;
    }
    toast(`發音查詢完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  async function genPronViaLLM(s, llm) {
    const { baseUrl, model } = llm;
    const words = s.state.words;
    const noPron = words.filter(w => !w.pron || !w.pron.trim());
    if (noPron.length === 0) {
      const c = document.getElementById('pronResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有發音了！</div>`; }
      return;
    }
    const taskId = 'pron-llm-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生音標', noPron.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noPron.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const text = await fetchLLM(`${baseUrl}/api/generate`, model, `Provide the IPA pronunciation of "${w.word}". Return ONLY the IPA string (e.g. /ˈhɛloʊ/), nothing else.`);
          if (text && text.trim()) {
            const cleaned = text.trim().replace(/^\/+|\/+$/g, '');
            const pron = cleaned ? `/${cleaned}/` : null;
            if (pron) { await s.actions.editWord(w.id, { pron }); count++; }
            else { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noPron.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加音標${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('pronResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加音標${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 音標完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  }

  window.__genRelatedLLM = async () => {
    const words = s.state.words;
    const noRel = words.filter(w => !w.related || !Array.isArray(w.related) || w.related.length === 0);
    const llm = await detectModel('relatedResult');
    if (!llm) return;
    const { baseUrl, model } = llm;

    if (noRel.length === 0) {
      const c = document.getElementById('relatedResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有相關詞了！</div>`; }
      return;
    }

    const taskId = 'gen-related-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生相關詞', noRel.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noRel.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const relText = await fetchLLM(`${baseUrl}/api/generate`, model,
            `Return a JSON array of synonyms/similar words for "${w.word}". Example: ["obtain","receive","fetch"]. Only the JSON array, no markdown.`
          );
          if (relText && relText.trim()) {
            try {
              const cleaned = relText.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
              const arr = JSON.parse(cleaned);
              await s.actions.editWord(w.id, { related: Array.isArray(arr) ? [...new Set(arr)] : [] });
              count++;
            } catch (_) { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noRel.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加相關詞${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('relatedResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加相關詞${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 相關詞完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  };

  window.__genFormsLLM = async () => {
    const words = s.state.words;
    const noForms = words.filter(w => !w.forms || !Array.isArray(w.forms) || w.forms.length === 0);
    const llm = await detectModel('formsResult');
    if (!llm) return;
    const { baseUrl, model } = llm;

    if (noForms.length === 0) {
      const c = document.getElementById('formsResult'); if (c) { c.style.display = 'block'; c.innerHTML = `<div style="color:var(--green)">${icon('check')} 所有單字都有詞形變化了！</div>`; }
      return;
    }

    const taskId = 'gen-forms-' + Date.now();
    s.actions.startBackgroundTask(taskId, 'LLM 產生詞形變化', noForms.length);
    let count = 0, fail = 0;
    const CON = 5;
    const queue = [...noForms.entries()];
    await Promise.all(Array.from({ length: Math.min(CON, queue.length) }, async () => {
      while (queue.length > 0) {
        const [, w] = queue.shift();
        try {
          const relText = await fetchLLM(`${baseUrl}/api/generate`, model,
            `Return a JSON array of inflections/derivations (past tense, -ing, -s, past participle) for "${w.word}". Example: ["gets","got","getting"]. Only the JSON array, no markdown.`
          );
          if (relText && relText.trim()) {
            try {
              const cleaned = relText.trim().replace(/```(?:json)?\s*/gi, '').replace(/\s*```/g, '').trim();
              const arr = JSON.parse(cleaned);
              await s.actions.editWord(w.id, { forms: Array.isArray(arr) ? [...new Set(arr)] : [] });
              count++;
            } catch (_) { fail++; }
          } else { fail++; }
        } catch (e) { fail++; }
        s.actions.updateBackgroundTask(taskId, count + fail, noForms.length);
      }
    }));
    s.actions.completeBackgroundTask(taskId, { type: 'summary', message: `完成：${count} 詞已添加詞形變化${fail ? `，${fail} 詞失敗` : ''}` });
    const container = document.getElementById('formsResult');
    if (container) {
      container.style.display = 'block';
      container.innerHTML = `<div style="color:var(--green)">${icon('check')} ${count} 詞已添加詞形變化${fail ? `，${fail} 詞失敗` : ''}</div>`;
    }
    toast(`LLM 詞形變化完成：${count} 成功${fail ? `，${fail} 失敗` : ''}`, fail ? '' : 'toast-success');
  };

  window.__lookupCambridge = async () => {
    const word = document.getElementById('cambridgeWord')?.value?.trim();
    if (!word) { toast('請輸入單字', ''); return; }
    const lang = _getMethod('cambridgeDict', 'en');
    const el = document.getElementById('cambridgeResult');
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `<div>查詢中...</div>`;
    try {
      const json = await lookupCambridge(word, lang);
      const data = JSON.parse(json);
      let html = `<div style="padding:8px;background:var(--bg-base);border-radius:var(--r1)">`;
      html += `<div style="font-size:16px;font-weight:600;margin-bottom:4px">${data.word}</div>`;
      if (data.uk_ipa || data.us_ipa) {
        html += `<div style="margin-bottom:6px;font-size:13px;color:var(--text-secondary)">`;
        if (data.uk_ipa) html += `UK: ${data.uk_ipa} `;
        if (data.us_ipa) html += `US: ${data.us_ipa}`;
        html += `</div>`;
      }
        for (const s of (data.senses || [])) {
        const posCN = _posCN;
        const pos = (s.part_of_speech || '').split(',').map(p => posCN[p.trim()] || p.trim()).join(', ');
        html += `<div style="margin-top:4px;padding:6px;background:var(--bg-secondary);border-radius:var(--r1)">`;
        html += `<div style="font-size:12px;color:var(--accent);margin-bottom:2px">${pos}${s.cefr_level ? ` <span style="color:var(--orange)">${s.cefr_level}</span>` : ''}</div>`;
        html += `<div style="font-size:13px;margin-bottom:2px">${icon('info')} ${s.definition}</div>`;
        if (s.translation) html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:2px">${icon('translate')} ${s.translation}</div>`;
        for (const ex of (s.examples || [])) {
          const txt = typeof ex === 'string' ? ex : `${ex.english}${ex.chinese ? ` / ${ex.chinese}` : ''}`;
          html += `<div style="font-size:12px;color:var(--text-tertiary);padding-left:12px">• ${txt}</div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = `<div style="color:var(--red)">${icon('error')} 查詢失敗: ${e}</div>`;
    }
  };

  document.getElementById('cambridgeWord')?.addEventListener('keydown', e => { if (e.key === 'Enter') window.__lookupCambridge(); });
  const exampleDisplayMax = document.getElementById('exampleDisplayMax');
  if (exampleDisplayMax) {
    window.__maxExampleLines = parseInt(exampleDisplayMax.value, 10) || 0;
    import('../lib/db.js').then(m => m.getSetting('exampleDisplayMax')).then(v => {
      const n = parseInt(v, 10);
      if (n > 0) { window.__maxExampleLines = n; exampleDisplayMax.value = n; }
    }).catch(() => {});
    exampleDisplayMax.addEventListener('input', () => {
      const n = parseInt(exampleDisplayMax.value, 10) || 0;
      window.__maxExampleLines = n;
      import('../lib/db.js').then(m => m.setSetting('exampleDisplayMax', String(n))).catch(() => {});
    });
  }
  _initCustomSelects();
  // ponytail: inline onclick broken in WebKitGTK, use addEventListener instead
  document.querySelectorAll('button[onclick]').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/window\.__(\w+)\(/);
    if (m && typeof window['__' + m[1]] === 'function') {
      if (m[1] === 'dismissTask') {
        const id = btn.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        if (id) btn.addEventListener('click', () => window.__dismissTask(id));
      } else {
        btn.addEventListener('click', window['__' + m[1]]);
      }
      btn.removeAttribute('onclick');
    }
  });
}
''

## FILE: src/lib/api.js
''
import { invoke } from '@tauri-apps/api/core'

// ─── CLI ─────────────────────────────────────────────────────
export const runCli = (args) =>
  invoke('run_cli', { args })

export const getAppPaths = () =>
  invoke('get_app_paths')

// ─── LLM / Network ─────────────────────────────────────
export const fetchLLM = (url, model, prompt, apiFormat) =>
  invoke('fetch_llm', { url, model, prompt, apiFormat })

export const fetchGet = (url) =>
  invoke('fetch_get', { url })

// ─── Scraping ──────────────────────────────────────────
export const lookupCambridge = (word, lang) =>
  invoke('lookup_cambridge', { word, lang })

export const scrapeQuizlet = (url) =>
  invoke('scrape_quizlet', { url })

// ─── TTS ───────────────────────────────────────────────
export const speakText = (text, opts = {}) => {
  const { speed = 1, voice = 'en_US-ryan-high', pitch } = opts
  return invoke('speak_text', {
    text,
    voice,
    pitch: pitch ?? 50,
    lengthScale: Math.max(0.3, Math.min(3, 1.0 / Math.max(0.3, speed) * 0.9)),
    noiseScale: 0.667,
  })
}

export const speakAndroid = (text, opts = {}) => {
  const { speed = 1, voice = '' } = opts
  return invoke('speak_android', { text, voice, speed })
}

export const stopAndroid = () =>
  invoke('stop_android')

/** 切換 launcher icon（Android activity-alias；非 Android 為 no-op） */
export const setLauncherIcon = (name) =>
  invoke('set_launcher_icon', { name })

/** 查目前使用的 launcher icon key（Android；非 Android 回 original） */
export const getLauncherIcon = () =>
  invoke('get_launcher_icon')

/** 重置 app-log.db（操作日誌 DB 損壞時刪檔重建；teno.db 不受影響） */
export const resetAppLogDb = () =>
  invoke('reset_app_log')

export const listAndroidVoices = () =>
  invoke('list_voices_android')

export const listPiperVoices = () =>
  invoke('list_piper_voices')

export const importPiperModelDialog = () =>
  invoke('import_piper_model_dialog')

export const installPiperModel = (url) =>
  invoke('install_piper_model', { url })

export const deletePiperModel = (name) =>
  invoke('delete_piper_model', { name })

// ─── Backup ────────────────────────────────────────────
export const backupDb = () =>
  invoke('backup_db')

export const listBackups = () =>
  invoke('list_backups')

export const restoreBackup = (filename) =>
  invoke('restore_backup', { filename })

export const deleteBackup = (filename) =>
  invoke('delete_backup', { filename })

export const exportBackupDialog = (filename) =>
  invoke('export_backup_dialog', { filename })

export const pruneBackups = (maxCount) =>
  invoke('prune_backups', { maxCount })

export const getDbMtime = () =>
  invoke('get_db_mtime')

// ─── Database / Export ─────────────────────────────────
export const importDbDialog = () =>
  invoke('import_db_dialog')

export const writeDbBytes = (buf) =>
  invoke('write_db_bytes', { data: Array.from(new Uint8Array(buf)) })

export const exportDbDialog = (includeLog = true) =>
  invoke('export_db_dialog', { includeLog })

export const exportCsvDialog = (csv, filename) =>
  invoke('export_csv_dialog', { csv, filename })

// ─── Android export (returns data for Blob download) ──
export const exportCsvData = (csv, filename) =>
  invoke('export_csv_data', { csv, filename })

export const exportDbData = (includeLog = true) =>
  invoke('export_db_data', { includeLog })

export const exportBackupData = (filename) =>
  invoke('export_backup_data', { filename })

// ─── Google Drive Sync ───────────────────────────────
export const driveSaveCreds = (clientId, clientSecret) =>
  invoke('drive_save_creds', { clientId, clientSecret })

export const driveOAuth = () =>
  invoke('drive_oauth')

export const driveUpload = () =>
  invoke('drive_upload')

export const driveDownload = () =>
  invoke('drive_download')

export const driveStatus = () =>
  invoke('drive_status')

export const driveLogout = () =>
  invoke('drive_logout')

export const optimizeFsrs = (reviews) =>
  invoke('optimize_fsrs', { reviews })

// ─── 官方 FSRS 模擬器 (fsrs-rs 6.6.1, 對齊 Anki 26.08) ───
// mode: 'simulate' | 'workload' | 'optimal'
export const simulateFsrs = (req) =>
  invoke('simulate_fsrs', { req })
''

## FILE: src/lib/db.js
''
// ═══════════════════════════════════════════════════════════════
// DB — Stateless SQLite data access layer.
// Every call goes to SQLite. No caching (that's the store's job).
// ═══════════════════════════════════════════════════════════════

/** @type {import('@tauri-apps/plugin-sql').default | null} */
let db = null;

/** Initialize DB connection. Call once at startup. */
export async function initDB(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { default: Database } = await import('@tauri-apps/plugin-sql');
      db = await Database.load('sqlite:teno.db');
      console.log('[db] ✅ SQLite connected');
      await migrate(db);
      await stampDbVersion(db);   // VERSION-TRACE: 寫入 DB 版本指紋（PRAGMA user_version + settings）
      return db;
    } catch (e) {
      console.error(`[db] ❌ Failed to init DB (attempt ${i + 1}/${retries}):`, e);
      db = null;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 500));
    }
  }
  return db;
}

/** Close DB connection. Use before import. */
export async function closeDB() {
  if (db) {
    try { await db.close(); } catch (e) { console.warn('[db] close error:', e); }
    db = null;
  }
}

// ─── VERSION-TRACE: DB 版本指紋 ───────────────────────────────
// 目的: 每份 DB 記下「哪個 app 版本寫的」，日後分析/除錯可確定版本邊界
// （修復分界不再靠 reviewed_at 的 Z/無Z 猜）。採 SQLite 原生 PRAGMA user_version
// （存於檔頭、單一值、不佔表）+ settings.db_from_version（字串人讀）。
let _pkgVer = null;
let _pkgBuildHash = null;
async function _loadPkg() {
  if (_pkgVer !== null) return { version: _pkgVer, buildHash: _pkgBuildHash };
  try {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    const p = pkg?.default || pkg || {};
    _pkgVer = p.version || '0.0.0';
    _pkgBuildHash = p.buildHash || null;
  } catch (_) { _pkgVer = '0.0.0'; _pkgBuildHash = null; }
  return { version: _pkgVer, buildHash: _pkgBuildHash };
}
async function loadAppVersion() { const p = await _loadPkg(); return p.version; }
/** 本次 build 對應 commit hash（package.json buildHash — 打包流程寫入；未寫入回 'unknown'）. */
async function getBuildCommit() { const p = await _loadPkg(); return p.buildHash || 'unknown'; }

function versionInt(versionStr) {
  const m = String(versionStr || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 1000000 + Number(m[2]) * 1000 + Number(m[3]);   // 5.1.18 → 5001018
}
export function getAppVersion() { return _pkgVer || '0.0.0'; }
export function getAppVersionInt() { return versionInt(getAppVersion()); }

/** 寫入 DB 版本指紋（已存在更高版本不覆寫 → 只升不降）。 commit hash 同時記錄. */
export async function stampDbVersion(d) {
  try {
    await _loadPkg();   // 確保 app 版本已載入（首次呼叫同步讀 package.json）
    const verInt = getAppVersionInt();
    const rows = await (d || requireDB()).select('PRAGMA user_version');
    const cur = rows?.[0]?.user_version ?? 0;
    const commitHash = await getBuildCommit();   // 本次 build 對應 commit（package.json buildHash 或執行環境）
    if (verInt > cur) {
      await (d || requireDB()).execute(`PRAGMA user_version = ${verInt}`);
      // 版本提升時一併記錄對應 commit hash
      try { await (d || requireDB()).execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_from_commit', ?)", [commitHash]); } catch (_) {}
    }
    // settings 字串版本（人讀）+ 首次寫入標記
    try {
      const exists = await (d || requireDB()).select("SELECT value FROM settings WHERE key='db_from_version'");
      if (!exists || !exists.length) {
        await (d || requireDB()).execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_from_version', ?)", [getAppVersion()]);
        await (d || requireDB()).execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_from_commit', ?)", [commitHash]);
      }
    } catch (_) { /* settings 可能無此表（極早期）→ 忽略 */ }
  } catch (e) { console.warn('[db] stampDbVersion:', e); }
}

/** 讀取 DB 版本指紋（分析/CLI 用）。回傳 { app, int, raw }。 */
export async function getDbVersion(d) {
  const conn = d || requireDB();
  const rows = await conn.select('PRAGMA user_version');
  const raw = rows?.[0]?.user_version ?? 0;
  const verRows = await conn.select("SELECT value FROM settings WHERE key='db_from_version'");
  return { app: verRows?.[0]?.value ?? null, int: raw, raw };
}

/** Run schema migrations. */
async function migrate(d) {
  const cols = ['synonym', 'antonym', 'derivative', 'examples', 'related', 'forms'];
  for (const col of cols) {
    try { await d.execute(`ALTER TABLE words ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  }
  // v5.2: review_log 記錄複習後的狀態 (fsrs-report 轉移分析不用 replay)
  try { await d.execute('ALTER TABLE review_log ADD COLUMN new_state INTEGER'); } catch (_) {}
  // v5.2: 審計日誌 (設定變更/匯入匯出/CLI 寫入)
  try {
    await d.execute(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT ''
    )`);
    await d.execute('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)');
  } catch (_) {}
  // A12: 容器卡假 due 清理 — state=0（new）不該有 due；只清帶 mcData/spellData 的容器卡
  try {
    await d.execute(`UPDATE cards SET due='' WHERE state=0 AND due != '' AND (mc_data IS NOT NULL OR spell_data IS NOT NULL)`);
  } catch (_) {}
}

/** Checkpoint WAL so the main db file is fully up to date. */
export async function checkpoint() {
  if (db) {
    try { await db.execute("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { console.warn('[db] checkpoint failed:', e); }
  }
}

/** Check if DB is available. */
export function isReady() {
  return db !== null;
}

function requireDB() {
  if (!db) throw new Error('DB not connected. Check src-tauri/capabilities/default.json includes sql:default + sql:allow-execute, and initDB() was called.');
  return db;
}

// ─── Words ─────────────────────────────────────

export async function getAllWords() {
  const rows = await requireDB().select(
    'SELECT id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, created_at, related, forms, synonym, antonym, derivative, examples FROM words ORDER BY created_at'
  );
  return rows.map(r => ({
    id: r.id,
    word: r.word,
    definition: r.definition || '',
    pos: r.part_of_speech || '',
    pron: r.pronunciation || '',
    example: r.example || '',
    deck: r.deck || 'Default',
    tags: parseJSON(r.tags, []),
    image: r.image || '',
    description: r.description || '',
    related: parseJSON(r.related, []),
    forms: parseJSON(r.forms, []),
    synonym: r.synonym || '',
    antonym: r.antonym || '',
    derivative: r.derivative || '',
    examples: parseJSON(r.examples, []),
    createdAt: normalizeUtcTimestamp(r.created_at),   // E2: 統一正規化（dashboard/filterEngine 兩消費點）
  }));
}

export async function getWordCount() {
  const rows = await requireDB().select('SELECT COUNT(*) AS count FROM words');
  return rows[0]?.count ?? 0;
}

export async function saveWord(word) {
  await requireDB().execute(
    `INSERT INTO words (id, word, definition, part_of_speech, pronunciation, example, deck, tags, image, description, related, forms, synonym, antonym, derivative, examples, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT(id) DO UPDATE SET
      word=excluded.word, definition=excluded.definition,
      part_of_speech=excluded.part_of_speech, pronunciation=excluded.pronunciation,
      example=excluded.example, deck=excluded.deck,
      tags=excluded.tags, image=excluded.image, description=excluded.description,
      related=excluded.related, forms=excluded.forms,
      synonym=excluded.synonym, antonym=excluded.antonym,
      derivative=excluded.derivative, examples=excluded.examples`,
    [   // E2: ON CONFLICT 不加 created_at — 編輯/改標籤不重置建立時間
      word.id,
      word.word || '',
      word.definition || '',
      word.pos || '',
      word.pron || '',
      word.example || '',
      word.deck || 'Default',
      JSON.stringify(word.tags || []),
      word.image || '',
      word.description || '',
      JSON.stringify(word.related || []),
      JSON.stringify(word.forms || []),
      word.synonym || '',
      word.antonym || '',
      word.derivative || '',
      JSON.stringify(word.examples || []),
      word.createdAt ?? new Date().toISOString(),   // E2: created_at ISO 帶 Z
    ]
  );
}

// G18: 批次存多個 words 於單一事務（tag 改動/批次編輯用 — 避免萬級詞庫逐詞 round-trip）
export async function saveWordsInTx(words) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    for (const w of words) await saveWord(w);
    await d.execute('COMMIT');
  } catch (e) {
    try { await d.execute('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

export async function deleteWord(id) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    // D14: 先取 word 文字（exam_history.word 存單字文字非 id，需其刪孤兒測驗紀錄）
    const wr = await d.select('SELECT word FROM words WHERE id = $1', [id]);
    const wordText = wr[0]?.word;
    await d.execute('DELETE FROM cards WHERE word_id = $1', [id]);
    await d.execute('DELETE FROM review_log WHERE word_id = $1', [id]);   // D14: 清孤兒複習紀錄
    if (wordText) await d.execute('DELETE FROM exam_history WHERE word = $1', [wordText]);  // D14: 清孤兒測驗紀錄(存文字)
    await d.execute('DELETE FROM words WHERE id = $1', [id]);
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

export async function bulkSaveWords(words) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM words');
    for (const w of words) await saveWord(w);
    await d.execute('COMMIT');
    await addAudit('import-words', `匯入 ${words.length} 詞 (整表覆寫)`);
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Cards ─────────────────────────────────────

export async function getAllCards() {
  const rows = await requireDB().select(
    'SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards'
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.word_id, {
      due: r.due,
      stability: r.stability,
      difficulty: r.difficulty,
      elapsedDays: r.elapsed_days,
      scheduledDays: r.scheduled_days,
      reps: r.reps,
      lapses: r.lapses,
      state: r.state,
      step: r.step ?? 0,
      lastReview: r.last_review,
      buried: !!r.buried,
      suspended: !!r.suspended,
      interval: r.scheduled_days || 0,
      mcData: parseJSON(r.mc_data, null),
      spellData: parseJSON(r.spell_data, null),
    });
  }
  return map;
}

export async function getCard(wordId) {
  const rows = await requireDB().select(
    'SELECT word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data FROM cards WHERE word_id = $1',
    [wordId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    due: r.due,
    stability: r.stability,
    difficulty: r.difficulty,
    elapsedDays: r.elapsed_days,
    scheduledDays: r.scheduled_days,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    step: r.step ?? 0,
    lastReview: r.last_review,
    buried: !!r.buried,
    suspended: !!r.suspended,
    interval: r.scheduled_days || 0,
    mcData: parseJSON(r.mc_data, null),
    spellData: parseJSON(r.spell_data, null),
  };
}

export async function saveCard(wordId, card) {
  await requireDB().execute(
    `INSERT INTO cards (word_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, step, last_review, buried, suspended, mc_data, spell_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT(word_id) DO UPDATE SET
       due=excluded.due, stability=excluded.stability, difficulty=excluded.difficulty,
       elapsed_days=excluded.elapsed_days, scheduled_days=excluded.scheduled_days,
       reps=excluded.reps, lapses=excluded.lapses, state=excluded.state,
       step=excluded.step, last_review=excluded.last_review,
       buried=excluded.buried, suspended=excluded.suspended,
       mc_data=excluded.mc_data, spell_data=excluded.spell_data`,
    [
      wordId,
      card.due ?? new Date().toISOString(),
      card.stability ?? 2.5,
      card.difficulty ?? 5,
      card.elapsedDays ?? 0,
      card.scheduledDays ?? 0,
      card.reps ?? 0,
      card.lapses ?? 0,
      card.state ?? 0,
      card.step ?? 0,
      card.lastReview ?? null,
      card.buried ? 1 : 0,
      card.suspended ? 1 : 0,
      card.mcData ? JSON.stringify(card.mcData) : null,
      card.spellData ? JSON.stringify(card.spellData) : null,
    ]
  );
}

export async function bulkSaveCards(cards) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    for (const [wordId, card] of cards) await saveCard(wordId, card);
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Decks ─────────────────────────────────────

export async function getAllDecks() {
  const rows = await requireDB().select('SELECT id, name, color FROM decks ORDER BY name');
  return rows.map(r => ({ id: r.id, name: r.name, color: r.color }));
}

export async function saveDeck(deck) {
  await requireDB().execute(
    'INSERT INTO decks (id, name, color) VALUES ($1, $2, $3) ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color',
    [deck.id, deck.name, deck.color || '#5e6ad2']
  );
}

export async function deleteDeck(id) {
  await requireDB().execute('DELETE FROM decks WHERE id = $1', [id]);
}

export async function deleteWordsByDeck(deckName) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM review_log WHERE word_id IN (SELECT id FROM words WHERE deck = $1)', [deckName]);
    await d.execute('DELETE FROM exam_history WHERE word IN (SELECT id FROM words WHERE deck = $1)', [deckName]);
    await d.execute('DELETE FROM cards WHERE word_id IN (SELECT id FROM words WHERE deck = $1)', [deckName]);
    await d.execute('DELETE FROM words WHERE deck = $1', [deckName]);
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Folders ────────────────────────────────────

export async function getAllFolders() {
  const rows = await requireDB().select('SELECT name, decks FROM folders');
  const map = {};
  for (const r of rows) map[r.name] = parseJSON(r.decks, []);
  return map;
}

export async function saveFolders(folders) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM folders');
    for (const [name, deckIds] of Object.entries(folders)) {
      await d.execute(
        'INSERT INTO folders (name, decks) VALUES ($1, $2) ON CONFLICT(name) DO UPDATE SET decks=excluded.decks',
        [name, JSON.stringify(deckIds)]
      );
    }
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Additions ──────────────────────────────────

export async function getAllAdditions() {
  const rows = await requireDB().select('SELECT * FROM additions ORDER BY added_at');
  return rows.map(r => ({
    id: r.id,
    word: r.word,
    definition: r.definition || '',
    pos: r.part_of_speech || '',
    pron: r.pronunciation || '',
    examples: parseJSON(r.examples, []),
    deck: r.deck || 'Default',
  }));
}

export async function bulkSaveAdditions(additions) {
  const d = requireDB();
  await d.execute('BEGIN TRANSACTION');
  try {
    await d.execute('DELETE FROM additions');
    for (const a of additions) {
      await d.execute(
        'INSERT INTO additions (word, definition, part_of_speech, pronunciation, examples, deck) VALUES ($1, $2, $3, $4, $5, $6)',
        [a.word, a.definition || '', a.pos || '', a.pron || '', JSON.stringify(a.examples || []), a.deck || 'Default']
      );
    }
    await d.execute('COMMIT');
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Settings (KV) ──────────────────────────────

export async function getSetting(key) {
  const rows = await requireDB().select('SELECT value FROM settings WHERE key = $1', [key]);
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value); } catch { return rows[0].value; }
}

export async function setSetting(key, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  await requireDB().execute(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, str]
  );
  // 審計: 設定變更軌跡 (CLI 與 GUI 統一)
  await addAudit('setting', `SET ${key}=${str.slice(0, 300)}`);
}

/** 審計日誌 — 記錄任何寫入動作 (GUI/CLI 共用, 存 teno.db) */
export async function addAudit(action, detail = '') {
  try {
    await requireDB().execute(
      'INSERT INTO audit_log (ts, action, detail) VALUES ($1, $2, $3)',
      [Date.now(), String(action).slice(0, 100), String(detail).slice(0, 1000)]
    );
  } catch (e) {
    console.warn('[db] addAudit error:', e);
  }
}

// ─── Tags ────────────────────────────────────────

export async function getAllTags() {
  const raw = await getSetting('tags');
  if (!Array.isArray(raw)) return [];
  return raw;
}

export async function setAllTags(tags) {
  await setSetting('tags', tags);
}

// ─── Review Log ─────────────────────────────────

export async function addReviewLog(entry) {
  await requireDB().execute(
    `INSERT INTO review_log (word_id, rating, duration, elapsed_days, scheduled_days, stability, difficulty, mode, card_state, new_state, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [entry.wordId, entry.rating, entry.duration ?? null, entry.elapsedDays ?? null, entry.scheduledDays ?? null, entry.stability ?? null, entry.difficulty ?? null, entry.mode || 'flip', entry.state ?? null, entry.newState ?? null, entry.reviewedAt ?? new Date().toISOString()]   // E2: reviewed_at ISO 帶 Z（不再靠 DEFAULT naive）
  );
}

export async function getAllReviewLogs() {
  const rows = await requireDB().select('SELECT * FROM review_log ORDER BY reviewed_at, id');   // C1: id 次鍵消除同刻 timestamp tie 順序不確定性
  return rows.map(r => ({
    id: r.id,
    wordId: r.word_id,
    rating: r.rating,
    duration: r.duration,
    elapsedDays: r.elapsed_days,
    scheduledDays: r.scheduled_days,
    stability: r.stability,
    difficulty: r.difficulty,
    // SQLite datetime('now') stores UTC WITHOUT a timezone marker; JS would
    // parse it as local time and shift every timestamp by the UTC offset.
    // Normalize to an ISO string carrying the Z (UTC) marker so downstream
    // consumers (scheduler + dashboard charts) interpret it correctly.
    reviewed_at: normalizeUtcTimestamp(r.reviewed_at),
    state: r.card_state,
    newState: r.new_state,
    ivl: r.scheduled_days,
    mode: r.mode || 'flip',
  }));
}

/**
 * Normalize a SQLite UTC timestamp (e.g. "2026-07-22 22:00:00") into an
 * ISO string with explicit UTC marker. Strings already carrying a timezone
 * (Z or ±HH:MM) are returned unchanged.
 */
function normalizeUtcTimestamp(ts) {
  if (ts == null) return ts;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(ts)) {
    return ts.replace(' ', 'T') + 'Z';
  }
  return ts;
}

/** Count today's new-card reviews for a given mode from revlog.
 *  reviewed_at is stored in UTC; convert the local todayStart + cutoff into a UTC boundary. */
export async function getNewRatedToday(mode, todayStart, dayCutoff = 0, tzOffset = null) {
  const offset = tzOffset ?? -(new Date().getTimezoneOffset());
  const [y, m, d] = todayStart.split('-').map(Number);
  const boundaryUtc = new Date(Date.UTC(y, m - 1, d, 0, dayCutoff || 0) - offset * 60000)
    .toISOString();   // E2: 完整 24 字元含 Z — 舊的 slice(0,19)+空格 對校正後 ISO 值字串比較失準（'T' > ' ' → 灌水）
  const rows = await requireDB().select(
    'SELECT COUNT(*) AS count FROM review_log WHERE mode = $1 AND card_state = 0 AND reviewed_at >= $2',
    [mode, boundaryUtc]
  );
  return rows[0]?.count ?? 0;
}

export async function clearReviewLogs() {
  await requireDB().execute('DELETE FROM review_log');
}

export async function getMaxReviewLogId() {
  const rows = await requireDB().select('SELECT MAX(id) AS m FROM review_log');
  return rows[0]?.m ?? 0;
}

export async function deleteReviewLogsAfter(id, mode) {
  // C1: mode 過濾 — COALESCE(mode, 'flip') 內固定字面量（NULL 舊資料視為 flip，僅 flip undo 會刪）；
  //     右側 $2 為目標 mode（比較參數化）
  const m = mode || 'flip';   // 防 undefined 參數（呼叫端已窮舉，純保險）
  await requireDB().execute(
    "DELETE FROM review_log WHERE id > $1 AND COALESCE(mode, 'flip') = $2",
    [id, m]
  );
}

export async function deleteLastReviewLog() {
  await requireDB().execute('DELETE FROM review_log WHERE id = (SELECT MAX(id) FROM review_log)');
}

export async function deleteCard(wordId) {
  await requireDB().execute('DELETE FROM cards WHERE word_id = $1', [wordId]);
}

// ─── Exam History ───────────────────────────────

export async function addExamEntry(entry) {
  await requireDB().execute(
    'INSERT INTO exam_history (word, correct, question_type, examined_at) VALUES ($1, $2, $3, $4)',
    [entry.word, entry.correct ? 1 : 0, entry.questionType || null, entry.examinedAt ?? new Date().toISOString()]   // E2: examined_at ISO 帶 Z（不再靠 DEFAULT naive）
  );
}

export async function getAllExamHistory() {
  return await requireDB().select('SELECT * FROM exam_history ORDER BY examined_at');
}

// ─── Goal Streak ────────────────────────────────

export async function getGoalStreak() {
  const rows = await requireDB().select('SELECT daily_goal, current, best, dates FROM goal_streak WHERE id = 1');
  if (rows.length === 0) return { dailyGoal: 20, current: 0, best: 0, dates: { flip: [], mc: [], spell: [] } };
  const r = rows[0];
  const raw = r.dates ? parseJSON(r.dates, {}) : {};
  if (Array.isArray(raw)) {
    return { dailyGoal: r.daily_goal, current: r.current, best: r.best, dates: { flip: [...raw], mc: [...raw], spell: [...raw] } };
  }
  return {
    dailyGoal: r.daily_goal,
    current: r.current,
    best: r.best,
    dates: { flip: Array.isArray(raw.flip) ? raw.flip : [], mc: Array.isArray(raw.mc) ? raw.mc : [], spell: Array.isArray(raw.spell) ? raw.spell : [] },
  };
}

export async function saveGoalStreak(data) {
  await requireDB().execute(
    `INSERT INTO goal_streak (id, daily_goal, current, best, dates)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT(id) DO UPDATE SET
       daily_goal=excluded.daily_goal, current=excluded.current,
       best=excluded.best, dates=excluded.dates`,
    [data.dailyGoal || 20, data.current || 0, data.best || 0, JSON.stringify(data.dates || [])]
  );
}

// ─── Filtered Decks ─────────────────────────────

export async function getAllFilteredDecks() {
  return await requireDB().select(
    'SELECT id, name, search_query, max_cards, order_by, color, created_at, last_used FROM filtered_decks ORDER BY name'
  );
}

export async function saveFilteredDeck(deck) {
  await requireDB().execute(
    `INSERT INTO filtered_decks (id, name, search_query, max_cards, order_by, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, search_query=excluded.search_query,
       max_cards=excluded.max_cards, order_by=excluded.order_by, color=excluded.color`,
    [deck.id, deck.name, deck.search_query, deck.max_cards || 100, deck.order_by || 'due', deck.color || '#f59e0b']
  );
}

export async function updateFilteredDeckLastUsed(id) {
  await requireDB().execute(
    'UPDATE filtered_decks SET last_used = $2 WHERE id = $1',
    [id, new Date().toISOString()]   // E2: ISO 帶 Z
  );
}

export async function deleteFilteredDeck(id) {
  await requireDB().execute('DELETE FROM filtered_decks WHERE id = $1', [id]);
}

// ─── Clear All Data ────────────────────────────

export async function executeSQL(sql, params = []) {
  await requireDB().execute(sql, params);
}

export async function clearAll() {
  const d = requireDB();
  try {
    await d.execute('BEGIN TRANSACTION');
    await d.execute('DELETE FROM words');
    await d.execute('DELETE FROM cards');
    await d.execute('DELETE FROM decks');
    await d.execute('DELETE FROM folders');
    await d.execute('DELETE FROM additions');
    await d.execute('DELETE FROM review_log');
    await d.execute('DELETE FROM exam_history');
    await d.execute('DELETE FROM goal_streak');
    await d.execute('DELETE FROM filtered_decks');
    try { await d.execute('DELETE FROM edits'); } catch (_) {}
    await d.execute('DELETE FROM settings');
    await d.execute('COMMIT');
    // 審計記錄保留 (不隨 clearAll 刪除), 讓「重設」這件事留痕
    try { await addAudit('reset-all', '所有資料已清除'); } catch (_) {}
  } catch (e) {
    await d.execute('ROLLBACK');
    throw e;
  }
}

// ─── Helpers ────────────────────────────────────

function parseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
''

## FILE: src-tauri/capabilities/default.json
''
{
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-fullscreen",
    "core:window:allow-is-fullscreen",
    "sql:default",
    "sql:allow-execute",
    "log:default",
    "dialog:default",
    "dialog:allow-save",
    "dialog:allow-open",
    "opener:default",
    "opener:allow-open-url"
  ]
}
''

## FILE: src/lib/store.js (節錄: addWord 區段)
''
    },

    /** Start a background task */
    startBackgroundTask(id, label, total) {
      state.backgroundTasks = state.backgroundTasks.filter(t => t.id !== id);
      state.backgroundTasks.push({ id, label, done: 0, total, status: 'running' });
      notify();
    },
    /** Update background task progress */
    updateBackgroundTask(id, done, total) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.done = done; t.total = total; notify(); }
    },
    /** Complete a background task successfully */
    completeBackgroundTask(id, result) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.status = 'done'; t.done = t.total; t.result = result; notify(); }
    },
    /** Mark a background task as failed */
    failBackgroundTask(id, error) {
      const t = state.backgroundTasks.find(t => t.id === id);
      if (t) { t.status = 'failed'; t.error = error; notify(); }
    },
    /** Remove a background task from the list */
    dismissBackgroundTask(id) {
      state.backgroundTasks = state.backgroundTasks.filter(t => t.id !== id);
      notify();
    },

    /** Add a new word */
    async addWord(wordData) {
      const word = {
        id: nextWordId(),
        word: wordData.word.toLowerCase().trim(),
        definition: wordData.definition || '',
        pos: wordData.pos || '',
        pron: wordData.pron || '',
        example: wordData.example || '',
        deck: wordData.deck || 'Default',
        tags: wordData.tags || [],
        image: wordData.image || '',
        description: wordData.description || '',
        related: wordData.related || [],
        forms: wordData.forms || [],
        synonym: wordData.synonym || '',
        antonym: wordData.antonym || '',
        derivative: wordData.derivative || '',
        examples: wordData.examples || [],
        createdAt: new Date().toISOString(),
      };
      state.words.push(word);
      try { await db.saveWord(word); } catch (e) { console.warn('[store] addWord saveWord error:', e); }
      await refreshDerived();
      notify();
      return word;
    },

    /**
     * Bulk import word objects. Skips duplicates (by lowercased word),
     * auto-creates any missing decks, and only notifies once at the end.
     * @param {object[]} words - parsed word objects
     * @param {(p:{done:number,total:number,added:number,skipped:number})=>void} [onProgress]
     * @returns {Promise<{added:number,skipped:number,decksCreated:string[]}>}
     */
    async importWords(words, onProgress) {
      const palette = ['#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb7185', '#fb923c', '#f0ecf5'];
      const existing = new Set(state.words.map(w => w.word.toLowerCase()));
      const deckByName = new Map(state.decks.map(d => [d.name, d]));
      const decksCreated = [];
      let added = 0, skipped = 0;
      const total = words.length;
      const now = new Date().toISOString();

      const newWords = [];

      for (let i = 0; i < total; i++) {
        const src = words[i];
        const w = (src.word || '').toLowerCase().trim();
        if (!w) { skipped++; continue; }
        if (existing.has(w)) { skipped++; if (onProgress) onProgress({ done: i + 1, total, added, skipped }); continue; }

        // Ensure deck exists
        const deckName = src.deck || 'Default';
        if (!deckByName.has(deckName)) {
          const color = palette[state.decks.length % palette.length];
          const deck = await this.createDeck(deckName, color);
          deckByName.set(deck.name, deck);
          decksCreated.push(deck.name);
        }

        const word = {
          id: nextWordId(),
          word: w,
          definition: src.definition || '',
          pos: src.pos || '',
          pron: src.pron || '',
          example: src.example || '',
          deck: deckName,
          tags: src.tags || [],
          image: src.image || '',
          description: src.description || '',
          related: src.related || [],
          forms: src.forms || [],
          synonym: src.synonym || '',
          antonym: src.antonym || '',
          derivative: src.derivative || '',
          examples: src.examples || [],
          createdAt: now,
        };
        state.words.push(word);
        existing.add(w);
        newWords.push(word);
        added++;
        if (onProgress && (i % 3 === 0 || i === total - 1)) {
          onProgress({ done: i + 1, total, added, skipped });
        }
      }

      // ponytail: single transaction for bulk insert
      if (newWords.length) {
        try { await db.executeSQL('BEGIN TRANSACTION'); } catch (_) {}
        try {
          for (const w of newWords) await db.saveWord(w);
          await db.executeSQL('COMMIT');
        } catch (e) {
          await db.executeSQL('ROLLBACK');
          console.warn('[store] importWords bulk insert error:', e);
        }
      }

      await refreshDerived();
      notify();
      return { added, skipped, decksCreated };
    },

    /** Edit a word */
    async editWord(id, updates) {
      const idx = state.words.findIndex(w => w.id === id);
      if (idx === -1) return;
      state.words[idx] = { ...state.words[idx], ...updates };
      try { await db.saveWord(state.words[idx]); } catch (e) { console.warn('[store] editWord saveWord error:', e); }
''

## FILE: src-tauri/src/lib.rs (節錄: 所有 tauri command 簽名)
''

#[tauri::command]
fn walk_piper_dir(dir: &std::path::Path, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
--

#[tauri::command]
fn list_piper_voices(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = piper_models_dir(&app_handle)?;
    Ok(collect_piper_voices(&data_dir))
--
// 開啟 report.html 圖表報告 (獨立視窗, file:// 讀 config 目錄)
#[tauri::command]
fn open_report(app_handle: tauri::AppHandle) -> Result<(), String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let report_path = format!("{}/.config/com.teno.app/sim-logs/report.html", home);
--
/// App paths the frontend needs (config dir, sim-logs dir) — no hardcoded HOME paths.
#[tauri::command]
fn get_app_paths(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
--

#[tauri::command]
async fn run_cli(app_handle: tauri::AppHandle, args: Vec<String>) -> Result<String, String> {
    log::info!("run_cli args={:?}", args);
    let cli_path = resolve_cli_path(&app_handle).ok_or_else(|| {
--

#[tauri::command]
fn scrape_quizlet(url: String) -> Result<String, String> {
    log::info!("scrape_quizlet url={}", url);
    if !url.starts_with("https://") { return Err("僅允許 HTTPS 連線".to_string()); }
--

#[tauri::command]
async fn fetch_llm(url: String, model: String, prompt: String, api_format: Option<String>) -> Result<String, String> {
    log::info!("fetch_llm url={} model={} prompt_len={} format={:?}", url, model, prompt.len(), api_format);
    let fmt = api_format.unwrap_or_default();
--

#[tauri::command]
async fn fetch_get(url: String) -> Result<String, String> {
    log::info!("fetch_get url={}", url);
    check_fetch_get_url(&url)?;
--

#[tauri::command]
async fn lookup_cambridge(word: String, lang: Option<String>) -> Result<String, String> {
    let is_zh = lang.as_deref() == Some("zh");
    let url = if is_zh {
--

#[tauri::command]
async fn speak_text(text: String, voice: Option<String>, length_scale: Option<f64>, noise_scale: Option<f64>, app_handle: tauri::AppHandle) -> Result<(), String> {
    if TTS_PLAYING.swap(true, Ordering::Acquire) {
        return Err("已有語音正在播放".to_string());
--

#[tauri::command]
async fn import_piper_model_dialog(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
fn delete_piper_model(name: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let data_dir = piper_models_dir(&app_handle)?;
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
--

#[tauri::command]
fn install_piper_model(url: String, app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = piper_models_dir(&app_handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("建立模型目錄失敗: {}", e))?;
--

#[tauri::command]
fn write_db_bytes(app_handle: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    log::info!("write_db_bytes app_dir={:?} data_len={}", app_dir, data.len());
--

#[tauri::command]
async fn import_db_dialog(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
fn optimize_fsrs(reviews: Vec<FsrsReviewEntry>) -> Result<Vec<f32>, String> {
    use std::collections::HashMap;
    use fsrs::{compute_parameters, ComputeParametersInput, FSRSItem, FSRSReview};
--

#[tauri::command]
fn simulate_fsrs(req: SimulateFsrsRequest) -> Result<SimulateFsrsResponse, String> {
    use fsrs::{extract_simulator_config, optimal_retention, simulate, Card, RevlogEntry};
    use std::sync::Arc;
--

#[tauri::command]
fn log_msg(msg: String) {
    use std::io::Write;
    log::info!("[js] {msg}");
--

#[tauri::command]
async fn export_db_dialog(app_handle: tauri::AppHandle, include_log: bool) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
async fn export_csv_dialog(app_handle: tauri::AppHandle, csv: String, filename: String) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
--

#[tauri::command]
fn backup_db(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("teno.db");
--

#[tauri::command]
fn prune_backups(app_handle: tauri::AppHandle, max_count: u32) -> Result<u32, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
fn get_db_mtime(app_handle: tauri::AppHandle) -> Result<u64, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("teno.db");
--

#[tauri::command]
fn list_backups(app_handle: tauri::AppHandle) -> Result<Vec<BackupEntry>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
fn restore_backup(app_handle: tauri::AppHandle, filename: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
fn delete_backup(app_handle: tauri::AppHandle, filename: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
--

#[tauri::command]
async fn export_csv_data(csv: String, _filename: String) -> Result<String, String> {
    let mut content = "\u{FEFF}".to_string();
    content.push_str(&csv);
--

#[tauri::command]
async fn export_db_data(app_handle: tauri::AppHandle, include_log: bool) -> Result<Vec<u8>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    pack_db_container(&app_dir, include_log)
--

#[tauri::command]
async fn export_backup_data(app_handle: tauri::AppHandle, filename: String) -> Result<Vec<u8>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let safe_name = std::path::Path::new(&filename).file_name().ok_or("非法檔名")?.to_string_lossy().to_string();
--

#[tauri::command]
async fn export_backup_dialog(app_handle: tauri::AppHandle, filename: String) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
''

## FILE: src-tauri/src/lib.rs (節錄: run() plugin 註冊)
''
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create core tables",
            sql: "
                CREATE TABLE IF NOT EXISTS words (
                    id TEXT PRIMARY KEY,
                    word TEXT NOT NULL,
                    definition TEXT,
                    part_of_speech TEXT,
                    pronunciation TEXT,
                    example TEXT,
                    deck TEXT NOT NULL DEFAULT 'Default',
                    tags TEXT DEFAULT '',
                    image TEXT DEFAULT '',
                    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))   // E2: DEFAULT 硬化（fresh-install）
                );

                CREATE TABLE IF NOT EXISTS cards (
                    word_id TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
                    due TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    stability REAL NOT NULL DEFAULT 2.5,
                    difficulty REAL NOT NULL DEFAULT 0.0,
                    elapsed_days INTEGER NOT NULL DEFAULT 0,
                    scheduled_days INTEGER NOT NULL DEFAULT 0,
                    reps INTEGER NOT NULL DEFAULT 0,
                    lapses INTEGER NOT NULL DEFAULT 0,
                    state INTEGER NOT NULL DEFAULT 0,
                    last_review TEXT,
                    buried INTEGER NOT NULL DEFAULT 0,
                    suspended INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS decks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    color TEXT DEFAULT '#5e6ad2'
                );

                CREATE TABLE IF NOT EXISTS folders (
                    name TEXT PRIMARY KEY,
                    decks TEXT NOT NULL DEFAULT '[]'
                );

                CREATE TABLE IF NOT EXISTS additions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    word TEXT NOT NULL,
                    definition TEXT,
''
