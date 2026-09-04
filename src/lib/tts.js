import { speakText as nativeSpeak, speakAndroid as androidSpeak, stopAndroid } from './api.js'
import { isAndroid, isWindows } from './platform.js'

const _voiceMap = {
  'en-us': 'en_US-amy-medium',
  'en-gb': 'en_GB-alan-medium',
  'en-au': 'en_US-sam-medium',
  'en-sc': 'en_GB-alan-medium',
  'en': 'en_US-lessac-medium',
  'en_US-amy-medium': 'en_US-amy-medium',
  'en_US-lessac-medium': 'en_US-lessac-medium',
  'en_US-ryan-high': 'en_US-ryan-high',
  'en_US-sam-medium': 'en_US-sam-medium',
  'en_GB-alan-medium': 'en_GB-alan-medium',
};

let _hasNative = null;
// G9：失敗 toast 節流（只壓警告、不壓重試）——取代舊「30s 冷卻靜默」語意。
// -Infinity 哨兵：首次必過節流閘（epoch 未同步鐘 now<30s 時 `now-0>30000` 為假會誤壓，
// R1#1-S2）；時鐘後跳由 catch 內 clamp 兜（R1#1-S1），toast 最壞多報不早、永不長期消音。
let _lastFailToast = -Infinity;
const FAIL_TOAST_THROTTLE_MS = 30000;

// Android TTS
// F2 事件契約：槽物件化 { utteranceId, resolve, reject, timer }；
// done(finish)→resolve、error→reject、stopped(user)→resolve cancelled（不推進）、
// stopped(pause)→標記 paused（不 resolve 不 reject 不推進）
let _speechResolve = null;
let _pausedUtterance = null;
const TTS_TIMEOUT_MS = 30000;

// 30s timeout：只清自己的槽（物件同一性 ⇔ 單槽 id 唯一性；id 未定時亦受保護）
function armTimeout(slot) {
  clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    if (_speechResolve !== slot) return;
    _speechResolve = null;
    if (_pausedUtterance === slot.utteranceId) _pausedUtterance = null;
    slot.reject(new Error('TTS timeout'));
  }, TTS_TIMEOUT_MS);
}

// G9：Web Speech 從不用於發音（唯一桌面路徑 = nativeSpeak），舊 pick/_enVoice
// voices 掃描死碼已除（getVoices 每事件週期白跑）。stopSpeech 的 cancel 保留（no-op 防呆）。

// Set up Android TTS event listeners once
if (isAndroid) {
  import('@tauri-apps/api/event').then(({ listen }) => {
    // start：id 傳遞通道（JS 無法自產 utteranceId，Kotlin 端 UUID 綁定 KEY_PARAM_UTTERANCE_ID）
    listen('tts://speech:start', (e) => {
      const slot = _speechResolve;
      if (!slot || slot.utteranceId != null) return; // 無槽或已回填 → ignore（防重送/異 id 覆蓋）
      slot.utteranceId = e.payload?.utteranceId ?? null;
      if (slot.utteranceId == null) return;
      armTimeout(slot); // 長音訊保護：timeout 自 start 起算重設
    });
    listen('tts://speech:done', (e) => {
      const slot = _speechResolve;
      if (!slot || slot.utteranceId !== e.payload?.utteranceId) return;
      _speechResolve = null;
      clearTimeout(slot.timer);
      if (_pausedUtterance === slot.utteranceId) _pausedUtterance = null;
      slot.resolve();
    });
    listen('tts://speech:error', (e) => {
      const slot = _speechResolve;
      if (!slot || slot.utteranceId !== e.payload?.utteranceId) return;
      _speechResolve = null;
      clearTimeout(slot.timer);
      if (_pausedUtterance === slot.utteranceId) _pausedUtterance = null;
      slot.reject(new Error(e.payload?.error || 'TTS error'));
    });
    listen('tts://speech:stopped', (e) => {
      const slot = _speechResolve;
      if (!slot || slot.utteranceId !== e.payload?.utteranceId) return;
      if (e.payload?.reason === 'pause') {
        // 契約：stopped(pause) → 標記 paused（不 resolve 不 reject 不推進）；槽保留至 timeout 或下次 speak 覆蓋
        _pausedUtterance = slot.utteranceId;
        return;
      }
      // reason=user（或未知 → 保守視為 user cancel）：resolve cancelled（不推進）
      _speechResolve = null;
      clearTimeout(slot.timer);
      slot.resolve({ cancelled: true });
    });
  });
}

