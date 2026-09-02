# E3 修復計畫書 — CLI dayCutoff/timezoneOffset 硬編碼與混用

> 狀態：**定案**｜審查：5 委員 × 1 輪（5/5 ✅）
> 範圍：tools/cli.mjs（E1 已讓 app 走此檔，改動直接生效）

---

## 1. Bug 定義

**症狀**：CLI stats/dash 的「今天到期/待複習」數字與 app 不一致（實測：cmdStats 高報 6 張、cmdDash 低報 11 張；06:00-08:00 窗內判不同天）。

**Root cause**（#1/#2/#3 實錘）：
- `ANKI` 物件（cli.mjs:26）寫死 `dayCutoff: 360, timezoneOffset: 480`，完全不讀 DB（DB 真實值 480/480）
- `const today`（:32）在 db 開啟（:34）**前**算一次，且非 lazy
- `cmdDash` 單一比較式內混用兩套：`localDue()` 用寫死 360/480、`today2()` 用 DB 值（fallback 300/480）→ 不自洽
- `cmdAudit`（:1558）從 ankiSettings blob 讀 dayCutoff（blob **無此欄**）→ 永遠 240
- `cmdStats` 用 `=== today` 排除逾期（app 用 `<=`）→ 少報 560+ 張
- `cmdSimulate`（:2216）硬編 DAY_CUTOFF=300/TZ=480
- app 端基準：dayCutoff 是 **settings 頂層 key**（fallback 0）、timezoneOffset 在 **ankiSettings blob**（fallback null=系統本地）

## 2. 修復方案（tools/cli.mjs）

### 2.1 db 開啟後載入全域（:34 後）
```js
const DAY_CUTOFF = (db.prepare("SELECT value FROM settings WHERE key='dayCutoff'").get()?.value) | 0;
const TZ_OFFSET = (() => {
  try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='ankiSettings'").get().value).timezoneOffset; }
  catch { return null; }
})() ?? -new Date().getTimezoneOffset();   // fallback 系統本地（勿用 0=UTC）
```

### 2.2 ANKI 改 DB 值（:26）→ 自動修好 makeSession/localDue/cmdDue/cmdSim/cmdStray
```js
const ANKI = { ...現有欄位, dayCutoff: DAY_CUTOFF, timezoneOffset: TZ_OFFSET };
```

### 2.3 today 改 lazy（:32）→ 6 呼叫點改 `today()`（:154/:309/:322/:1253/:1282/:1343）
```js
const today = () => getToday(DAY_CUTOFF, TZ_OFFSET);
```

### 2.4 cmdDash 統一（:180-184 + :196/:239）— 刪 today2/requireScheduler 副本
- 刪 ad-hoc 讀取，用全域 DAY_CUTOFF/TZ_OFFSET；fallback 300→0、480→系統本地
- 用已 import 的 scheduler（:9 getToday/toLocalDateStr）取代內聯副本

### 2.5 cmdAudit（:1557-1558）— 刪 `anki.dayCutoff ?? 240`，改全域
### 2.6 cmdSimulate（:2216-2217）— 硬編 300/480 改全域
### 2.7 cmdStats（:154）— `localDue(card.due) === today()` → `<= today()`（對齊 app 含逾期）

## 3. 審查歷程（第 1 輪 5/5 ✅）

| 委員 | 視角 | 裁決 | 關鍵 |
|---|---|---|---|
| #1 | 技術 | ✅ | ANKI 移到 db 後 + try/catch；timezoneOffset fallback 須 null 非 0 |
| #2 | Anki | ✅ | fallback 0 僅 dayCutoff；cmdStats `===`→`<=`（70 vs 642 量級）；cmdAudit 讀錯 key |
| #3 | 實測 | ✅ | 現況高報 6/低報 11 實錘；統一 480/480 後與 app 一致 |
| #4 | 副作用 | ✅ | localDue/makeSession/api.today/cmdSimulate/cmdAudit 全納入 |
| #5 | 整合 | ✅ | 6 處呼叫點 + api export；E2 無衝突（互補） |

## 4. 驗證方式

1. **行為**：`node tools/cli.mjs stats` / `dash` 數字 = app 端（待複習 642）
2. **窗測試**：模擬 06:00-08:00 執行，today 判定與 app 一致
3. **Build**：node --check + vite build（cli.mjs 不被 bundle，node --check 即可）

## 5. 風險

- **低**：CLI 是 dev 工具；改動讓 CLI 數字對齊 app（正確方向）
- **低**：api.today export 形狀變函式（repo 無 JS 消費方）
- **已知**（範圍外）：cmdStudy 已讀頂層 dayCutoff ✓（#5 確認）
