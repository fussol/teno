# PM-OCR-CAPTURE 計畫書 v1.0（OCR 取圖雙源＋切割＋獨立工具頁）

> 功能開發案（非 bug）。載體：現行 OCR（tools.js 內嵌 block，OCR-plan-v1.3 產出）。
> 需求來源：元首 jun_yteu 逐輪口述收斂（2026-08-29）。
> 治理：本文件為立案文件，依憲法①送審；通過後動工。

---

## 第1章 需求定義（元首拍板收斂）

### 目標
把 OCR 從「工具頁內嵌區塊」升級為**完整獨立工具頁**，並補上**取圖雙源**與**切割**能力，同時把整體 UI 做乾淨。既有整頁 OCR 辨識 pipeline **原封不動**銜接。

### 明確要做
| # | 項目 | 說明 |
|---|---|---|
| 1 | 獨立 OCR 工具頁 | 工具頁把 OCR 區塊改成**入口卡片**，點入跳新頁 `pages/ocr.js`（走現行 `navigate(page)` 動態 import 機制，main.js:68-72） |
| 2 | 取圖雙源 | **原生相機**（`<input type=file capture=environment>`）＋**匯入照片**（`accept=image/*` 無 capture）兩個獨立入口按鈕 |
| 3 | 回顯＋切割 | 拍照/選圖後**先顯示影像**，可拖**矩形切割框**選取要辨識的範圍，再送辨識 |
| 4 | 整頁 pipeline 銜接 | 切割後的 bitmap → 既有 `getActiveEngine().recognize()` → token 白名單 → 候選勾選 → `s.actions.importOcrText` 入庫（黑名單/Cambridge/補欄位全部原封） |
| 5 | UI 整體打磨 | 乾淨的取圖區、影像預覽＋切割框、辨識結果候選清單、入庫結果的排版重做 |

### 明確不做（一時段外）
- ❌ 螢光筆偵測辨識模式（元首另案保留，本立案不實作）
- ❌ 內嵌 viewfinder／動態連拍（元首 2026-08-29 裁示取消「怕負擔」）
- ❌ Google Lens／視覺 model 辨識（無公開 API，已潑冷水）
- ❌ 現行 desktop tools.js 內嵌 OCR 區塊的辨識邏輯重寫（只拆殼、不動 pipeline）

---

## 第2章 現況分析（一手實碼）

### 現行 OCR 掛載點
- **工具頁內嵌**：`src/pages/tools.js` render() :208-232（OCR section HTML）、onMount()/initOcrBlock :1017-1121
- **取圖**：唯一入口 `#ocrCaptureBtn` → `#ocrFileInput.click()`（:1048-1053），`<input accept="image/*" capture="environment">`
- **辨識**：`:1063-1066` `getActiveEngine().recognize(file)`；`:1069-1075` token 白名單 `_OCR_TOKEN_RE` 過濾＋去重保序
- **結果**：`:1082-1087` 候選清單渲染，`:1100-1120` `importOcrText(picked)` 入庫
- **pipeline 入口**：`store.js importOcrText`（:1385）→ 黑名單過濾 → Cambridge 查證 → `importWords`（DB tx）→ 背景 `enrichOcrWords` 補欄位

### router 機制
- `main.js:68-72` `loadPage(name)` 動態 `import('./pages/${name}.js')`
- `main.js:81-86` 頁面標籤表 `PAGE_LABELS`
- 導航：`store.actions.navigate(page)`（設定 `state.currentPage`）→ `renderPage` 動態載入對應 page 模組、呼叫其 `render(s)` + `onMount(s)`

### 切割可行性（實測管道）
- `recognize(file: File)` 收 File → 切割後需轉成 `File` 或 blob/arrayBuffer。
- **做法**：canvas 裁切 `canvas.toBlob()` → `new File([blob], 'crop.png', {type:'image/png'})` → 送 `recognize(cropFile)`。**pipeline 零改動**即可消費切割結果。

---

## 第3章 檔案修改清單（窮舉）

### 新增
| # | 檔案 | 內容 |
|---|---|---|
| 1 | `src/pages/ocr.js`（新） | 獨立 OCR 工具頁：`render(s)` 回傳頁面 HTML（取圖雙源＋預覽切割＋候選清單），`onMount(s)` 綁定事件＋核心邏輯 |

### 修改
| # | 檔案 | 修改點 |
|---|---|---|
| 2 | `src/pages/tools.js` | :208-232 OCR section **砍掉辨識 block**，改成一張「進入 OCR 工具」入口卡片（比照 `toolsGoSimulator` :43-52 風格）；把 `initOcrBlock`(:1017-1121) 遷移到新頁 or 標記移除；保留 OCR 引擎選單設定（若有）改放新頁 |
| 3 | `src/main.js` | `PAGE_NAMES`（:79-86）加 `ocr: 'OCR 工具'`（不進 sidebar/bottom nav，純內部導向頁，類似 app-log 非主 nav） |
| 4 | `src/lib/store.js` | 確認 `navigate` 對未知 page 不炸；profile 檢查頁面是否需註冊白名單（**視實碼而定，若無白名單則不動**） |
| 5 | `src/lib/ocr/engine.js` | 無改動（`recognize(file)` 簽名已相容，切割後產 File 即可） |

