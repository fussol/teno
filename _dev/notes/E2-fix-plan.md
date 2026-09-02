# E2 — datetime('now') 改 ISO 帶 Z（v3.2 — 定案 ✅）

狀態：**第 5 輪 3/3 ✅ 通過 — 定案可實作（2026-08）**
關聯：v3 定案 ✅（與 B4 合併，commit 拆開）

## ⚠️ 實作精度要求（第 5 輪委員附，必須遵守）

1. **saveWord ON CONFLICT 不加 created_at**：db.js:112-119 的 `ON CONFLICT(id) DO UPDATE SET` 清單**保持不動**，只在 INSERT 欄位串加 created_at/VALUES/參數 — 否則編輯/改標籤會重置 created_at → dashboard 每日新增圖灌水
2. **createdAt 讀側統一在 db.js:99**：`createdAt: normalizeUtcTimestamp(r.created_at)`（與 :400 同款 helper）— 一處修好 dashboard.js:516＋filterEngine.js:191-192（deck-browser「依加入時間排序」）兩個消費點；dashboard.js:516 的 normTs 改法可省
3. **sort key 保留 `|| ''`**：cli.mjs:1469/:1589 改 `normTs(e.reviewed_at) || ''`（review_log.reviewed_at 無 NOT NULL，normTs(null) 回 null → null.localeCompare TypeError）
4. **cli.mjs:135 localDue 讀側**：`toLocalDateStr(new Date(normTs(due)), ANKI.timezoneOffset, ANKI.dayCutoff)`（normTs 對 ISO 原樣返回零成本）
5. **db-compare :1638-1639 MIN/MAX**：校正後全 ISO 無虞，補註即可

## Bug 定義

CLI `fix` 子命令 4 處用 SQLite `datetime('now')` 寫 due，格式 `YYYY-MM-DD HH:MM:SS`（無 T 無 Z），而 app 端（store.js:534/617 等）一律 `new Date().toISOString()`（`YYYY-MM-DDTHH:MM:SS.sssZ`）。

JS `new Date('2026-08-11 05:30:00')` 會把**無時區標記的字串當 local time**（tzOffset=480 → UTC+8），CLI 寫的 UTC 時間被誤當 local → due 偏移 8 小時；且 `localDue()`/`today()` 解析不一致，會造成卡出現在「未來」或「已過期但顯示未到期」。

## Root Cause

CLI 直接用 SQL 的 `datetime('now')`，沒跟 app 的 ISO 8601 帶 Z 格式對齊。SQLite 的 datetime() 回 UTC 但格式是 local-naive。

## v3.2 修正方案（吸收第 1/2/3/4 輪委員盲點）

### 1. tools/cli.mjs 7 處改 ISO 帶 Z（v3.2：補 add/import-csv 的 words INSERT 🔴）

| 位置 | 現況 | 改法 |
|---|---|---|
| :1327 reset-card | `due=datetime('now')` | `due=new Date().toISOString()` |
| :1331 graduate | `due=datetime('now','+1 day')` | `due=new Date(Date.now()+86400000).toISOString()` |
| :1335 rewind | `due=datetime('now')` | `due=new Date().toISOString()` |
| :1352 reset-stray | `due=datetime('now')` | `due=new Date().toISOString()` |
| :1069 exam_history | `examined_at=datetime('now')`（INSERT 值） | 4 placeholders，傳 `new Date().toISOString()` |
| **:403-408 cmdAdd**（v3.2 新增 🔴） | words INSERT 16 欄漏 created_at → DEFAULT naive | 欄位串加 created_at，16→17 欄，VALUES 補 `?`，run() 補 `new Date().toISOString()` |
| **:1146-1150 cmdImportCsv**（v3.2 新增 🔴） | 同上 | 同上 |

（⚠️ 正文一律寫 `86400000`，無遮罩。CLI 的 words INSERT 是「活碼」— add/import 會持續生產 naive created_at，跟 db.js:110 同 class。）

### 2. src/lib/db.js 4 個 app 寫入點

**root cause 主體：DEFAULT naive 不是休眠，db.js 每次複習/測驗/新增單字都觸發**：

| 位置 | 現況 | 改法 |
|---|---|---|
| :379-382 addReviewLog | INSERT 漏 reviewed_at → DEFAULT naive | 加 reviewed_at 欄位，值 `entry.reviewedAt ?? new Date().toISOString()`（唯一 caller store.js:682 不傳 → fallback） |
| :458-463 addExamEntry | INSERT 漏 examined_at → DEFAULT naive | 加 examined_at（`entry.examinedAt ?? new Date().toISOString()`） |
| :519 last_used | `last_used = datetime("now")` | `new Date().toISOString()` |
| :110 saveWord | INSERT 16 欄不含 created_at → DEFAULT naive | 加 created_at，16→17 placeholders，值 `word.createdAt ?? new Date().toISOString()` |

**⚠️ placeholders 對齊**：saveWord 17、addReviewLog 11、addExamEntry 4。

