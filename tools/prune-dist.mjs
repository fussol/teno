// TAI 條碼：tauri 打包前修剪 dist 死資產（vite build 後、codegen 嵌入前跑）。
// 四項在 src/dist/Rust/seed 全數零引用（2026-10-06 grep 實查）：
//   img/ 29MB、real-data.json 12MB（.so 內 brotli 2.1）、eng.traineddata raw
//   （gzip:true 只讀 .gz）、words.txt.gz（詞典走 src/assets/words.txt?raw 內嵌）。
// 只動 dist/，public/ 原件留給 tools/（snapshot、copy-ocr、verify-image-url）。
import { existsSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KILL = [
  'img',
  'real-data.json',
  'words.txt.gz',
  'assets/ocr/lang/eng.traineddata',
];

function size(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return 0;
  } catch {
    return 0;
  }
}

for (const rel of KILL) {
  const p = fileURLToPath(new URL(`../dist/${rel}`, import.meta.url));
  if (!existsSync(p)) continue;
  const n = size(p);
  rmSync(p, { recursive: true, force: true });
  console.log(`prune-dist: - dist/${rel}${n ? ` (${(n / 1048576).toFixed(1)}MB)` : ''}`);
}
