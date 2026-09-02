# G1 — accent-on 對比修復計畫書（v7 — 定案 ✅）

狀態：**第 6 輪 5/5 ✅ 全數通過 — 定案可實作（2026-08）**
關聯：使用者「手機按任何按鈕都會反白」＝ G1 症狀

## Bug 定義

`--accent-on`（accent 背景上的反白文字色）在多數主題下對比不足：
- 現行實作（theme.js:189）：`intensity < 0.3 ? hsl(h,aSat,isDark?92:12) : '#ffffff'` — 幾乎永遠白色
- 實測（委員 #2/#3）：**現況 66-79/80 案例失敗**（白字 1.07–4.37:1）；預設 skyBlue dark 白字僅 **1.52:1** — 看不清楚

## Root Cause

`--accent-on` 是**硬編碼二選一**，沒對實際渲染背景色算任何對比。v1 擬案（YIQ + 原始 hex）已被證偽：
- YIQ 對**原始 hex** 算，但實際渲染色是 `hsl(h, aSat, aL)` clamp 重造（亮度與原始脫鉤）
- 二選一對 mid-tone 註定有一邊 <4.5
- 實測 v1 方案 **97/400 組合仍 <4.5**（olive dark 僅 1.07:1、periwinkle light 2.33、slate light 2.93…）
- **⚠️ fix-plan-critical-v3.md:57-59 的 G1 條目仍是 v1 YIQ 方案（已標定案）→ 內容已證偽，需以本計畫書取代**

## v7 修正方案（吸收 14 名委員人次歷輪全部盲點）

### 1. theme.js — 候選鏈選色（核心，歷輪全部委員獨立實測 0 失敗）

`generateAccentVars(h, sat, light, isDark, intensity)`（theme.js:167）內新增：

```js
// 新增 helper（放 theme.js 內）
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r,g,b] = [c,x,0]; else if (h < 120) [r,g,b] = [x,c,0];
  else if (h < 180) [r,g,b] = [0,c,x]; else if (h < 240) [r,g,b] = [0,x,c];
  else if (h < 300) [r,g,b] = [x,0,c]; else [r,g,b] = [c,0,x];
  return [r + m, g + m, b + m];
}
function relLum(rgb) { // rgb 0-1
  const lin = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}
function contrast(a, b) {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
```

`--accent-on`（:189）改為：

```js
// 8-bit 量化後再算對比（瀏覽器把 hsl() 量化成 8-bit 才渲染，float 過關渲染可能 <4.5）
const accentRgb = hslToRgb(h, aSat, aL).map(v => Math.round(v * 255) / 255);
const candidates = [[0x16,0x0e,0x2b],[0xff,0xff,0xff],[0,0,0]]; // #160e2b → #fff → #000
const pick = candidates.find(c => contrast(accentRgb, c.map(v=>v/255)) >= 4.5) || [0,0,0];
'--accent-on': `rgb(${pick.join(',')})`,
```

**⚠️ 實作坑**：
- hslToRgb 吃**度數 h**（hexToHSL 回 0-360），不要吃 0-1
- WCAG 線性化門檻是 **0.03928**（不是 sRGB gamma 的 0.04045）
- 直接傳 `(h, aSat, aL)` 給 hslToRgb，**不要 parse 自產的 `hsl(...)` 字串**
- s=0 灰階 c=0 無除零，不需特判（但測試要含）
- **候選色是「渲染色」**：候選鏈回傳的整數 rgb 即最終值，不再套用任何 filter/opacity

### 2. base.css:163 `.sidebar-logo` — 漸層改純色（委員全數一致 🔴）

`background: linear-gradient(135deg, var(--accent), var(--cyan))` → `background: var(--accent)`

實測：cyan 端對比崩潰（midnight 2.30:1、sage light 3.74、winterPine light 3.37）；純色是唯一乾淨解。

### 3. base.css:598 及 :1398 `.btn-primary` — 兩處都改純色（委員全數一致 🔴）

