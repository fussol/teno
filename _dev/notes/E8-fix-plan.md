# E8 修復計畫書 v1.1（2026-08-28，首相2／PM2 域）

## 1. Bug 定義
`tools/cli.mjs` `cmdSelfTest()` 第 3 段「模擬引擎」import 不存在的路徑
`../src/lib/sim-engine.js`（實際檔案早在政策隔離時移入
`src/lib/deprecated/sim-engine.js`）→ 每次 selftest 必拋
`Cannot find module` → `check('模擬引擎', false)` **永遠 ❌**。

實錘（2026-08-28，tmp DB 副本 `TENO_DB=/tmp/e8work/teno.db node tools/cli.mjs selftest`）：
```
❌ 模擬引擎 Cannot find module '/home/jupiter/teno/src/lib/sim-engine.js' imported from /home/jupiter/teno/tools/cli.mjs
═══ 結果: 11 通過 / 1 失敗 ═══
```
實際行號：2251–2264（佇列寫 2145 為 08-13 掃描，已漂移，如實登記）。

## 2. Root cause
git 史實錘：`0b43e48`（Initial commit）cli 就 import `../src/lib/sim-engine.js`；
`c461727`「模擬器全面對齊 Anki 官方（官方 fsrs-rs 引擎）」把 JS 引擎移入
`deprecated/` 並政策隔離，**但 selftest 的引用沒有同步退役** → 死引用。

消费者穷举（全庫 grep `sim-engine`，排除 `_dev/cli/` 舊版禁碰檔）：
- `src/lib/deprecated/sim-engine.js`（自身檔頭註解）
- `tools/cli.mjs:2258`（本 bug，死引用）
- `_dev/cli/cli.mjs:2104`（舊版 CLI，檔案所有權白名單外、政策不准碰）
→ **app 端（src/pages、src/lib 非 deprecated）零消费者**；官方模擬 =
Rust `simulate_fsrs`（fsrs-rs 6.6.1），CLI `simulate` 命令亦自帶另一套 loop，
均不經此 JS 引擎。

## 3. 修法（tools/cli.mjs:2251-2264）
**刪除 selftest 第 3 段整塊**，以註解說明退役原因。後續段落註解編號（4./5.）
保持原樣不動（最小 diff，便於審查定位）。

### 否決方案 A：import 改指 deprecated 路徑（看似一行最小修）
否決理由（三條獨立）：
1. **政策**：舊 JS 模擬引擎已被官方引擎取代並隔離（法典：模擬一律官方
   simulate_fsrs；自寫引擎禁接回）。把 selftest 接回隔離檔＝測試綁死隔離碼，
   隔離不徹底。
2. **防衛價值零**：selftest 目的是體檢「現行 toolchain」；該引擎 app 零消费者、
   CLI simulate 也不用它，測它綠了不保護任何生產路徑。
3. **與佇列 E16 衝突**：E16 孤兒刪除前提「grep 全專案零引用」。方案 A 會人造
   一個引用，E16 到時只能再拆一次（打補丁循環，憲法⑩精神）。

### 可選項定案（憲法⑦）
- 換成「官方引擎可用性檢查」（查 python venv / fsrs-optimize.py 存在）：**不做**。
  理由：selftest 現行段全為純 Node/DB 斷言，引入外部工具鏈探測會在他機
  （無 venv）人造新 ❌，違反 selftest 穩定性；官方鏈路已由 optimize 命令自身
  驗證。
- selftest 檢查觸發數由 12 降至 11（buggy 態第 3 段只觸發 catch 內 1 個 check；
  修法後該段 0 觸發。R1#1 更正 v1.0 誤記「9」）：接受，如實登記。

## 4. 驗證方式（tools/verify-e8-selftest.mjs，tmp DB，嚴禁碰真檔）
- T1 靜態：cli.mjs 源碼不再含 `src/lib/sim-engine` 死路徑、無 `runSimulation` 引用。
- T2 實跑：tmp 最小 schema DB 跑 `selftest` → 輸出零 ❌、失敗計數 = 0、
  `模擬引擎` 字樣不再出現、FSRS 段仍 OK（回歸釘：刪除未殃及他段）。
