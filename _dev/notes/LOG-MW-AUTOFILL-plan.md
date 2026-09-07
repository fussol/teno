# 自動補齊＋日誌＋韋氏 計畫書（LOG-MW-AUTOFILL）

> 使用者拍板（2026-09-07）：①日誌 txt 匯出搬到 app-log 頁、設定頁刪除
> ②捆包照舊（TENOC 容器、匯出＋匯入都通、加大小守門）③覆寫＝整欄取代＋
> 無視門檻、一個全域開關 ④韋氏 key 自備兩把、存設定頁
> ⑤同反義重用單數欄、只加 etymology/syllables/phrases
> ⑥語音先只存文字＋編號。
> 基線：修檢版 main `cdc602f`（v5.13.0）。Rust 現行 migration 到 v12，
> 本波新欄用 v13。

## 0. 參考（出处記名）

1. **HannoZ / MerriamWebster.NET**（GitHub, MIT 客戶端）：
   API 基址 `https://www.dictionaryapi.com/api/v3/references/`、
   產品路徑 `collegiate`＋`thesaurus`（另有 medical/learners/sd2/sd3/sd4/
   ithesaurus/spanish）；音檔基址
   `https://media.merriam-webster.com/audio/prons/`、
   規則 `en/us/{mp3|wav|ogg}/{subdir}/{audio}.{fmt}` 全小寫，
   subdir＝首字（`bix`→bix、`gg`→gg、數字/`_`→number）——見
   `Parsing/AudioLinkCreator.cs`＋`Configuration.cs`。本波只存編號，
   播放后續直接套此規則（已驗證，不用再查）。
2. **fluencer / dictionary-cli-app**（作者 Vidhyalakshmi Sundara Raman）：
   `merriam.py` 示範 `collegiate/json/{word}?key=` 直調＋`shortdef` 取義、
   `fl` 取詞性、`def[].sseq` 挖 `vis[].t` 例句、`meta.id` 對詞、
   key 放獨立 `keys.txt`（呼應本波「key 存設定頁」）。`lookup.sh` 只是
   `python3 merriam.py $word | less` 薄包裝。
5. **NdYAG / mw-dict**（Node.js wrapper，TS）：`src/walkers.ts` 走舊 XML
   格式（`dtWalker`/`buildHierarchy`/`sx`同義、`vi`例句），現行 JSON API
   下參考價值低，僅確認 `sseq→dt→vis`  extraction 語義一致；附帶
   `__mocks__` 有 TEST_ETYMOLOGY/TEST_SOUND/TEST_THESAURUS 可作 fixture
   靈感。`demo/cli.js`＋`demo/server.js` 只是呼叫殼。
6. **robludwig / MerriamWebsterAPI**（Python demo）：同 `collegiate/json/
   {word}?key=` 直調（與 fluencer 一致），無新增解析邏輯，僅雙重確認
   endpoint 形狀。
7. **by-zhang / M.Webster-Dictionary**（MIT，220k+ 詞，Lingoes `.ld2` 經
   librehat/kdictionary-lingoes 轉出）：單檔 `mwdictionary` 57,673,925
   bytes，實測 schema **只有** `{entry, func, def}` 三鍵（head＋range 抽樣
   確認，無發音/例句/字源/同反義/音檔），按 entry 排序，`%%%`＝換行。
   → 離線包只能覆蓋 pos＋definition；發音/例句/字源/同反義/片語/語音
   仍需在線 API。嵌入方案：APK 直帶＋57MB 且 WebView `JSON.parse`
   必 OOM——改建置期轉 SQLite（word 主鍵索引）＋首次使用時下載到
   app 資料目錄（APK 保持精瘦）；SQLite 查詢走現有 plugin-sql。
3. **Merriam-Webster 官方 JSON 文件**（dictionaryapi.com/products/json，
   403KB 全文已拉回實錘）：`hwi.hw`（音節點 `·`/`*`，例 agonise→
   `ag*o*nise`）、`hwi.prs[].mw`＋`sound.audio/ref`、`fl`、`def.sseq`
  （`dt`/`vis`）、`et`（字源文本）、`date`（首次使用，可併字源顯示）、
   `syns[].pt`（同義辨析長文）、`dros[].drp+def`（片語 run-on）、
   `uros`、`shortdef`；Thesaurus 側 `meta.syns/ants`＋`syn_list/ant_list/
   phrase_list/rel_list`。
4. **Tesseract 官方 ImproveQuality／Multigrid／tesseract.js／OpenCV**
   沿用 OCR3-optimize-plan §2（本波不動 OCR）。

## A. 日誌 txt 匯出搬家（設定頁→app-log 頁）

- 現況：`runExportAppLog`（settings.js:552-571）＋按鈕（:416）＋綁定
  （:1253）＋import（:13）；`app-log.js` 頁只有 sims＋logs，無匯出鈕；
  工具頁入口 `toolsGoAppLog` 僅 devMode 渲染（tools.js:61）——搬家後
  devMode 門檻不變（拍板只搬不開放）。