- :598 `background: linear-gradient(135deg, var(--accent-deep), var(--accent))` → `background: var(--accent)`
- **:1398 有同名重複定義（multi-accent 區塊，同 specificity 後者勝）→ 兩處都要改，只改 598 等於沒改**
- 純色 token **寫死 `var(--accent)`**（不能 `var(--accent-deep)` — 字色對 accent 算，deep 更暗崩盤）
- 漸層移除無副作用：`--accent-deep` 仍有 hero-bar-fill:356、review-progress-fill:491、study-progress-fill:1152 消費者（全為無文字進度條，安全；exam-progress-fill:544 實為 accent→accent-secondary 漸層，非 accent-deep 消費者）

### 3b. hover 回饋 — 移除明度變化，改陰影＋位移（opencode #4/#5 抓 🔴）

- **base.css:601** `.btn-primary:hover` — 刪除 `filter:brightness(1.05)`，保留 `box-shadow: 0 6px 20px var(--accent-glow); transform: translateY(-1px)`
- **base.css:1175** `.study-flip-btn:hover{background:var(--accent-dim)}` → **改** `box-shadow:0 6px 22px var(--accent-glow);transform:translateY(-1px)`（不能只刪除 — 原本唯一 hover 提示就是換背景；陰影/位移安全，glow 是 0.18 alpha 不影響文字對比）
- **base.css:1210** `.study-submit:hover{background:var(--accent-dim)}` → **改** `box-shadow:0 4px 14px var(--accent-glow)`
- 實錘：accent-dim hover 362-364/1680 失敗（最差 olive light@0.8 = 1.93）；brightness(1.05) 43-44/1680 失敗

### 3b2. **tag hover opacity — 漏網的 accent opacity 消費者（第 5 輪委員 #3 抓 🔴🔴）**

- **base.css:932** `.word-row-tags .tag:hover{opacity:.7}` — tag chip（v6 修後 fallback 時背景=accent、文字=--accent-on）hover 時整顆 0.7 opacity 與 word-row 背景合成 → **1000+/1680 案例崩潰**（正確合成模型：文字同受 opacity 合成；最差 candyPink light@0.65 靜態 4.50 → hover 2.19-2.30）
- **v6 宣告「修後無 accent opacity 消費者」是錯的** — 已撤銷
- **修法**：`base.css:932` 改 `box-shadow:0 0 0 1.5px var(--accent-on)`（保留 hover 提示、不動對比；用 accent-on 而非 accent — fallback tag 背景即 accent，用 accent 會同色不可見）
- 驗證項目 2 的 :active/hover 合成矩陣必須包含 `.tag:hover`，且合成模型須含文字本身透明度合成

### 3c. :active opacity — 手機 tap 瞬間崩潰（第 3 輪委員 #3 抓 🔴🔴）

- **base.css:1176** `.study-flip-btn:active{opacity:.85}` → **改** `transform:scale(.97)`（比照 `.btn:active` base.css:**594**）
- **base.css:1211** `.study-submit:active{opacity:.85}` → 同上
- 實錘：opacity .85 合成 — 1680 案例 **316 例 <4.5**（最差 candyPink light@0.65 靜態 4.55 → 按下 3.27）；預設 intensity 0.5 就有 14 例失敗

### 3d. 硬編碼 `color:#fff` 在 accent 背景上 — 實為 **24 處**（歷輪委員抓 🔴🔴）

**A. 靜態模板（12 處）— `color:#fff` 直接改 `var(--accent-on)`：**

| 檔案 | 位置 | 元素 |
|---|---|---|
| src/pages/settings.js | :118 | `.voice-chip.active`（`#fff !important`） |
| src/pages/settings.js | :425 | 設定頁 logo「T」tile |
| src/pages/dashboard.js | :35 | chart-range-tab active |
| src/pages/deck-browser.js | :489,490,779,893,894 | def/ex 晶片、pos-chip selected 模板 |
| src/pages/browser.js | :760,871,872 | pos-chip selected 模板、def/ex 晶片 |
| src/pages/app-log.js | :37 | kind badge |

