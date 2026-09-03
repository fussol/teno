# Teno

Teno 是一個以繁體中文介面打造、離線優先的英文單字學習工具。它使用 FSRS 間隔重複排程，支援字本、拼字與選擇題測驗、OCR 匯入、離線桌面 TTS，以及 Android 與桌面版。

## 功能

- FSRS 6.6.1 排程與 Anki 相容的複習流程
- 字本、標籤、單字瀏覽、CSV/Anki TSV 匯入與匯出
- 翻卡、選擇題、拼字測驗與學習統計
- OCR 圖片匯入：全掃描、局部切割、連拍累積、候選篩選與黑灰名單覆寫
- Desktop Piper TTS，以及 Android 原生 TTS
- SQLite 本機資料庫，不使用 localStorage 作為資料來源

## 開發

需求：Node.js、npm、Rust stable 與各目標平台的 Tauri 前置依賴。

```bash
npm install
npm run dev
```

建立前端發行輸出：

```bash
npm run build
```

啟動 Tauri：

```bash
npm run tauri dev
```

OCR 離線資產首次需要建立：

```bash
npm run ocr:assets
```

## 驗證

`tools/` 內含各功能的獨立驗證腳本，例如：

```bash
node tools/verify-tile-scan.mjs
node tools/verify-crop-flow.mjs
node tools/verify-vision-v2.mjs
```

## 專案結構

- `src/`：Vite 前端與學習引擎
- `src-tauri/`：Rust/Tauri 原生層、Android 專案與桌面資源
- `public/`：會隨前端發行的靜態資產
- `tools/`：建置、維護與驗證工具
- `_dev/`：設計、封裝、決策與開發紀錄，不會打包進 App

完整的打包邊界與本機資料規則請見 [`_dev/WORKSPACE.md`](_dev/WORKSPACE.md)。

## 授權

詳見 [LICENSE](LICENSE) 與 [DISCLAIMER.md](DISCLAIMER.md)。
