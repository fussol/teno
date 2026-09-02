# R2 複審報告 — 委員#B（新幻覺偵測）：OCR-plan-v1.1.md

审查日期：2026-08-28 ｜ 基準：HEAD e23e6f7 ｜ 方法：逐引用 grep 實碼 + node --check 語法校验（唯讀，未改任何代碼）

## 總判定：❌ 退回（有 2 項 ❌ 阻擋級 + 多項 ⚠️）

幽靈引用問題相較 v1.0 已大幅改善（多數符號實存），但 §6「完整窮舉」仍未達「每一行都要寫好」標準，且 §0 對照表與第6章內容自相矛盾。

---

## 1) 符號/路徑/設定鍵逐一核對

### ✅ 通過項（實碼證據）
| 計畫引用 | 實碼證據 |
| :--- | :--- |
| `icon('check')`（§4.1 HTML） | src/lib/svg.js:107 `check: () => S(checkRaw),` ✅ |
| `icon('camera')`（新增，合法） | svg.js 無 camera（合法新增）；`node_modules/lucide-static/icons/camera.svg` 實存（已驗證檔案存在）✅ |
| `window.__TAURI__?.core === 'object'`（M5/§4.2） | src/lib/platform.js:5 `export const isTauri = typeof window.__TAURI__?.core === 'object';` — 與專案慣例字字相符 ✅ |
| `store.addWord` | store.js:1180 ✅（§5 僅聲明「嚴禁直呼」，存在性成立） |
| `store.importWords` | store.js:1214 `async importWords(words, onProgress)` ✅；內含去重（Set, :1216）、自動建 Deck（:1234-1237 `this.createDeck(deckName, color)`）、單一交易（:1270 `BEGIN TRANSACTION`/COMMIT/ROLLBACK）— §0-L4「內建去重、交易與自動建 Deck」三宣稱全部屬實 ✅ |
| `saveWordsInTx`（§5 禁呼對象） | db.js:205 `export async function saveWordsInTx(words)` ✅ |
| `tools.js` `render(s)` / `onMount(s)` | tools.js:5 / tools.js:237 ✅ |
| 插入點「Generate Forms 與 Cambridge 之間」 | tools.js:190 `<!-- Generate Forms -->`、:203 `<!-- Cambridge Dictionary -->` — 兩-section 界線實存、順序相符 ✅ |
| CSS 類 `section/section-title/config-section/tool-output/btn/btn-sm` | base.css:620 `.config-section`、:728 `.tool-output`、:603 `.btn-sm`；section/section-title/btn 於 tools.js/base.css 大量使用 ✅ |
| CSS 變數 `--s2/--s3/--text-tertiary/--text-secondary` | base.css:64 `--s2: 8px; --s3: 12px`、:19-20 text-secondary/tertiary ✅ |
| `teno.db`（§8 驗收） | db.js:14 `Database.load('sqlite:teno.db')` ✅ |
| `lucide-static` 依賴（cameraRaw 來源） | package.json:23 `"lucide-static": "^1.28.0"` ✅ |
| `vite.config.js` 路徑 | 檔案實存 ✅（但見 F3：§6 清單與 §0 矛盾） |
| CSP 位置與現值（§6.5） | tauri.conf.json:27 `"csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; ..."` — 計畫新值與現值逐字比對，差異僅在 script-src 加入 `'wasm-unsafe-eval'`，其餘逐字相同，非幻覺 ✅ |

### ❌/⚠️ 失敗項

**F1 ❌（阻擋）— §6.1 svg.js 缺 `import cameraRaw ... ?raw` 這一行（違反「每一行都要寫好」）**
- 計畫 §6.1 只寫：`camera: () => S(cameraRaw), // 引入 lucide-static camera svg 原始碼`
- 實碼 svg.js:8-37 的現行模式是 **ESM import**：`import homeRaw from 'lucide-static/icons/home.svg?raw';`（共 30+ 行皆如此，非行內字串常量）。
- 照計畫字面執行，`cameraRaw` 是未定義識別符 → `ReferenceError`。「引入 lucide-static」屬注释性空話，**未貼出實際要新增的 import 行**（也不需要貼 raw 字串本體，現行模式本来就靠 `?raw` import 帶入）。依 v1.0 退回同款標準，此為 M4「修改清單不全」的殘留變體 → ❌。
- 修法：§6.1 需明文補 `import cameraRaw from 'lucide-static/icons/camera.svg?raw';`（建議插於 svg.js:17 checkRaw 之後）。

