# Packaging

## Binary

```sh
npx tauri build
```

流程：

1. `beforeBuildCommand: "vite build"` — Vite 打包前端到 `dist/`
2. `cargo build --release` — Rust 編譯 `src-tauri/` → `src-tauri/target/release/teno`
3. Tauri CLI 自動產出各平台格式：
   - **Linux** → `.deb`, `.rpm`
   - **macOS** → `.dmg`
   - **Windows** → `.msi`

## Arch Linux 套件 (.pkg.tar.zst)

```sh
makepkg -f --nodeps
```

### PKGBUILD (`PACKAGING.md` 同目錄)

```bash
# Maintainer: Teno

pkgname=teno
pkgver=5.1.0
pkgrel=4
pkgdesc='Teno — English vocabulary learning app'
arch=('x86_64')
url='https://teno.app'
license=('custom:commercial')
depends=('webkit2gtk-4.1' 'libsoup3' 'gstreamer' 'gst-plugins-base' 'gst-plugins-good'
         'gst-plugins-bad' 'gst-plugins-ugly' 'gst-libav' 'glib2' 'gtk3'
         'cairo' 'pango' 'gdk-pixbuf2' 'atk' 'librsvg'
         'sqlite' 'libx11' 'libxdo' 'ttf-font')
makedepends=()
source=("$pkgname-$pkgver.tar.gz")
sha256sums=('SKIP')

package() {
  install -Dm755 "${srcdir}/teno" "${pkgdir}/usr/bin/teno"
  install -Dm644 "${srcdir}/Teno.desktop" "${pkgdir}/usr/share/applications/teno.desktop"
  for size in 32x32 128x128 128x128@2x; do
    install -Dm644 "${srcdir}/${size}.png" \
      "${pkgdir}/usr/share/icons/hicolor/${size}/apps/teno.png"
  done
}
```

### 手動準備 source tarball

每次更新 binary 後需重建 `teno-<ver>.tar.gz`：

```sh
mkdir -p /tmp/teno-src
cp src-tauri/target/release/teno /tmp/teno-src/teno
cp src-tauri/target/release/bundle/appimage/Teno.AppDir/usr/share/applications/Teno.desktop /tmp/teno-src/
cp src-tauri/icons/32x32.png /tmp/teno-src/
cp src-tauri/icons/128x128.png /tmp/teno-src/
cp src-tauri/icons/128x128@2x.png /tmp/teno-src/
cd /tmp/teno-src
tar czf /path/to/project/_local/artifacts/arch/teno-$pkgver.tar.gz *
```

### 安裝

```sh
sudo pacman -U _local/artifacts/arch/teno-5.1.0-4-x86_64.pkg.tar.zst
```

### 版本更新

1. 更新 `PKGBUILD` 中的 `pkgver` / `pkgrel`
2. 更新 `teno-$pkgver.tar.gz`
3. `makepkg -f --nodeps`，將產物移至 `_local/artifacts/arch/`
4. `sudo pacman -U _local/artifacts/arch/teno-$pkgver-$pkgrel-x86_64.pkg.tar.zst`
