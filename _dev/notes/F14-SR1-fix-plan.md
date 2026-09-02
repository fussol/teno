# F14-SR1 修復計畫書 — cli.mjs `teno doublefire`（cmdDoublefire）預設路徑失效

- 波次：SR2（CLI 域）
- ID：F14-SR1（master + _dev 鏡像同步）
- 作者：SR2 首相
- 日期：2026-08-30

## 1. Bug 定義

F14 主修把 monitor log 從 `/tmp/teno-monitor.log` 搬到 `app_log_dir()`（Tauri）。CLI 兩鏡像 `cmdDoublefire`（偵測 double-fire rate）讀 monitor log 的**預設路徑仍是硬編碼 `/tmp/teno-monitor.log`** → GUI 寫的 log 在 app_log_dir，CLI 預設讀 /tmp 找不到（可傳參 `args[0]` 覆蓋非斷路，但預設失效）。

- `tools/cli.mjs:1477`（實錘）
- `_dev/cli/cli.mjs:1292`（實錘）

```js
function cmdDoublefire() {
  const path = args[0] || '/tmp/teno-monitor.log';
```

## 2. Root cause 與 app_log_dir 實錘（v2 修正路徑）

F14 主修改變日誌落點（Rust `log_msg`→`open_monitor_log(&app_log_dir())`），但 CLI 鏡像預設未同步，仍指 `/tmp`。

**app_log_dir 真實解析（v1 誤判 .local/state 已引證修正）**：Tauri v2 `app_log_dir()`（非 macOS）＝`dirs::data_local_dir().join(identifier).join("logs")`（Cargo.lock 鎖定 tauri-2.11.3 `src/path/desktop.rs:278`）；`dirs` `data_local_dir()`＝`$XDG_DATA_HOME`，預設 **`~/.local/share`**（dirs-6.0.0 `src/lin.rs:12`）。bundle identifier=`com.teno.app`（tauri.conf.json）。

**本機實錘（v2）**：`~/.local/share/com.teno.app/logs/teno-monitor.log` **存在**（129038 B、mode 600＝F14 守門特徵、8/30 02:35 寫入、150 筆 `[rate]` 行＝cmdDoublefire 解析格式）；`~/.local/state/...` 不存在。CLI 兩鏡像均有 `const HOME = process.env.HOME || ''`。

## 3. 修法（v2，兩鏡像同款）

`cmdDoublefire` 預設路徑自 `/tmp/teno-monitor.log` 改為 app_log_dir 實路徑：

```js
function cmdDoublefire() {
  const path = args[0] || `${HOME}/.local/share/com.teno.app/logs/teno-monitor.log`;
```

- `${HOME}` 使用既有常量（tools:15／_dev:11）。可傳參覆蓋不變。

## 4. 驗證

- **tools/verify-f14-monitor-log.mjs Rust 側 T0-T4 回歸（38/38）**。
- **T-CLI section（v2 marker=.local/share）**：掃描兩鏡像 cmdDoublefire 段，斷言預設含 `.local/share/com.teno.app/logs/teno-monitor.log`、段內零 `/tmp/teno-monitor.log` 殘留、`${HOME}/.local/share` 展開在場；NC 牙注入 bug 版必被抓。
- 回歸：`node --check` 兩鏡像；`npx vite build`。

## 5. 風險

- 低。單一路徑字串（v2 修正為 share）。`path` 仍可能不存在 → readFileSync catch「無此 log」（保守同舊）。
- **XDG_DATA_HOME 漂移（知情）**：設了 XDG_DATA_HOME 的機器 GUI 落點漂移；沿用 `${HOME}` 硬編碼與 CLI 既有 DB 預設（`${HOME}/.config`）同慣例，可接受，已成文。
- **macOS 落點不同**（`~/Library/Logs/com.teno.app`）：CLI 為本庫 Linux 開發工具，與既有慣例一致，不阻擋，一行知悉。

## 6. 範圍外（憲法⑥→追蹤）

- `cmdReport` 預設 `${HOME}/桌面/log/...`（tools:2746）不同語義（user 本地 day-*.log），非 F14 影響，不修。
- Rust `lib.rs` 不碰（主修已完）。
- XDG_DATA_HOME / macOS 落點支援：見 §5 知情，另 bug 追蹤。
- 命名正名：dispatch `logs: cmdLogs`（讀 app-log.db）與 `doublefire: cmdDoublefire` 兩命令，本 SR 指後者（`teno doublefire [log]`）。

## 7. 版本

合入後 `./tools/version.sh patch`（合入當下現值 +0.0.1）。三指紋 staged 齊全。`scope-requests.md` 絕不 add。

## 8. 審查歷程
- v1（2026-08-30）：送審 1 席。❌ — 路徑誤判 `~/.local/state`（正確=`~/.local/share`，Tauri app_log_dir 實證鏈＋本機 log 檔 129KB/600/150[rate] 在場）；若照修同 bug 換錯誤地址續命且 verify 護送錯路徑過綠。v1 PRE self-check 43 PASS/6 FAIL（Rust 38 綠、兩鏡像 6 紅、NC 3 牙）。
- v2（2026-08-30）：採納委員引證——修法路徑全改 `${HOME}/.local/share/...`，verify marker→`.local/share`、HOME regex→`/.local/share/`；§1/2/3 內文 `state/XDG_STATE_HOME` 全誤→`share/XDG_DATA_HOME`＋實錘句更正（GUI 已跑 log 在 share）；§5 補 XDG/macOS 知情；§6 補命名正名。待重送。