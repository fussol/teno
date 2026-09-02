# E16 修復計畫書 v1.1（2026-08-28，首相2／PM2 域；R1 ✅ 吸收升版見 §7）

## 1. Bug 定義（實錘 2026-08-28）
三個死檔殭屍滯留 src/（git ls-files 全在來追蹤）：
1. `src/lib/deprecated/sim-engine.js`（14,970B）— E8 波次已定性：官方
   fsrs-rs simulate_fsrs 取代（c461727 搬入 deprecated 隔離），全庫零活引用
   （唯一文字命中=tools/verify-e8-selftest.mjs 負控制模板字串＋負控制斷言
   本體，屬「以消失為斷言」的測試產物豁免；_dev/cli 隔離舊版豁免）。
2. `src/lib/themes.js`（1,603B）— THEMES 調色盤死數據：全庫 `lib/themes`
   grep 零 import（exit=1 實錘）。主題系統現行實現不走此檔。
3. `src/pages/svg.js`（2,115B）— icon 死分裝層：全庫 import 全指向活本體
   `src/lib/svg.js`（exam-session/import/study*/tag-manager/tools 等 9+ 處
   逐一覆核皆 '../lib/svg.js'），`pages/svg` 零 import 者。

## 2. Root cause
演算法/圖標/主題三代重構（官方 fsrs-rs、Lucide 集中 lib/svg.js、場景色群
主題系統）搬移時只改引用端未刪舊檔，死碼沉積（E8 教訓的存量面）。

## 3. 修法
`git rm` 三檔。連帶處置：
- `src/lib/deprecated/sim-behavior.js`（7,612B）：唯一 import 者=sim-engine
  （:13），sim-engine 刪後淪為孤兒之孤兒。**白名單外**（任務書僅列三檔）
  → 依鐵律⑦登 scope-requests（E16-SR1）不逕刪，本波保留。
- 可選項定案（憲法⑦）：(a) 順手刪 sim-behavior？**不做**（白名單鐵律）。
  (b) verify-e8 T4b 掃描是否需更新？**不需**——walk() 本就跳 deprecated
  目錄，且斷言方向=「引用零殘留」，刪檔只讓斷言更真。(c) E8 負控制依賴？
  **不依賴**——其 T3 重建的死路徑是 `src/lib/sim-engine.js`（E8 時代原路徑，
  早已不存在），與本次刪除的 deprecated/ 路徑無關，刪後 e8 驗證不受影響
  （T1a/T4 皆反向斷言，零命中恆綠）。

