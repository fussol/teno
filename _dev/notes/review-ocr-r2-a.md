# OCR-plan v1.1 R2 複審 — 委員#A（修訂閉合性）

- 審查對象：`_dev/notes/OCR-plan-v1.1.md`（213 行）§0 修訂對照表宣稱 vs 正文實際內容
- 對照基準：v1.0（`OCR-plan.md`）+ R1 三席報告（c1: M1-M5/m1-m6；c2: 遺漏清單 L1-L11；c3）+ 實碼 grep 實證
- 審查方式：逐條核對，全部行號為 v1.1 實測行號；實碼證據為終端實測。**未修改任何檔案。**
- **總判定：❌ 不完全閉合 — 9 項✅ / 4 項🟡 / 3 項❌。其中 M4/L7 為「對照表宣稱與正文不符」的假宣稱，屬最嚴重。**

---

## 一、逐條判定表

| 項 | §0 表宣稱（行號） | 正文實際 | 判定 |
|---|---|---|---|
| **M1** fs 插件編譯失敗 | L11：放棄 Tauri fs 路線，不改 Cargo.toml/capabilities | §6 五大項（L138-171）無 capabilities/Cargo/fs 任何修改項；全文 `fs:` / `capabilities` 僅出現在 §0 表（L11、L17），正文零殘留 | **閉合✅** |
| **M2** 幽靈 `recognize_image` | L12：移除所有 Rust IPC 橋樑假定 | grep 全文 `recognize`：僅 L12/L18（§0 表對**歷史問題**的描述）與 L89（HTML 註解 `<!-- OCR Recognize -->`，無害）。正文無任何 `invoke('recognize_image')`/`recognizeImage`/api.js 橋代碼；§6 無 api.js、無 lib.rs 項。**全文清零確認** | **閉合✅** |
| **M3** `icon('camera')` 不存在 | L13：svg.js 補 camera 鍵（引入 lucide-static camera.svg） | §6 項1（L138-143）確有 `camera: () => S(cameraRaw)`。**但 `cameraRaw` 無定義**：實碼 `svg.js:8-` 的慣例是每圖示一行 `import xRaw from 'lucide-static/icons/x.svg?raw'`，v1.1 缺該 import 語句（僅一句註解帶過）。照貼即 ReferenceError。lucide-static 已在 package.json:23 ✅（不需新增依賴，此點無害） | **部分🟡** |
| **M4** 第6章清單不全 | **L14：宣稱「第6章完整窮舉：tools.js、svg.js、package.json、vite.config.js、tauri.conf.json 五大檔案」** | §6 正文實際五項為：svg.js(L138)、**store.js(L145)**、tools.js(L158)、package.json(L161)、tauri.conf.json(L167) — **`vite.config.js` 根本不在 §6**，宣稱與正文直接矛盾（假宣稱）。另 c1-M4 要求的「eng.traineddata/wasm/worker 模型檔擺放位置」仍未在任何章節指定（無 workerPath/corePath/langPath 規範）。③ OCR Worker 檔案未列（tesseract.js 自帶 worker 可辩护，但打包路徑仍未收口） | **未閉合❌（假宣稱）** |
| **M5** 能力偵測慣例 | L15：改用 `typeof window.__TAURI__?.core === 'object'` | 第4章 L118 確為該寫法（與 `src/lib/platform.js:5` 慣例逐字一致）；舊寫法 `window.__TAURI__ !== undefined` 全文已滅。小註：`isTauri`（L118）宣告後未使用（函式僅 click file input），属死變數，與 P1 純前端路線相容但宜刪 | **閉合✅**（附小註） |
| **L1** 清單漏 tools.js | L16：補 tools.js（HTML 插入 + onMount 綁定） | §6 項3（L158-159）列名 `src/pages/tools.js`，明示 render(s) 插入 + onMount(s) 綁定四個 ID（#ocrCaptureBtn/#ocrFileInput/#ocrSelectAllBtn/#ocrConfirmBtn）；第4章 L87 給插入位置（Generate Forms 與 Cambridge 之間，R1 已證錨點真實）✅。惟僅敘述式，無可貼 onMount 代碼 | **閉合✅**（弱：無行級代碼） |
| **L2** 盲目加 fs 權限 | L17：刪除 fs 權限項 | 同 M1：正文零 fs 權限內容 | **閉合✅** |
| **L3** api.js 錯誤橋接 | L18：刪除 api.js 擴充 | 同 M2：§6 無 api.js 項、正文無橋代碼 | **閉合✅** |
| **L4** 入庫路徑唯一化 | L19：全數統一走 `s.actions.importOcrText` | 唯一化正文可證：第1章 L37「統一走 importOcrText」、第5章 L131-132「嚴禁直接呼叫 addWord 批次或 saveWordsInTx」；v1.0 第4章 `s.actions.addWord(...)` 狀態機（原矛盾源）已整個移除，正文 `addWord` 僅存在於「嚴禁」句。**§6 項2（L145-156）importOcrText 定義存在**（含正則過濾+lower/trim+委派 importWords）。缺陷：(a) **無插入錨點** — v1.0 §6 原有 `return { added, skipped, decksCreated };` / `/** Edit a word */` 前後錨點（v1.0 L322-327），v1.1 反而刪除，屬**閉合性倒退**；(b) c2 附帶發現的 `this.importWords` 解構陷阱（`const { importOcrText } = s.actions` 即炸）呼叫慣例仍未註明 | **部分🟡** |
| **L5(CSP)** | L20：CSP 補 wasm-unsafe-eval + 模型離線打包 | §6 項5（L167-171）**有具體修改後 CSP 字串**（L170）。與實碼 `src-tauri/tauri.conf.json:27` 現行 CSP 逐字 diff：唯一差異是 script-src 加入 `'wasm-unsafe-eval'`，其餘各指令逐字相同 ✅。惟「模型與 WASM 離線打包在本地」僅存於表格宣稱與第1章 L32 一句話，**無任何檔案級打包規範**（與 L7 同洞）；worker-src/blob: 未評估 | **閉合✅**（CSP 字串這半部閉合；打包半部見 L7） |
| **L6** Android 清單 | L21（併 L7）：補 package.json/vite | c2 明列的两點之一已做：第1章 L41 明文 `<input capture>`「**無需額外 Android CAMERA 權限**」✅。但第6章仍無任何 P2 安卓檔案項（AndroidManifest/build.gradle 均未提）；且第3章 L81 手機端仍推薦「ML Kit」，第8章 P2 交付物（L191）卻只做「檔案上傳串接」——**ML Kit 推薦與 P2 範圍矛盾未收口**（走 ML Kit 需 gradle 依賴，清單缺失） | **部分🟡** |
| **L7** package.json/vite/模型放置 | L21：「於第6章補齊 package.json **與 vite.config.js**（WASM/Worker 資產打包）」 | package.json 項存在（L161-165，tesseract.js ^5.1.0）✅；**vite.config.js 項在 §6 正文不存在** — 表格假宣稱（實碼 `vite.config.js:16` 的 `optimizeDeps.exclude` onnxruntime 先例證明此坑真實，c2 L7 點名要評估，v1.1 零處理）；模型檔放置（public/ vs assets、workerPath/corePath/langPath）仍未指定 → 預設行為=CDN 依賴，違背離線宣稱 | **未閉合❌** |
| **L8** token 白名單 | L22：正則 `/^[a-z][a-z'-]{1,30}$/i` | 正則存在×2：第5章 L127-130（規則定義）、§6 項2 L152（落地於 importOcrText 過濾鏈）。全路徑封頂：過濾在 importOcrText 內、而 L132 唯一化禁令封死旁路 ✅。小瑕疵：**off-by-one** — `{1,30}` 實容 2–31 字元，L130 文字卻宣稱「長度 2 至 30 字元」；L152 落地版未加 `/i`（前置 toLowerCase 故語義等價，無害但兩處寫法不一致） | **閉合✅**（附小註） |
| **L10** 失敗回報負控制 | L23：驗收補「辨識成功但 DB 寫入失敗」負控制 | **已進第7章**：L179 負控制 B「模擬 DB 寫入中斷（Mock 拋錯）。預期觸發 Rollback，回傳 added=0」✅。重大附註：實碼 `store.js:1269-1277` 的既有 bug（ROLLBACK 後僅 console.warn，仍回傳累計 added）**未列任何 §6 修復項** → 負控制 B 照跑必FAIL於現行實碼；計畫既未修 importWords 亦未宣告此測試預期暴露既有 bug，施工者將陷入「驗收標準 vs 嚴禁改動範圍」死鎖。負控制的 Mock 方法亦未定義 | **閉合✅（宣稱面）**／附重大保留 |
| **L9** camera 圖示 | （**§0 表無 L9 行**，實質由 M3 行承接） | 同 M3 判定：鍵有、import 定義無 | **部分🟡**（併 M3） |
| **L11** 波及風險漏項 | **§0 表完全未列 L11，正文亦無任何對應內容** | c2-L11 三點（deck-browser.js:566 addWord 消費點、refreshDerived 批量成本、「OCR Inbox」新 Deck 對清單/統計頁呈現）在 v1.1 全文零痕跡 → **遭無痕遺棄**，連宣稱都沒有 | **未閉合❌** |

