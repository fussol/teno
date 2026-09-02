# PM5 檢查點（2026-08-28，預算將盡交接 — 法律③）

## 本 session 完成
- **F17 | commit cd9c177 | 審查 4 輪 10 人次（R1/R2 鑑識 ❌→憲法⑩結構重做→R3 ❌錨點→v4→R4 全綠）| 驗證腳本 8/8 PASS（雙態＋11 攻擊變體全紅）| 計畫書 _dev/notes/F17-fix-plan.md（v1→v1.3 凍結歷程）**
- G10 先前已入（3367f12，總統親審），非本軌產出。

## 剩餘佇列（依 PM5-MISSION 順序，全部未動工）
1. **F18** tts.js（Android TTS promise 無 timeout 兜底 → 事件遺失永久 pending）— 下一顆。先讀檔實錘行號（任務書 41-54/63-74 係 2026-08-13 掃描）。注意：tts.js 有 `tools/verify-tts-contract.mjs`（10 斷言）是 F2 事件契約閘，F18 改動必過它；timeout 兜底 emit 的終態要與 done/error/stopped 四事件契約對齊（reason 新增值的話 contract 腳本可能要升版，tts.js:81 附近有契約測試）。F17 已定稿的「暖機未完成視窗」語意見 F17-fix-plan v1.2 段，F18 的 timeout 不可把降級路徑誤判成事件遺失。
2. **G9** tts.js native 失敗後 30 秒靜默；_enVoice/pick 死碼；ttsAvailable 誤報（要一起修）。
3. **F4** IconPlugin.kt alarm requestCode/finish/alias race — 同 F17 用 gradle compileArmDebugKotlin 當編譯閘（JAVA_HOME=~/jdk21，--offline 可用，2-10s）。
4. **F5** IconPlugin.kt ResolverActivity 清理＋DEFAULT 誤判。
5. **F6** AndroidManifest MANAGE_EXTERNAL_STORAGE/cleartext/backup 排除 — 高風險上架項，複雜度最高，留足審查輪。

## 可直接複用的資產（本 session 淬煉）
- **驗證腳本範式**：`tools/verify-f17-findvoice.mjs` v4 是本倉最強範本——單趟狀態機等長剝離器（註解/raw string 空白化、普通字串保留）、token 級掃描、精確計數（===N 雙邊）、負控制精準拼接、威脅模型定文頭註。JS 域（F18/G9）同理可寫：先 bug 態紅基線，修法綠，負控制剝修法精準紅。
- **審查協議實戰教訓**：鑑識席會把「文字閘 vs 對抗偽裝」打成無限軍備競賽——第一輪就送威脅模型定文（防無意回歸＋偷工，不抵禦蓄意偽裝），可省兩輪（本軌 R1/R2 白燒 4 席）。委員處方若附「升版後可予 ✅」明示，複核可 1 席（代碼不動前提）。
- **委員指令必自包含＋唯讀纪律＋實驗限 /tmp**；delegate 三席併發一轮 ≈20-40 分鐘。
- **gradle**：`:app:compileArmDebugKotlin --offline`（多 flavor，`:app:compileDebugKotlin` 歧義勿用）。
- **kotlin 檔實際路徑**：`src-tauri/gen/android/app/src/main/java/com/teno/app/`（任務書路徑是簡寫，計畫書要登記勘誤）。
- **共享 repo**：git add 明確四檔制（code+腳本+計畫書+subagent-log）；lib.rs/cli.mjs/scope-requests.md 是三檔他軌髒檔，勿 add。
- 終端守衛會誤判 `npx vite build` 為 server——用 `npm run build`。

## 工作區狀態
- main HEAD = cd9c177；F17 白名單四檔已全數入庫，tracked 檔本軌零殘留。
- 髒檔（scope-requests.md/lib.rs/cli.mjs）＝他軌，未觸。
- /tmp/f17v2/、/tmp/r3atk/、/tmp/f17_r4/ 為審查攻擊樣本（暫存，可清）。

## 下一步（接手首相第一動作）
讀本檔 → 從 F18 開始：`_dev/notes/F18-fix-plan.md` 計畫書（含行號實錘＋可選項定案＋範圍外清單）→ 驗證腳本先行（PRE 紅基線）→ 3 席送審（附威脅模型定文）→ 動工 → POST（verify-tts-contract 必綠）→ commit → 落盤 subagent-log。
