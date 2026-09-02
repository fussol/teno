# PM-OCR2 · T2 `feat(ocr): assets` — 建置期離線資產管線（2026-08-28）

## 任務目標
照計畫 §6.4/§6.7：tesseract.js ^7（devDep）＋ `tools/copy-ocr-assets.mjs`
＋ `npm run ocr:assets` ＋ vite `optimizeDeps.exclude: ['tesseract.js']`。
資產全部建置期進 `public/assets/ocr/`，執行期零下載（CSP 零放寬）。

## 實查校正（計畫書 §6.7 檔名勘誤，實碼為準）
- 計畫宣稱 core 來源為 npm 包 `tesseract-core-simd-lstm` → **實際**：tesseract.js@7
  依賴 `tesseract.js-core@^7`（單一包含全變體）。複製源 = `node_modules/tesseract.js-core/`。
- eng.traineddata.gz tessdata_fast **不隨附 .gz** → 腳本下載 raw 後自行 gzip
  （tesseract.js `gzip:true` 預設要求 `lang/eng.traineddata.gz`，語意吻合）。
- traineddata 防呆 magic：實測本機 `/usr/share/tessdata` 四檔 + 下載檔一致，
  檔頭 uint32 LE = `0x18`（非網路宣稱的 4C4D 字串簽名）。
- worker 變體選擇邏輯一手查證 `src/worker-script/browser/getCore.js`：
  corePath 傳目錄 → 依 wasm-feature-detect 拼 `tesseract-core[-relaxedsimd|-simd][-lstm].wasm.js`
  → createWorker(...,lstmOnly=1) 用 3 個 lstm 變體（已全數複製）。

## 四層內測門
1. **靜態**：`npm run build` 697ms 綠（僅既存 chunk warning）
2. **驗證腳本** `tools/verify-ocr-assets.mjs` **15/15 ALL PASS**
   - A1 devDep ^7＋實裝 7.0.0；A2 script＋腳本存在；A3 vite exclude 靜態釘
   - A4 四檔 sha256 與 node_modules 源 byte-identical
   - A5 eng gz gunzip 還原 magic=0x18＋>1MB
   - A6 負控制雙連：vite exclude 剝除→A3 紅；gz 截斷→gunzip 必拋（測敏感）
   - A7 .gitignore 已收 public/assets/ocr/（防 18MB 誤入 repo）
3. **Browser 內測**（vite 改 config 自動重載後重進）：
   - 頁面載入 console 零 error / js_errors 0
   - 三路徑執行期路由實測 200：worker.min.js 111,307B／core simd-lstm 3,899,472B／
     eng.traineddata.gz 1,961,173B（即 T3 adapter 將用的 workerPath/corePath/langPath）
4. **證據**：本檔＋verify 腳本腳手

## 資產清單（public/assets/ocr/，gitignored，npm run ocr:assets 再生）
worker.min.js 112K；core/ 三 lstm 變體 3.8M×3；lang/eng.traineddata.gz 1.9M（還原 4.1M）

## OSV 登記
`npm i -D tesseract.js@^7` 時 npm 審計面板顯示 GHSA-83rx-c8cr-6j8q 命中 7.0.0
（smart approval 放行）。**待辦**：T6 收尾前查該 advisory 內容是否影響本專案使用面
（離線 worker only、無不可信輸入源路徑）。

## commit
`feat(ocr): assets` — package.json(+devDep+script)、vite.config.js(exclude)、
tools/copy-ocr-assets.mjs、tools/verify-ocr-assets.mjs、.gitignore
