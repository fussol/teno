#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G24 防回歸驗證 — export.js render() 引用未定義 words → ReferenceError
// 用法: node --experimental-test-module-mocks tools/verify-g24-export-render.mjs
// 真實載入（沿用 G4）: mock export.js 的 6 個 import 依賴，其餘皆真實。
// 負控制: 未修 export.js 的 render() 會 ReferenceError；修後正常回文字串。
// ═══════════════════════════════════════════════════════════════
import { mock } from 'node:test';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

mock.module('../src/lib/svg.js', { exports: { icon: () => '' } });
mock.module('../src/lib/toast.js', { exports: { toast() {} } });
mock.module('../src/core/import.js', { exports: { buildCSV: (arr) => 'CSV' } });
mock.module('../src/lib/api.js', { exports: { exportCsvDialog: async () => '/tmp/x.csv' } });
mock.module('../src/lib/platform.js', { exports: { isAndroid: false, downloadBlob: () => {} } });

const { render, renderContent } = await import('../src/pages/export.js');

const s = {
  state: {
    words: [{ word:'apple', deck:'Default' }, { word:'banana', deck:'Default' }],
    decks: [{ name:'Default', color:'#f00' }],
  },
};

console.log('── G24 export.js render() words 未定義 ──');

// T1 修法後 render() 不 throw
try {
  const out = render(s);
  ok('T1 render() 不 throw', true);
  ok('T2 輸出含 共 2 詞', typeof out === 'string' && out.includes('共 2 詞'));
} catch (e) {
  ok('T1 render() 不 throw（修法後）', false, e.message);
  ok('T2 輸出含 共 2 詞（修法後）', false);
}

// T3 renderContent 獨立正常
try {
  const c = renderContent(s);
  ok('T3 renderContent() 正常（含 將匯出 與 詞）', typeof c === 'string' && c.includes('將匯出') && c.includes('</span> 詞'));
} catch (e) { ok('T3 renderContent() 正常', false, e.message); }

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);