use tauri_plugin_sql::{Migration, MigrationKind};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

mod tts_android;
mod icon_android;
mod drive_sync;

struct PiperAudio {
    handle: rodio::OutputStreamHandle,
}

static TTS_PLAYING: AtomicBool = AtomicBool::new(false);

fn piper_models_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let mut dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    dir.push("piper-models");
    Ok(dir)
}

fn piper_resource_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let r = app_handle.path().resource_dir().map(|p| p.join("resources").join("piper"));
    if let Ok(ref dir) = r {
        if dir.join("piper").exists() { return Ok(dir.clone()); }
    }
    // ponytail: check next to the binary (non-bundled install)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let next_to = parent.join("resources").join("piper");
            if next_to.join("piper").exists() { return Ok(next_to); }
        }
    }
    let system = std::path::PathBuf::from("/usr/lib/teno/resources/piper");
    if system.join("piper").exists() { return Ok(system); }
    r.map_err(|e| e.to_string())
}

fn piper_voice_path(name: &str, data_dir: &std::path::Path) -> std::path::PathBuf {
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
    let filename = if safe.ends_with(".onnx") { safe } else { format!("{}.onnx", safe) };
    data_dir.join(&filename)
}

#[tauri::command]
fn walk_piper_dir(dir: &std::path::Path, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_piper_dir(&path, out);
            } else if path.extension().map(|ext| ext == "onnx").unwrap_or(false) {
                if let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) {
                    out.push(stem);
                }
            }
        }
    }
}

fn collect_piper_voices(data_dir: &std::path::Path) -> Vec<String> {
    let mut voices: Vec<String> = Vec::new();
    if data_dir.is_dir() { walk_piper_dir(data_dir, &mut voices); }
    voices.sort();
    voices.dedup();
    voices
}

#[tauri::command]
fn list_piper_voices(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = piper_models_dir(&app_handle)?;
    Ok(collect_piper_voices(&data_dir))
}

/// Resolve the CLI script path. Priority:
/// 1. TENO_CLI env (dev override)
/// 2. bundled resource: <resource_dir>/resources/cli/cli.mjs
/// 3. packaged path: /usr/lib/teno/resources/cli/cli.mjs
/// 4. dev repo fallback: $HOME/teno/tools/cli.mjs
fn resolve_cli_path(app_handle: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("TENO_CLI") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    if let Ok(r) = app_handle.path().resource_dir() {
        let cand = r.join("resources").join("cli").join("cli.mjs");
        if cand.exists() { return Some(cand); }
    }
    let system = std::path::PathBuf::from("/usr/lib/teno/resources/cli/cli.mjs");
    if system.exists() { return Some(system); }
    let home = std::env::var("HOME").unwrap_or_default();
    let dev = std::path::PathBuf::from(home).join("teno").join("tools").join("cli.mjs");
    if dev.exists() { return Some(dev); }
    None
}

/// App paths the frontend needs (config dir, sim-logs dir) — no hardcoded HOME paths.
#[tauri::command]
fn get_app_paths(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "configDir": app_dir.to_string_lossy(),
        "simLogsDir": app_dir.join("sim-logs").to_string_lossy(),
        "homeDir": std::env::var("HOME").unwrap_or_default(),
    }))
}

#[tauri::command]
async fn run_cli(app_handle: tauri::AppHandle, args: Vec<String>) -> Result<String, String> {
    log::info!("run_cli args={:?}", args);
    let cli_path = resolve_cli_path(&app_handle).ok_or_else(|| {
        "CLI 工具不存在（開發者模式需 tools/cli.mjs，或設 TENO_CLI 環境變數）".to_string()
    })?;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let db_path = std::env::var("TENO_DB").unwrap_or_else(|_| format!("{}/.config/com.teno.app/teno.db", home));
    // simulate 時 log 存到 app 快取 sim-logs/
    let log_dir = std::env::var("TENO_SIM_LOGS").unwrap_or_else(|_| format!("{}/.config/com.teno.app/sim-logs", home));
    let mut final_args = args.clone();
    // B4: 同時接受 --log-dir 與 --log-dir=path 形式
    let has_log_dir = final_args.iter().any(|a| a == "--log-dir" || a.starts_with("--log-dir="));
    if final_args.iter().any(|a| a == "simulate") && !has_log_dir {
        final_args.push("--log-dir".to_string());
        final_args.push(log_dir);
    }
    // B3: 放到 blocking thread, 避免模擬數分鐘時凍結 UI
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg(&cli_path)
            .args(&final_args)
            .env("TENO_DB", &db_path)
            .env("TENO_NO_BACKUP", "1")
            .output()
    }).await
        .map_err(|e| { log::error!("run_cli join 失敗: {}", e); format!("run_cli 執行失敗: {}", e) })?
        .map_err(|e| { log::error!("run_cli spawn 失敗: {}", e); format!("run_cli 執行失敗: {}", e) })?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        log::error!("run_cli 非零退出: {}", err);
        return Err(format!("run_cli 錯誤: {}", err));
    }
    let out = String::from_utf8_lossy(&output.stdout).to_string();
    log::info!("run_cli 完成, 輸出 {} 字元", out.len());
    Ok(out)
}

fn speak_piper(text: &str, voice: &str, length_scale: f64, noise_scale: f64, app_handle: &tauri::AppHandle) -> Result<(), String> {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let tmp_wav = std::env::temp_dir().join(format!("teno_piper_out_{}.wav", ts));

    let data_dir = piper_models_dir(app_handle)?;
    let mut model = piper_voice_path(voice, &data_dir);
    if !model.exists() {
        log::warn!("語音模型不存在 {:?}, 改用預設", model);
        model = piper_voice_path("en_US-ryan-high", &data_dir);
        if !model.exists() {
            return Err("無任何可用 Piper 語音模型，請匯入 .onnx 模型".to_string());
        }
    }

    let piper_dir = piper_resource_dir(app_handle)?;
    let piper_bin = piper_dir.join("piper");
    if !piper_bin.exists() {
        return Err("Piper 執行檔不存在".to_string());
    }

    let espeak_data = if piper_dir.join("espeak-ng-data").is_dir() {
        piper_dir.join("espeak-ng-data")
    } else if std::path::Path::new("/usr/share/espeak-ng-data").is_dir() {
        std::path::PathBuf::from("/usr/share/espeak-ng-data")
    } else {
        return Err("找不到 espeak-ng 語音資料，請執行: sudo pacman -S espeak-ng".to_string());
    };

    let ld_path = format!("{}:{}",
        piper_dir.to_string_lossy(),
        std::env::var("LD_LIBRARY_PATH").unwrap_or_default());

    let mut child = std::process::Command::new(&piper_bin)
        .args([
            "--model", &model.to_string_lossy(),
            "--length_scale", &length_scale.to_string(),
            "--noise_scale", &noise_scale.to_string(),
            "--output_file", &tmp_wav.to_string_lossy(),
            "--espeak_data", &espeak_data.to_string_lossy(),
            "--quiet",
        ])
        .env("LD_LIBRARY_PATH", &ld_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("piper 啟動失敗: {}", e))?;

    use std::io::Write;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }

    let status = child.wait().map_err(|e| format!("piper 等待失敗: {}", e))?;
    if !status.success() {
        use std::io::Read;
        let mut stderr = String::new();
        if let Some(mut s) = child.stderr.take() { let _ = s.read_to_string(&mut stderr); }
        log::error!("piper stderr: {}", stderr);
        let _ = std::fs::remove_file(&tmp_wav);
        return Err(format!("piper 回傳錯誤: {:?} stderr={}", status.code(), stderr));
    }

    // ponytail: try paplay → pw-play → aplay for audio output
    for player in &["paplay", "pw-play", "aplay"] {
        let result = std::process::Command::new(player)
            .arg(&tmp_wav)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if let Ok(s) = result {
            log::info!("speak_piper: {} exit={}", player, s.code().unwrap_or(-1));
            if s.success() {
                let _ = std::fs::remove_file(&tmp_wav);
                return Ok(());
            }
        }
    }
    let _ = std::fs::remove_file(&tmp_wav);
    log::error!("speak_piper: all players failed");
    Err("all audio players failed".to_string())
}

#[tauri::command]
fn scrape_quizlet(url: String) -> Result<String, String> {
    log::info!("scrape_quizlet url={}", url);
    if !url.starts_with("https://") { return Err("僅允許 HTTPS 連線".to_string()); }
    // F12: curl → ureq（Android 無 curl 二進制，舊碼 Command ENOENT 必敗）。
    // UA/15s 整體/10s 連線逐項對齊原 curl 旗標；-L 等價＝ureq 預設跟 5 跳
    // （ureq-2.12.1 agent.rs:262 redirects:5；HF/Quizlet 鏈 ≤2 跳，餘量充足）。
    let html_str = {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(15))
            .build();
        let resp = agent.get(&url)
            .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            // 2026-09-01 實測（學測4500 deck）：純 UA 被 PerimeterX 403；補 Accept/Accept-Language
            // 後同 URL 200 + 1.19MB 完整字卡頁 — 瀏覽器式 headers 三件套缺一不可。
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .set("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.8")
            .call()
            .map_err(|e| format!("HTTP 請求失敗: {}", e))?;
        resp.into_string().map_err(|e| format!("讀取回應失敗: {}", e))?
    };
    let cards = quizlet_scraper::scrape_quizlet_html(&html_str)
        .map_err(|e| format!("刮取失敗: {}（請確認網址是否為公開 Quizlet 單字集）", e))?;
    let json: Vec<serde_json::Value> = cards.iter().map(|c| {
        serde_json::json!({
            "term": c.term,
            "definition": c.definition,
        })
    }).collect();
    serde_json::to_string(&json).map_err(|e| format!("JSON 序列化失敗: {}", e))
}



#[tauri::command]
async fn fetch_llm(url: String, model: String, prompt: String, api_format: Option<String>) -> Result<String, String> {
    log::info!("fetch_llm url={} model={} prompt_len={} format={:?}", url, model, prompt.len(), api_format);
    let fmt = api_format.unwrap_or_default();
    let body = if fmt == "openai" {
        serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": false
        })
    } else {
        serde_json::json!({ "model": model, "prompt": prompt, "stream": false })
    };
    let json_str = serde_json::to_string(&body).map_err(|e| format!("serialize fail: {}", e))?;

    if !url.starts_with("http://") && !url.starts_with("https://") { return Err("URL 格式不正確".to_string()); }
    let handle = tokio::task::spawn_blocking(move || {
        // ponytail: ureq instead of curl — Android has no curl binary
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60)) // 對齊原 curl --max-time 60（整體上限）
            .build();
        let resp = agent.post(&url)
            .set("Content-Type", "application/json")
            .send_string(&json_str)
            .map_err(|e| format!("HTTP error: {}", e))?;
        let text = resp.into_string().map_err(|e| format!("body error: {}", e))?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("json parse fail: {}", e))?;
        let resp = if fmt == "openai" {
            match json["choices"][0]["message"]["content"].as_str() {
                Some(s) => s.to_string(),
                None => { log::warn!("fetch_llm: openai response missing content"); return Err("API response missing content".to_string()); }
            }
        } else {
            match json["response"].as_str() {
                Some(s) => s.to_string(),
                None => { log::warn!("fetch_llm: response missing field"); return Err("API response missing 'response' field".to_string()); }
            }
        };
        Ok(resp)
    });
    tokio::time::timeout(std::time::Duration::from_secs(90), handle).await
        .map_err(|_| format!("LLM request timed out after 90s"))?
        .map_err(|e| format!("task failed: {}", e))?
}

/// fetch_get URL 白名單：http 僅允許本機 host（localhost/127.0.0.1/[::1]），其餘一律 https-only。
/// （v3 定案：hostname 白名單取代 https:// 前置字串檢查；url crate 已在 Cargo.lock 為傳遞依賴）
/// 型別化比對（第 1 輪審查 #1 採納）：不用 host_str() 字串比對 — url 2.5.8 源碼實錘
/// host_str() 切片的是 parse 正規化重寫後的內部字串，IPv6 含方括號（"[::1]"）；
/// Host 列舉才是正規化型別（Domain/Ipv4/Ipv6；Ipv6Addr::LOCALHOST == ::1，
/// 長寫法 0:0:0:0:0:0:0:1 亦歸一；Domain host 已被小寫化，eq_ignore_ascii_case 為雙保險）。
fn check_fetch_get_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL 解析失敗: {}", e))?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => match parsed.host() {
            Some(url::Host::Domain(d)) if d.eq_ignore_ascii_case("localhost") => Ok(()),
            Some(url::Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => Ok(()),
            Some(url::Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST => Ok(()),
            _ => Err("僅允許 HTTPS 連線（http 僅限 localhost）".to_string()),
        },
        _ => Err("僅允許 HTTPS 連線".to_string()),
    }
}

