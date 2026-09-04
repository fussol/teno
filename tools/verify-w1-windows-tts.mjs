// ═══════════════════════════════════════════════════════════════
// verify-w1-windows-tts.mjs — W1：Windows speechSynthesis TTS（方案 C，2026-09-05 使用者裁示）
// 架構：Android → 原生 plugin；Windows → WebView2 speechSynthesis（Edge/Microsoft
// 自然語音）；Linux → piper（speakAsync 唯一路徑不變）。
// 釘：①Windows+有語音→Web Speech（native 零呼叫）②語音優先序（Natural>en-US）
// ③Linux→speakAsync native ④Windows 零語音→fallback native ⑤靜態分支順序。
// 跑法：node --experimental-test-module-mocks tools/verify-w1-windows-tts.mjs
// ═══════════════════════════════════════════════════════════════
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.__w1IsWindows = true;

// 攔截層（node26-test-harness 陷阱 #4 同款：register + URL 實例，不用 registerHooks）
const LOADER_SRC = `
export function resolve(specifier, context, next) {
  let src = null;
  if (specifier === './platform.js') {
    src = 'export const isAndroid = false; export const isWindows = globalThis.__w1IsWindows === true;';
  } else if (specifier === './api.js') {
    src = 'globalThis.__w1NativeCalls = 0; export const speakText = async (t, o) => { globalThis.__w1NativeCalls++; }; export const speakAndroid = async () => {}; export const stopAndroid = async () => {};';
  }
  if (src) return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
  return next(specifier, context);
}
`;
const loaderUrl = 'data:text/javascript,' + encodeURIComponent(LOADER_SRC);
register(loaderUrl, pathToFileURL(resolve(REPO, 'src/lib/tts.js')).href);

// speechSynthesis stub：speak() 記錄 utterance 並觸發 onend（同步完成）
let utterances = [];
globalThis.speechSynthesis = {
  getVoices: () => globalThis.__w1Voices || [],
  cancel: () => {},
  speak: (u) => { utterances.push(u); u.onend && u.onend(); },
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
};

async function importTts() {
  const url = pathToFileURL(resolve(REPO, 'src/lib/tts.js')).href + '?w1=' + Math.random();
  return await import(url);
}

test('T1. Windows + 有語音 → speakWebSpeech（零 native 呼叫）', async () => {
  globalThis.__w1IsWindows = true;
  globalThis.__w1Voices = [
    { lang: 'en-US', name: 'Microsoft Aria Online (Natural) - English (United States)' },
    { lang: 'en-US', name: 'Microsoft Zira - English (United States)' },
  ];
  globalThis.__w1NativeCalls = 0; utterances = [];
  const m = await importTts();
  await m.speak('hello world', 1.0, 'en-us', 50);
  assert.equal(globalThis.__w1NativeCalls, 0, 'native piper 零呼叫（Windows 走 Web Speech）');
  assert.equal(utterances.length, 1, 'SpeechSynthesisUtterance 恰建構一次');
  assert.equal(utterances[0].text, 'hello world');
  assert.ok(/aria|natural/i.test(utterances[0].voice?.name || ''), `語音優先選 Natural（實選 ${utterances[0].voice?.name}）`);
});

test('T2. 語音優先序：無 Natural → en-US SAPI', async () => {
  globalThis.__w1IsWindows = true;
  globalThis.__w1Voices = [
    { lang: 'en-GB', name: 'Microsoft George - English (United Kingdom)' },
    { lang: 'en-US', name: 'Microsoft Zira - English (United States)' },
  ];
  utterances = [];
  const m = await importTts();
  await m.speak('test', 1.0, 'en-us', 50);
  assert.ok(/en[-_]US/i.test(utterances[0].voice?.lang || ''), `fallback 到 en-US（實選 ${utterances[0].voice?.name}）`);
});

test('T3. Linux（isWindows=false）→ 走 speakAsync native', async () => {
  globalThis.__w1IsWindows = false;
  globalThis.__w1Voices = [];   // 清語音：Linux 不該看 Web Speech 條件（isWindows=false 已擋，雙保險）
  globalThis.__w1NativeCalls = 0; utterances = [];
  const m = await importTts();
  await m.speak('linux piper', 1.0, 'en-us', 50);
  assert.equal(globalThis.__w1NativeCalls, 1, 'Linux 桌面唯一路徑 native piper（G9 契約不變）');
  assert.equal(utterances.length, 0, 'Web Speech 零觸發');
});

test('T4. Windows + 零語音 → fallback native（speakAsync）', async () => {
  globalThis.__w1IsWindows = true;
  globalThis.__w1Voices = [];
  globalThis.__w1NativeCalls = 0; utterances = [];
  const m = await importTts();
  await m.speak('fallback', 1.0, 'en-us', 50);
  assert.equal(globalThis.__w1NativeCalls, 1, '零語音時 fallback piper');
});

test('T5. 靜態釘：speak() 分支順序（方案 C 落地釘）', () => {
  const src = readFileSync(resolve(REPO, 'src/lib/tts.js'), 'utf8');
  const speakStart = src.indexOf('export function speak(');
  const speakBody = src.slice(speakStart, src.indexOf('function speakAndroidTts'));
  // F17 教訓：註解提及 token 不得誤報——剝註解後比對
  const CODE = speakBody.replace(/\/\/[^\n]*/g, '');
  assert.ok(/isWindows/.test(CODE), 'speak() 有 isWindows 分支');
  assert.ok(CODE.indexOf('isWindows') < CODE.indexOf('speakAsync'), 'Windows 判斷在 piper fallback 之前');
  assert.ok(/speechSynthesis\.getVoices\(\)\.length > 0/.test(CODE), '有語音才走 Web Speech（零語音 fallback）');
  assert.ok(/pickWindowsEnVoice/.test(src), '語音選擇函式在位');
  assert.ok(/u\.rate = /.test(src) && /u\.pitch = /.test(src), 'speed/pitch 有映射到 utterance');
});
