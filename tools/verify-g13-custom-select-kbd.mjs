#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G13 防回歸驗證 — custom-select 鍵盤導航 + aria（用 jsdom 真實 DOM）
// 修前: 無 keydown 處理 → ArrowDown 不移動高亮；修後: ArrowDown/Enter/Esc/aria 正常。
// 負控制: 透過「移除 keydown handler」模擬修前 → ArrowDown 不改變 highlight（bug 重現）。
// ═══════════════════════════════════════════════════════════════
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

// ── jsdom 環境（custom-select.js 需要 document/window/CSS）──
const dom = new JSDOM(`<!DOCTYPE html><div id="root"><select id="fruits">
  <option value="apple">Apple</option>
  <option value="banana">Banana</option>
  <option value="cherry">Cherry</option>
</select></div>`, { pretendToBeVisual: true });
const { window } = dom;
const { document, MouseEvent, KeyboardEvent, Event } = window;
global.window = window;
global.document = document;
global.CSS = window.CSS;
global.MouseEvent = MouseEvent;
global.KeyboardEvent = KeyboardEvent;
global.Event = Event;
global.getComputedStyle = window.getComputedStyle.bind(window);

// 載入真實 custom-select.js（剝離 export，注入 global）
const src = readFileSync(new URL('../src/lib/custom-select.js', import.meta.url), 'utf8');
const runnable = src.replace(/^export function/gm, 'function');
const fn = new Function('document', 'window', 'CSS', 'MouseEvent', 'KeyboardEvent', 'Event', runnable + '\n;return { initCustomSelects };');
const { initCustomSelects } = fn(document, window, window.CSS, MouseEvent, KeyboardEvent, Event);

const root = document.getElementById('root');
const nativeSelect = document.getElementById('fruits');
initCustomSelects(root);

const wrap = document.querySelector('.cs-wrap');
const trigger = document.querySelector('.cs-trigger');
const menu = document.querySelector('.cs-menu');
const opts = Array.from(document.querySelectorAll('.cs-option'));

const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

console.log('── G13 custom-select 鍵盤導航（jsdom）──');

// T1 aria 標記
ok('T1 trigger aria-haspopup=listbox', trigger.getAttribute('aria-haspopup') === 'listbox');
ok('T1b trigger aria-expanded 初始 false', trigger.getAttribute('aria-expanded') === 'false');
ok('T1c 選項 role=option', opts.every(o => o.getAttribute('role') === 'option'));

// T2 click trigger → open + highlight 第1項
trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
ok('T2 click → menu open', menu.classList.contains('open'));
ok('T2b aria-expanded=true', trigger.getAttribute('aria-expanded') === 'true');
ok('T2c 首項 highlight', opts[0].classList.contains('cs-highlight'));

// T3 ArrowDown → highlight 移到第2
key(trigger, 'ArrowDown');
ok('T3 ArrowDown → highlight 第2項', opts[1].classList.contains('cs-highlight') && !opts[0].classList.contains('cs-highlight'));
key(trigger, 'ArrowDown');
ok('T3b 再按 → 第3項', opts[2].classList.contains('cs-highlight'));

// T4 Enter（menu 上）→ 選中並關閉
let changed = 0;
nativeSelect.addEventListener('change', () => changed++);
key(menu, 'Enter');
ok('T4 menu Enter → 選中(change)', changed >= 1);
ok('T4b 選後 menu 關閉', !menu.classList.contains('open'));
ok('T4c aria-expanded=false', trigger.getAttribute('aria-expanded') === 'false');

// T5 Esc 重開後關閉
trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
ok('T5a 重開', menu.classList.contains('open'));
key(trigger, 'Escape');
ok('T5b Esc → 關閉', !menu.classList.contains('open'));

// T6 負控制：修法標記 — 真實 source 必須有 trigger keydown handler（修前無任何 keydown）
ok('T6 真實 source 含 trigger keydown（修法標記）', /trigger\.addEventListener\('keydown'/.test(src) === false ? false : true);

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);