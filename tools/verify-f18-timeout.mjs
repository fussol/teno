// F18 驗證 — Android TTS promise timeout 兜底（結論型：已被 F2/b620d46 吸收）
// 用法：node --test tools/verify-f18-timeout.mjs
//
// 威脅模型定文（比照 F17 v4）：本腳本防「無意回歸＋偷工」（重構拆掉兜底、pause 分支誤加
// clearTimeout、start 重挂被移除），不抵禦蓄意偽裝對抗（惡意 decoy/註解欺詐不在防禦面）。
//
// 雙態：
//   T0  PRE 紅基線 — dabfea1（audit 2026-08-13 前最後一版）抽至 /tmp 實跑：事件遺失 →
//       31s 仍 pending ＝ F18 宣稱在掃描時點精準重現（舊版無 timer、連 stopped 監聽都沒有）。
//   T1-T7 POST 綠態 — HEAD 真碼逐路徑兜底斷言（P1/P2/P3/P4/P6/P7/P8 見 F18-fix-plan §3）。
//   T8  靜態釘 — 三錨點（常數/speak 建槽挂/start 重挂）防無聲拆除。
//   NC1/NC2 負控制 — /tmp 變體精準剝修法 → bug 精準重現。
// 零連網、零真機：全部事件層模擬，Kotlin 降級路徑（仍 emit 事件）天然隔離，
// 不干預 F17 暖機視窗語義。
//
// 【harness 注意】loader stub 的 __ttsListeners 是跨模組共用 Map（URL 相同→stub 只求值一次），
// 每個被載入的 tts.js 副本（HEAD/舊 blob/NC 變體）都會以自身 handler 覆寫同名 key。
// 故本腳本在每次 import 後立即快照該模組的 handler（emitVia），所有事件顯式路由，
// 嚴禁依賴 Map 現值。
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/teno-f18-verify';

register(new URL('./verify-tts-contract-loader.mjs', import.meta.url));

const snapshot = () => new Map(globalThis.__ttsListeners);
const emitVia = (h, name, payload) => {
  const cb = h.get(name);
  assert.ok(cb, `handler ${name} 未註冊（快照缺 key：${[...h.keys()].join(',')}）`);
  cb({ payload });
};
const flush = () => new Promise((r) => setImmediate(r));
const settleProbe = (p) => {
  const probe = { settled: false, value: undefined, error: undefined };
  p.then((v) => { probe.settled = true; probe.value = v; },
         (e) => { probe.settled = true; probe.error = e; });
  return probe;
};
const gitShow = (rev) =>
  execFileSync('git', ['-C', REPO, 'show', `${rev}:src/lib/tts.js`], { encoding: 'utf8' });
// 花括號平衡提取函數/回調本體（威脅模型：非對抗場景，明文掃描即可）
const bodyOf = (src, anchor) => {
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

const OLD_COMMIT = 'dabfea1'; // audit(2026-08-13) 前最後一次 tts.js 改動
let HEAD_SRC = '';

before(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const oldSrc = gitShow(OLD_COMMIT);
  // 正宗性釘：舊 blob 必須是「無 timeout、無 stopped 監聽」版（否則 PRE 基線失真）
  assert.ok(!/armTimeout|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|Worker|Atomics/.test(oldSrc), 'PRE blob 必須是無 timeout 版（R1#2 擴字面集：堵 interval/rAF/polling 隱形兜底假紅）');
  assert.ok(!/tts:\/\/speech:stopped/.test(oldSrc), 'PRE blob 必須是無 stopped 監聽版');
  HEAD_SRC = gitShow('HEAD');
  assert.match(HEAD_SRC, /armTimeout/, 'HEAD 正宗性：含 armTimeout（F2 吸收態）');
});

after(() => { try { mock.timers.reset(); } catch {}
  rmSync(TMP, { recursive: true, force: true }); });

beforeEach(() => {
  globalThis.__ttsApi.speakCalls.length = 0;
  globalThis.__ttsApi.stopCalls = 0;
  globalThis.__ttsApi.failNextSpeak = false;
});

// ---------- HEAD 載入（先於所有 POST 斷言） ----------
const { speak, stopSpeech } = await import('../src/lib/tts.js');
await new Promise((r) => setImmediate(r)); // listen(...) 微任務註冊
const H = snapshot(); // HEAD 四監聽 handler 快照（後續不依賴 Map 現值）

// ---------- T1. P1：invoke 成功但四事件全遺失 → speak+30s 大限 reject ----------
test('T1. P1 事件全遺失 → 恰 30s reject(TTS timeout)，非永久 pending', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = speak('hello', 0.9, 'en-us', 50);
    const probe = settleProbe(p);
    mock.timers.tick(29999);
    await flush();
    assert.equal(probe.settled, false, '29.999s 不應提前誤殺');
    mock.timers.tick(1);
    await assert.rejects(p, /TTS timeout/);
  } finally { mock.timers.reset(); }
});

