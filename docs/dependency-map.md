# Teno 部件相互依賴關係總圖（DEPMAP1）

> 生成方式：靜態實測（`grep` 全 repo），非推測。抽樣命令見 §10。
> 版本：v5.17.11（2026-09-11）。改動任一模組前先查本表。
> 六路 subagent 曾因 API 429 全滅，本表由主線直接抽取。
> §11 孤兒掃描（2026-09-11）：60 個 src JS 檔全有連接，無檔案級孤兒。
> §12 增量（v5.17.7–v5.17.11）：BATCHADD1／MERGEMOVE1／CARDNEXT1／MWKEYLAYOUT1／DEADCODE1。

---

## 1. 分層總圖（一句話：誰能碰誰）

```
┌─ 頁面層 src/pages/*.js（19 頁，lazy import，只准往下依賴）
│    瀏覽/編輯：browser / deck-browser / tag-manager
│    學習：study / study-v4 / study-mc / study-spell
│    測驗：exam / exam-flip / exam-mc / exam-spell
│    工具：tools / import / export / ocr / simulator / dashboard / app-log / settings
├─ 入口/殼 src/main.js（路由＋nav＋splash，頁面 lazy 載入）
├─ 引擎層 src/engine/session-*.js（學習/測驗 session 狀態機）
├─ 核心層 src/core/*.js（FSRS／scheduler／import 解析／exam-session／simulator／filter）
├─ 服務層 src/lib/*.js（db／store／api／解析／呈現／橫切）
└─ 後端 src-tauri/src/*.rs（tauri command，唯一經 src/lib/api.js 呼叫）
```

**鐵律：頁面不准互相 import；跨頁共用一律下沉到 `lib`／`core`／`engine`。**
`main.js` 註明頁面→main 循環已被抽離（state/toast 已搬 `lib`）。

---

## 2. 模組職責（一檔一句話）

### 2.1 頁面層（按行數＝爆炸半徑排序）

| 檔案 | 行數 | 職責 |
|---|---|---|
| deck-browser.js | 2555 | 字本瀏覽＋新增/編輯 modal（圖片、膠囊、自動填入鏈）＋批量新增（BATCHADD1）＋合併第二問（MERGEMOVE1） |
| tools.js | 2086 | 批次工具：組合包自動補齊（9 欄位×來源分派）＋獨立卡 |
| browser.js | 1819 | 字庫瀏覽＋新增/編輯 modal（與 deck-browser 鏡像邏輯；批量新增不進此頁） |
| settings.js | 1758 | 設定頁：全部開關＋Key＋主題＋備份＋Drive |
| ocr.js | 1140 | OCR 錄入頁（引擎選擇＋裁切＋辨識＋入庫） |
| import.js | 1042 | CSV/TSV/APKG/DB 匯入 |
| dashboard.js | 977 | 統計圖表（讀 FSRS／scheduler） |
| simulator.js | 751 | FSRS 參數模擬（調 `simulate_fsrs`） |
| exam-mc.js | 538 | 測驗-選擇（session-mc-utils） |
| exam-spell.js | 513 | 測驗-拼字（session-spell-utils） |
| exam-flip.js | 513 | 測驗-翻卡 |
| tag-manager.js | 502 | 標籤管理（browser 子頁） |
| study-v4.js | — | 學習-翻卡（session-utils） |
| study-mc.js | — | 學習-選擇（session-mc-utils） |
| study-spell.js | — | 學習-拼字（session-spell-utils） |
| study.js／exam.js | — | 主頁殼（幾乎只有 `svg.js` 依賴，實作在子頁） |
| export.js | — | CSV/DB 匯出（`core/import.buildCSV`＋`exportCsvDialog`） |
| app-log.js | 205 | 操作日誌頁 |

### 2.2 服務層 `src/lib`

