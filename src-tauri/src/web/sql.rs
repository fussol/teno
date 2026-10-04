// WEB-SERVE1：/api/sql — 對齊 @tauri-apps/plugin-sql 的執行語意（行為零漂移）。
//  - bind：複製 plugin wrapper sqlite 臂（null→NULL、string→TEXT、number→f64、其餘→serde_json 編碼）
//  - decode：複製 plugin decode/sqlite（TEXT/REAL/INTEGER→JSON、BLOB→數字陣列…）
//  - migrator：sqlx Migrator 同源（Migration::new = SHA-384 checksum，與桌面同一套 _sqlx_migrations）
//  - 每用戶 data/users/<user>/ 各自一顆庫；pool 首開即跑 preensure＋migrations（每進程一次）
//  - ponytail: pool 快取按檔無限長 → 單機數十用戶夠用；要收合再改 LRU
use super::{err, AppState};
use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Extension;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::{Column, Executor, Row};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct SqlState {
    // key: 絕對 db 路徑；value: pool（含已遷移保證：進 pool 即已跑 preensure＋migrations）
    pools: Mutex<HashMap<String, SqlitePool>>,
}

#[derive(Deserialize)]
pub struct SqlReq {
    pub db: String,     // 'sqlite:teno.db'（plugin-sql 原樣 url）
    pub query: String,
    #[serde(default)]
    pub values: Vec<JsonValue>,
}

// db url → 該用戶目錄下絕對檔名（白名單：杜绝 path 逃逸）
fn db_path(user_dir: &std::path::Path, db: &str) -> Result<PathBuf, String> {
    let name = db
        .strip_prefix("sqlite:")
        .ok_or_else(|| format!("只支援 sqlite: url：{db}"))?;
    if name.contains('/') || name.contains('\\') || name.contains("..")
        || !name.ends_with(".db")
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!("非法資料庫名：{name}"));
    }
    Ok(user_dir.join(name))
}

async fn open_pool(abs: &str, user_dir: &std::path::Path, db_name: &str) -> Result<SqlitePool, String> {
    let opts: SqliteConnectOptions = format!("sqlite:{abs}?mode=rwc")
        .parse()
        .map_err(|e| format!("連線字串錯誤: {e}"))?;
    let opts = opts.create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(10) // 與 plugin-sql sqlx 預設同值（JS 端 workaround 依此假設）
        .connect_with(opts)
        .await
        .map_err(|e| format!("DB 開啟失敗: {e}"))?;

    // 桌面啟動序：preensure（修舊庫斷點）→ sqlx migrator；網站版同序同碼
    if db_name == "teno.db" {
        crate::preensure_upgrade_columns(user_dir);
        run_migrations(&pool, crate::teno_db_migrations()).await?;
    } else if db_name == "app-log.db" {
        run_migrations(&pool, crate::app_log_db_migrations()).await?;
    }
    // 其他 .db：與桌面同語意 — 沒註冊 migration 的 url 就是裸開
    Ok(pool)
}

async fn run_migrations(pool: &SqlitePool, migs: Vec<tauri_plugin_sql::Migration>) -> Result<(), String> {
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use std::borrow::Cow;
    let list: Vec<SqlxMigration> = migs
        .into_iter()
        .filter(|m| matches!(m.kind, tauri_plugin_sql::MigrationKind::Up))
        .map(|m| SqlxMigration::new(m.version, m.description.into(), m.kind.into(), m.sql.into(), false))
        .collect();
    let migrator = Migrator { migrations: Cow::Owned(list), ..Migrator::DEFAULT };
    migrator.run(pool).await.map_err(|e| format!("migration 失敗: {e}"))?;
    Ok(())
}

// 每請求：取（或建）該用戶該庫的 pool
async fn pool_for(
    st: &AppState,
    user: &str,
    db: &str,
) -> Result<SqlitePool, String> {
    let user_dir = st.data_dir.join("users").join(user);
    let abs_path = db_path(&user_dir, db)?;
    let abs = abs_path.to_string_lossy().to_string();
    // fast path
    if let Some(p) = st.sql.pools.lock().unwrap().get(&abs) {
        return Ok(p.clone());
    }
    std::fs::create_dir_all(&user_dir).map_err(|e| format!("建立用戶目錄失敗: {e}"))?;
    let name = abs_path.file_name().unwrap().to_string_lossy().to_string();
    let pool = open_pool(&abs, &user_dir, &name).await?;
    st.sql.pools.lock().unwrap().insert(abs, pool.clone());
    Ok(pool)
}

// ─── bind/decode：與 plugin-sql wrapper.rs、decode/sqlite.rs 同語意 ───
fn bind<'a>(
    mut q: sqlx::query::Query<'a, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'a>>,
    values: Vec<JsonValue>,
) -> sqlx::query::Query<'a, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'a>> {
    for value in values {
        if value.is_null() {
            q = q.bind(None::<JsonValue>);
        } else if value.is_string() {
            q = q.bind(value.as_str().unwrap().to_owned());
        } else if let Some(number) = value.as_number() {
            q = q.bind(number.as_f64().unwrap_or_default());
        } else {
            q = q.bind(value);
        }
    }
    q
}

