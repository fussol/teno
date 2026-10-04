import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// WEB-SERVE1：`--mode web` = 網站版構建（alias 接管 Tauri 傳輸層、proxy 打本地伺服器、
// 出力 dist-web 與桌面 dist 分開）。預設 mode 不變 → 桌面/Android 構建零接觸。
export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    clearScreen: false,
    ...(web
      ? {
          resolve: {
            alias: [
              {
                find: /^@tauri-apps\/api\/core$/,
                replacement: fileURLToPath(new URL('./web-shims/core.js', import.meta.url)),
              },
              {
                find: /^@tauri-apps\/plugin-sql$/,
                replacement: fileURLToPath(new URL('./web-shims/plugin-sql.js', import.meta.url)),
              },
            ],
          },
          server: {
            strictPort: true,
            allowedHosts: true,
            proxy: { '/api': 'http://127.0.0.1:8788' },
          },
        }
      : {
          server: {
            strictPort: true,
            allowedHosts: true,
          },
        }),
    define: { __TENO_WEB__: 'true' },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
      target: ['es2021', 'chrome100', 'safari13'],
      minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
      sourcemap: !!process.env.TAURI_DEBUG,
      outDir: web ? 'dist-web' : 'dist',
    },
    optimizeDeps: {
      exclude: ['onnxruntime-web', '@huggingface/transformers', 'tesseract.js'],
    },
  };
});
