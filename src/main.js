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

// ─── G3：子頁 → 主頁 mapping（nav 高亮用）——子頁（study-v4/exam-flip/deck-browser…）
// 屬主頁的「深度態」，active 應落在所屬主頁，而非 nav 全滅。
const SUBPAGE_PARENT = {
  'study-v4': 'study', 'study-mc': 'study', 'study-spell': 'study',
  'exam-flip': 'exam', 'exam-mc': 'exam', 'exam-spell': 'exam',
  'deck-browser': 'browser', 'tag-manager': 'browser',
  'import': 'tools', 'export': 'tools', 'ocr': 'tools', 'simulator': 'tools', 'crop': 'tools',
  'app-log': 'settings',
};
const resolveNavPage = (p) => (SUBPAGE_PARENT[p] || p);

// ─── Splash：至少顯示 SPLASH_MIN_MS（蓋住久一點）+ 跟隨目前 launcher icon ───
// [F7-SPLASH-BEGIN]
// F7 v1.1：localStorage 開機 cache 前置（二次啟動 JS 期零閃爍）＋ getLauncherIcon
// 3 次重試（Android binder plugin 瞬時未 ready）＋ meta theme-color 跟 splash 底。
// 段自含鐵律：本段在 module 頂部同步執行，$ 尚未宣告（TDZ）→ 一律用
// document.getElementById（T1.10 釘）。
const SPLASH_MIN_MS = 1600;
const _splashStart = Date.now();

/** 依賴注入 seam（harness T2 動態腿在此 mock；生產態走真 import）。四鍵分離：
 *  getLauncherIcon（Rust IPC）/ initDB / getSetting（DB fallback 兩步）/ sleep（重試間隔）。 */
const _splashDeps = {
  async getLauncherIcon() {
    const { getLauncherIcon } = await import('./lib/api.js');
    return getLauncherIcon();
  },
  async initDB() {
    const { initDB } = await import('./lib/db.js');
    await initDB(2);
  },
  async getSetting() {
    const { getSetting } = await import('./lib/db.js');
    return getSetting('launcherIcon');
  },
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};

/** splash 快取鍵（唯一定義；settings.js 切 icon 成功點同步寫，成對釘 T1.7） */
const _SPLASH_KEY = '_splashIconKey';

function readSplashCache() {
  try { return localStorage.getItem(_SPLASH_KEY); } catch { return null; }
}

function writeSplashCache(key) {
  try { localStorage.setItem(_SPLASH_KEY, key); } catch { /* 無痕模式吞 */ }
}

/** 把 splash 背景 + 圖示切到指定 icon preset。
 *  persist=true（預設）→ 寫 cache；退場點/渲染 fallback 用 persist=false 防污染。 */
function applySplashIcon(key, persist = true) {
  try {
    const splash = document.getElementById('splash');
    if (!splash) return;
    const preset = ICON_PRESETS.find(p => p.key === key) || ICON_PRESETS[0];
    splash.style.background = preset.bg;
    const img = document.getElementById('splashIcon');
    if (img) {
      // G31: icon 圖檔完整性 — png 遺失/損壞時不顯示破圖。依目前 src 找下一個未試 preset，
      // 全失敗則隱藏 img（splash 仍有 spinner/字 不空稿）。持久 handler 保連鎖，已試 set 防死循環。
      let tried = new Set([preset.key]);
      img.onerror = () => {
        for (const p of ICON_PRESETS) {
          if (tried.has(p.key)) continue;
          tried.add(p.key);
          img.src = iconImgPath(p.key);
          return;
        }
        img.style.display = 'none';
      };
      img.src = iconImgPath(preset.key);
    }
    if (persist) writeSplashCache(preset.key);
    // meta theme-color 跟 splash 底（狀態欄色一致）；init 後 applyTheme 覆蓋回主題色。
    // theme-injected guard（theme.js 同款標記）：applyTheme 已跑則本回調讓位，
    // 防 icon 底污染 meta 整個 session；documentElement 缺失環境（測試 stub）跳過
    const meta = document.querySelector('meta[name="theme-color"]');
    const _injected = document.documentElement?.dataset?.themeInjected;
    if (meta && !_injected) meta.content = preset.bg;
  } catch (e) { console.error('[main] splash icon:', e); }
}

