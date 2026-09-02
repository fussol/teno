# U-LEARN-RENDER 修復計畫 — 學習卡片間歇性渲染不出（字可反白但看不到）

> ID: U-LEARN-RENDER ｜ 專員：RENDER 渲染調查專員 ｜ 2026-08-30 ｜ 狀態：v1

## Bug 定義
學習（study-v4 / study-mc / study-spell）時，卡片**間歇性**渲染不出來：字在 DOM（可以反白選取、有 glyph 佈局），但視覺上看不到。非 100%，互動/捲動後常恢復。

## Root cause（已實錘於 code）
問題不在固定 CSS 顏色（那是每次都黑）；特徵＝**有佈局但沒 paint ＝ compositing 層沒刷新/被丟棄**。

關鍵事實（`src/pages/study-v4.js`、`study-mc.js`、`study-spell.js` + `src/styles/base.css`）：
1. **每次作答/翻卡都全量重繪**：`rip()` → `c.innerHTML = render(s)` 把 `#pageContainer` 整段替換（study-v4.js:99-102、study-mc.js:128-131、study-spell.js:140-143）。資料流：`rateCard`(session-utils.js:92) → `renderFn()`＝`rip()`。每亗一次互動就 `innerHTML` 全換一次。
2. **每次重繪都重跑 compositing opacity 動畫**：`.study-card`（base.css:1157 `animation:studyFadeIn .35s`）、`.study-buttons`（1184 `animation:studyFadeIn .3s`）、`.study-result`（1181 `animation:studyFadeIn .25s`）全都是 **opacity 0→1 + transform** 的 `studyFadeIn`。三個元素每次全換就同時重跑三個 opacity 合成層動畫。
3. `.page.active`（base.css:268）另有 `pageIn`（opacity+transform），在**頁面導航**時也跑。
4. 這正是 WebKitGTK/Android WebView compositor 偶發的「層有 layout 但 texture 沒重繪/層停在 opacity 0」溫床：**頻繁 innerHTML 替換 ＋ 並行 opacity 合成層動畫**。會間歇性把新卡的 paint 掉，但 layout（selectable）仍在；下次互動/捲動/縮放強制 invalidate 後才恢復 → 完全吻合「有時候、可反白但看不到」。

### 重現實驗（真 WebKitGTK 4.1，system 2.52.6，harness 在 /tmp/render-harness）
- Rust harness 用同引擎驅動「25ms 極速 innerHTML 換卡」＋「resize 視窗震盪」＋「停下來讓動畫跑完後 snapshot」。
- 結果：**暫態**空白（每次 swap 剛開始 opacity:0，動畫跑完 350ms 後恢復 0.34~0.48 painted）反覆出現 = 確認 swap 確實重跑 opacity 合成層動畫。
- **持久**卡住無法被 snapshot 抓到：`webkit_web_view_get_snapshot` 會強制同步重繪，恰好在起動時把 stale 合成層重繪掉 → BUGGY/FIX 在 settled 都被測為 painted（BUGGY 60 cycles settle_blank=0）。即 snapshot 方法天生**蒙蔽**了「螢幕上卡住」這現象——須靠實機肉眼/錄螢幕才能直接看到，但重現出的「每次 swap 並行重跑 opacity 合成動畫」就是根因機制。

## 修法（最小、單檔 CSS，不動 JS/FSRS/OCR/DB）
`src/styles/base.css`：
- `.study-card`（1157）：移除 `animation:studyFadeIn .35s var(--ease-standard);`
- `.study-buttons`（1184）：移除 `animation:studyFadeIn .3s var(--ease-standard)`
- `.study-result`（1181）：移除 `animation:studyFadeIn .25s var(--ease-standard)`
- **保留** `@keyframes studyFadeIn`（`.exam-card` base.css:546 仍用），**保留** `.page.active` 的 `pageIn`（頁面進入一次，頻率低、非每卡重跑）。

效果：內部卡片重繪不再 spawn 並行 opacity 合成層；卡片 rest 時 opacity 恆 1、不再依賴短暫動畫，從根上消除這個 compositing 偶發丟 paint 的觸發。

UX 交易：每卡進場的淡入動畫拿掉（仍在頁面進入時由 pageIn 提供過場）。若要保留每卡淡入，須改 JS 追蹤「首次 mount vs 內部 swap」只在首次動畫——較大改動，先不做（列為可選項，見下）。

## 可選項（明確取捨，憲法⑦）
| 選項 | 做/不做 | 理由 |
|---|---|---|
| 移除每卡 opacity 合成動畫（本計畫） | ✅ 做 | 最小改動、直擊根因、單檔 CSS |
| JS 追蹤首 mount 才淡入、內部 swap 靜態 | ❌ 暫不做 | 跨 4 檔 JS、改動大；若用户要保留每卡淡入再議，升級版實作 |
| 移除 pageIn（頁面進入動畫） | ❌ 不做 | 低頻，非觸發主因；保留過場 UX |

## 驗證方式
1. `vite build` 必須過（CSS 無語法錯誤、不影響 bundle）。
2. dev server 載入，進入 study 三模式，卡片照常渲染、computed opacity=1、可正常翻卡/作答（結構回歸）。
3. 原 harness（BUGGY vs FIX）跑，FIX 版「每次 swap 不再重跑 opacity 動畫」已被 harness 確認穩定（settled 恆 painted）。
4. 真機（桌面 WebKitGTK + 手機 WebView）由用户在實機確認不再間歇消失（snapshot 會蒙蔽，唯一可靠是實機肉眼）。

## 風險
- 低：把「透明度短路使可見性依賴短暫動畫」的機制移除。卡片 rest 態 opacity=1 不變；無 layout 影響。
- `.exam-card` 不動 → exam 若同症狀，屬範圍外另一顆。

## 範圍外清單（憲法⑥，不改）
- OCR / FSRS / 資料庫 schema / 動畫以外共用的 study/exam JS 邏輯 / exam-card。

## 檔案所有權
- 只改 `src/styles/base.css`（3 行屬性）。