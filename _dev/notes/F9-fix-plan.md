# F9 修復計畫書 v1 — install_piper_model 目錄網址解析（lib.rs）

狀態：v1 送審凍結中（憲法⑤）。PM3 佇列第二顆（D5 已登 D5-SR1 跳過）。
基線：main HEAD（動工前實錘行號錨點見 §2）。

## 1. Bug 定義

使用者在 設定→TTS「貼上 HuggingFace 網址自動安裝」貼語音網址，
`install_piper_model`（lib.rs:456-515）解析出錯誤下載網址 → 下載失敗或**寫入假模型**。

### 審計主張勘誤（誠實歸責，憲法附帶義務）
audit（2026-08-13）稱「目錄網址 model_name off-by-one → **永遠** 404」——**不實**。
JS 逐字複製解析邏輯 + curl 實測（2026-08-28）：
- UI 自家 hint 例（settings.js:216 `.../tree/main/en/en_US/ryan/high`）→ 生成
  `resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx` → **302 存活**（HEAD 實測，非 404）。
- 真實死法有三（下 §2），皆「必 404」但非「永遠 404」。
- `git log -S "locale-voice-quality"` 僅 initial commit——區塊自初始未改，非他人修一半。

## 2. Root cause（三病灶＋一中毒連鎖）

實錘行號（HEAD，2026-08-28）：
- **RC1 尾斜杠**（:461-465）：`.../ryan/high/` → split('/') 末段空字串 →
  rel_path 尾附 `/` → 生成 `high//en_US-ryan-high.onnx` → **實測 404**。
- **RC2 深度不足靜默瞎猜**（:506-510）：voice 層目錄 `.../tree/main/en/en_US/ryan`
  → `dir_parts.get(3)`=None → `unwrap_or("high")` 硬湊 → 生成
  `.../en/en_US/ryan/en_US-ryan-high.onnx`（缺品質目錄段）→ **實測 404**，
  錯誤訊息僅「請確認網址正確」不教使用者怎麼貼才對。locale 層更甚：
  get(2)=None→"default" → 名稱瞎拼 `en_US-default-high`。
- **RC3 `https://hf.co/` 短網域**（:461-464 trim 鏈只認 `hf.co/` 開頭）：
  `https://hf.co/rhasspy/...` 三條 trim 全不中 → `segments[0]="https:"` 垃圾座標 →
  rel_path 從錯誤偏移拼起 → 404。
- **中毒連鎖（登記另檔 F12，本單不治，憲法⑥）**：curl 無 `-f`，HTTP 404 時
  **exit code 仍 0** → `onnx_status.success()==true` → HF 錯誤頁 HTML 存成 `.onnx`
  → 「語音模型安裝完成」假成功＋模型目錄髒檔。修法在 F12（ureq 對 4xx/5xx
  自然 Err）根治；F9 只做 URL 面，避免與 F12 改動重疊（佇列順序 F9→F10→F12）。
- 另 `.onnx` 檔名分支（:470-474）與 dir 分支共用 `segments[4..]` 假設
  `[owner,repo,ref_type,ref,...]`——此假設對 tree/blob/resolve 三種 ref_type 皆成立，
  非病灶（區辨審計 off-by-one 指控：index 4 起點實測正確）。

## 3. 修法（唯一檔：src-tauri/src/lib.rs）

