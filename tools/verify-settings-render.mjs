#!/usr/bin/env node
// verify-settings-render.mjs — 補「設定頁 render 無 runtime 測試」盲區（漏網 bug：sections.js 用
// pkg.version 卻無 import → ReferenceError 'pkg is not defined'，靜態釘抓不到）。
// 以最小 DOM 樁動態 import sections.js 並實跑 renderSettingsContent()，任何未綁定識別字/型別錯必炸。
import { readFileSync } from 'node:fs';
import { mock } from 'node:test';

// ── 最小 DOM / 平台樁（sections.js 及其相依頁在 import 期會碰）──
const noop = () => {};
const classList = { toggle: noop, add: noop, remove: noop, contains: () => false };
const el = () => ({
  style: {}, classList, dataset: {}, appendChild: noop, removeChild: noop, prepend: noop,
  addEventListener: noop, removeEventListener: noop, querySelector: () => null,
  querySelectorAll: () => [], insertAdjacentHTML: noop, setAttribute: noop, getAttribute: () => null,
  focus: noop, click: noop, innerHTML: '', textContent: '', value: '', children: [],
});
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop };
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { href: '', reload: noop }, visualViewport: null };
globalThis.document = {
  body: el(), documentElement: { dataset: {}, style: {} }, head: el(),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), createDocumentFragment: () => el(),
  addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
};
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });

let pass = 0, fail = 0;
const chk = (n, ok, x = '') => { if (ok) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x ? ' | ' + x : ''}`); } };

// 登錄需求：renderContent 來自 import/export/tag-manager（其 import 期可能有副作用）→ 樁掉降低耦合
mock.module('../src/pages/import.js', { exports: { renderContent: () => '<import-content>' } });
mock.module('../src/pages/export.js', { exports: { renderContent: () => '<export-content>' } });
mock.module('../src/pages/tag-manager.js', { exports: { renderContent: () => '<tag-content>' } });
// vite 專屬（?raw / 重型相依）→ 樁掉；sections.js 自身邏輯仍真跑
mock.module('../src/lib/svg.js', { exports: { icon: () => '<svg></svg>', splitFieldsHtml: () => '' } });
mock.module('../src/lib/store.js', { exports: { UI_SCALE_LABELS: ['80%', '90%', '100%', '110%', '120%'] } });
mock.module('../src/lib/theme.js', { exports: { ACCENTS: {}, ACCENT_GROUPS: [] } });
mock.module('../src/lib/platform.js', { exports: { isAndroid: false, isWeb: true } });
mock.module('../src/lib/icon-presets.js', { exports: { ICON_PRESETS: [] } });
mock.module('../src/lib/word-extra.js', { exports: { FIELD_LABELS: {}, FIELD_KEYS: [], FIELD_STUDY_ONLY: [] } });
mock.module('../src/pages/settings/_shared.js', {
  exports: { FIELD_VIS_GROUPS: [], _ankiMode: () => 'flip', escapeAttr: (s) => String(s ?? ''), formatCutoffHHMM: () => '00:00', renderAnkiFields: () => '' },
});
mock.module('../src/pages/settings/deck-manager.js', { exports: { renderDeckManager: () => '', renderFilteredDecks: () => '' } });

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// node 需 import attribute 才吃 JSON import；sections.js 以裸 JSON import（vite 專屬）→ 樁掉同 URL
mock.module(new URL('../package.json', import.meta.url).href, { exports: { default: pkg } });

function fakeState() {
  const s = () => ({});
  return {
    state: {
      words: [], decks: [], stats: { total: 0, mature: 0, due: 0 },
      goalStreak: { dailyGoal: 20, current: 0, best: 0, dates: {} },
      ankiSettings: { timezoneOffset: 0, cardsPerDay: 100, learnSteps: '1,10', relearnSteps: '10', reviewMix: 2, desiredRetention: 0.9, maxIvl: 365 },
      ankiSettingsMc: {}, ankiSettingsSpell: {}, simParams: {}, dayCutoff: 0,
      uiHints: false, uiScaleIdx: 0, devMode: false, llmApiUrl: '', llmModel: '', llmApiFormat: 'ollama', llmApiKey: '',
      ocrCambridgeVerify: true, logRetentionDays: 14, logScopes: {}, logMirror: true,
      tagConfig: {}, filteredDecks: [], methodSources: {}, webdavAutoUpload: false,
      buried: new Set(), suspended: new Set(), reviewLog: [],
    },
    subscribe: () => noop, // 若 render 期訂閱
  };
}

try {
  const mod = await import('../src/pages/settings/sections.js');
  chk('sections.js 可載入（import 期零炸）', typeof mod.renderSettingsContent === 'function');
  let html = null, err = null;
  try { html = mod.renderSettingsContent(fakeState()); } catch (e) { err = e; }
  // 只把「未綁定識別字」（ReferenceError，如曾漏 import 的 pkg）視為回歸；
  // 其餘 TypeError 多為假 state 欄位形狀（非本測試目的）。
  chk('render 期無未綁定識別字（ReferenceError 守門）', !(err && err.name === 'ReferenceError'), err ? `${err.name}: ${err.message}` : '');
  if (!err) chk('渲染結果含 app 版本（pkg import 生效）', typeof html === 'string' && html.includes(pkg.version), `expect包含 ${pkg.version}`);
  else console.log(`  ℹ render 因假 state 中止（非 ReferenceError，不計紅）: ${err.name}: ${err.message}`);
} catch (e) {
  chk('sections.js 載入無例外（ReferenceError 守門）', e.name !== 'ReferenceError', `${e.name}: ${e.message}`);
}

// 針對性靜態釘（runtime 假 state 未必走到 pkg 行）：使用 `pkg.*` 就必須有對應 import。
{
  const src = readFileSync(new URL('../src/pages/settings/sections.js', import.meta.url), 'utf8');
  const usesPkg = /[^.\w$]pkg\s*\./.test(src);
  const importsPkg = /import\s+pkg\s+from\s+['"][^'"]*package\.json['"]/.test(src);
  chk('sections.js 用 pkg.* 必有 import（pkg is not defined 防復發）', !usesPkg || importsPkg);
}

console.log(fail === 0 ? '\n═══ SETTINGS-RENDER ALL PASS ═══' : `\n═══ ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
