# Teno Design System (DESIGN.md)

> 單一真相來源 — 所有 UI 決策的依據（stitch-skills: no theme leakage）。
> 生成/開發時禁止在元件層 inline 即興色值；顏色/字體/尺寸必須落在本文件定義的 token 階梯內。

## 1. Visual Theme & Atmosphere

Teno 是英文單字學習 app（FSRS 間隔重複）。視覺語言以「字卡」為主角：
深色優先（MD3-inspired tonal elevation）、暖中性紫黑基底、單一 accent（預設 plum）。
學習卡是 signature element：大字單字 + accent 底線 + mono 音標，全螢幕居中。
整體感受：精密、安靜、學習工具感 — 不是娛樂 app。

## 2. Color Palette & Roles

### Primitives（基底，定義於 base.css `:root`）
| Role | Dark | 用途 |
|------|------|------|
| `--bg-base` | `#0b0911` | 頁面底（暖紫黑，非純黑） |
| `--bg-surface` | `#14111c` | 側欄/卡片 |
| `--bg-elevated` | `#1c1825` | 輸入框/浮層 |
| `--bg-hover` | `#241f31` | hover 層 |
| `--bg-active` | `#2c2639` | pressed 層 |
| `--text-primary` | `#f3eefb` | 標題/主文字 |
| `--text-secondary` | `#b9b2cc` | 內文 |
| `--text-tertiary` | `#807899` | 次要/說明 |
| `--text-disabled` | `#4d4663` | 禁用 |

### Accent（唯一彩色，稀有使用）
`--accent: #b69dff`（plum）— 只花在：主按鈕、active nav、選中狀態、進度、學習卡底線。
`--accent-dim / --accent-deep` — hover/深階。`--accent-on` — accent 上的文字（深色）。
禁止：side-tab 色條、accent 光暈裝飾、漸層文字。

### Semantic（作答狀態，跨主題固定）
`--green`（Good/成功）、`--amber`（Hard/警告）、`--red`（Again/錯誤）、`--cyan`（Easy/資訊）、`--orange`。
語意色一律用 CSS 變數引用（`var(--green)`），禁止 inline hex 散落。

## 3. Typography Rules

- **Font stack**：`--font: 'Noto Sans TC', system-ui, ...`（中文學習 app，系統級中文優先；不載入 Inter 等網路字體 — 離線可用）
- **Mono**：`--mono: 'JetBrains Mono', 'Fira Code', ui-monospace` — 音標、進度計數、統計數字
- **數字一律 tabular**：`font-variant-numeric: tabular-nums`（計時、計數、統計不跳動）
- 階層：page-title 28px/700 → section-title → 內文 13-15px；靠字重+顏色建立層級，不狂放尺寸
- 深色內文 line-height 1.6，max-width 65-75ch
- 標題 `text-wrap: balance`、內文 `text-wrap: pretty`（防孤字）

## 4. Component Stylings

- **Buttons**：pill 主按鈕（accent 底 + accent-on 字）、ghost 次要（elevated 底 + border）；radius `--r-full`
- **Cards**：`--bg-surface` + `1px var(--border-subtle)` + radius `--r-lg/--r-2xl`；卡片**無預設陰影**（深度靠 surface 階梯 + hairline）
- **Study card（signature）**：`.study-word` 38px/700 大字單字 + `.study-word::after` 32px accent 底線 + mono 音標
- **Inputs**：elevated 底、focus 時 accent border + `--accent-glow` 外框（`:focus-visible` 全域 outline 替代）
- **Modal/Toast**：toastIn 由下浮入；modal 用 `overscroll-behavior: contain`

## 5. Layout Principles

- 間距階梯（4dp base）：`--s1:4px → --s2:8px → --s3:12px → --s4:16px → --s6:24px → --s8:32px`
- Radius 階梯：`--r-xs:4 / --r-sm:8 / --r-md:12 / --r-lg:16 / --r-xl:24 / --r-2xl:28 / --r-full`
- 側欄 264px、學習卡 max-width 640px、儀表板 max-width 1180px
- 觸控：web ≥ 44px、Android ≥ 48dp；`touch-action: manipulation`
- 安全區：`viewport-fit=cover` + `env(safe-area-inset-*)`

## 6. Motion & Interaction

- Duration tokens：`--t-fast:120ms / --t-med:220ms / --t-slow:380ms`
- Easing：`--ease-standard: cubic-bezier(.2,0,0,1)`（MD3 emphasized）；禁 bounce/elastic
- **只動 transform/opacity**（keyframes 全部符合）；progress fill 動 width 是唯一例外（fill 本質）
- `prefers-reduced-motion: reduce` 全域降級（0.01ms + 單次迭代）
- 裝飾性 pulsing dot / marquee / 無限迴圈動畫：禁止（splashPulse 是載入指示，例外）

## 7. Anti-Patterns (Banned)

- **em-dash（—）**：UI 文案完全禁止，用逗號/冒號/連字符
- **Inter / Roboto** 字體（過度使用）：用 Noto Sans TC 系統字體
- **純黑 `#000` / 純白 `#fff` 大面積**：基底一律 tinted（暖紫黑）
- **`transition: all`**：明確列出屬性
- **inline hex 語意色**：用 var(--green/red/amber/cyan)
- **side-tab 色條、nested cards、icon-tile-stack、kicker/eyebrow、漸層文字、光暈 shadow**
- **假數據/假指標**：學習 app 嚴禁塞虛構統計
- 霓虹 glow、glassmorphism 濫用、3 等分 feature 卡

## 8. Theme Switching（動態）

`applyTheme(mode, accentName, intensity)` 動態注入 `:root` CSS 變數（theme.js）。
主題切換只改 token 值，不改元件樣式（token 與內容分離）。
`theme-color` meta 需隨背景同步更新（深/淺模式）。
