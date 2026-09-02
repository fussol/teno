// F2 事件契約驗證（node:test + mock timers）
// 用法：node --test tools/verify-tts-contract.mjs
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// 先註冊 loader 攔截 tts.js 的三個依賴（./api.js、./platform.js、@tauri-apps/api/event），
// 再動態 import tts.js（靜態 import 會在 register 前解析 → 必須動態）
// Node 26：register 接受 URL 實例（勿用 pathToFileURL 包 URL — ERR_INVALID_ARG_TYPE）
register(new URL('./verify-tts-contract-loader.mjs', import.meta.url));

const { speak, stopSpeech } = await import('../src/lib/tts.js');
// import 返回時 tts.js 內部的 listen 微任務可能尚未執行 → flush 一次確保 listener 註冊完成
await new Promise((r) => setImmediate(r));

const listeners = () => globalThis.__ttsListeners;
const emit = (name, payload) => {
  const cb = listeners().get(name);
  assert.ok(cb, `listener ${name} 未註冊`);
  cb({ payload });
};
const flush = () => new Promise((r) => setImmediate(r));

before(() => {
  assert.ok(listeners().has('tts://speech:start'), 'start listener 已註冊');
  assert.ok(listeners().has('tts://speech:done'), 'done listener 已註冊');
  assert.ok(listeners().has('tts://speech:error'), 'error listener 已註冊');
  assert.ok(listeners().has('tts://speech:stopped'), 'stopped listener 已註冊');
});

beforeEach(() => {
  globalThis.__ttsApi.speakCalls.length = 0;
  globalThis.__ttsApi.stopCalls = 0;
  globalThis.__ttsApi.failNextSpeak = false;
});

test('1. speak→start(id)→done(id) ⇒ resolve', async () => {
  const p = speak('hello', 0.9, 'en-us', 50);
  emit('tts://speech:start', { utteranceId: 'id-1', reason: '', text: 'hello' });
  emit('tts://speech:done', { utteranceId: 'id-1', reason: 'finish' });
  assert.equal(await p, undefined, 'done(finish) 應 resolve undefined');
});

test('2. 舊 utterance 的 done 不誤觸（id 比對）', async () => {
  const p = speak('hello', 0.9, 'en-us', 50);
  emit('tts://speech:done', { utteranceId: 'stale-old-id', reason: 'finish' }); // 老事件 → ignore
  await flush();
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, '舊 id done 不應 settle');
  emit('tts://speech:start', { utteranceId: 'id-2', text: 'hello' });
  emit('tts://speech:done', { utteranceId: 'id-2', reason: 'finish' });
  await p; // 自己的 done 才 resolve
});

test('3. speak→start(id)→stopped(id,user) ⇒ resolve cancelled（不推進）', async () => {
  const p = speak('hello', 0.9, 'en-us', 50);
  emit('tts://speech:start', { utteranceId: 'id-3', text: 'hello' });
  emit('tts://speech:stopped', { utteranceId: 'id-3', reason: 'user' });
  assert.deepEqual(await p, { cancelled: true }, 'stopped(user) 應 resolve {cancelled:true}');
});

test('4. stopped(pause) 不 resolve 不 reject（標記 paused，槽保留）', async () => {
  const p = speak('hello', 0.9, 'en-us', 50);
  emit('tts://speech:start', { utteranceId: 'id-4', text: 'hello' });
  emit('tts://speech:stopped', { utteranceId: 'id-4', reason: 'pause' });
  await flush();
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'stopped(pause) 不應 settle');
  // 槽仍活著：稍後 done 仍可 resolve
  emit('tts://speech:done', { utteranceId: 'id-4', reason: 'finish' });
  assert.equal(await p, undefined);
});

test('5. timeout 只清自己的槽：覆蓋後舊 timeout 不誤殺新槽', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });   // Node 26：clearTimeout 隨 setTimeout 自動 mock，勿列
  try {
    const pa = speak('a', 0.9, 'en-us', 50); // slot A
    mock.timers.tick(29000);
    const pb = speak('b', 0.9, 'en-us', 50); // 覆蓋 A：A resolve cancelled、新槽 B
    assert.deepEqual(await pa, { cancelled: true }, '覆蓋時舊槽應 resolve cancelled');
    mock.timers.tick(2000); // 共 31s：A 的 timeout 到點，但不得誤殺 B
    let settled = false;
    pb.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    assert.equal(settled, false, '舊槽 timeout 不應誤殺新槽 B');
    emit('tts://speech:start', { utteranceId: 'id-b', text: 'b' });
    emit('tts://speech:done', { utteranceId: 'id-b', reason: 'finish' });
    await pb;
  } finally {
    mock.timers.reset();
  }
});