> **檔案所有權檢查**：tools.js 屬首相 B（pages/exam-*、cli.mjs…）領域外；store.js 屬首相 A（唯一屬主）——本案動 store.js 前需確認是否真的需要改。若 navigate 已通用（無白名單），則 store.js **不動**，避免跨屬主爭議。
> main.js 屬首相 C（Android/TTS）領域——本案僅加一行 PAGE_LABELS 標籤，低風險，於 plan 明列待總統裁示歸屬。

---

## 第4章 切割實作設計

### 互動流程
```
取圖來源選取
  ├─ 原生相機 → capture input → file
  └─ 匯入照片 → accept input → file
        │
        ▼
  影像預覽（<img> / canvas 依比例縮放顯示）
        │
        ▼
  拖曳矩形切割框（mousedown → mousemove → mouseup 選取）
        │  按顯示比例映射回原圖座標
        ▼
  「確認切割並辨識」→ canvas.drawImage(crop region) → toBlob → new File
        │
        ▼
  recognize(cropFile) → token 過濾 → 候選勾選 → importOcrText 入庫
```

### 關鍵細節
- 切割框：CSS 絕對定位 overlay（`position:absolute; border:2px accent; background:rgba(accent,0.15)`），綁 pointer events。
- 座標映射：顯示尺寸→原圖尺寸的比例倍率，避免 on-screen 座標直接用。
- 保持比例：`object-fit:contain` 讓整個圖可見，切割區貼合顯示框。
- 重新選取：切割完想重畫，提供「清除選取」按鈕。
- 載入階段顯示 spinner（既有 `ocrLoading` 樣式沿用）。

---

## 第5章 驗證計畫（內測門四層）

### L1 語法與建置 ✅ 2026-08-29
```
node --check src/pages/ocr.js / tools.js / main.js   # 全 OK
npm run build                                        # 725ms 綠，產出 dist/assets/ocr-*.js
```

### L2 harness ✅ 2026-08-29 — `_dev/notes/verify-ocr-capture.mjs` 7/7 PASS
T1 比例映射（顯示 400×800→原 2000×4000）、T2 1:1、T3 越界 clamp、T4 除零負控、T5 原圖 0 負控、T6 切割區塊寬高映射正確

### L3 瀏覽器實跑 ✅ 2026-08-29（dev server）
- 工具頁→入口卡→跳獨立頁 navigate('ocr') 正常
- 雙源 input 差異正確（camera capture=environment / import 無 capture）
- **切割 bug 修復**：`runFile` 原先 loadFile（內 layoutImage 量 rect）才 _showStage → stage 隱藏時 rect=0 → dispW/H=0 → 切割尺寸 NaN。修法：先 _showStage() 再 loadFile。整頁 reload 後切割 overlay 200×100 正確、映射回原圖 250×124 px 正確
- 切割→toBlob→new File→engine.recognize() 完整跑通（tesseract 認出候選）
- 候選清單渲染、DOM 21 元素全綁定、console 零 error

### L3 範圍限制（非本案 bug，登為待真機驗證）
- dev browser 無 Tauri invoke：`s.actions.importOcrText` 的 Cambridge 查證（store.js:1406 `lookupCambridge` on ocrCambridgeVerify=true）會懸掛 wait。正式 Tauri 環境有 real `lookup_cambridge` invoke 不會 hang。OCR 頁整合本身正確（僅呼叫 importOcrText）。
- 列入「真機/桌面終驗」項，不等於本案失敗。

### L4 證據落盤
- 記錄於本 plan（2026-08-29 總統直修實測）

### 負控制
- 未選圖直接點「確認切割」→ cropToFile 走全圖（_crop null），無 crash
- 切割小於 2px → toast 擋下（code :272-275）
- 全黑/無文字 → token 過濾後無候選 → 顯示「未偵測到有效單字」

---

## 第6章 風險與範圍外

### 風險
1. **切割座標偏差**（devicePixelRatio / 顯示縮放）→ 用 canvas 顯示＋統一 mapping 函式，harness 實測映射正確性。
2. **store.js / main.js 跨屬主** → plan 明列，動工前總統裁示歸屬或流程豁免。

### 範圍外（自動進追蹤，憲法⑥）
- 螢光筆辨識模式（元首另案）
- 動態連拍／內嵌 viewfinder
- Google Lens／視覺 model
- 辨識結果手動校正（改字/加字）編輯器（現行僅勾選，維持）

---

## 第7章 分期與驗收
- **P1（本案）**：獨立 OCR 頁 ＋ 取圖雙源 ＋ 切割 ＋ pipeline 銜接 ＋ UI 打磨。驗收＝瀏覽器實跑可從拍照/選圖→切割→辨識→入庫全鏈路，console 零 error。
- **P2（另案）**：螢光筆辨識模式。

---

## 附錄：動工前待總統裁示（歸屬）— 元首 2026-08-29 拍板定案

1. **store.js**：navigate 無 page 白名單（實碼 :1133 通用）→ **零改動**，不碰首相 A 獨屬檔。✅
2. **main.js PAGE_NAMES**：加一行標籤 → **總統直修**（元首裁示），不委派。✅
3. **tools.js**：非首相 B 明列屬主 → **總統直修**（元首裁示）。✅
4. **OCR 特例**：僅 OCR 拆獨立頁，其餘 tool 留原地 → 走「特例跳轉」，不建通用子頁架構（元首裁示）。✅