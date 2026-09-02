# F7 修復計畫書 v1

## Bug 定義
冷啟動 splash 兩缺陷：
1. **深底→亮底閃爍**：`#splash` CSS 寫死深紫黑 `#0b0911`（base.css:760），JS 非同步
   resolve launcher icon 後（Android binder IPC／DB init，數百 ms）才 `style.background`
   換 preset.bg，且 `#splash` transition 只有 opacity（base.css:762）→ 瞬間色彩跳變。
   20 個 preset 裡 13 個是亮色底（杏桃 #F4C182／奶油／檸檬黃／rose…），桌面（非 Android）
   getLauncherIcon 恆回 'original'=#F4C182 → **每次冷啟動 100% 黑→橘閃爍**。
2. **getLauncherIcon 失敗不重試**：main.js splash IIFE（:35-46）invoke 失敗一次即
   fallthrough 到 DB fallback（`initDB(2)` 完整 migrate 慢路徑）。Android 冷啟動 binder
   plugin 尚未 ready 的瞬時失敗很常見 → 常態冷啟動被踢到最慢路徑。

## Root cause（實錘 2026-08-29）
- `index.html:11-17` splash DOM（static，無 bg 資訊）；`index.html:6` meta theme-color
  寫死 #0b0911（icon 切換後狀態欄色與 splash 脫節——附帶視覺面，見可選項）
- `src/styles/base.css:757-763` `#splash{background:#0b0911; transition:opacity .45s}`
- `src/main.js:18-27` `applySplashIcon(key)`：同步改 bg+img，無持久化
- `src/main.js:35-46` splash IIFE：`getLauncherIcon()` 單次嘗試→catch 即 DB fallback
- `src/main.js:388-398` init 完成退場點：重複 bg/img 套用碼（與 applySplashIcon 同邏輯兩份）
- `src-tauri/src/icon_android.rs:28-43` `get_launcher_icon`：`run_mobile_plugin` 失敗即
  Err（無重試）→ JS 端收到 throw；瞬時性（plugin handle 時序）
- 行號無漂移（mission 行號 index.html:11＋main.js:18-51 與實測一致；IIFE 實際 35-46 於
  mission 宣告的 18-51 區間內）

## 修法（三檔皆白名單內：main.js、base.css；index.html 不動）
### 1. base.css `#splash`：色彩切換柔化（秒閃→平滑）
`transition:opacity .45s var(--ease-emphasized)`
→ `transition:opacity .45s var(--ease-emphasized), background .35s var(--ease-emphasized)`

### 2. main.js：localStorage 開機_cache 前置（二次啟動零閃爍）_
repo 先例：easter-eggs/human-data 已用 localStorage 做非業務渲染 cache（业务資料
Pure SQLite 原則不破壞——本 cache 丟失自重建、單鍵、可殘）。
- `applySplashIcon(key)` 成功時寫 `localStorage['_splashIconKey']=key`（防無痕 throw，
  try/catch 吞）；並同步更新 `meta[name=theme-color]`（先例 theme.js:249 同款查改，
  狀態欄色跟 splash 底；init 完成後 applyTheme 會覆蓋回主題色，語意正確分層）
- IIFE 最前（module 頂部同步段）：讀 cache 命中即 `applySplashIcon(cached)` 零等待套用
- init 退場點（:388-398）重複 bg/img 碼收斂為呼叫 `applySplashIcon(key)`（消雙份漂移）

### 3. main.js IIFE：getLauncherIcon 重試
try 改 3 次嘗試、間隔 150ms（`for i<3`，最後一敗才落 DB fallback）。Android plugin
未 ready 瞬敗由第 2/3 次接住，慢路徑只剩真環境性失敗。

### 4. settings.js：切 icon 成功即更新 cache（消失同步窗口）
`setLauncherIcon(key)` 成功後一行 `localStorage.setItem('_splashIconKey', key)`（inline
字串；驗證腳本成對釘：main.js 賦值端＋settings.js 賦值端＋鍵名字面恰 2 處計數釘，
D10 T1h 唯一定義體例）。DB setSetting 投機寫時（樂觀更新 :833）同步寫——cache 與 DB
同點更新，零額外窗口。

