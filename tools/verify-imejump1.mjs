// IMEJUMP1 驗證 — 瀏覽 新增/編輯 modal：Android 組字中 keydown 沒標 isComposing/229 時
//                   （MOBILE1 守門漏接），導覽層不得把「value 尚空」當空欄跳下一欄。
// 方法：剝 import/export 後 new Function 評估 browser.js（ReferenceError 自動補 stub）
//       → jsdom 真 DOM 開 openModal → compositionstart 掛旗 → 模擬漏標 Enter →
//       → 斷言焦點不動；compositionend＋commit 後 Enter 照常存膠囊；空值 Enter 仍跳欄。
// 負控制：--expect-legacy 剝掉 _ime 守門 → 組字 Enter 必須重現跳欄（bug 仍在）。
// 用法: node tools/verify-imejump1.mjs
//       node tools/verify-imejump1.mjs --expect-legacy
import { readFileSync } from 'node:fs';

const LEGACY = process.argv.includes('--expect-legacy');

let passed = 0, failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${extra ? ' → ' + extra : ''}`); }
}

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="pageContainer"></div></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let src = readFileSync('src/pages/browser.js', 'utf8');
if (LEGACY) {
  src = src.replace(' || input._ime', '')
           .replace(/^\s*if \(el\._ime\) \{.*$/m, '');
}
src = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');

const stubs = {
  store: { state: {}, actions: {} },
  isMobile: false,
  HARD_LIST_CAP: 999,
  WORD_IMAGE_CSS: '',
  toast: () => '',   // TEMP-IMELOG nav 跳欄會呼叫；listener 內 ReferenceError 會被 jsdom 吞掉，先預置
  window: dom.window,
  navigator: dom.window.navigator,
};
let openModal = null;
const s = { state: { decks: ['Default'], words: [], systemTags: [], tags: [] }, actions: {} };
let done = false;
for (let i = 0; i < 100 && !done; i++) {
  try {
    const fn = new Function(...Object.keys(stubs), `${src}\n;return { openModal };`);
    ({ openModal } = fn(...Object.values(stubs)));
    openModal(s, null);
    done = true;
  } catch (e) {
    if (!(e instanceof ReferenceError)) throw e;
    const name = (e.message.match(/(\S+) is not defined/) || [])[1];
    if (!name || name in stubs) throw e;
    stubs[name] = /^[A-Z_]+$/.test(name) ? '' : (..._a) => '';
  }
}
if (!done) throw new Error('openModal 自舉失敗');

const wm = document.getElementById('wordModal');
check('modal 已開', !!wm);
const def = document.getElementById('fDefinition');
def.focus();
check('焦點在定義欄', document.activeElement === def);

const kd = () => {
  const e = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { value: 13 });   // 漏標 keydown：keyCode 13、isComposing=false
  return e;
};

// ── 組字期：keyValue 空、旗幟應已掛 → 不跳 ──
def.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
check('compositionstart 掛旗', def._ime === true);
def.dispatchEvent(kd());
const jumpedOnCompose = document.activeElement !== def;

if (LEGACY) {
  check('legacy 負控制：組字 Enter 重現跳欄（bug 在）', jumpedOnCompose,
    `activeElement=${document.activeElement && document.activeElement.id}`);
} else {
  check('組字期 Enter 不跳欄', !jumpedOnCompose,
    `誤跳到 ${document.activeElement && document.activeElement.id}`);

  // ── commit：旗落、字進欄 → Enter 存膠囊、不跳 ──
  def.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  check('compositionend 落旗', def._ime === false);
  def.value = '[初,第一]';
  def.dispatchEvent(kd());
  const chips = document.querySelectorAll('#fDefChips .def-chip');
  check('Enter 切兩顆膠囊', chips.length === 2 && chips[0].textContent === '[初' && chips[1].textContent === '第一]',
    `n=${chips.length} [${[...chips].map(c => c.textContent).join('|')}]`);
  check('輸入框已清空', def.value === '');
  check('存膠囊後焦點不動', document.activeElement === def,
    `activeElement=${document.activeElement && document.activeElement.id}`);

  // ── 空值 Enter：原「跳下一欄」功能保留 ──
  def.dispatchEvent(kd());
  const pron = document.getElementById('fPron');
  check('空值 Enter 跳下一欄', document.activeElement === pron,
    `activeElement=${document.activeElement && document.activeElement.id}`);

  // ── focusout 兜底清旗 ──
  def.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
  check('focusout 清旗', def._ime !== true);
}

console.log(`\n${failed ? 'FAIL' : 'ALL PASS'} ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