**B. JS runtime inline setter（6 處）— `chip.style.color = '#fff'` 改 `'var(--accent-on)'`：**

| 檔案 | 位置 | 元素 |
|---|---|---|
| src/pages/browser.js | :1020 | `_selectPosChips`（**inline style 優先權最高，會蓋掉 A 類模板修法**） |
| src/pages/browser.js | :1128 | fPosGroup click handler |
| src/pages/deck-browser.js | :502,512 | deckAddPosGroup |
| src/pages/deck-browser.js | :904,914 | deckEditPosGroup |

**C. tag chip `var(--accent)` fallback（4 處）— ⚠️ 條件要用查表（v7 修正，第 5 輪委員抓型別錯誤）：**

`t` 是**字串**（tag name），`t.color` 恆 undefined → 用 `t.color ?` 條件式恆 false → 深色自訂色 tag 崩到 1.61:1。**條件必須用查表 truthiness**：

```js
// browser.js:135 / deck-browser.js:158（tc = tagColors || {} 查表）
color:${tc[t] ? '#fff' : 'var(--accent-on)'}
// browser.js:277 / deck-browser.js:1244（tagConfig 查表）
color:${(s.state.tagConfig || {})[t] ? '#fff' : 'var(--accent-on)'}
```

| 檔案 | 位置 | 元素 |
|---|---|---|
| src/pages/browser.js | :135, :277 | tag chip（`tc[t] || 'var(--accent)'`） |
| src/pages/deck-browser.js | :158, :1244 | tag chip（`:1244` 用 `tagConfig` fallback） |

**D. `#a78bfa` 固定 fallback tag chip（2 處，v7 新增 — 第 5 輪委員抓 🔴）：**

**不能照抄 `var(--accent-on)` — 此處 fallback 背景是固定色 #a78bfa 不是 accent token**：

```js
// browser.js:23 / deck-browser.js:22（tagPickerHtml）
// 現況：<span class="tag" style="background:${t.color || '#a78bfa'};color:#fff">
// 實測 #a78bfa vs #fff = 2.72:1（確定性失敗）；#160e2b vs #a78bfa = 6.82:1
color:${t.color ? '#fff' : '#160e2b'}
```

| 檔案 | 位置 | 元素 |
|---|---|---|
| src/pages/browser.js | :23 | tagPickerHtml（t 是**物件**，`t.color` 可用） |
| src/pages/deck-browser.js | :22 | 同上 |

**⚠️ 驗證 grep 規則（v7 強化）**：grep 全 src：`'#fff'`/`"#fff"`/`#ffffff`/`color:#fff`/`style.color` 全部掃，人工確認背景是否 accent 系（含 template、inline、JS setter 三種形態）。

範圍外（另立 bug，不併入 G1）：base.css:550/551、1200/1202 白字在 `--green/--red` 上；base.css:1181 `.study-btn` light 白字 1.08:1（:active opacity .8 一併列入）；**tag chip 有自訂色者（不限深淺）一律另立 bug** — 白字分支僅對深色自訂色安全（淺色 #22d3ee 1.81、#4ade80 1.74、#fbbf24 1.67、#fb923c 2.26、#f0ecf5 1.17、中亮度 #808080 3.95、#4682B4 3.88 全 <4.5）；accent-as-text-on-container（.config-opt.active/.nav-item.active light 淺 accent 字）。

### 4. switch — **移出 G1 範圍，另立 bug**（第 4/5 輪委員 🔴）

- **base.css:1396 維持現狀**（`var(--accent-secondary)`）— 修法全矩陣實測有 6 regression（skyBlue 6.53→1.96 等），無單一 token 能全 80 組合 ≥3:1
- **⚠️ 另立 bug 文件必須記：base.css:655 `.switch.on::after{background:var(--accent-on)}` — knob 是 --accent-on 的隱藏消費者**，候選鏈改值後 dark 主題 knob 從白變深紫（1307/1680 選 #160e2b），基線變動需以「修後值」評估（現況最差 1.000:1 → 修後最差 1.586:1，仍 <3:1 非文字下限）

