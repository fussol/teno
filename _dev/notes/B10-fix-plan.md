# B10 Fix Plan — 側邊欄導航離開測驗不存檔 + module state 殘留

## 1. Bug 事實

**位置**：src/main.js bindNav(:240-260)/renderPage(:285-298) + 三頁 exam-*.js

**問題**：側邊欄導航離開測驗頁不存檔（只有 exit 按鈕存），且 exam 頁 module-level `e` state 殘留 → 再進測驗頁 `render()` 依 `e.phase==='exam'` 直接 renderExam → 跳回中途。

## 2. 狀態流（實讀確認）

- sidebar `.nav-item[data-page]` click → bindNav → `store.actions.navigate()` → currentPage 變更 + notify → renderPage() → 跑上一頁 `window.__pageCleanup`（無則跳過）→ 載入新頁
- bottom-nav 離開是 B1/B2 刻意續答語意（nextWord page guard + onMount 補跳）→ 修法不得碰
- exit 按鈕有完整 save 流程（flush + buildSession + saveExamSession + phase='config'）

## 3. 修法：save on leave（sidebar-scoped）+ 同步 phase 重置

選 save on leave 而非 reset on enter：存檔保留進度（符合「中途退出自動存檔」承諾）；reset 丟進度且要區分導航來源。

**機制**：
- `bindNav` sidebar handler 設 `window.__navFromSidebar=true`（self-nav guard：點目前頁不設，防標記殘留誤觸發 bottom-nav）
- `renderPage` 每頁切換後無條件 `delete window.__navFromSidebar`（含 _forceRender 路徑）
- exam 三頁 `onMount` phase==='exam' 時註冊 `window.__pageCleanup = () => saveOnLeave(s)`；config/result 時 delete（清 stale）
- `saveOnLeave`：phase guard + 標記 guard → 清 timer → flushPendingScore（B2）→ buildSession（mc 加收 mcData，resume 可還原選項）→ **同步 e.phase='config'**（消滅回頁跳中途）→ fire-and-forget saveExamSession().catch()
- 冪等：phase guard 保證重複觸發不雙存

## 4. 消費者清單

| # | 位置 | 影響 |
|---|---|---|
| 1 | main.js bindNav | sidebar 三處設標記（nav-item/deck-item/addDeck） |
| 2 | main.js renderPage | 消費後清除標記 |
| 3 | 三頁 onMount | exam 註冊 / config+result 清除 |
| 4 | 三頁 saveOnLeave | 新 helper |
| 5 | bottom-nav / exit | 不變（測試鎖住） |

## 5. 驗證

tools/verify-b10-nav-exam.mjs 73/73（T1 三頁 sidebar 離開→session 完整已存+phase='config'+回頁 config UI+冪等；T2 bottom-nav 離開→不存檔 phase 仍 exam（B1/B2 保留）；T3 exit 行為不變；T4 負控制剝除→bug 再現；T5 main.js 接線靜態斷言）。回歸 B5 51/51、B6 72/72、B7 34/34、A5 59/59、A6 19/19。node --check 4 檔、vite build 773ms。

## 6. 範圍外

- Android back（goBack）離開測驗不存檔 — 可後續用同一 __pageCleanup 掛鉤擴展
- bottom-nav 續答語意（保留）
