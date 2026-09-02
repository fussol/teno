# PM-OCR-AB 任務書 — OCR 優化 A（螢光筆 HSV 過濾）+ B′（切割兩態）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`、**`_dev/notes/OCR-OPTIMIZE-plan.md`**（完整計劃書 v1.1，你的範圍=**A 段 + B′ 段**）。工作目錄 `~/teno`，branch main。基線 HEAD=`$(git rev-parse HEAD)`（讀檔時現值，約 v5.8.13+）。

## 任務性質
執行 OCR 優化計劃書的 **A 段（實體螢光筆 HSV 顏色過濾）+ B′ 段（切割按鈕＋拖四角成型）**，兩顆獨立 commit（A 一顆、B′ 一顆）。詳細設計、驗證、harness、風險全在 plan 對應段。

## 範圍（只動這些，**禁碰 store.js**）
- `src/pages/ocr.js`（A：highlight 前處理調用＋顏色 UI；B′：切割兩態狀態機＋四角 handle）
- `src/lib/ocr/`（A：新增前處理函式；可能新增 `preprocess.js`）
- `tools/verify-ocr2-highlightfilter.mjs`、`tools/verify-ocr2-crop.mjs`（新增 harness）
- `_dev/notes/`（subagent-log/）

## 明確禁區（跟並行首相協調）
- **絕不碰 `src/lib/store.js`** — BH-FIX 首相正在改它（BH-01~04），會撞。你的兩顆只用 ocr.js/lib/ocr，不需要碰 store.js。
- 不碰 `src-tauri/`（SR2-CONT/C 在改 Rust）。
- 不碰 B′ 以外的切割；不碰 E′/F′/C/D′（別的首相負責）。
- **禁 `git add -A`**；commit 前完整 `git status` 揪別人預 staged 的檔（ALIGN 教訓）：只 add 你的白名單檔。

## 版本（並行衝突對策）
- 每顆 commit 前 `./tools/version.sh <完整版號>`（繞過 patch 分支 bug），**從 5.8.14 起**。若 version.sh 報「三檔漂移」或 spot 有人已佔下版，改用 `5.8.15` 以上／`git status` 協調，commit message 標清楚版本。
- 若 version-gate 因並行檔持有而卡 → 先 commit code（不含版本檔）再補，或回報總統協調，不要硬解 lock。

## 鐵律（GOV-BRIEF）
- 一顆一 commit：先寫 harness 實跑（PRE 紅負控制）→ 動工 → `node --check`＋OCR 既有 harness＋`vite build` → 審查（store 不動故非共享，可視風險降席，但 A/B′ 動 ocr.js 核心 → 建議 3 席）→ commit。
- A/B′ 是使用者的實際需求 → 別跳審查。
- 429 退避：審查並行易撞 glm 限流，起審前 sleep≥60s。

## 交付
- A 一顆、B′ 一顆，各 commit + harness。
- 回報：各 commit hash、審查輪數人次、驗證 N/N、harness 路徑。
- 用繁體中文。