| 檔案 | 被 import 數 | 職責 |
|---|---|---|
| svg.js | 20 | 圖標＋字卡/例句 HTML（`cardFaceHtml` 在 word-extra，`splitFieldsHtml` 等在 svg） |
| toast.js | 16 | 全 app 提示 |
| word-extra.js | 9 | 字卡面渲染＋欄位可見度（`cardFaceHtml`／`visShow`／`extraFieldsHtml`；CARDNEXT1 後例句區內下一組鈕已拔，只留 head 鈕） |
| tts.js | 9 | 發音：`speak`／`stopSpeech`／`bindSpeakClick`（轉調 api `speakText`；CARDNEXT1 按鈕優先擋＋NOSPEAK-CN 中文欄靜音） |
| api.js | 8＋動態7 | 後端唯一入口（wrapper→command 見 §6；DEADCODE1 後 `writeDbBytes` wrapper 已刪，後端 command 保留） |
| word-image.js | 8 | 單字圖片 carousel＋編輯器縮圖＋貼連結流程 |
| platform.js | 6 | 平台判斷＋下載 blob |
| db.js | 3＋動態45 | SQLite 資料層（真正的資料心臟，靜態數會騙人） |
| store.js | 2 | 全域 state＋actions（createStore；單例在 app-store.js） |
| app-store.js | 2 | `export const store = createStore()` 單例 |
| merriam.js | 4（3頁＋harness） | 韋氏純解析（strip／parse／merriamToFields／parseStems） |
| dictionary.js | 2（ocr／tools） | 內建詞表（`assets/words.txt`） |
| display-limit.js | 2 | 瀏覽顯示上限（`browserDisplayLimit`） |
| rng.js | 4 | hash／mulberry32（queue shuffle／fuzz） |
| image-url.js | 2（word-image 鏈） | 圖片 URL 正規化＋貼連結解析（IMGURL1） |
| theme.js | 1 | 主題 |
| chart.js | 2 | 圖表（dashboard 用） |
| custom-select.js | 2 | 自訂下拉（main.js 初始化） |
| app-log.js | 5（動態） | 操作日誌寫庫 |
| backup-scheduler.js | 1（動態） | 自動備份排程 |
| batch-add.js | 1（deck-browser 動態 import） | 批量新增純函式（`parseBatchInput` 切分去重＋`partitionBatch` 已存在/未存入分流；無 DOM 無 DB，harness 直測） |
| ocr-blacklist.js | — | OCR 黑名單預設字 |
| icon-presets.js | — | launcher icon 預設 |
| human-data.js | — | 人工資料（展示用） |
| easter-eggs.js | — | 彩蛋 |

### 2.3 核心層 `src/core`／引擎 `src/engine`／OCR `src/lib/ocr`

| 檔案 | 被引用 | 職責 |
|---|---|---|
| core/fsrs.js | 6（4 engine＋store＋dashboard） | FSRS 排程唯一真相（參數／review／fuzz） |
| core/scheduler.js | 5（4 engine＋store＋dashboard＋study-mc/spell/v4＋main） | 抽卡 queue／shuffle／streak |
| core/import.js | 2（tools＋export） | CSV/TSV 解析＋欄位正規化（`normalizePos` 等） |
| core/exam-session.js | 3 | 測驗 session 存檔（exam-flip 用） |
| core/fsrs-optimizer.js | 1（動態，simulator） | 權重優化 |
| core/simulator.js | 1（動態，simulator 頁） | 模擬引擎 |
| core/filterEngine.js | 1（動態） | 搜尋語法解析 |
| engine/session-utils.js | study-v4 | 翻卡 session |
| engine/session-mc-utils.js | study-mc＋exam-mc | 選擇 session |
| engine/session-spell-utils.js | study-spell＋exam-spell | 拼字 session |
| engine/session-v4.js | — | v4 session（fsrs＋scheduler＋store） |
| ocr/engine.js | ocr 頁 | 引擎列舉（讀 `ocr_engine`） |
| ocr/vision-adapter.js | — | 雲端 vision（含 `ocrVisionModel`） |
| ocr/auto-preprocess.js | — | 自動預處理（調 `upscale.js` 的 otsu／行高／縮放） |
| ocr/preprocess.js | ocr 頁 | 高亮色票（`HIGHLIGHTER_COLORS`） |
| ocr/crop.js | ocr 頁 | 四角裁切 |
| ocr/upscale.js | auto-preprocess | otsu／行高／縮放 |
| ocr/tile-scan.js | 動態 | 切片掃描 |
| ocr/tesseract-adapter.js | 動態 | 本地 Tesseract |
| ocr/paddle-adapter.js | 動態 | Paddle |

---

## 3. 資料層：表＋settings key 讀寫