store.js:1588 recordExam 呼叫處傳 `examinedAt: now`（:1584 已算好 ISO）。

### 3. _dev/cli/cli.mjs — 100% 死碼不動

**實碼驗證（v3.1 更正）**：`_dev/cli/cli.mjs` **無 timebox 命令**（grep=0）→ run-50days.sh:58 呼叫 `node cli.mjs timebox` 第一天就「未知命令」→ **副本 100% 死碼**。datetime('now') 計 5 處（fix 4＋exam_run :1061），均無觸發路徑。

- **不動副本**，加檔頭死碼註記即可

### 4. 一次性校正（四表，全必跑）

```sql
-- cards.due
UPDATE cards SET due = substr(replace(due,' ','T'),1,19) || '.000Z'
WHERE due NOT LIKE '%Z' AND due LIKE '____-__-__ __:__:__';
-- exam_history.examined_at
UPDATE exam_history SET examined_at = substr(replace(examined_at,' ','T'),1,19) || '.000Z'
WHERE examined_at NOT LIKE '%Z' AND examined_at LIKE '____-__-__ __:__:__';
-- review_log.reviewed_at
UPDATE review_log SET reviewed_at = substr(replace(reviewed_at,' ','T'),1,19) || '.000Z'
WHERE reviewed_at NOT LIKE '%Z' AND reviewed_at LIKE '____-__-__ __:__:__';
-- words.created_at
UPDATE words SET created_at = substr(replace(created_at,' ','T'),1,19) || '.000Z'
WHERE created_at NOT LIKE '%Z' AND created_at LIKE '____-__-__ __:__:__';
```

- 精確命中 `YYYY-MM-DD HH:MM:SS`（19 字元無 Z）→ `YYYY-MM-DDTHH:MM:SS.000Z`；帶 Z／帶 T 無 Z／含毫秒／NULL 全不命中（委員實測安全＋冪等）
- **執行步驟（v3.2 補強 — 順序是硬性要求）**：① 關閉 app（UPDATE 需寫鎖）② `echo ${TENO_DB:-~/.config/com.teno.app/teno.db}` 確認實際 DB 路徑（CLI 尊重 TENO_DB 覆寫，backup 與 UPDATE 必須同一檔）③ backup（`sqlite3 <db> ".backup '<path>/teno.db.e2-bak'"` — WAL 安全）④ 跑四條 UPDATE ⑤ 驗證四表 count = 0 ⑥ **count=0 驗證通過前，不得啟動新版 app**（v3.2：新 boundary 對未校正 naive 資料會漏算當日記錄 → newPerDay 反轉低估）

### 5. tools/verify-next-after-undo.mjs:34 修正

`c.due <= datetime('now')` → `c.due <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`（ISO 對 ISO，字典序正確）

### 6. CLI/app 讀側正規化（6 處：CLI 5＋dashboard 1）

**正規化 helper（勿複用 db.js:413 — 其 regex 只認秒精度，漏毫秒）**：

```js
const normTs = x => x == null ? x : (/Z$|[+-]\d{2}:\d{2}$/.test(String(x)) ? String(x) : String(x).replace(' ','T') + 'Z');
```

| 位置 | 現況 | 改法 |
|---|---|---|
| cli.mjs:221 cmdDash | `new Date(e.reviewed_at).getHours()` | `new Date(normTs(e.reviewed_at)).getHours()` |
| cli.mjs:277 cmdDash | `new Date(e.reviewed_at).getTime()` | `new Date(normTs(e.reviewed_at)).getTime()` |
| cli.mjs:1592 cmdAudit | `new Date(String(e.reviewed_at).replace(' ','T'))` | `new Date(normTs(e.reviewed_at))` |
| cli.mjs:1589 cmdAudit sort | raw localeCompare | sort key 改 `normTs(e.reviewed_at)` |
| cli.mjs:1469 cmdFsrsReport sort | raw localeCompare（同 :1589 同款） | sort key 改 `normTs(e.reviewed_at)` |
| dashboard.js:516 | `localDateStr(new Date(w.createdAt))` | 用 normTs 後再 parse |

### 7. src/lib/db.js:426-429 getNewRatedToday boundary

`boundaryUtc = ...toISOString().slice(0, 19).replace('T', ' ')`（naive 空格格式）→ 校正後 ISO reviewed_at `'T'`(0x54) > `' '`(0x20) → boundary 當天 UTC 日期內所有記錄被計入 → **newPerDay 灌水**。

改 `.toISOString()`（**完整 24 字元含 Z** — v3.2 修正：slice(0,23) 會丟 Z，雖功能等價但文字誤導）

⚠️ **反向風險（v3.2）**：新 ISO boundary 對「未校正的 naive 資料」會漏算當日記錄（newPerDay 低估）— 執行順序 §4⑥ 已強制校正先於部署。

### 8. lib.rs DEFAULT 硬化（5 個：v3.2 補 edits.updated_at 🟡）