---

## 二、匯總

| 判定 | 項目 |
|---|---|
| 閉合✅（9） | M1、M2、M5、L1、L2、L3、L5(CSP字串)、L8、L10(宣稱面) |
| 部分🟡（4） | M3/L9（cameraRaw 無 import 定義）、L4（路徑唯一化達成，但 importOcrText 錨點倒退 + this 慣例未註）、L6（capture 免權限已明文，P2 安卓清單仍缺 + ML Kit 矛盾） |
| 未閉合❌（3） | **M4（§0 表宣稱 vite.config.js 在第6章，正文沒有 — 假宣稱）**、**L7（vite 項缺失、模型放置未定）**、**L11（表格與正文雙重缺席）** |

## 三、其他觀察（非閉合判定但建議 R2 併記）

1. **§0 表編號錯亂**：c2 原清單 L4=入庫矛盾、L5=CSP，v1.1 表卻寫「L4/L5＝入庫」+「L5 (CSP)」**兩行共用 L5**；L9 未列行（寄生在 M3 行）、L11 整個消失。對照表喪失與 R1 發現的一一映射，審計可追溯性破口。
2. **session_id 殘渣**：L198（第8章之後）、L213（第9章末）殘留 `session_id:` 行，第9章併入時未清理（L198 甚至卡在 L200 `---` 與第9章標題之間，結構錯位）。
3. **第1章功能 vs 第6/7章覆蓋**（c3 缺口延續）：L31 剪貼簿貼上、L34-35 置信度 >0.8 閾值 / bbox 預覽 / 手動修正，在第6章無歸屬代碼項、第7章無對應測試行；「<3s 計時」仍建立在 c3 點名的未驗證延遲估算上。
4. **L8 正則 off-by-one**（2–31 vs 宣稱 2–30）。
5. 正面確認：M2 幽靈符號**確實全文清零**；CSP 修改串與 tauri.conf.json:27 現行值逐字可 diff、唯一增量正當；importOcrText 過濾鏈（lower→trim→正則→importWords）與第5章唯一化禁令構成自洽防線，是本次修訂最紮實的兩處。

