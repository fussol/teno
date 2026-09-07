# OCR3 優化計畫書 — 本地成功率提升＋切割併入主流程＋全螢幕切割畫面

> 使用者拍板（2026-09-07）：①只做本地優化（不接雲端）②刪 crop.js 獨立頁併入 OCR
> ③全螢幕 overlay 切割畫面 ④全自動條件式前處理 ⑤tile 變自動第二槍。
> 基線：修檢版 main `cff98ae`。改動域：`src/pages/ocr.js`、`src/lib/ocr/*`、
> `src/pages/tools.js`、`src/main.js`、刪 `src/pages/crop.js`。

## 1. 現況實錘（行號 = 動工前）

- 主辨識：`ocr.js:698-826` confBtn 流程：cropToFile → highlight HSV 過濾（:715-725）
  → enhanceSmallText（:728-735，小字 2-3x＋Otsu）→ `engine.recognize(cropFile)`（:738，
  **無 opts，PSM/DPI 全預設**）→ token 白名單 → 離線字典還原 → appendCandidates。
- tile 局部掃描：`ocr.js:831-906` 獨立按鈕 `ocrTileScanBtn`（render :188），3×3 重疊
  25%＋逐片 2x＋跨片投票。**問題：使用者不知道何時該按；主流程失敗就停了。**
- 切割現況：`ocr.js:170-192` 預覽 wrap＋四角 handle（20px，:105 CSS）；
  `cutStartBtn` 在 :628 直接 `navigate('crop')` 跳獨立頁 —— in-page 的
  enterCutting/paintCorners（:606-614）**已成死碼**；preview wrap 本體無 cutting
  綁定（手機可滑是保住了，但代價是切割跳頁、狀態丟失）。
- crop 獨立頁：`src/pages/crop.js` 460 行，多框矩形＋逐塊 2x＋候選三頁籤自帶一套
  （與 ocr.js 三頁籤重複實作）；`tools.js:219-231` 卡片入口＋:274 綁定；
  `main.js:20` SUBPAGE_PARENT 有 'crop'。
- PSM/DPI：全庫零 `setParameters`（grep 實錘無命中）。tesseract-adapter
  `getWorker` 只傳 langs＋路徑；worker 預設 PSM SINGLE_BLOCK(6)、DPI 走圖檔內嵌
  （手機拍照常無 DPI → 落 70dpi 警告區）。
- 前處理缺口（對照官方文件）：無光照不均檢測（一律全域 Otsu，暗邊整塊吃掉）、
  無白邊（緊裁切掉字邊，Tesseract issue 398）、無反白（白底黑字假設）、無去噪、
  無條件分支（乾淨圖也被 Otsu＋放大全套招呼，Multigrid 明確說會變差）。

## 2. 參考（出处記名，用了什麼寫清楚）

1. **Tesseract 官方《Improving the quality of the output》**
   （tesseract-ocr.github.io/tessdoc/ImproveQuality.html）：DPI≥300、內部 Otsu
   在背景不均時次優、緊裁切加白邊（issue 398）、小區域換 PSM、白名單。
   → 本計畫的白邊＋PSM＋DPI＋條件分支直接來源。
2. **Multigrid《OCR Pipelines: The Preprocessing That Decides Your Accuracy》**
   （multigrid.ai/learn/ocr-pipeline）：`looks_uneven` 四象限均值差>40 才用
   adaptive（Gaussian，blockSize 31／C 10），否則全域 Otsu；旋轉只在
   |angle|>0.3° 才做；去噪同樣 gate；`mean_conf` 做路由信號。
   → 本計畫「全自動條件式」架構來源；閾值 40 照抄，手機照片降 35。
3. **tesseract.js 官方 API 文件**（github.com/naptha/tesseract.js docs/api.md、
   examples.md、index.d.ts）：`worker.setParameters({tessedit_pageseg_mode})`、
   PSM 枚舉（3 AUTO／6 SINGLE_BLOCK／11 SPARSE_TEXT）、`user_defined_dpi`、
   高解析圖先 upscale 再 recognize。
   → PSM/DPI 透傳實作來源。
