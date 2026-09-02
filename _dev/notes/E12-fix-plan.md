# E12 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；v1.1＝R1 過審＋地雷另案裁決）

## 1. Bug 定義（行號實錘 2026-08-28：cmdMature cli.mjs:2896 / :2843）
`mature` 結束寫 sim_runs 的 `totalReviews`（消費者：app-log.js → UI 顯示
「上次模擬」）：
- **超時分支 :2896**：`SELECT count(*) FROM review_log`（mature.db）——
  cmdSimulate 只 upsert cards **零寫 review_log**（實錘：全檔 INSERT INTO
  review_log 唯 :1343 cmdRate＋:3533 import 路徑），mature.db 的 review_log
  永远是建檔時 app 真庫 `.backup` 快照 → 報的是**使用者真實刷題史**冒充
  模擬 effort（真例：會報 4884，即使本次跑了 10 萬次模擬評分）。
- **成功分支 :2843**：writeSimRun 呼叫乾脆**不傳 totalReviews** →
  sim_runs.total_reviews = null（欄位存在但恆空）。

## 2. Root cause
模擬 effort 無直接計數源（simulate 不落 log），cmdMature 拿錯表湊數；
成功路徑連湊都懶得湊。正確計量＝**本次 run 期間 cards.reps 總和增量**——
FSRS 每次評分 reps+1（Session 語意），child simulate 全程寫同一 MATURE_DB，
基線差＝本次 run 評分總次數，確定性、零改 simulate 寫入面。

## 3. 修法（tools/cli.mjs cmdMature，~8 行）
1. 小工具：`const sumReps = (p) => { try { const d = new DatabaseSync(p, { readOnly: true }); const n = d.prepare('SELECT COALESCE(SUM(reps),0) n FROM cards').get().n; d.close(); return n; } catch { return null; } };`
2. 基線捕捉（MATURE_DB 建妥＋from-zero 清空**之後**、日循環之前）：
   `const repsBase = sumReps(MATURE_DB);`
3. 兩出口統一：`const totalReviews = (() => { const s = sumReps(MATURE_DB); return repsBase != null && s != null ? s - repsBase : null; })();`
   成功分支（:2843）＋超時分支（:2896 刪除錯表查詢）皆傳此值。
- 未知（sumReps null）→ null 誠實，不謊報。
- from-zero：基線捕捉在清空後 → base=0，delta=全程。
- 可選項（憲法⑦）：(a) 讓 simulate 寫 review_log 進 sim DB？**不做**——
  simulate 是排程壓力測試（E5-SR1 波次定案：記憶體 queue 測試不落庫），
  落 log 會污染 mature.db（若被 import 鏈吃到就是假刷題史），改寫入面
  風險遠大於計量收益；(b) 解析 child stdout 計 [store.rate] 數？**不做**——
  reps 基線差更準（stdout 若未來改版格式即斷，reps 是持久化語意）。

## 4. 驗證方式（tools/verify-e12-mature-totalreviews.mjs，全 tmp）
- T1 超時分支：tmp 主庫 6 字＋真 app review_log 快照 40 筆 → mature 目標
  100% --max-days 2 --from-zero --speed 60 → sim_runs.total_reviews ==
  SUM(cards.reps)（實際模擬 effort）且 != 40（不再是快照謊數）且 > 0。
- T2 成功分支：預種 1 張成熟卡（不 from-zero）→ mature 1 --max-days 3 首日
  即達標 → total_reviews 非 null 且 == 循環期間 reps 增量（基線已含預種）。
- T3 契約釘：sim_runs 欄位集合不變（零 schema 遷移）；kind/days/target_pct
  等欄不動。
- T4 負控制：錯表版反換 → 超時分支 total_reviews==40（快照謊數重現）＋
  成功分支 total_reviews==null（缺欄重現）。
- T5 增量正確性：T1 跑完記 SUM(reps)=S1 → 再跑一次 --max-days 1（不
  from-zero，續-progress）→ 第二次 total_reviews == S2−S1（基線差非總和）。

## 5. 風險
- 行為變化：total_reviews 語意「app 快照計數/null」→「本次 run 模擬評分數」
  ——修復目的；UI 顯示更誠實。
- reps 增量假设：Session.review 每評分 reps+1（fsrs.js 官方語意）。若某
  路徑评分不增 reps 會低估——驗證 T1 用獨立計數源（child 日誌 [store.rate]
  行數）交叉核對相等。

## 6. 範圍外清單（憲法⑥）
- simulate 寫入面（§3(b) 定案不落庫）。
- writeSimRun DELETE 全表只留最新一筆（設計如此，另案）。
- mature.db 生命週期（existsSync 就不重建，跨 run 殭屍快取）另案。
- sim_runs 失敗 exit code（系統化另單）。
- **新地雷（R1 親驗收窄）**：cmdSimulate `_diffBins` NaN bin——真庫 review_log
  若存在 ≥30 筆 difficulty=NULL **且為唯一分級** 時 `getDiffDist` 崩
  （`round(NULL*2)/2→NULL→parseFloat('null')=NaN`；NaN 雙比較 false 自然遭
  排除，唯獨「全 NaN 單 bin」則 lo/hi 雙 null → `(.lo||hi).dist` 炸）。真庫
  實查 NULL＝0 筆現況不可達。正確修法＝`Number.isFinite` 濾 bin（非 `?.dist`
  靜默降級——行為決策）。登案優先級低。
- R1 觀察：中途換 mature.db tampering→負 total_reviews（可併生命週期單
  `Math.max(0,·)`）；child spawn 120s 超時殺→當日 reps 遺失低估（併 exit
  code 系統化單）；UI app-log.js:40 `?? 0` 把 null 與真 0 混消（PM1 域另單）。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 單席）
- ✅ **通過**（2 非阻塞觀察＋地雷裁決）。驗證 11/11×2 屬實重跑（T1b/c 三數
  釘死 15==15==15）；計畫 §3 與 diff 語意一致（IIFE→simReviews() 函式兩出口
  呼叫＝等價更貼出口，無異議）。
- 攻擊全擋：(a1) fsrs.js review 頂部 unconditional newReps、唯一 return 必帶
  →「評分必 +1」釘死；(a2) 未評分卡 upsert 原值回寫 delta=0；(a3) 基線每 run
  現捕捉無跨 run 持久態，resume 語意自洽、from-zero 冪等；(b) 換檔於 run 前
  無害、中途 tampering 負數屬生命週期另案；(c) 消費者全盤點三處零假設炸
  （app-log.js `?? 0` 空安全／cmdLogs 模板直插／simulator.js 自有計數）；
  (d) 同意不落 log 定案（且補強論據：mature.db＝app 庫備份，污染即假刷題史）。
- 變異 (e) 基線前移 → from-zero run total_reviews=−13（T1b/c/d 三連紅）預言
  實現，測資敏感度正確。
- **地雷裁決：登 §6 恰當、不准順手修**（觸發鏈親驗收窄＝全 NaN 單 bin 才崩、
  真庫 NULL=0 不可達；正確修法 Number.isFinite 濾 bin 屬行為非零風險一行）。
- 首相誠實登記初跑紅×2（difficulty=NULL 測資踩既存地雷→測資改帶值；T3 查錯
  DB；預種改 upsert）委員全數覆核通過。
- 結論：**R1 全席 ✅ 過審**（單席制），動工 commit。
