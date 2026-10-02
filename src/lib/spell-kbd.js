// SPELLKBD：拼字內建鍵盤 — 只在手機掛。
// 原因：原生鍵盤的建議列會把答案補完／自動更正把錯拼改對＝拼字測驗失效；
// 屬性（autocorrect/spellcheck off）壓不乾淨、各家鍵盤行為不一 → 手機用內建，
// 桌機維持實體鍵盤輸入（無建議問題）。進來的 input 加 readonly 避免原生鍵盤彈出。
// 手感對齊原生 IME：fixed 貼螢幕底、鍵帽陰影＋按壓下沈、⇧ 大寫、空格/⌫/⏎ 齊備，
// 「就像換了一個鍵盤 app」——但刻意【無建議列】（建議＝洩答案，見上）。
import { isMobile } from './platform.js';

const ROWS = ['qwertyuiop', 'asdfghjkl'];
const ROW3 = 'zxcvbnm';

export function spellKbdHtml() {
  if (!isMobile) return '';
  const rows = ROWS.map(r =>
    `<div class="sk-row">${[...r].map(c => `<button type="button" class="sk-key" data-sk="${c}">${c}</button>`).join('')}</div>`
  ).join('');
  return `<div class="spell-kbd" id="spellKbd">${rows}
      <div class="sk-row">
        <button type="button" class="sk-key sk-fn sk-shift" data-sk="__shift">⇧</button>
        ${[...ROW3].map(c => `<button type="button" class="sk-key" data-sk="${c}">${c}</button>`).join('')}
        <button type="button" class="sk-key sk-fn" data-sk="__bs">⌫</button>
      </div>
      <div class="sk-row sk-util">
        <button type="button" class="sk-key" data-sk=",">,</button>
        <button type="button" class="sk-key sk-space" data-sk="__space"></button>
        <button type="button" class="sk-key" data-sk=".">.</button>
        <button type="button" class="sk-key sk-ret" data-sk="__ret">⏎</button>
      </div>
    </div>`;
}

export function spellInputAttr() {
  return isMobile ? 'readonly' : '';
}

export function bindSpellKbd(inputId) {
  if (!isMobile) return;
  const kbd = document.getElementById('spellKbd');
  const input = document.getElementById(inputId);
  if (!kbd || !input || !kbd.querySelectorAll) return;
  let up = false, holdT = null, rep = null;
  const stopBs = () => { clearTimeout(holdT); clearInterval(rep); holdT = rep = null; };
  kbd.querySelectorAll('[data-sk]').forEach(btn => {
    const k = btn.dataset.sk;
    if (k === '__bs') {
      // 原生手感：點＝刪1字；按住450ms後每70ms連刪（放開/滑出/pointercancel 即停）
      btn.addEventListener('pointerdown', () => {
        input.value = input.value.slice(0, -1);
        stopBs();
        holdT = setTimeout(() => {
          rep = setInterval(() => { input.value = input.value.slice(0, -1); }, 70);
        }, 450);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => btn.addEventListener(t, stopBs));
      return;
    }
    btn.addEventListener('click', () => {
      if (k === '__shift') { up = !up; kbd.classList.toggle('sk-up', up); return; }
      if (k === '__space') { input.value += ' '; return; }
      if (k === '__ret') {
        input.closest('.study-input-row')?.querySelector('.study-submit')?.click();
        return;
      }
      input.value += (up && k.length === 1 && k !== ',' && k !== '.') ? k.toUpperCase() : k;
      if (up) { up = false; kbd.classList.remove('sk-up'); }
    });
  });
}
