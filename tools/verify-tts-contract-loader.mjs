// F2 驗證 loader — 攔截 tts.js 的三個 ESM 依賴，換成可注入的 stub。
// 用法：由 verify-tts-contract.mjs 以 register() 載入。
const apiStub = `
globalThis.__ttsApi = { speakCalls: [], nativeCalls: [], stopCalls: 0, failNextSpeak: false, failNative: false };
export const speakText = async (text, opts) => {
  globalThis.__ttsApi.nativeCalls.push({ text, opts });
  if (globalThis.__ttsApi.failNative) throw new Error('native speak unavailable');
};
export const speakAndroid = async (text, opts) => {
  globalThis.__ttsApi.speakCalls.push({ text, opts });
  if (globalThis.__ttsApi.failNextSpeak) {
    globalThis.__ttsApi.failNextSpeak = false;
    throw new Error('speak_android invoke failed');
  }
};
export const stopAndroid = async () => { globalThis.__ttsApi.stopCalls++; };
`;

// 平台開關（G9 驗證用）：預設 true＝Android，verify-tts-contract 既有行為零變動；
// G9 桌面路徑腳本 import 前設 globalThis.__ttsPlatformIsAndroid = false。
// isTauri 亦是 tts.js 的 import 名（TAURIGATE1 後加入）——stub 缺它 → SyntaxError 模組載不進。
// 預設 true＝桌面 app（Web Speech 條件 `!isTauri` 不觸發，Windows 分支照走）；
// 需要 WEB 態的驗證以 __ttsPlatformIsTauri=false 設定。
const platformStub = `export const isAndroid = globalThis.__ttsPlatformIsAndroid !== false;
export const isWindows = globalThis.__ttsPlatformIsWindows === true;
export const isTauri = globalThis.__ttsPlatformIsTauri !== false;`;

const eventStub = `
globalThis.__ttsListeners = new Map();
export async function listen(name, cb) {
  globalThis.__ttsListeners.set(name, cb);
  return () => globalThis.__ttsListeners.delete(name);
}
`;

export async function resolve(specifier, context, next) {
  let src = null;
  if (specifier === './api.js') src = apiStub;
  else if (specifier === './platform.js') src = platformStub;
  else if (specifier === '@tauri-apps/api/event') src = eventStub;
  if (src) {
    return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
  }
  return next(specifier, context);
}
