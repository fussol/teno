# BUG-OCR-CSP-fix-plan.md — Tauri 生產 CSP 擋 tesseract blob worker（OCR 無法正常工作）

## Bug 定義
tools 頁 OCR：選圖→辨識，真機（Tauri 桌面/Android 生產環境）回錯誤「辨識失敗：OCR 資產載入但 Tesseract API 缺失」。
dev server（無 CSP）可正常辨識 → 差異只在生產 CSP。

## Root cause
tesseract.js createWorker 內部用 `URL.createObjectURL()`（blob URL）產生內部 Web Worker script，
再 `new Worker(blobURL)`。Tauri 生產 CSP `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`
**缺少 `blob:`** → CSP 擋掉 blob worker → createWorker reject。

一手實證（CSP 真機模擬測試頁，dev server 伺服帶同 CSP meta 的 HTML）：
- 真機 CSP（無 blob:、無 unsafe-eval）：`window.Tesseract=true`、`createWorker=true` 但 `createWorker REJECT msg=undefined`
- +`'unsafe-eval'`：仍 REJECT（證明 unsafe-eval 非必要條件）
- **+`blob:`（script-src）のみ：createWorker RESOLVED ✅**（最小修法實錘）

tesseract.min.js 一手查證：含 `new Worker` ×2、`URL.createObjectURL` ×1 → blob worker 屬關鍵路徑。

## 修法
`src-tauri/tauri.conf.json` 的 CSP `script-src` 值，加入 `blob:`：
```
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:
```
不需動 `worker-src`（實際測試 script-src blob: 單獨即夠）；不引入 `'unsafe-eval'`（非必要，且降低 CSP 安全面）。

## 驗證
1. node --check + npm run build 綠（構建不受 CSP 影響，但確認無 syntax 破壞）
2. dev server 伺服「帶修後 CSP 的測試 HTML」→ createWorker RESOLVED（已實錘最小變因）
3. tauri.conf.json CSP 值確認含 blob:
4. 真機（A55）需用戶重裝 APK 後實測——此為終極驗證（本機無法跑 Android WebView）

## 風險
低。`script-src blob:` 允許 blob URL 執行程式——攻擊面有限（blob 僅來自本 app 自身 origin），
且 tesseract 已將引擎資料放在 /assets 離線、cacheMethod none，無外部下載。
對比引入 `'unsafe-eval'`（全域 eval 允許，風險高），`blob:` 是 tesseract 正常運作的必要、且最小之放行。

## 送審紀錄
v1.0 2026-08-29