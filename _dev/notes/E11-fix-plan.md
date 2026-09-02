# E11 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.1＝R1 過審＋advisory#1 混源緊縮採納）

## 1. Bug 定義（行號實錘 2026-08-28：cmdReport cli.mjs:2783）
`const totalWords = 4868;` 硬編碼。實測：tmp DB 7 單字 → report --json 回
`totalWords: 4868`、`maturePct: 0`（真值應 7 與 43）。三處消費者全錯：
--json `totalWords`/`maturePct`（**app UI runCli('report --json') 直接吃**，
simulator.js 已查證為 UI 呼叫面之一）、HTML「N 單字」、HTML 成熟率。

## 2. Root cause
同函式 :2769 **已經**查了 `words` 計數（`const words = d.prepare(...)`）但
困在 try 塊作用域，:2783 寫 HTML/JSON 時取不到 → 當年拿當時真庫的 4868 湊數。
謊數還扭曲 maturePct（分母虛大 → 3/4868=0% 誤導為「近乎零成熟」）。

## 3. 修法（tools/cli.mjs cmdReport，~4 行）
1. `let ivlDist = null, matureCumulative = null;`（:2759）→ 加 `totalWords = null`；
2. try 內 `const words = ...` 後：`totalWords = words;`（複用同查詢零額外開銷）；
3. `:2783 const totalWords = 4868;` → 刪除，替換為回退：
   `if (totalWords == null) { try { totalWords = db.prepare('SELECT count(*) n FROM words').get().n; } catch { totalWords = 0; } }`
   （log 目錄無 base.db/mature.db 時回退主庫——全局 db 唯讀句柄；主庫也壞→0）；
4. maturePct 兩處分母守衛 `matureCumulative ?` → `matureCumulative && totalWords ?`
   （:2790 JSON＋:2818 HTML；防 totalWords=0 時 Infinity/NaN——修謊數後 0 變可達
   值，同根清零蟲）。
- 分母語意＝words 計數（與 cmdMature :2704-2709 同式，對齊非自創）。
- 可選項（憲法⑦）：JSON 加 `totalWordsSource: 'db'|'fallback'`？**不做**——
  消費者（app UI）契約欄位不動，加欄屬擴編。

## 4. 驗證方式（tools/verify-e11-report-totalwords.mjs，全 tmp）
- T1 主鏈：tmp log 目錄（day-1/day-2＋base.db 7 字 3 成熟）→ --json
  totalWords=7＋maturePct=43（3/7）＋HTML「7 單字」。
- T2 db 鏈路：--db 顯式指向另一 counts DB → 数字跟 DB 走（實時非快照）。
- T3 回退鏈：無 base.db/mature.db → 回退主庫（TENO_DB tmp 主庫 5 字）→ 5；
  主庫 0 字 → totalWords=0 不崩＋maturePct null 非 Infinity/NaN。
- T4 變動釘：T1 後對 base.db 加 3 字重跑 → 10（釘「實時查詢」非殘影）。
- T5 負控制：4868 段反換回 HEAD → totalWords=4868 謊數重現（且 maturePct
  由 43 墬 0 誤導重現）。

## 5. 風險
- 行為變化：UI/HTML/JSON 的 totalWords 由恆 4868 改真實值——這是修復目的；
  maturePct 隨之變動（正確化）。
- dbPath 不存在路徑新增一次主庫唯讀查詢（原路徑零查詢）——O(count) 輕。

## 6. 範圍外清單（憲法⑥）
- report 其余指標正確性（matureSnap 系列邏輯另案）。
- default 目錄硬編碼 `${HOME}/桌面/log/成熟295天`（CLI UX 另案）。
- UI 端 totalWords 顯示寬容度（PM1 域）。
- **R1 advisory**：#2 matureCumulative=0→pct null（truthy 守衛 HEAD 作風，
  宜 `!= null` 另案）；#3 `--db` 指向不存在路徑被靜默降層（吞使用者意圖）；
  #4 DB 掃描 catch 路徑 DatabaseSync 未 close（短命進程無害）。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席）
- ✅ **放行**（附 4 advisory）。diff 與 §3 逐句吻合；驗證 11/11×2 屬實重跑。
- 消費者矩陣穷举：UI simulator.js:726 只吃 maturePct（不吃 totalWords，
  無 4868 刻度假設）；JSON 契約欄位集合與 HEAD 相同；bot/cron/rust 零消費者；
  全倉 4868 字面量零殘留。§1「UI 呼叫面之一」宣稱屬實（:726 在位）。
- 攻擊：(b) dbPath 三層 fallback×缺表三態 exit 0 無 crash；(d) totalWords
  消費點穷举 6 處全覆蓋無漏網；(e) 變異 A（只上守衛不上主修法）紅 7 精準、
  變異 B（回退改 0）紅 3＋**T3a 對 B 綠之發現：HEAD :2763 `dbPath=DB` 已做
  主庫回退，hunk(3) 真實棲息地＝「dbPath 存在但 try 拋錯」防禦縱深**（誠實登記）。
- **advisory#1 採納（v1.1）**：hunk(3) 緊縮為 `totalWords == null &&
  matureCumulative == null`——委員實測混源孵化點（base.db 有 cards 無 words
  表→分子 3 來自 base.db／分母 9 來自主庫→pct=33 混源可達）。同 DB 同敗才
  整組回退主庫，絕不混源；矛盾 DB 態 totalWords/pct=null 誠實呈現。補 T3c
  混源釘（schema 矛盾→null/null 絕非 33）→ 驗證 12/12 ALL PASS。
- advisory#2（既有 matureCumulative=0→pct null truthy 作風）/#3（--db 不存在
  路徑靜默降層）/#4（catch 路徑 d 未 close 短命進程無害）登 §6 另案。
- 結論：**R1 全席 ✅ 過審**（單席制＋advisory#1 採納），動工 commit。
