// F12 整合測試：download_url_to_file（teno_lib 公開面）
// 网络腿以 TENO_NET_TEST=1 閘控——無網路/CI 環境跳過不紅（429/斷網波次教訓：
// 測試基建不可把網絡設為強依賴）。tools/verify-f12-curl-to-ureq.mjs 負責帶閘實跑。
use std::path::PathBuf;

fn net_enabled() -> bool {
    std::env::var("TENO_NET_TEST").is_ok()
}

fn tmp_dest(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("f12dl-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 真 HF 鏈：resolve → 302 → cdn-lfs（ureq 預設追跳），拿最小 sidecar json（~KB 級）
#[test]
fn hf_resolve_redirect_streams_small_json() {
    if !net_enabled() { eprintln!("SKIP: TENO_NET_TEST unset"); return; }
    let dir = tmp_dest("ok");
    let dest = dir.join("en_US-lessac-low.onnx.json");
    teno_lib::download_url_to_file(
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/en_US-lessac-low.onnx.json",
        &dest, 30,
    ).expect("HF json 下載應成功");
    let txt = std::fs::read_to_string(&dest).unwrap();
    let v: serde_json::Value = serde_json::from_str(&txt).expect("合法 JSON（非錯誤頁）");
    assert!(v.get("audio").is_some(), "piper config 應含 audio 鍵，實際: {}", &txt[..txt.len().min(120)]);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 中毒鏈根治釘：404 → Err 且目標檔零生成（舊 curl 無 -f 時 exit 0＋錯誤頁存檔）
#[test]
fn http_404_errs_and_never_creates_file() {
    if !net_enabled() { eprintln!("SKIP: TENO_NET_TEST unset"); return; }
    let dir = tmp_dest("404");
    let dest = dir.join("ghost-model.onnx");
    let r = teno_lib::download_url_to_file(
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ghost-voice-xyz/low/en_US-ghost-voice-xyz-low.onnx",
        &dest, 30,
    );
    assert!(r.is_err(), "404 必須 Err，實際 Ok");
    assert!(!dest.exists(), "404 後目標檔必須零生成（中毒鏈根治），實際存在");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 下載中斷（Content-Length 5000 但只發 10B 即斷線）→ Err ＋ 半成品零殘留。
/// R1#1 次要#2 採納：本地迴環 TcpListener，**免 TENO_NET_TEST 閘**（非外網，
/// CI/斷網可跑）——補上『io::copy 中斷 → remove_file』此前僅有結構釘的行為腿。
#[test]
fn truncated_body_removes_partial_file() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().unwrap();
    let h = std::thread::spawn(move || {
        // 一回調：謊稱 5000 bytes，只寫 10 個就關連線（連線中斷徵狀）
        if let Ok((mut stream, _)) = listener.accept() {
            use std::io::Write;
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n0123456789");
            let _ = stream.flush();
            std::thread::sleep(std::time::Duration::from_millis(50));
            drop(stream); // 觸發 EOF/斷線
        }
    });
    let dir = tmp_dest("trunc");
    let dest = dir.join("partial.onnx");
    let r = teno_lib::download_url_to_file(
        &format!("http://{}/x", addr), &dest, 10);
    assert!(r.is_err(), "中斷下載必須 Err，實際 Ok");
    assert!(!dest.exists(), "中斷後半成品必須零殘留（remove_file 腿），實際存在");
    let _ = h.join();
    let _ = std::fs::remove_dir_all(&dir);
}

/// 非 HTTPS/垃圾 URL → Err 且不建檔
#[test]
fn bogus_url_errs_without_file() {
    let dir = tmp_dest("bogus");
    let dest = dir.join("x.onnx");
    assert!(teno_lib::download_url_to_file("not-a-url", &dest, 5).is_err());
    assert!(!dest.exists());
    let _ = std::fs::remove_dir_all(&dir);
}
