# PM-OCR2 · T3 `feat(ocr): engine` — 引擎註冊表＋雙 Adapter（2026-08-28）

## 任務目標
§6.6：`src/lib/ocr/engine.js`（JSDoc typedef＋registerEngine/getActiveEngine，
讀 `getSetting('ocr_engine')` 異常回退 tesseract）＋ `tesseract-adapter.js`
（worker 單例、三路徑離線）＋ `paddle-adapter.js` 佔位 available()=false。

## 交付
- `src/lib/ocr/engine.js`：OcrBlock/OcrResult/OcrEngine JSDoc typedef（§3 原樣）；
  registry Map；`_getActiveEngine(getSettingImpl)` 可注入 seam；
  回退鏈＝setting 拋錯/幽靈 id/未註冊/available=false/available 拋錯 → tesseract；
  預設引擎本身不可用 → reject（不靜默回傳炸彈）；
  `getActiveEngine()` 每次現讀 setting＝無痛切換零寫死 import；
  內建引擎 lazy factory（模組載入零成本）。
- `src/lib/ocr/tesseract-adapter.js`：worker 單例（同語言復用、語言集變換 terminate
  重建）、workerPath/corePath/langPath 三路徑指 /assets/ocr/、gzip:true、
  recognize → OcrResult（blocks bbox/confidence 0..1 轉換，P1 僅留存）。
- `src/lib/ocr/paddle-adapter.js`：佔位，available()=false，recognize reject 中文提示。
- CSP：tauri.conf.json script-src 補 `'wasm-unsafe-eval'`（計畫 §6.5 原字串）。

## 一手查證（tesseract.js@7.0.0 原始碼）
- `createWorker(langs, oem, options)` 簽名 ✅（src/createWorker.js:72 corePath 透傳）
- corePath 目錄 → getCore.js 依 wasm-feature-detect 拼 `*-lstm.wasm.js`（lstmOnly=1）✅
- `worker.recognize(image, opts, output)` output={text,blocks} ✅（createWorker.js:168）
- package.json：main=src/index.js（CJS）exports undefined → **bare import 在
  optimizeDeps.exclude 下 vite 直出 CJS 必炸**（實測）
- **public/ JS import 死路（實測 v8 除錯）**：`import('/assets/ocr/x.js')` 被
  vite:import-analysis 附加 `?import` → dev 500；`@vite-ignore`／字串拼接均無效；
  blob URL import 可繞 bundler 但 Tauri 生產 CSP script-src 'self' 擋 blob:。
  **對策＝官方 UMD dist `<script src>` 注入（window.Tesseract）**：同網域
  script-src 'self' 兼容 dev/build/Tauri 三環境，資產管線補 tesseract.min.js。

## 四層內測門
1. **靜態**：node --check engine/tesseract-adapter/paddle-adapter/verify ✅；
   build 725ms 綠；verify-ocr-assets 15/15（補 tesseract.min.js sha256 釘）
2. **驗證腳本** `tools/verify-ocr-engine.mjs` **12/12 ALL PASS**
   E1 參數驗證／E2 paddle 佔位回退／E3 setting 拋錯回退／E4 幽靈 id 回退／
   E5 null 預設／E6 available 拋錯回退／E7 預設不可用 reject／
   E8 listEngines＋無痛切換（setting 換→engine 換）／
   NC 剝除回退段 paddle 直通＋NC 反換釘正常路徑不誤傷
3. **Browser 內測（真辨識，非 mock）** dev:5199：
   - registry：list=[tesseract,paddle]、getActiveEngine→tesseract（無 DB 環境
     getSetting 拋錯→回退鏈真實觸發）、paddleAvail=false、tesseractAvail=true
   - **真 OCR**：canvas 生成 'hello journey' 圖 → recognize →
     `{text:"hello journey", conf:0.95, blocks:1, ms:110}`（端到端 <3s 達標）
   - **負控制**：全黑圖 → text='' blocks=0 不拋例外 ✅（計畫 §7 負控制 A）
   - console 零 error / js_errors 0（全程多輪重載）
4. **證據**：本檔＋verify-ocr-engine.mjs

## 範圍外／登記
- worker.terminate 只在語言切換時觸發；app 退出不主動 terminate（OS 回收，Electron/
  WebView 慣例），P3 可加 cleanup。
- `cacheMethod:'none'`：離線部署防任何隱性快取路徑（assets 本身即快取）。
- OSV GHSA-83rx-c8cr-6j8q（T2 登記）仍未查——T6 收尾前處置。

## commit
`feat(ocr): engine` — src/lib/ocr/{engine,tesseract-adapter,paddle-adapter}.js、
tools/verify-ocr-engine.mjs、copy-ocr-assets/verify-ocr-assets 補 UMD dist、
tauri.conf.json CSP wasm-unsafe-eval
