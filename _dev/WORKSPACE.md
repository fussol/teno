# Teno 開發工作區

## App 打包邊界

Tauri 發行時只會使用下列輸入：

- 前端：`src/`、`public/`，由 Vite 建成 `dist/`
- 原生端：`src-tauri/`；其中 `tauri.conf.json` 明列 `resources/piper/*` 為桌面版隨附資源

`_dev/` 與 `tools/` 都是開發、驗證與維護資料，不會進入 Vite 的 `dist/` 或 Tauri bundle。

## 本機、不入版控的資料

`_local/` 是所有本機產物的唯一位置，已由 Git 忽略：

| 路徑 | 用途 | 是否打包 |
| --- | --- | --- |
| `_local/artifacts/android/` | 已簽名 APK 與簽名資訊 | 否 |
| `_local/artifacts/arch/` | Arch 套件與舊版 tarball | 否 |
| `_local/legacy/` | 舊版桌面散件 | 否 |
| `_local/ocr-cache/` | OCR 下載/測試殘留原始資料 | 否 |
| `_local/keys/` | 僅本機使用的發行金鑰 | 否 |

不要將使用者資料庫搬入 `_local/`：根目錄的 `teno-backup*.db`、`phone-db.db` 是 H1 維護紀錄所引用的實體，仍受 `.gitignore` 保護且必須保留原位。

## 必須保留在打包輸入的位置的資產

- `public/assets/ocr/`：OCR Web Worker、WASM 與語言資料。它們是離線 OCR 的正式功能資產。
- `src-tauri/resources/piper/`：桌面版 Piper TTS 的正式 bundle resource；Android build script 會在建置時排除它。

## 開發資料位置

- `_dev/build/`：桌面封裝流程與文件
- `_dev/cli/`：維護 CLI 與文件
- `_dev/notes/`：決策、檢查點、驗證紀錄與歷史計畫
- `tools/`：可直接執行的驗證器與建置輔助工具