export function speak(text, speed, voice, pitch) {
  if (!text) return Promise.resolve();
  if (isAndroid) return speakAndroidTts(text, speed ?? 0.9, voice || '', pitch ?? 50);
  // 2026-09-05 方案 C（使用者裁示）：Windows 走 WebView2 speechSynthesis（Edge/Microsoft
  // 自然語音，免 piper 免安裝）；Linux 維持 piper。speechSynthesis 不可用或零語音時
  // fallback piper（speakAsync，Windows 無 piper 會失敗並反映在 ttsAvailable）。
  if (isWindows && typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices().length > 0) {
    return speakWebSpeech(text, speed ?? 0.9, pitch ?? 50);
  }
  return speakAsync(text, speed ?? 0.9, _voiceMap[voice] || voice || 'en_US-ryan-high', pitch ?? 50);
}

// Windows：WebView2 speechSynthesis（Chromium on Windows 吃 OS/Edge 語音，含自然語音）
let _wsVoice = null;
function pickWindowsEnVoice() {
  if (_wsVoice) return _wsVoice;
  const vs = speechSynthesis.getVoices();
  // 優先 en-US 自然語音（Natural/Online 標記），退而求其次任何 en
  _wsVoice = vs.find(v => /en[-_]US/i.test(v.lang) && /natural|online/i.test(v.name))
    || vs.find(v => /^en/i.test(v.lang) && /natural|online/i.test(v.name))
    || vs.find(v => /^en[-_]US/i.test(v.lang))
    || vs.find(v => /^en/i.test(v.lang))
    || null;
  return _wsVoice;
}
function speakWebSpeech(text, speed, pitch) {
  return new Promise((resolve, reject) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = pickWindowsEnVoice();
      if (v) u.voice = v;
      u.lang = v?.lang || 'en-US';
      u.rate = Math.max(0.5, Math.min(2.0, speed));
      u.pitch = Math.max(0, Math.min(2.0, pitch / 50));
      u.onend = () => resolve();
      u.onerror = (ev) => reject(new Error('speech error: ' + (ev?.error || 'unknown')));
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      // 保底 timeout：onend 不觸發時不永久 pending
      setTimeout(() => { speechSynthesis.cancel(); resolve({ cancelled: true }); }, 30000);
    } catch (e) {
      reject(e);
    }
  });
}

function speakAndroidTts(text, speed, voice, pitch) {
  return new Promise((resolve, reject) => {
    if (_speechResolve) {
      // 覆蓋前 settle 舊槽 + clearTimeout：pause 槽被覆蓋不永久 pending（pronAuto await 即時恢復）
      const prev = _speechResolve;
      clearTimeout(prev.timer);
      prev.resolve({ cancelled: true });
      stopAndroid().catch(() => {});
    }
    _pausedUtterance = null;
    const slot = { utteranceId: null, resolve, reject, timer: null };
    _speechResolve = slot;
    armTimeout(slot);
    androidSpeak(text, { speed, voice }).catch(e => {
      if (_speechResolve === slot) {
        _speechResolve = null;
        clearTimeout(slot.timer);
        reject(e);
      }
    });
  });
}

