// ─── Anki .apkg 匯入後端（plan 2026-09-09_170000 Tasks 3-5）───
// .apkg = zip（collection.anki2 SQLite + media 對照 JSON + 編號媒體檔）。
// 本檔三層：純函式（inspect_apkg_bytes / clean_anki_field）→ tauri commands。
//
// apkg schema（實證自 fixture）：
//   col.models JSON: mid -> {name, flds:[{name},...]}
//   col.decks JSON:  did -> name（fixture 是扁平字串對照）
//   notes: flds 欄以 \x1f 分隔、tags 空格分隔、mid 指向 models
//   cards(nid, did)：有卡才取；deck 名取首卡 did 查 decks JSON
use std::collections::HashMap;
use std::io::Read;

/// 前端欄位對應 UI 用的中間表（契約固定，前端並行開發勿改）。
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct ApkgInspect {
    /// 各 notetype 欄位名聯集（保序：首次出現序）+ `_deck` + `_tags`
    pub headers: Vec<String>,
    /// 有卡 note 的欄位值（HTML 清洗後）；缺欄補空字串
    pub rows: Vec<Vec<String>>,
    /// 該批 rows 實際引用到的 <img> 檔名（去重、保序）
    pub media_files: Vec<String>,
    /// 每格圖片出處（row/col 對齊 rows/headers；僅非空項）。
    /// 前端逐欄開關＋圖片總開關的三層 AND 靠它過濾。
    pub cell_images: Vec<CellImage>,
    /// 無卡 note 數（跳過不靜默丟失）
    pub skipped_no_cards: usize,
    /// 首欄為空的 note 數
    pub skipped_empty: usize,
    /// 選檔的真實檔名（file stem；bytes 版為空字串）。D-NAME1：完成頁
    /// 只剩「牌組（N 列）」分不清連續匯入的兩副牌組，故帶上真名。
    pub file_name: String,
}

/// 某格（row, col）引用的圖片檔名們。
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
pub struct CellImage {
    pub row: usize,
    pub col: usize,
    pub files: Vec<String>,
}

// 500MB 守門：真實牌組多帶音檔（實測 25MB～224MB），50MB 不夠。
// 檔案在 Rust 端讀碟（非 WebView IPC），结果才過 IPC；列數另有 20000 上限。
const MAX_APKG_BYTES: usize = 500 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;
const MAX_MEDIA_BYTES: usize = 5 * 1024 * 1024;

/// 從 col JSON 取 models：mid -> Vec<欄位名>（保序）。
fn parse_models(col_models: &str) -> HashMap<i64, Vec<String>> {
    let mut out = HashMap::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(col_models) {
        if let Some(map) = v.as_object() {
            for (mid, m) in map {
                let id: i64 = mid.parse().unwrap_or(0);
                let mut names = Vec::new();
                if let Some(flds) = m.get("flds").and_then(|f| f.as_array()) {
                    for f in flds {
                        if let Some(n) = f.get("name").and_then(|x| x.as_str()) {
                            names.push(n.to_string());
                        }
                    }
                }
                out.insert(id, names);
            }
        }
    }
    out
}

/// 從 col JSON 取 decks：did -> name。相容兩種形狀：
/// 舊版/fixture 扁平 `{"1": "Default"}`；新版 `{did: {name: ...}}`。
fn parse_decks(col_decks: &str) -> HashMap<i64, String> {
    let mut out = HashMap::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(col_decks) {
        if let Some(map) = v.as_object() {
            for (did, d) in map {
                let id: i64 = did.parse().unwrap_or(0);
                let name = match d {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Object(_) => d.get("name").and_then(|n| n.as_str()).map(String::from),
                    _ => None,
                };
                if let Some(n) = name {
                    out.insert(id, n);
                }
            }
        }
    }
    out
}

/// zip 內檔案讀成 bytes（不存在回 None；讀取失敗回 Some(Err)）。
fn read_zip_entry(z: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str) -> Option<Result<Vec<u8>, String>> {
    let mut f = match z.by_name(name) {
        Ok(f) => f,
        Err(_) => return None,
    };
    let mut buf = Vec::new();
    match f.read_to_end(&mut buf) {
        Ok(_) => Some(Ok(buf)),
        Err(e) => Some(Err(format!("讀取 zip 內 {} 失敗: {}", name, e))),
    }
}

