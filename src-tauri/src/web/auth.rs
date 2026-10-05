// WEB-SERVE1：帳號/會話。單機多用戶，帳號由 `teno-server adduser` 或網站版註冊建立。
// 憑證：argon2id（不可逆）＋ session cookie（HttpOnly/SameSite=Strict，30 天）。
// sessions.json 落檔 → 伺服器重啟不用全部重登入。
use super::{err, AppState};
use axum::{
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const COOKIE_NAME: &str = "teno_session";
const SESSION_TTL_SECS: u64 = 30 * 24 * 3600;

#[derive(Default, Serialize, Deserialize)]
pub struct Users(pub HashMap<String, String>); // name → argon2id hash

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub user: String,
    pub exp: u64,
}

fn users_path(data: &Path) -> std::path::PathBuf { data.join("users.json") }
fn sessions_path(data: &Path) -> std::path::PathBuf { data.join("sessions.json") }

pub fn load_users(data: &Path) -> Result<Users, String> {
    let p = users_path(data);
    if !p.exists() { return Ok(Users::default()); }
    let s = std::fs::read_to_string(&p).map_err(|e| format!("users.json 讀取失敗: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("users.json 解析失敗: {e}"))
}

pub fn save_users(data: &Path, users: &Users) -> Result<(), String> {
    let s = serde_json::to_string_pretty(users).map_err(|e| e.to_string())?;
    std::fs::write(users_path(data), s).map_err(|e| format!("users.json 寫入失敗: {e}"))
}

pub fn load_sessions(data: &Path) -> HashMap<String, Session> {
    let now = now();
    std::fs::read_to_string(sessions_path(data))
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, Session>>(&s).ok())
        .map(|m| m.into_iter().filter(|(_, v)| v.exp > now).collect())
        .unwrap_or_default()
}

fn save_sessions(data: &Path, sessions: &HashMap<String, Session>) {
    if let Ok(s) = serde_json::to_string(sessions) {
        let _ = std::fs::write(sessions_path(data), s);
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn rand_hex(bytes: usize) -> String {
    let mut rng = rand::rng(); // ThreadRng：OS 種子＋自動 reseed（token/salt 夠用）
    (0..bytes).map(|_| format!("{:02x}", rng.random::<u8>())).collect()
}

pub fn hash_password(pw: &str) -> Result<String, String> {
    use argon2::password_hash::{PasswordHasher, SaltString};
    let mut rng = rand::rng();
    let salt: Vec<u8> = (0..16).map(|_| rng.random::<u8>()).collect();
    let salt = SaltString::encode_b64(&salt).map_err(|e| e.to_string())?;
    argon2::Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

fn verify_password(pw: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    PasswordHash::new(hash)
        .ok()
        .map(|ph| argon2::Argon2::default().verify_password(pw.as_bytes(), &ph).is_ok())
        .unwrap_or(false)
}

// 不存在的帳號也跑一次 argon2 → 避免帳號枚舉計時側信道
static DUMMY_HASH: std::sync::LazyLock<String> =
    std::sync::LazyLock::new(|| hash_password("dummy-timing-equalizer").unwrap_or_default());

#[derive(Deserialize)]
pub struct LoginBody { pub username: String, pub password: String }

fn set_cookie(token: &str, max_age: i64) -> String {
    let secure = if std::env::var("TENO_SECURE_COOKIE").is_ok() { "; Secure" } else { "" };
    format!("{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}")
}

// 發 session（login/register 共用）：過期清場 + sessions.json 落檔
fn issue_session(st: &AppState, user: &str) -> String {
    let token = rand_hex(32);
    let mut sess = st.sessions.write().unwrap();
    let now_t = now();
    sess.retain(|_, v| v.exp > now_t);
    sess.insert(token.clone(), Session { user: user.to_string(), exp: now_t + SESSION_TTL_SECS });
    save_sessions(&st.data_dir, &sess);
    token
}

pub async fn login(State(st): State<AppState>, Json(b): Json<LoginBody>) -> Response {
    // adduser 可在 server 執行中改 users.json → 每次登入重讀（檔案小、登入低頻）
    if let Ok(fresh) = load_users(&st.data_dir) {
        *st.users.lock().unwrap() = fresh;
    }
    let users = st.users.lock().unwrap();
    let hash = users.0.get(&b.username).cloned();
    let pass = match &hash {
        Some(h) => verify_password(&b.password, h),
        None => verify_password(&b.password, &DUMMY_HASH),
    };
    drop(users);
    if !pass {
        return err(axum::http::StatusCode::UNAUTHORIZED, "帳號或密碼錯誤");
    }
    let token = issue_session(&st, &b.username);
    let body = Json(json!({ "user": b.username }));
    ([(axum::http::header::SET_COOKIE, set_cookie(&token, SESSION_TTL_SECS as i64))], body).into_response()
}

// 網站版自助註冊（伺服器 --no-register 可關）。驗證同 adduser 口徑。
pub async fn register(State(st): State<AppState>, Json(b): Json<LoginBody>) -> Response {
    if !st.allow_register {
        return err(axum::http::StatusCode::FORBIDDEN, "註冊已關閉（伺服器以 --no-register 啟動）");
    }
    let name_ok = !b.username.is_empty()
        && b.username.len() <= 32
        && b.username.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !name_ok {
        return err(axum::http::StatusCode::BAD_REQUEST, "帳號限 ASCII 字母數字 _ -（1~32 字元）");
    }
    if b.password.len() < 8 {
        return err(axum::http::StatusCode::BAD_REQUEST, "密碼至少 8 碼");
    }
    // ponytail: 無 per-IP 速率限制；伺服器公開暴露到網路時再加 throttle
    let mut users = load_users(&st.data_dir).unwrap_or_else(|_| Users(HashMap::new()));
    if users.0.contains_key(&b.username) {
        return err(axum::http::StatusCode::CONFLICT, "帳號已存在");
    }
    let hash = match hash_password(&b.password) {
        Ok(h) => h,
        Err(e) => return err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    users.0.insert(b.username.clone(), hash);
    if let Err(e) = save_users(&st.data_dir, &users) {
        return err(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    *st.users.lock().unwrap() = users;
    let token = issue_session(&st, &b.username);
    let body = Json(json!({ "user": b.username }));
    ([(axum::http::header::SET_COOKIE, set_cookie(&token, SESSION_TTL_SECS as i64))], body).into_response()
}

pub async fn logout(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    if let Some(tok) = cookie_value(&headers) {
        let mut sess = st.sessions.write().unwrap();
        sess.remove(&tok);
        save_sessions(&st.data_dir, &sess);
    }
    ([(axum::http::header::SET_COOKIE, set_cookie("", -1))], Json(json!({ "ok": true }))).into_response()
}

pub async fn whoami(State(st): State<AppState>, headers: axum::http::HeaderMap) -> Response {
    match cookie_value(&headers).and_then(|t| {
        let sess = st.sessions.read().unwrap();
        sess.get(&t).filter(|s| s.exp > now()).map(|s| s.user.clone())
    }) {
        Some(user) => Json(json!({ "user": user })).into_response(),
        None => err(axum::http::StatusCode::UNAUTHORIZED, "未登入"),
    }
}

fn cookie_value(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').filter_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == COOKIE_NAME).then(|| v.to_string())
    }).next()
}

// 鉴權中間件：cookie → sessions 查驗 → 通過則把 user 放進 request extensions
pub async fn require_auth(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    let user = cookie_value(req.headers()).and_then(|t| {
        let mut sess = st.sessions.write().unwrap();
        let now_t = now();
        let u = sess.get(&t).filter(|s| s.exp > now_t).map(|s| s.user.clone());
        if u.is_some() && sess.len() > 64 { // 順手清過期（lazy: 只在規模到門檻時清）
            sess.retain(|_, v| v.exp > now_t);
        }
        u
    });
    match user {
        Some(u) => {
            req.extensions_mut().insert(u);
            next.run(req).await
        }
        None => err(axum::http::StatusCode::UNAUTHORIZED, "未登入"),
    }
}
