// P3-WEB1：command 統一上下文參數。
//   桌面 = AppHandle 包裝（path 解析委派原 PathResolver → 行為零漂移）
//   網站 = 每用戶資料目錄 data/users/<user>/（＝桌面 app_config_dir 的對應物）
// 全部 command 簽名統一寫 `app_handle: Ctx`（預設 Ctx<Wry>），函數體 `app_handle.path().xxx()` 不變。
use tauri::Manager;

// 無 derive(Clone)：derive 會加 R: Clone 界，android 的 Wry 不滿足 → E0599×4（host 碰巧過、aarch64 掛）。
// 手工實作無界：AppHandle<R> 恆為 Clone，Web 三欄 PathBuf。
pub enum Ctx<R: tauri::Runtime = tauri::Wry> {
    Desktop(tauri::AppHandle<R>),
    Web {
        config: std::path::PathBuf,
        log: std::path::PathBuf,
        cache: std::path::PathBuf,
    },
}

impl<R: tauri::Runtime> Clone for Ctx<R> {
    fn clone(&self) -> Self {
        match self {
            Ctx::Desktop(h) => Ctx::Desktop(h.clone()),
            Ctx::Web { config, log, cache } => Ctx::Web { config: config.clone(), log: log.clone(), cache: cache.clone() },
        }
    }
}

impl Ctx<tauri::Wry> {
    pub fn web(config: std::path::PathBuf) -> Self {
        let log = config.join("logs");
        let cache = config.join("cache");
        let _ = std::fs::create_dir_all(&log);
        Ctx::Web { config, log, cache }
    }
}

impl<R: tauri::Runtime> Ctx<R> {
    /// 僅桌面路徑使用（web 分派不經過；被呼叫即為接線錯誤）。
    pub fn handle(&self) -> &tauri::AppHandle<R> {
        match self {
            Ctx::Desktop(h) => h,
            Ctx::Web { .. } => panic!("Ctx::handle() 僅桌面版可用"),
        }
    }

    pub fn is_web(&self) -> bool {
        matches!(self, Ctx::Web { .. })
    }

    /// 桌面 = package_info().version；Web = 同一份 CARGO_PKG_VERSION（單一真相）。
    pub fn version(&self) -> String {
        match self {
            Ctx::Desktop(h) => h.package_info().version.to_string(),
            Ctx::Web { .. } => env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn path(&self) -> CtxPath<'_, R> {
        CtxPath(self)
    }
}

fn io_err(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

pub struct CtxPath<'a, R: tauri::Runtime>(&'a Ctx<R>);

impl<R: tauri::Runtime> CtxPath<'_, R> {
    pub fn app_config_dir(&self) -> Result<std::path::PathBuf, std::io::Error> {
        match self.0 {
            Ctx::Desktop(h) => h.path().app_config_dir().map_err(io_err),
            Ctx::Web { config, .. } => Ok(config.clone()),
        }
    }
    pub fn app_log_dir(&self) -> Result<std::path::PathBuf, std::io::Error> {
        match self.0 {
            Ctx::Desktop(h) => h.path().app_log_dir().map_err(io_err),
            Ctx::Web { log, .. } => Ok(log.clone()),
        }
    }
    pub fn app_cache_dir(&self) -> Result<std::path::PathBuf, std::io::Error> {
        match self.0 {
            Ctx::Desktop(h) => h.path().app_cache_dir().map_err(io_err),
            Ctx::Web { cache, .. } => Ok(cache.clone()),
        }
    }
    pub fn resource_dir(&self) -> Result<std::path::PathBuf, std::io::Error> {
        match self.0 {
            Ctx::Desktop(h) => h.path().resource_dir().map_err(io_err),
            Ctx::Web { .. } => {
                Err(std::io::Error::new(std::io::ErrorKind::NotFound, "resource_dir 僅桌面版"))
            }
        }
    }
}

// 桌面 invoke 分派用（Tauri 生成碼把每個 command 參數交給 CommandArg）
impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for Ctx<R> {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        Ok(Ctx::Desktop(
            command.message.webview_ref().app_handle().clone(),
        ))
    }
}
