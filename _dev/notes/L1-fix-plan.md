# L1 — learnAheadLimit 無 clamp → learning 卡無限循環重複作答（v1.4 — 送審）

狀態：**v1.4 待審查（第 1 輪 ❌：不實陳述/clamp 上限；第 2 輪 ❌：修法 3 誤傷/NaN 期望值/⑦未定案；第 3 輪 ❌：修法 3 `||20` 吃 0 + else 破壞 parseFloat；第 4 輪 ⚠️ 文件層 ✅ 過審條件達成，補 warn/註解/所有權 3 小項）**
關聯：2026-08-15 污染卡分析（teno-backup0815.db）——review_log 異常卡 root cause 之一
負責人：總統 Oliver（新案）

## 一、Bug 定義

1. **現象**：`ankiSettings.learnAheadLimit` 髒值（2000）→ learnAheadSecs=120,000s（33 小時）→ learning/relearning 卡在 session 中被無限提前撈出重複作答 → review_log 灌爆、reps 灌水、stability 崩潰。
2. **真實再現**（app 真實 code session-v4.js + fsrs.js 模擬，`/tmp/teno-verify-fix.mjs` 實跑）：
   - `learnAheadLimit=2000`：learning 卡 l2 被 review **269 次**（無限循環）
   - clamp 後窗外卡不撈（作答數 2）
3. **實錘受害者範圍**：
   - 330 張 = review_log 異常卡（單日≥5 ∪ 60 秒窗連發），flip 59/60
   - **learnAhead 循環的直接受害者 = 8/14 16:12 後 flip learning 卡單日≥5 的 16+ 張**（8/14 前 limit=20 不可能循環；7 月歷史異常卡 301 張屬其他成因）
   - Again 比例實測：合併卡 6850 筆中 rating=0 佔 56.4%

## 二、Root Cause

- `session-v4.js:36`：`this.learnAheadSecs = (learnAheadLimit ?? 20) * 60;` **無 clamp** → 2000 → 33 小時窗。
- `_next()` step3（:164-171）：撈 `c.due <= now + learnAheadSecs*1000` 的所有 learning 卡 → 窗太大把全天卡捲入。
- learning 卡答 Again → `requeueIntraday`（:273-300）放回佇列 due=now+1min → 仍在 33h 窗 → 立刻重撈 → 循環（斷點：答 Good 畢業）。
- 髒值寫入路徑：GUI settings.js:967 與 CLI cli.mjs:906 均無 clamp。

## 三、消費者清單（憲法② — grep learnAheadLimit 全 repo：代碼命中 9 檔 19 筆）

| 檔案:行號 | 角色 | 處理 |
|---|---|---|
| src/lib/store.js:27 | 預設值 | `20, // minutes, Anki default` — 不動 |
| src/engine/session-v4.js:20,36 | **讀取端（修法 1）** | constructor 解構 + `(learnAheadLimit ?? 20) * 60` 無 clamp |
| src/engine/session-utils.js:45 | 傳入 | flip — clamp 涵蓋 |
| src/engine/session-mc-utils.js:45 | 傳入 | mc — clamp 涵蓋 |
| src/engine/session-spell-utils.js:44 | 傳入 | spell — clamp 涵蓋 |
| src/pages/settings.js:108 | UI 顯示 | input max=120 → **同步改 max=20（⑦定案）** |
| src/pages/settings.js:967 | **GUI 寫入端（修法 2）** | `_n('setLearnAheadLimit', 0)` 無 clamp |
| tools/cli.mjs:39,903,906,923,2454 | **CLI 寫入+讀取（修法 3）** | `anki set` parseInt 直接寫 DB 無 clamp |
| _dev/cli/cli.mjs:28,892,895,912,2400 | CLI（deprecated） | 已隔離 — 明示不修（讀取端被修法 1 涵蓋） |
| tools/verify-next-after-undo.mjs:53 | 測試工具 | 固定傳 20，非消費端 — 不動 |

**learnAheadSecs 消費點**（修法 1 一次涵蓋）：_next step3 :165、null 分支 filter :185、isDone :215、pendingIntradayInfo :224、requeueIntraday :286

## 四、修法

### 修法 0 — 共享 clamp helper（憲法⑩替代結構：三處 guard 統一，消除同類 edge）

在 `src/lib/store.js` 匯出：
```js
/** learnAheadLimit clamp：NaN/undefined/null → 20（預設），0 保留（關閉提前），超限夾 [0,20] */
export function clampLearnAhead(v) {
  return Number.isFinite(v) ? Math.min(20, Math.max(0, v)) : 20;
}
```
- 三處 guard（session-v4 / settings / cli）共用同一 helper → 行為一致、0 保留、無誤傷空間

