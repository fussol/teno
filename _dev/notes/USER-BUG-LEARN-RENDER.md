# 使用者回報 Bug — 學習時卡片「偶爾」渲染不出來（可反白但看不到）

> ID: U-LEARN-RENDER ｜ 回報者：使用者（2026-08） ｜ 狀態：✅ 已結案（commit bb1a0d8, v5.8.1, 2026-08-30）

## 症狀（使用者口述，關鍵特徵）
- 「學習的時候，卡片**有時候**渲染不出來，但裡面的字是可以反白的（選取），但看不到。」
- **「有時候」＝間歇性** ⚠️ 這是最大線索：非 100% 發生 → 排除「固定 CSS 顏色錯誤/文字色=背景色」（那是每次漆黑）。
- 「字能反白選取但看不到」＝ 元素在 DOM、**有 glyph 佈局（所以能選取）**，但視覺上**沒有 paint**。

## root cause 方向（依間歇性特徵排列，優先查）
1. **compositing / paint 層沒刷新**（最符「有佈局能選取但沒 paint」）：WebKitGTK（桌面）或 Android WebView 合成層偶發不刷新 — 縮放/捲動/視窗 resize 後突然出現。
2. **載入競態 / 動畫 flash**：卡片插入時 CSS/字體未就緒，或 state 切換動畫卡在中途（opacity 停在 0 / visibility 未復原）。
3. **字體載入延遲 / fallback gap**：web font 偶發載失敗 → fallback 渲染空白。
4. **未觸發重繪**：內容更新後 viewport 沒 invalidate，直到下次互動才 repaint。

## 調查重點（先讀現況，不要憑印象）
- `src/pages/study*.js`（study / study-v4 / study-mc / study-spell）— 卡片 render + state 切換 + 動畫/transition。
- `src/pages/exam*.js` — 若考試卡片同症狀也適用。
- `src/*.css`、theme 變數（`--text-primary`、`--bg-*`）、字體載入（`@font-face`/`font-family`）。
- 事件：結束/切換/回到卡片時有無 `opacity`/`visibility`/`transform` 的 transition 未收尾。

## 驗證（需「刺激重現」，間歇性不能靠單次）
- 桌面 dev server (localhost:5173)：連續切換卡片 N 次、縮放、resize 視窗，看可否誘發。
- 手機 (SM-A5560)：桌面正常而手機才出現 → WebView 合成層差異。
- 若能重現：DevTools/`document.elementFromPoint` 確認字體是否都 render；看 paint 層（`will-change`/`transform`/`opacity`）狀態。
- 「能反白」用於定位：選取那片字，看 computed style 的 `color` 是否異常。

## 派單
派首相調查 root cause → 確認後編修復任務（一顆）。可併入 BUGHUNT 或新開專員。

---

## ✅ 調查結論 + 修復（2026-08-30，commit bb1a0d8 / v5.8.1）

### Root cause（已實錘於 code）
- 每次作答/翻卡，study 頁的 `rip()` 都 `c.innerHTML = render(s)` 把 `#pageContainer` 全量替換（study-v4.js:99-102、study-mc.js:128-131、study-spell.js:140-143；資料流 `rateCard`(session-utils.js:92) → `renderFn()`）。
- 每次全量替換，`.study-card`（base.css:1157）、`.study-buttons`（1184）、`.study-result`（1181）**同時重跑 `studyFadeIn` = opacity 0→1 + transform**。三個 opacity 合成層動畫每卡並行重跑。
- 這正是 WebKitGTK/Android WebView compositor 偶發的「層有 layout 但 texture 沒重繪 / 停在 opacity 0」溫床 → 卡片間歇性「可選取但看不到」，下次互動/捲動/縮放強制 invalidate 才恢復。吻合所有症狀特徵（間歇性、有佈局能選取、觸發後恢復）。

### 重現（真 WebKitGTK 4.1 2.52.6，harness /tmp/render-harness）
- Rust harness 用同引擎：25ms 極速 innerHTML 換卡＋resize 震盪＋停下讓動畫跑完。
- 確認每次 swap 都重跑 opacity 合成層動畫（暫態空白反覆出現）。
- 持久卡住無法用 `webkit_web_view_get_snapshot` 抓到：snapshot 強制同步重繪，正好把 stale 層重繪掉 → 蒙蔽。真機肉眼/錄螢幕才看得到。

### 修法（單檔 CSS，不動 JS/FSRS/OCR/DB）
移除 `.study-card` / `.study-buttons` / `.study-result` 上的 `animation:studyFadeIn`。卡片 rest 恆 opacity1，可見性不再依賴暫態動畫。保留 `@keyframes studyFadeIn`（`.exam-card` 仍用）＋ `.page.active` 的 `pageIn`（頁面進入動畫）。

計畫書：`_dev/notes/U-LEARN-RENDER-fix-plan.md`

### 驗證
- `node node_modules/vite/bin/vite.js build`：PASS（961ms）。
- browser（dev server）注入 `.study-card`：computed `animation-name:none`、`opacity:1`、即時有 layout、`checkVisibility()=true`，無 console error。
- 真機（桌面 WebKitGTK + 手機 WebView）待用户在實機確認（snapshot 蒙蔽，唯一可靠是實機）。

### 範圍外
- `.exam-card` 同款 `studyFadeIn` 未動（exam 若同症狀為另一顆）。
- 附帶發現：`tools/version.sh patch` 在當前 patch 分量=0 時因 `((patch++))` 回傳 0 被 `set -e` 中止（此顆以 `./tools/version.sh 5.8.1` 繞過）。