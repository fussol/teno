#!/usr/bin/env node
// verify-tts-server.mjs — WEB 語音來源（電腦 Piper）防回歸
//   前端非 Tauri 時可選請 web server 用 Piper 合成（回 base64 WAV）→ 瀏覽器播放；失敗退回 speechSynthesis。
//   本檔只做源碼契約釘（Rust 命令＋web 分派＋JS 接線）；實機合成由 server 端 e2e 另驗。
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x ? ' | ' + x : ''}`); } };
const R = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const lib = R('src-tauri/src/lib.rs');
const winvoke = R('src-tauri/src/web/invoke.rs');
const api = R('src/lib/api.js');
const tts = R('src/lib/tts.js');
const store = R('src/lib/store.js');
const sect = R('src/pages/settings/sections.js');
const settingsJs = R('src/pages/settings.js');

console.log('── Rust ──');
ok('lib.rs 有 piper_synth（純合成、不播放）', /fn piper_synth\(/.test(lib));
ok('lib.rs 有 speak_piper 呼叫 piper_synth', /fn speak_piper\([\s\S]{0,400}?piper_synth\(/.test(lib));
ok('lib.rs 有 pub tts_synthesize 回 base64', /pub async fn tts_synthesize\([\s\S]{0,900}?b64_encode\(/.test(lib));
ok('lib.rs 有 b64_encode', /fn b64_encode\(/.test(lib));
ok('piper_models_dir 支援 TENO_PIPER_MODELS 覆寫', /TENO_PIPER_MODELS/.test(lib));
ok('piper_models_dir web 回退桌機模型目錄', /is_web\(\)[\s\S]{0,200}com\.teno\.app[\s\S]{0,40}piper-models/.test(lib));
ok('web/invoke.rs 有 tts_synthesize 分派', /"tts_synthesize"\s*=>/.test(winvoke) && /crate::tts_synthesize\(/.test(winvoke));
ok('tts_synthesize 不在 web 封鎖清單', !/"tts_synthesize"[\s\S]{0,40}(僅桌面|RCE)/.test(winvoke));

console.log('── JS api ──');
ok('api.js 有 synthesizeTts → invoke(tts_synthesize)', /synthesizeTts[\s\S]{0,200}invoke\('tts_synthesize'/.test(api));

console.log('── JS tts ──');
ok('tts.js 有 _ttsSource ＋ setTtsSource', /let _ttsSource/.test(tts) && /export function setTtsSource/.test(tts));
ok('speak() 非 Tauri 時依 _ttsSource 分流 piper', /if \(!_ttsSource === 'piper'\)/.test(tts) || /_ttsSource === 'piper'[\s\S]{0,200}speakServerPiper/.test(tts));
ok('speakServerPiper 失敗退回 speakWebSpeech', /speakServerPiper\([\s\S]{0,300}speakWebSpeech/.test(tts));
ok('有 base64 → Blob 播放（Audio）', /base64ToBlob/.test(tts) && /new Audio\(/.test(tts));
ok('stopSpeech 會停 server 音訊', /_serverAudio[\s\S]{0,60}pause/.test(tts));

console.log('── JS store / settings ──');
ok('store 有 ttsSource 預設＋hydrate', /ttsSource: 'browser'/.test(store) && /ttsSource: await db\.getSetting\('ttsSource'\)/.test(store));
ok('store 有 setTtsSource action 並全域套用', /async setTtsSource\(v\)[\s\S]{0,200}applyTtsSource/.test(store));
ok('settings 區塊有語音來源選擇器（web）', /id="ttsSourceSel"/.test(sect) && /isWeb \? `[\s\S]{0,400}ttsSourceSel/.test(sect));
ok('settings 綁定 ttsSourceSel → setTtsSource', /ttsSourceSel'\)\?\.addEventListener\('change'[\s\S]{0,120}setTtsSource/.test(settingsJs));

console.log(fail === 0 ? `\n═══ TTS-SERVER ALL PASS ═══` : `\n═══ ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