## 四、判定

**❌ 退回補正**（僅限缺口，非全面返工）。補正最低清單：
1. §6 補 `vite.config.js` 實質項（optimizeDeps.exclude/assetsInclude 評估 + 模型檔 workerPath/corePath/langPath 放置規範），否則刪除 §0 表 L14/L21 的 vite 宣稱 — **不得保留與正文不符的宣稱**。
2. svg.js 項補 `import cameraRaw from 'lucide-static/icons/camera.svg?raw';` 完整行。
3. §0 表補 L11 行並給正文處理（至少一段波及風險敘述覆蓋 deck-browser.js:566 / refreshDerived / OCR Inbox 呈現），或明文論證為何不採納。
4. importOcrText 項補回插入錨點 + `this` 呼叫慣例註記；第7章負控制 B 旁註「現行 importWords 失敗路徑必致本項 FAIL，需併修 store.js 錯誤分支或明示為暴露既有 bug 的_probe 測試」。
5. 清理 session_id 殘渣、L5 編號重複、正則 30/31 off-by-one；收口第3章 ML Kit 推薦 vs 第8章 P2 範圍的矛盾。

*審查人：R2 委員#A（修訂閉合性）。全程唯讀，未改任何 src/ 或計畫檔案；本報告為唯一產出。*
