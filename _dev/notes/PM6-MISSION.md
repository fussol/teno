# PM6 任務書 — UI / 主題 / 設定域

先讀 `/home/jupiter/teno/_dev/notes/GOV-BRIEF.md`（鐵律）與 `_dev/notes/法典.md`。
工作目錄 `~/teno`，branch main，基線 8d1b0f8。

## 檔案所有權白名單
- `src/main.js`、`src/index.html`、`src/styles/base.css`、`src/lib/theme.js`
- `src/lib/custom-select.js`、`src/pages/settings.js`
- `_dev/notes/`、`tools/verify-*.mjs`
- **不碰** `src/lib/store.js`（PM8）、`src/lib/chart.js`（基線已檢入，他域）、`src/pages/*` 其他、`src/lib/*` 其他

## Bug 佇列（依序；行號 2026-08-13 僅供參考，動工前實錘）
1. **D6** settings.js:483-486 — import 在 plugin-sql 連線開啟時覆寫 teno.db（closeDB 在 swap 後）→ 需先 closeDB 再 swap
2. **F7** index.html:11 + main.js:18-51 — splash 深底→亮底閃爍；getLauncherIcon 失敗不重試
3. **G2** base.css:1016 + main.js:197 — 手機版 topbar display:none，唯一 sidebarReopen 在 topbar → 側欄打不開
4. **G3** main.js:115,206,279 + store.js:977 — 子頁 nav 無 active 高亮；setReviewDeckFilter 不 push pageHistory（這顆若需動 store.js:977 → scope-requests，改 main.js 側為主）
5. **G5** custom-select.js:69 — document capture click listener 每頁每次 mount 累積
6. **G6** main.js:273-307 — renderPage 無 generation guard → 快速換頁舊頁覆蓋新頁
7. **G13** custom-select.js — 無鍵盤支援/aria；CSS.escape 特殊字元選擇器會壞
8. **G12** base.css:102 + theme.js:209-223 — light mode color-scheme 仍 dark → 原生控制項深色殘留
9. **G14** settings.js:1406-1412 — renderInPlace 後 custom-select 轉換遺失
10. **G15** base.css:1391,1398 vs 260,595,126 — 重複 selector 後者覆蓋前者（multi-accent 分布區塊）
11. **G23** settings.js:304 — 每日目標 inline onclick WebKitGTK 可能無效
12. **G27** main.js:353 — human-data .then 無 catch
13. **G31** index.html splash — splash 閃色、icon 圖檔完整性未驗證

注意：UI 修復後**必須用本機 GPU vision 驗渲染**（ollama llama3.2-vision 看 screenshot）：修完起 `npm run dev`（或 tauri dev 若可行）→ 截圖 → vision 驗證（若跑不起來就在計畫書註明「無法渲染驗證」）。D6 與 D2 同屬 closeDB 問題但部位不同，D2 已修。G2 涉及 CSS 佈局，改完檢查手機 topbar 語意（CSS 分析為主，vision 若手機 viewport 難測可用響應式 breakpoint 斷言）。

完成標準：佇列全數有 `fix: <ID>` commit。結束回報五欄摘要。