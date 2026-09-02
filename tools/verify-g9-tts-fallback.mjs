// G9 驗證 — native TTS 失敗反饋／死碼／ttsAvailable 誠實化
// 用法：node --test tools/verify-g9-tts-fallback.mjs
//
// 威脅模型定文（比照 F17 v4）：防「無意回歸＋偷工」，不抵禦蓄意偽裝對抗。
// 本腳本全程 desktop 模式（__ttsPlatformIsAndroid=false，平台 stub 每進程只求值一次，
// 故 Android 分支以靜態釘锁定 T8，不在本進程跑）。
//
// 雙態：
//   PRE（T0）：git show ed00132（動工前 HEAD）— ①失敗後 30s 內第二次呼叫：native 呼叫數
//       不增＋零 toast＝靜默無聲重現 ②native 已死＋speechSynthesis 存在 → ttsAvailable()
//       仍 true＝誤報重現。
//   POST（T1-T6）：工作區真碼 — 每次必重試、toast 30s 節流、ttsAvailable 三態、cancel 保留。
//   T7/T8 靜態釘：死碼零殘留＋ttsAvailable 無 speechSynthesis＋Android 分支原樣。
//   NC1/NC2 負控制：拼回靜默閘→重試斷言紅；拼回 speechSynthesis 分支→誤報斷言紅。
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/teno-g9-verify';
const PRE_COMMIT = 'ed00132'; // G9 動工前 HEAD（bug 態 pin）

// desktop 模式必須先於任何 import 設定（平台 stub 只求值一次）
globalThis.__ttsPlatformIsAndroid = false;
register(new URL('./verify-tts-contract-loader.mjs', import.meta.url));

// Web Speech stub：PRE 誤報場景需要它存在；POST stopSpeech cancel 測試需要它可記數
let cancelCalls = 0;
globalThis.speechSynthesis = {
  getVoices: () => [{ lang: 'en-US', name: 'stub' }],
  cancel: () => { cancelCalls++; },
  onvoiceschanged: null,
};
// toast stub：真信道形態 window.toast(msg, type)（main.js:434 賦值形態）。
// R1#1 必須項：harness 嚴禁供給被驗證信道本身——舊 stub 發 __toast 幽靈全域把
// 「真 app 從無反饋」掩蓋成綠，T0/T7b 現把幽靈態如實釘紅。
let toasts = [];
globalThis.window = { toast: (msg, type) => toasts.push({ msg, type }) };

let importSeq = 0;
const freshImport = async (filePath) => {
  const url = pathToFileURL(filePath).href + `?v=${++importSeq}`;
  const m = await import(url);
  await new Promise((r) => setImmediate(r));
  return m;
};
const flush = () => new Promise((r) => setImmediate(r));
const bodyOf = (src, anchor) => { // 花括號平衡提取（非對抗場景）
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `錨點「${anchor}」存在`);
  let d = 0, j = src.indexOf('{', i);
  const s = j;
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(s, j + 1);
};

const SRC_PATH = resolve(REPO, 'src/lib/tts.js');
let SRC = '';        // 工作區真碼（POST）
let PRE_SRC = '';    // 動工前 blob（PRE）

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  SRC = readFileSync(SRC_PATH, 'utf8');
  PRE_SRC = execFileSync('git', ['-C', REPO, 'show', `${PRE_COMMIT}:src/lib/tts.js`],
    { encoding: 'utf8' });
  // PRE 正宗性釘：必須是「冷卻靜默＋speechSynthesis 誤報＋死碼俱在」版
  assert.match(PRE_SRC, /_nativeFailTime/, 'PRE blob 必含冷卻閘變數');
  assert.match(PRE_SRC, /_enVoice/, 'PRE blob 必含 _enVoice 死碼');
  assert.ok(!/_lastFailToast/.test(PRE_SRC), 'PRE blob 非修復態');
});

after(() => { try { mock.timers.reset(); } catch {}
  rmSync(TMP, { recursive: true, force: true }); });

