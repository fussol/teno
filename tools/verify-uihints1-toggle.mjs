#!/usr/bin/env node
// UIHINTS1: 介面備註切換鈕（設定頁 master；預設關＝no-hints body class 隱藏輔助說明）
// 用法:
//   node tools/verify-uihints1-toggle.mjs           # POST 檢查（應全綠）
//   node tools/verify-uihints1-toggle.mjs --check   # 同上, 簡短輸出
// 驗證四腿:
//   H1 store: state.uiHints 欄位 + loadAll 讀取 + hydrate 套 body class + setUiHints action
//   H2 settings: 切換鈕 uiHintsToggle (.switch) + click handler
//   H3 css: body.no-hints 隱藏規則存在且涵蓋八大 hint 類
//   H4 boot 防閃: index.html <body class="no-hints"> 預掛（DB 讀到 true 才移除）
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const R = execSync('git stash list', { encoding: 'utf8' }).trim();
if (R.includes('stash@')) { console.error('PRE-FAIL: git stash 非空, 先清乾淨'); process.exit(1); }

let pass = 0, fail = 0;
const chk = (name, cond) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const store = readFileSync('src/lib/store.js', 'utf8');
const settings = readFileSync('src/pages/settings.js', 'utf8');
const css = readFileSync('src/styles/base.css', 'utf8');
const index = readFileSync('index.html', 'utf8');

console.log('[H1] store 腿');
chk('state.uiHints 預設 false', /uiHints:\s*false/.test(store));
chk('loadAll 讀 uiHints', /getSetting\('uiHints'\)/.test(store));
chk('hydrate: settings.uiHints === true 才開', /state\.uiHints = settings\.uiHints === true/.test(store));
chk('hydrate: body class toggle', /classList\.toggle\('no-hints',\s*!state\.uiHints\)/.test(store));
chk('action setUiHints 存在', /async setUiHints\(v\)/.test(store));
chk('action 持久化 db.setSetting', /setSetting\('uiHints',\s*state\.uiHints\)/.test(store));

console.log('[H2] settings 切換鈕腿');
chk('uiHintsToggle 開關渲染', /id="uiHintsToggle"/.test(settings));
chk('用 .switch 元件', /class="switch \$\{s\.state\.uiHints \? 'on' : ''\}" id="uiHintsToggle"/.test(settings));
chk('click handler 綁定', /getElementById\('uiHintsToggle'\)\?\.addEventListener\('click'/.test(settings));
chk('handler 呼叫 s.actions.setUiHints', /s\.actions\.setUiHints\(!s\.state\.uiHints\)/.test(settings));

console.log('[H3] css 隱藏規則腿');
const hintClasses = ['study-hint', 'card-flip-hint', 'config-field-hint', 'ocr-hint', 'ocr-ov-hint', 'drop-zone-sub', 'page-subtitle', 'card-desc'];
for (const c of hintClasses) chk(`body.no-hints .${c} → display:none`, new RegExp(`body\\.no-hints .*\\.${c}`).test(css) || css.includes(`.${c}{display:none}`) || new RegExp(`body\\.no-hints [\\s\\S]*?\\.${c}[\\s\\S]*?\\{display:none\\}`).test(css));

console.log('[H4] boot 防閃腿');
chk('index.html body 預掛 no-hints', /<body class="no-hints">/.test(index));

// 反向驗證: stash 掉工作區改動後必須紅 (證明 harness 真的在看這些行)
// HEAD 已含特徵（已 commit）→ 跳過；僅未 commit 時 stash 驗證
console.log('[NEG] 反向驗證 (stash 後應紅)');
let headHasUiHints;
try { headHasUiHints = /uiHints/.test(execSync('git show HEAD:src/lib/store.js', { encoding: 'utf8' })); }
catch { headHasUiHints = false; }
if (headHasUiHints) {
  console.log('  NEG-SKIP: 特徵已在 HEAD（已 commit），stash 拔 HEAD 不可能 — 跳過');
} else {
execSync('git stash push -q -- src/lib/store.js src/pages/settings.js src/styles/base.css index.html');
let negFail = 0;
try {
  const s2 = readFileSync('src/lib/store.js', 'utf8');
  const st2 = readFileSync('src/pages/settings.js', 'utf8');
  const cs2 = readFileSync('src/styles/base.css', 'utf8');
  const ix2 = readFileSync('index.html', 'utf8');
  if (/uiHints/.test(s2)) { negFail++; console.log('  NEG-FAIL: stash 後 store 仍有 uiHints'); }
  if (/uiHintsToggle/.test(st2)) { negFail++; console.log('  NEG-FAIL: stash 後 settings 仍有 toggle'); }
  if (/no-hints/.test(cs2)) { negFail++; console.log('  NEG-FAIL: stash 後 css 仍有 no-hints'); }
  if (/no-hints/.test(ix2)) { negFail++; console.log('  NEG-FAIL: stash 後 index 仍有 no-hints'); }
} finally {
  execSync('git stash pop -q');
}
if (negFail === 0) { pass++; console.log('  NEG-OK: stash 後四腿全滅 (harness 有效)'); }
else { fail++; }
}

console.log(`\nUIHINTS1: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
