# PM-SR1 任務書 — 資料層 SR 修復（D5/D20/E16/F16）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。工作目錄 `~/teno`，branch main，基線 HEAD=`12e9978`(v5.7.0)。

## 檔案所有權白名單
- `src/lib/api.js`
- `src/lib/db.js`
- `src/lib/deprecated/sim-behavior.js`（E16 唯一：刪除；刪後若 deprecated/ 空可一併消失）
- `src/pages/export.js`（F16 SSI：死 import 刪除）
- `tools/verify-d5-checkpoint.mjs`、`tools/verify-d20-dual-generations.mjs`、`tools/verify-f16-csv-data.mjs`、`tools/verify-g24-export-render.mjs`（F16 雙向鎖）
- `_dev/notes/`（含你開的審查紀錄 subagent-log/）

**不碰**：`src-tauri/src/lib.rs`（F16 已在 Rust side 殲滅，你只做 JS 側）、`src/lib/store.js`（他軌）、`tools/cli.mjs`（他軌髒檔）、`src-tauri/Cargo.*`。

## Bug 佇列（依序，每顆完整循環：計畫書→審查→動工→驗證→升版→commit→md log）

### 1. D5-SR1 — backupDb 未先 WAL checkpoint → 備份缺最近複習（資料完整性最高優先）
- Bug：`api.js:72 backupDb` 未 checkpoint。Rust `backup_db` 的 fs::copy 無 WAL checkpoint → 備份檔缺 WAL 內最新交易（夜間定時備份每天都少最後一段複習）。
- 修法（已裁示，單點封頂）：`src/lib/api.js` `import { checkpoint } from './db.js'` ＋ `export const backupDb = async () => { await checkpoint(); return invoke('backup_db') }` — 唯一 choke point，涵蓋全 4 呼叫點（backup-scheduler.js:33／settings.js:484/551/928）。
- `checkpoint()` 已存在 db.js:122-126（PRAGMA wal_checkpoint(TRUNCATE)＋catch）。
- 驗證：`tools/verify-d5-checkpoint.mjs`，雙態（未修能抓到缺 checkpoint＝RED；修後 GREEN）。可用 fake invoke 驗證 backupDb 呼叫前必 await checkpoint()。負控制：剝除 await checkpoint 必紅。

### 2. D20-SR1 — deleteWordsByDeck 漏 id 族 → 刪字漏孤兒（真資料丟失）
- Bug：`db.js` deleteWordsByDeck:370 只刪 id 族（`word IN (SELECT id...)`），B4 後新資料（word_id 語意）legacy 文字孤兒留；deleteWord:221-226 只刪 text 族，新資料 id 族孤兒留。雙清理函式各只蓋一族 → 刪字主路徑漏。
- CLI 域已兩族皆刪（tools/cli.mjs cmdDeleteDeck，verify-d20 T1d/T8c 釘），你照同語意在 db.js 補齊。
- 修法評量：兩條 DELETE 各蓋一族，或 JOIN 語意統一（評定哪個最穩，寫進計畫書）。殺legecy文字與新id各族。
- 驗證：`tools/verify-d20-dual-generations.mjs`，雙態。測資兩世代都要（legacy text + new id），D14 舊測資只測 text 故未逮，補 id 族。

### 3. E16-SR1 — deprecated/sim-behavior.js 零引用孤兒（准刪）
- Bug：sim-behavior.js(7.6KB) 唯一 import 者 = 已刪的 deprecated/sim-engine.js:13，全庫零引用（E8 已政策隔離舊 JS 模擬鏈，官方 fsrs-rs simulate_fsrs 為唯一模擬路徑）。
- 修法：刪該檔；deprecated/ 目錄若空一併消失。先 grep 全庫證零引用（grep -rn "sim-behavior"）。
- 驗證：grep 零引用 + 檔案不存在；跑既有 fsrs/sim 相關 harness 回歸。

### 4. F16-SR1 — JS 側死 wrapper exportCsvData（雙向鎖）
- Bug：`api.js:107-108` 死 wrapper `exportCsvData`＋`export.js:8` 死 import（全檔零呼叫，實證見 F16-fix-plan §2）。
- 修法：兩處刪除。**雙向鎖**：同步修訂 `tools/verify-f16-csv-data.mjs` T3b「wrapper 在冊」釘（該釘現 fail-closed 存續期鎖，Tap 落地日不修必紅）。同單清 `tools/verify-g24-export-render.mjs:19` mock stub。
- 驗證：verify-f16-csv-data.mjs 全綠（T3b 更新後）。

## 完成標準
佇列全數有 `fix: D5-SR1 / D20-SR1 / E16-SR1 / F16-SR1` commit（或標註）＋回報五欄摘要。每顆獨立 commit、獨立驗證、獨立 md log。

## 版本
每顆 bug 結案 commit → `./tools/version.sh 5.7.x`（D5 首顆 5.7.1，後續逐顆 +1）。commit 前確認 staged 三檔齊全。共享檔（scope-requests.md）絕不 add。