fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-lib=c++_shared");
    }
    // F11-SR1: option_env! 注入，顯式宣告 env 敏感性（cargo 官方建議，dep-info env-dep 本已自動追蹤）
    println!("cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_SECRET");
}