### 5. theme.js:172 aL 下限 38→36（light 模式）— 「可選」（🟡）

- `Math.min(Math.max(light - 12, 38), 55)` → `36`
- 非對比修復必要項（floor=38 時 sage 黑字 4.79 已達標，36 只是 sage 黑→白）；影響 8 主題 light accent 暗 2 點
- **決策：保留（視覺較自然）但列為可選**

### 6. 測試區間修正（🔴）

- 滑桿實際 `min="0" max="1" step="0.05"`（settings.js:174）→ 驗證區間 `{0, 0.05, …, 1.0}` = **1680 案例**
- **最薄裕度：terracotta light@0.3 = 4.5038（8-bit）**（歷輪委員一致）；worst-8 全擠 4.50–4.52
- babyBlue light：0.9 → #160e2b 4.53、0.95 → 黑字 4.67（白字 8-bit 4.4979 <4.5 被正確拒絕）、1.0 → 白字 4.95
- 全色相掃描最差 ≈4.50

### 7. 不做的事

- `.theme-*` 靜態覆蓋（base.css:1128-1136）— 死碼：全 repo 無任何 JS/HTML 套用這些 class（specificity `:root.theme-ocean` 0,2,0 高於 JS 注入 `:root` 0,1,0，一旦套用會繞過候選鏈）。不動，建議加註或日後刪除
- THEMES.js 6 色 preset — 未被任何檔案 import（死碼），不動

## 驗證項目