// ---------- T2. P2：start 到達、done 遺失 → 自 start 重算 30s ----------
test('T2. P2 start 回填重挂：start+29s 不殺、start+30s 大限 reject', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = speak('long-audio', 0.9, 'en-us', 50);
    mock.timers.tick(29000); // 原 speak-timer 剩 1s
    emitVia(H, 'tts://speech:start', { utteranceId: 'id-p2', text: 'long-audio' });
    mock.timers.tick(29000); // 總 58s、自 start 起 29s
    const probe = settleProbe(p);
    await flush();
    assert.equal(probe.settled, false, 'start 後 29s 不應 timeout');
    mock.timers.tick(1000);
    await assert.rejects(p, /TTS timeout/, 'start+30s 兜底 reject');
  } finally { mock.timers.reset(); }
});

// ---------- T3. P3：invoke reject → 即時 settle，殘 timer 到點無副作用 ----------
test('T3. P3 invoke reject 即時 settle；殘留 timeout 到點無副作用', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.__ttsApi.failNextSpeak = true;
    const p = speak('boom', 0.9, 'en-us', 50);
    await assert.rejects(p, /invoke failed/); // 未 tick 任何 timer 就 reject
    mock.timers.tick(60000); // 舊 timer 到點：槽已清 → 靜默 return，無 unhandled
    await flush();
    const p2 = speak('next', 0.9, 'en-us', 50); // 系統仍健康
    emitVia(H, 'tts://speech:start', { utteranceId: 'id-p3', text: 'next' });
    emitVia(H, 'tts://speech:done', { utteranceId: 'id-p3', reason: 'finish' });
    await p2;
  } finally { mock.timers.reset(); }
});

// ---------- T4. P4：覆蓋舊槽即時 settle（不等 30s） ----------
test('T4. P4 speak 覆蓋：舊槽即時 resolve cancelled，無懸掛', { timeout: 8000 }, async () => {
  const pa = speak('a', 0.9, 'en-us', 50);
  const pb = speak('b', 0.9, 'en-us', 50);
  assert.deepEqual(await pa, { cancelled: true }, '舊槽覆蓋即 settle');
  emitVia(H, 'tts://speech:start', { utteranceId: 'id-p4b', text: 'b' });
  emitVia(H, 'tts://speech:done', { utteranceId: 'id-p4b', reason: 'finish' });
  await pb;
});

// ---------- T5. P6：pause 槽至大限 reject（pause 不得 clearTimeout 造成永久懸掛） ----------
test('T5. P6 stopped(pause) 後零事件 → timeout 兜底 reject，不永久懸掛', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = speak('paused', 0.9, 'en-us', 50);
    emitVia(H, 'tts://speech:start', { utteranceId: 'id-p6', text: 'paused' });
    emitVia(H, 'tts://speech:stopped', { utteranceId: 'id-p6', reason: 'pause' });
    mock.timers.tick(30000);
    await assert.rejects(p, /TTS timeout/, 'pause 槽由 timeout 兜底收尾');
  } finally { mock.timers.reset(); }
});

// ---------- T6. P7：幽靈異 id 事件不 settle 不清 timer，兜底照常 ----------
test('T6. P7 幽靈事件風暴：異 id done/stopped/error 全 ignore，30s 兜底仍生效', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = speak('ghost', 0.9, 'en-us', 50);
    emitVia(H, 'tts://speech:start', { utteranceId: 'id-p7', text: 'ghost' });
    emitVia(H, 'tts://speech:done', { utteranceId: 'ghost-1', reason: 'finish' });
    emitVia(H, 'tts://speech:stopped', { utteranceId: 'ghost-2', reason: 'user' });
    emitVia(H, 'tts://speech:error', { utteranceId: 'ghost-3', error: 'x' });
    const probe = settleProbe(p);
    await flush();
    assert.equal(probe.settled, false, '幽靈事件不應誤 settle');
    mock.timers.tick(30000);
    await assert.rejects(p, /TTS timeout/);
  } finally { mock.timers.reset(); }
});

// ---------- T7. P8：stopSpeech 後 Kotlin 未 emit → timeout 兜底 ----------
test('T7. P8 stopSpeech 無後續事件 → timeout 兜底 reject，不懸掛', { timeout: 8000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const p = speak('bye', 0.9, 'en-us', 50);
    emitVia(H, 'tts://speech:start', { utteranceId: 'id-p8', text: 'bye' });
    await stopSpeech();
    assert.ok(globalThis.__ttsApi.stopCalls >= 1, 'stopAndroid 已呼叫');
    mock.timers.tick(30000);
    await assert.rejects(p, /TTS timeout/);
  } finally { mock.timers.reset(); }
});

