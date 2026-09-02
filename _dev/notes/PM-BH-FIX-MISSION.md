# PM-BH-FIX 任務書 — 修 BUGHUNT 掃出的 4 顆新 bug（BH-01 ~ BH-04）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`、**`_dev/notes/BUGHUNT-TODO.md`**（bug 清單全內容：每條含現況碼、root cause、建議修法、驗證）。工作目錄 `~/teno`，branch main。基線 HEAD=`$(git rev-parse HEAD)`（讀檔時現值，v5.8.12+）。

## 任務性質
把 BUGHUNT 掃出的 4 顆新發現 bug 依序收完：**BH-01 → BH-02 → BH-03 → BH-04**。全部已在 BUGHUNT-TODO.md 有實錘行號＋建議修法，直接照它動工（如有行號漂移先重實錘）。

## 佇列（照 BUGHUNT-TODO.md，每顆完整循環）
1. **BH-01** 🟠 `src/lib/store.js:1740-1766` — deleteDeck 漏清 suspendedMc/suspendedSpell（state＋DB settings 都漏）。補兩行過濾＋兩行 setSetting。
2. **BH-02** 🟠 `src/lib/store.js:1697-1705` — deleteWord 只清 words/cards，reviewLog/examHistory/buried/suspended/三mode Set/buriedAt/examples 全殘留 → memory/DB 分歧 → **保留率吃已刪字髒資料**。補齊清理。
3. **BH-03** 🟡 `src/lib/store.js:1740-1766` — deleteDeck 不清 memory reviewLog/examHistory（DB 已清）。建議與 BH-02 **共用同一 helper**（避免邏輯漂移），或分顆。由你判斷最穩寫法。
4. **BH-04** 🟡 `src/pages/tools.js:349-364`（呼叫 :1004）— 自訂 select 對 document 累積 click listener 無 guard。補 module 級 `_toolsCsBound` flag（仿 lib/custom-select.js:12-13 G5 模式）。

## 鐵律（GOV-BRIEF）
- **一顆一任務**：實錘現行行號 → PRE 態紅優先證（負控制）→ 修 → POST 綠 → 審查 → commit → md log 落 `_dev/notes/subagent-log/`。嚴禁多顆交錯、嚴禁跳審查。
- **store.js 是共享核心檔（檔案所有權高風險）**：BH-01/02/03 動到它 → 一律 3 委員審查（不可降席）。改動要最小幅、精準，不碰資料庫 schema、不碰 FSRS、不碰 OCR。
- **BH-02 動使用者盯的保留率**：務必先寫 PRE 紅 harness（確認刪字後保留率確實溢算）→ 修 → 斷言 POST 綠，負控制證據先行。
- 禁 `git add -A`；commit 前完整 `git status` 揪預 staged 外來檔。禁碰共享髒檔（scope-requests.md、Cargo.lock 若非版本同步必要）。
- 升版逐顆 `./tools/version.sh <完整版號>`（繞過 patch 分支 bug），三指紋同步。
- 429 退避：審查並行易撞 glm-5.3-free 8req/min，起審前 sleep≥60s。

## 交付
- 4 顆都 commit，或逐顆完整交接。
- 回報：各顆 commit hash、審查輪數人次、驗證 N/N（PRE紅/POST綠）、計畫書路徑。
- 用繁體中文。