### 3.1 表（`db.js` 建表；後端 Rust 側有對應 migration v11–v13）

| 表 | 用途 | 主要讀寫者 |
|---|---|---|
| words（＋decks 欄等；migration 加欄） | 單字本體 | store（add/edit/import）、全部頁面讀 |
| word_images | 單字圖片（word_id 外鍵） | word-image.js（經 db.js `addWordImage` 等） |
| settings（key-value） | 全部開關（下表） | store（48 處 get）＋各頁直接讀 |
| review_log | FSRS 複習記錄 | store rateCard、optimizer |
| audit_log／app-log.db | 操作日誌 | app-log.js |
| examSessions（settings 存） | 測驗歷史 | exam 頁、store |

### 3.2 settings key 讀寫對照（寫者 → 讀者）

**單一寫者（store 內寫，多處讀）**：`buried*`／`suspended*`／`buriedAt*`（6 組×3 模式）、`ankiSettings*`（3 模式）、`deckOrder`、`launcherIcon`、`fieldVisExam`。讀者：學習/測驗頁＋settings 頁。

**頁面直讀（`import('../lib/db.js').getSetting`）**：
- browser.js：`exampleDisplayMax`、`autoFillOrder`
- deck-browser.js：`exampleDisplayMax`、`autoFillOrder`（×2 modal）
- tools.js：`autofillOverwrite`、`exampleDisplayMax`
- ocr.js：`ocr_engine`、`ocrHighlightColor`
- main.js：`launcherIcon`

**store 啟動載入（48 處 get，讀完進 `state.*`）**：`mwDictKey`／`mwThesKey`、`ocrMode`／`ocrRestoreModel`／`graylist`／`blacklist`／`ocrCambridgeVerify`、`fieldVisStudy`／`fieldVisExam`／`fieldVisBrowser*`、`tags`／`systemTags`／`tagConfig`、`ttsVoice`／`ttsSpeed`／`ttsPitch`、`themeMode`／`themeAccent`、`dayCutoff`、`deckOrder`、`examSessions`、`simParams`、`devMode`、`colorPalette`、`logRetentionDays`、`backupIntervalH`／`backupKeepMax`、`maxExamSessions`、`uiHints`、`ollamaUrl`、`examples`／`edits`。

**注意**：`setSetting('字面key')` 在前端是 0 次——寫入全走變數（`stateKey`／`DISPLAY_LIMIT_KEY` 等）或 settings 頁表單。查「誰寫了某 key」要 `grep setSetting`＋變數回溯，不能只 grep 字面。

---

## 4. 自動補齊來源分派（tools.js，韋氏第一、劍橋第二）

組合包 9 欄預設（`_getMethod(id, fallback)`）：

| 欄位 | 預設 | 候選 |
|---|---|---|
| pos 詞性 | cambridge | cambridge／merriam／llm |
| example 例句 | dictionary-api | dict-api／cambridge／merriam／tatoeba／llm |
| pron 發音 | cambridge | cambridge／merriam／llm |
| related 相關詞 | llm | llm／merriam |
| forms 詞形 | merriam | merriam／llm |
| trans 翻譯 | cambridge | cambridge／llm |
| syn 同義 | merriam | merriam／llm |
| ant 反義 | merriam | merriam／llm |
| phrase 片語 | merriam | merriam／llm |

編輯器 sparkle（browser／deck-browser 雙份鏡像）：`llmFillRelated`、`llmFillSynAntDeriv`、`llmFillForms` 皆韋氏優先、無 key 掉 LLM；`mwFillExtra`（音節/字源/片語）、`autoFillAll` 鏈（cambridge→merriam→dict-api→tatoeba→llm，可調序，存 `autoFillOrder`）。

---

## 5. 學習／測驗鏈（FSRS）

```
頁面（study-v4/mc/spell・exam-flip/mc/spell）
 └─ engine/session-{utils,mc-utils,spell-utils,v4}.js（session 狀態機＋queue）
     ├─ core/fsrs.js（review／fuzz／參數，唯一真相）
     ├─ core/scheduler.js（抽卡／shuffle／streak；main.js 也用 computeStreak）
     ├─ lib/store.js（rateCard／undo／bury／suspend 回寫 review_log＋settings）
     └─ lib/tts.js（bindSpeakClick 發音；study/exam 六頁＋兩瀏覽器＋settings 共用）
```