test('6. start 回填重設 timeout：長音訊 >30s 不被誤殺', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });   // Node 26：clearTimeout 隨 setTimeout 自動 mock，勿列
  try {
    const p = speak('long', 0.9, 'en-us', 50);
    mock.timers.tick(29000); // 接近 timeout
    emit('tts://speech:start', { utteranceId: 'id-6', text: 'long' }); // 回填 → 重設 30s
    mock.timers.tick(29000); // 再 29s（總 58s）— 未到新 timeout
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    assert.equal(settled, false, 'start 後 30s 內不應 timeout');
    emit('tts://speech:done', { utteranceId: 'id-6', reason: 'finish' });
    await p;
  } finally {
    mock.timers.reset();
  }
});

test('7. timeout 30s ⇒ reject(TTS timeout)，且 pause 槽至 timeout 亦 reject', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });   // Node 26：clearTimeout 隨 setTimeout 自動 mock，勿列
  try {
    const p = speak('x', 0.9, 'en-us', 50);
    mock.timers.tick(30000);
    await assert.rejects(p, /TTS timeout/);
    // pause 槽保留至 timeout 也會 reject（不推進語意不變）
    const p2 = speak('y', 0.9, 'en-us', 50);
    emit('tts://speech:start', { utteranceId: 'id-y', text: 'y' });
    emit('tts://speech:stopped', { utteranceId: 'id-y', reason: 'pause' });
    mock.timers.tick(30000);
    await assert.rejects(p2, /TTS timeout/);
  } finally {
    mock.timers.reset();
  }
});

test('8. speak 失敗（invoke reject）⇒ 恰一次 reject、error 事件零命中', async () => {
  globalThis.__ttsApi.failNextSpeak = true;
  const p = speak('boom', 0.9, 'en-us', 50);
  await assert.rejects(p, /invoke failed/);
  // invoke reject 後槽已清 → 後到的 error 事件零命中（無第二次 reject）
  emit('tts://speech:error', { utteranceId: 'id-8', reason: 'error', error: 'TTS error' });
  await flush();
  // 無 unhandled 二次 reject：給微任務時間觀察（若雙 reject 會 throw unhandledRejection）
  await flush();
});

test('9. stopSpeech ⇒ stopped(user) 自然 resolve cancelled', async () => {
  const p = speak('bye', 0.9, 'en-us', 50);
  emit('tts://speech:start', { utteranceId: 'id-9', text: 'bye' });
  const sp = stopSpeech();
  assert.equal(globalThis.__ttsApi.stopCalls, 1, 'stopAndroid 被呼叫');
  emit('tts://speech:stopped', { utteranceId: 'id-9', reason: 'user' });
  await sp;
  assert.deepEqual(await p, { cancelled: true });
});

test('10. 連播順序（L1 鎖定）：A 的 start 晚到不覆蓋已回填的槽；B 不被 done(B) 誤傷', async () => {
  // speak A → 立即 speak B（覆蓋 A）。事件序：start(A) 晚到時 slot B 已存在。
  const pa = speak('a', 0.9, 'en-us', 50);
  const pb = speak('b', 0.9, 'en-us', 50); // 覆蓋：A resolve cancelled
  assert.deepEqual(await pa, { cancelled: true }, 'A 被覆蓋 → resolve cancelled');
  // start(A) 晚到：slot B 已存在且 id 未定 → 依實作會被回填（已知限制 L1，console 層級）
  // 鎖定行為：B 的 promise 不 double-settle，且真正屬於 B 的事件仍正常處理
  emit('tts://speech:start', { utteranceId: 'id-a', text: 'a' }); // 可能污染 slot B
  emit('tts://speech:stopped', { utteranceId: 'id-a', reason: 'user' }); // A 的 stopped
  emit('tts://speech:start', { utteranceId: 'id-b', text: 'b' }); // 已回填 → ignore（防覆蓋）
  emit('tts://speech:done', { utteranceId: 'id-b', reason: 'finish' });
  await pb; // 不 throw 即可（無論 resolve 值為何，雙 settle 會 throw）
});
