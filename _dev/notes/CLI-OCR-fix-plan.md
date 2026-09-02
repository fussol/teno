# CLI-OCR 計畫書 v1.0（CLI 加 ocr 指令：圖片→辨識→入庫）

> 功能開發案。需求：元首 2026-08-29 指示「CLI 可以做到跟 GUI 一樣的事」，具體落點＝GUI 的 OCR 工具頁（取圖→辨識→黑名單→Cambridge→入庫）在 CLI 要有對應能力。
> 現況：GUI OCR 用 Tauri invoke 走 db 入庫；CLI（tools/cli.mjs）已有 fetch 直連 cambridge（不走 invoke）、dbw 寫入、backupDb、audit。本例補 CLI `ocr` 指令。

## 第1章 需求
`cli.mjs ocr <圖片路徑> [--deck 名] [--no-verify]`
1. tesseract.js（Node 離線）辨識圖片
2. token 白名單過濾（與 GUI tools.js:9 `_OCR_TOKEN_RE` 同正則）
3. 黑名單過濾（import ocr-blacklist.js DEFAULT_BLACKLIST ∪ db settings.blacklist）
4. Cambridge 查證（默認開；fetch 直連，不走 Tauri invoke——避免 dev-web 卡死問題；`--no-verify` 關）
5. 入庫（backupDb → INSERT words → audit → log）

## 第2章 檔案修改
| 檔 | 修改 |
|---|---|
| tools/cli.mjs | 新增 `cmdOcr`、`cambridgeVerify`；handlers 掛 `ocr`；help 加一行 |

## 第3章 驗證（已實跑 ✅ 2026-08-29）
| 測項 | 結果 |
|---|---|
| 辨識測試圖 7 字 | ✅ hello/world/apple/banana/cat/dog/river |
| 黑名單擋 5 | ✅ apple/banana/cat/dog/river（草漯 PDF 詞，與 GUI 一致） |
| 入庫 2 | ✅ hello/world，OCR Inbox |
| 完整 verify 模式 6 字 | ✅ 辨識 6→黑名單擋 music/moon→Cambridge 查到 story/bridge/valley/desk→入庫 4 |
| backup + audit + log | ✅ 全寫 |

## 第4章 範圍外
- 不實作 GUI 的切割/雙源（那是瀏覽器互動，CLI 無 DOM）；CLI 收整張圖或預切好的圖檔
- 背景補欄位（enrichOcrWords）— CLI 後續可加，本例專注入庫