# Teno ↔ Anki 比對報告（C 範圍全倉，2026-09-08）

對象：Teno `main`（v5.15.13 工作區）vs `ankitects/anki` main（當日抓
`rslib/src/scheduler` 8 檔到 `/tmp/anki-compare/`）。
方法：jscpd 內部重複率＋全倉關鍵字普查（361 hits，去誤殺後歸類）＋
逐檔概念對拍（跨語言 JS↔Rust，token-diff 無意義，故採 port/inspired/
diverged/coincidental 四級）。

## 1. jscpd 內部掃描
`npx jscpd src --min-lines 30`：6 組、301 行、**1.17%**。
全是自家鏡像頁（browser↔deck-browser、study-mc↔study-spell、
exam-flip↔exam-spell 等），屬已知架構重複，無外部抄襲問題。

## 2. 關鍵字普查（去誤殺後）
- `words.txt` 108 個全是 banking/blanket 誤殺，忽略。
- `ankiSettings` 變數名（store.js 等）是自家設定鍵，非引用。
- 真引用集中：`session-v4.js`（44）、`scheduler.js`（12）、
  `fsrs-optimizer.js`（9）、`fsrs.js`（5）、`store.js` 頭註解、
  `simulator.js`、`settings.js`、`dashboard.js`。

## 3. 逐段對拍表

| Teno | Anki | 級別 | 說明 |
|---|---|---|---|
| `fsrs.js` FUZZ_RANGES/fuzzDelta/fuzzBounds/constrained/withReviewFuzz | `states/fuzz.rs` 同名函式 | **port（近逐行）** | 常數 2.5/7/20、factor .15/.1/.05、clamp＋upper==lower 補 1 全同。註解自白 `port from Anki's rslib/...` |
| `fsrs.js` minReviewFuzzInterval | `minimum_review_fuzz_interval` | port＋**刻意分叉** | branch2 取 prevIvl+1，Anki 原文 prevIvl（註解 R1 有寫理由） |
| `fsrs.js` FSRS 類／遺忘曲線／21 權重 | `fsrs-rs`（MIT） | port，**授權安全** | 首行即 MIT attribution |
| `session-v4.js` intradayLearning 排序／now／ahead／requeue／collapsed | `queue/learning.rs` 全檔 | **port（概念級）** | comparator `(reps==0, due)` 同；`intraday_now/ahead_iter` 同；`requeue_learning_entry`＋`learning_collapsed`（main 空才塌）同。差異：Teno Array+splice+sort，Anki VecDeque＋binary-search 插入；Teno 無 mtime  tiebreak、無 cutoff snapshot／undo |
| `fsrs.js` parseStepsStr | `states/steps.rs` LearningSteps | inspired＋分叉 | 分鐘→天、NaN/負丟棄、空 steps 畢業同語意；Anki 的 hard 首步平均特殊例、remaining%1000 索引 Teno 未見對應（待查） |
| `scheduler.js` bury/suspend（Set 過濾）＋`main.js` A5 跨天 unbury | `bury_and_suspend.rs` | inspired（簡化版） | Teno 無 SchedBuried/UserBuried/Suspended 三態、無 sibling bury、無 gather_ord；行為級相似，程式級不像 |
| `scheduler.js` getToday／dayCutoff（分鐘制） | `timing.rs` rollover_hour／days_elapsed／next_day_at | inspired | 概念同（rollover 決定 days_elapsed），單位不同（分 vs 時），實作各寫 |
| `scheduler.js` isLeech（門檻 8） | deckconfig leech 預設 8 lapses | coincidental | 門檻值同屬業界常數，程式不像 |
| `scheduler.js` CORRECT_THRESHOLD（Good+ 算記住） | optimizer 對齊 fsrs-rs analytic（Hard 亦算） | 內部有兩套定義並存 | scheduler 用 GOOD，optimizer 用 Hard＋；皆有註解，未統一（非 Anki 問題，記一筆） |
| `store.js` cap_answer_time／EasyDay／SimulatorConfig::default 註解 | `answering/mod.rs`、load_balancer、sim | cited（僅註解引用） | 實作是否真對齊未逐行驗，列為待查 |
| `session-v4.js` A7 new 卡每日 salt re-hash | Anki 同名行為 | 分叉 | Teno 自家 seeded PRNG（memory 既定），行為致敬、實作自有 |
| `import.js` parseAnkiTSV／mapAnkiRows | Anki TSV 匯出格式 | coincidental | 格式互通無授權問題 |
| Teno 三模式卡（flip/mc/spell 三表） | Anki note→cards | **diverged（自有設計）** | 硬套 Anki 會殺掉此設計，不建議對齊 |

## 4. 未驗（留白，不瞎猜）
- `answering/review.rs`＋`states/review.rs` vs Teno `review()` 作答寫卡全路徑。
- `states/load_balancer.rs` vs Teno `selectIntervalWithLoadBalancing`。
- `queue/builder/`＋`new.rs`（gather 排序）vs Teno deckWeights／new 抽卡。
- `learning_ivl_with_fuzz`（+25%/5min 種子）Teno 有無對應。
- store.js 三處 cited（cap_answer_time／EasyDay／simulator 預設）實作對齊度。

## 5. 授權結論（重點）
- **MIT 安全區**：FSRS 模型核心（fsrs-rs），attribution 完整。
- **AGPL 暴露區**：fuzz 整段、queue/learning 概念、steps 語意、timing
  語意——Anki 本體 AGPL-3.0，port 屬衍生。註解自白（`port from ...`）
  誠實但不等於合規；AGPL 要的是源碼提供，不是署名。
- **最大缺口**：全倉無中央 NOTICE／THIRD-PARTY 檔，attribution 只散在
  code 註解。若走閉源商用，現狀是有風險的。
- 建議：① 補中央 NOTICE（Anki AGPL＋fsrs-rs MIT＋對照表，本檔即草稿）；
  ② 決定開閉源路線——閉源則把 AGPL 區重寫到「想法級」或諮詢法務；
  ③ 註解自白保留（刪掉更糟）；④ 補完 §4 四項再結案。
