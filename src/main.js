// ═══════════════════════════════════════════════════════════════
// Main — Entry point. Creates store, mounts app shell, routes pages.
// v05.01.00.0010
// ═══════════════════════════════════════════════════════════════

import { createStore } from './lib/store.js';
import { icon } from './lib/svg.js';
import { computeStreak } from './core/scheduler.js';
import { initCustomSelects, closeAll } from './lib/custom-select.js';
import { invoke } from '@tauri-apps/api/core';
import { logToDb, classifyScope } from './lib/app-log.js';
import { ICON_PRESETS, iconImgPath } from './lib/icon-presets.js';
import { PLUGINS, PLUGIN_PARENT } from './lib/plugins.js';

// ─── G3：子頁 → 主頁 mapping（nav 高亮用）——子頁（study-v4/exam-flip/deck-browser…）
// 屬主頁的「深度態」，active 應落在所屬主頁，而非 nav 全滅。
const SUBPAGE_PARENT = {
  'study-v4': 'study', 'study-mc': 'study', 'study-spell': 'study',
  'exam-flip': 'exam', 'exam-mc': 'exam', 'exam-spell': 'exam',
  'deck-browser': 'browser', 'tag-manager': 'browser',
  'import': 'tools', 'export': 'tools', 'ocr': 'tools', 'simulator': 'tools',
  'app-log': 'settings',
  ...PLUGIN_PARENT,   // 插件子頁（grammar／gsat…）→ 題目
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
// LOG-SCOPE1：轉發先分類（scope 出生即定）；鏡像（Rust 檔＋DB）受 window.__logMirrorEnabled
// 開關（store 載入設定後賦值，預設開＝沿用舊行為）。error 一律轉發＋寫庫（強制保留）。
try {
  if (typeof window !== 'undefined' && window.__logMirrorEnabled === undefined) window.__logMirrorEnabled = true;
  const fwd = (level) => (...args) => {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const scope = classifyScope(msg);
    const mirrorOn = typeof window === 'undefined' || window.__logMirrorEnabled !== false;
    if (mirrorOn || level === 'error') {
      invoke('log_msg', { msg: `[${level}] ${msg}` }).catch(() => {});
    }
    if (!mirrorOn && level !== 'error') return;
    logToDb(level, scope, msg);
  };
  console.log = fwd('log');
  console.warn = fwd('warn');
  console.error = fwd('error');
  invoke('log_msg', { msg: '[boot] console forwarding enabled' }).catch(() => {});
  logToDb('log', 'system', '[boot] console forwarding enabled');
} catch (_) {}

// ─── App state & toast (extracted to lib/ to avoid pages→main.js cycle) ───
export { store } from './lib/app-store.js';
export { toast } from './lib/toast.js';
import { store } from './lib/app-store.js';
import { toast } from './lib/toast.js';

// ─── Lazy page imports ───
const pages = {};

async function loadPage(name) {
  if (!pages[name]) {
    pages[name] = await import(`./pages/${name}.js`);
  }
  return pages[name];
}

// ═══ KEEPALIVE1：主頁預渲染圖層 ═══
// 使用者定調（2026-09-26）：
//   ① 五個主頁全部事先渲染好，渲染成本攤在 splash；
//   ② 前置作業沒做完，splash 不准退場；
//   ③ 但超過 PRERENDER_HARD_MS 一律強制進場（不能把使用者困在登入畫面動彈不得）。
//
// 實測動機（6x CPU 節流 ≈ 中階 Android WebView、真實 4921 詞）：
//   原本每次換頁 = 動態載 chunk + render() 重建字串 + innerHTML 整頁重解析 + onMount。
//   單次 render() 冷呼叫：設定 460ms／儀表板 187ms／字庫 106ms；innerHTML 解析+排版另計
//   （字庫 165–500ms）。加起來就是使用者感覺到的「每次跳頁等半秒到一秒」。
//   改成圖層切換後，換頁只剩切 .active → 實測平均 53ms、最差 157ms，且 render 成本歸零。
const MAIN_PAGES = ['dashboard', 'study', 'browser', 'tools', 'settings'];
const PRERENDER_HARD_MS = 60_000;
/** name → { root, dirty }；root 是留在 DOM 裡的 .page 圖層（見 prerenderMainPages） */
const pageLayers = new Map();
/** 目前顯示中的 .page 元素（主頁圖層，或動態子頁用的 #pageContainer） */
let _activeRoot = null;
/** 預渲染進行中（此時不標髒，見 markLayersDirty） */
let _prerendering = false;
// ─── KEEPALIVE2：子頁 keep-alive／捲動記憶（stashSubpage/tryWarmEnter/applySub）───
/** 容器內子頁名（apply 設、stash 清） */
let _activeSub = null;
/** 產生當前 DOM 的 render 字串（暖命中新鮮度指紋） */
let _activeSubHtml = null;
/** apply 時的 container.firstElementChild（投毒偵測：ghost 蓋版後身分不符 → 不快取） */
let _activeSubRoot = null;
/** 目前顯示頁名（捲動 key；boot 無名 → null，存點 guard 掉 undefined 鍵） */
let _activeRootName = null;
/** name → { nodes, html }；FIFO 上限 6 */
const _subCache = new Map();
/** 頁名 → scrollTop（存點一律在 remove('active') 之前，見 setActiveRoot） */
const _scrollPos = new Map();

// ─── Mount app ───
const $ = (id) => document.getElementById(id);
const app = $('app');

const PAGE_NAMES = {
  dashboard: '儀表板', study: '學習',
  'study-v4': '翻卡學習', 'study-mc': '多選學習', 'study-spell': '拼字學習',
  exam: '測驗',
  'exam-flip': '翻卡測驗', 'exam-mc': '多選測驗', 'exam-spell': '拼字測驗',
  topics: '題目',
  simulator: '模擬', settings: '設定', tools: '工具', browser: '字庫',
  'deck-browser': '字本', 'app-log': '操作日誌', ocr: 'OCR 工具',
  ...Object.fromEntries(PLUGINS.map(p => [p.id, p.label])),   // 插件頁標題
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
    { id: 'topics', label: '題目', icon: 'target' },
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
        <!-- KEEPALIVE1：順序有意義 —— #pageContainer（動態子頁）必須排在主頁圖層前面。
             主頁與子頁有 32 組重複 id（#dropZone #scrollTopBtn 等），document.getElementById
             取文件順序第一個；子頁排前面才會命中子頁自己那顆，否則 import/export 會抓到設定頁的元素。
             主頁圖層由 prerenderMainPages() 依序接在後面，五頁之間實測 0 組 id 衝突。 -->
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

  // 點 sidebar 外自動縮回（桌機寬螢幕用；窄螢幕原本走 backdrop，這裡順手一起吃）。
  // 開關鈕 #sidebarReopen 本身在外，要排除，不然點開瞬間會被同一泡泡關掉。
  if (!window.__sidebarOutsideBound) {
    window.__sidebarOutsideBound = true;
    document.addEventListener('click', (e) => {
      const sidebar = document.getElementById('sidebar');
      if (!sidebar || sidebar.classList.contains('hidden')) return;
      if (e.target.closest('#sidebar')) return;
      if (e.target.closest('#sidebarReopen')) return;
      if (e.target.closest('#sidebarBackdrop')) return;
      sidebar.classList.add('hidden');
      document.getElementById('sidebarBackdrop')?.classList.remove('show');
    });
  }

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

/**
 * KEEPALIVE1：預渲染五個主頁。
 *
 * 做法：**逐一「單獨掛進 DOM → 渲染 → onMount → 收起來」**，最後才全部一起插回。
 * 為什麼要這麼繞：頁面模組的 onMount 是照「此刻 DOM 裡只有自己這一頁」寫的
 * （全用 document.querySelectorAll）。一次只掛一頁，onMount 就跑在與舊架構完全相同的
 * 條件下，不必去改五個頁面模組的選擇器。
 * （另外 lib/scope-dom.js 仍會在 onMount 期間把查詢導向本頁圖層，兩層保險。）
 *
 * @param {number} deadline 硬性截止時間（ms epoch）；超過就停手，剩下的頁面之後按需即時渲染
 * @returns {{built: string[], skipped: string[]}}
 */
async function prerenderMainPages(deadline) {
  const area = $('contentArea');
  const subEl = $('pageContainer');
  const built = [];
  const skipped = [];
  _prerendering = true;               // 期間不標髒（見 store.subscribe）
  subEl.remove();                     // 舞台清空（splash 蓋著，看不到）
  try {
    for (const name of MAIN_PAGES) {
      if (Date.now() >= deadline) { skipped.push(name); continue; }
      const root = document.createElement('div');
      root.className = 'page';
      root.id = 'page-' + name;
      area.appendChild(root);         // 此刻 DOM 裡的 .page 只有這一頁
      let ok = false;
      try {
        const mod = await loadPage(name);
        if (Date.now() < deadline) {
          root.innerHTML = mod.render(store) ?? '';
          if (typeof mod.onMount === 'function') mod.onMount(store);
          initCustomSelects(root);
          pageLayers.set(name, { root, dirty: false });
          built.push(root);
          ok = true;
        }
      } catch (e) {
        console.error('[keepalive] 預渲染失敗：', name, e);
      }
      if (!ok) { root.remove(); skipped.push(name); }
    }
  } finally {
    for (const r of built) r.remove();          // 先全收起來…
    area.append(subEl, ...built);               // …再按「子頁容器在最前」的順序插回
    _prerendering = false;
  }
  return { built: built.map(r => r.id), skipped };
}

/** 瞬時捲動（inline auto 繞過 .content-area 的 scroll-behavior:smooth —— Chrome 對 scrollTop
 *  賦值也套 smooth，直接設會動畫跨幀） */
function setScrollNow(area, y) {
  const sb = area.style.scrollBehavior;
  area.style.scrollBehavior = 'auto';
  area.scrollTop = y;
  area.style.scrollBehavior = sb;
}

/** 把某一頁顯示出來（切 .active，零重建）。離開的那頁順手清掉掛在上面的浮層。
 *  KEEPALIVE2：帶頁名 —— 存/還原捲動都 keyed by 頁名；存點必須在 remove('active')
 *  之前（display:none 當幀會把 scrollHeight 壓塌、scrollTop 被 clamp 成 0 不可逆）。 */
function setActiveRoot(el, name) {
  if (!el) return;
  if (_activeRoot === el) { if (name) _activeRootName = name; return; }   // 子→子：stash 已存，這裡只換名
  const area = $('contentArea');
  if (_activeRoot && area && _activeRootName != null) _scrollPos.set(_activeRootName, area.scrollTop);
  if (_activeRoot) {
    _activeRoot.classList.remove('active');
    onRootDeactivate(_activeRoot);
  }
  _activeRoot = el;
  el.classList.add('active');
  if (name) _activeRootName = name;
  if (area) setScrollNow(area, _scrollPos.get(name) ?? 0);
}

/** 離開一頁時的清理。
 *  換頁在舊架構是「整頁重繪」，這些浮層本來就會跟著消失；頁面改成保留在 DOM 之後
 *  必須自己清，否則浮層會留在隱藏的圖層裡、下次回到該頁又冒出來。
 *  （keydown 之類的 document 級監聽由頁面自己註冊的 window.__pageCleanup 負責，見 renderPage）
 *
 *  ★ 子頁容器 #pageContainer 額外要整碗清掉：它排在文件最前面（見 renderShell 註解），
 *    裡面的元素在 getElementById 撞名時會**優先命中**。留著上一輪子頁的 #dropZone /
 *    #scrollTopBtn 會蓋掉主頁自己那顆，讓 import/export 之類操作到錯的元素。 */
function onRootDeactivate(root) {
  try {
    // KEEPALIVE2：子頁容器改走 stashSubpage（存捲動＋移出快取＋整碗清在 finally）
    if (root.id === 'pageContainer') { stashSubpage(); return; }
    root.querySelectorAll('.modal-overlay').forEach(el => el.remove());
    root.querySelectorAll('#cardPreviewModal, #deckCardPreview').forEach(el => el.remove());
    root.querySelectorAll('.cs.o').forEach(el => el.classList.remove('o'));
  } catch (e) { console.warn('[keepalive] 離頁清理：', e); }
}

/** 就地重繪一頁圖層（render → innerHTML → onMount）。頁面隱藏中也安全：
 *  五個主頁的 onMount 都不讀版面尺寸（已逐檔確認無 getBoundingClientRect/clientWidth/offsetWidth），
 *  所以隱藏時掛載不會拿到 0 尺寸。 */
function refreshLayer(name) {
  const layer = pageLayers.get(name);
  const mod = pages[name];
  if (!layer || !mod || typeof mod.render !== 'function') return;
  try {
    layer.root.innerHTML = mod.render(store) ?? '';
    if (typeof mod.onMount === 'function') mod.onMount(store);
    initCustomSelects(layer.root);
    layer.dirty = false;
  } catch (e) { console.error('[keepalive] 重繪失敗：', name, e); }
}

// ── 髒標記 + 閒置背景補重繪 ──
// 主頁不再每次換頁重繪，所以資料一動就要標髒，換頁前補上。
// 補重繪有兩條路：① 閒置時背景做（讓換頁幾乎不會遇到）② 換頁當下若還髒就同步做。
// 有了 KEEPALIVE1-PERF1 之後重繪很便宜（儀表板 ~95ms@6x、設定 ~8ms、學習/工具 ~0ms），
// 所以①沒趕上也不會痛。
const IDLE_REFRESH_DELAY_MS = 800;
let _idleRefreshTimer = null;
let _idleRefreshHandle = null;

/** 主頁圖層「內容相關」資料的指紋。
 *
 *  為什麼不能直接「每次 notify 就標髒」：`navigate()` 自己也會 notify，
 *  而 notify 跑訂閱者時 `renderPage` 還排在 rAF 上（`_activeRoot` 仍是上一頁）
 *  → 正要前往的那一頁會被標髒 → renderPage 進去看見 dirty 就同步重繪一次。
 *  結果是**每次換頁都白付一次 render**（實測儀表板 +95ms@6x，換頁 131–168ms 裡大半是這個），
 *  keep-alive 的成果直接還回去一半。
 *  用指紋擋掉「純導航 / 無關 UI 變動」造成的通知，只留真的改到資料的那種。
 *  未涵蓋：settings 頁的多數純設定鍵（那頁自己的操作都會 renderInPlace 就地更新，不受影響）。 */
function layersSignature(s) {
  const n = (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : 0);
  const st = s.stats || {};
  const gs = s.goalStreak || {};
  const d = gs.dates || {};
  return [
    n(s.words), n(s.decks), s.cards.size, s.cardsMc.size, s.cardsSpell.size,
    n(s.reviewLog), n(s.examHistory), n(s.tags), n(s.systemTags),
    s.buried.size, s.suspended.size, s.buriedMc.size, s.suspendedMc.size, s.buriedSpell.size, s.suspendedSpell.size,
    s.dueCount, s.dueCountMc, s.dueCountSpell,
    st.total, st.learned, st.new, st.due, st.mature, st.young, st.avgDifficulty,
    s.newRatedToday, s.newRatedTodayMc, s.newRatedTodaySpell,
    s.dayCutoff, s.reviewDeckFilter, n(s.filteredDecks), n(s.examSessions), n(s.backgroundTasks),
    n(d.flip), n(d.mc), n(d.spell), gs.dailyGoal, gs.best, gs.current,
    s.themeMode, s.themeAccent, s.themeAccentIntensity, s.uiScaleIdx, s.devMode,
    n(s.blacklist), n(s.graylist), n(s.fieldVisBrowser), n(s.fieldVisStudy), n(s.fieldVisExam),
    n(s.colorPalette), s.browserDeckLock === true ? 1 : 0, n(s.examples),
  ].join(',');
}
/** 上次看到的資料指紋（boot 後初始化，見 init IIFE） */
let _layerSig = null;

/** 把五個圖層全部標髒（含顯示中的那頁）。
 *  顯示中那頁標髒但不重繪（閒置補重繪會跳過它、換頁時也不會自己活起來），
 *  等使用者離開再回來時 renderPage 才補 —— 與舊架構「回到該頁重新渲染」語意一致。 */
function markLayersDirty() {
  for (const [, layer] of pageLayers) layer.dirty = true;
  scheduleIdleRefresh();
}

function scheduleIdleRefresh() {
  if (_idleRefreshTimer) clearTimeout(_idleRefreshTimer);
  _idleRefreshTimer = setTimeout(() => {
    _idleRefreshTimer = null;
    if (document.visibilityState !== 'visible') return;
    const run = (deadline) => {
      _idleRefreshHandle = null;
      for (const [name, layer] of pageLayers) {
        if (!layer.dirty || layer.root === _activeRoot) continue;
        if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 5) break;   // 時間不夠，剩下的下一輪
        refreshLayer(name);
      }
      for (const [, layer] of pageLayers) {
        if (layer.dirty && layer.root !== _activeRoot) { scheduleIdleRefresh(); break; }
      }
    };
    _idleRefreshHandle = (typeof requestIdleCallback === 'function')
      ? requestIdleCallback(run, { timeout: 2000 })
      : setTimeout(() => run(null), 0);
  }, IDLE_REFRESH_DELAY_MS);
}

/** KEEPALIVE2 丁：每頁捲動還原（瞬時，見 setScrollNow） */
function restoreScroll(name) {
  const a = $('contentArea');
  if (a) setScrollNow(a, _scrollPos.get(name) ?? 0);
}

/** KEEPALIVE2 乙：髒層先上屏、下一幀前補繪（補繪可能壓縮高度 → 還原捲動） */
function deferRefresh(name) {
  requestAnimationFrame(() => {
    const l = pageLayers.get(name);
    if (l && l.dirty) {
      refreshLayer(name);
      if (_activeRootName === name) restoreScroll(name);
    }
  });
}

// [K2-BEGIN] — KEEPALIVE2 核心（tools/verify-keepalive2.mjs 抽真碼跑 jsdom 動態腿；中間勿插非 K2 碼）

/** 離場時把 select 的使用者選取寫回 option[selected] 內容屬性（property 級變更 clone 不帶）。 */
function k2SyncSelectOptions(root) {
  const sels = root.querySelectorAll ? root.querySelectorAll('select') : [];
  for (const sel of sels) {
    const idx = sel.selectedIndex;
    if (idx < 0) continue;
    const opts = sel.options;
    for (let i = 0; i < opts.length; i++) {
      if (i === idx) opts[i].setAttribute('selected', '');
      else opts[i].removeAttribute('selected');
    }
  }
}

/** clone 後拆掉 custom-select 綁定痕跡（data-cs＋前兄弟 .cs-wrap），重建時視為新 select。 */
function k2StripSelects(sel) {
  delete sel.dataset.cs;
  const prev = sel.previousElementSibling;
  if (prev && prev.classList && prev.classList.contains('cs-wrap')) prev.remove();
}

/** 離場唯一收斂點。同步段只做 O(1)：存捲動、快照頂層節點引用、清容器；
 *  浮層清理／搬移／select 同步／clone 快取全交 rIC（Profiler：同步段曾吃掉導航 400–600ms）。 */
function stashSubpage() {
  const container = $('pageContainer');
  try {
    closeAll();                                // 實測 0.1ms，保同步（menu 狀態收斂與快取無關）
    const name = _activeSub;                 // 快照：idle 只吃參數，禁讀模組變數（讀了會配到新頁）
    const html = _activeSubHtml;
    if (name && container.firstElementChild && container.firstElementChild === _activeSubRoot) {
      const refs = [...container.childNodes];   // 引用快照：清空後仍活著，不搬不查（µs 級）
      const idle = () => k2CacheIdle(name, html, refs);
      if (typeof requestIdleCallback === 'function') requestIdleCallback(idle, { timeout: 1000 });
      else setTimeout(idle, 200);
    }
  } finally {
    container.innerHTML = '';
    _activeSub = null;
    _activeSubHtml = null;
    _activeSubRoot = null;
    container.classList.remove('leaving');
  }
}

/** idle：浮層剝除 → 選取寫回 → clone → strip → 快取（FIFO 6）。idle 沒跑完就回訪 = 走冷路徑，無 pending 佇列。 */
function k2CacheIdle(name, html, refs) {
  const holder = document.createElement('div');
  const OVERLAY = '.modal-overlay, #cardPreviewModal, #deckCardPreview';
  for (const n of refs) {
    if (n.nodeType !== 1) { holder.append(n); continue; }
    if (n.matches(OVERLAY)) continue;              // 頂層浮層不入快取
    n.querySelectorAll(OVERLAY).forEach(el => el.remove());
    n.querySelectorAll('.cs.o').forEach(el => el.classList.remove('o'));
    holder.append(n);
  }
  k2SyncSelectOptions(holder);
  const nodes = [...holder.childNodes].map(n => n.cloneNode(true));
  nodes.forEach(n => n.querySelectorAll?.('select[data-cs]')?.forEach(s => k2StripSelects(s)));
  _subCache.set(name, { nodes, html });
  if (_subCache.size > 6) _subCache.delete(_subCache.keys().next().value);
}

/** 暖命中 → 換入快取 DOM。html 不等（資料已變）→ 刪 entry 走冷路徑；命中即消耗。 */
function tryWarmEnter(page, rendered, gen, mod) {
  if (page === _activeSub) return false;      // forceRender 同頁：照舊重建
  const entry = _subCache.get(page);
  if (!entry) return false;
  if ((rendered ?? '') !== entry.html) { _subCache.delete(page); return false; }
  if (gen !== _renderGen) return false;
  const container = $('pageContainer');
  stashSubpage();
  container.replaceChildren(...entry.nodes);
  _subCache.delete(page);
  applySub(page, entry.html, mod);
  return true;
}

/** warm/cold 共用上屏：記帳 → 開點擊 → 上屏（setActiveRoot 同幀切 .active）→ 還原捲動 → onMount → select 重建。 */
function applySub(page, html, mod) {
  const container = $('pageContainer');
  _activeSub = page;
  _activeSubHtml = html;
  _activeSubRoot = container.firstElementChild;
  container.classList.remove('leaving');
  setActiveRoot(container, page);
  restoreScroll(page);
  if (typeof mod.onMount === 'function') mod.onMount(store);
  initCustomSelects(container);
}
// [K2-END]

async function renderPage() {
  const gen = ++_renderGen;          // 本輪 token；await 期間有新 renderPage → 本輪作廢
  const page = store.state.currentPage;

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

  // KEEPALIVE2：捲動存點固定在導航起點（此處樹乾淨 —— `.leaving`/髒化之後再讀 scrollTop
  // 會強制整棵大樹版面計算，實測 deck 1.57MB 下 316ms）。stash 不再讀 scrollTop。
  if (_activeSub) {
    const a = $('contentArea');
    if (a) _scrollPos.set(_activeSub, a.scrollTop);
  }

  // ─── KEEPALIVE1：主頁 = 切圖層（零重建）；KEEPALIVE2：髒層先上屏後補繪 ───
  const layer = pageLayers.get(page);
  if (layer) {
    setActiveRoot(layer.root, page);
    if (layer.dirty) deferRefresh(page);
    return;
  }

  const container = $('pageContainer');
  container.classList.add('leaving');            // 舊頁可見期間不可點（子→子；主→子時容器尚未上屏）

  // Load and render page
  try {
    const mod = await loadPage(page);
    if (gen !== _renderGen) return;   // G6：await 期間已換頁 → 舊頁丟棄，不覆蓋新頁
    if (typeof mod.render === 'function') {
      const rendered = mod.render(store);        // 只 render 一次（暖 miss 不重跑）
      if (tryWarmEnter(page, rendered, gen, mod)) return;
      stashSubpage();
      if (gen !== _renderGen) return;
      container.innerHTML = rendered ?? '';
      applySub(page, rendered ?? '', mod);
    } else {
      stashSubpage();
      container.classList.remove('leaving');
      setActiveRoot(container, page);
    }
  } catch (e) {
    if (gen !== _renderGen) return;   // 錯誤處理也受 guard：過期錯誤不洗掉新頁
    console.error('Page load error:', e);
    stashSubpage();
    container.innerHTML = `<div class="empty-state">
      ${icon('info')}
      <h3>載入失敗</h3>
      <p>${e.message}</p>
    </div>`;
    container.classList.remove('leaving');
    _activeSub = null;
    _activeSubHtml = null;
    setActiveRoot(container, page);
    restoreScroll(page);
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

// ─── KEEPALIVE1：資料變動 → 標記主頁圖層為髒（換頁前或閒置時才真的重繪）───
// 用資料指紋過濾：`navigate()` 本身也會 notify，不過濾的話每次換頁都會把目標頁標髒
// → 換頁當下必同步重繪一次（見 layersSignature 的說明）。
// 預渲染期間也跳過（那時各頁剛建好、內容一定是最新的，標了會害第一次換頁白重繪一次）。
store.subscribe((state) => {
  if (_prerendering) return;
  const sig = layersSignature(state);
  if (sig === _layerSig) return;
  _layerSig = sig;
  markLayersDirty();
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
  _activeRoot = $('pageContainer');    // KEEPALIVE1：初始顯示的是動態子頁容器（載入中畫面住在裡面）

  // Show a loading state while the store boots (DB load)
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

  // ─── KEEPALIVE1：主頁預渲染（使用者定調：前置沒做完 splash 不退場）───
  // 超過 PRERENDER_HARD_MS 就停手進場，剩下的頁面之後按需即時渲染（不會把使用者困在登入畫面）。
  try {
    const t0 = Date.now();
    const res = await prerenderMainPages(Date.now() + PRERENDER_HARD_MS);
    const skipped = res.skipped.length ? `（逾時略過：${res.skipped.join(',')}，之後按需渲染）` : '';
    console.log(`[keepalive] 預渲染 ${res.built.length}/${MAIN_PAGES.length} 頁，耗時 ${Date.now() - t0}ms ${skipped}`);
  } catch (e) {
    console.error('[keepalive] 預渲染異常：', e);
  }

  // ─── KEEPALIVE2：熱子頁 chunk 預載 ───
  // 實測（6x）：deck 圖層 1.57MB 活著時首次 import ocr 求值 105→455ms；stash 後置再 +90ms。
  // splash 期間 DOM 乾淨、載入成本最低，先把驗證過的四頁裝好 → 換頁 loadPage 全走快取。
  // ponytail: 只鎖這四頁；其他子頁冷進仍按需載入，有實測 jank 再擴充清單。
  try {
    const t0 = Date.now();
    for (const p of ['deck-browser', 'ocr', 'import', 'app-log']) await loadPage(p);
    console.log(`[keepalive] 子頁預載完成，耗時 ${Date.now() - t0}ms`);
  } catch (e) {
    console.error('[keepalive] 子頁預載異常：', e);
  }

  _layerSig = layersSignature(store.state);   // 記錄 boot 後的資料指紋（之後只回應真正的資料變動）

  renderPage();

  // WIDGET1：開 App 即推（Android 桌面 widget 同步今日到期數；其他平台 no-op）
  invoke('widget_refresh').catch(() => {});

  // WIDGETROUTE：桌面 widget 點擊路由（MainActivity flushTick evaluateJavascript 推送，回 1=原生清 pending）。
  // 狀態→study 複習；收詞→字庫新增 modal；抽字→字庫字卡預覽（_pendingWidget 同 _pendingDeckModal 型，
  // browser onMount 消費）。已停在字庫 → _forceRender 強制 self-nav 重跑 renderPage（deck-item 同型）。
  window.__widgetRoute = (route, arg) => {
    try {
      if (route === 'review') { store.actions.navigate('study'); return 1; }
      if (route === 'add' || route === 'word') {
        store.state._pendingWidget = route === 'add' ? { type: 'add' } : { type: 'word', id: arg };
        // pending 不在 layersSignature → 主動標髒 browser 圖層，否則 renderPage 快路徑
        // （圖層存在且未髒 → 直接 return）不重跑 onMount、pending 永遠沒人消費。
        const l = pageLayers.get('browser');
        if (l) l.dirty = true;
        if (store.state.currentPage === 'browser') _forceRender = true;   // 同頁：subscribe 只認 page change
        store.actions.navigate('browser');
        return 1;
      }
    } catch (e) { console.error('[main] widget route:', e); }
    return 1;
  };

  // Splash 退場：預渲染完成（或逾時）後才退場，且至少顯示 SPLASH_MIN_MS
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
  const dbMod = await import('./lib/db.js');
  if (!dbMod.isReady()) {
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

// ─── UISCALE1：桌機介面縮放（Ctrl +/- 切五檔、Ctrl+0 回 100%、Ctrl+滾輪同效）───
// 取代舊「禁縮放」：WebView 桌面版不認 viewport 縮放，改由 app 自己控 body zoom，
// 五檔存 DB（uiScaleIdx），跟瀏覽器手感一致。手機 pinch 照舊由 touch-action 鎖死。
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const cur = store.state?.uiScaleIdx ?? 0;
  store.actions?.setUiScale(cur + (e.deltaY > 0 ? -1 : 1));
}, { passive: false });
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (['=', '+'].includes(e.key)) { e.preventDefault(); store.actions?.setUiScale((store.state?.uiScaleIdx ?? 0) + 1); }
  else if (['-', '_'].includes(e.key)) { e.preventDefault(); store.actions?.setUiScale((store.state?.uiScaleIdx ?? 0) - 1); }
  else if (e.key === '0') { e.preventDefault(); store.actions?.setUiScale(0); }
});

// ─── A5: 跨天自動 unbury — Android 背景化過夜 resume 的補檢查（guard 一天一次）───
// ─── A-DASH1: 同場補 refreshDerived＋dashboard 重繪（開著 app 過換日線，首頁額度／到期數不再是昨天）───
document.addEventListener('visibilitychange', () => {
  // WIDGET1：離開（學完回桌面）與回來都推一次 — widget 數字跟著剛完成的作答更新
  invoke('widget_refresh').catch(() => {});
  if (document.visibilityState === 'visible') {
    store._autoUnburyIfNewDay?.().catch(e => console.warn('[main] autoUnbury:', e));
    store._refreshDerivedIfNewDay?.().then((refreshed) => {
      // 僅 dashboard 重繪（學習／測驗進行中不碰，當前會話不受擾；側欄由 notify 訂閱自刷）
      // KEEPALIVE1：跨日會動到 dueCount/stats（多頁都顯示）→ 先標髒再重繪當前頁
      if (refreshed) {
        for (const [, layer] of pageLayers) layer.dirty = true;
        if (store.state.currentPage === 'dashboard') renderPage();
      }
    }).catch(e => console.warn('[main] refreshDerived:', e));
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
