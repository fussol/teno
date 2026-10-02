// SPELLKBD：拼字內建鍵盤 — 只在手機掛。
// 原因：原生鍵盤的建議列會把答案補完／自動更正把錯拼改對＝拼字測驗失效；
// 屬性（autocorrect/spellcheck off）壓不乾淨、各家鍵盤行為不一 → 手機用內建，
// 桌機維持實體鍵盤輸入（無建議問題）。進來的 input 加 readonly 避免原生鍵盤彈出。
import { isMobile } from './platform.js';

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export function spellKbdHtml() {
  if (!isMobile) return '';
  const rows = ROWS.map(r =>
    `<div class="sk-row">${[...r].map(c => `<button type="button" class="sk-key" data-sk="${c}">${c}</button>`).join('')}</div>`
  ).join('');
  return `<div class="spell-kbd" id="spellKbd">${rows}
      <div class="sk-row"><button type="button" class="sk-key sk-wide" data-sk="__bs">⌫</button></div>
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
  kbd.querySelectorAll('[data-sk]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.sk;
      input.value = k === '__bs' ? input.value.slice(0, -1) : input.value + k;
    });
  });
}