#[tauri::command]
async fn fetch_get(url: String) -> Result<String, String> {
    log::info!("fetch_get url={}", url);
    check_fetch_get_url(&url)?;
    let handle = tokio::task::spawn_blocking(move || {
        // ponytail: ureq instead of curl — Android has no curl binary
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(15)) // 對齊原 curl --max-time 15（整體上限）
            .build();
        let resp = agent.get(&url)
            .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            // 2026-09-01 實測（學測4500 deck）：純 UA 被 PerimeterX 403；補 Accept/Accept-Language
            // 後同 URL 200 + 1.19MB 完整字卡頁 — 瀏覽器式 headers 三件套缺一不可。
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .set("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.8")
            .call()
            .map_err(|e| format!("HTTP error: {}", e))?;
        resp.into_string().map_err(|e| format!("body error: {}", e))
    });
    tokio::time::timeout(std::time::Duration::from_secs(20), handle).await
        .map_err(|_| format!("fetch_get request timed out"))?
        .map_err(|e| format!("task failed: {}", e))?
}

#[tauri::command]
async fn lookup_cambridge(word: String, lang: Option<String>) -> Result<String, String> {
    let is_zh = lang.as_deref() == Some("zh");
    let url = if is_zh {
        cambridge_scraper::build_chinese_url(&word)
    } else {
        cambridge_scraper::build_english_url(&word)
    };
    log::info!("lookup_cambridge word={} url={} lang={:?}", word, url, lang);
    let handle = tokio::task::spawn_blocking(move || {
        // ponytail: ureq instead of curl — Android has no curl binary
        let resp = ureq::get(&url)
            .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .call()
            .map_err(|e| format!("HTTP error: {}", e))?;
        let html = resp.into_string()
            .map_err(|e| format!("body error: {}", e))?;
        if is_zh {
            let result = cambridge_scraper::scrape_cambridge_chinese_html(&html)
                .map_err(|e| format!("解析失敗: {}", e))?;
            serde_json::to_string(&result).map_err(|e| format!("JSON 序列化失敗: {}", e))
        } else {
            let result = cambridge_scraper::scrape_cambridge_html(&html)
                .map_err(|e| format!("解析失敗: {}", e))?;
            serde_json::to_string(&result).map_err(|e| format!("JSON 序列化失敗: {}", e))
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(15), handle).await
        .map_err(|_| format!("lookup_cambridge request timed out"))?
        .map_err(|e| format!("task failed: {}", e))?
}


#[tauri::command]
async fn speak_text(text: String, voice: Option<String>, length_scale: Option<f64>, noise_scale: Option<f64>, app_handle: tauri::AppHandle) -> Result<(), String> {
    if TTS_PLAYING.swap(true, Ordering::Acquire) {
        return Err("已有語音正在播放".to_string());
    }

    let v = voice.as_deref().unwrap_or("en_US-ryan-high").to_string();
    let ls = length_scale.unwrap_or(1.0).max(0.3).min(3.0);
    let ns = noise_scale.unwrap_or(0.667).max(0.0).min(1.0);
    log::info!("speak_text len={} voice={} length_scale={} noise_scale={}", text.len(), v, ls, ns);
    // B2: 用 guard 保證無論成功/失敗都釋放旗標, 避免 join 失敗後 TTS 永久卡死
    struct TtsGuard;
    impl Drop for TtsGuard {
        fn drop(&mut self) { TTS_PLAYING.store(false, Ordering::Release); }
    }
    let _guard = TtsGuard;
    tokio::task::spawn_blocking(move || {
        speak_piper(&text, &v, ls, ns, &app_handle)
    }).await.map_err(|e| format!("TTS 執行緒錯誤: {}", e))?
}

#[tauri::command]
async fn import_piper_model_dialog(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle.dialog()
        .file()
        .add_filter("Piper 語音模型", &["onnx"])
        .pick_file(move |file| { let _ = tx.send(file); });
    let file = rx.await.map_err(|_| "對話框錯誤".to_string())?
        .ok_or_else(|| "使用者取消".to_string())?;
    // F10: Android SAF 回 content:// URI，FilePath::as_path()=None 曾直接必然「無效路徑」
    // （鏡同檔 import_db_dialog 既有模式：先經 copy_uri_to_cache 落地再當一般檔案讀）。
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
    let data_dir = piper_models_dir(&app_handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("建立模型目錄失敗: {}", e))?;
    let fname = src.file_name().ok_or("無效路徑")?.to_string_lossy().to_string();
    if !fname.ends_with(".onnx") { return Err("請選擇 .onnx 模型檔案".to_string()); }
    let dest = data_dir.join(&fname);
    std::fs::copy(&src, &dest).map_err(|e| format!("複製模型失敗: {}", e))?;
    let mut json_src = src.with_extension("onnx.json");
    if !json_src.exists() { json_src = src.with_extension("json"); }
    if json_src.exists() {
        let json_dest = dest.with_extension("onnx.json");
        std::fs::copy(&json_src, &json_dest).ok();
    }
    log::info!("import_piper_model_dialog {:?} -> {:?} (json={})", src, dest, json_src.exists());
    Ok(collect_piper_voices(&data_dir))
}

#[tauri::command]
fn delete_piper_model(name: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    let data_dir = piper_models_dir(&app_handle)?;
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.').collect();
    let onnx = data_dir.join(format!("{}.onnx", safe));
    let json_onnx = data_dir.join(format!("{}.onnx.json", safe));
    let json_legacy = data_dir.join(format!("{}.json", safe));
    let mut deleted = false;
    if onnx.exists() { std::fs::remove_file(&onnx).map_err(|e| e.to_string())?; deleted = true; }
    if json_onnx.exists() { std::fs::remove_file(&json_onnx).ok(); }
    if json_legacy.exists() { std::fs::remove_file(&json_legacy).ok(); }
    if !deleted { return Err(format!("找不到模型: {}", name)); }
    log::info!("delete_piper_model {:?}", onnx);
    Ok(())
}

/// F9: Parse a HuggingFace piper-voices URL into (repo-relative dir, model name).
/// Accepts tree/blob/resolve URLs, trailing slash, and the `hf.co` short host.
/// F12: query/fragment tail stripped (`?download=true` from HF download button);
/// host prefixes matched ASCII-case-insensitively (`HTTPS://HF.CO` variants).
/// Directory URLs must reach the quality level (.../lang/locale/voice/quality);
/// the model name is {locale}-{voice}-{quality} = last three directory segments.
fn parse_piper_url(url: &str) -> Result<(String, String), String> {
    // F12: HF「下載檔案」按鈕複製的網址自帶 ?download=true；#fragment 同棄
    let mut rest = url.trim().split(['?', '#']).next().unwrap_or("");
    // F12 R1#3（返修補全）: 混入文字的粘貼法（「帮我安装 <url>」「你好https://…」）
    // 明確拒絕。合法向量無論有無 scheme/www 前綴皆以 ASCII 起頭（F9 釘 hf_co_bare_host
    // 支援裸 hf.co/...），非 ASCII 起頭必非 URL——舊 lenient 行為會拼出含
    // tree/main 的垃圾相對路徑，到下載端才 404，錯誤訊息難讀。空字串不經本閘
    // （留給下方段數守門，錯誤訊息含範例網址更貼切）。
    if !rest.is_empty() && !rest.starts_with(|c: char| c.is_ascii()) {
        return Err("網址混入了額外文字，請只貼網址本身".to_string());
    }
    // F12: 大小寫不敏感前綴鏈（舊 trim_start_matches 大小寫敏感，HTTPS://HF.CO 不中→段位移）。
    // 字節安全×2：① .get() 取代裸切片——rest 以多字節字符開頭時（「帮我安装 https://…」
    // 粘貼法，R1#3 實測 panic 釘）直接 None 不 panic；② 匹配成立 ⇒ 該段全 ASCII
    // （UTF-8 非 ASCII 字節恒 >=0x80 不可能等於 ASCII 字節），切割必落字符邊界。
    for pref in ["https://", "http://", "www.", "huggingface.co/", "hf.co/"] {
        if rest.get(..pref.len()).is_some_and(|h| h.eq_ignore_ascii_case(pref)) {
            rest = &rest[pref.len()..];
        }
    }
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    // segments = [owner, repo, ref_type(tree|blob|resolve), ref, dirs..., file?]
    if segments.len() < 6 {
        return Err("網址格式不正確，預期 huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high".to_string());
    }
    let dirs = &segments[4..];
    let last = *segments.last().unwrap();
    if last.ends_with(".onnx") {
        let name = last.strip_suffix(".onnx").unwrap_or(last);
        Ok((dirs[..dirs.len() - 1].join("/"), name.to_string()))
    } else {
        if dirs.len() < 4 {
            return Err("請貼到品質目錄層級(high/medium/low)，例如 huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high".to_string());
        }
        let n = dirs.len();
        Ok((dirs.join("/"), format!("{}-{}-{}", dirs[n - 3], dirs[n - 2], dirs[n - 1])))
    }
}

/// F12: Download `url` to `dest` via ureq (Android has no curl binary).
/// Status semantics strict: ureq `.call()` errors on >=400 BEFORE any file is
/// created — HF 404 error pages can no longer be saved as fake .onnx models
/// (the curl-without--f poisoning chain found in F9). `overall_secs` mirrors
/// the old `curl --max-time`; mid-stream failure removes the partial file.
/// `pub` for integration tests (src-tauri/tests/f12_download.rs).
pub fn download_url_to_file(url: &str, dest: &std::path::Path, overall_secs: u64) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(overall_secs))
        .build();
    let resp = agent.get(url)
        .call()
        .map_err(|e| format!("HTTP 請求失敗: {}", e))?;
    let mut reader = resp.into_reader();
    let mut f = std::fs::File::create(dest).map_err(|e| format!("建立檔案失敗 ({}): {}", dest.display(), e))?;
    if let Err(e) = std::io::copy(&mut reader, &mut f) {
        let _ = std::fs::remove_file(dest);
        return Err(format!("下載中斷: {}", e));
    }
    Ok(())
}

#[tauri::command]
fn install_piper_model(url: String, app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let data_dir = piper_models_dir(&app_handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("建立模型目錄失敗: {}", e))?;

    // F9: URL 解析委派給 parse_piper_url（尾斜杠/短網域/深度守門，見其文件與單元測試）
    let (rel_path, model_name) = parse_piper_url(&url)?;

    let download = |model_name: &str| -> Result<String, String> {
        let base = format!("https://huggingface.co/rhasspy/piper-voices/resolve/main/{}", rel_path);
        let onnx_url = format!("{}/{}.onnx", base, model_name);
        let json_url = format!("{}/{}.onnx.json", base, model_name);
        let dest = data_dir.join(format!("{}.onnx", model_name));
        let dest_json = data_dir.join(format!("{}.onnx.json", model_name));

        // F12: curl → ureq（Android 無 curl；404 狀態語意根治中毒鏈）
        download_url_to_file(&onnx_url, &dest, 120)
            .map_err(|e| format!("{}，請確認網址正確: {}", e, onnx_url))?;
        // sidecar json best-effort（舊 curl 版失敗僅刪檔續行，語意零變化）
        if download_url_to_file(&json_url, &dest_json, 30).is_err() {
            let _ = std::fs::remove_file(&dest_json);
        }
        Ok(model_name.to_string())
    };

    download(&model_name)?;

    Ok(collect_piper_voices(&data_dir))
}

// ─── 匯出容器格式: teno.db + app-log.db 打包單一檔案, 明確長度分隔 ───
// 結構: "TENOC"(5) + version(1) + [u32 len][teno.db bytes] + [u32 len][app-log.db bytes]
// len=0 表示無 log。向後相容: 非容器資料視為純 teno.db。
const CONTAINER_MAGIC: &[u8] = b"TENOC";

fn pack_db_container(app_dir: &std::path::Path, include_log: bool) -> Result<Vec<u8>, String> {
    let teno = std::fs::read(app_dir.join("teno.db")).map_err(|e| format!("讀取資料庫失敗: {}", e))?;
    let log = if include_log {
        let p = app_dir.join("app-log.db");
        if p.exists() {
            std::fs::read(&p).map_err(|e| format!("讀取操作日誌失敗: {}", e))?
        } else { Vec::new() }
    } else { Vec::new() };
    let mut out = CONTAINER_MAGIC.to_vec();
    out.push(1u8);
    out.extend_from_slice(&(teno.len() as u32).to_le_bytes());
    out.extend_from_slice(&teno);
    out.extend_from_slice(&(log.len() as u32).to_le_bytes());
    out.extend_from_slice(&log);
    Ok(out)
}