// ---------- T8. 靜態釘：timeout 三錨點 ----------
test('T8. 靜態釘：大限常數／speak 建槽挂／start 回填重挂 三錨點存在', { timeout: 8000 }, () => {
  assert.match(HEAD_SRC, /const TTS_TIMEOUT_MS\s*=\s*30000;/, '大限常數在');
  assert.match(bodyOf(HEAD_SRC, 'function speakAndroidTts('), /armTimeout\(slot\);/,
    'speak 建槽即挂 timer（先挂再 invoke：invoke 後事件全遺失也有兜底）');
  assert.match(bodyOf(HEAD_SRC, "listen('tts://speech:start'"), /armTimeout\(slot\);/,
    'start 回填重挂（長音訊誤殺防護＋P2 兜底源）');
});

// ---------- NC1. 負控制：剝除 speak 路徑 armTimeout → 永久 pending 精準重現 ----------
test('NC1. 剝除 speak 路徑 armTimeout → P1 場景永久 pending（F18 原態重現）', { timeout: 8000 }, async () => {
  const patched = HEAD_SRC.replace(
    '    _speechResolve = slot;\n    armTimeout(slot);',
    '    _speechResolve = slot;');
  assert.notEqual(patched, HEAD_SRC, 'NC1 splice 必須精準命中（源碼漂移則失護，需修腳本）');
  const ncPath = resolve(TMP, 'tts-nc1.mjs');
  writeFileSync(ncPath, patched);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = await import(ncPath);
    await flush();
    const p = m.speak('nc1', 0.9, 'en-us', 50);
    const probe = settleProbe(p);
    mock.timers.tick(61000);
    await flush();
    assert.equal(probe.settled, false, 'NC1：剝除兜底後永久 pending＝負控制精準重現');
  } finally { mock.timers.reset(); }
});

// ---------- NC2. 負控制：剝除 start 重挂 → 長音訊 30s 誤殺重現 ----------
test('NC2. 剝除 start 回填重挂 → 長音訊被 speak 起算舊 timer 誤殺', { timeout: 8000 }, async () => {
  const patched = HEAD_SRC.replace(
    '      armTimeout(slot); // 長音訊保護：timeout 自 start 起算重設',
    '      // [NC2] armTimeout removed');
  assert.notEqual(patched, HEAD_SRC, 'NC2 splice 必須精準命中');
  const ncPath = resolve(TMP, 'tts-nc2.mjs');
  writeFileSync(ncPath, patched);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = await import(ncPath);
    await flush();
    const HN = snapshot(); // NC2 模組自己的 handler（覆寫 Map 後快照）
    const p = m.speak('nc2-long', 0.9, 'en-us', 50);
    mock.timers.tick(29000);
    emitVia(HN, 'tts://speech:start', { utteranceId: 'id-nc2', text: 'nc2-long' });
    mock.timers.tick(1500); // start 後僅 1.5s，但 speak 起算已 30.5s
    await assert.rejects(p, /TTS timeout/, 'NC2：無重挂 → 正常長音訊被 30s 誤殺');
  } finally { mock.timers.reset(); }
});

// ---------- T0. PRE 紅基線：掃描時點 bug 實跑重現（放最後：舊 blob 載入必覆寫共用 Map，
// 顯式路由下雖無害，仍置尾以隔離一切） ----------
test('T0. PRE：dabfea1 舊版 — 事件全遺失 → 31s 仍 pending（F18 宣稱重現）', { timeout: 8000 }, async () => {
  const oldSrc = gitShow(OLD_COMMIT);
  const oldPath = resolve(TMP, 'tts-old.mjs');
  writeFileSync(oldPath, oldSrc);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const m = await import(oldPath);
    await flush();
    const p = m.speak('hello', 0.9, 'en-us', 50);
    const probe = settleProbe(p);
    mock.timers.tick(31000);
    await flush();
    assert.equal(probe.settled, false, 'PRE：事件遺失 31s 後仍永久 pending＝F18 重現');
    // 死因歸屬：舊版事件面可 settle（證明卡死原因是「事件遺失」非樁子壞死）
    // （R1#3 註：此處用 Map 現值系刻意例外——T0 壓尾、舊模組最後載入其 done/error 已覆寫
    //   Map、顯式路由（H/HN 快照）各測試已結束，頭註「嚴禁依賴 Map 現值」的適用域為 POST 測試）
    const cb = globalThis.__ttsListeners.get('tts://speech:done');
    cb({ payload: { utteranceId: 'x', reason: 'finish' } });
    await p; // 能 settle
  } finally { mock.timers.reset(); }
});