**F2 ❌（阻擋）— §0-L4/L6 宣稱 §6 窮舉含 `vite.config.js`，實查第6章五大檔案清單根本沒有 vite.config.js（文件內部矛盾）**
- §0 L4：「第6章完整窮舉：tools.js、svg.js、package.json、**vite.config.js**、tauri.conf.json 五大檔案」；L6：「於第6章補齊 package.json 與 **vite.config.js**（WASM/Worker 資產打包）」。
- 實查第6章小節：1=svg.js、2=store.js、3=tools.js、4=package.json、5=tauri.conf.json。**vite.config.js 缺席**（被 store.js 頂替）；§8 P1 交付物清單亦無 vite.config.js。
- 後果非純文字問題：Tesseract.js 離線化必須指定 `workerPath/corePath/langPath` 指向本地打包資產（CSP 已是 `default-src 'self'` 且計畫明示「離線打包在本地」），這正是 L6 號稱已補的 vite 打包規範——实际上**一行都沒寫**。參照現有慣例 vite.config.js:16-18 `optimizeDeps.exclude: ['onnxruntime-web', '@huggingface/transformers']`（同類 WASM 依賴的既有處理先例），計畫連要仿此 exclude/asset 處理的指示都缺失 → 純前端離線路線目前不可執行 → ❌。

**F3 ⚠️ — 負控制 B 預期「回傳 added=0」與 importWords 實碼行為矛盾**
- 計畫 §7：「Mock 拋錯 → 預期觸發 Rollback，回傳 added=0」。
- 實碼 store.js:1241-1297：`added++` 在迴圈內先遞增，交易失敗僅 `ROLLBACK + console.warn`（:1274-1277），函式仍回傳 `{ added, skipped, decksCreated }` 且 **added 為已遞增值（>0）**；state.words 亦已 push、不回滾。故現行 importWords 在 DB 失敗時回傳 added>0，計畫的驗收斷言照字面做會必紅；若要在 importOcrText 層達成，計畫需明確寫出（例如改由 importOcrText 檢查交易結果或 importWords 需回傳 txOk），目前未寫 → ⚠️（驗收標準與被複用函式的真實語意不一致）。

**F4 ⚠️ — 正則宣告與程式碼不一致 + 長度描述 off-by-one**
- §5/§0-L8 規範 `/^[a-z][a-z'-]{1,30}$/i`（含 `i` 旗標）；§6.2 實碼片段為 `/^[a-z][a-z'-]{1,30}$/`（無 `i`）。因前面已 `.toLowerCase()` 功能上等價，但兩處規格不同字 → ⚠️ 應統一。
- 兩處都宣稱「長度 2 至 30」；正則實際允許 2–31 字元（首字元 + {1,30}）→ 規格文字 off-by-one ⚠️。

**F5 ⚠️ — §4.2 代碼块宣告「能力偵測與來源分支」但無分支且偵測值是死變數**
- `const isTauri = ...` 宣告後從未使用（node --check 通過但 lint 死碼）；函式只無條件 `getElementById('ocrFileInput').click()`。宣稱「來源分支」未實踐。另專案慣例其實是 `import { isTauri } from '../lib/platform.js'`（platform.js:5 已匯出），代碼块選擇複製內聯表達式而非 import 既有單例 → ⚠️。
- 附帶事實核對：tauri.conf.json 全檔無 `withGlobalTauri`，原始碼路徑無 with_global_tauri/initialization_script → 桌面端 `window.__TAURI__` 是否注入存疑（R1 M5 原題根源未根治，只是改寫成「與 platform.js 相同」的寫法）；因該變數在 §4.2 未使用，不阻擋但登記 ⚠️。

**F6 ⚠️ — 功能清單與 §6 檔案清單仍有縫隙**
- 第1章電腦端流程宣稱「剪貼簿貼上（Ctrl+V）」與「Bounding Box 預覽」；§6.3 綁定清單只有 4 個 id（captureBtn/fileInput/selectAllBtn/confirmBtn），無 paste 監聽、無 bbox 渲染元素/代碼归屬。
- 五檔清單中沒有任何檔案承接 Tesseract 引擎載入/辨識呼叫本身（§6 僅有 UI、store 入庫、依賴宣告）；`handleOcrCapture` 只 `click()` file input，change→FileReader→recognize→候選渲染鏈路完全無歸檔無代碼 → 對「完整窮舉」的 M4 修復而言仍屬不完整 ⚠️（若座談會定性為阻擋即升 ❌）。