beforeEach(() => {
  // api stub 於首次 import 時才求值（t0/測試內懶載入）→ 存在才清；
  // failNative 一律在 freshImport 之後、speak 之前設定（呼叫時讀值）
  if (globalThis.__ttsApi) {
    globalThis.__ttsApi.nativeCalls.length = 0;
    globalThis.__ttsApi.failNative = false;
    globalThis.__ttsApi.speakCalls.length = 0;
  }
  toasts = [];
  globalThis.window.toast = (msg, type) => toasts.push({ msg, type });
  cancelCalls = 0;
});

// ---------- T0. PRE 紅基線：靜默無聲＋ttsAvailable 誤報 雙重現 ----------
test('T0. PRE：失敗後 30s 第二次呼叫靜默（native 零重試零 toast）＋ttsAvailable 誤報', { timeout: 8000 }, async () => {
  const p = resolve(TMP, 'tts-pre.mjs');
  writeFileSync(p, PRE_SRC);
  const m = await freshImport(p);
  globalThis.__ttsApi.failNative = true;
  assert.equal(m.ttsAvailable(), true, 'PRE 初始樂觀 true');
  await m.speak('hello', 0.9, 'en-us', 50); // 失敗#1
  assert.equal(globalThis.__ttsApi.nativeCalls.length, 1, '第一次呼叫 native');
  // R1#1 如實登記：真信道形態（僅 window.toast）下 PRE 首次失敗也零 toast——
  // PRE 讀的是幽靈 window.__toast（真 app 零賦值端）。PRE 真 app 態＝每次失敗皆雙重靜默，
  // audit「30s 靜默」屬低估。
  assert.equal(toasts.length, 0, 'PRE 幽靈信道：真信道形態下首次失敗亦無反饋（雙重靜默實錘）');
  await m.speak('hello2', 0.9, 'en-us', 50); // 30s 窗內：靜默！
  assert.equal(globalThis.__ttsApi.nativeCalls.length, 1, 'PRE 重現：窗內零重試');
  assert.equal(toasts.length, 0, 'PRE 重現：窗內零反饋');
  assert.equal(m.ttsAvailable(), true, 'PRE 重現：native 已死仍報可用（speechSynthesis 誤報源）');
});

// ---------- POST：工作區真碼 ----------
// T1. 首次失敗即 toast（反饋及時報，不吞錯）
test('T1. POST：首次失敗 → native 被呼叫＋恰一 toast＋promise 不拋', { timeout: 8000 }, async () => {
  const m = await freshImport(SRC_PATH);
  globalThis.__ttsApi.failNative = true;
  await m.speak('hello', 0.9, 'en-us', 50); // 不擲出
  assert.equal(globalThis.__ttsApi.nativeCalls.length, 1);
  assert.equal(toasts.length, 1, '首次失敗必須可見');
  assert.match(toasts[0].msg, /發音失敗/);
  assert.equal(toasts[0].type, 'toast-error', 'CSS 存在類（.toast-warn 於 base.css 不存在）');
});

// T2. 30s 窗內第二次呼叫：必重試（bug 核心反轉）、toast 節流不洗屏
test('T2. POST：失敗窗內再呼叫 → 必重試 native（治「靜默無聲」）＋toast 節流', { timeout: 8000 }, async () => {
  const realNow = Date.now();
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(realNow); // mock Date 起點為 0（非真 epoch）——與 _lastFailToast=0
  // 初始態比較會 misjudge「從未有過 toast」；對齊真 epoch 語意（node -e 實測 start=0）
  try {
    const m = await freshImport(SRC_PATH);
    globalThis.__ttsApi.failNative = true;
    await m.speak('a', 0.9, 'en-us', 50);
    await m.speak('b', 0.9, 'en-us', 50); // 舊態此處靜默；新態必重試
    assert.equal(globalThis.__ttsApi.nativeCalls.length, 2, '每次必重試——永不靜默');
    assert.equal(toasts.length, 1, 'toast 節流：30s 窗內只警告一次');
  } finally { mock.timers.reset(); }
});

// T3. 節流跨窗：31s 後再失敗 → 再報（非永久消音）
test('T3. POST：跨 30s 節流窗再失敗 → toast 重現', { timeout: 8000 }, async () => {
  const realNow2 = Date.now();
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(realNow2); // 同上：mock Date 起點 0 → 對齊真 epoch
  try {
    const m = await freshImport(SRC_PATH);
    globalThis.__ttsApi.failNative = true;
    await m.speak('a', 0.9, 'en-us', 50);
    assert.equal(toasts.length, 1);
    mock.timers.tick(31000);
    await m.speak('b', 0.9, 'en-us', 50);
    assert.equal(toasts.length, 2, '跨窗再報——節流非永久消音');
    assert.equal(globalThis.__ttsApi.nativeCalls.length, 2);
  } finally { mock.timers.reset(); }
});