fn unpack_db_container(data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    if !data.starts_with(CONTAINER_MAGIC) {
        // 非容器: 必須是有效 SQLite 檔, 避免誤選檔案覆寫現有 DB
        if !data.starts_with(b"SQLite format 3\0") {
            return Err("不是有效的 Teno 備份或 SQLite 檔案".to_string());
        }
        return Ok((data.to_vec(), Vec::new()));
    }
    if data.len() < 6 { return Err("容器格式損壞 (magic 不完整)".to_string()); }
    // D16: version byte 讀而必斷——pack 端恆寫 1，v0/v2/翻轉位皆非本代語意，
    // 硬解析＝半壞資料以健康姿態覆寫好 DB（資料覆寫入口拒比收安分，同 D19/F12 族譜）。
    if data[5] != 1 {
        return Err(format!("容器版本不支援: v{}（本版 Teno 僅支援 v1，請升級後再匯入）", data[5]));
    }
    let mut pos = 6usize;
    let read_u32 = |p: usize| -> Option<u32> {
        if data.len() >= p + 4 {
            Some(u32::from_le_bytes([data[p], data[p + 1], data[p + 2], data[p + 3]]))
        } else { None }
    };
    let Some(teno_len) = read_u32(pos) else { return Err("容器損壞: 缺少長度欄位".to_string()); };
    pos += 4;
    if data.len() < pos + teno_len as usize { return Err("容器損壞: teno.db 段截斷".to_string()); }
    let teno = data[pos..pos + teno_len as usize].to_vec();
    pos += teno_len as usize;
    // D16: log 長度欄缺位＝截斷（pack 端恆寫 log 欄含 len=0，缺欄必為損壞），
    // 舊碼 if-let 靜默降級為無 log＝同族第三病灶（半截容器健康過關）。
    let Some(log_len) = read_u32(pos) else { return Err("容器損壞: 缺少 app-log 長度欄位（檔案不完整，請重新匯出備份）".to_string()); };
    pos += 4;
    if data.len() < pos + log_len as usize {
        return Err("容器損壞: app-log.db 段截斷".to_string());
    }
    let log = data[pos..pos + log_len as usize].to_vec();
    pos += log_len as usize;
    // D16: trailing garbage 必拒——合法 pack 產物段段相接恰好用盡位元組，
    // 尾部多餘資料＝拼接/損壞/手改，靜默丟棄回 Ok 即偽損壞接受面。
    if pos != data.len() {
        return Err(format!("容器損壞: 尾部有多餘資料（{} bytes，可能為手動修復殘留；可用 CLI import-db 救回後重新匯出）", data.len() - pos));
    }
    Ok((teno, log))
}

