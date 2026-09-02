# G12 修法計畫書 v1.0

## Bug 定義
`src/styles/base.css:102` 硬編碼 `html{...;color-scheme:dark}` → **不論 light/dark，原生控制項（select/checkbox/scrollbar/input 反白）一律強制深色渲染**。light mode 時背景是淺色，但原生控制項仍是深色，視覺衝突。audit G12：「light mode color-scheme 仍 dark → 原生控制項深色殘留」。

## Root Cause
color-scheme 被寫死在 CSS，沒有跟 theme 的 mode（light/dark）連動。theme.js 的 applyTheme 注入 `:root{--bg-base:...}` 等變數，但從未控制 `color-scheme`。

## 修法（兩點協同）
1. **base.css:102** — `color-scheme:dark` 改為 CSS 變數驅動，fallback dark：
   `color-scheme: var(--color-scheme, dark)`
2. **theme.js:applyTheme（:244 css 注入）** — 在 `:root{...}` 加入 `--color-scheme` 依 mode：
   `const css = ':root{' + (isDark?'':'--color-scheme:light;') + ... }` 或統一加 `--color-scheme:${isDark?'dark':'light'};`

## 消費者清單（憲法②）
- `color-scheme` 讀取者：瀏覽器原生控制項渲染（隱含，非 code 消費者）
- base.css:102 html rule（唯一硬編碼處，grep 實錘）
- theme.js applyTheme：唯一主題套用注入點（main.js H15 呼叫；切換設定頁時重行）
三形態：CSS rule + JS 注入變數 — 同時涉及 template/CSS 兩形態。

## 驗證
- 靜態：base.css:102 不再含字面 `color-scheme:dark`（改為 var）
- theme.js 注入的 :root CSS 在 dark 含 `--color-scheme:dark`、light 含 `--color-scheme:light`
- harness（tools/verify-g12-color-scheme.mjs）：
  - T1 讀真實 base.css → `color-scheme: var(--color-scheme, dark)` 存在（fix marker）
  - T2 讀真實 theme.js → applyTheme 注入 `--color-scheme:${mode}`
  - T3 靜態：dark 時注入 dark、light 時注入 light（parse applyTheme 字串）
  - T4 負控制：移除 var 改回 dark → T1 fail（bug 重現）

## 風險
- 極低：加一個 CSS 變數，不影響既有色譜生成；原生控制項跟隨 mode 正常化。

## 範圍外
- H15（applyTheme 只在 init 後執行一次，切換設定頁不更新）— 另開案，本顆不改 main.js。
- 其他深色殘留（如 scrollbar）若 CSS 另有硬編碼 — grep 已確認僅 :102 一處，無其他。

## 審查委員數
簡單 bug（base.css + theme.js 兩協同點、低風險、<15 行）→ 依法①降 1 名委員（總統親審實測雙向）。