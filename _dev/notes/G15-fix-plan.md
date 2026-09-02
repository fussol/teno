# G15-fix-plan — 移除 multi-accent distribution 撞色覆蓋

**Bug**（LEDGER G15 / audit 142行）：base.css:1391-1406「multi-accent distribution」block 把一堆互動/強調元素從 `var(--accent)` 單一主色覆蓋成 `--accent-secondary`（theme.js 色相 +45°）/ `--accent-tertiary`（−35°）撞色。

**違反點**：
1. 使用者設計原則＝Linear 式中性基底＋單一 accent，拒高飽和撞色。
2. 預定義主題（ocean/forest/sunset/mono 於 1131-1137）只定義 `--accent-secondary`（同色調降階），根本**沒定義** `--accent-secondary-container/glow`、`--accent-tertiary` 等變數 → 這些規則引用未定義變數，屬性失效（回退 initial）。
3. 1400 `.nav-item.active` 覆蓋 187 相同定義但**少 font-weight:600**，把字重洗掉。
4. 1401/1404 與前面 btn-primary/deck-item.active 純重複。

**修法**：整段 1390-1406（含註解標題行）刪除。所有元素回歸前面已定義的單一 accent 規則：
- 1391→620 `btn-icon:hover` 中性 hover（正確）
- 1392→956 `search-box:focus-within` accent
- 1393→129 `input/select/textarea:focus` accent
- 1394→263 `topbar-toggle:hover` 中性
- 1395→715 `modal-close:hover` 中性
- 1396→230 `sidebar-reopen:hover` 中性
- 1397→515 `config-opt.active` accent
- 1398→1085 `study-stat-ic`（原本無特別色）
- 1399→657 `switch.on` accent
- 1400→187 `nav-item.active`（回復 font-weight:600）
- 1401→598 `btn-primary`
- 1402→932 `word-row-pos` accent
- 1403→724 `tag-accent` accent
- 1404→219 `deck-item.active`
- 1405→635 `config-field-label .ic` accent
- 1406→294 `section-title .ic` accent

**驗證**：grep 確認無殘留 `accent-secondary/tertiary` 引用於互動元素；`:focus-visible` outline 仍用 `--accent`；build 過。無新變數引用。