fn decode(v: sqlx::sqlite::SqliteValueRef<'_>) -> Result<JsonValue, String> {
    use sqlx::{TypeInfo, Value, ValueRef};
    if v.is_null() {
        return Ok(JsonValue::Null);
    }
    let val = match v.type_info().name() {
        "TEXT" => match v.to_owned().try_decode::<String>() {
            Ok(s) => JsonValue::String(s),
            Err(_) => JsonValue::Null,
        },
        "REAL" => match v.to_owned().try_decode::<f64>() {
            Ok(f) => JsonValue::from(f),
            Err(_) => JsonValue::Null,
        },
        "INTEGER" | "NUMERIC" => match v.to_owned().try_decode::<i64>() {
            Ok(i) => JsonValue::Number(i.into()),
            Err(_) => JsonValue::Null,
        },
        "BOOLEAN" => match v.to_owned().try_decode::<bool>() {
            Ok(b) => JsonValue::Bool(b),
            Err(_) => JsonValue::Null,
        },
        "DATE" => match v.to_owned().try_decode::<time::Date>() {
            Ok(d) => JsonValue::String(d.to_string()),
            Err(_) => JsonValue::Null,
        },
        "TIME" => match v.to_owned().try_decode::<time::Time>() {
            Ok(t) => JsonValue::String(t.to_string()),
            Err(_) => JsonValue::Null,
        },
        "DATETIME" => match v.to_owned().try_decode::<time::PrimitiveDateTime>() {
            Ok(t) => JsonValue::String(t.to_string()),
            Err(_) => JsonValue::Null,
        },
        "BLOB" => match v.to_owned().try_decode::<Vec<u8>>() {
            Ok(bytes) => JsonValue::Array(bytes.into_iter().map(|n| JsonValue::Number(n.into())).collect()),
            Err(_) => JsonValue::Null,
        },
        "NULL" => JsonValue::Null,
        other => return Err(format!("不支援的資料型別: {other}")),
    };
    Ok(val)
}

pub async fn select(
    State(st): State<AppState>,
    Extension(user): Extension<String>,
    Json(req): Json<SqlReq>,
) -> Response {
    let pool = match pool_for(&st, &user, &req.db).await {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let q = bind(sqlx::query(&req.query), req.values);
    let rows = match pool.fetch_all(q).await {
        Ok(r) => r,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("SQL select 失敗: {e}")),
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut obj = serde_json::Map::new();
        for (i, col) in row.columns().iter().enumerate() {
            let raw = match row.try_get_raw(i) {
                Ok(r) => r,
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("decode 失敗: {e}")),
            };
            match decode(raw) {
                Ok(v) => { obj.insert(col.name().to_string(), v); }
                Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e),
            }
        }
        out.push(JsonValue::Object(obj));
    }
    Json(out).into_response()
}

pub async fn execute(
    State(st): State<AppState>,
    Extension(user): Extension<String>,
    Json(req): Json<SqlReq>,
) -> Response {
    let pool = match pool_for(&st, &user, &req.db).await {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let q = bind(sqlx::query(&req.query), req.values);
    match pool.execute(q).await {
        // 回傳形狀 = Tauri tuple (u64, i64) 序列化 → JSON 陣列（JS 端 [rowsAffected, lastInsertId] 解構）
        Ok(r) => Json(JsonValue::Array(vec![
            JsonValue::Number(r.rows_affected().into()),
            JsonValue::Number(r.last_insert_rowid().into()),
        ]))
        .into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, format!("SQL execute 失敗: {e}")),
    }
}

// close：移除 pool（sqlx drop 即關連線；對齊 plugin close 的 flush 語意）
pub async fn close(
    State(st): State<AppState>,
    Extension(user): Extension<String>,
    Json(req): Json<serde_json::Value>,
) -> Response {
    let user_dir = st.data_dir.join("users").join(user);
    let mut pools = st.sql.pools.lock().unwrap();
    let db = req.get("db").and_then(|v| v.as_str());
    match db {
        Some(db) => match db_path(&user_dir, db) {
            Ok(p) => {
                pools.remove(&p.to_string_lossy().to_string());
            }
            Err(e) => return err(StatusCode::BAD_REQUEST, e),
        },
        None => {
            let prefix = format!("{}", user_dir.join("").display());
            pools.retain(|k, _| !k.starts_with(&prefix));
        }
    }
    Json(JsonValue::Bool(true)).into_response()
}

// AppState 欄位（供 mod.rs 使用）：sql pool registry
pub type SharedSql = Arc<SqlState>;