- T3 負控制（bugsub 同深副本＋src symlink，E5/E6 同法）：把修法還原成原 broken
  block → selftest 必現 `❌ 模擬引擎`＋`Cannot find module`＋失敗計數 ≥1，
  精準重現 bug。
- T4 E16 前提釘：tools/cli.mjs 與 src/（排除 deprecated 檔本身）零 `sim-engine`
  引用；`_dev/cli` 舊版豁免（白名單外）。
- T2 回歸釘（T2e/f/g）已補 `✅ ` 前綴，根除變異 c2 假綠（R1#3 發現）。
- **marker 契約**：`// 3. (E8 退役)` 精確文字 = 驗證腳本 T3 重建錨，不可改字
  （R1#3 確認：無 marker 時 T3a/c/d/e 連帶轉紅 = fail-safe 方向正確）。
- **退役註解核准文字（方案 ii，R1#3 建議）**：
  `// 3. (E8 退役) 舊 JS 模擬引擎段移除：政策隔離＋官方引擎取代＋零消费者`
  此文字不含 `sim-engine` 子串，T1a/T4a 可保留整檔掃描（不需剝註解）。

## 5. 風險
- selftest 覆蓋率下降：僅降在零消费者隔離引擎（見 §3），無生產防衛損失。
- `[TEST]` 標記 log 寫入、計數匯總邏輯不動。
- cli.mjs 為 PM2 獨有檔，無並行首相交錯（SR-C4 hunk 除外，commit 前照 E6/E7
  既定程序反剝、事後還原）。

## 6. 範圍外清單（憲法⑥）
- E10（selftest 容器檢查 `|| true` 恆真）：同函式但独立 bug，獨立單。
- E16 孤兒刪除本體（含 `deprecated/sim-behavior.js` 連帶孤兒问题——它不在 PM2
  白名單，E16 時視情況登 scope-requests）。
- `_dev/cli/cli.mjs` 同款死引用：舊版禁碰。
- selftest 對真 DB 異常資料的健壮性：非本單。

## 7. 審查紀錄
### R1（3 委員）：#1 ✅ / #2 ✅ / #3 ❌
- #1（修法正確性）✅：五項獨立查證全過（ consumers 穷举、政策檔頭、git 漂移史、
  負控制實跑、否決 A 三理由成立＋加證：方案 A 連「一行修」都不是，會拖入
  sim-behavior.js 隔離碼）。LOW 備案：計數 12→11 非 9（已採納）。
- #2（消費者穷举）✅：src/、Discord bot、cron 對 selftest 輸出/計數/check 名稱
  零機械依赖；段落無共用變數交錯；無孤立 import；T4 walk 排除 deprecated 與
  E16 白名單等價性論證成立；負控制真實性於 /tmp 模擬修法後狀態 18/18 實錘。
  提醒：退役註解含 sim-engine token 會炸 T1a/T4a（→ #3 缺陷 1，已採納方案 ii）。
- #3（牙檢）❌ 兩缺陷：(1) T2e/f/g 無 ✅ 前綴 → 變異 c2（誤刪容器段代碼行）
  ReferenceError 訊息湊出 pin 子串假綠（實測實錘）→ 已補前綴；(2) 修法要求
  「註解說明退役原因」的自然寫法（提及 sim-engine 檔名）實測觸 T1a+T4a 假紅
  → 已採納方案 (ii)：pin 死核准註解文字（§4），marker 契約文件化。
  其餘變異有牙：mut-a 方案 A 七發斃命、mut-b/mut-d 連坐 fail-safe、T3 重組
  邏輯無假綠路徑。
### R2：#3 複審 ✅ 放行
- 五項清單全過：(1) 腳本 diff 恰好三處前綴零其他變更；(2) fix-clean（核准文字
  逐字）×v1.1 → 18/18×2 穩定；(3) 變異 c2 重跑 → T2f 轉紅實錘（假綠機制對照組
  ×v1.0 親眼復現拼接命中）；(4) fix-natural 違反契約紅＝設計行為非缺陷（其餘
  16 綠精準不連坐）；(5) 基準未修態 T3 負控制群 6/6 仍綠（fallback 分支活著）。
- 實施備註採納：單行核准文字最短路徑；SR-C4 hunk commit 前反剝照 §5。