- 修法：app-log.js render 加匯出行（txt 匯出鈕；B 段再加捆包鈕）＋
  onMount 綁定＋`runExportAppLog` 整段搬過去（import：api.js
  `exportAppLogText`、app-log.js `checkpointAppLog`、platform.js
  `downloadBlobFromArray`＋`isAndroid`、toast）；settings.js 刪按鈕＋
  函式＋綁定＋import 內 `exportAppLogText` 一項。
- 驗證：`node --check` 兩檔；ID 差分（刪 `exportAppLogBtn`、加
  `applogExportTxtBtn`）；vite build。

## B. 捆包匯出（TENOC db＋log）＋大小守門

- 現況實錘：`pack_db_container(dir, include_log)`（lib.rs:567）、
  `unpack`（:584，v1＋純 sqlite fallback＋D16 三斷言）、
  `write_db_container`（:626，雙檔＋刪 wal/shm）、`import_db_dialog`
  （:651，已吃容器）全在；`export_db_data` 寫死 `false`（:1540-1546，
  1d1c172 故意拆，Android WebView 15MB＋ IPC/btoa OOM）；內部
  backup/restore 只管 teno.db（:1371/1496）。
- 修法：新增 `export_db_bundle_data`（`pack_db_container(&dir, true)`）
  ＋handler 註冊＋api.js wrapper；app-log 頁加「匯出完整備份」鈕：
  先 `checkpoint()`＋`checkpointAppLog()` 再取位元組，大小＞50MB 先
  confirm 警告（拍板守門）；桌面走 `export_db_dialog` 式存檔對話框
  另開 `export_bundle_dialog`（filter `.db`），Android 走
  `downloadBlobFromArray`（沿用 96ed927 chunked base64 路徑）。
  匯入不動（已吃容器）＋harness 驗 `unpack(pack(true))` round-trip。
- 不做：backup/restore 改容器（維持 teno-only；拍板「匯出＋匯入通就好」）。

## C. 全域覆寫開關＋五路取代語義

- 現況：pos-Cambridge 合併（tools.js:410-415）、pos-LLM/發音/相關詞/
  詞形只做缺失、例句看 threshold（:502/551/592）。開關：
  `autofillOverwrite`（db setting，預設 false），UI 放自動補齊家族頭。
- 修法（tools.js 內）：開＝pos-Cambridge 直接蓋（不合併）、其餘四路
  全量重跑、例句無視 threshold/count 全取；關＝現行不動。
  LLM 路重跑＝token/時間成本，toast 加註「覆寫模式」。
- 驗證：靜態斷言（開關讀寫＋五路分支各一）＋`node --check`。

## D. 韋氏來源＋三新欄＋卡背

- 設定頁：`mwDictKey`＋`mwThesKey`（password input，存 db setting，
  跟 ollamaUrl 同級；免費各 1000 次/天，超額 API 回 429→toast 提示）。
- Rust：`lookup_merriam(word, dict_key, thes_key)`（ureq GET
  `collegiate/json/{word}?key=`＋`thesaurus/json/{word}?key=`，
  15s timeout，參照 lookup_cambridge 模式；key 空→Err；回傳合併 JSON）
  ＋handler 註冊＋api.js wrapper。音檔：只存 `sound.audio` 編號，
  不組 URL（規則已驗證，播放后續）。
- 解析（JS，前端做，dictionaryapi CORS 有開；失敗回退 Rust fetch_get）：
  shortdef→definition（覆寫語義走 C 開關）、fl→pos、prs[0].mw→pron、
  sseq vis→example、et（＋date 併「首次」）→etymology、meta.syns/ants
  ＋syn_list/ant_list→synonym/antonym（重用單數欄）、dros drp→phrases、
  hw 去 `·`/`*`→syllables。
- Schema（migration v13，Rust＋db.js migrate 雙寫）：words 加
  `etymology TEXT ''`、`syllables TEXT ''`、`phrases TEXT ''`；
  單數 synonym/antonym 由 Rust 補（JS 早有，Rust v1 無——本次順手對齊，
  空字串預設）；saveWord（db.js:185）欄位列表同步；store.editWord
  透傳（spread 已通，零改）；import/export（export.js:81、import.js）
  加三欄；browser.js＋deck-browser.js 編輯器加三輸入；學習/測驗六頁
  卡背渲染（study-v4/mc/spell、exam-flip/mc/spell）＋browser/deck-browser
  詳情。
- tools 自動補齊：pos/example/pron/related 四卡來源選單加「韋氏字典」
  選項（related 用 Thesaurus syns；forms 維持 LLM，無屈折來源）。
- 驗證：harness（fixture JSON→解析斷言＋負控制拔 key）；cargo check；
  browser 實跑（有 key 才跑，無 key 跳過並註記）。

## 風險／範圍外

- MW 超額 429／key 錯 401→toast 明示，不靜默吞。
- 播放、透視校正、OSD、多框、PDF：不做。
-  commit 拆：A＋B 一顆（日誌家族）、C 一顆、D 一顆（大顆，含 migration
  v13）；各 bump minor/patch 照 version.sh。