/** async 解析 launcher icon：Rust 3 次重試（僅前兩敗後 sleep 150ms，末敗直落 fallback）
 *  → DB fallback（initDB+getSetting 兩步）。 */
async function resolveSplashIcon(deps = _splashDeps) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const key = await deps.getLauncherIcon();
      if (key) return key;
      break; // 空 key＝非 Android 明確回應，無需重試
    } catch (e) {
      // plugin 瞬時未 ready → sleep 150ms 再試；最後一敗不 sleep 直接落 fallback
      if (attempt < 2) await deps.sleep(150);
    }
  }
  try {
    await deps.initDB();
    const key = await deps.getSetting();
    return key || 'original';
  } catch { return 'original'; }
}

// 開機 cache 命中 → 同步零等待套用（JS 期零閃爍；pre-JS 首幀由 CSS transition 柔化）
const _cachedSplashIcon = readSplashCache();
if (_cachedSplashIcon) applySplashIcon(_cachedSplashIcon, false);

// Splash 一進場就立刻讀 launcherIcon（不等完整 init — 冷啟動時 init
// 可能超過 SPLASH_MIN_MS，等 init 完 splash 早就 fade 了）。
(async () => { applySplashIcon(await resolveSplashIcon(_splashDeps)); })();
// [F7-SPLASH-END]

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

// ─── App state & toast (extracted to lib/ to avoid pages→main.js cycle) ───
export { store } from './lib/app-store.js';
export { toast } from './lib/toast.js';
import { store } from './lib/app-store.js';

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
  'deck-browser': '字本', 'app-log': '操作日誌', ocr: 'OCR 工具',
};

function renderSidebar() {
  const s = store.state;
  const decks = s.decks;
  const due = s.dueCount;
  const current = s.currentPage;
  const total = s.stats.total;
  const activeDeck = s.reviewDeckFilter;

  const homeItem = { id: 'dashboard', label: '儀表板', icon: 'home' };

  const navCurrent = resolveNavPage(current);

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
    <div class="nav-item ${navCurrent === n.id ? 'active' : ''}" data-page="${n.id}">
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
  const navCurrent = resolveNavPage(current);
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
        <div class="bottom-item ${navCurrent === n.id ? 'active' : ''}" data-page="${n.id}">
          ${icon(n.icon)}
          ${n.badge != null ? `<span class="bottom-badge">${n.badge}</span>` : ''}
        </div>
      `).join('')}
    </div>
    <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
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

  // G2（v3 2026-08-31 元首令）：FAB 已拔 — 字本另有途徑進入
  // （字庫 browser 頁 deck 卡/字本管理），手機側欄入口回歸 bottom-nav 頁面即足夠。
  // sidebarBackdrop 元素保留（點外關閉側欄，319 行綁定原先綁 null 的順修仍在）。

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

// ─── Render current page ───
let _renderGen = 0;   // G6：generation guard — 快速換頁時舊 renderPage 在 await 後丟棄

async function renderPage() {
  const gen = ++_renderGen;          // 本輪 token；await 期間有新 renderPage → 本輪作廢
  const page = store.state.currentPage;
  const container = $('pageContainer');
  container.className = 'page active';

  // Update sidebar active state + topbar
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === resolveNavPage(page));
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
    if (gen !== _renderGen) return;   // G6：await 期間已換頁 → 舊頁丟棄，不覆蓋新頁
    if (typeof mod.render === 'function') {
      const rendered = mod.render(store);
      if (gen !== _renderGen) return;   // render 期間（可能含 await）換頁 → 同樣丟棄
      container.innerHTML = rendered ?? '';
      if (typeof mod.onMount === 'function') mod.onMount(store);
      initCustomSelects(container);
    }
  } catch (e) {
    if (gen !== _renderGen) return;   // 錯誤處理也受 guard：過期錯誤不洗掉新頁
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
      el.classList.toggle('active', el.dataset.page === resolveNavPage(state.currentPage));
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
    import('./lib/human-data.js').then(hd => hd.track('page:' + state.currentPage)).catch(() => {});
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
    // 背景色 + 圖片跟隨目前 launcher icon（F7：收斂雙份碼→applySplashIcon；
    // persist=false 防 init 失敗的 'original' 渲染污染 cache）
    try {
      // F7：收斂雙份碼→applySplashIcon；persist=false 防 init 失敗的 'original' 渲染污染 cache
      applySplashIcon(store.state.launcherIcon || 'original', false);
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