```sql
-- :1449 words.created_at
-- :1454 cards.due
-- :1492 edits.updated_at（v3.2 併入：cli.mjs:2876 cmdEdits 有 new Date() 消費者 — 表恆空但論述要誠實）
-- :1503 review_log.reviewed_at
-- :1511 exam_history.examined_at
-- 統一改：DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
-- 其餘 2 個（:1486 additions.added_at、:1566 filtered_decks.created_at）無 new Date() 消費者，可留
```

⚠️ **migration 語意**：CREATE TABLE IF NOT EXISTS 對既有表是 no-op，改 v1 SQL 只影響**全新安裝**；既有 DB 靠一次性校正。真正的防未來 = 修 db.js/cli.mjs 寫入點。

## 使用點窮舉（憲法第 2 條）

| 檔案 | 位置 | 動作 |
|---|---|---|
| tools/cli.mjs | :1327/:1331/:1335/:1352 | fix 4 處 → toISOString |
| tools/cli.mjs | :1069 | exam_history examined_at → ISO |
| tools/cli.mjs | :403-408/:1146-1150 | words INSERT 加 created_at ISO（v3.2） |
| tools/cli.mjs | :221/:277 | cmdDash 讀側 normTs |
| tools/cli.mjs | :1589/:1592 | cmdAudit sort/解析 normTs |
| tools/cli.mjs | :1469 | cmdFsrsReport sort normTs |
| src/lib/db.js | :110 | saveWord 加 created_at ISO |
| src/lib/db.js | :379-382 | addReviewLog 加 reviewed_at ISO |
| src/lib/db.js | :426-429 | getNewRatedToday boundary 改 ISO |
| src/lib/db.js | :458-463 | addExamEntry 加 examined_at ISO |
| src/lib/db.js | :519 | last_used → toISOString |
| src/lib/store.js | :1588 | recordExam 傳 examinedAt: now |
| src/pages/dashboard.js | :516 | createdAt normTs |
| tools/verify-next-after-undo.mjs | :34 | due 比較改 strftime ISO |
| src-tauri/src/lib.rs | :1449/:1454/:1492/:1503/:1511 | DEFAULT 硬化（fresh-install） |
| _dev/cli/cli.mjs | — | **100% 死碼標記不動** |

## 驗證項目

1. grep `datetime(` 全 repo：僅 lib.rs DEFAULT（硬化目標）＋_dev/cli 死碼
2. **grep `INSERT INTO words/review_log/exam_history` 逐一確認欄位含時間戳**（v3.2 新增 — 漏欄位走 DEFAULT 類別 grep datetime( 抓不到）
3. 改後跑 `fix reset-card <id>` / `fix graduate <id>` → DB due = ISO 帶 Z
4. Node 模擬：`new Date('2026-08-11T05:30:00.000Z')` 正確（vs 舊格式偏移 8h）
5. 一次性校正四表：只命中無 Z、不碰帶 Z、冪等（sqlite3 :memory: 實測）
6. verify-next-after-undo.mjs:34 改後：ISO due 同日可被抓出
7. **混合 naive+ISO review_log 上實跑 cmdDash/cmdAudit/cmdFsrsReport**：全部正確
8. **getNewRatedToday boundary 驗證**：校正後 newPerDay 不灌水（校正前不部署）
9. **dashboard 每日新增圖**：00:00-08:00 新增歸當天
10. `node --check` 全部改動檔案
11. CLI 實跑（副本 DB）

## 風險

- 校正只對無 Z 19 字元格式 — app 帶 Z 不命中，安全；四表全跑
- graduate 固定 24h 與 SQLite '+1 day' 等價（UTC 無 DST）
- lib.rs DEFAULT 只影響 fresh install — 既有 DB 靠校正＋寫入點
- db.js/cli.mjs 寫入點是「每次複習/測驗/新增」熱路徑 — 改完即不再產生新 naive
- ms-naive（`2026-08-14 05:30:00.789`）校正不命中（目前無此生產者）— normTs 已涵蓋 CLI/dashboard 讀側；app 端 db.js:413 未涵蓋 ms-naive（風險節明載）
- boundary 順序：校正前部署新版 → newPerDay 低估（§4⑥ 強制順序）

## 審查歷程

- v3 定案：✅（與 B4 合併）
- 第 1 輪（v1）：1✅2❌ — 漏 exam_history:1069＋_dev/cli 副本＋verify 字串比較 → v2
- 第 2 輪（v2）：2✅1❌ — app 端 db.js 3 個寫入點＋cmdDash 讀側＋_dev/cli 死碼 → v3
- 第 3 輪（v3）：1✅2❌ — words.created_at 漏網＋cmdFsrsReport sort＋getNewRatedToday boundary → v3.1
- 第 4 輪（v3.1）：2✅1❌ — **CLI add/import-csv 漏 created_at（同 class 在 CLI 端殘留）＋boundary 執行順序（校正前部署 → newPerDay 低估）＋edits.updated_at 有消費者（:2876）** → v3.2 修正（CLI 2 處 words INSERT＋§4⑥ 順序強制＋edits 併入硬化＋驗證#2 欄位檢查）
- 第 5 輪：送審中
