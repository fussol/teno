# F13 修復計畫書 v1.0（2026-08-28, PM3）

## 0. 白名單映射登記
任務書寫 `src-tauri/src/cambridge/url.rs:2-10`，該路徑**不存在**；實際檔為
`src-tauri/cambridge_scraper/src/url.rs`（`build_english_url`:2、
`build_chinese_url`:9 與任務書行號 2-10 完全吻合，repo 內無其他 cambridge
url 檔，函式語意吻合）。判定＝同一檔_intent_誤寫，照白名單意圖執行，已在
`scope-requests.md` 追加映射備註留痕。改動仅此檔＋既有 test mod。

## 1. Bug 定義（實測徵狀）
使用者查片語（多詞彙）或含 URL 保留字元的詞，Cambridge 查詢失敗：
- `get rid` 原始碼直插 → URL 含 raw space，curl 直接 000 拒發；ureq 內 url
  crate 會自動把 space 壓成 `%20`，但 Cambridge 對 `%20` slug **不給條目頁**，
  302 到 `?q=get%2Brid%2Bof` 搜尋 fallback 頁（實測 url_effective 帶 `?q=`），
  下游 `scrape_cambridge_html` 在 fallback 頁解析失敗 → 使用者看「解析失敗」。
- `#`（如 `B#`、`c#`）：raw `#` 變 URL fragment → 路徑被截斷，靜默查錯詞。
- `?` 變 query 分隔符、`%` 造成非法百分序列。
- 中文 CJK 現行可用（ureq 自動 pct-encode），非本 bug 徵狀。

## 2. Root cause（源碼實錘，HEAD 258458d）
`cambridge_scraper/src/url.rs:2-13`：兩支 build 函式用 `format!("...{word}")`
對使用者輸入**零編碼零正規化**直插 path 段。

## 3. 修法（唯一改動檔：cambridge_scraper/src/url.rs）
新增私有助手 `encode_slug(word)`，兩支 build 函式改用它：
1. `trim()`；連續空白（空格/tab/換行）折單個 `-`、首尾 `-` 剔除
   （Cambridge 片語 canonical slug 格式，**實測前提**：`get-rid-of` →
   條目頁 url_effective 無 `?q=`；`get%20rid%20of` → 帶 `?q=` fallback）。
2. 逐字元白名單 passthrough：`[A-Za-z0-9\-._~]`；其餘（含 `#?%+&/`、CJK、
   emoji）→ UTF-8 位元組 `%XX`（大寫 hex）。手寫編碼器 **零新依賴**
   （不碰任何 Cargo.toml；url crate 雖已在 deps，手寫 15 行免 set 選擇
   疑義＋`%` 不在 url crate PATH 集內需另處理，反而更複雜）。
3. 不 lower-case：大小寫正規化列另案（R1#F-6 勘誤：原論據「Cambridge 端
   自行處理」半錯——live `Hello` 落 `hello?q=Hello` 非直達條目頁；但條目
   slug 全小寫、lowercase 屬一行零風險改動，尊重凍結範圍列可選項不做）。
4. 既有 test mod 保留＋新增：片語→hyphen、多空白摺疊、`#`→%23、`%`→%25、
   `?`→%3F、CJK→pct、首尾空白/連字號。

呼叫端（lib.rs lookup_cambridge）不動：消費端窮舉＝僅 lib.rs:368/370＋
crate re-export（§實查 grep 清單），回傳型別不變 String，零消費者影響。

## 4. 驗證方式（tools/verify-f13-url-encode.mjs）
- T0 cargo 計數釘：`cargo test -p cambridge_scraper url::` 通過數釘死。
- T1 真碼提取向量機：regex 抽 `encode_slug`＋build 兩函式原樣塞進 mini
  crate（零依賴，純 std）rustc 編譯執行，攻擊向量輸出精確斷言：
  `get rid of`→`get-rid-of`；`  A  B `→`A-B`；`c#`→`c%23`；`100%`→`100%25`；
  `a?b`→`a%3Fb`；`中文`→`%E4%B8%AD%E6%96%87`；`hello` 回歸；`-x-`→`x`。
- T2 線上前題釘（網路容錯）：實測 `get-rid-of` 條目頁 vs `%20` fallback，
  網路掛→SKIP 明示（絕不假綠）。