async function speakAsync(text, speed, voice, pitch) {
  // G9：舊實作 native 失敗後 30s 直接靜默 return（無聲無 toast）——改為每次必重試，
  // 失敗反馈只剩 toast 節流（30s 一次）。僅桌面可達（speak() Android 已提前 return）。
  try {
    await nativeSpeak(text, { speed, voice, pitch });
    _hasNative = true;
  } catch (e) {
    console.warn('[tts] native TTS failed:', e);
    _hasNative = false;
    const now = Date.now();
    if (now < _lastFailToast) _lastFailToast = now; // 時鐘後跳 clamp（防壓制期毒化）
    if (now - _lastFailToast > FAIL_TOAST_THROTTLE_MS) {
      _lastFailToast = now;
      // G9-R1#1：真信道 = window.toast（main.js:434 賦值，CSS .toast-error 存在）；
      // 舊 window.__toast 全 repo 零賦值端＝幽靈信道，真 app 從未顯示過（dabfea1 起）。
      if (typeof window !== 'undefined' && typeof window.toast === 'function') {
        window.toast('發音失敗: ' + (e?.message || String(e)).slice(0, 50), 'toast-error');
      }
    }
  }
}

export async function stopSpeech() {
  if (isAndroid) {
    // 不再預先清槽：Kotlin stop() 會 emit stopped(user) 帶 id → 由事件自然 resolve（cancelled）；
    // 無進行中 speech 時 Kotlin 不 emit、無副作用
    try { await stopAndroid(); } catch {}
    return;
  }
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

export function ttsAvailable() {
  // G9：誠實語意——桌面發音唯一路徑是 native plugin，舊 `|| speechSynthesis` 分支
  // 假設了已不存在的 Web Speech fallback（誤報源）。未知時樂觀 true（首次呼叫揭曉），
  // 連續失敗後 false（重試仍進行，僅可用性匯報翻臉）。
  // 2026-09-05：Windows 走 speechSynthesis（方案 C）——樂觀 true，WebView2 必帶語音。
  if (isAndroid) return true;
  if (isWindows) return true;
  return _hasNative !== false;
}

/**
 * 從中英混雜的文字抽出英文部分（例句常是「英文。中文翻譯」）。
 * 以中文字元/中文標點為界拆段，每段去中文後保留英文，全部 join。
 */
export function extractEnglish(s) {
  if (!s) return '';
  const parts = String(s).split(/[•·]/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const chunks = p
      .split(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/)
      .map(c => c.replace(/\s+/g, ' ').trim())
      .map(c => c.replace(/[\s/—–|:：]+$/g, '').trim())
      .filter(c => /[A-Za-z]/.test(c) && !/^[a-z]{1,5}\.$/.test(c));
    out.push(...chunks);
  }
  return out.join(' ') || (!/[\u4e00-\u9fff]/.test(String(s)) ? String(s).trim() : '');
}

/**
 * 點擊英文文字播放 TTS（取代發音按鈕）。
 * 綁定在頁面 root 上做事件委派：
 *   .study-word（單字）、.study-example（例句，自動抽英文）、
 *   .chip-accent/.chip-subtle（相似詞/詞形變化）、.tts-click（自訂可點區域）
 * getSettings() 回傳 { ttsSpeed, ttsVoice, ttsPitch }。
 */
export function bindSpeakClick(root, getSettings) {
  if (!root) return;
  // #pageContainer 是常駐節點（main.js 建一次，翻卡/換頁只改 innerHTML）。
  // 若不擋重複綁定，每次 onMount 都會多一個 click listener → 點擊一次 N 次發音。
  if (root.__speakBound) return;
  root.__speakBound = true;
  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('.study-word, .study-example, .chip-accent, .chip-subtle, .tts-click, .word-row-word, .deck-word, .card-panel-word, .card-panel-pron, .card-panel-def, .card-panel-example, .card-panel-desc');
    if (!el) return;
    if (el.closest('button, input, a, select, textarea')) return;
    ev.stopPropagation();
    const st = (typeof getSettings === 'function' ? getSettings() : {}) || {};
    // data-speak 優先：拼字頁點定義區要唸「目標單字」，但單字不能顯示在畫面上
    const text = el.dataset?.speak
      ? el.dataset.speak
      : el.classList.contains('study-example')
        ? extractEnglish(el.textContent)
        : el.textContent.trim();
    if (!text) return;
    speak(text, st.ttsSpeed || 0.9, st.ttsVoice || 'en-us', st.ttsPitch || 50);
  });
}
