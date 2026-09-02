#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// G16 防回歸驗證 — store.js sidebarOpen/toggleSidebar 死碼刪除
// 修後: store.js 不再含 sidebarOpen/toggleSidebar；全域零消費者確認。
// ═══════════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';

let failures = 0;
function ok(name, cond, detail='') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' → ' + detail : ''}`);
  if (!cond) failures++;
}

const storeSrc = readFileSync(new URL('../src/lib/store.js', import.meta.url), 'utf8');

console.log('── G16 sidebar 死碼刪除 ──');

// T1 FIX MARKER: store.js 不再有 sidebarOpen state
ok('T1 store.js 無 sidebarOpen: true 初始值', !/sidebarOpen:\s*true/.test(storeSrc));
// T2 FIX MARKER: 不再有 toggleSidebar 函式
ok('T2 store.js 無 toggleSidebar()', !/toggleSidebar/.test(storeSrc));

// T3 全域零消費者（修後）—— 用 fs 實際掃描 src
import { fileURLToPath } from 'node:url';
const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const walk = (dir) => {
  let files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '_dev', 'assets'].includes(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) files = files.concat(walk(p));
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
  return files;
};
let hits = [];
for (const f of walk(srcDir)) {
  const c = readFileSync(f, 'utf8');
  if (/sidebarOpen|toggleSidebar/.test(c)) hits.push(f.replace(srcDir + '/', ''));
}
ok('T3 全域 src 零引用 sidebarOpen/toggleSidebar', hits.length === 0, hits.join(',') || 'none');

// T4 main.js 側欄走 DOM classList（不依賴 store）— 保持
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
ok('T4 main.js 用 classList.toggle(hidden) 控側欄', /sidebar\.classList\.toggle\('hidden'\)/.test(mainSrc) || /sidebar.*classList\.toggle/.test(mainSrc));

console.log(`\n結果: ${failures===0 ? 'ALL PASS' : failures+' FAIL'}`);
process.exit(failures===0 ? 0 : 1);