- T3 負控制：pin HEAD 靜態 hash 258458d 舊碼提取體＝raw 直插，斷言
  `get rid` 輸出含 raw space（徵狀1）、`c#` 輸出含 raw `#`（徵狀2）＋新舊
  提取體不同（判別性釘，F9 教訓：靜態 hash 非浮動）。
- T4 結構釘：build 兩函式經 encode_slug（非 raw 直插）、零 Cargo.toml 改動、
  host `cargo check -p cambridge_scraper` 綠。

## 5. 風險
- hyphen 前提失效風險：Cambridge 改版 → T2 URL 形狀釘會紅；**R1#F-4 勘誤**：
  原稱「模板改版 T2 會紅」不實——T2 v1.0 只釘 URL 形狀，模板漂移不會紅；
  v1.1 補 T2-3 端到端條目頁釘＋漂移 WARN。**已實錘第二根因**：新
  tw-/superentry 模板條目頁零 `.entry-body` → scraper WordNotFound（F13-SR2
  另案）＝F13 修 URL 層 ≠ 片語端到端全閉，閉環報告禁把該徵狀記 F13 帳上。
  現行名詞單字路徑零變化（passthrough 集涵蓋既有全部合法詞形，R1 回歸
  live 雙測 `o'clock` 新舊 url_effective 位元組級相同）。
- 已含 hyphen 輸入 `get-rid-of`：原樣通過（既有行為不變）。
- 詞含 `’`（U+2019 卷曲撇號）：編碼後大概率仍 fallback——Cambridge 條目
  本體用直撇號，超出編碼 bug 範圍（§6）。R1 補：直撇號 `o'clock` 新舊同掛
  （皆落 ?q= fallback），屬 scraper/查詢品質域非 F13 回歸。
- 預編碼輸入 `%20`→`%2520`：R1 背書為正確防注入語意（path 段編碼器視輸入
  為 literal token，解預編碼＝二次解釋漏洞）。

## 6. 範圍外
- 卷曲引號/全形標點 → ASCII 正規化（屬查詢品質非編碼正確性，另案）。
- 大小寫正則化、近義 fallback 偵測（scrape 端回報「找不到條目」優於
  「解析失敗」的 UX 問題——屬 scraper 解析域，PM4 軌）。
- tatoeba.rs 的 urlencode（已用 url crate parse_with_params，本無此 bug）。

## 7. 審查紀錄
### R1（2026-08-28，簡單 bug 降 1 席，✅ 有條件放行）
- 獨立重跑：驗證腳本 30/30 EXIT=0、cargo 17/17、負控制 pin 真性（git show
  258458d raw 直插屬實）、T3c/T3d 徵狀精準、T3e 判別性封死兩邊空轉。
- 自建攻擊向量全過：`../english/attack`→全編碼路徑穿越殲滅；`%20`→`%2520`
  正確防注入（背書）；CRLF→頭注入殲滅；emoji/NUL/30k 字不炸；全形空格
  U+3000 不摺 hyphen→§6 另案一致。
- **[F-4]（重大・採納＝放行條件）**：端到端第二根因實錘——新模板條目頁
  （get-rid-of/take-a-shower，真條目頁 def-block×5）零 `.entry-body` →
  scrape_cambridge_html WordNotFound（3× 交錯重取穩定）；hello 舊模板綠。
  → F13-SR2 登 scope-requests（scraper 域待派）＋T2-3 端到端釘＋WARN＋
  §5 勘誤。F13 仍嚴格改善（raw space/#/?/% 殲滅＋單字零變化）不判阻斷。
- [F-6]（採納）：§3.3 lowercase 論據勘誤（live `Hello` 落 ?q=）。
- [F-5]（登記）：工作區 tools/cli.mjs 髒檔屬 C4-SR1 他軌在製品，commit
  嚴禁捲入（只 stage url.rs＋verify 腳本＋_dev/notes/）。
- nit×3 不採納（全點 guard/長度 cap——256B cap 屬可選防 414，服務端自有
  兜底，不動凍結範圍）。
- v1.0→v1.1 變更：§3.3 論據修正・§5 F-4 勘誤＋SR2 連結・§7 本紀錄。
  代碼零變動（條件均落文件＋驗證腳本，R1 明載非阻斷）。
- 首相誠實登記：本 session `cargo fmt -p` 曾越界.format 同 crate 4 支無關
  源檔→即 `git checkout` 回退，T4d 髒檔釘確保零殘留。