/// 解析 apkg bytes → 中間表。純函式，command 層只負責選檔/讀檔/守門。
pub fn inspect_apkg_bytes(data: &[u8]) -> Result<ApkgInspect, String> {
    if data.len() > MAX_APKG_BYTES {
        return Err(format!("檔案過大（{}MB > 500MB），拒絕匯入", data.len() / (1024 * 1024)));
    }
    if data.is_empty() {
        return Err("不是有效的 .apkg（空檔）".to_string());
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|_| "不是有效的 .apkg（zip 解不開）".to_string())?;

    let anki2 = read_zip_entry(&mut z, "collection.anki2")
        .ok_or_else(|| "不是有效的 .apkg（缺少 collection.anki2）".to_string())?
        .map_err(|e| e)?;
    // media JSON 不存在視為空（無媒體的合法牌組）
    let media_json: HashMap<String, String> = match read_zip_entry(&mut z, "media") {
        Some(Ok(buf)) => serde_json::from_slice(&buf).unwrap_or_default(),
        _ => HashMap::new(),
    };
    // 無卡 note 計數用：有卡 nid 集合
    let _ = media_json;

    // ── 開 SQLite（temp 檔 open；restore_anki2 內處理寫檔/開檔/刪檔）──
    let conn = restore_anki2(&anki2)?;

    // col: models / decks
    let (models_json, decks_json): (String, String) = conn
        .query_row("SELECT models, decks FROM col", [], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| format!("讀取 col 表失敗（非 Anki 庫）: {}", e))?;
    let models = parse_models(&models_json);
    let decks = parse_decks(&decks_json);

    // headers：各 notetype 欄位名聯集（保序）+ _deck + _tags
    // 「保序：首次出現序」以 notes 掃描序決定（與 models JSON 序無關，
    // 因為實際欄位價值按 note 出現順序體現；同一 mid 的欄位順序按 flds 序）。
    let mut headers: Vec<String> = Vec::new();
    let mut headers_index: HashMap<String, usize> = HashMap::new();
    let mut register = |name: &str, headers: &mut Vec<String>, idx: &mut HashMap<String, usize>| {
        let name = name.to_string();
        if let std::collections::hash_map::Entry::Occupied(e) = idx.entry(name.clone()) {
            return *e.get();
        }
        headers.push(name.clone());
        idx.insert(name, headers.len() - 1);
        headers.len() - 1
    };
    // 常數欄先登記（前端依賴 _deck/_tags 恆在尾端屬性欄）
    register("_deck", &mut headers, &mut headers_index);
    register("_tags", &mut headers, &mut headers_index);

    // 有卡 note id 集合 + 各 note 首卡 deck
    let mut card_nids: HashMap<i64, i64> = HashMap::new(); // nid -> 首卡 did
    {
        let mut stmt = conn
            .prepare("SELECT nid, did FROM cards ORDER BY nid, id")
            .map_err(|e| format!("讀取 cards 失敗: {}", e))?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let nid: i64 = r.get(0).map_err(|e| e.to_string())?;
            let did: i64 = r.get(1).map_err(|e| e.to_string())?;
            card_nids.entry(nid).or_insert(did); // 首卡（id 最小）
        }
    }

    // notes 掃描
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut media_files: Vec<String> = Vec::new();
    let mut media_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cell_images: Vec<CellImage> = Vec::new();
    let mut skipped_no_cards = 0usize;
    let mut skipped_empty = 0usize;

    {
        let mut stmt = conn
            .prepare("SELECT id, flds, tags, mid FROM notes ORDER BY id")
            .map_err(|e| format!("讀取 notes 失敗: {}", e))?;
        let mut qr = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = qr.next().map_err(|e| e.to_string())? {
            let nid: i64 = r.get(0).map_err(|e| e.to_string())?;
            let flds: String = r.get(1).map_err(|e| e.to_string())?;
            let tags: String = r.get::<_, Option<String>>(2).map_err(|e| e.to_string())?.unwrap_or_default();
            let mid: i64 = r.get(3).map_err(|e| e.to_string())?;
            let did = match card_nids.get(&nid) {
                Some(d) => *d,
                None => {
                    skipped_no_cards += 1;
                    continue;
                }
            };
            let deck_name = decks.get(&did).cloned().unwrap_or_default();
            let model_flds = models.get(&mid);

            // 動態欄位發現：先登記該 notetype 的欄位名（保序），再填值
            if let Some(names) = model_flds {
                for n in names {
                    register(n, &mut headers, &mut headers_index);
                }
            }
            let width = headers.len();
            let mut row = vec![String::new(); width];

            // flds 切欄：與 model 欄位對齊；錯位多餘捨去（不 crash）
            let parts: Vec<&str> = flds.split('\u{1f}').collect();
            let names = model_flds.cloned().unwrap_or_default();
            let row_idx = rows.len(); // 本列 push 後的索引（cell_images 對齊用）
            for (i, p) in parts.iter().enumerate() {
                let (text, imgs) = clean_anki_field(p);
                if i < names.len() {
                    let col = headers_index
                        .get(&names[i])
                        .copied()
                        .unwrap_or(usize::MAX);
                    if col != usize::MAX && col < width {
                        row[col] = text;
                    }
                    if !imgs.is_empty() && col != usize::MAX {
                        cell_images.push(CellImage { row: row_idx, col, files: imgs.clone() });
                    }
                }
                for img in imgs {
                    if media_seen.insert(img.clone()) {
                        media_files.push(img);
                    }
                }
            }

            // _deck / _tags 恆在（col 0/1 已登記）
            row[0] = deck_name;
            row[1] = tags;

            // 首欄為空 → skipped_empty 計數，但 row 仍保留（前端決定顯示）
            // 「首欄」定義 = 第一個非 _deck/_tags 欄；無 notetype 欄時視為空
            if names.is_empty() || parts.first().map(|s| s.trim().is_empty()).unwrap_or(true) {
                skipped_empty += 1;
            }

            rows.push(row);
        }
    }

    // 每列寬度對齊 headers（掃描後新 notetype 出現會加寬，補空）
    for row in rows.iter_mut() {
        row.resize(headers.len(), String::new());
    }

    if rows.len() > MAX_ROWS {
        return Err(format!(
            "單次匯入上限 {} 列，此牌組有 {} 列，請拆分牌組後分批匯入",
            MAX_ROWS, rows.len()
        ));
    }

    Ok(ApkgInspect {
        headers,
        rows,
        media_files,
        cell_images,
        skipped_no_cards,
        skipped_empty,
        file_name: String::new(),
    })
}

