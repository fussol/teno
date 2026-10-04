// ═════════════════0═══════════════════════════════════════════
// WEB-SERVE1：網站版伺服器（唯讀本檔群，桌面/Android 不編譯）。
// 一份 code 兩個出口：前端 isTauri=false 走這裡的 /api/invoke。
// 資料隔離：data/users/<user>/ 自成一顆庫，與桌面 ~/.config/com.teno.app 永不相交。
// 同步語意：只有使用者主動按（匯出/匯入/WebDAV/Drive），無自動同步。
// ══════════════════════════════════════════════════════════════
use axum::{
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tower_http::services::{ServeDir, ServeFile};

pub mod auth;
mod invoke;
pub mod sql;

#[derive(Clone)]
pub struct AppState {
    pub data_dir: Arc<PathBuf>,
    pub users: Arc<Mutex<auth::Users>>,
    pub sessions: Arc<RwLock<HashMap<String, auth::Session>>>,
    pub sql: sql::SharedSql,
    pub allow_register: bool,
}

pub struct WebCfg {
    pub port: u16,
    pub data_dir: PathBuf,
    pub dist_dir: PathBuf,
    pub allow_register: bool,
}

pub async fn run(cfg: WebCfg) -> Result<(), String> {
    std::fs::create_dir_all(&cfg.data_dir)
        .map_err(|e| format!("建立資料目錄失敗 {}: {}", cfg.data_dir.display(), e))?;
    let users = auth::load_users(&cfg.data_dir)?;
    let sessions = auth::load_sessions(&cfg.data_dir);
    let state = AppState {
        data_dir: Arc::new(cfg.data_dir.clone()),
        users: Arc::new(Mutex::new(users)),
        sessions: Arc::new(RwLock::new(sessions)),
        sql: Arc::new(sql::SqlState::default()),
        allow_register: cfg.allow_register,
    };

    // 認證後區域：/api/invoke/* ＋ /api/sql/*
    let guarded = Router::new()
        .route("/api/invoke/{cmd}", post(invoke::handler))
        .route("/api/sql/select", post(sql::select))
        .route("/api/sql/execute", post(sql::execute))
        .route("/api/sql/close", post(sql::close))
        .layer(middleware::from_fn_with_state(state.clone(), auth::require_auth));

    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/login", post(auth::login))
        .route("/api/register", post(auth::register))
        .route("/api/logout", post(auth::logout))
        .route("/api/whoami", get(auth::whoami))
        .merge(guarded)
        .with_state(state)
        .fallback_service(
            ServeDir::new(&cfg.dist_dir)
                .fallback(ServeFile::new(cfg.dist_dir.join("index.html"))),
        );

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("監聽 {} 失敗: {}", addr, e))?;
    eprintln!("[web] teno-server 啟動 http://{} (dist={}, data={})",
        addr, cfg.dist_dir.display(), cfg.data_dir.display());
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("伺服器錯誤: {}", e))
}

// 統一錯誤出口：非 200 一律 {"error": msg} → 前端 fetch wrapper 直接 throw msg 字串
// （契約對齊 Tauri invoke 的 reject(字串)，前端 catch(e) 全吃字串）。
pub fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}