### 修法 1 — session-v4.js:36 讀取 clamp（根本解，涵蓋三 mode + 全部消費點）

```js
// 從: this.learnAheadSecs = (learnAheadLimit ?? 20) * 60;
// 改為（session-v4.js 頂部加 import，與既有 fsrs.js import 同區）:
import { clampLearnAhead } from '../lib/store.js';
this.learnAheadSecs = clampLearnAhead(learnAheadLimit) * 60;
```
- 邊界：-5→0、999→20、20→20、NaN→20、undefined→20、null→20、0→0

### 修法 2 — settings.js:967 GUI 寫入 clamp（+ UI max 同步）

```js
// 從: learnAheadLimit: _n('setLearnAheadLimit', 0),
// 改為: learnAheadLimit: clampLearnAhead(_n('setLearnAheadLimit', 20)),
```
- settings.js:108 input `max="120"` → `max="20"`（⑦定案：UI 與 clamp 上限對齊）
- 副作用註明：fallback 0→20 是修正（與 UI ?? 20、store 預設、session 一致；原本 input 空值會悄悄寫 0 = 關閉 ahead）

### 修法 3 — cli.mjs CLI 寫入 clamp（**保留原三分支結構，只包 learnAheadLimit**）

```js
// 現況 tools/cli.mjs:905-908 三分支：
//   :906 parseInt 分支（maxIvl/cardsPerDay/leechThreshold/reviewMix/timezoneOffset/learnAheadLimit）
//   :907 parseFloat 分支（lapseMult/desiredRetention）
//   :908 isNaN 檢查
// 改為（只動 :906 內 learnAheadLimit 的取值，不碰 :907/:908）：
if (['maxIvl','cardsPerDay','leechThreshold','reviewMix','timezoneOffset','learnAheadLimit'].includes(key)) {
  if (key === 'learnAheadLimit') {
    const p = parseInt(value);
    if (Number.isNaN(p)) {
      console.warn(`learnAheadLimit 非數值「${value}」，已自動設為 20`);   // ⑦定案：CLI warn 做
      nv = 20;
    } else {
      nv = clampLearnAhead(p);   // 0 保留、-5→0、999→20
    }
  } else {
    nv = parseInt(value);
  }
} else if (['lapseMult','desiredRetention'].includes(key)) {
  nv = parseFloat(value);
}
```
- `Number.isNaN(p)` 檢查取代 `|| 20`（0 是合法值不該被吃掉 — 第 3 輪委員實錘）
- :908 isNaN 檢查對 learnAheadLimit 分支成 dead code（無害，其他欄位仍生效）
- `_dev/cli/cli.mjs:895` deprecated 分支不修（已隔離）

### 修法 4 — 既有髒值校正 SQL（不自動跑，等使用者確認）

- **事實**：現役 DB（`~/.config/com.teno.app/teno.db`）flip learnAheadLimit **仍是 2000**（委員實測；mc/spell=20）
- 校正 SQL（settings 表 JSON 內嵌欄位，三 key 全處理；json_valid guard）：
```sql
-- 執行前先備份 DB；teno.db 為 SQLite（app_config_dir），TENOC 容器需先解包
UPDATE settings SET value = json_set(value, '$.learnAheadLimit', 20)
WHERE key IN ('ankiSettings','ankiSettingsMc','ankiSettingsSpell')
  AND json_valid(value)
  AND json_extract(value, '$.learnAheadLimit') > 20;
```
- 驗證：測試 DB 實跑後 `SELECT json_extract(value,'$.learnAheadLimit') FROM settings WHERE key='ankiSettings'` → 20
- 註：`json_type` 邊角（字串型態）現役 DB 為 integer 不觸發；如需更嚴可加 `AND json_type(value,'$.learnAheadLimit')='integer'`

## 五、驗證（✅ 附實測證據；「已實跑」= 送審前已執行，「動工後」= 修法落地後必跑）

**送審已實跑（1/2/3 輪委員獨立覆跑確認）：**
1. ✅ 再現：`/tmp/teno-verify-fix.mjs` — 2000 → l2 卡 269 次循環
2. ✅ 修後重跑（參數模擬）：clamp 20 → 窗外卡不撈（作答數 2）
3. ✅ 窗內卡回歸：`/tmp/teno-stress-inside-window.mjs` — 窗內卡在 2000/120/20 都持續重撈（150 上限截斷、未自然結束；l1:75 l2:72）；clamp 0 只答 1 次自然結束。**結論：窗內失敗卡重撈 = Anki 設計行為（類比非實測對照）；0=關閉提前最安全**
4. ✅ node --check 三檔現況通過（動工後重跑）
5. ✅ vite build 現況通過（動工後重跑）
6. ✅ 修法 3 條件式不誤傷實測：maxIvl 365→365、cardsPerDay 100→100、timezoneOffset -300→-300、leechThreshold 8→8（第 3 輪委員副本實跑）
7. ✅ 校正 SQL 全邊角：2000→20、999→20、20/0 不動、NULL 不動、畸形 JSON 不炸（第 3 輪委員實跑）