/// collection.anki2 bytes → rusqlite 連線。
/// ponytail：不開 rusqlite 新 feature，直接寫 temp 檔再 open（讀完即刪）。
fn restore_anki2(anki2: &[u8]) -> Result<rusqlite::Connection, String> {
    let tmp = std::env::temp_dir().join(format!(
        "teno-apkg-{}.anki2",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, anki2).map_err(|e| format!("暫存 collection.anki2 失敗: {}", e))?;
    let conn = rusqlite::Connection::open(&tmp).map_err(|e| format!("開啟 collection.anki2 失敗: {}", e))?;
    let _ = std::fs::remove_file(&tmp); // 開啟後即刪（unix fd 語意；win 下刪不掉也無害，下次 temp 清）
    Ok(conn)
}

// ─── Task 4: Anki HTML 清洗（全 repo 唯一實作點）───
// 規則（寫死，不發散）：
//  1. <img ... src="X"> → 記 X（去 query string）後刪 tag
//  2. <br ...> → "\n"
//  3. [sound:xxx.mp3] → 刪掉（app 無音訊欄；不入庫）
//  4. 其餘 <...> 全刪；decode &amp;/&lt;/&gt;/&quot;/&#39;/&nbsp;（對齊前端 decodeHtmlEntities）
//  5. trim
pub fn clean_anki_field(html: &str) -> (String, Vec<String>) {
    let mut imgs: Vec<String> = Vec::new();
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &html[i..];
        // ── tag 掃描 ──
        if rest.starts_with('<') {
            // img 標籤：抽 src 再刪 tag
            if let Some(tag_end) = rest.find('>') {
                let tag = &rest[..tag_end + 1];
                let lower = tag.to_ascii_lowercase();
                if lower.starts_with("<img") {
                    let src = extract_img_src(tag);
                    if let Some(s) = src {
                        imgs.push(s);
                    }
                    i += tag.len();
                    continue;
                }
                if lower.starts_with("<br") {
                    out.push('\n');
                    i += tag.len();
                    continue;
                }
                // 其餘 tag 全刪
                i += tag.len();
                continue;
            }
            // 無 '>' 收尾的孤兒 '<'：原樣保留文字
            out.push('<');
            i += 1;
            continue;
        }
        // ── [sound:...] 刪除 ──
        if rest.starts_with("[sound:") {
            if let Some(end) = rest.find(']') {
                i += end + 1;
                continue;
            }
        }
        // ── entity decode ──
        if rest.starts_with('&') {
            let mut consumed = 0;
            let decoded = decode_entity(rest, &mut consumed);
            if consumed > 0 {
                out.push_str(&decoded);
                i += consumed;
                continue;
            }
        }
        // ── 一般字元（UTF-8 安全取一個 char）──
        let ch_len = utf8_char_len(bytes[i]);
        let end = (i + ch_len).min(html.len());
        // char 邊界保險（rust slicing 恐 panic）：
        let end = match html.get(i..end) {
            Some(_) => end,
            None => {
                out.push_str(&rest);
                break;
            }
        };
        out.push_str(&html[i..end]);
        i = end;
    }
    (out.trim().to_string(), imgs)
}