## 4. 驗證方式（tools/verify-e16-orphan-deletion.mjs，雙態自適應）
- T1 零引用前提釘（刪前刪後都必須綠＝安全刪除的充要證據）：src/**.js（跳
  deprecated）、tools/*.mjs（豁免 verify-e8/verify-e16 自身——以消失為斷言
  的測試產物）、index.html：零 `lib/themes` import／零 `pages/svg`／零
  sim-engine import 語句。
- T2 存在態偵測＋殲滅釘：修法版→三檔 existsSync=false；原版模式→存在＋
  讀檔正則釘導出符號實證非空殼（R1 次要#1：不刪前動態 import——pages/svg.js
  經 lib/svg.js 的 lucide `?raw` import，Node ESM 必拋 ERR_UNKNOWN_FILE_EXTENSION，
  非 vite 環境不可 import，「刪前 import 成功」斷言不可行）。
- T3 動態 import 殲滅釘＝錯誤碼雙態判別子（R1 次要#1 建議 b）：刪後三
  路徑 import 皆 ERR_MODULE_NOT_FOUND＝真從磁碟消失（防「留空檔假刪」——
  空檔 import 會成功而非拋 NOT_FOUND，判別子天然捕捉此態）；刪前模式
  themes/sim-engine import 成功、pages/svg 拋 ERR_UNKNOWN_FILE_EXTENSION
  （檔在才會走到 extension 階段＝存在性副證）。
- T1b glob 盲點豁免註記（R1 次要#3）：main.js:70 `import(\`./pages/${name}.js\`)`
  模板字串＝vite glob，靜態文字 grep 有天然盲點；現況 dist 確把 pages/svg.js
  打成死 chunk，但 'svg' 不在 PAGE_NAMES、無 loadPage('svg')（R1 實錘），
  刪後 glob 自動收斂零 breakage。此面充要驗證＝vite build 必測（§5 升格）。
- T4 歷史真實性釘：`git log --oneline -1 -- <path>` 三檔皆有歷史（證刪除
  對象曾真實存在，非刪不存在檔的空轉）。
- T5 白名單邊界釘：sim-behavior.js 本波**必須仍在**（防順手多刪）＋其檔內
  對 sim-engine 的引用僅在自身被刪後才孤兒化（scope-request 已登）。
- T6 消費端零波及釘：lib/svg.js 活本體存在＋導出 icon/icons/splitFieldsHtml/
  fmtExample；分裝層独有符號 `SVG`（R1 次要#2 修正：lib 版**沒有** SVG，原
  「符號全在活本體」措辭不實）→ 改釘 `SVG` 全庫零導入者（import 式樣 grep
  零命中）＝刪分裝層無符號真空。另登記：分裝層的 splitFieldsHtml/fmtExample
  係自作主張第二份實作（非代理），消費端 import 全指 lib 版、從未被-pages
  版餵過 → 刪後零行為變化。

## 5. 風險
- 未來有人「找回」死檔引用＝無（git 歷史永在，要找回 `git checkout <sha> -- 路徑`）。
- **vite build 必測**（R1 次要#3：glob 動態 import 面的充要驗證，刪檔若有任何
  殘存 import/glob 失配立刻炸）＋回归義務全套（node --check、既有 verify 集）。

## 6. 範圍外清單（憲法⑥）
- sim-behavior.js 刪除 → E16-SR1 scope-request（PM2 域，待總統裁示）。
- deprecated/ 目錄本身是否保留 → 隨 sim-behavior 命運，另案。
- _dev/cli/ 死碼雙胞胎清理（白名單禁碰，既登）。

## 7. 審查紀錄
- **R1（1 委員，simple 單席）✅ 准行**（0 阻斷／3 次要／2 nit，全吸收升版 v1.1）：
  - 獨立穷举三檔引用面（動態 import/new URL/Rust include_str/py/sh/cron 全型別）
    皆零活引用；兩豁免（verify-e8 負控制模板字串、_dev/cli）開檔覆核成立且後者
    理由更強（指向原路徑早已死）。
  - 次要#1：T2/T3「刪前動態 import 成功」對 pages/svg.js 不可行（lucide `?raw`
    → ERR_UNKNOWN_FILE_EXTENSION）→ 採建議 b 錯誤碼雙態判別子（實跑兩態皆證）。
  - 次要#2：`SVG` 符號 lib 活本體**沒有**，原「符號全在活本體」措辭不實 → T6
    改釘 SVG 零導入者（實跑零命中）＋第二份實作登記。
  - 次要#3：main.js:70 模板 glob＝靜態 grep 天然盲點，dist 曾含 svg 死 chunk →
    vite build 升必測＋glob 收斂釘；實測刪後 import map 與 chunk 雙消。
  - nit#1 _dev/cli 豁免理由補強、nit#2 `lib/themes\b` 精確式防 theme.js 近親誤傷
    （掃描式樣已用）、nit dist 二進位排除（teno-5.1.0 入 SKIP_DIRS）。
  - 義務5 親跑 verify-e8 18/18 綠＋刪後推理恆綠（T3 死路徑=E8 時代原路徑與
    deprecated/ 無關）；義務6 sim-behavior 走 SR 同意（白名單鐵律唯一合規選項）。
- §6b 首相誠實登記：初跑測資自傷×2（find 括號未 escape shell；'svg.js' 短名
  誤咬 lucide-static 錯誤訊息中的 lib/svg.js → 判別子改完整相對路徑），產品碼
  零改；vite build 必測 glob 面收斂實證（map+chunk 雙消）。