## 可選項定案（憲法⑦）
- meta theme-color 跟 splash 底：**做**（同上；applyTheme 在 init 後覆蓋回主題，分層正確）
- splash 初始底色改為由 theme cache 決定：**不做**——CSS 解析期無 JS、讀 theme cache 需
  inline script 入 index.html（新增渲染阻塞面）；柔化＋icon cache 已消用戶感知面
- splash icon 圖檔 preload link：**不做**——img 同節點換 src 瀏覽器快取即秒換，且圖檔
  完整性屬 G31（佇列尾，另顆處理）
- icon_android.rs 端 Rust 重試：**不做**——白名單外（src-tauri）；JS 端重試達到同等用戶
  感知效果，Rust 側登記範圍外

## 驗證方式
`tools/verify-f7-splash.mjs`：
- T0 PRE 態斷言（bug 實錘必紅機制同 D6 v2 模式自判）：CSS transition 無 background、
  main.js 無 cache 讀寫、無重試迴圈 → BUG 態 EXIT=1
- T1 靜態釘（遮罩後源碼）：
  - T1.1 base.css #splash transition 含 background
  - T1.2 main.js cache 賦值端＋讀取端成對（localStorage 鍵字面 count==1 in main.js）
  - T1.3 頂部同步讀 cache 位置 < IIFE 起始位置（前置順序釘）
  - T1.4 重試釘：for/while + 嘗試計數 ≥3 + setTimeout/sleep 间隔 存在於 IIFE 內
  - T1.5 meta theme-color 更新在 applySplashIcon 內
  - T1.6 settings.js 鍵字面 count==1（成對）
  - T1.7 兩檔鍵字面合計 == 2（D10 唯一定義釘）
  - T1.8 退場點無重複 bg 指派（`splash.style.background` 於 main.js 只出現 1 次＝
    applySplashIcon 內）
- T2 提取式動態腿（/tmp harness，D10 T3 體例）：以錨點註解抽出 splash 段＋mock
  $/ICON_PRESETS/getLauncherIcon/initDB spy，真執行：
  - T2.1 cache 命中 → 同步套用 preset.bg（無 await）
  - T2.2 getLauncherIcon 首敗次成 → 套用成功且 initDB spy 未觸發（重試生效）
  - T2.3 getLauncherIcon 三連敗 → initDB fallback 觸發恰好 1 次
  - T2.4 applySplashIcon 寫 cache＋meta theme-color 更新
  - T2.5 幽靈 key → 落 ICON_PRESETS[0]（防禦回退原語意保留）
- T3 負控制：BUG 版原文常量 → T1.1/T1.2/T1.4 精準紅
- 渲染驗證（Mission 規定）：起 vite dev → browser 截 splash 兩幀（初始＋切換後）→
  ollama llama3.2-vision 驗「底色與 icon 圖一致、無刺眼跳色」；cache 腿用第二次重新整理
  截圖證即時底色。無法驗證時於本節實註。
- 回歸：node --check（main.js/settings.js）、vite build、既有 verify ≥3（g12/g13/g14＋
  splash 域最近 g9?）＋ version.sh patch

## 風險
- cache 與實際 icon 失同步（換 icon 後首次冷啟動先用舊 key 再糾正）：修法 4 在切換成功
  點同步寫消窗口；殘留＝切換 crash（Android 重啟前）且 DB 投機寫未遂 → transition .35s
  柔化二跳，接受
- localStorage 在 Android WebView 被清（用戶清資料）→ 等於首裝態＝現行為＋柔化，無害
- 重試 3×150ms 全敗才 DB fallback：比現行多 300ms 極端路徑延遲；換取常態瞬敗不走
  initDB migrate 慢路徑（數百 ms~秒級），淨改善
- theme-color meta 與 applyTheme 兩寫點：splash 階段 icon 底、init 後主題色——分層語意
  於註解成文

## 範圍外清單
1. icon_android.rs get_launcher_icon Rust 端重試（白名單外）
2. splash 圖檔完整性／preload（G31 佇列另顆）
3. index.html inline theme 前置（可選項已裁：不做）
4. initDB 冷啟動總體提速（他域）

## 送審前實跑證據（2026-08-29）
- PRE（repo bug 態）：`node tools/verify-f7-splash.mjs` → RESULT[BUG] 7/7 PASS＋15 N/A、
  EXIT=1（必紅＝bug 確認：T0.1-T0.6 打真實源碼，含「bg 碼雙份==2」結構錘）