/// <img src="X"> → X（去 query string）。單/雙引號、無引號都吃。
/// srcset 內的 src 不算：逐個候選位置試，直到符合「src 後緊接空白或 =」邊界者。
fn extract_img_src(tag: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut start = 0;
    while let Some(rel) = lower[start..].find("src") {
        let pos = start + rel;
        // 前邊界：src 前不能是英數/_/-（排除 data-src、xsrc 等）
        if pos > 0 {
            let prev = lower.as_bytes()[pos - 1];
            if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'-' {
                start = pos + 3;
                continue;
            }
        }
        let after = &tag[pos + 3..];
        let t = after.trim_start();
        if let Some(v) = t.strip_prefix('=') {
            let after = v.trim_start();
            let quote = after.chars().next()?;
            let (val, consumed) = if quote == '"' || quote == '\'' {
                let close = after[1..].find(quote)?;
                let v = &after[1..1 + close];
                (v, close + 2)
            } else {
                let end = after.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(after.len());
                (&after[..end], end)
            };
            let _ = consumed;
            return Some(strip_query(val).to_string());
        }
        // 非邊界（如 srcset）→ 從 pos+3 之後繼續找下一個 src
        start = pos + 3;
    }
    None
}

/// 去掉 URL query string（`pic.jpg?v=2` → `pic.jpg`）與 fragment。
fn strip_query(s: &str) -> &str {
    let cut = s.find(['?', '#']).unwrap_or(s.len());
    &s[..cut]
}

fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 { 1 } else if b >> 5 == 0b110 { 2 } else if b >> 4 == 0b1110 { 3 } else { 4 }
}

/// decode &amp;/&lt;/&gt;/&quot;/&#39;/&nbsp;（+ 前端同源的 &#x27;/&#x2F;）。
/// 回 (decoded, consumed_bytes)；不認得回 consumed=0。
fn decode_entity(s: &str, consumed: &mut usize) -> String {
    let candidates: &[(&str, &str)] = &[
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&#x27;", "'"),
        ("&#x2F;", "/"),
    ];
    for (ent, rep) in candidates {
        if let Some(rest) = s.strip_prefix(ent) {
            let _ = rest;
            *consumed = ent.len();
            return rep.to_string();
        }
    }
    String::new()
}

// ─── Task 5: Tauri commands ───
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// temp apkg 存放：app cache dir 下的固定子目錄（新 inspect 覆蓋舊檔）。
fn apkg_temp_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let d = dir.join("apkg-temp");
    std::fs::create_dir_all(&d).map_err(|e| format!("建立暫存目錄失敗: {}", e))?;
    Ok(d)
}

/// 新 inspect 前刪舊 temp 檔（失敗吞掉記 log；殘留下次再清）。
fn cleanup_old_temp(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().extension().map(|x| x == "apkg").unwrap_or(false) {
                if let Err(err) = std::fs::remove_file(e.path()) {
                    log::warn!("remove old apkg temp {:?}: {}", e.path(), err);
                }
            }
        }
    }
}

/// 隨機十六進位檔名（rand 已是 dep）。
fn random_temp_name() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    (0..16).map(|_| format!("{:02x}", rng.random::<u8>())).collect()
}

