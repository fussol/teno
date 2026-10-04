#!/usr/bin/env node
// scan-refs.mjs — 死碼候選掃描（Phase3 整理）
// 規則（保守，寧漏勿錯殺）：
//   1) 靜態 import/export-from、字面量動態 import()、new URL(...)、index.html 引用 → 有引用=活
//   2) 模板動態 import(`./pages/${x}.js`) → 抽前綴，該目錄全部視為活（study.js 教訓）
//   3) src/main.js = 入口不報
// 輸出：零引用檔案候選（人工確認後才刪；刪前必查 loadPage/MAIN_PAGES）
// 用法: node tools/scan-refs.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.resolve('src'));

const rel = f => path.relative(root, f);
const refs = new Set();       // 被引用的檔案（正規化絕對路徑）
const prefixes = new Set();   // 模板動態前綴（相對於 importer 目錄的解析結果）

function addRef(fromFile, spec) {
  if (!spec.startsWith('.')) return; // 套件/alias 不追
  refs.add(path.resolve(path.dirname(fromFile), spec));
}
function addPrefix(fromFile, spec) {
  if (!spec.startsWith('.')) return;
  prefixes.add(path.resolve(path.dirname(fromFile), spec));
}

const RES = [
  /(?:^|\s)import\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
  /export\s+[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*`([^`]+)`/g, // 模板（含 ${} → 前綴匹配）
  /new URL\(\s*['"]([^'"]+)['"]/g,
];

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const re of RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (spec.includes('${')) addPrefix(f, spec.slice(0, spec.indexOf('${')));
      else addRef(f, spec);
    }
  }
}
// index.html 引用
const html = readFileSync('index.html', 'utf8');
for (const m of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) addRef(path.join(root, 'index.html'), m[1]);

const alive = f =>
  refs.has(f) ||
  [...prefixes].some(p => f.startsWith(p)) ||
  f === path.join(root, 'src/main.js');

const dead = files.filter(f => !alive(f));
console.log(`掃 ${files.length} 檔 | 模板前綴 ${prefixes.size} | 零引用候選 ${dead.length}`);
dead.forEach(f => console.log('  ' + rel(f)));
if (prefixes.size) console.log('模板前綴:', [...prefixes].map(p => rel(p)).join(', '));

// ── 第二段：export 出去但「全 repo（含 tools/web-shims/scripts/_dev，harness 也 import src）」零提及 ──
const extFiles = [];
for (const dir of ['tools', 'web-shims', 'scripts', '_dev']) {
  (function walkExt(d) {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkExt(p);
      else if (/\.(mjs|js)$/.test(e.name)) extFiles.push(p);
    }
  })(dir);
}
for (const e of readdirSync(root, { withFileTypes: true })) {
  if (e.isFile() && /\.(mjs|js)$/.test(e.name)) extFiles.push(e.name);
}
extFiles.push('index.html');
const body = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));
const otherCorpus = extFiles.map(f => readFileSync(f, 'utf8')).join('\n');
const suspects = [];
for (const [f, src] of body) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|function|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n && n !== 'default') names.add(n);
    }
  }
  const others = otherCorpus + '\n' + [...body].filter(([g]) => g !== f).map(([, s]) => s).join('\n');
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${esc}\\b`).test(others)) {
      const own = (src.match(new RegExp(`\\b${esc}\\b`, 'g')) || []).length - 1; // 扣掉 export 定義本身
      suspects.push({ line: `${rel(f)} :: ${n} (own=${own})`, own });
    }
  }
}
console.log(`\n零提及 export 候選 ${suspects.length}：own=0 真死可刪 / own≥1 只該收 export（人工確認後才動）:`);
suspects.forEach(s => console.log('  ' + s.line));
