// IMEJUMP1 驗證 — 新增/編輯 modal：組字期 Enter 不跳欄（Android keydown 常沒標 isComposing/229）
//   範圍：browser.js wordModal、deck-browser.js deckAddModal/deckEditModal（三處同款守門）
//   ＋ IMEHINT1：input.form-input 皆掛 enterkeyhint=enter（手機 IME 動作鍵原生推焦點的解法）
// 方法：剝 import/export 後 new Function 評估（ReferenceError 自動補 stub）→ jsdom 真 DOM
//       → compositionstart 掛旗 → 模擬漏標 Enter → 斷言焦點不動；commit 後 Enter 存膠囊；
//       空值 Enter 跳欄（原功能）；focusout 清旗。
// 負控制：--expect-legacy 剝掉 _ime 守門 → 組字 Enter 三處皆須重現跳欄（bug 仍在）。
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

const load = (file) => {
  let src = readFileSync(file, 'utf8');
  if (LEGACY) {
    src = src.replace(/ \|\| input\._ime/g, '')
             .replace(/^\s*if \(el\._ime\) return;.*$/gm, '');
  }
  return src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
};

// 自舉：評估＋執行 thunk；ReferenceError 補 stub 重來（modal 重開會先 remove 舊的，安全）
const bootstrap = (src, ret, thunk) => {
  const stubs = {
    store: { state: {}, actions: {} },
    isMobile: false,
    HARD_LIST_CAP: 999,
    WORD_IMAGE_CSS: '',
    toast: () => '',
    window: dom.window,
    navigator: dom.window.navigator,
  };
  for (let i = 0; i < 100; i++) {
    try {
      const api = new Function(...Object.keys(stubs), `${src}\n;return { ${ret} };`)(...Object.values(stubs));
      thunk(api);
      return api;
    } catch (e) {
      if (!(e instanceof ReferenceError)) throw e;
      const name = (e.message.match(/(\S+) is not defined/) || [])[1];
      if (!name || name in stubs) throw e;
      stubs[name] = /^[A-Z_]+$/.test(name) ? '' : (..._a) => '';
    }
  }
  throw new Error('自舉失敗');
};

const kd = () => {
  const e = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { value: 13 });   // 漏標 keydown：keyCode 13、isComposing=false
  return e;
};

const runSuite = ({ name, modalId, defId, pronId, chipSel, open }) => {
  open();
  check(`${name} modal 已開`, !!document.getElementById(modalId));
  const def = document.getElementById(defId);
  def.focus();
  check(`${name} 焦點在定義欄`, document.activeElement === def);
  check(`${name} enterkeyhint=enter`, def.getAttribute('enterkeyhint') === 'enter');
  def.dispatchEvent(new dom.window.CompositionEvent('compositionstart', { bubbles: true }));
  check(`${name} compositionstart 掛旗`, def._ime === true);
  def.dispatchEvent(kd());
  const jumped = document.activeElement !== def;
  if (LEGACY) {
    check(`${name} legacy：組字 Enter 重現跳欄`, jumped, `act=${document.activeElement && document.activeElement.id}`);
    return;
  }
  check(`${name} 組字期 Enter 不跳欄`, !jumped, `誤跳到 ${document.activeElement && document.activeElement.id}`);
  def.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
  check(`${name} compositionend 落旗`, def._ime === false);
  def.value = '[初,第一]';
  def.dispatchEvent(kd());
  const chips = document.querySelectorAll(chipSel);
  check(`${name} Enter 切兩顆膠囊`,
    chips.length === 2 && chips[0].textContent === '[初' && chips[1].textContent === '第一]',
    `n=${chips.length} [${[...chips].map(c => c.textContent).join('|')}]`);
  check(`${name} 輸入框已清空`, def.value === '');
  check(`${name} 存膠囊後焦點不動`, document.activeElement === def,
    `act=${document.activeElement && document.activeElement.id}`);
  def.dispatchEvent(kd());
  const pron = document.getElementById(pronId);
  check(`${name} 空值 Enter 跳下一欄`, document.activeElement === pron,
    `act=${document.activeElement && document.activeElement.id}`);
  def.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
  check(`${name} focusout 清旗`, def._ime !== true);
};

// ── 1) browser.js 瀏覽 新增/編輯（共用 wordModal） ──
bootstrap(load('src/pages/browser.js'), 'openModal', (api) => {
  api.openModal({ state: { decks: ['Default'], words: [], systemTags: [], tags: [] }, actions: {} }, null);
});
runSuite({ name: 'browse', modalId: 'wordModal', defId: 'fDefinition', pronId: 'fPron',
           chipSel: '#fDefChips .def-chip', open: () => {} });

// ── 2) deck-browser.js 牌組 新增 modal ──
const sD = {
  state: {
    decks: [{ name: 'Default' }],
    words: [{ id: 'w1', word: 'hi', definition: '', pos: '', pron: '', syllables: '', example: '',
              description: '', related: [], forms: [], synonym: '', antonym: '', derivative: '',
              etymology: '', deck: 'Default', tags: [] }],
  },
  actions: {},
};
const deckSrc = load('src/pages/deck-browser.js');
bootstrap(deckSrc, 'openAddModal, openEditModal', (api) => api.openAddModal(sD));
runSuite({ name: 'deck-add', modalId: 'deckAddModal', defId: 'deckAddDef', pronId: 'deckAddPron',
           chipSel: '#deckAddDefChips .def-chip', open: () => {} });

// ── 3) deck-browser.js 牌組 編輯 modal（另起自舉：編輯路徑的自由變數單獨補） ──
bootstrap(deckSrc, 'openAddModal, openEditModal', (api) => api.openEditModal(sD, 'w1'));
runSuite({ name: 'deck-edit', modalId: 'deckEditModal', defId: 'deckEditDef', pronId: 'deckEditPron',
           chipSel: '#deckEditDefChips .def-chip', open: () => {} });

console.log(`\n${failed ? 'FAIL' : 'ALL PASS'} ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