// T4. ttsAvailable 三態：樂觀 true → 失敗 false → 成功翻回 true
test('T4. POST：ttsAvailable 誠實三態（無 speechSynthesis 誤報）', { timeout: 8000 }, async () => {
  const m = await freshImport(SRC_PATH);
  globalThis.__ttsApi.failNative = true;
  assert.equal(m.ttsAvailable(), true, '初始樂觀（首次呼叫揭曉）');
  await m.speak('x', 0.9, 'en-us', 50);
  assert.equal(m.ttsAvailable(), false, 'native 已死 → 誠實 false（speechSynthesis 存在不豁免）');
  globalThis.__ttsApi.failNative = false;
  await m.speak('y', 0.9, 'en-us', 50);
  assert.equal(m.ttsAvailable(), true, '恢復成功翻回 true（非單向棘輪）');
});

// T5. 成功路徑零 toast（誤報反饋不擾民）
test('T5. POST：成功發音零 toast', { timeout: 8000 }, async () => {
  const m = await freshImport(SRC_PATH);
  await m.speak('ok', 0.9, 'en-us', 50);
  assert.equal(globalThis.__ttsApi.nativeCalls.length, 1);
  assert.equal(toasts.length, 0, '成功不得有失敗反馈');
});

// T6. stopSpeech 桌面分支 cancel 保留（可選項定案：no-op 防呆不刪）
test('T6. POST：stopSpeech → speechSynthesis.cancel 仍被呼叫', { timeout: 8000 }, async () => {
  const m = await freshImport(SRC_PATH);
  await m.stopSpeech();
  assert.equal(cancelCalls, 1, 'cancel 防呆保留');
});

// T7. 死碼靜態釘：工作區真碼零殘留
test('T7. 靜態釘：_enVoice/getVoices/onvoiceschanged/_nativeFailTime 全除', () => {
  // 註解剝離後掃描（F17 教訓：來源註解提及被禁 token 不得誤報——本檔註解即此案例）
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/_enVoice/.test(CODE), '_enVoice 死碼已除');
  assert.ok(!/getVoices/.test(CODE), 'getVoices 死碼已除');
  assert.ok(!/onvoiceschanged/.test(CODE), 'onvoiceschanged 死碼已除');
  assert.ok(!/_nativeFailTime/.test(CODE), '冷卻閘變數已除');
  const av = bodyOf(CODE, 'export function ttsAvailable()');
  assert.ok(!/speechSynthesis/.test(av), 'ttsAvailable 無 speechSynthesis 誤報分支');
  const sa = bodyOf(CODE, 'async function speakAsync(');
  assert.match(sa, /await nativeSpeak\(/, 'speakAsync 無條件重試 native');
  // R1#2 強烈建議①：節流機制釘死——防日後改 setInterval/flag 偽裝換制（T3 之外第二哨兵）
  assert.match(sa, /Date\.now\(\)/, '節流必基於 Date.now');
  assert.match(sa, /_lastFailToast/, '節流狀態變數在位');
});

// T7b. R1#1 必須項成對釘：讀取端↔賦值端同源（防信道改名再度斷鏈）
test('T7b. 靜態釘成對：tts.js 讀 window.toast 且無 __toast 幽靈＋main.js 存在 window.toast 賦值', { timeout: 8000 }, () => {
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/__toast/.test(CODE), 'tts.js 不得再引用幽靈 __toast');
  assert.match(CODE, /typeof window\.toast === 'function'/, '真信道守衛');
  assert.match(CODE, /window\.toast\(/, '讀取端呼叫 window.toast');
  const MAIN = readFileSync(resolve(REPO, 'src/main.js'), 'utf8');
  assert.match(MAIN, /window\.toast\s*=/, 'main.js 賦值端在位（成對釘死，改名必紅）');
});

