# SR-C4 harness 補登

`tools/verify-src4-makesession.mjs` 驗證 makeSession 統一走 fsrsCtx（取代預設 new FSRS() 權重漂移）。
溯源：PM1 修 C4 時登 scope-requests C4-SR1（makeSession 是 fsrsCtx 統一化漏網）。

cli.mjs 的 makeSession 實際改動與 PM2 現役 E6 同工作區，由 PM2 的 E6 commit 自然帶入 HEAD；
本 harness 之 fix-marker 檢真實 cli.mjs（工作區改動已存在 → 立即 PASS，E6 commit 後仍 PASS）。