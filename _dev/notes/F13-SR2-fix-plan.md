# F13-SR2 修復計畫書（v1.0，送審凍結）

## Bug 定義
Cambridge 新 tw-/superentry 模板條目頁（get-rid-of、take-a-shower）零 `.entry-body`，
`scrape_cambridge_html` 強依賴 `.entry-body`（english.rs:48 定義、:67-70 檢查、:85 主
迴圈前提）→ 直回 `Err(WordNotFound)`。舊 hello 模板（有 `.entry-body`）仍綠＝非全局
壞，為該 scraper 域前顆 F13（URL 層）留文登案的模板選擇器漂移尾巴。

## Root cause（實錘 2026-08-30 /tmp/getridof.html，252,165 B）
- 新模板 **`.entry-body: 0`**、`.pos-body: 0`、`.entry-body__el: 0`、`.pos.dpos`（有，
  值 phrase/idiom）、`.hw.dhw` **匹配 0**（新用 `class="headword tw-bw dhw dpos-h_hw"`，
  有 dhw 但**無 hw class**）、`.headword`（h2，內 `<b>get rid of <span class="obj">…`）有。
- **`.def-block ddef_block`: 5**、`.def.ddef_d.db`: 3+（定義）、`.eg.deg`: 有（examples）、
  `.epp-xref dxref B1`: 有（CEFR）。→ 這些**核心 sense 元素全在 document 層可取**，僅
  外層 `.entry-body`/`.pos-body` 容器缺失導致現行路由全斷。
- pos 對應：每 sense 群的 `.di-info > .pos.dpos`（文字 phrase/idiom）與 `.phrase-di-body >
  .def-block`（新模板）或 `.sense-body > .def-block`（新 dsense）為 sibling 鏈。

## 修法（根源分層，檔:行號）
白名單：`src-tauri/cambridge_scraper/src/english.rs`、`tools/verify-f13-url-encode.mjs`、
`src-tauri/Cargo.lock`。實錘現行行號：english.rs:48(selectors)、:64-147(scrape_cambridge_html)。

1. **路由分層改寫 `scrape_cambridge_html`**（english.rs:64-147）：
   - 入口：先 `let has_old = document.select(&SEL.entry_body).next().is_some()`。
   - **word 取用兜底**（L72-76）：先 `.hw.dhw`（舊），none 則 `.headword`（新 h2，flatten
     取 `<b>` 內文）。
   - **舊模板不走原迴圈**（有 entry-body）：保現有 `.entry_body > .pr_section > .pos_body >
     def_block` 邏輯不變（hello 回歸零風險）。
   - **新模板 fallback**（缺 entry-body）：對 `document.select(&SEL.def_block)` 全數迭代，
     每塊：取 `.def.ddef_d.db`（definition）、`.eg.deg`（examples）、`.epp-xref.dxref`
     （cefr）；pos 用「該 def-block 向上最近 `.pos.dpos`」。
2. **新增 selector**：`.headword`（fallback word）、沿用既有 def_block/definition/example/cefr
   selector（L56-59 已覆蓋新模板 class，無需新 class）。
3. **pos 匹配實作**：ElementRef（Deref→NodeRef）有 `.parent()`，向上爬至 `di-info` 內的
   `.pos.dpos`；新模板結構 `.pr.X-block > div > .di-info > .pos.dpos`，def-block 與其
   sibling。用 `.parent()` walk＋`select(.pos.dpos)`。若向上 walk 仍取不到 pos（結構差
   異）→ pos 用該 block 前一 sense 的 pos，最壞算 `""`（不 fail，senses 仍回）。※動工
   前以真碼解析 getridof.html 實錘 parent 鏈，行號以實捶為準。
4. **保留錯誤語意**：新模板缺 def-block 或缺定義 → 維持 `NoDefinitions`/`WordNotFound`
   之語意（WordNotFound 僅在「連 fallback 都找不到 headword+def_block」時）。

## 驗證方式
`tools/verify-f13-url-encode.mjs`：
- 沿用 T0（url:: 6 測試）、T1（真碼向量機 url 函式）、T2（線上前題）、T3（負控制 pin
  258458d）、T4（結構釘）全數保留＝回歸 31/31。
- **新增 T5 區段（english.rs 新模板解析）**：
  - T5A english.rs 現行含 `.headword` fallback selector。
  - T5B scrape_cambridge_html 有 `has_old` 分層（entry_body 存在/缺失二路由）。
  - T5C** 端到端**：對 `/tmp/getridof.html`（或 cached 樣本）跑真`scrape_cambridge_html`
    → 回 Ok，word=="get rid of"（flatten 後取核心）、senses≥3、每 sense 有 definition、
    有 CEFR 或兜底、pos∈{phrase,idiom}。網路/SRI 依賴：樣本檔先 curl 抓落地 repo 外
    /tmp cache；離線則 SKIP 不假綠（不可用空樣本假綠）。
  - T5D 舊模板樣本（english.rs tests 內 hello）仍回 1 sense（回歸）。
  - T5E 負控制：pin 動工前 HEAD 的 english.rs 舊 blob（現行 L64-147 無 headword fallback/
    無 fallback 迴圈），餵 getridof.html → 應 WordNotFound（同牙判別）。
- 回歸：`cargo test -p cambridge_scraper`（既有 17 測＋新增 3 測全綠）、
  `node tools/verify-f13-url-encode.mjs`、`node --check`（verify 檔）。

## 風險
- 新模板日後再變結構（class 再漂移）→ fail 語意會導回 WordNotFound（fail-closed，
  非偽 Ok）。
- pos 匹配若 parent walk 結構不同步 → pos=""，senses 仍回（不會 fail 更嚴重）。
- `.headword` 若舊模板也有（hello 的 `.hw.dhw` 外層包 `span.headword`）→ word 取用
  先 `.hw.dhw`（舊精確），再 fallback，順序不誤傷。

## 範圍外（自動進追蹤）
- 卷曲引號/全形標點/大小寫正規化（查詢品質域，F13 已登）。
- chinese.rs 若同模板漂移 → 登 scope-requests（本顆僅含 english.rs，動工前 grep
  chinese.rs 是否也吃 entry-body，若同病但白名單外→追蹤）。
- CEFR 新模板 class 可能為 `dxref B1`（含），但漏洞級 CEFR 語意若與舊不同→追蹤。

## 可選項定案
- ✅ 路由分層（舊模板零改動，新模板 fallback）— 最大限度保護 hello 回歸。
- ✅ 真碼端到端（用抓落的 getridof.html cache）— 非假綠，證明真解析。
- ❌ 統一改單一 select 路徑（`def_block` 直接當唯一中間層）：hello 舊模板 def_block
  仍在 `.pos-body` 下，單一路徑會打亂舊 pos/cefr 對應，改動面大＋回歸風險高。