## 2) §6 各代碼區塊語法校验 + 參數對齊
以 node --check 實測（包殼後）：
- §6.1 `camera: () => S(cameraRaw),` — 語法 OK；但見 F1（cameraRaw 無來源）。
- §6.2 `importOcrText` 块 — 語法 OK（含預設參數、可選鏈合法）。對齊檢查：`this.importWords(parsed)` 傳 **1** 個參數 vs 實碼 `importWords(words, onProgress)`（store.js:1214）— onProgress 於迴圈內皆以 `if (onProgress)` 守衛（:1228/:1264）→ 可省略 ✅；parsed 元素 `{word, definition, deck}` 欄位名與實碼讀取的 `src.word/src.definition/src.deck`（:1227/:1242/:1233）對齊 ✅；`this` 綁定合法（importWords 本身即用 `this.createDeck`，同為 actions 物件方法）✅。
- §4.2 `handleOcrCapture` — 語法 OK（死變數見 F5）。
- §4.1 HTML 骨架 — div 開閉計數平衡（4 開 4 閉逐層核對 ✅）；`icon('camera')/icon('check')` 與 tools.js 模板字串用法一致；插於 render(s) 模板內合法。
- §6.4 `"tesseract.js": "^5.1.0"` — 合法 package.json 片段；v5 確為 tesseract.js 實際存在的大版本（本次離線未查 npm registry，登記為「待驗證版本存在性」而非幻覺指控）。
- §6.5 CSP 字串 — 合法 JSON 值；與現值 diff 僅加 `'wasm-unsafe-eval'` ✅。小提醒 ⚠️：Tesseract.js Worker 若走 blob: URL，僅靠 script-src 'wasm-unsafe-eval' 未必夠，可能需 `worker-src blob:`（計畫未討論，建議補驗證）。

## 3) cameraRaw 判定（任務指定問題）
**判定：違反。** §6.1 僅寫「引入 lucide-static camera svg 原始碼」註解而未貼實際要新增的 import 行，不符svg.js現行 `import xRaw from 'lucide-static/icons/x.svg?raw'` 模式的全行列舉要求 → 併入 F1 ❌。（註：現行模式是 `?raw` ESM import，計畫不需手貼 SVG 字串本體，但 import 行本身是「要新增的每一行」。）

## 4) 第9章 vs v1.1 前8章矛盾檢查
**判定：✅ 無過時矛盾。** 逐條核對 v1.1 第9章（:205-211）：僅含 APK 體積/記憶體、準確率預期、範圍外聲明三項，與純前端路線相容；**未**提及 Tauri fs 權限、Cargo.toml、capabilities 或 `recognize_image` 等 v1.0 遺留敘事（對照 `_dev/notes/OCR-plan.md` 第9章原文，內容逐字一致且恰好不含權限風險條目）。「全走端側離線辨識」與第1/8章一致；「Tesseract traineddata 體積」與第2/3章 Tesseract.js 推薦一致。小噪點 ⚠️：第9章開頭宣稱「R2 複審確認仍適用」——本席（R2）此刻正在審，文書時序上自我矛盾，屬占位文字未清理。

## 其他登記
- 文件內殘留兩行 `session_id:`（:198, :213）與 v1.0 相同格式髒字，建議正式版移除 ⚠️。

## 結論
| # | 嚴重度 | 摘要 |
| :-- | :-- | :-- |
| F1 | ❌ | §6.1 缺 `import cameraRaw ... '?raw'` 行，cameraRaw 為未定義引用 |
| F2 | ❌ | §0 宣稱 §6 含 vite.config.js 窮舉，§6 實際無此節；WASM/Worker 離線打包規範零行代碼 |
| F3 | ⚠️ | 負控制 B「added=0」與 importWords 實碼（失態回傳 added>0、記憶體態不回滾）矛盾 |
| F4 | ⚠️ | 正則 /i 旗標兩處不一致；「2–30」長度描述 off-by-one（實為 2–31） |
| F5 | ⚠️ | §4.2 isTauri 死變數、無分支；未沿用 platform.js isTauri 匯入慣例；withGlobalTauri 未開之源問題未議 |
| F6 | ⚠️ | Ctrl+V、Bounding Box、Tesseract 載入/辨識鏈路在五檔清單中無歸屬 |
| — | ✅ | check/camera icon、__TAURI__ 偵測式、addWord/importWords/saveWordsInTx/CSP:27/teno.db/onMount/render/插入點/全部 CSS 類與變數 — 實存且相符 |
| — | ✅ | §9 併入章與 v1.1 前 8 章無矛盾（未談 Tauri fs，不過時）；唯「R2 複審確認」占位語需改 |

**建議裁定：退回 PM-OCR 補 F1、F2 兩行級缺失（各一行 import、一節 vite 規範）＋修正 F3 驗收斷言後可過 R3；其餘 ⚠️ 屬編輯性修正。**