/// 選檔 + 解析 + 回傳欄位對應表；apkg bytes 存 temp 供 get_apkg_media 取圖。
#[tauri::command]
pub async fn inspect_apkg_dialog(app_handle: tauri::AppHandle) -> Result<ApkgInspect, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle
        .dialog()
        .file()
        .add_filter("Anki Deck", &["apkg"])
        .pick_file(move |file| {
            let _ = tx.send(file);
        });
    let file = rx
        .await
        .map_err(|_| "對話框錯誤".to_string())?
        .ok_or_else(|| "使用者取消".to_string())?;
    // On Android the file picker returns a content:// URI, not a real path.
    // Copy it to cache first so we can read it as a normal file.
    #[cfg(target_os = "android")]
    let src = match file {
        tauri_plugin_dialog::FilePath::Path(p) => p,
        tauri_plugin_dialog::FilePath::Url(u) => {
            let cached = crate::tts_android::copy_uri_to_cache(app_handle.clone(), u.to_string()).await?;
            std::path::PathBuf::from(cached)
        }
    };
    #[cfg(not(target_os = "android"))]
    let src = file.into_path().map_err(|_| "無法取得路徑".to_string())?;
    let data = std::fs::read(&src).map_err(|e| format!("讀取檔案失敗: {}", e))?;
    log::info!("inspect_apkg_dialog src={:?} bytes={}", src, data.len());
    let mut res = inspect_apkg_bytes(&data)?;
    // D-NAME1: 真實檔名（stem；取不到退回空字串，前端再退回列數標籤）
    res.file_name = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();

    // temp 存 bytes 供 get_apkg_media 重開 zip（新 inspect 覆蓋舊檔）
    let dir = apkg_temp_dir(&app_handle)?;
    cleanup_old_temp(&dir);
    let tmp_path = dir.join(format!("{}.apkg", random_temp_name()));
    std::fs::write(&tmp_path, &data).map_err(|e| format!("寫入暫存失敗: {}", e))?;
    log::info!("apkg temp saved: {:?}", tmp_path);

    Ok(res)
}