1. Node 實測：40 主題 × dark/light × intensity{0, 0.05, …, 1.0} = 1680 案例，**候選鏈（8-bit 量化後）全 ≥4.5**
2. **:active/hover 合成對比**：全部 accent-on 使用點 × 1680 案例，sRGB 合成模型 ≥4.5 — **必須含 `.tag:hover`（base.css:932）與 `.study-flip-btn:active`（1176）、`.study-submit:active`（1211）**
3. 灰階（aSat=0）＋全色相 360° 掃描 ≥4.5
4. **全專案 grep（v7 強化版）**：`'#fff'`/`"#fff"`/`#ffffff`/`color:#fff`/`style.color` 全掃 — accent 背景＋白字組合 = 0（含 template、inline、JS setter 三種形態；非 accent 系如 splash-name:779/784、spinner、swatch:915、tag-manager border:129/138 已人工判別排除）
5. logo/btn-primary/study-flip/study-submit/tag chip/**badge（base.css:191 `.nav-item.active .badge`、:834 `.bottom-badge` — 既有 --accent-on 消費者，自動受益，須入驗證防日後背景被改）** 靜態＋hover＋active 對比 ≥4.5
6. `vite build` 通過
7. 手機/瀏覽器實際點按鈕（反白文字清晰）

## 風險

- light 8 主題 accent 視覺暗 2%（可選項，跳過則無）
- **dark/light 按鈕文字都黑白混用**（dark 也混用：midnight 等深 accent→白字、skyBlue 等淺 accent→#160e2b）— 對比全過，視覺跳 tone 可接受
- hover/tap 回饋改變：hover 變陰影＋位移、tap 變 scale(.97)、tag hover 變 outline — 手機無感，桌面可接受
- **裕度極薄**：多案落在 4.50x（8-bit）— **任何背景明度變化（filter/opacity/漸層）都會一次跌破多案，日後加樣式必須重驗**
- switch 不在本次修（另立 bug，含 knob 基線變動）— 已知 light 22/40 <3:1 維持現狀

## 審查歷程

- 第 1 輪（v1 YIQ）：0/5 ❌ — YIQ 對紅粉誤判、沒算渲染色（97/400 失敗）
- 第 2 輪（v3）：delegate 2❌1✅＋opencode 2❌ — 抓 hover brightness、study-flip/submit accent-dim、測試區間 0-1
- 第 3 輪（v4）：delegate 3❌ — 硬編碼 #fff 11 處＋8-bit 量化＋:active opacity＋hover 零回饋
- 第 4 輪（v5）：5/5 ❌ — #fff 實為 18 處（JS inline setter）＋tag fallback 4 處＋switch 軌道 light 22/40 <3:1
- 第 5 輪（v6）：delegate 3❌ — **C 類 `t.color` 型別錯誤（t 是字串，恆 false → 深色自訂色 tag 1.61:1）＋#a78bfa 漏 2 處（2.72:1）＋tag hover opacity（1000+/1680）＋switch knob 基線** → v7 修正 C 類查表＋D 類新增
- 第 6 輪（v7）：**5/5 ✅ 全數通過** — delegate 3 + opencode 2 全部獨立復現：1680 案例 0 失敗（最薄 terracotta 4.5038）、合成矩陣四項（accent-dim 364/brightness 43/tag-hover 837/:active 316）復現、24 處清單 100% 零遺漏、C/D 型別語意正確。非阻塞瑕疵 2 項：candyPink 靜態 4.55（:97 為準）、系統 `correct` tag #4ade80+#fff=1.74:1 列另立 bug 優先。
- **定案 ✅（2026-08）**

## 動工 Checklist（憲法第 8 條）

| # | 位置 | 修法 | ✅ |
|---|---|---|---|
| 1 | theme.js:167+ | 新增 hslToRgb/relLum/contrast helpers | ☐ |
| 2 | theme.js:189 | 候選鏈（8-bit 量化，#160e2b→#fff→#000 取 ≥4.5） | ☐ |
| 3 | theme.js:172 | aL 下限 38→36（可選 — 決策：**做**，視覺較自然） | ☐ |
| 4 | base.css:163 | sidebar-logo 漸層→純色 var(--accent) | ☐ |
| 5 | base.css:598 | .btn-primary 漸層→var(--accent) | ☐ |
| 6 | base.css:1398 | .btn-primary 第二定義→var(--accent) | ☐ |
| 7 | base.css:601 | 刪 filter:brightness(1.05)，留陰影+位移 | ☐ |
| 8 | base.css:1175 | study-flip hover accent-dim→box-shadow+translateY | ☐ |
| 9 | base.css:1210 | study-submit hover accent-dim→box-shadow | ☐ |
| 10 | base.css:1176 | study-flip :active opacity→scale(.97) | ☐ |
| 11 | base.css:1211 | study-submit :active opacity→scale(.97) | ☐ |
| 12 | base.css:932 | .tag:hover opacity→box-shadow outline accent-on | ☐ |
| 13 | settings.js:118 | voice-chip.active #fff→var(--accent-on) | ☐ |
| 14 | settings.js:425 | logo T tile #fff→var(--accent-on) | ☐ |
| 15 | dashboard.js:35 | chart-range-tab #fff→var(--accent-on) | ☐ |
| 16 | app-log.js:37 | kind badge #fff→var(--accent-on) | ☐ |
| 17 | browser.js:760,871,872 | pos-chip/def/ex #fff→var(--accent-on) | ☐ |
| 18 | deck-browser.js:489,490,779,893,894 | 同上 | ☐ |
| 19 | browser.js:1020,1128 | inline setter #fff→var(--accent-on) | ☐ |
| 20 | deck-browser.js:502,512,904,914 | 同上 | ☐ |
| 21 | browser.js:135,277 | tag chip tc[t] 查表 | ☐ |
| 22 | deck-browser.js:158,1244 | tag chip tagConfig 查表 | ☐ |
| 23 | browser.js:23 | tagPicker #a78bfa→#160e2b 深字 | ☐ |
| 24 | deck-browser.js:22 | 同上 | ☐ |

驗證：①Node 1680 案例（8-bit）≥4.5 ②合成矩陣 ③grep 全 src #fff 剩餘=非 accent ④vite build ⑤手機實測