fn write_db_container(app_dir: &std::path::Path, teno: &[u8], log: &[u8]) -> Result<(), String> {
    let _ = std::fs::remove_file(app_dir.join("teno.db-wal"));
    let _ = std::fs::remove_file(app_dir.join("teno.db-shm"));
    let tmp = app_dir.join("teno.db.tmp");
    std::fs::write(&tmp, teno).map_err(|e| format!("寫入資料庫失敗: {}", e))?;
    std::fs::rename(&tmp, app_dir.join("teno.db")).map_err(|e| format!("寫入資料庫失敗: {}", e))?;
    if !log.is_empty() {
        let _ = std::fs::remove_file(app_dir.join("app-log.db-wal"));
        let _ = std::fs::remove_file(app_dir.join("app-log.db-shm"));
        std::fs::write(app_dir.join("app-log.db"), log).map_err(|e| format!("寫入操作日誌失敗: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn write_db_bytes(app_handle: tauri::AppHandle, data: Vec<u8>) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    log::info!("write_db_bytes app_dir={:?} data_len={}", app_dir, data.len());
    let (teno, log) = unpack_db_container(&data)?;
    write_db_container(&app_dir, &teno, &log)?;
    log::info!("write_db_bytes OK (teno={} log={})", teno.len(), log.len());
    Ok(())
}

#[tauri::command]
async fn import_db_dialog(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle.dialog()
        .file()
        .add_filter("SQLite Database", &["db", "sqlite", "sqlite3"])
        .pick_file(move |file| { let _ = tx.send(file); });
    let file = rx.await.map_err(|_| "對話框錯誤".to_string())?
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
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let data = std::fs::read(&src).map_err(|e| format!("讀取檔案失敗: {}", e))?;
    let (teno, log) = unpack_db_container(&data)?;
    write_db_container(&app_dir, &teno, &log)?;
    log::info!("import_db_dialog OK (teno={} log={})", teno.len(), log.len());
    Ok(())
}

// ─── 官方 FSRS 權重優化 (fsrs-rs 6.6.1 compute_parameters, 桌面用官方算法) ───
#[derive(serde::Deserialize)]
struct FsrsReviewEntry {
    word_id: String,
    rating: u32,
    elapsed_days: Option<u32>,
}

#[tauri::command]
fn optimize_fsrs(reviews: Vec<FsrsReviewEntry>) -> Result<Vec<f32>, String> {
    use std::collections::HashMap;
    use fsrs::{compute_parameters, ComputeParametersInput, FSRSItem, FSRSReview};
    log::info!("optimize_fsrs reviews={}", reviews.len());
    let mut by_card: HashMap<String, Vec<FsrsReviewEntry>> = HashMap::new();
    for r in reviews {
        by_card.entry(r.word_id.clone()).or_default().push(r);
    }
        let mut items: Vec<FSRSItem> = Vec::new();
        for (_, mut rs) in by_card {
            rs.sort_by(|a, b| a.elapsed_days.unwrap_or(0).cmp(&b.elapsed_days.unwrap_or(0)));
            let mut first = true;
            let f_reviews: Vec<FSRSReview> = rs.into_iter().map(|r| {
                let d = if first { 0 } else { r.elapsed_days.unwrap_or(0) };
                first = false;
                FSRSReview { rating: (r.rating + 1).min(4).max(1), delta_t: d }
            }).collect();
            let has_positive = f_reviews.iter().any(|r| r.delta_t > 0);
            if f_reviews.len() >= 2 && has_positive {
                items.push(FSRSItem { reviews: f_reviews });
            }
        }
        log::info!("optimize_fsrs items={}", items.len());
        if items.is_empty() {
            return Err("沒有足夠的有效複習記錄（至少需要一個包含跨日複習的卡片）".to_string());
        }
        let input = ComputeParametersInput {
        train_set: items,
        ..Default::default()
    };
    let params = compute_parameters(input).map_err(|e| format!("FSRS 優化失敗: {:?}", e))?;
    log::info!("optimize_fsrs OK weights={}", params.len());
    Ok(params)
}

// ─── 官方 FSRS 模擬器 (fsrs-rs 6.6.1 simulate / extract_simulator_config / optimal_retention, 對齊 Anki 26.08) ───
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimCardEntry {
    stability: f32,
    difficulty: f32,
    /// scheduled_days (天數)
    interval: f32,
    lapses: u32,
    /// 0=new, 1=learn, 2=review, 3=relearn
    state: u8,
    due_ms: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimReviewEntry {
    word_id: String,
    /// 0-3 (Again/Hard/Good/Easy)
    rating: u32,
    duration_ms: u32,
    /// 複習時狀態 0=new, 1=learn, 2=review, 3=relearn
    card_state: u8,
    reviewed_at_ms: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulateFsrsRequest {
    cards: Vec<SimCardEntry>,
    reviews: Vec<SimReviewEntry>,
    params: Vec<f32>,
    desired_retention: f32,
    max_interval: u32,
    /// 每日新卡上限
    learn_limit: u32,
    /// 每日複習上限
    review_limit: u32,
    days: u32,
    seed: u64,
    /// "simulate" | "workload" | "optimal"
    mode: String,
    /// 清空進度從零學
    from_zero: bool,
    /// 複習排序: "day" | "retrievability_asc" | "retrievability_desc" | "random"
    #[serde(default = "default_review_order")]
    review_order: String,
    /// 新卡忽略每日複習上限 (對齊 Anki new_cards_ignore_review_limit)
    #[serde(default)]
    new_cards_ignore_review_limit: bool,
    /// 累積失敗幾次後 suspend (對齊 Anki suspend_after_lapse_count)
    #[serde(default)]
    suspend_after_lapse_count: Option<u32>,
    /// Easy Days 每週日負載 (0.0=Minimum, 0.5=Reduced, 1.0=Normal; 對齊 Anki easy_days_percentages)
    #[serde(default)]
    easy_days_percentages: Vec<f32>,
    /// 時區偏移（分鐘，台灣 +480）— 算當地日界線用
    #[serde(default)]
    timezone_offset_minutes: i32,
    /// 日界線（分鐘，從當地 00:00 起算；teno dayCutoff=360）
    #[serde(default)]
    day_cutoff_minutes: i32,
}

fn default_review_order() -> String {
    "day".to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadDr {
    dr: u32,
    memorized: f32,
    cost: f32,
    review_count: u32,
}

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SimulateFsrsResponse {
    memorized_per_day: Vec<f32>,
    review_per_day: Vec<u32>,
    learn_per_day: Vec<u32>,
    cost_per_day: Vec<f32>,
    drs: Vec<WorkloadDr>,
    reviewless_end_memorized: f32,
    optimal_retention: Option<f32>,
}

/// 穩定字串 hash → i64 (revlog cid 用, 同詞同 cid)
fn word_id_hash(w: &str) -> i64 {
    let mut h: i64 = 0;
    for b in w.bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as i64);
    }
    h
}

fn revlog_kind_from_state(state: u8) -> fsrs::RevlogReviewKind {
    match state {
        0 | 1 => fsrs::RevlogReviewKind::Learning,
        2 => fsrs::RevlogReviewKind::Review,
        _ => fsrs::RevlogReviewKind::Relearning,
    }
}

/// 對齊 Anki create_review_priority_fn (simulator.rs:80-119)。
/// teno 無 deck 概念 → Day/DayThenDeck/DeckThenDay 皆為 scheduled_due。
fn build_review_priority(order: &str, deck_size: usize) -> Option<fsrs::ReviewPriorityFn> {
    use fsrs::ReviewPriorityFn;
    match order {
        "retrievability_asc" => Some(ReviewPriorityFn::new(|c: &fsrs::Card| {
            -(c.retrievability() * 1000.0) as i32
        })),
        "retrievability_desc" => Some(ReviewPriorityFn::new(|c: &fsrs::Card| {
            (c.retrievability() * 1000.0) as i32
        })),
        // Random: 偽隨機 (seed 固定可重現; Anki 用真隨機 rand::rng)
        "random" => Some(ReviewPriorityFn::new(move |c: &fsrs::Card| {
            (c.id as i64).wrapping_mul(2654435761) as i32 % (deck_size.max(1) as i32)
        })),
        // day (預設): scheduled_due = last_date + interval
        _ => Some(ReviewPriorityFn::new(|c: &fsrs::Card| {
            c.scheduled_due() as i32
        })),
    }
}

// ─── Load Balancer + Easy Days（移植 Anki 26.08 rslib/src/scheduler/states/{load_balancer,fuzz}.rs，對齊模擬器 post_scheduling_fn）───
// 用於模擬時對 interval 做加權分散：同一天複習數越少越優先、Easy Day 調節、sibling 分散（teno 無 sibling → 固定 1.0）

/// Anki fuzz.rs FUZZ_RANGES
const FUZZ_RANGES: [(f32, f32, f32); 3] = [
    (2.5, 7.0, 0.15),
    (7.0, 20.0, 0.1),
    (20.0, f32::MAX, 0.05),
];

fn fuzz_delta(interval: f32) -> f32 {
    if interval < 2.5 {
        0.0
    } else {
        FUZZ_RANGES.iter().fold(1.0, |delta, &(start, end, factor)| {
            delta + factor * (interval.min(end) - start).max(0.0)
        })
    }
}

fn fuzz_bounds(interval: f32) -> (u32, u32) {
    let delta = fuzz_delta(interval);
    (
        (interval - delta).round() as u32,
        (interval + delta).round() as u32,
    )
}

fn constrained_fuzz_bounds(interval: f32, minimum: u32, maximum: u32) -> (u32, u32) {
    let minimum = minimum.min(maximum);
    let interval = interval.clamp(minimum as f32, maximum as f32);
    let (mut lower, mut upper) = fuzz_bounds(interval);
    lower = lower.clamp(minimum, maximum);
    upper = upper.clamp(minimum, maximum);
    if upper == lower && upper > 2 && upper < maximum {
        upper = lower + 1;
    }
    (lower, upper)
}

/// Anki load_balancer.rs EasyDay（0.0=Minimum, 0.5=Reduced, 1.0=Normal）
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum EasyDay {
    Minimum,
    Reduced,
    Normal,
}

impl From<f32> for EasyDay {
    fn from(other: f32) -> EasyDay {
        match other {
            1.0 => EasyDay::Normal,
            0.0 => EasyDay::Minimum,
            _ => EasyDay::Reduced,
        }
    }
}

impl EasyDay {
    fn load_modifier(&self) -> f32 {
        match self {
            EasyDay::Minimum => 0.0001,
            EasyDay::Reduced => 0.5,
            EasyDay::Normal => 1.0,
        }
    }
}

fn parse_easy_days_percentages(percentages: &[f32]) -> [EasyDay; 7] {
    if percentages.len() != 7 {
        return [EasyDay::Normal; 7];
    }
    let mut out = [EasyDay::Normal; 7];
    for (i, p) in percentages.iter().enumerate() {
        out[i] = EasyDay::from(*p);
    }
    out
}

/// Anki load_balancer.rs interval_to_weekday — 用 tzOffset 轉當地（Anki 用系統時區 local_datetime；teno 用 app 設定時區，更一致）
fn interval_to_weekday(interval: u32, next_day_at: i64, timezone_offset_secs: i64) -> usize {
    let local_secs = next_day_at + (interval as i64 - 1) * 86400 + timezone_offset_secs;
    use chrono::Datelike;
    chrono::DateTime::from_timestamp(local_secs, 0)
        .map(|dt| dt.weekday().num_days_from_monday() as usize)
        .unwrap_or(0)
}

/// Anki load_balancer.rs calculate_easy_days_modifiers
fn calculate_easy_days_modifiers(
    easy_days_load: &[EasyDay; 7],
    weekdays: &[usize],
    review_counts: &[usize],
) -> Vec<f32> {
    let total_review_count: usize = review_counts.iter().sum();
    let total_percents: f32 = weekdays
        .iter()
        .map(|&weekday| easy_days_load[weekday].load_modifier())
        .sum();

    weekdays
        .iter()
        .zip(review_counts.iter())
        .map(|(&weekday, &review_count)| {
            let day = match easy_days_load[weekday] {
                EasyDay::Reduced => {
                    const HALF: f32 = 0.5;
                    let other_days_review_total = (total_review_count - review_count) as f32;
                    let other_days_percent_total = total_percents - HALF;
                    let normalized_count = review_count as f32 / HALF;
                    let reduced_day_threshold = other_days_review_total / other_days_percent_total;
                    if normalized_count > reduced_day_threshold {
                        EasyDay::Minimum
                    } else {
                        EasyDay::Normal
                    }
                }
                other => other,
            };
            day.load_modifier()
        })
        .collect()
}

/// Anki load_balancer.rs LoadBalancerInterval
struct LoadBalancerInterval {
    target_interval: u32,
    review_count: usize,
    sibling_modifier: f32,
    easy_days_modifier: f32,
}

/// Anki load_balancer.rs select_weighted_interval（rand 0.9 WeightedIndex + StdRng seed）
fn select_weighted_interval(
    intervals: impl Iterator<Item = LoadBalancerInterval>,
    fuzz_seed: Option<u64>,
) -> Option<u32> {
    use rand::distr::weighted::WeightedIndex;
    use rand::distr::Distribution;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    let intervals_and_weights = intervals
        .map(|interval| {
            let weight = match interval.review_count {
                0 => 1.0,
                card_count => {
                    let card_count_weight = (1.0 / card_count as f32).powf(2.15);
                    let card_interval_weight = (1.0 / interval.target_interval as f32).powi(3);
                    card_count_weight
                        * card_interval_weight
                        * interval.sibling_modifier
                        * interval.easy_days_modifier
                }
            };
            (interval.target_interval, weight)
        })
        .collect::<Vec<_>>();

    let mut rng = StdRng::seed_from_u64(fuzz_seed?);
    let weighted_intervals =
        WeightedIndex::new(intervals_and_weights.iter().map(|k| k.1)).ok()?;
    let selected_interval_index = weighted_intervals.sample(&mut rng);
    Some(intervals_and_weights[selected_interval_index].0)
}

/// Anki simulator.rs apply_load_balance_and_easy_days
fn apply_load_balance_and_easy_days(
    interval: f32,
    max_interval: f32,
    day_elapsed: usize,
    due_cnt_per_day: &[usize],
    fuzz_seed: u64,
    next_day_at: i64,
    timezone_offset_secs: i64,
    easy_days_percentages: &[EasyDay; 7],
) -> f32 {
    let (lower, upper) = constrained_fuzz_bounds(interval, 1, max_interval as u32);
    let mut review_counts = vec![0; upper as usize - lower as usize + 1];

    let start = day_elapsed + lower as usize;
    let end = (day_elapsed + upper as usize + 1).min(due_cnt_per_day.len());
    if start < due_cnt_per_day.len() {
        let copy_len = (end - start).min(review_counts.len());
        review_counts[..copy_len].copy_from_slice(&due_cnt_per_day[start..start + copy_len]);
    }

    let possible_intervals: Vec<u32> = (lower..=upper).collect();
    let weekdays = possible_intervals
        .iter()
        .map(|interval| interval_to_weekday(*interval, next_day_at, timezone_offset_secs))
        .collect::<Vec<_>>();
    let easy_days_modifier =
        calculate_easy_days_modifiers(easy_days_percentages, &weekdays, &review_counts);

    let intervals = possible_intervals
        .iter()
        .enumerate()
        .map(|(interval_index, &target_interval)| LoadBalancerInterval {
            target_interval,
            review_count: review_counts[interval_index],
            sibling_modifier: 1.0,
            easy_days_modifier: easy_days_modifier[interval_index],
        });
    select_weighted_interval(intervals, Some(fuzz_seed)).unwrap_or(interval as u32) as f32
}

/// 對齊 Anki timing_today().next_day_at：當地日界線（今天已過 cutoff → 明天；否則今天）
fn compute_next_day_at(now: i64, timezone_offset_secs: i64, day_cutoff_minutes: i32) -> i64 {
    let local_now = now + timezone_offset_secs;
    let local_midnight = local_now - local_now % 86400;
    let cutoff_secs = (day_cutoff_minutes.max(0) as i64) * 60;
    let mut local_next_day_at = local_midnight + cutoff_secs;
    if local_now >= local_next_day_at {
        local_next_day_at += 86400;
    }
    local_next_day_at - timezone_offset_secs
}

/// F19：Anki 當地 cutoff 系天數 — floor((t + tz - cutoff) / 86400)。
/// 對齊官方 timing.rs 日界線切割（日界線＝當地 cutoff 分鐘，非 UTC 午夜）。
/// div_euclid＝floor 語意，負偏移（西時區／cutoff 前時刻）不破。
/// 根治 simulate_fsrs 卡片端 UTC 系 vs revlog 端當地系的雙參考系混用。
fn local_day_index(t_secs: i64, timezone_offset_secs: i64, cutoff_secs: i64) -> i64 {
    (t_secs + timezone_offset_secs - cutoff_secs).div_euclid(86400)
}

#[tauri::command]
fn simulate_fsrs(req: SimulateFsrsRequest) -> Result<SimulateFsrsResponse, String> {
    use fsrs::{extract_simulator_config, optimal_retention, simulate, Card, RevlogEntry};
    use std::sync::Arc;
    log::info!(
        "simulate_fsrs mode={} cards={} reviews={} days={} dr={} from_zero={}",
        req.mode, req.cards.len(), req.reviews.len(), req.days, req.desired_retention, req.from_zero
    );

    // 1. reviewLog → fsrs RevlogEntry (id 用真實時間戳, 同詞同 cid)
    let revlogs: Vec<RevlogEntry> = req
        .reviews
        .iter()
        .map(|r| RevlogEntry {
            id: r.reviewed_at_ms,
            cid: word_id_hash(&r.word_id),
            usn: 0,
            button_chosen: (r.rating + 1).min(4).max(1) as u8,
            interval: 0,
            last_interval: 0,
            ease_factor: 0,
            taken_millis: r.duration_ms,
            review_kind: revlog_kind_from_state(r.card_state),
        })
        .collect();

    // 2. next_day_at = 當地日界線 (對齊 Anki timing_today().next_day_at)
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let tz_secs = req.timezone_offset_minutes as i64 * 60;
    let next_day_at = compute_next_day_at(now, tz_secs, req.day_cutoff_minutes);

    // 3. 從真實 revlog 抽 config (smooth=true 對齊 Anki get_optimal_retention_parameters)
    let mut config = extract_simulator_config(revlogs, next_day_at, true);
    config.learn_span = req.days as usize;
    config.max_cost_perday = f32::MAX; // 對齊 Anki: 不限制每日成本
    config.max_ivl = req.max_interval as f32;
    config.learn_limit = req.learn_limit as usize;
    config.review_limit = req.review_limit as usize;
    config.new_cards_ignore_review_limit = req.new_cards_ignore_review_limit;
    config.suspend_after_lapses = req.suspend_after_lapse_count;
    // 對齊 Anki 26.08 實際行為：SimulateFsrsReviewRequest 的 learning_step_count/relearning_step_count
    // 在 SimulatorModal 未綁定 → proto default 0 → 學習卡一步畢業（memory_state_short_term step_count=0）
    config.learning_step_count = 0;
    config.relearning_step_count = 0;
    // Load balancer + Easy Days：Anki 26.08 LoadBalancerEnabled 預設 true → 模擬時套用 post_scheduling_fn
    let easy_days = parse_easy_days_percentages(&req.easy_days_percentages);
    let post_next_day_at = next_day_at;
    let post_tz_secs = tz_secs;
    config.post_scheduling_fn = Some(fsrs::PostSchedulingFn::new(
        move |mut ctx: fsrs::PostSchedulingContext<'_>| {
            apply_load_balance_and_easy_days(
                ctx.card.interval,
                ctx.max_interval,
                ctx.today,
                ctx.due_counts_per_day,
                ctx.random_u64(),
                post_next_day_at,
                post_tz_secs,
                &easy_days,
            )
        },
    ));

    // 4. 卡片轉換 (對齊 Anki Card::convert + simulate_request_to_config)
    // F19：卡片端與 revlog 端統一「當地 cutoff 系」（extract_simulator_config 用
    // next_day_at 當地錨定；原 UTC 系 today_days 造成同日不同時刻模擬結果抖動 ±1 天）
    let cutoff_secs = (req.day_cutoff_minutes.max(0) as i64) * 60;
    let today_days = local_day_index(now, tz_secs, cutoff_secs) as f32;
    let params_arc: Arc<Vec<f32>> = Arc::new(req.params.clone());
    let existing: Vec<Card> = req
        .cards
        .iter()
        .enumerate()
        .filter(|(_, c)| !req.from_zero && c.state > 0)
        .map(|(i, c)| {
            let due_day = c.due_ms
                .map(|ms| local_day_index(ms.div_euclid(1000), tz_secs, cutoff_secs) as f32 - today_days)
                .unwrap_or(0.0);
            let last_date = (due_day - c.interval).min(0.0);
            Card {
                id: i as i64 + 1,
                difficulty: c.difficulty,
                stability: c.stability.max(1e-8),
                last_date,
                due: due_day,
                interval: c.interval,
                lapses: c.lapses,
                desired_retention: req.desired_retention,
                parameters: params_arc.clone(),
            }
        })
        .collect();
    // deck_size = 該模式全部詞數 (simulate_inner 自動補足新卡, 分批 learn_limit/天)
    config.deck_size = req.cards.len();
    config.review_priority_fn = build_review_priority(&req.review_order, config.deck_size);

    // 5. 執行
    let mut resp = SimulateFsrsResponse::default();
    match req.mode.as_str() {
        "workload" => {
            for dr in 70..=99u32 {
                let cards = existing
                    .iter()
                    .map(|c| {
                        let mut x = c.clone();
                        x.desired_retention = dr as f32 / 100.0;
                        x
                    })
                    .collect::<Vec<_>>();
                let result = simulate(&config, &req.params, dr as f32 / 100.0, Some(req.seed), Some(cards))
                    .map_err(|e| format!("負載模擬失敗: {:?}", e))?;
                resp.drs.push(WorkloadDr {
                    dr,
                    memorized: *result.memorized_cnt_per_day.last().unwrap_or(&0.0),
                    cost: result.cost_per_day.iter().sum(),
                    review_count: result.review_cnt_per_day.iter().sum::<usize>() as u32
                        + result.learn_cnt_per_day.iter().sum::<usize>() as u32,
                });
            }
            // reviewless: 完全不複習, 每張卡按記憶曲線衰減到模擬末日 (對齊 Anki simulate_workload)
            resp.reviewless_end_memorized =
                existing.iter().fold(0.0, |p, c| p + c.retention_on(req.days as f32));
        }
        "optimal" => {
            let dr = optimal_retention(&config, &req.params, |_| true, Some(existing), None)
                .map_err(|e| format!("最佳留存率計算失敗: {:?}", e))?;
            resp.optimal_retention = Some(dr);
            log::info!("simulate_fsrs optimal retention = {:.4}", dr);
        }
        _ => {
            let result = simulate(&config, &req.params, req.desired_retention, Some(req.seed), Some(existing))
                .map_err(|e| format!("模擬失敗: {:?}", e))?;
            resp.memorized_per_day = result.memorized_cnt_per_day;
            resp.review_per_day = result.review_cnt_per_day.iter().map(|x| *x as u32).collect();
            resp.learn_per_day = result.learn_cnt_per_day.iter().map(|x| *x as u32).collect();
            resp.cost_per_day = result.cost_per_day;
        }
    }
    log::info!("simulate_fsrs OK mode={}", req.mode);
    Ok(resp)
}

/// F14: 開啟除錯鏡像 log。根除 `/tmp` 固定路徑的 symlink 追擊面——
/// 目標目錄為 app 私有（app_log_dir，tauri 開機自建），且 Linux/Android
/// 下帶 O_NOFOLLOW 原子守門：symlink 預植時 open 直接 ELOOP 失敗回 None，
/// 零「檢查-使用」窗口、零新依賴。
/// 注意（R1#3-F-1 勘誤）：`target_os="linux"` 在 Android **為 false**
/// （android 與 linux 互斥），必 any() 雙 os；O_NOFOLLOW 非跨架構通用值
/// （glibc/bionic x86=0x20000、arm/arm64=0x8000、riscv64 bionic=0x400000／
/// glibc=0x20000，R3#2 勘誤），必 per-arch 取值。矩陣外架構與未知 os 退化
/// 為僅目錄隔離（fail-toward-isolation，不比現況差）。
fn open_monitor_log(dir: &std::path::Path) -> Option<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // 架構常數表：源＝linux/uapi fcntl.h＋bionic（glibc 同值）。
        const O_NOFOLLOW: i32 = if cfg!(any(target_arch = "aarch64", target_arch = "arm")) {
            0x8000 // arm/arm64（含產品 Android a55 arm64）
        } else if cfg!(any(target_arch = "x86", target_arch = "x86_64")) {
            0x20000 // x86/x86_64
        } else {
            0 // riscv64/mips 等矩陣外：0＝不設 flag（見 doc 註退化語意）
        };
        if O_NOFOLLOW != 0 {
            opts.custom_flags(O_NOFOLLOW);
        }
        opts.mode(0o600);
    }
    opts.open(dir.join("teno-monitor.log")).ok()
}

#[tauri::command]
fn log_msg(msg: String, app_handle: tauri::AppHandle) {
    use std::io::Write;
    log::info!("[js] {msg}");
    // F14: 舊實作把前端 console 轉發寫進世界可寫 /tmp 下固定檔名（目錄
    // sticky 但檔可被預植 symlink＋內容前端可注入＝arbitrary-append 原語），
    // 改落 app 私有 log 目錄。
    if let Ok(dir) = app_handle.path().app_log_dir() {
        if let Some(mut f) = open_monitor_log(&dir) {
            let _ = writeln!(f, "{}", msg);
        }
    }
}

#[tauri::command]
async fn export_db_dialog(app_handle: tauri::AppHandle, include_log: bool) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle.dialog()
        .file()
        .add_filter("SQLite Database", &["db", "teno"])
        .set_file_name("teno-backup.db")
        .save_file(move |file| { let _ = tx.send(file); });
    let file = rx.await.map_err(|_| "對話框錯誤".to_string())?
        .ok_or_else(|| {
            log::info!("export_db_dialog cancelled");
            "使用者取消".to_string()
        })?;
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let data = pack_db_container(&app_dir, include_log)?;
    match file {
        FilePath::Path(dest) => {
            log::info!("export_db_dialog dst={:?} data_len={} include_log={}", dest, data.len(), include_log);
            std::fs::write(&dest, &data)
                .map_err(|e| format!("寫入匯出檔失敗: {}", e))?;
            log::info!("export_db_dialog OK");
            Ok(format!("{}", dest.display()))
        }
        FilePath::Url(_url) => {
            let exports = app_dir.join("exports");
            std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
            let fallback = exports.join("teno-backup.db");
            std::fs::write(&fallback, &data).map_err(|e| format!("寫入失敗: {}", e))?;
            log::info!("export_db_dialog fallback to {:?}", fallback);
            Ok(format!("{}", fallback.display()))
        }
    }
}

