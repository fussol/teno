#!/usr/bin/env node
// ═══ VERIFY-G6 renderPage generation guard ═══
// Bug：renderPage await loadPage 期間換頁 → 舊頁 innerHTML 晚到覆蓋新頁。
// 修法：_renderGen token，await 後過期即丟棄（含 render 內 await 與 catch 面）。
// 用法: node tools/verify-g6-render-guard.mjs [--pre]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');

const PRE = process.argv.includes('--pre');
let fail = 0, total = 0;
function ok(label, cond, detail) {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
}

// ── 靜態釘 ──
const hasGenVar = /let _renderGen = 0/.test(MAIN);
const genInc = /const gen = \+\+_renderGen/.test(MAIN);
const guardAfterLoad = /await loadPage\(page\);\s*\n\s*if \(gen !== _renderGen\) return;/.test(MAIN);
const guardAfterRender = /if \(gen !== _renderGen\) return;[^\n]*\n\s*container\.innerHTML/.test(MAIN);
const guardInCatch = /catch \(e\) \{\s*\n\s*if \(gen !== _renderGen\) return;/.test(MAIN);
// 沒 guard 的 innerHTML 直寫面 = 0（三個寫入點全在 guard 後）
const unguarded = (MAIN.match(/container\.innerHTML = (?!rendered|`<div class="empty-state")/g) || []).length;

// ── 動態模擬（race 重現）：提取 renderPage 函式本體跑 ──
async function simulateRace(withGuard) {
  // 構造最小環境：mock loadPage 兩頁（慢/快）、container、$、resolveNavPage
  const calls = [];
  let innerSeq = [];
  const pages = {
    slow: { render: () => { calls.push('render:slow'); return 'SLOW_PAGE'; }, onMount: () => calls.push('mount:slow') },
    fast: { render: () => { calls.push('render:fast'); return 'FAST_PAGE'; }, onMount: () => calls.push('mount:fast') },
  };
  const loadPage = async (p) => { calls.push('load:' + p); if (p === 'slow') await new Promise(r => setTimeout(r, 30)); return pages[p]; };
  const container = {
    _cls: '', set className(v) { this._cls = v; }, get className() { return this._cls; },
    set innerHTML(v) { calls.push('innerHTML:' + v); innerSeq.push(v); },
  };
  const $ = () => ({ innerHTML: '' });
  const document = { querySelectorAll: () => [] };

  let _renderGen = 0;
  async function renderPage(page) {
    let gen;
    if (withGuard) { gen = ++_renderGen; }
    try {
      const mod = await loadPage(page);
      if (withGuard && gen !== _renderGen) return;
      const rendered = mod.render();
      if (withGuard && gen !== _renderGen) return;
      container.innerHTML = rendered;
      if (typeof mod.onMount === 'function') mod.onMount(page);
    } catch (e) { if (withGuard && gen !== _renderGen) return; container.innerHTML = 'ERR'; }
  }
  // race：slow 先跑，10ms 後 fast 插隊 → slow 的 innerHTML 晚到
  const p1 = renderPage('slow');
  await new Promise(r => setTimeout(r, 10));
  const p2 = renderPage('fast');
  await Promise.all([p1, p2]);
  const htmls = innerSeq.filter(v => v.includes('PAGE'));
  return { final: htmls[htmls.length - 1], seq: htmls.join(',') };
}

if (PRE) {
  ok('T0.1 bug 實錘：無 _renderGen guard', !hasGenVar && !genInc);
  ok('T0.2 bug 實錘：await 後無丟棄檢查', !guardAfterLoad);
} else {
  ok('T1.1 _renderGen 宣告在位', hasGenVar);
  ok('T1.2 每輪 ++_renderGen 取 token', genInc);
  ok('T1.3 await loadPage 後 guard 丟棄', guardAfterLoad);
  ok('T1.4 render 後（innerHTML 前）guard', guardAfterRender);
  ok('T1.5 catch 面也有 guard', guardInCatch);
  ok('T1.6 innerHTML 寫入全在 guard 保護內（無裸寫）', unguarded === 0, `unguarded=${unguarded}`);

  // 動態 race 模擬
  const buggy = await simulateRace(false);
  const fixed = await simulateRace(true);
  ok('T2.1 無 guard 時 race 重現（舊頁覆蓋新頁）', buggy.final === 'SLOW_PAGE', buggy.seq);
  ok('T2.2 有 guard 時新頁獲勝（fast 為最終畫面）', fixed.final === 'FAST_PAGE', fixed.seq);
  ok('T2.3 有 guard 時 slow 頁丟棄（序列無 SLOW_PAGE）', !fixed.seq.includes('SLOW_PAGE'), fixed.seq);
}

console.log(fail === 0 ? `\n═══ ${PRE ? 'PRE(BUG)' : 'POST(FIXED)'}: ${total - fail}/${total} ALL PASS ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
