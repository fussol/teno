# PM-OCR2 任務書 — OCR 優化合理化計劃書（純寫 plan，不動 code）

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）、`_dev/notes/法典.md`、`_dev/notes/行政法.md`。工作目錄 `~/teno`，branch main。

## 任務性質
這是**計劃書寫作任務**：你調查現況＋設計優化方案，產出 `/home/jupiter/teno/_dev/notes/OCR-OPTIMIZE-plan.md`（完整設計計劃書）。**不 commit code、不改 source**。只有計劃書本身可 commit（docs，不升版）或先落盤等總統審。

## 使用者痛點（最高層 2026-08 口述，3 項）
1. **螢光筆模式沒有區別**：OCR 頁的「螢光筆」模式（highlight，高信心）跟「全掃描」實際行為看起來一樣，使用者感覺不到區別。需合理化兩者差別。
2. **框選功能手機難用**：拖矩形框選（`src/pages/ocr.js` 的 pointer 拖曳 overlay）在手機上操作不便。需設計更直觀的手機框選 UX。
3. **黑灰名單重疊字不出現在勾選欄**：OCR 抓出的單字如果跟黑名單/灰名單重疊，就**無法被顯示在勾選欄位** — 使用者看不到被濾掉的字，喪失控制權（想恢復某些字也無法）。需設計「重疊字仍可見、但標示為已遮蔽＋可勾選強制加入」的機制。

## 調查範圍（先讀現況再設計，不要憑印象）
- `src/pages/ocr.js` — 完整讀：畫 render（模式切換/取圖/切割/候選）、onMount（mode 切換、切割 pointer 事件、辨識、候選 render、入庫）。
- `src/lib/store.js` — `importOcrText`/`importWords` 的黑/灰名單過濾邏輯，檢查點（是過濾在 store 端還是 ocr.js render 端？重疊字為何「不顯示」）。
- `src/lib/ocr-blacklist.js` — DEFAULT_BLACKLIST、normalizeBlackWord。
- 黑名單/灰名單目前如何擋（`isBlacklisted`/`isGraylisted` 在候選 render 時有無被呼叫、filter 在哪一層）。
- 模式切換持久化（`ocrMode` scan/highlight，store.js:435）。

## 計劃書必須涵蓋（每一項：現況實錘行號 → 痛點 → 建議方案 → 取捨 → 驗證方式）
1. **螢光筆 vs 全掃描差異化**：
   - 現況：`ocr.js` 辨識段 `if (_mode === 'highlight')` 只做 confidence≥50 過濾（:367-371）。
   - 建議思考：螢光筆該有怎樣「不同」的 UX？(a) 螢光筆＝單一重點字選取（點選字而非勾選清單）？(b) 螢光筆＝只辨識框內一個高亮區？(c) 全掃描＝整張多字清單，螢光筆＝聚焦單字卡片？設計出兩者實質差異，別只停在信心閾值。
   - 注意手機 WebKitGTK/blob: 圖源限制（記憶：手機 blob: 圖源不渲染黑框、需 data: URL）。
2. **手機框選 UX**：
   - 現況：拖矩形 pointer 事件（:266-290），手機 touch 難精準。
   - 建議：全選/快速框選助手（等分格九宮格、常見構圖預設框）、拖放容錯（放大鏡/吸附）、或系統截圖模式整張。設計符合手機拇指操作。
3. **黑灰名單重疊字可見性**：
   - 現況：重疊字在候選 render 被過濾，完全不顯示。
   - 建議：候選清單中重疊字**仍顯示但標示「已遮蔽（黑名單/灰名單）」**＋允許勾選強制加入（override，寫入時跳過該字過濾）。追蹤 filter 在哪層改。
   - 這是資料流/UI 雙層問題，需明確誰該改。

## 計劃書格式（照法典憲法①，完整 bug/需求定義 → root cause → 方案 → 驗證 → 風險 → 範圍外）
- 每個痛點一個 section：現況（檔案:行號實錘）→ 痛點 → 2-3 個候選方案＋取捨表 → 建議方案詳細設計 → 驗證方式（harness/雙態）。
- 跨層（ocr.js + store.js）改動標明邊界。
- 純寫 plan，產出 `_dev/notes/OCR-OPTIMIZE-plan.md`。

## 交付
- `_dev/notes/OCR-OPTIMIZE-plan.md`（完整、可直接動工）。
- 回報：計劃書路徑＋三痛點各建議方案摘要＋現況實錘行號。
- 用繁體中文。
- 不動 code、不 commit source 改動。計劃書可 commit（docs 不升版）或等你說。