學習/測驗頁**零直接後端呼叫**（invoke 計數全 0），全走 engine＋store 間接層。`optimize_fsrs`（store 用）、`simulate_fsrs`（simulator 頁用）是唯二 FSRS 相關後端。

---

## 6. 前→後端對照（`api.js` wrapper → `lib.rs` command）

| wrapper | command | 讀寫目標 | 前端呼叫者 |
|---|---|---|---|
| fetchLLM | fetch_llm | Ollama（localhost:11434） | tools／browser／deck-browser／ocr |
| fetchGet | fetch_get | 任意 https GET（白名單：http 僅 localhost） | tools／browser／deck-browser／image-url／word-image |
| lookupCambridge | lookup_cambridge | Cambridge 官網 scrape（cambridge_scraper crate） | tools／browser／deck-browser／store |
| lookupMerriam | lookup_merriam | dictionaryapi.com（collegiate＋thesaurus→ithesaurus fallback） | tools／browser／deck-browser（經 merriam.js 解析） |
| scrapeQuizlet | scrape_quizlet | Quizlet（quizlet_scraper crate） | import |
| speakText／speakAndroid／stopAndroid | speak_text／tts_android::* | Piper／Android TTS | tts.js（9 頁經 tts 間接） |
| inspectApkgDialog／getApkgMedia | apkg::* | .apkg 解析 | import |
| importDbDialog／writeDbBytes／export* | import_db_dialog／write_db_bytes／export_* | DB 檔＋系統對話框 | settings／export／import |
| backupDb／listBackups／restoreBackup／deleteBackup／pruneBackups／getDbMtime | backup_* | 備份目錄 | settings（backup-scheduler 觸發） |
| import/exportPiperModel・listPiperVoices | *piper* | TTS 模型 | settings |
| drive*（6 個） | drive_sync::* | Google Drive | settings |
| optimizeFsrs／simulateFsrs | optimize_fsrs／simulate_fsrs | Rust 側 FSRS 計算 | store／simulator |
| setLauncherIcon／getLauncherIcon | icon_android::* | Android launcher | settings／main |
| runCli／getAppPaths | run_cli／get_app_paths | CLI／路徑 | settings（devMode） |

後端呼叫集中度：tools.js 35 處、deck-browser.js 32 處、browser.js 25 處，三頁吃掉九成。

### CSP 白名單（`tauri.conf.json`，擋外連第一線）

- `img-src`：self＋data:＋asset:＋`https:` 全放行（貼圖連結能顯示的前提）
- `connect-src`：self＋localhost:11434＋`api.dictionaryapi.dev`＋`api.tatoeba.org` ——注意**沒有** `dictionaryapi.com`／`dictionary.cambridge.org`（前端直連會被擋，必須走後端 `fetch_get`／`lookup_*` 繞行，這就是 IMGURL1 用 fetchGet 的原因）

---

## 7. 頁面路由（`main.js` lazy import＋`SUBPAGE_PARENT`）

```
study ┬ study-v4／study-mc／study-spell
exam  ┬ exam-flip／exam-mc／exam-spell
browser ┬ deck-browser／tag-manager
tools ┬ import／export／ocr／simulator
settings ┬ app-log
dashboard（獨立主頁）
```

`store.actions.navigate(page)` 切頁；`window.__pageCleanup` 清上一頁監聽。改路由先看 `SUBPAGE_PARENT`（nav 高亮依賴它）。

---

## 8. 改 A 動 B 風險表（修 bug 前必查）