### 3.1 新增純函式（install_piper_model 上方，零依賴 std-only 便於 cargo test）
```rust
/// F9: Parse a HuggingFace piper-voices URL into (repo-relative dir, model name).
/// Returns Ok((rel_dir, model_name)); rel_dir 供 resolve 基底, model_name 不含 .onnx。
fn parse_piper_url(url: &str) -> Result<(String, String), String> {
    let rest = url.trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .trim_start_matches("huggingface.co/")
        .trim_start_matches("hf.co/");
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    // segments = [owner, repo, ref_type(tree|blob|resolve), ref, dirs..., file?]
    if segments.len() < 6 { return Err("網址格式不正確，預期 huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high".to_string()); }
    let last = segments[segments.len() - 1];
    let dirs = &segments[4..];
    if last.ends_with(".onnx") {
        let name = last.strip_suffix(".onnx").unwrap_or(last);
        let rel = dirs[..dirs.len() - 1].join("/");
        if rel.is_empty() { return Err(同上格式錯誤) }
        Ok((rel, name.to_string()))
    } else {
        if dirs.len() < 4 { return Err("請貼到品質目錄層級（high/medium/low），例如 .../tree/main/en/en_US/ryan/high".to_string()); }
        let n = dirs.len();
        // piper-voices 命名 = {locale}-{voice}-{quality} = 末三段（尾導向，容忍未來多一層巢狀）
        Ok((dirs.join("/"), format!("{}-{}-{}", dirs[n-3], dirs[n-2], dirs[n-1])))
    }
}
```
要點：
- `filter(|s| !s.is_empty())` 一次根除尾斜杠/雙斜杠髒段（RC1）。
- 網域 trim 鏈先拆 scheme 再拆 host → `https://hf.co/` `www.huggingface.co` 全收（RC3）。
- 目錄分支改**尾導向**末三段取名＋深度守門 ≥4（RC2：不足即明確錯誤訊息教格式，
  不瞎拼）。舊固定 index get(1..3) 對正規 4 層結果逐字相同（回調零變化）。
- 最低段數 `segments.len()<5` → `<6`：旧 <5 對目錄 3 段（len=7? 勘：舊 len=owner..main+3=7）
  放行後瞎拼——新门槛統一由 dirs.len()≥4 / .onnx 分支 rel 非空雙閘把關。
  （`.onnx` 分支保留舊 len 彈性：owner,repo,type,ref,file 5 段=倉庫根直接放檔的極端 repo
   不存在於 piper-voices，但仍以 rel 非空閘統一。）
- 網域不驗證（貼 github 網址照樣拼 HF 路徑→404）：語意同舊，F12 狀態碼檢查後
  錯誤訊息會顯示實際 404 URL 可自診。不做＋理由（憲法⑦）：白名單網域清單属過度設計。

### 3.2 install_piper_model 內 :461-512 解析段整段替換
```rust
let (rel_path, model_name) = parse_piper_url(&url)?;
let downloaded = download(&model_name, &rel_path)?;
```
- `download` 閉包簽名加 rel 參數（原捕獲 rel_path 語意不變）；curl 呼叫**不動**（F12 域）。
- 外層 `last` 變數消滅（僅解析段使用，窮舉：:469 定義、:470/:501 讀取，皆在替換區）。

### 3.3 單元測試（#[cfg(test)]，鏡 drive_sync.rs:396 先例）
`parse_piper_url` 測資表 12 條（見 §4 T1 清單）。

## 4. 驗證
1. `cargo test --lib`（src-tauri 下，暖快取）全綠。
2. `tools/verify-f9-piper-url.mjs`：
   - T1 真碼提取：由 lib.rs 現檔抽 parse_piper_url 全函式體＋12 向量組裝獨立
     bin，rustc 編譯執行（純 std，秒級）——避整crate編譯同時釘「源碼即實裝」。
   - 向量：A UI例4層→302腿 / B 尾斜杠→與A同解 / C 3層目錄→明確Err / D resolve .onnx
     / E blob .onnx / F hf.co裸 / G https://hf.co / H zh 4層 / I 倉庫根4段→Err
     / J 大小寫 .onnx 混雜名 / K 雙斜杠中段 / L 空字串→Err。
   - T2 實網腿：A/D/E/F/G/H 生成 URL range GET → 302/200（B 與 A 同解共用腿）。
   - T3 負控制：git show HEAD:lib.rs 機械抽出舊解析段（逐字，僅 download 呼叫切為
     回傳元組）編譯同向量 → B 生成雙斜杠/C 瞎拼 `en_US-ryan-high` 缺段路徑/
     G(`https://hf.co`) `https:` 垃圾段 精準重現；B 舊 URL 實網 404 目視腿。
   - T4 結構釘：install_piper_model 區段含 `parse_piper_url(&url)?` 呼叫＋
     舊瞎拼字面量（`unwrap_or("high")`/`unwrap_or("default")`/`unwrap_or("en_US")`）零殘留。
