// WEB-SERVE1：網站版伺服器入口（cargo run --features web --bin teno-server）。
// 用法:
//   teno-server serve [--port 8788] [--data DIR] [--dist ./dist] [--no-register]
//   teno-server adduser <name> [--data DIR]   # 密碼從 stdin 讀（避免 argv 留在 ps）
//   --data 預設 ~/teno-web-data（永久資料；沒有 HOME 時退回 ./data）
//   註冊預設開；--no-register 關（只剩 adduser 建號）
use teno_lib::web::WebCfg;

fn flag(args: &[String], name: &str, default: &str) -> String {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| default.to_string())
}

fn default_data() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    if home.is_empty() {
        "data".to_string()
    } else {
        format!("{home}/teno-web-data")
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("adduser") => {
            let Some(name) = args.get(1).filter(|s| !s.starts_with("--")) else {
                eprintln!("用法: teno-server adduser <name> [--data DIR]");
                std::process::exit(2);
            };
            if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                eprintln!("帳號僅限 ASCII 字母數字 _ -");
                std::process::exit(2);
            }
            let data = std::path::PathBuf::from(flag(&args, "--data", &default_data()));
            if let Err(e) = std::fs::create_dir_all(&data) {
                eprintln!("建立資料目錄失敗: {e}");
                std::process::exit(1);
            }
            let mut pw = String::new();
            eprint!("密碼: ");
            use std::io::Write;
            let _ = std::io::stdout().flush();
            if std::io::stdin().read_line(&mut pw).is_err() {
                eprintln!("讀密碼失敗");
                std::process::exit(1);
            }
            let pw = pw.trim_end_matches(['\r', '\n']);
            if pw.len() < 8 {
                eprintln!("密碼至少 8 碼");
                std::process::exit(2);
            }
            let mut users = teno_lib::web::auth::load_users(&data).expect("users.json 讀取失敗");
            if users.0.contains_key(name.as_str()) {
                eprintln!("帳號已存在: {name}");
                std::process::exit(1);
            }
            let hash = teno_lib::web::auth::hash_password(pw).expect("雜湊失敗");
            users.0.insert(name.clone(), hash);
            teno_lib::web::auth::save_users(&data, &users).expect("users.json 寫入失敗");
            println!("已建立帳號 {name}（資料根目錄 {}）", data.display());
        }
        Some("serve") | None => {
            let port: u16 = flag(&args, "--port", &std::env::var("TENO_WEB_PORT").unwrap_or_else(|_| "8788".into()))
                .parse()
                .expect("--port 需為數字");
            let cfg = WebCfg {
                port,
                data_dir: std::path::PathBuf::from(flag(&args, "--data", &default_data())),
                dist_dir: std::path::PathBuf::from(flag(&args, "--dist", "dist")),
                allow_register: !args.iter().any(|a| a == "--no-register"),
            };
            if let Err(e) = teno_lib::web::run(cfg).await {
                eprintln!("[web] {e}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("用法: teno-server [serve [--port N] [--data DIR] [--dist DIR]] | adduser <name>");
            std::process::exit(2);
        }
    }
}