| 改這裡 | 會動到 | 原因 |
|---|---|---|
| svg.js | 20 檔全 app | 圖標＋字卡 HTML 共用 |
| db.js（表結構） | 全 app＋後端 migration | 前後端雙寫 migration（v11–v13 對應）；45 處動態 import |
| store.js（state 鍵／action） | 全部頁面 | 單一真相；`cards`／`cardsMc`／`cardsSpell` 三 Map 並存；DEADCODE1 後 `clearReviewDeckFilter` 已刪（state 欄位保留） |
| word-extra.js（欄位可見度） | 學習/測驗/瀏覽全字卡面 | `visShow`／`cardFaceHtml` 共用；`fieldVis*` 五鍵 |
| merriam.js（parser） | browser／deck-browser／tools＋全部 harness | 純函式牽三頁；改 shape 先跑 verify-mw-* |
| api.js（wrapper 簽名） | 8 檔＋7 處動態 | 後端唯一入口 |
| tts.js（speak 簽名） | 9 檔（學習測驗六頁＋兩瀏覽器＋settings） | 經 bindSpeakClick 間接 |
| core/fsrs.js | 4 engine＋store＋dashboard | 排程唯一真相；Anki 對齊要求 |
| core/scheduler.js | engine＋store＋dashboard＋3 study 頁＋main | queue／streak 共用 |
| engine/session-*.js | 對應學習＋測驗頁（mc/spell 兩用） | mc/spell 引擎學習測驗共用，改一動二 |
| browser.js ÷ deck-browser.js | 彼此（鏡像邏輯） | autoFill／sparkle／圖片三份鏡像，修一處要同步另一處（歷史重災區） |
| tools.js 組合包預設 | 批次補齊結果 | `_getMethod` fallback 改一個影響整批 |
| tauri.conf.json CSP | 全 app 外連 | 加新外連域名要同步加白名單，否則前端直連被擋 |
| lib.rs command 簽名 | api.js＋呼叫頁 | 前後端契約；另有 `src-tauri/tests/f12_download.rs` |

---

## 9. 維修 SOP（以後修 bug 照這走）

1. 症狀定位層：UI→頁面？資料→store/db？排程→engine/core？外連→api＋CSP？
2. 查本表找共用鏈：先列「同函式還被誰用」，一次修全（不要只修報案那頁，browser/deck-browser 鏡像必同步；**批量新增是例外**——只活在 deck-browser，browser.js 故意不加）。
3. 純函式先寫 harness（`tools/verify-*.mjs`，含 stash 反向驗證；新純函式放 `src/lib/*.js` 保持 node-safe）。
4. 全套回歸（十三顆）＋`vite build`＋`node --check` 改動檔。
5. 一結案一 commit＋patch 升版＋tag（`tools/version.sh patch` 三檔一致才過）。

---

## 10. 抽樣命令（重抽本表用）

```bash
R="/home/jupiter/teno 修檢版"
grep -rn "from '\.\." "$R/src/pages/" "$R/src/lib/" "$R/src/core/" "$R/src/engine/" "$R/src/main.js" > /tmp/imports.txt  # 靜態 import 邊（125 條）
grep -rhoE "getSetting\('[^']+'\)" "$R/src/" | sort | uniq -c | sort -rn   # settings 讀
grep -rln "core/fsrs" "$R/src/"                                            # FSRS 引用者
python3 -c "import re;txt=open('$R/src-tauri/src/lib.rs').read();m=re.search(r'generate_handler!\[(.*?)\]\)',txt,re.S);print([p.strip() for p in m.group(1).split(',') if p.strip() and ' ' not in p.strip() and '(' not in p.strip() and '::' not in p.strip()])"  # command 表
```

---

## 11. 關係網外清單（孤兒／死碼掃描，2026-09-11）

> 方法：全 repo `grep` 實測。檔案級：60 個 `src/**/*.js` 逐檔查 incoming import＋路由可達，**零孤兒**。
> 符號級／後端／頂層目錄有抓到以下。

### 11.1 死 wrapper（後端在、前端無人打）

| 符號 | 位置 | 狀態 |
|---|---|---|
| `writeDbBytes` | `src/lib/api.js:112` → `write_db_bytes`（lib.rs:732 在、已註冊） | 前端零呼叫。現行匯入走 `importDbDialog`（settings.js:637）。**v5.17.8 已刪前端 wrapper**；後端 command 保留（f15／f16 釘著註冊表，刪後端會炸 harness）。 |

### 11.2 死導出（定義了、src 內無人調用）

| 符號 | 位置 | 狀態 |
|---|---|---|
| store `clearReviewDeckFilter` | `src/lib/store.js` | src＋tools 全零引用。**v5.17.8 已刪**。注意 `reviewDeckFilter` state 欄位本身還活著（study 三頁＋main 在讀），只刪了 setter。 |
| store `failBackgroundTask` | `src/lib/store.js` | 零呼叫（`start/update/complete/dismissBackgroundTask` 都有人用，唯獨 fail 沒人調）。**不是刪除候選**——失敗路徑本來就該存在，留著是對的；記一筆即可。 |