4. **OpenCV《Smart Document Scanning with Live OCR using OpenCV.js》**
   （opencv.org）：幾何先於外觀（先框正再增強對比）、自適應閾值處理陰影、
   高斯模糊去噪在閾值前。→ 切割→透視收斂→增強→辨識的順序依據。
   （透視校正本波不做：四角取包圍矩形維持既有路徑，見範圍外。）
5. **Otsu, N. (1979)** "A threshold selection method from gray-level
   histograms", IEEE TSMC. → 既有 `otsuThreshold` 理論來源（沿用不動）。
6. **MDPI Symmetry 2020** 卷積前處理論文（F1 0.163→0.729）→ 證明前處理是
   主戰場，但 RL 選算法太重，本波只取「依影像選分支」的結論，不引模型。

## 3. 修法設計

### 3.1 新增 `src/lib/ocr/auto-preprocess.js`（純函式＋DOM wrapper，node-safe）

- `toGrayscale(data,w,h)`、`quadrantMeans(gray,w,h)`、
  `looksUneven(gray,w,h,thr=35)`（四象限最大均值差；Multigrid 同構，閾值 40→35）。
- `integralImage`＋`adaptiveThreshold(gray,w,h,block=31,C=10)`（Gaussian 近似用
  box-mean 代，integral 加速；Multigrid 參數照抄）。
- `detectDarkBackground(gray)`（均值<100 → 反白）、`invertGray`、
  `despeckleBinary(bin,w,h)`（3×3 鄰居<2 黑→轉白，單遍）。
- `addWhiteBorder(bin,w,h,pad=12)`（Tesseract issue 398；pad 12px）。
- `selectPsm({hasCrop, mode})`：有框選或 highlight→6；整頁 scan→3；
  稀疏短字（tokens 預檢？不做，主流程固定二選一，保持簡單）。
  放 `tesseract-adapter.js` export（PSM 常數同處）。
- `shouldSecondShot({finalCount, avgConf})`：`finalCount<3` → true
  （avgConf 備用，tesseract conf 灌水嚴重，主判據用字數）。
- `autoPreprocessPixels(img)` 編排：灰階＋min-max 拉伸（沿用 upscale 手法）→
  暗底反白 → 行高估計（復用 `estimateLineHeight` 決定 scale）→
  uneven? adaptive : Otsu → despeckle → 放大（復用雙線性）→ 白邊。
  回 `{img, scale, applied[], note}`。**舊 `enhanceForOcrPixels` 一字不動**
  （既有 harness 14/14 保住）。
- DOM wrapper `autoEnhanceSmallText(file)`：createImageBitmap→canvas→
  autoPreprocessPixels→toBlob→File；`{file:null}` 表不需處理（大字＋均勻＋亮底）。
  呼叫端回退原圖。

### 3.2 tesseract-adapter PSM/DPI 透傳

- `recognize(file, opts={})`：opts.psm（3/6/11）、opts.dpi（預設 300）。
  worker 單例加 `_workerPsm/_workerDpi` 追蹤，變化才 `setParameters`
  （避免每 call 重設）。`available()` 不動。
- `engine.js` typedef 更新 `recognize(file, opts?)` 註解；`_getActiveEngine`
  不動（engine 物件直通，呼叫端傳 opts）。

### 3.3 ocr.js 主流程整合

- confBtn 流程：`enhanceSmallText` → `autoEnhanceSmallText`；
  `engine.recognize(cropFile)` → `engine.recognize(cropFile, {psm, dpi:300})`，
  psm = 有_crop 或 highlight ? 6 : 3。
- tile 頁按鈕刪除（render :188 整顆拔，onMount 831-906 整段拔）；
  改自動第二槍：主流程 `finalTokens.length<3` 時，用**同一 cropFile**
  跑 tileGrid 3×3＋逐片 autoEnhance＋recognize＋crossTileVote，
  結果 `appendCandidates` 疊加；loadEl 顯示「主辨識字太少，自動局部掃描中」。
  小圖（_imgW<900 且無框選）跳過第二槍（tile 無意義）。