**動工後必跑（對照表，☐ 逐項勾選）：**
| ☐ | 驗證項 | 預期 |
|---|---|---|
| ☐ | 動工前 git status：僅含 L1 相關檔案（chart.js/base.css 分離） | — |
| ☐ | `new Session({learnAheadLimit:-5})` | learnAheadSecs=0 |
| ☐ | `new Session({learnAheadLimit:999})` | learnAheadSecs=1200 |
| ☐ | `new Session({learnAheadLimit:20})` | learnAheadSecs=1200 |
| ☐ | `new Session({learnAheadLimit:0})` | learnAheadSecs=0 |
| ☐ | `new Session({learnAheadLimit:NaN})` | learnAheadSecs=1200 |
| ☐ | `new Session({learnAheadLimit:undefined})` | learnAheadSecs=1200 |
| ☐ | `new Session({learnAheadLimit:null})` | learnAheadSecs=1200 |
| ☐ | `anki set learnAheadLimit 999` → 讀回 | DB=20 |
| ☐ | `anki set learnAheadLimit 0` → 讀回 | DB=0（**不被吃掉**） |
| ☐ | `anki set learnAheadLimit abc` → | 寫 20 + warn |
| ☐ | `anki set maxIvl 365` → 讀回 | DB=365（不受誤傷） |
| ☐ | `anki set lapseMult 1.5` → 讀回 | DB=1.5（parseFloat 分支保留） |
| ☐ | GUI 設 learnAheadLimit=60 → 存檔讀回 | DB=20（修法 2 clamp） |
| ☐ | GUI input max attribute | max="20" |
| ☐ | 校正 SQL 測試 DB | 2000→20、999→20、正常 20/0 不動、NULL 不動、畸形 JSON 不炸 |
| ☐ | node --check（session-v4/settings/cli + 新增 helper） | 通過 |
| ☐ | vite build | 通過 |

**防回歸測試（bug 無法被觸發 — 使用者指定必測）：**
| ☐ | 驗證項 | 預期 |
|---|---|---|
| ☐ | **刻意傳髒值 2000**：`new Session({learnAheadLimit:2000})` | learnAheadSecs=1200（**非 120000**，33h 窗不存在） |
| ☐ | **再現腳本重跑**：`/tmp/teno-verify-fix.mjs` 改用修法後 code（含 clamp），learnAheadLimit=2000 | 作答數=2、無循環（修法前 269 次） |
| ☐ | **DB 層防禦**：模擬現役 DB 髒值 2000 → app 讀取端 | learnAheadSecs=1200（讀取端 clamp 擋住） |
| ☐ | **直接寫 DB 繞過 GUI/CLI**（手動 UPDATE settings 2000）→ 重啟 session | learnAheadSecs=1200（最後防線成立） |
| ☐ | **三 mode 全測**：flip/mc/spell 各建 Session，learnAheadLimit=2000 | 三 mode learnAheadSecs 都=1200 |
| ☐ | 防回歸腳本留存 repo（`_dev/verify/verify-l1-clamp.mjs` 或既有 verify 工具目錄） | 可重跑 |

## 六、風險與範圍外（憲法⑥）

- 範圍外（另案追蹤）：7 月歷史異常卡 301 張（成因待查，非 learnAhead）、C3（mc/spell 缺鎖）、C10（flip 鎖無 try/finally）、已污染卡（reps/stability/due）修復
- 已定案可選項（憲法⑦）：
  - NaN 防護：**做**（共享 helper Number.isFinite）
  - UI max 同步：**做**（120→20）
  - CLI 警告訊息：**做**（console.warn）
  - `_dev/cli` deprecated 分支：**不修**（已隔離，讀取端被修法 1 涵蓋）
  - 共享 helper：**做**（修法 0，憲法⑩替代結構）
- 檔案所有權（法律 6）：修法 0/1 動 store.js + session-v4.js（首相 A）、修法 2 動 settings.js（**明訂：歸首相 B，pages 範疇**）、修法 3 動 tools/cli.mjs（首相 B）→ **動工時與首相 A/B 任務串行**；L1 單案單一 commit（helper 先行、依賴順序內含）
- 已知殘留：clamp 後窗內 learning 卡重撈與 Anki 一致（設計行為）；`learnAheadLimit=0` 是「關閉提前」非 Anki 預設（預設 20）——0 時 step3 永不提前撈，最安全