> **§11 初版誤判更正（v5.17.8 動刀前全量複查抓到）**：以下三項初版列為候選，複查證實活著，**不刪**——
> `ttsAvailable`（`verify-g9-tts-fallback.mjs` 重度依賴：運行時 `m.ttsAvailable()`＋靜態 `bodyOf(CODE)` 釘死 `export function ttsAvailable()`）；
> `setReviewDeckFilter`（`verify-g3.mjs` B1 靜態釘 G3 guard 註解＋代碼，刪了 harness 紅）；
> `enrichOcrWords`（`importOcrText` 內 `await this.enrichOcrWords`，`verify-ocr2-enrich.mjs` 全套覆蓋）。教訓：查死碼必須含 `this.` 同檔調用＋tools harness，否則誤殺。

### 11.3 名存實亡的中轉（有連接、但走旁門）

| 符號 | 實況 |
|---|---|
| `finish_app`／`log_msg`／`save_export_file` | 三個 command 有註冊、有前端呼叫，但**不經 `api.js` wrapper**，直接 `invoke()`（main.js:130／546、platform.js:25／41）。功能正常，風格不一致。改簽名時記得這三處不在 wrapper 表裡。 |
| `extractEnglish`（tts.js:208）、`getFieldVis`（word-extra.js:39） | 只在自家檔案內部用（`bindSpeakClick`／`visShow` 調用）。不是孤兒，不用動。 |
| merriam 內部 helper（`stripMwTokens` 等） | 同檔內用＋harness 測。不是孤兒，不用動。 |

### 11.4 過時路由映射（無害、但會誤導查表的人）

`main.js` `SUBPAGE_PARENT` 裡 `'import': 'tools'`、`'export': 'tools'`、`'tag-manager': 'browser'` 三條已無對應 `navigate()` 路徑——import／export／tag-manager 現為 **settings 頁內嵌 section**（settings.js:14–16 `renderContent` 引入），不是獨立路由。映射表本身無害（查不到就回原值），但修 nav 高亮 bug 時別被它帶偏。

### 11.5 關係網外的磁碟（非 code，但佔空間）

| 路徑 | 大小 | 性質 |
|---|---|---|
| `_local/` | 194M | 舊工作區殘留（artifacts／keys／legacy／ocr-cache／workflows，9/3 起未動） |
| `dist/` | 63M | vite build 產物（可重建） |
| `pkg/` | 41M | 8/2 舊打包殘留 |
| `pkg-src/teno-5.1.0` | 24M | 5.1.0 舊打包源 |
| `_dev/notes` | 小 | 開發筆記（9/10 有動，非孤兒，別刪） |

code 本體無孤兒；要清空間先從 `_local`＋`pkg*` 下手（刪前備份，照你的 git 焦慮慣例）。

### 11.6 重掃命令

```bash
R="/home/jupiter/teno 修檢版"
for f in $(find "$R/src" -name "*.js" | sed "s|$R/||"); do base=$(basename $f .js); hit=$(grep -rlE "from ['\"][^'\"]*/$base\.js['\"]|import\(['\"][^'\"]*/$base\.js['\"]" "$R/src/" 2>/dev/null | grep -v "^$R/$f$" | wc -l); echo "$hit $f"; done | sort -rn | awk '$1==0'  # 檔案級孤兒（頁面經 main.js 動態路由，不在內為正常，須再查 navigate）
grep -rhoE "navigate\('[^']+'\)" "$R/src/" | sort | uniq -c | sort -rn  # 路由可達頁
```

---

## 12. 增量：v5.17.7–v5.17.11（本節是 §1–§11 的補丁，查表先看這裡）

### 12.1 BATCHADD1（v5.17.11）：字本瀏覽器批量新增 —— deck-browser 專屬