- 全螢幕 overlay 切割：`cutStartBtn` 改開 overlay（不再 navigate）。
  overlay DOM（onMount 內建，預設 hidden）：fixed inset-0 z 150、header
  （取消／完成＋尺寸＋zoom ＋/−/重置）、stage（img＋svg＋4 大 handle 36px）、
  footer hint。狀態機沿用 `_corners/_cropMode`，座標除以 `_ovZoom`。
  開啟鎖 `body`＋`#contentArea` overflow，關閉還原。
  in-page cutDone/cutCancel 隱藏（overlay 接管），preview wrap 永不進 cutting。
- 多框：overlay 加「單框／多框」切換？**不做**（範圍外）。crop.js 的多框能力
  以「連拍累積＋自動第二槍」覆蓋 90% 場景；真多框需求後續另開。
- 刪除：`src/pages/crop.js`、`tools.js:219-231` 卡片＋:274 綁定、
  `main.js:20` 的 `'crop'` 映射。ocr.js:628 改 overlay。

### 3.4 UI 細節提升（順手，不另開顆）

- handle 20px→overlay 內 36px＋透明外圈（拇指好抓）；完成鈕顯示即時尺寸；
  zoom 按鈕三段（1x/1.5x/2x）輔助精調；overlay 內圖 `touch-action:none`，
  外層 overlay 可滑說明區（切割互動只鎖圖區，不鎖整頁）。
- 辨識中 loadEl 文案顯示實際分支（`note`＋applied，如「光照不均→局部閾值」），
  使用者看得到自動化在幹嘛。

## 4. 驗證

- 新增 `tools/verify-ocr3-auto.mjs`（純 node import，無 mock 需求）：
  T1 looksUneven（均勻灰→false；半暗圖→true）；T2 adaptive 在半暗圖保住暗側
  文字行（Otsu 對照組在暗側全黑→ adaptive 白像素數>對照）；T3 白邊尺寸
  +12*2；T4 暗底反白（均值 40→反白後 215）；T5 去噪（孤點清除，實線保留）；
  T6 selectPsm（有框→6／整頁→3）；T7 shouldSecondShot（0-2字→true／≥3→false）；
  T8 autoPreprocess 編排（半暗小字圖 applied 含 adaptive＋scale>1）。
  NC1：把 looksUneven 閾值改 ∞（永不 adaptive）→ T2 紅（分支敏感）。
  NC2：selectPsm 恆回 3 → T6 紅。目標 10/10＋2NC。
- 回歸：既有 ocr harness 全跑（小字 14/14、engine、assets、crop 純函式、
  highlightfilter 新期望、ui 已知 16F 掛起不擋——ui 錨的是舊 tools.js 版面，
  本波 tools.js 刪卡片會再多 1-2 紅，計畫書先登記，動工後更新錨點）。
- `node --check` 改動 js 全檔＋`npx vite build`。

## 5. 風險

- adaptive 31 窗在 12MP 大圖上 JS 單線程慢 → 只在 looksUneven=true 才跑，
  且跑在切割後小圖上；主流程另有 600px 級縮圖慣例可借（vision 的 1280）。
- tesseract.js v7 `setParameters` 若改名 → 包 try/catch 回退無參辨識（零炸）。
- overlay z 150 與 modal/toast 關係：toast 200 在上（提示可見）、modal 100
  在下（切割時不會有 modal，實錘無並發）。

## 6. 範圍外

1. 透視校正（四角任意四邊形→homography）：維持包圍矩形裁切。
2. 自動旋轉/OSD：不做（legacy core 未啟）。
3. 多框切割模式：後續另開（見 3.3）。
4. 雲端引擎：本次零改動（拍板）。
5. PDF render：維持「尚未支援」提示。
