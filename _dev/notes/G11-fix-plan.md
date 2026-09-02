# G11 修復計畫書 v1（2026-08-31，總統心跳）

## Bug 定義
頁面在 **document / window.visualViewport / body** 等**常駐節點**上 addEventListener 卻無對應 prevent/cleanup，每次 renderPage（切頁或同頁 re-render）重新註冊，handler 在常駐節點上無限累積 → 記憶體洩漏＋多重觸發＋outside-click 關閉對已卸載節點重複執行。

**累積點**（audit 原值 → 現行碼，全 grep 確認）：

| 檔 | 行（現行） | 常駐節點 | 累積？ |
|---|---|---|---|
| browser.js | 421 | document（card settings outside-click） | ✅ 每次開卡片 preview 累積 |
| browser.js | 608 | document（tag dropdown outside-click） | ✅ 每次 onMount 累積 |
| tag-manager.js | 291 | document（palette outside-click） | ✅ 每次 onMount 累積 |
| study-spell.js | 131 | window.visualViewport（resize 對齊輸入框） | ✅ 每次 onMount 累積 |
| deck-browser.js | 1341 | document（deck card settings outside-click） | ✅ 每次開卡片 preview 累積 |
| tools.js | 353 | document（custom select） | ⭕ 已 `_toolsCsBound` guard，安全 |

## 消費者窮舉（憲法②）
- 這些全是 is-收尾（outside-click 隱藏開關、scroll 對齊），無共享 handler 需保持單一註冊。
- 每檔已有 `window.__pageCleanup`（renderPage:379 每頁切換 consume 並 delete）。因為 renderPage 每頁切換只會刪掉「最後一次註冊」的 cleanup，要避免多個 cleanup 互相覆蓋 → **統一在每檔 onMount 尾端合併到單一 `window.__pageCleanup`，且該 cleanup 集中移除所有本頁註冊的常駐 listener**。

## 修法（每個累積點：具名 handler → 註冊時記住 → cleanup 移除；browser/deck 的 settings outside-click 用參照無名函式拉 module 級變數）
通式：
```
let _<page>DocHandler = null;              // module 級參照
function bindOnce<Name>() {                 // 冪等：重複 onMount 不重疊註冊
  if (_<page>DocHandler) return;
  _<page>DocHandler = (e) => { ... };
  document.addEventListener('click', _<page>DocHandler);
}
```
onMount 呼叫 bind；cleanup 內移除並置 null、並把既無名 keydown/visualViewport 一併納入，重組為單一 cleanup 函式（不覆蓋其他 listener 的移除）。

各具體：
1. **browser.js:421** card settings outside-click → `_bCardOutHandler`，在 openCardPreview 的 cleanup（現 `_cardKeyHandler`）同 cleanupshape 移除；改由 onMount 一次性綁（冪等），不再每次開卡片疊。
2. **browser.js:608** tag dropdown outside-click → `_bTagDocHandler`，onMount bind，cleanup 移除。
3. **tag-manager.js:291** palette outside-click → `_tmDocHandler`，onMount bind；本檔現無 __pageCleanup → 新增。
4. **study-spell.js:131** visualViewport resize → `_ssVvHandler`，onMount bind，cleanup 移除。
5. **deck-browser.js:1341** deck card settings outside-click → `_dCardOutHandler`，onMount bind，cleanup 移除。

所有頁面 cleanup 統一為**單一 `window.__pageCleanup`**（合併 keydown＋modal 移除＋常駐 listener 移除），renderPage 的 consume-and-delete 語意維持。

## 驗證（tools/verify-g11-listener-cleanup.mjs，全靜態，五檔）
- V1 每檔具名 handler 存在於 onMount 路徑（或 bind 函式），cleanup 內有 removeEventListener 同 handler、並置 null。
- V2 每檔 window.__pageCleanup 是單一定義（無多重覆蓋殘留；重組後仍恰一個）。
- V3 tools.js 維持 _toolsCsBound guard（不回歸）。
- V4 browser/deck 兩處 outside-click 均以 module 級變數參照（稱名）而非內嵌匿名 — grep `== null` 綁定檢查。
- V5 負控制：讀源碼「拔除」cleanup 移除行 → handler 註冊無對應移除（累積 bug 重現）。
- 每檔 build 過（npm run build）。

## 風險
- 中：跨 5 檔 DOM，需小心重組 __pageCleanup 不破壞既有 keydown/modal 移除。每檔 edit 後即跑對應 verify 段＋build。
- powers 語意不變（移除只是 prevent 常駐節點堆疊，各 handler 行為照舊）。

## 範圍外（憲法⑥）
- tools.js（已 guard）不動。
- exam-mc/spell/flip 系列的 window.__pageCleanup（B10 語意，獨立）不動。
- G29 (app-log refresh 併發)、G17 (render filter 效能) → 各自佇列。