```
[批量新增 modal] 全螢幕級（920px/94vw/88vh，筆記本 textarea）
 ├─ lib/batch-add.js（新檔，純函式）
 │    parseBatchInput：[,，、\n;；] 切分→lowercase→去重→WORD_RE 合法性分流
 │    partitionBatch：比對 state.words → existing[]（整批問搬移）／fresh[]（背景新增）
 ├─ openBatchModal(s)：目標字本預設現在字本；分析→兩路按鈕
 └─ runBatchAdd(s, list, targetDeck)：背景任務（start/update/complete＋toast）
      填字來源＝組合包預設逐欄重打（§4 那張表）：
      pos/pron/trans 走 lookupCambridge／example 走 dictionaryapi.dev／
      forms/syn/ant/phrase/derivative/音節/字源走 lookupMerriam＋merriam.js／
      related 走韋氏 related＋LLM（fetchLLM，連不上跳過該欄）
      併發 CON=3，每字 400ms 節流；韋氏 401/429 中止整批
```

依賴邊：`core/import.js normalizePos`（動態 import）＋`api.js` 四 wrapper＋`merriam.js`＋store（addWord／editWord／backgroundTasks）＋`renderInPlace`。
**browser.js 故意不加**（使用者裁示：只有字本瀏覽器有）。harness：`verify-batchadd1.mjs`。

### 12.2 MERGEMOVE1（v5.17.11）：合併彈窗重設計＋保留舊的第二問

- `showDeckMergeModal` 放大 680px，左右卡「現有的／這次新增的」＋字本徽章＋欄位分隔線（同 modal 風格）。
- 保留舊的 → 舊字不在目標字本（`_deckName`）才跳 `showDeckMoveModal`（同風格衍生：否／搬過去，走 `editWord(id, {deck})`）；已在就不打擾。
- 只動 deck-browser；browser.js 的 `showMergeModal` 不動（鏡像慣例在此是例外）。

### 12.3 CARDNEXT1（v5.17.9）：瀏覽器字卡五點

1. 例句區內下一組鈕拔除（word-extra 不再生成 `ex-next-btn`；兩頁刷新簡化為 `el.innerHTML = fmtExample(next)`，正反面全刷；head 鈕保留）。
2. 按下一組不自動發音（`bindSpeakClick` 先查 `ev.target` 是否在 button/input/a/select/textarea／`.ex-next-btn`／`.ex-corner` 內——舊 `el.closest` 查 div 祖先永遠放行，同節點 stopPropagation 也擋不住）。
3. 中文欄不發音（NOSPEAK-CN：`card-panel-def`／`card-panel-desc`／`split-badge` 移出清單；`card-panel-example` 改走 `extractEnglish`，純中文→空→靜音）。
4. 翻卡正面無圖（study-v4 image 改 `isAns` 才渲染）。
5. 圖上字上（study-v4／mc／spell＋exam-flip／mc／spell 六頁 image slot 移到 `study-word-row` 之前；browser 卡本已在上方）。
- 舊 harness 同步：batch5 區內鈕斷言改「已拔」＋tapflip1 T3/T4 改新 selector 語意。harness：`verify-cardnext1.mjs`。

### 12.4 MWKEYLAYOUT1（v5.17.10）：韋氏 Key 欄窄螢幕破版

- 兩列加 `flex-wrap:wrap`＋input 加 `min-width:0`（`flex:1` 無最小寬在手機寬度撐破容器，看起來像破圖；圖標本身正常）。
- 純 settings.js 兩行 style；學習卡圖片位置 v5.17.9 已就位，本版免動 code。

### 12.5 DEADCODE1（v5.17.8）：真死碼兩處＋§11 誤判更正

- 刪：`api.js writeDbBytes` wrapper（後端 command 保留，f15/f16 釘註冊表）＋store `clearReviewDeckFilter`（state 欄位保留）。
- §11 初版誤判三項證實活著、不刪：`ttsAvailable`（verify-g9 雙重依賴）、`setReviewDeckFilter`（verify-g3 B1 靜態釘）、`enrichOcrWords`（`importOcrText` 內 `this.` 調用）。備份分支 `backup-pre-deadcode`。

### 12.6 風險表補充（§8 追加）

