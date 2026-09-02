#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-bh04.mjs — BH-04: tools.js custom-select 對 document 累積 click listener 無 guard
//   _initCustomSelects() 每次 onMount 對 document 加一條常駐 click listener，無去重 flag
//   → 進出工具頁 N 次累積 N 條，O(N×DOM) + 多次 toggle 競態。
//   修法：module 級 flag `_toolsCsBound` 擋重複綁定（仿 lib/custom-select.js G5）。
// 用法: node tools/verify-bh04.mjs
// 兩層：1) 源碼契約釘（讀真實 tools.js，未修必 FAIL）
//       2) jsdom 語意重放（flag 防重複監聽：修後註冊1次 vs 未修註冊N次）
// ═══════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_JS = join(REPO, 'src/pages/tools.js');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${extra}»`); }
};
const src = readFileSync(TOOLS_JS, 'utf8');

// ═══ 1. 源碼契約釘（未修 → 必紅）═══
console.log('── 1. source 契約釘（tools.js _initCustomSelects）──');
const fnStart = src.indexOf('function _initCustomSelects()');
const fnBody = fnStart >= 0 ? src.slice(fnStart, src.indexOf('\n  }', fnStart)) : '';
const flagDeclIdx = src.indexOf('let _toolsCsBound = false;');
const addIdx = fnBody.indexOf("document.addEventListener('click'");
T('S1 module 級 _toolsCsBound flag 存在', flagDeclIdx >= 0);
T('S2 flag 宣告在 _initCustomSelects 之前', flagDeclIdx >= 0 && flagDeclIdx < fnStart, `flag@${flagDeclIdx} fn@${fnStart}`);
const hasGuardAndBound = /if \(_toolsCsBound\) return;\s*_toolsCsBound = true;/.test(fnBody);
T('S3 _initCustomSelects 內 flag guard（if _toolsCsBound return + 設 true）', hasGuardAndBound);
const guardIdx = fnBody.indexOf('_toolsCsBound) return');
T('S4 addEventListener 在 guard 之後、受其保護', guardIdx >= 0 && addIdx > guardIdx, `guard@${guardIdx} add@${addIdx}`);
  T('S5 flag 為 module 級 col0 宣告（/^let _toolsCsBound/, 在 onMount 函式外）', /^let _toolsCsBound = false;/m.test(src), '查無 col0 module 級 flag');

// ═══ 2. jsdom 語意重放（flag 防重複監聽）═══
console.log('── 2. jsdom 語意重放 ──');
try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div></div>');
  const document = dom.window.document;

  // 模擬「多次導航 = 多次 onMount」。修後：flag 為 module 級共享（跨導航存續）；
  // 未修：flag 在 onMount 閉包內每次重生 → 每次導航都綁一條。
  function sim(listener, { moduleLevel }) {
    const clickCount = { n: 0 };
    const orig = document.addEventListener.bind(document);
    document.addEventListener = (type, fn) => { if (type === 'click') clickCount.n++; return orig(type, fn); };
    let _toolsCsBound = false;             // module 級（修後）：只初始化一次，跨導航共享
    for (let nav = 0; nav < 5; nav++) {    // 5 次導航 / onMount
      if (!moduleLevel) _toolsCsBound = false;   // 未修：閉包內每次導航重生 flag
      const init = () => { if (_toolsCsBound) return; _toolsCsBound = true; listener(); };
      init();                              // 每次導航呼叫 _initCustomSelects()
    }
    return clickCount.n;
  }

  const nFixed = sim(() => document.addEventListener('click', () => {}), { moduleLevel: true });
  T(`P1 修後(module flag) 5 次導航註冊 click 恆 1 條（${nFixed}）`, nFixed === 1, `${nFixed}`);
  const nBug = sim(() => document.addEventListener('click', () => {}), { moduleLevel: false });
  T(`P2 未修(閉包 flag 每次重生) 5 次導航註冊 ${nBug} 條（listener 累積）`, nBug === 5, `${nBug}`);
  T('P3 兩態數量不同（修法確有防跨導航累積）', nFixed !== nBug, `${nFixed} vs ${nBug}`);
} catch (e) {
  console.log(`  FAIL  jsdom 啟動失敗: ${e.message}`);
  fail++;
}

console.log(`\n═══ BH-04 verify: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);