#[tauri::command]
async fn export_csv_dialog(app_handle: tauri::AppHandle, csv: String, filename: String) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle.dialog()
        .file()
        .add_filter("CSV 檔案", &["csv"])
        .set_file_name(&filename)
        .save_file(move |file| { let _ = tx.send(file); });
    let file = rx.await.map_err(|_| "對話框錯誤".to_string())?
        .ok_or_else(|| {
            log::info!("export_csv_dialog cancelled");
            "使用者取消".to_string()
        })?;
    log::info!("export_csv_dialog csv_len={}", csv.len());
    let bom: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    let mut content = bom;
    content.extend_from_slice(csv.as_bytes());
    match file {
        FilePath::Path(dest) => {
            log::info!("export_csv_dialog dst={:?}", dest);
            std::fs::write(&dest, &content).map_err(|e| { log::error!("export_csv_dialog write fail: {}", e); format!("寫入 CSV 失敗: {}", e) })?;
            log::info!("export_csv_dialog OK");
            Ok(format!("{}", dest.display()))
        }
        FilePath::Url(_url) => {
            let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
            let exports = app_dir.join("exports");
            std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
            let safe_name: String = filename.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect();
            let fallback = exports.join(if safe_name.is_empty() { "export.csv" } else { &safe_name });
            std::fs::write(&fallback, &content).map_err(|e| format!("寫入失敗: {}", e))?;
            log::info!("export_csv_dialog fallback to {:?}", fallback);
            Ok(format!("{}", fallback.display()))
        }
    }
}


/// D17: 唯一備份目的地——O_EXCL _atomic 建立，同名碰撞-forward 1µs 重試。
/// 純函式（零 AppHandle）便於單元測與獨立驗證；回傳 (已建立檔柄, 路徑)。
fn unique_backup_dest(backups_dir: &std::path::Path, ts_ns: u64) -> Result<(std::fs::File, std::path::PathBuf), String> {
    use std::os::unix::fs::OpenOptionsExt; // R1#1-M-2：.mode(0o600)
    let mut ts = ts_ns;
    for _ in 0..10_000u32 {
        let dest = backups_dir.join(format!("teno-{}.db", ts));
        // R1#1-M-2：備份含全量复习史，0600 預設（F11 write_private 同課；
        // 僅作用於新建路徑——O_EXCL 語意下 open 成功必為本呼叫獨創新檔）
        match std::fs::File::options().write(true).create_new(true).mode(0o600).open(&dest) {
            Ok(f) => return Ok((f, dest)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // 同 µs（極罕見）或手刻同名檔：前进 1µs 換名，絕不覆寫既有快照
                ts = ts.saturating_add(1_000);
            }
            Err(e) => return Err(format!("建立備份檔失敗: {}", e)),
        }
    }
    Err("建立備份檔失敗: 檔名連續碰撞超過 10000 次（目錄異常）".to_string())
}

#[tauri::command]
fn backup_db(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("teno.db");
    let backups_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| format!("建立備份目錄失敗: {}", e))?;
    // D17: 秒粒度命名 → 同秒第二次備份被 fs::copy 靜默截斷覆寫（按兩次按鈕＝
    // 列表少一條，快照幽靈消失）。改 nanos 命名＝既有 list/prune「nanos→secs」
    // 启发式（"old backups used nanoseconds"）原生支援的格式，名稱解析端零改動；
    // 再加 O_EXCL 獨佔建立兜底——名稱真撞＝換名重試，永不覆寫既有備份。
    // R1#1-M-1：as_nanos() 是 u128，裸 `as u64` 在 2554 年後截斷 wrap 成 ~0
    // →被解析成 1970 秒→prune 首端新備份先刪；.min 鉗位讓溢出場景退化為
    // 連撞 Err（響亮失敗）而非靜默 1970 排位。
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
        .min(u64::MAX as u128) as u64;
    let (mut dest_file, dest) = unique_backup_dest(&backups_dir, ts)?;
    log::info!("backup_db src={:?} dst={:?}", db_path, dest);
    let mut src = std::fs::File::open(&db_path).map_err(|e| format!("複製資料庫失敗: {}", e))?;
    std::io::copy(&mut src, &mut dest_file)
        .map_err(|e| { let _ = std::fs::remove_file(&dest); format!("複製資料庫失敗: {}", e) })?;
    log::info!("backup_db OK");
    Ok(format!("{}", dest.display()))
}

#[tauri::command]
fn prune_backups(app_handle: tauri::AppHandle, max_count: u32) -> Result<u32, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
    if !backups_dir.exists() { return Ok(0); }
    let mut entries: Vec<_> = std::fs::read_dir(&backups_dir).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".db"))
        .map(|e| (e.path(), e.file_name()))
        .collect();
    entries.sort_by_key(|(_, name)| {
        let name = name.to_string_lossy();
        let ts_str = name.strip_prefix("teno-").and_then(|s| s.strip_suffix(".db")).unwrap_or("0");
        let ts: u64 = ts_str.parse().unwrap_or(0);
        if ts > 100_000_000_000 { ts / 1_000_000_000 } else { ts }
    });
    let mut removed = 0;
    while entries.len() as u32 > max_count {
        if let Some((path, _)) = entries.first() {
            if std::fs::remove_file(path).is_ok() { removed += 1; }
        }
        entries.remove(0);
    }
    log::info!("prune_backups: removed={} remaining={}", removed, entries.len());
    Ok(removed)
}

#[tauri::command]
fn get_db_mtime(app_handle: tauri::AppHandle) -> Result<u64, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("teno.db");
    let metadata = std::fs::metadata(&db_path).map_err(|e| format!("讀取資料庫資訊失敗: {}", e))?;
    let mtime = metadata.modified().map_err(|e| format!("讀取修改時間失敗: {}", e))?;
    let duration = mtime.duration_since(std::time::UNIX_EPOCH).map_err(|e| format!("時間計算失敗: {}", e))?;
    Ok(duration.as_secs())
}

#[derive(serde::Serialize)]
struct BackupEntry {
    filename: String,
    timestamp: u64,
    size: u64,
    date: String,
}

#[tauri::command]
fn list_backups(app_handle: tauri::AppHandle) -> Result<Vec<BackupEntry>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
    if !backups_dir.exists() { return Ok(Vec::new()); }
    let mut entries: Vec<BackupEntry> = std::fs::read_dir(&backups_dir).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("teno-") && name.ends_with(".db")
        })
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let ts_str = name.strip_prefix("teno-")?.strip_suffix(".db")?;
            let ts: u64 = ts_str.parse().ok()?;
            // ponytail: old backups used nanoseconds, convert to seconds
            let ts_secs = if ts > 100_000_000_000 { ts / 1_000_000_000 } else { ts };
            let meta = e.metadata().ok()?;
            let size = meta.len();
            let date = chrono_or_manual(ts_secs);
            Some(BackupEntry { filename: name, timestamp: ts_secs, size, date })
        })
        .collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(entries)
}