// T9. 時鐘邊界（R1#1-S1/S2）：epoch 未同步鐘首報不誤壓；後跳 clamp 後跨窗複報
test('T9. POST：epoch 未同步鐘（now=10s）首敗仍報＋時鐘後跳 clamp 後跨窗複報', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(10000); // 假設 epoch 未同步：now=10s（< 30s 節流窗）
  try {
    const m = await freshImport(SRC_PATH);
    globalThis.__ttsApi.failNative = true;
    await m.speak('a', 0.9, 'en-us', 50);
    assert.equal(toasts.length, 1, 'S2：-Infinity 哨兵——未同步鐘首敗仍報（0 初始值會誤壓）');
    mock.timers.setTime(20000); // 窗內推進（20-10=10s < 30s）
    await m.speak('b', 0.9, 'en-us', 50);
    assert.equal(toasts.length, 1, '窗內節流正常壓制');
    mock.timers.setTime(5000); // 時鐘後跳 15s（NTP 回撥/VM 快照）
    await m.speak('c', 0.9, 'en-us', 50);
    assert.equal(toasts.length, 1, '後跳瞬間不誤報（clamp 把 last 拉到 now）');
    mock.timers.tick(31000); // 5+31=36s，距 last(5s) 31s
    await m.speak('d', 0.9, 'en-us', 50);
    assert.equal(toasts.length, 2, 'S1：後跳 clamp 後 31s 即複報——toast 不長期消音');
  } finally { mock.timers.reset(); }
});

// T8. Android 分支原樣釘（本進程 desktop 模式無法運行時驗證 Android 分支）
test('T8. 靜態釘：Android 路徑零觸碰（speak 提前 return＋ttsAvailable 恆 true）', () => {
  const CODE2 = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const sp = bodyOf(CODE2, 'export function speak(');
  assert.match(sp, /if \(isAndroid\) return speakAndroidTts\(/, 'Android 提前 return');
  const av2 = bodyOf(CODE2, 'export function ttsAvailable()');
  assert.match(av2, /if \(isAndroid\) return true;/, 'Android 恆可用');
});

// ---------- 負控制 ----------
test('NC1. 拼回靜默閘 → T2 重試命題精準紅（負控制）', { timeout: 8000 }, async () => {
  const patched = SRC.replace(
    '  try {\n    await nativeSpeak(text, { speed, voice, pitch });',
    '  if (_hasNative === false) return; // [NC1] 靜默閘拼回\n  try {\n    await nativeSpeak(text, { speed, voice, pitch });');
  assert.notEqual(patched, SRC, 'NC1 splice 必須精準命中');
  const p = resolve(TMP, 'tts-nc1.mjs');
  writeFileSync(p, patched);
  const m = await freshImport(p);
  globalThis.__ttsApi.failNative = true;
  await m.speak('a', 0.9, 'en-us', 50);
  await m.speak('b', 0.9, 'en-us', 50);
  // NC1 態＝bug 態：第二次不重試。此處斷言「若拼回閘則呼叫數停 1」自證敏感：
  // 真碼必須是 2（T2 已斷言）；本測試證明掃描器抓得住退化。
  assert.equal(globalThis.__ttsApi.nativeCalls.length, 1,
    'NC1 自證：靜默閘回退可被 T2 命題捕獲（此處 1＝bug 態重現成功）');
});

test('NC2. 拼回 speechSynthesis 分支 → 誤報斷言精準紅（負控制）', { timeout: 8000 }, async () => {
  const patched = SRC.replace(
    '  return _hasNative !== false;\n}',
    '  return _hasNative !== false || typeof speechSynthesis !== "undefined";\n}');
  assert.notEqual(patched, SRC, 'NC2 splice 必須精準命中');
  const p = resolve(TMP, 'tts-nc2.mjs');
  writeFileSync(p, patched);
  const m = await freshImport(p);
  globalThis.__ttsApi.failNative = true;
  await m.speak('x', 0.9, 'en-us', 50);
  // NC2 態＝誤報態：native 死＋speechSynthesis stub 存在 → 誤 true
  assert.equal(m.ttsAvailable(), true,
    'NC2 自證：speechSynthesis 分支回退可被 T4 命題捕獲（此處 true＝誤報重現成功）');
});
