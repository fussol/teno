# Container Build

隔離環境編譯 Teno，避免宿主依賴汙染。

## 前置

- [Podman](https://podman.io/)

## 用法

```bash
podman build -t teno-builder .
podman cp $(podman create teno-builder):/teno ./teno
```

Output: `./teno`（靜態連結 frontend，可直接執行）

## 說明

- Arch Linux base，Tauri v2 完整 pipeline（`vite build` + `cargo build --release`）
- `--no-bundle` 跳過 deb/rpm 打包，只產 binary
- Containerfile 在專案根目錄