- POST 仿真（委員可復跑）：`node /tmp/f7-post-sim.mjs` → /tmp/f7post 全樹套修法全文後
  RESULT[FIXED] 17/17 ALL PASS EXIT=0；T2 動態腿真實執行生產 F7-SPLASH 段（mock 僅在
  `_splashDeps` 注入 seam，括號計數器定位），五案全過：直接成功三寫一致／瞬敗重試次成
  擋下 initDB／三連敗恰一次 DB fallback／幽靈 key 回退／cache 一致零跳色（bgSeq 相鄰
  去重恰 1 筆——同色二次 apply 非跳色，故去重斷言）
- 驗證器雙遮罩形態：序斷言用全遮罩（註解＋字串）；鍵字面/theme-color 等字串值偵測用
  commentMask（去註解保字串）—— threats：字串內 decoy 不防（不影響 runtime 鍵值），成文
- 段自含鐵律：F7-SPLASH 段在 module 頂部同步執行，不可引用後段 `const $`（main.js:76
  TDZ）→ applySplashIcon 用 document.getElementById（T1.10 釘 `$(` 零引用）

## 審查明產
v1：R1 三席（2✅ #1/#2、❌ #3 鑑識席）。POST 仿真器 /tmp/f7-post-sim.mjs 內含修法全文
（逐字錨點替換，失配即 EXIT=2 防行號漂移）。

---

## 修訂歷史
### v1.1（2026-08-29，R1#3 ❌ 處方全收錄 + R1#1 兩項加固）
R1#3 逮獲 4 個驗證器假綠面（D6 M5 hoisting 同族），處方全數落地：
1. **T1.11 宣告唯一性釘**：splash 四函式（applySplashIcon/resolveSplashIcon/
   readSplashCache/writeSplashCache）行首錨定宣告計數（含 async 前綴）恆 ==1
   → 殺攻擊 e/g（檔尾藏 bug 版 hoisting 覆蓋）。
2. **T1.8 泛化**：`/.style.background=/` 全檔恰 1（去 splash. 前綴殺 h3 別名重植入
   深底）＋ `setProperty('background` ==0 ＋ `style.cssText` ==0（迴避面封死）。
3. **T1.12 seam 本體釘**：_splashDeps 塊 commentMask 提取，四鍵＋`import('./lib/api.js')`
   ×1＋`import('./lib/db.js')` ×2 字面在位 → 殺 h5（seam 內硬編碼 mock 應付動態腿）。
4. **seam 提取 h4 修正**：錨點/括號計數改在 masked 上（字串內 `'}{'` 遮平），raw 同
   offset 切本體 → 崩潰攻擊轉結構性無效。
5. **T2.6 補案**（R3 建議）：三連敗＋DB fallback 讀到真 key（graphite #2B2B2B，
   實檔 icon-presets.js:16）→ fallback 非只 original 一路。

R1#1 加固（✅ 附帶條件，主席裁決吸收進 v1.1 而非留瑕疵）：
6. **meta theme-color 加 `#theme-injected` guard**（theme.js:245 applyTheme 首跑單調
   標記實存已驗）：applyTheme 已跑則 splash 遲到回調讓位，防 icon 底坐實整個 session
   （#1①/…O-1 同源）。
7. **applySplashIcon(key, persist=true) ＋退場點 persist=false**：store init 失敗時
   default 'original' 純渲染不寫 cache，防正確 cache 被污染跨啟動持久化（#1②）。
   新增 T1.13 靜態釘。

勘誤（誠實性，R1 兩席指出）：
- #splash transition 實際行號 :761（計畫書 :762 微漂）；IIFE 起點 :34；仿真器逐字錨點
  自帶漂移保險（失配 EXIT=2）。
- 20 preset 亮底實數 15（非 13）；方向更嚴重，結論不變。
- 「二次啟動零閃爍」降格為「JS 期零閃爍；pre-JS 首幀跳色由 .35s transition 柔化」
  （module script deferred，慢機首幀可能已 paint CSS 深底——#1③ 措辭勘誤）。

v1.1 雙態實跑（2026-08-29）：
- PRE：RESULT[BUG] 7/7＋19 N/A，EXIT=1
- POST 仿真：RESULT[FIXED] 21/21 ALL PASS，EXIT=0（T2 六案全過，含 T2.6）