/// 按檔名取媒體 → data URL（base64）。前端入庫後逐張問。
/// filename 只取 file_name（防 ../ 穿越，對齊 export_backup_data 的 safe_name 寫法）。
#[tauri::command]
pub async fn get_apkg_media(filename: String, app_handle: tauri::AppHandle) -> Result<String, String> {
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .ok_or("非法檔名")?
        .to_string_lossy()
        .to_string();
    if safe_name == "." || safe_name == ".." {
        return Err("非法檔名".to_string());
    }
    let dir = apkg_temp_dir(&app_handle)?;
    // temp 目錄內最新的 .apkg（inspect 剛存的）
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("讀取暫存目錄失敗: {}", e))?;
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "apkg").unwrap_or(false) {
                let mtime = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                    newest = Some((mtime, p));
                }
            }
        }
    }
    let tmp_path = newest
        .map(|(_, p)| p)
        .ok_or("沒有已解析的 .apkg（請先選檔）".to_string())?;
    let data = std::fs::read(&tmp_path).map_err(|e| format!("讀取暫存失敗: {}", e))?;

    // zip + media JSON 反查：filename -> 編號
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&data[..]))
        .map_err(|e| format!("暫存 zip 解不開: {}", e))?;
    let media_json: HashMap<String, String> = match z.by_name("media") {
        Ok(mut f) => {
            let mut s = String::new();
            use std::io::Read as _;
            f.read_to_string(&mut s).map_err(|e| e.to_string())?;
            serde_json::from_str(&s).unwrap_or_default()
        }
        Err(_) => HashMap::new(),
    };
    let num = media_json
        .iter()
        .find(|(_, v)| *v == &safe_name)
        .map(|(k, _)| k.clone())
        .ok_or_else(|| format!("媒體不存在: {}", safe_name))?;

    // 單檔 5MB 守門
    let mut f = z
        .by_name(&num)
        .map_err(|_| format!("媒體不存在: {}", safe_name))?;
    if f.size() > MAX_MEDIA_BYTES as u64 {
        return Err(format!("媒體過大（>5MB）: {}", safe_name));
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| format!("讀取媒體失敗: {}", e))?;
    if buf.len() > MAX_MEDIA_BYTES {
        return Err(format!("媒體過大（>5MB）: {}", safe_name));
    }
    let b64 = base64_encode(&buf);
    let mime = mime_from_ext(std::path::Path::new(&safe_name).extension().and_then(|e| e.to_str()));
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 無 base64 crate 依賴 → 自寫 RFC4648 standard encode（+ padding）。
fn base64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TBL[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TBL[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn mime_from_ext(ext: Option<&str>) -> String {
    let lower = ext.unwrap_or("").to_ascii_lowercase();
    match lower.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ─── 測試（fixture: tests/fixtures/apkg_fixture.apkg — 真實最小 apkg）───
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn fixture() -> Vec<u8> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/apkg_fixture.apkg");
        std::fs::read(&p).unwrap_or_else(|e| panic!("fixture 讀不到 {:?}: {}", p, e))
    }

    // ── Task 3: inspect_apkg_bytes ──
    #[test]
    fn inspect_parses_fixture() {
        let r = inspect_apkg_bytes(&fixture()).unwrap();
        // headers：欄位名聯集（保序）+ _deck + _tags
        assert_eq!(r.headers.len(), 2 + 7, "2 常數欄 + Full notetype 7 欄 + Basic 0 新欄（Basic 的 Front/Back 已含於 Full）: {:?}", r.headers);
        // 保序：_deck/_tags 先登記，其後按 note 出現序
        assert_eq!(&r.headers[..2], &["_deck", "_tags"]);
        assert!(r.headers.contains(&"Front".to_string()));
        assert!(r.headers.contains(&"vacabulary".to_string()));
        assert!(r.headers.contains(&"詞性".to_string()));
        assert!(r.headers.contains(&"sound".to_string()));
        // rows = 有卡 note 數（3 notes，1 無卡 → 2 rows）
        assert_eq!(r.rows.len(), 2);
        assert_eq!(r.skipped_no_cards, 1);
        // 首卡 deck：note1 → 999「測試牌組」、note2 → 1「Default」
        let row1 = &r.rows[0];
        let deck_col = r.headers.iter().position(|h| h == "_deck").unwrap();
        let tags_col = r.headers.iter().position(|h| h == "_tags").unwrap();
        assert_eq!(row1[deck_col], "測試牌組");
        assert_eq!(row1[tags_col], "tagA tagB");
        assert_eq!(r.rows[1][deck_col], "Default");
        // 欄位對齊：note2 的 Front=apple（清洗後）
        assert!(r.rows[1].iter().any(|c| c == "apple"), "note2 Front 應為 apple");
        // 錯位捨去不 crash：note1 flds 有 2 欄（Basic），欄數吻合
        assert_eq!(r.rows[0].iter().filter(|c| !c.is_empty()).count() >= 2, true);
    }

    #[test]
    fn inspect_media_files_dedup() {
        let r = inspect_apkg_bytes(&fixture()).unwrap();
        // note1 引用 pic.jpg（img src 去query）、note2 引用 好.png；a.mp3 是 sound 不算圖
        assert!(r.media_files.contains(&"pic.jpg".to_string()), "media_files: {:?}", r.media_files);
        assert!(r.media_files.contains(&"好.png".to_string()), "media_files: {:?}", r.media_files);
        assert!(r.media_files.iter().all(|m| m != "a.mp3"), "sound 不應入 media_files");
        // 去重：pic.jpg 在多 note 重複引用時只出現一次（fixture 單次，驗去重集合）
        let mut seen = std::collections::HashSet::new();
        for m in &r.media_files {
            assert!(seen.insert(m.clone()), "重複 media: {}", m);
        }
    }

    #[test]
    fn inspect_cell_images_align_rows_cols() {
        let r = inspect_apkg_bytes(&fixture()).unwrap();
        assert!(!r.cell_images.is_empty());
        // 每項 row/col 都在 rows/headers 範圍內；files 非空
        for c in &r.cell_images {
            assert!(c.row < r.rows.len(), "row {} 越界", c.row);
            assert!(c.col < r.headers.len(), "col {} 越界", c.col);
            assert!(!c.files.is_empty());
        }
        // 去重一致：cell_images 展開 == media_files 集合
        let mut flat: Vec<String> = r.cell_images.iter().flat_map(|c| c.files.clone()).collect();
        flat.sort();
        flat.dedup();
        let mut mf = r.media_files.clone();
        mf.sort();
        assert_eq!(flat, mf);
    }

    #[test]
    fn inspect_rejects_invalid() {
        // 非 zip
        assert!(inspect_apkg_bytes(b"not a zip at all").is_err());
        // 空 bytes
        assert!(inspect_apkg_bytes(b"").is_err());
        // zip 但無 collection.anki2
        let mut no_anki = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts: zip::write::SimpleFileOptions = Default::default();
        no_anki.start_file("hello.txt", opts).unwrap();
        no_anki.write_all(b"hi").unwrap();
        let bad = no_anki.finish().unwrap().into_inner();
        assert!(inspect_apkg_bytes(&bad).is_err());
    }

    #[test]
    fn clean_basic_substitutions() {
        assert_eq!(clean_anki_field("hello<br>world").0, "hello\nworld");
        assert_eq!(clean_anki_field("hello<br/>world").0, "hello\nworld");
        assert_eq!(clean_anki_field("hello<br />world").0, "hello\nworld");
        assert_eq!(clean_anki_field("  x  ").0, "x"); // trim
        assert_eq!(clean_anki_field("").0, "");
    }

    #[test]
    fn clean_img_extraction() {
        let (t, imgs) = clean_anki_field(r#"a<img src="pic.jpg?v=2">b"#);
        assert_eq!(t, "ab");
        assert_eq!(imgs, vec!["pic.jpg"]);
        // 單引號 + 無引號
        let (_, i1) = clean_anki_field("<img src='x.png'>");
        assert_eq!(i1, vec!["x.png"]);
        let (_, i2) = clean_anki_field("<img src=y.gif>");
        assert_eq!(i2, vec!["y.gif"]);
        // srcset 陷阱：不應誤抓
        let (_, i3) = clean_anki_field(r#"<img srcset="a.png 2x" src="real.jpg">"#);
        assert_eq!(i3, vec!["real.jpg"]);
        // 大小寫
        let (_, i4) = clean_anki_field(r#"<IMG SRC="up.png">"#);
        assert_eq!(i4, vec!["up.png"]);
    }

    #[test]
    fn clean_sound_and_entities() {
        assert_eq!(clean_anki_field("x[sound:a.mp3]y").0, "xy");
        assert_eq!(clean_anki_field("a[sound:file name.mp3]b").0, "ab");
        // entity decode（對齊前端 decodeHtmlEntities）
        assert_eq!(clean_anki_field("A &amp; B").0, "A & B");
        assert_eq!(clean_anki_field("a&lt;b&gt;c&quot;d&#39;e").0, "a<b>c\"d'e");
        assert_eq!(clean_anki_field("x&nbsp;y").0, "x y");
        assert_eq!(clean_anki_field("&#x27;q&#x2F;s").0, "'q/s");
        // 音檔不算圖；[sound:..] 不應吃掉之後的 entity
        let (t, imgs) = clean_anki_field("[sound:a.mp3]&amp;");
        assert_eq!(t, "&");
        assert!(imgs.is_empty());
        // 孤兒 '<' 保留為文字
        assert_eq!(clean_anki_field("3 < 5").0, "3 < 5");
        // 其他 tag 全刪
        assert_eq!(clean_anki_field("<div>keep</div><b>bold</b>").0, "keepbold");
        // 標籤內含 '>' 值的引號屬性（不會誤判 tag_end）
        assert_eq!(clean_anki_field(r#"<span title="a>b">t</span>"#).0, "b\">t");
    }

    #[test]
    fn clean_fixture_end_to_end() {
        // fixture note1 flds: '<b>hello</b><br>world&lt;2&#39;s'
        let (t, imgs) = clean_anki_field("<b>hello</b><br>world&lt;2&#39;s");
        assert_eq!(t, "hello\nworld<2's");
        assert!(imgs.is_empty());
        // fixture note1 Back: '<img src="pic.jpg?v=2">&nbsp;X [sound:a.mp3]'
        let (t2, imgs2) = clean_anki_field(r#"<img src="pic.jpg?v=2">&nbsp;X [sound:a.mp3]"#);
        assert_eq!(t2, "X");
        assert_eq!(imgs2, vec!["pic.jpg"]);
    }

    #[test]
    fn base64_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"Hello, Anki!"), "SGVsbG8sIEFua2kh");
    }
}