3. 回歸：`cargo check`＋`npm run build`（前端零改，純防呆）＋既有 verify 抽 3。

## 5. 風險
- 低。純函式單檔單函式＋一處呼叫替換；download（curl）零改動。
- 語意變化誠實登記：3 層目錄網址由「試 high 下載→404」改為「明確錯誤教學」
  （拒錯優於瞎猜）；`.onnx` 檔名分支行為零變化。
- 目錄名恰以 `.onnx` 結尾的 pathological 目錄不存在於 piper-voices（窮舉 HF API tree
  en/en_US/ryan + zh 抽樣實測 2026-08-28：目錄全為 high/low/medium 詞彙）。

## 6. 範圍外（登案另單）
- curl 404 HTML 存假模型（`-f` 缺失）→ **F12 根治**（ureq 狀態語意）。
- 下載無 sha256 校驗／無斷點續傳 → 呈總統（非佇列）。
- HF 網域白名單驗證 → 不做，§3.1 理由。
- models 目錄同名覆寫無提示（同 voice 重複安裝靜默蓋檔，既有語意）→ 登記。
- TTS 播放端對假 .onnx 的健護 → F12 後此源頭枯竭，不另治。
- **R1 登記（併 F12 順治）**：`?download=true` 查詢尾巴（HF「下載檔案」按鈕複製即得，高頻貼法）
  → 本碼辨認失效 404（R1#1 實測，新舊同死非回歸）→ F12 重寫下載段時一行去 query/fragment。
- **R1 登記（併 F12 順治）**：大寫網域 `HTTPS://HF.CO` trim 大小寫敏感不中 → 段位移 404
  （R1#1/#3 實測，舊碼同死）→ F12 時 host 段 `to_ascii_lowercase`。
- 404 錯誤頁實為純文字 `Entry not found`（R1#3 實測，非 HTML——§2 措辭勘正，中毒實質不變：
  exit 0＋垃圾存檔＋假成功）。
- quality 詞彙集實測為 {high,low,medium,x_low}（R1#2 voices.json 175/175 全倉驗證）——
  深度守門查層級不查詞彙零誤殺；錯誤示範文案未列 x_low 屬純文案 nit，登記不改。
- 驗證面非阻塞：T1 目錄向量皆 4 層，「尾導向 vs 固定 index」M4 變異無區別向量（R1#2 逮，
  實倉無 5 層目錄零行為影響）→ 補 cargo unit test 五層尾導向釘（v1.1 產品碼側）。

## 7. 審查紀錄
**R1（3 委員，2026-08-28）**：#1 ✅（附登記：?download=true／大寫網域／大寫 .ONNX 死法
皆垃圾進→404 家族非回歸、負控制 ORIG_BLOCK 638B/ORIG_TAIL 586B 逐字節獨立核對屬實、
路徑穿越面審查——model_name 由 `--` 分隔 curl 參數注入封閉、`<6` 門檻＋末三段下溢證明安全）；
#2 ✅（消費者窮舉：唯一鏈 settings.js:754→api.js:66，bot/cron/CLI 零；兩碼等價性自寫
10 向量 EQUIVDIFF 0；變異 M1/M2/M3/M5 全斃、M4 尾導向盲區登記如上；HF API 全域結構
175/175 支援深度守門零誤殺）；#3 ✅（四 hunk 逐一目視零夾帶、curl 閉包 HEAD 逐字節同、
中毒連鎖實跑 exit=0＋「Entry not found」體存檔屬實、T1 真碼提取無硬編碼確認、
advisory：計畫 §3.1 註文字與 `<6` 硬閘矛盾／§3.2 「閉包加 rel 參數」實際保留捕獲——
**§3 文字勘正如下**：閉包維持捕獲 rel_path（等價更簡）、rel 非空閘經 `<6` 門檻證明不可達
故未裝（死碼省略），向量 J 由 C2（locale 瞎拼面，價值更高）實替）。
**裁決：三席全 ✅ 一輪過審**；登記項併 F12/文案面，產品碼零改動放行 commit
（v1.1 僅計畫書文字升版＋cargo 側補五層釘 unit test，不動已審函数體）。