fn chrono_or_manual(ts: u64) -> String {
    // Convert unix timestamp to readable date without chrono crate
    let secs = ts as i64;
    let mut days = secs / 86400;
    let mut y = 1970i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if days < days_in_year { break; }
        days -= days_in_year;
        y += 1;
    }
    let leap = is_leap(y);
    let mons = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    for (i, &md) in mons.iter().enumerate() {
        if days < md { m = i + 1; break; }
        days -= md;
    }
    let d = days + 1;
    let rem = secs % 86400;
    let h = rem / 3600;
    let min = (rem % 3600) / 60;
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, d, h, min)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[tauri::command]
fn restore_backup(app_handle: tauri::AppHandle, filename: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
    let safe_name = std::path::Path::new(&filename).file_name().ok_or("非法檔名")?.to_string_lossy().to_string();
    if safe_name == "." || safe_name == ".." { return Err("非法檔名".to_string()); }
    let src = backups_dir.join(&safe_name);
    let db_path = app_dir.join("teno.db");
    if !src.exists() {
        return Err(format!("備份檔案不存在: {}", safe_name));
    }
    log::info!("restore_backup src={:?} dst={:?}", src, db_path);
    // 防呆：確認來源是合法 SQLite（擋空檔/HTML/截斷下載）
    let head = std::fs::read(&src).map_err(|e| format!("讀取備份失敗: {}", e))?;
    if head.len() < 16 || &head[..16] != b"SQLite format 3\0" {
        return Err("備份檔案不是有效資料庫".to_string());
    }
    // 原子還原：先寫 tmp → 刪 WAL/SHM → rename（對齊 write_db_container 既有 pattern）
    let tmp = app_dir.join("teno.db.restore_tmp");
    std::fs::copy(&src, &tmp).map_err(|e| format!("還原失敗: {}", e))?;
    let wal = app_dir.join("teno.db-wal");
    let shm = app_dir.join("teno.db-shm");
    let _ = std::fs::remove_file(&wal);
    let _ = std::fs::remove_file(&shm);
    std::fs::rename(&tmp, &db_path).map_err(|e| format!("還原失敗: {}", e))?;
    log::info!("restore_backup OK");
    Ok(())
}

#[tauri::command]
fn delete_backup(app_handle: tauri::AppHandle, filename: String) -> Result<(), String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let backups_dir = app_dir.join("backups");
    let safe_name = std::path::Path::new(&filename).file_name().ok_or("非法檔名")?.to_string_lossy().to_string();
    if safe_name == "." || safe_name == ".." { return Err("非法檔名".to_string()); }
    let path = backups_dir.join(&safe_name);
    if !path.exists() {
        return Err(format!("備份檔案不存在: {}", safe_name));
    }
    std::fs::remove_file(&path).map_err(|e| format!("刪除備份失敗: {}", e))?;
    log::info!("delete_backup {:?}", path);
    Ok(())
}

#[tauri::command]
async fn export_db_data(app_handle: tauri::AppHandle, include_log: bool) -> Result<Vec<u8>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    pack_db_container(&app_dir, include_log)
}

#[tauri::command]
async fn export_backup_data(app_handle: tauri::AppHandle, filename: String) -> Result<Vec<u8>, String> {
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let safe_name = std::path::Path::new(&filename).file_name().ok_or("非法檔名")?.to_string_lossy().to_string();
    if safe_name == "." || safe_name == ".." { return Err("非法檔名".to_string()); }
    let src = app_dir.join("backups").join(&safe_name);
    std::fs::read(&src).map_err(|e| format!("讀取備份失敗: {}", e))
}

