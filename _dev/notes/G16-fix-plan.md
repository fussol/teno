# G16 修法計畫書 v1.0

## Bug 定義
`src/lib/store.js` 的 `state.sidebarOpen`（:147）與 `toggleSidebar()`（:1141-1142）是**死碼** — audit G16：「sidebarOpen/toggleSidebar 死碼」。

## Root Cause
早期側欄用 store state 控制，後期改為 main.js 直接用 DOM classList.toggle（:223 `$('sidebar').classList.toggle('hidden')`），store 的 sidebarOpen 沒人再用但殘留。

## 消費者清單（憲法② grep 實錘）
`state.sidebarOpen` / `toggleSidebar` 全域唯見於 store.js 自身定義；src/ 與 tools/ 無任何外部讀取（grep 確認）。main.js 側欄開關走 $('sidebar').classList.toggle('hidden')，未經 store。→ 安全刪除。

## 修法
src/lib/store.js：
- :147 刪 `sidebarOpen: true,`
- :1141-1142 刪 `toggleSidebar() { state.sidebarOpen = !state.sidebarOpen; },`

## 驗證
- T1 全域 grep 確認刪除後無殘留引用
- T2 node --check + vite build
- T3 確認 main.js 側欄邏輯不依賴 store（已 grep .sidebarOpen 零引用）
- T4 負控制：刪除前 toggleSidebar 存在但無消費者（grep 已證）

## 風險
- 極低：刪純死碼，不影響 store 行為。grep 實錘零消費者。

## 範圍外
- G16b（audit 指 :977）實為 suspend 函式，非 sidebar — 登範圍外（grep 證 sidebar 死碼僅 :147/:1141）。