| 改這裡 | 會動到 | 原因 |
|---|---|---|
| batch-add.js（WORD_RE／分隔符） | 批量新增解析＋verify-batchadd1 | 純函式牽 modal；改正則先跑 harness |
| runBatchAdd 來源分派 | 批量新增整批結果 | 與 §4 組合包預設同語意但**各寫一份**（未抽共用），改一邊記得對另一邊 |
| showDeckMergeModal／showDeckMoveModal | 單字新增合併流程 | deck-browser 專屬；browser.js 那顆是另一份 |
| tts.js selector 清單 | 全 app 點讀發音 | CARDNEXT1 後中文欄靜音是刻意的；加新可發音 class 要同步改 tapflip1 harness |
| word-extra 例句區結構 | 兩瀏覽器字卡刷新 | 區內鈕已拔；刷新假設「例句區無鈕」，加回去會雙鈕重現 |
### 12.7 AUTOFILL-ENGINE1（v5.17.14）→ ENGINE2 接滿 → ENGINE3 全走引擎（本版 v5.17.16）
- ENGINE1：組合包 fillWord＋批量 fillOne 共用 fillWordFields。
- ENGINE2：九張獨立卡韋氏分支經 `_mwFillOne` 走引擎（pos 保留 nosug 語意，errors 通道新回傳）；兩編輯器十顆 sparkle 韋氏分支經 `_engineMw` 走引擎（LLM 兜底不動；mwFillExtra 單次 fetch 三欄，片語以空底取新句走 ExampleAppend）。
- ENGINE3：三顆例句鈕整條 chain 走引擎（merriam 步＝phrase 併例句，deck 取首句未收錄／browser 經 norm 取新句＋來源 toast，皆同舊；deck 兩鈕照舊無 llm 路）；`_engineMw` fetchers 補齊 getCamEn＋llmText（getMw 單次快取，threshold 預設全開）；三處 modal 音節列新增獨立 sparkle（deckAddFillExtra／deckEditFillExtra／btnFillExtra→既有 mwFillExtra）；g/s 提升 modal 層（fGet/fSet 避開 modal 參數 s，autoFillAll 內 alias 回來呼叫點不動）；引擎 Cambridge 分支正規物件形例句（免 [object Object] 灌 chip，E2b 鎖）。
- 故意不接：autoFillAll 鏈編排層（調的已是接線後的 sparkle，傳遞受惠）、Cambridge／LLM／dict-api／tatoeba 獨立卡分支（非 MW 解析層，無一致性問題）、OCR 入庫 Cambridge 管線（store 層入庫語意，動它風險大於收益）、批量 runBatchAdd 的 mwLookup（本來就是引擎的 fetch 層）。
- 語意修正（只多不砍方向）：相關詞卡補上 synonym 字串 union（與組合包／批量／編輯器一致）；片語卡覆寫模式去重（舊行為會寫入重句）；mwFillExtra 音節／字源改只填空欄（註解本來就這麼寫，舊程式會蓋掉已填值）。
| autofill-engine.js（欄位分派＋errors＋E2b 物件形正規） | 組合包／批量／八卡／十三 sparkle＋三音節字源鈕 | 改來源語意只動引擎；harness E9/E9b 鎖接線覆蓋 |

- 新檔 `src/lib/autofill-engine.js`（node-safe，只 import core/import.js）：
  欄位表 12 欄（`AUTOFILL_FIELDS`，字源/音節/衍生 fixed 韋氏）＋
  `DEFAULT_METHODS`（組合包 11 欄）＋`BATCH_METHODS`（批量 12 欄，related 走 merriam+llm 雙併）＋
  純函式（count/dedup/mergeComma/mergeExamplePhrases/posToks/isBareWord）＋
  `fillWordFields`（逐欄分派，LLM raw/JSON 雙通道，quota 中止回傳）。
- 組合包 `fillWord` 改調引擎（getMw suggest 快拋、usedRemote/aborted 語意沿用；
  M 加字源/音節固定韋氏；_isBare＋CN＋UI 從九欄→十一欄）。
- 批量 `fillOne` 改調引擎（exampleMax 3 沿用舊 cap；related 多併 synonym union，屬只多不砍）。
- 編輯器 sparkle（llmFill*/mwFillExtra）與 autoFillAll chain 維持薄包裝，未收（使用者裁示功能只多不砍，行為零刪）。
- 舊 harness 同步：mwkeys1-forms 詞形分支斷言改指引擎。
- harness：`verify-autofill-engine1.mjs` 33/33（stub 零網路＋HEAD 反向）。