#[tauri::command]
async fn export_backup_dialog(app_handle: tauri::AppHandle, filename: String) -> Result<String, String> {
    use tokio::sync::oneshot;
    let (tx, rx) = oneshot::channel();
    app_handle.dialog()
        .file()
        .add_filter("SQLite Database", &["db"])
        .set_file_name(&filename)
        .save_file(move |file| { let _ = tx.send(file); });
    let file = rx.await.map_err(|_| "對話框錯誤".to_string())?
        .ok_or_else(|| {
            log::info!("export_backup_dialog cancelled");
            "使用者取消".to_string()
        })?;
    let app_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let safe_name = std::path::Path::new(&filename).file_name().ok_or("非法檔名")?.to_string_lossy().to_string();
    if safe_name == "." || safe_name == ".." { return Err("非法檔名".to_string()); }
    let src = app_dir.join("backups").join(&safe_name);
    match file {
        FilePath::Path(dest) => {
            log::info!("export_backup_dialog src={:?} dst={:?}", src, dest);
            std::fs::copy(&src, &dest).map_err(|e| { log::error!("export_backup_dialog copy fail: {}", e); format!("匯出失敗: {}", e) })?;
            log::info!("export_backup_dialog OK");
            Ok(format!("{}", dest.display()))
        }
        FilePath::Url(_url) => {
            let data = std::fs::read(&src)
                .map_err(|e| format!("讀取備份失敗: {}", e))?;
            let exports = app_dir.join("exports");
            std::fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
            let safe: String = safe_name.chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_').collect();
            let fallback = exports.join(if safe.is_empty() { "backup.db" } else { &safe });
            std::fs::write(&fallback, &data).map_err(|e| format!("寫入失敗: {}", e))?;
            log::info!("export_backup_dialog fallback to {:?}", fallback);
            Ok(format!("{}", fallback.display()))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create core tables",
            sql: "
                CREATE TABLE IF NOT EXISTS words (
                    id TEXT PRIMARY KEY,
                    word TEXT NOT NULL,
                    definition TEXT,
                    part_of_speech TEXT,
                    pronunciation TEXT,
                    example TEXT,
                    deck TEXT NOT NULL DEFAULT 'Default',
                    tags TEXT DEFAULT '',
                    image TEXT DEFAULT '',
                    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))   // E2: DEFAULT 硬化（fresh-install）
                );

                CREATE TABLE IF NOT EXISTS cards (
                    word_id TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
                    due TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    stability REAL NOT NULL DEFAULT 2.5,
                    difficulty REAL NOT NULL DEFAULT 0.0,
                    elapsed_days INTEGER NOT NULL DEFAULT 0,
                    scheduled_days INTEGER NOT NULL DEFAULT 0,
                    reps INTEGER NOT NULL DEFAULT 0,
                    lapses INTEGER NOT NULL DEFAULT 0,
                    state INTEGER NOT NULL DEFAULT 0,
                    last_review TEXT,
                    buried INTEGER NOT NULL DEFAULT 0,
                    suspended INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS decks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    color TEXT DEFAULT '#5e6ad2'
                );

                CREATE TABLE IF NOT EXISTS folders (
                    name TEXT PRIMARY KEY,
                    decks TEXT NOT NULL DEFAULT '[]'
                );

                CREATE TABLE IF NOT EXISTS additions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    word TEXT NOT NULL,
                    definition TEXT,
                    part_of_speech TEXT,
                    pronunciation TEXT,
                    examples TEXT,
                    deck TEXT NOT NULL DEFAULT 'Default',
                    added_at TEXT DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS edits (
                    word_id TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
                    data TEXT NOT NULL,
                    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );

                CREATE TABLE IF NOT EXISTS review_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
                    rating INTEGER NOT NULL,
                    elapsed_days INTEGER,
                    scheduled_days INTEGER,
                    stability REAL,
                    difficulty REAL,
                    reviewed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );

                CREATE TABLE IF NOT EXISTS exam_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    word TEXT NOT NULL,
                    correct INTEGER NOT NULL,
                    question_type TEXT,
                    examined_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS goal_streak (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    daily_goal INTEGER DEFAULT 20,
                    current INTEGER DEFAULT 0,
                    best INTEGER DEFAULT 0,
                    dates TEXT DEFAULT '[]'
                );

                INSERT OR IGNORE INTO goal_streak (id, daily_goal, current, best, dates) VALUES (1, 20, 0, 0, '[]');

                CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
                CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
                CREATE INDEX IF NOT EXISTS idx_words_deck ON words(deck);
                CREATE INDEX IF NOT EXISTS idx_review_log_word ON review_log(word_id);
                CREATE INDEX IF NOT EXISTS idx_review_log_time ON review_log(reviewed_at);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add learning step column to cards",
            sql: "ALTER TABLE cards ADD COLUMN step INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add duration column to review_log",
            sql: "ALTER TABLE review_log ADD COLUMN duration INTEGER;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add description column to words",
            sql: "ALTER TABLE words ADD COLUMN description TEXT DEFAULT '';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create filtered_decks table",
            sql: "
                CREATE TABLE IF NOT EXISTS filtered_decks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    search_query TEXT NOT NULL,
                    max_cards INTEGER DEFAULT 100,
                    order_by TEXT DEFAULT 'due',
                    color TEXT DEFAULT '#f59e0b',
                    created_at TEXT DEFAULT (datetime('now')),
                    last_used TEXT
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "add mc_data and spell_data columns to cards",
            sql: "
                ALTER TABLE cards ADD COLUMN mc_data TEXT;
                ALTER TABLE cards ADD COLUMN spell_data TEXT;
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add mode column to review_log",
            sql: "ALTER TABLE review_log ADD COLUMN mode TEXT NOT NULL DEFAULT 'flip';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add card_state column to review_log for revlog-based newRatedToday",
            sql: "ALTER TABLE review_log ADD COLUMN card_state INTEGER;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add related column to words (synonyms, similar, derivatives as JSON array)",
            sql: "ALTER TABLE words ADD COLUMN related TEXT DEFAULT '[]';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add forms column to words (inflections as JSON array)",
            sql: "ALTER TABLE words ADD COLUMN forms TEXT DEFAULT '[]';",
            kind: MigrationKind::Up,
        },
    ];

    // 隔離 DB: 操作日誌 + 模擬歷史 (不污染 teno.db 真實學習資料)
    let log_migrations = vec![
        Migration {
            version: 1,
            description: "create app_log and sim_runs tables",
            sql: "
                CREATE TABLE IF NOT EXISTS app_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    level TEXT NOT NULL DEFAULT 'log',
                    message TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_app_log_ts ON app_log(ts);
                CREATE TABLE IF NOT EXISTS sim_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    days INTEGER,
                    target_pct REAL,
                    seed INTEGER,
                    from_zero INTEGER DEFAULT 0,
                    total_reviews INTEGER,
                    mature_cards INTEGER,
                    mature_pct REAL,
                    summary TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_sim_runs_ts ON sim_runs(ts);
            ",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:teno.db", migrations)
                .add_migrations("sqlite:app-log.db", log_migrations)
                .build(),
        )
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tts_android::init())
        .plugin(icon_android::init())
        // ponytail: removed single-instance for dev builds
        .invoke_handler(tauri::generate_handler![log_msg, run_cli, get_app_paths, speak_text, fetch_llm, fetch_get, lookup_cambridge, list_piper_voices, scrape_quizlet, write_db_bytes, import_db_dialog, export_db_dialog, export_csv_dialog, export_db_data, export_backup_data, backup_db, prune_backups, get_db_mtime, list_backups, restore_backup, delete_backup, export_backup_dialog, import_piper_model_dialog, install_piper_model, delete_piper_model, tts_android::speak_android, tts_android::finish_app, optimize_fsrs, simulate_fsrs, tts_android::stop_android, tts_android::list_voices_android, tts_android::save_export_file, icon_android::set_launcher_icon, icon_android::get_launcher_icon, icon_android::reset_app_log, drive_sync::drive_save_creds, drive_sync::drive_oauth, drive_sync::drive_upload, drive_sync::drive_download, drive_sync::drive_status, drive_sync::drive_logout])
        .setup(|app| {
            #[cfg(not(target_os = "android"))]
            {
                // ponytail: prefer pulse/default (PipeWire/PulseAudio) over HDMI
                let stream_result = {
                    use cpal::traits::{HostTrait, DeviceTrait};
                    let host = cpal::default_host();
                    host.devices().ok().and_then(|ds| {
                        ds.into_iter().find(|d| {
                            let n = d.name().unwrap_or_default();
                            d.default_output_config().is_ok() && (
                                n.contains("pulse") || n.contains("PulseAudio") ||
                                n.contains("default")
                            )
                        })
                    }).or_else(|| {
                        host.devices().ok().and_then(|ds| {
                            ds.into_iter().find(|d| {
                                let n = d.name().unwrap_or_default();
                                d.default_output_config().is_ok() && (
                                    n.contains("Analog") || n.contains("ALC") || n.contains("audio")
                                )
                            })
                        })
                    })
                    .map(|d| rodio::OutputStream::try_from_device(&d))
                    .unwrap_or_else(|| rodio::OutputStream::try_default())
                };
                if let Ok((stream, handle)) = stream_result {
                    Box::leak(Box::new(stream));
                    app.manage(PiperAudio { handle });
                } else {
                    log::error!("無法初始化音訊輸出，TTS 將無法播放");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod container_tests {
    use super::*;

    #[test]
    fn container_roundtrip() {
        let app_dir = std::env::temp_dir().join("teno-container-test");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(app_dir.join("teno.db"), b"FAKE_TENO_DATA").unwrap();
        std::fs::write(app_dir.join("app-log.db"), b"FAKE_LOG_DATA").unwrap();

        // 含 log: round-trip
        let packed = pack_db_container(&app_dir, true).unwrap();
        assert!(packed.starts_with(CONTAINER_MAGIC));
        let (teno, log) = unpack_db_container(&packed).unwrap();
        assert_eq!(teno, b"FAKE_TENO_DATA");
        assert_eq!(log, b"FAKE_LOG_DATA");

        // 不含 log: log 段為空
        let packed2 = pack_db_container(&app_dir, false).unwrap();
        let (teno2, log2) = unpack_db_container(&packed2).unwrap();
        assert_eq!(teno2, b"FAKE_TENO_DATA");
        assert!(log2.is_empty());

        // 向後相容: 純 SQLite bytes 視為無 log
        let (t3, l3) = unpack_db_container(b"SQLite format 3\0RAW").unwrap();
        assert_eq!(t3, b"SQLite format 3\0RAW");
        assert!(l3.is_empty());

        // 非 SQLite 檔案: 拒絕 (避免覆寫現有 DB)
        assert!(unpack_db_container(b"RAW_DB_BYTES").is_err());
        // 損壞容器: 拒絕
        assert!(unpack_db_container(b"TENOC\x01\xff\xff\xff\xffBROKEN").is_err());
        // 截斷容器 (宣告長度 > 實際 bytes): 拒絕
        assert!(unpack_db_container(b"TENOC\x01\x10\x00\x00\x00ABCDEF").is_err());
        // 長度欄位不足: 拒絕
        assert!(unpack_db_container(b"TENOC\x01\x00").is_err());

        let _ = std::fs::remove_dir_all(&app_dir);
    }

    /// D16: 入口嚴格三守門（version 必為 1／log 欄必在／trailing 必拒）
    #[test]
    fn d16_container_strict_gates() {
        // 合法基準容器：magic+v1+[len 4][DBAA]+[len 0]
        let good: Vec<u8> = vec![b'T', b'E', b'N', b'O', b'C', 1,
            4, 0, 0, 0, b'D', b'B', b'A', b'A', 0, 0, 0, 0];
        assert_eq!(unpack_db_container(&good).unwrap(),
                   (b"DBAA".to_vec(), Vec::new()));

        // 守門 1：version byte 必斷（v0/v2/0xFF 全拒——舊碼讀而不斷全收）
        for v in [0u8, 2, 0xFF] {
            let mut bad = good.clone();
            bad[5] = v;
            let e = unpack_db_container(&bad);
            assert!(e.is_err(), "version={} 必須拒，實際 {:?}", v, e.map(|(t, l)| (t.len(), l.len())));
            assert!(e.unwrap_err().contains("版本不支援"));
        }
        // 守門 2：trailing garbage 必拒（舊碼靜默丟棄回 Ok）
        let mut trailing = good.clone();
        trailing.extend_from_slice(b"EXTRA_GARBAGE");
        let e = unpack_db_container(&trailing);
        assert!(e.as_ref().is_err_and(|m| m.contains("尾部")), "trailing 拒訊息應含『尾部』，實際 {:?}", e);
        // 守門 3：log 長度欄缺位＝截斷必拒（舊碼 if-let 靜默降級無 log 回 Ok）
        let no_log_field: Vec<u8> = vec![b'T', b'E', b'N', b'O', b'C', 1,
            4, 0, 0, 0, b'D', b'B', b'A', b'A'];
        let e = unpack_db_container(&no_log_field);
        assert!(e.as_ref().is_err_and(|m| m.contains("app-log")), "log 欄缺位拒訊息應含『app-log』，實際 {:?}", e);

        // 零誤殺：含 log 段完整容器照收；len=0 log 照收（good 已測）
        let with_log: Vec<u8> = vec![b'T', b'E', b'N', b'O', b'C', 1,
            4, 0, 0, 0, b'D', b'B', b'A', b'A', 3, 0, 0, 0, b'L', b'G', b'!'];
        assert_eq!(unpack_db_container(&with_log).unwrap(),
                   (b"DBAA".to_vec(), b"LG!".to_vec()));
        // raw SQLite fallback 分支不動（向後相容釘同 up 版）
        assert!(unpack_db_container(b"SQLite format 3\0tail-any").is_ok());
        // 非 SQLite 非容器仍拒
        assert!(unpack_db_container(b"TENOX garbage").is_err());
    }

    #[test]
    fn container_writes_both_dbs() {
        let app_dir = std::env::temp_dir().join("teno-container-write");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(app_dir.join("teno.db"), b"OLD_TENO").unwrap();
        std::fs::write(app_dir.join("app-log.db"), b"OLD_LOG").unwrap();

        write_db_container(&app_dir, b"NEW_TENO", b"NEW_LOG").unwrap();
        assert_eq!(std::fs::read(app_dir.join("teno.db")).unwrap(), b"NEW_TENO");
        assert_eq!(std::fs::read(app_dir.join("app-log.db")).unwrap(), b"NEW_LOG");

        // log 為空: 不覆寫 app-log.db
        write_db_container(&app_dir, b"NEW2", &[]).unwrap();
        assert_eq!(std::fs::read(app_dir.join("app-log.db")).unwrap(), b"NEW_LOG");

        let _ = std::fs::remove_dir_all(&app_dir);
    }
}

#[cfg(test)]
mod monitor_log_tests {
    use super::*;

    #[test]
    fn f14_monitor_log_symlink_guard() {
        let dir = std::env::temp_dir().join(format!("teno-f14-monitor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 正常路徑：雙附加順序保留
        {
            let mut f = open_monitor_log(&dir).expect("正常目錄必可開");
            std::io::Write::write_all(&mut f, b"L1\n").unwrap();
        }
        {
            let mut f = open_monitor_log(&dir).expect("附加模式重開必綠");
            std::io::Write::write_all(&mut f, b"L2\n").unwrap();
        }
        let p = dir.join("teno-monitor.log");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "L1\nL2\n");
        // 0600 私檔慣例（F11 同課）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // symlink 預植攻擊：舊碼 create+append 會追擊寫進受害者；新碼必回
        // None 且受害者零增寫
        let _ = std::fs::remove_file(&p);
        std::fs::write(dir.join("victim.txt"), b"PRISTINE").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("victim.txt"), &p).unwrap();
            assert!(open_monitor_log(&dir).is_none(), "symlink 目標必拒（ELOOP）");
            assert_eq!(std::fs::read(dir.join("victim.txt")).unwrap(), b"PRISTINE");
        }
        // 目錄不存在 → None 不 panic
        assert!(open_monitor_log(&dir.join("nope")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// D17: 同秒備份檔名碰撞——unique_backup_dest 永不覆寫既有快照
#[cfg(test)]
mod backup_naming_tests {
    use super::*;

    #[test]
    fn d17_same_ts_never_overwrites() {
        let dir = std::env::temp_dir().join("teno-d17-naming");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 同一 ts 三次（＝舊碼同秒三次全寫同一檔互相截斷覆寫）
        let ts: u64 = 1_786_230_000_123_456_789; // 真實 nanos 量級
        let mut names = vec![];
        for i in 0..3u8 {
            let (mut f, p) = unique_backup_dest(&dir, ts).unwrap();
            std::io::Write::write_all(&mut f, format!("SNAP{}", i).as_bytes()).unwrap();
            names.push(p.file_name().unwrap().to_string_lossy().to_string());
        }
        // 三檔獨立存在、名稱互異
        assert_eq!(names.len(), 3);
        let uniq: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(uniq.len(), 3, "名稱必兩兩相異，實際 {:?}", names);
        // 快照內容零覆寫：第一檔仍是 SNAP0（舊碼此處必為 SNAP2）
        let first = dir.join(&names[0]);
        assert_eq!(std::fs::read(&first).unwrap(), b"SNAP0");
        // nanos 名稱必過 list/prune 的 >1e11 換算启发式（解析契約釘）
        for n in &names {
            let tsv: u64 = n.strip_prefix("teno-").unwrap().strip_suffix(".db").unwrap().parse().unwrap();
            assert!(tsv > 100_000_000_000, "nanos 名稱必 >1e11 走秒換算分支，實際 {}", tsv);
            let secs = tsv / 1_000_000_000;
            assert!(secs > 1_700_000_000 && secs < 4_000_000_000, "換算後必為合理秒級 epoch，實際 {}", secs);
        }
        // 手刻同名檔（攻擊/殘留）→ 跳名不覆寫
        std::fs::write(dir.join("teno-999999999999999999.db"), b"PRECIOUS").unwrap();
        let (_, p) = unique_backup_dest(&dir, 999999999999999999).unwrap();
        assert_ne!(p.file_name().unwrap().to_string_lossy(), "teno-999999999999999999.db");
        assert_eq!(std::fs::read(dir.join("teno-999999999999999999.db")).unwrap(), b"PRECIOUS");
        // R1#1-M-2：新建備份權限必 0600（F11 同課，備份含全量复习史）
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&first).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "備份檔權限必 0600，實際 {:o}", mode);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod sim_tests {
    use super::*;
    use chrono::Datelike;

    fn load_req(path: &str) -> SimulateFsrsRequest {
        let data = std::fs::read_to_string(path).unwrap();
        serde_json::from_str(&data).unwrap()
    }

    #[test]
    fn simulate_all_modes_from_real_db() {
        for mode in ["flip", "mc", "spell"] {
            let req = load_req(&format!("/tmp/sim-req-{}.json", mode));
            let resp = simulate_fsrs(req).expect("simulate failed");
            assert_eq!(resp.memorized_per_day.len(), 30, "{} days", mode);
            assert_eq!(resp.review_per_day.len(), 30, "{} days", mode);
            assert_eq!(resp.learn_per_day.len(), 30, "{} days", mode);
            assert_eq!(resp.cost_per_day.len(), 30, "{} days", mode);
            // memorized 是 ΣR（浮點）, 不是整數卡數
            let last = resp.memorized_per_day[29];
            println!("[{}] final memorized={:.1} reviews={} learn={} cost={:.0}", mode, last,
                resp.review_per_day.iter().sum::<u32>(), resp.learn_per_day.iter().sum::<u32>(),
                resp.cost_per_day.iter().sum::<f32>());
            assert!(last > 0.0, "{} 應有記憶量", mode);
        }
    }

    #[test]
    fn workload_matches_anki_semantics() {
        let req = load_req("/tmp/sim-req-workload.json");
        let resp = simulate_fsrs(req).expect("workload failed");
        assert_eq!(resp.drs.len(), 30, "70~99 共 30 組");
        // DR 越高 cost 越高（單調趨勢允許小波動, 但整體應上升）
        let cost70 = resp.drs[0].cost;
        let cost99 = resp.drs[29].cost;
        println!("cost70={:.0} cost99={:.0} reviewless={:.1}", cost70, cost99, resp.reviewless_end_memorized);
        assert!(cost99 > cost70, "DR 99 成本應高於 DR 70 (got {} vs {})", cost99, cost70);
        assert!(resp.reviewless_end_memorized >= 0.0);
        // review_count 含 learn（對齊 Anki simulator.rs:306-307）
        let first = &resp.drs[0];
        println!("dr70: memorized={:.1} cost={:.0} review_count={}", first.memorized, first.cost, first.review_count);
        assert!(first.review_count > 0);
    }

    #[test]
    fn optimal_retention_returns_reasonable_value() {
        let req = load_req("/tmp/sim-req-optimal.json");
        let resp = simulate_fsrs(req).expect("optimal failed");
        let dr = resp.optimal_retention.expect("應有最佳留存率");
        println!("optimal retention = {:.4} ({}%)", dr, dr * 100.0);
        assert!(dr >= 0.7 && dr <= 0.99, "最佳留存率應在 70~99% 之間 (got {})", dr);
    }

    // ─── Load Balancer / Easy Days 對齊 Anki fuzz.rs + load_balancer.rs ───

    #[test]
    fn fuzz_bounds_match_anki() {
        // fuzz.rs 測試同款數學: delta = 1 + Σ factor*((interval.min(end)-start).max(0))
        assert_eq!(fuzz_delta(2.0), 0.0);                       // < 2.5 不 fuzz
        assert_eq!(fuzz_bounds(5.0), (4, 6));                   // 1+0.15*(5-2.5)=1.375 → 4/6
        assert_eq!(fuzz_bounds(10.0), (8, 12));                 // 1+0.675+0.1*3=1.975 → 8/12
        assert_eq!(fuzz_bounds(25.0), (22, 28));                // 1+0.675+1.3+0.05*5=3.225 → 22/28
        assert_eq!(fuzz_bounds(100.0), (93, 107));              // +0.05*80 → 6.975 → 93/107
        // constrained: min/max clamp（interval 先 clamp 再 fuzz → 5→4 → fuzz(4)=(3,5) → (3,4)）
        assert_eq!(constrained_fuzz_bounds(5.0, 1, 4), (3, 4));
        assert_eq!(constrained_fuzz_bounds(1.0, 1, 36500), (1, 1)); // interval<2.5 → (1,1)
        assert_eq!(constrained_fuzz_bounds(5.0, 1, 5), (4, 5)); // upper==lower 且 <maximum → +1
    }

    #[test]
    fn easy_days_parsing_matches_anki() {
        // parse_easy_days_percentages: 1.0=Normal, 0.0=Minimum, 其他=Reduced
        assert_eq!(parse_easy_days_percentages(&[]), [EasyDay::Normal; 7]);
        assert_eq!(parse_easy_days_percentages(&[1.0; 7]), [EasyDay::Normal; 7]);
        let p = parse_easy_days_percentages(&[0.0, 0.5, 1.0, 0.0, 0.5, 1.0, 1.0]);
        assert_eq!(
            p,
            [
                EasyDay::Minimum, EasyDay::Reduced, EasyDay::Normal,
                EasyDay::Minimum, EasyDay::Reduced, EasyDay::Normal, EasyDay::Normal,
            ]
        );
        assert_eq!(EasyDay::Minimum.load_modifier(), 0.0001);
        assert_eq!(EasyDay::Reduced.load_modifier(), 0.5);
        assert_eq!(EasyDay::Normal.load_modifier(), 1.0);
    }

    #[test]
    fn load_balance_stays_within_fuzz_bounds() {
        // apply_load_balance_and_easy_days 選出的 interval 必須落在 fuzz bounds 內
        let easy = [EasyDay::Normal; 7];
        for &ivl in &[2.0f32, 5.0, 10.0, 25.0, 100.0, 365.0] {
            let (lower, upper) = constrained_fuzz_bounds(ivl, 1, 36500);
            let due = vec![0usize; 400];
            let out = apply_load_balance_and_easy_days(ivl, 36500.0, 100, &due, 42, 1760000000, 28800, &easy);
            assert!(out >= lower as f32 && out <= upper as f32,
                "interval {} → {} 超出 fuzz bounds ({},{})", ivl, out, lower, upper);
        }
    }

    #[test]
    fn easy_day_minimum_gets_zero_weight() {
        // 週日設 Minimum → 落在週日的 interval 權重極低 → 大量抽樣不該選到週日
        // 用 2026-08-13（四）當地 00:00 當 next_day_at，讓 interval 3..5 涵蓋週日
        let mut easy = [EasyDay::Normal; 7];
        easy[6] = EasyDay::Minimum; // 週日 Minimum
        let tz = 28800; // UTC+8
        // 2026-08-13 00:00 UTC+8 = 2026-08-12 16:00 UTC
        let next_day_at = 1786406400 + 2 * 86400 - tz; // 1786550400
        // due 非零（review_count>0 才會乘 easy_days_modifier；day_elapsed=0 → 對應 due[3..6]）
        let mut due = vec![0usize; 30];
        due[3] = 5;
        due[4] = 5;
        due[5] = 5;
        let mut hit_sunday = 0;
        let total = 200;
        for seed in 0..total {
            let out = apply_load_balance_and_easy_days(4.0, 36500.0, 0, &due, seed, next_day_at, tz, &easy);
            let local = next_day_at + (out as i64 - 1) * 86400 + tz;
            let wd = chrono::DateTime::from_timestamp(local, 0).unwrap().weekday().num_days_from_monday() as usize;
            if wd == 6 { hit_sunday += 1; }
        }
        println!("hit_sunday={}/{}", hit_sunday, total);
        assert!(hit_sunday <= total / 50, "週日 Minimum 幾乎不該被選到 ({}%)", hit_sunday * 100 / total);
    }
}

#[cfg(test)]
mod fetch_tests {
    use super::*;

    #[test]
    fn fetch_get_url_whitelist() {
        // https 一律允許
        assert!(check_fetch_get_url("https://example.com/api/tags").is_ok());
        assert!(check_fetch_get_url("https://api.openai.com/v1/chat").is_ok());
        // http 僅限本機 host
        assert!(check_fetch_get_url("http://localhost:11434/api/tags").is_ok());
        assert!(check_fetch_get_url("http://127.0.0.1:11434/api/tags").is_ok());
        assert!(check_fetch_get_url("http://[::1]:11434/api/tags").is_ok());
        assert!(check_fetch_get_url("http://[0:0:0:0:0:0:0:1]:11434/api/tags").is_ok()); // ::1 長寫法亦歸一
        // 大小寫不敏感（url crate 正規化 scheme/host）
        assert!(check_fetch_get_url("HTTP://LOCALHOST:11434/api/tags").is_ok());
        // 其餘 http 拒絕
        assert!(check_fetch_get_url("http://example.com/api/tags").is_err());
        assert!(check_fetch_get_url("http://192.168.1.5:11434/api/tags").is_err());
        // 非 http/https scheme 拒絕
        assert!(check_fetch_get_url("ftp://example.com/file").is_err());
        // 偽 scheme（"localhost" 為合法 RFC 3986 scheme）→ 落 _ 分支拒絕
        assert!(check_fetch_get_url("localhost:11434/api/tags").is_err());
    }
}

// F9: parse_piper_url 測試 — 目錄/檔案/短網域/尾斜杠/深度守門
#[cfg(test)]
mod piper_url_tests {
    use super::parse_piper_url;

    const RYAN: (&str, &str) = ("en/en_US/ryan/high", "en_US-ryan-high");

    fn ok(url: &str) -> (String, String) {
        parse_piper_url(url).unwrap()
    }

    #[test]
    fn dir_tree_canonical_matches_ui_hint() {
        // UI hint 原例（settings.js）
        assert_eq!(ok("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn dir_trailing_slash_same_as_canonical() {
        assert_eq!(ok("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high/"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn dir_inner_double_slashes_filtered() {
        assert_eq!(ok("https://huggingface.co//rhasspy//piper-voices/tree//main/en//en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn dir_voice_level_rejected_with_guidance() {
        // 深度不足（voice 層）→ 明確錯誤，不瞎拼 high
        let e = parse_piper_url("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan").unwrap_err();
        assert!(e.contains("high"), "錯誤訊息應示範品質目錄: {}", e);
    }

    #[test]
    fn dir_locale_level_rejected() {
        assert!(parse_piper_url("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US").is_err());
    }

    #[test]
    fn repo_root_rejected() {
        assert!(parse_piper_url("https://huggingface.co/rhasspy/piper-voices/tree/main").is_err());
    }

    #[test]
    fn resolve_file_url() {
        assert_eq!(ok("https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn blob_file_url() {
        assert_eq!(ok("https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ryan/high/en_US-ryan-high.onnx"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn hf_co_bare_host() {
        assert_eq!(ok("hf.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn hf_co_with_https_scheme() {
        // 舊 trim 鏈三條全不中 → segments[0]="https:" 垃圾座標（RC3）
        assert_eq!(ok("https://hf.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn other_locale_zh() {
        assert_eq!(ok("https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium"),
                   ("zh/zh_CN/huayan/medium".into(), "zh_CN-huayan-medium".into()));
    }

    #[test]
    fn deeper_nesting_uses_tail_three() {
        // R1#2 M4 盲區補釘：尾導向取名（固定 index get(1..3) 變體在此紅）
        assert_eq!(ok("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high/fake5"),
                   ("en/en_US/ryan/high/fake5".into(), "ryan-high-fake5".into()));
    }

    #[test]
    fn empty_and_garbage_rejected() {
        assert!(parse_piper_url("").is_err());
        assert!(parse_piper_url("   ").is_err());
        assert!(parse_piper_url("https://huggingface.co/").is_err());
    }

    // R1#3 阻斷返修釘：多字節字符開頭（「帮我安装 <url>」粘貼法）曾裸切片 PANIC
    // v1.0 修復只做到不 panic（.get()），拒斥語意未落地（前首相預算中斷）；
    // 現行＝非 ASCII 起頭守門明確拒絕。
    #[test]
    fn multibyte_prefix_no_panic() {
        // 修復前這三條全部 panic（byte index is not a char boundary）
        assert!(parse_piper_url("帮我安装 https://hf.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high").is_err());
        assert!(parse_piper_url("你好https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high").is_err());
        assert!(parse_piper_url("日本語abcdefg").is_err());
        // 勘誤（本首相實錘 rustc）：前版註解宣稱「trim 不剥 U+3000」不實——
        // Rust str::trim 依 Unicode White_Space 屬性**會**剝 U+3000（实测
        // "　https://hf.co/a/b".trim() == "https://hf.co/a/b"）。
        // 故全角空格前綴＝前後空白正常的合法網址，应解析成功（誠實釘真實行為）。
        assert_eq!(
            ok("　https://hf.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
            (RYAN.0.into(), RYAN.1.into()));
    }

    // F12: ?download=true 查詢尾（HF「下載檔案」按鈕複製即得）與 #fragment 須同解
    #[test]
    fn download_button_query_tail_stripped() {
        assert_eq!(
            ok("https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx?download=true"),
            (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn query_and_fragment_stripped_on_dir_urls() {
        assert_eq!(
            ok("https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high?foo=1#files"),
            (RYAN.0.into(), RYAN.1.into()));
    }

    // F12: 大寫網域（舊 trim_start_matches 大小寫敏感 → 段位移 404）
    #[test]
    fn uppercase_host_accepted() {
        assert_eq!(ok("HTTPS://HUGGINGFACE.CO/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
        assert_eq!(ok("https://HF.CO/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
        assert_eq!(ok("https://Www.HuggingFace.Co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high"),
                   (RYAN.0.into(), RYAN.1.into()));
    }

    #[test]
    fn uppercase_host_with_query_and_slash() {
        assert_eq!(
            ok("HTTPS://HF.CO/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx?download=true/"),
            (RYAN.0.into(), RYAN.1.into()));
    }

    // F12: 前綴鏈邊界安全 — 只剝leading edge、單遍掃描，段中後段前綴字樣不觸發
    #[test]
    fn prefix_only_strips_leading_edge() {
        let r = parse_piper_url("https://huggingface.co/owner/huggingface.co/tree/main/en/en_US/ryan/high").unwrap();
        // host 剝落一次後 rest 以 owner 段開始，段中 "huggingface.co/" 永不觸發
        assert_eq!(r.0, "en/en_US/ryan/high");
        assert_eq!(r.1, "en_US-ryan-high");
    }

    #[test]
    fn owner_named_hfco_equivalence_with_old_chain() {
        // owner 段恰為 "hf.co"：新前綴鏈與舊 trim 鏈**同款雙剝**（hf.co/ 排鏈尾，
        // 舊 trim_start_matches 對剝後 rest 再剝一次）→ 深度守門 Err。
        // 等價性釘：新舊行為逐字同，非 F12 引入之變。
        assert!(parse_piper_url("https://huggingface.co/hf.co/piper-voices/tree/main/en/en_US/ryan/high").is_err());
    }

    #[test]
    fn non_hf_host_lenient_pinning() {
        // 登記性釘（網域白名單屬 F9 §6 範圍外未做）：非 HF 網域現行寬容解析＝段位移
        // 垃圾路徑，由下載端 404 拒收（F12 後 404=Err+零落盤，中毒鏈已閉）。
        // 此釘記錄現況；未來若做白名單，本釘紅即預期升版訊號。
        let r = parse_piper_url("https://evil.example.com/rhasspy/piper-voices/tree/main/en/en_US/ryan/high").unwrap();
        assert_eq!(r.0, "main/en/en_US/ryan/high");
        assert_eq!(r.1, "en_US-ryan-high");
    }
}

// F10: bug 機制釘 — Android SAF 回 FilePath::Url，舊碼 as_path() 抽取恆 None 必敗
// （語意源頭 tauri-plugin-fs file_path.rs::as_path/into_path，宿主即可實證）
#[cfg(test)]
mod import_piper_path_tests {
    use tauri_plugin_dialog::FilePath;

    #[test]
    fn url_variant_as_path_is_always_none() {
        let u = url::Url::parse(
            "content://com.android.externalstorage.documents/document/primary%3AModels%2Fen_US-ryan-high.onnx",
        )
        .unwrap();
        // 舊碼 file.as_path().ok_or("無效路徑")? 對這一行必然 Err
        assert!(FilePath::Url(u).as_path().is_none());
    }

    #[test]
    fn content_uri_into_path_also_fails() {
        // into_path() 內部走 Url::to_file_path()，content:// 非 file scheme 同樣失敗
        // ——佐證 android 分支必須走 copy_uri_to_cache 落地而非標準轉換
        let u = url::Url::parse("content://media/external/file/123").unwrap();
        assert!(FilePath::Url(u).into_path().is_err());
    }

    #[test]
    fn path_variant_exposes_path() {
        let p = std::path::PathBuf::from("/storage/emulated/0/Models/voice.onnx");
        assert_eq!(FilePath::Path(p.clone()).as_path(), Some(p.as_path()));
    }
}
