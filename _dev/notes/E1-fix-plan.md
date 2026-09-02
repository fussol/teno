# E1 修復計畫書 — dev CLI 指向舊版（_dev/cli）

> 狀態：**定案**｜審查：5 委員 × 1 輪（5/5 ✅）
> 範圍：僅 E1 專案（lib.rs 3 處）；_dev/cli 死碼保留不刪（run-50days.sh 依賴）

---

## 1. Bug 定義

**症狀**：app dev 模式（模擬器診斷/報表按鈕）執行的 CLI 是舊版 `_dev/cli/cli.mjs`。

**Root cause**：`resolve_cli_path`（lib.rs:97-112）優先序 TENO_CLI env → bundled resources（**死路**，tauri.conf.json 未 bundle cli）→ /usr/lib/teno（**死路**，PKGBUILD 未裝）→ **dev fallback `$HOME/teno/_dev/cli/cli.mjs`（:109）→ 唯一有效路徑 = 舊版**。
- `tools/cli.mjs`（正式版，3571 行，活躍到 426843b）vs `_dev/cli/cli.mjs`（舊快照 3530 行，凍結 e7021d2）
- 實質差異：optimize 用官方 fsrs-rs 6.6.1（tools）vs 自寫 JS optimizer 三模式共用權重（_dev，違反官方政策）；audit 重算 dayCutoff-aware（tools）vs 舊版

## 2. 修復方案（lib.rs 3 處）

| 行 | 現況 | 改為 |
|---|---|---|
| :96 | `/// 4. dev repo fallback: $HOME/teno/_dev/cli/cli.mjs` | `/// 4. dev repo fallback: $HOME/teno/tools/cli.mjs` |
| :109 | `.join("teno").join("_dev").join("cli").join("cli.mjs")` | `.join("teno").join("tools").join("cli.mjs")` |
| :129 | `"CLI 工具不存在（開發者模式需 _dev/cli/cli.mjs，或設 TENO_CLI 環境變數）"` | `"CLI 工具不存在（開發者模式需 tools/cli.mjs，或設 TENO_CLI 環境變數）"` |

- tools/cli.mjs 相對依賴自足（`../src/` import、`./fsrs-optimize.py`、`.venv-fsrs/` 皆存在）
- `_dev/cli/cli.mjs` 改後無 code 引用（死碼）；run-50days.sh 依賴相對 `node cli.mjs` → **保留 _dev/cli 不刪**（或日後連腳本一起處理）

## 3. 審查歷程（第 1 輪 5/5 ✅）

| 委員 | 視角 | 裁決 | 關鍵 |
|---|---|---|---|
| #1 | 技術 | ✅ | 核心 :109 + 同步 :96/:129（3 處非 1 行）；bundled 死路實錘 |
| #2 | 整合 | ✅ | tools 是正式版（git 歷史/文檔/偏好）；方案 B 正確、A 不可行 |
| #3 | 實測 | ✅ | tools/cli.mjs 可執行、輸出一致、optimize 走官方；模擬 spawn 路徑過 |
| #4 | 副作用 | ✅ | run_cli 消費端僅 diagnose/report；打包零影響 |
| #5 | 整合 | ✅ | E1 是 E2/E3 前置（app 先跑對的 CLI）；無衝突 |

## 4. 驗證方式

1. **Rust**：cargo check
2. **行為**（#3 已實測）：`TENO_DB=... TENO_NO_BACKUP=1 node ~/teno/tools/cli.mjs dash` 通過（= run_cli spawn 路徑）
3. **對齊**：改後 app dev 模式 diagnose/report 走 tools/cli.mjs（官方 optimize）

## 5. 風險

- **低**：只改路徑字串 3 處；_dev 版斷引用變死碼（保留不刪，無破壞）
- **已知**（範圍外）：release 打包未 bundle cli.mjs → 正式安裝 run_cli 報「不存在」；需另案 bundling
