// ═══════════════════════════════════════════════════════════════
// verify-e16-orphan-deletion.mjs — E16: 三死檔殲滅釘
//   src/lib/deprecated/sim-engine.js / src/lib/themes.js / src/pages/svg.js
// 雙態自適應：刪前模式證「孤兒但存在＋動態 import 殲滅判別子成立」，
// 刪後模式證「磁碟殲滅＋零殘留＋歷史真實」。
// 設計出處 E16-fix-plan.md v1.1 §4（R1 次要#1 錯誤碼雙態判別子、
// #2 SVG 符號零消費者釘、#3 glob 面＝vite build 必測在回归義務非本腳本）。
// 跑法: node tools/verify-e16-orphan-deletion.mjs
// ═══════════════════════════════════════════════════════════════
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
function T(name, ok, extra = '') {
  (ok ? pass++ : fail++);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `  [${extra}]`}`);
}

const TARGETS = [
  { p: 'src/lib/deprecated/sim-engine.js', exports: ['runSimulation', 'runWorkloadSimulation'] },
  { p: 'src/lib/themes.js', exports: ['THEMES', 'THEME_LIST'] },
  { p: 'src/pages/svg.js', exports: ['SVG', 'icons', 'splitFieldsHtml', 'fmtExample'] },
];
const present = TARGETS.map(t => existsSync(join(REPO, t.p)));
const mode = present.every(Boolean) ? 'pre' : present.every(x => !x) ? 'post' : null;
if (!mode) { console.log('FAIL  半刪態（部分檔還在）＝刪除不完整'); process.exit(1); }
console.log(`mode=${mode}\n`);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'teno-5.1.0']);
function walk(d, acc = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name), acc); }
    else if (/\.(js|mjs|html)$/.test(e.name)) acc.push(join(d, e.name));
  }
  return acc;
}

// ── T1 零引用前提釘（刪前刪後皆必綠＝安全刪除充要證據） ──
console.log('T1 零引用前提釘');
{
  const files = [
    ...walk(join(REPO, 'src')).filter(f => !f.includes('/deprecated/') && !f.includes('/teno-5.1.0/')),
    ...walk(join(REPO, 'tools')).filter(f => !/verify-(e8-selftest|e16-orphan)/.test(f)),
    join(REPO, 'index.html'),
  ].filter(f => existsSync(f));
  const pats = [
    ['lib/themes import', /from\s+['"][^'"]*lib\/themes(\.js)?['"]/],
    ['pages/svg 路徑', /pages\/svg/],
    ['./svg 旁支 import', /from\s+['"]\.\/svg(\.js)?['"]/],
    ['sim-engine token', /sim-engine/],
  ];
  for (const [label, re] of pats) {
    const hits = files.filter(f => re.test(readFileSync(f, 'utf8')));
    T(`T1 ${label} 零命中（${files.length} 檔掃）`, hits.length === 0, hits.join(','));
  }
  // T1b glob 豁免登記釘（R1 次要#3）：main.js 模板 glob 必須不經 'svg' 頁名
  const mainJs = readFileSync(join(REPO, 'src/main.js'), 'utf8');
  T('T1b PAGE_NAMES 不含 svg', !/['"]svg['"]/.test(mainJs));
  T('T1b2 無 loadPage(\'svg\') 直調', !/loadPage\(\s*['"]svg['"]/.test(mainJs));
}

// ── T2 存在態＋非空殼（pre）／殲滅（post） ──
console.log('\nT2 存在態殲滅釘');
if (mode === 'pre') {
  for (const t of TARGETS) {
    const src = readFileSync(join(REPO, t.p), 'utf8');
    const missing = t.exports.filter(x => !new RegExp(`export\\s+(const|function|\\{[^}]*\\b)\\s*.*\\b${x}\\b`, 's').test(src));
    T(`T2 ${t.p} 存在且導出齊（${t.exports.join('/')}）`, missing.length === 0, '缺:' + missing);
  }
} else {
  for (const t of TARGETS) T(`T2 ${t.p} 已殲滅`, !existsSync(join(REPO, t.p)));
}

// ── T3 動態 import 錯誤碼雙態判別子 ──
console.log('\nT3 動態 import 判別子');
async function probe(rel) {
  try { await import(pathToFileURL(join(REPO, rel)).href); return { code: 'OK' }; }
  catch (e) { return { code: e.code || 'OTHER', msg: String(e.message).slice(0, 120) }; }
}
{
  if (mode === 'post') {
    for (const t of TARGETS) {
      const r = await probe(t.p);
      // 殲滅判別：ERR_MODULE_NOT_FOUND 且訊息點名本檔完整相對路徑
      // （用 t.p 非僅文件名：'svg.js' 短名會誤咬 lucide-static 解析錯誤訊息裡的 lib/svg.js）
      T(`T3 import(${t.p}) ERR_MODULE_NOT_FOUND 點名本檔`,
        r.code === 'ERR_MODULE_NOT_FOUND' && r.msg.includes(t.p), JSON.stringify(r));
    }
  } else {
    const a = await probe('src/lib/themes.js');
    T('T3(前) themes.js import 成功', a.code === 'OK', JSON.stringify(a));
    const b = await probe('src/lib/deprecated/sim-engine.js');
    T('T3(前) sim-engine.js import 成功', b.code === 'OK', JSON.stringify(b));
    const c = await probe('src/pages/svg.js');
    T('T3(前) pages/svg.js 拋 ERR_UNKNOWN_FILE_EXTENSION（存在性副證：檔在才走到 extension 階段；?raw lucide import Node ESM 原生不可載 R1#1）',
      c.code === 'ERR_UNKNOWN_FILE_EXTENSION', JSON.stringify(c));
  }
}

// ── T4 歷史真實性釘 ──
console.log('\nT4 歷史真實性釘');
for (const t of TARGETS) {
  const log = execSync(`git -C ${REPO} log --oneline -1 -- ${t.p}`, { encoding: 'utf8' }).trim();
  T(`T4 ${t.p} 有 git 歷史`, log.length > 0 && /^\w+ /.test(log), log);
}

// ── T5 白名單邊界釘（E16-SR2 演化 2026-08-30）：sim-behavior 已刪（E16-SR1 fd4324e 落地）──
// 原臨時釘「本波必須仍在」為 SR1 送審期的存續期鎖；SR1 commit 後該檔已刪，釘翻紅屬預期。
// 演化為「已刪」態：existsSync 應為 false（負向釘，防誤復活）。
console.log('\nT5 白名單邊界釘（E16-SR2：sim-behavior 已刪態）');
{
  T('T5a sim-behavior.js 已刪（E16-SR1 落地，負向釘防復活）', !existsSync(join(REPO, 'src/lib/deprecated/sim-behavior.js')));
  const all = walk(join(REPO, 'src'), []).filter(f => !f.includes('/teno-5.1.0/'));
  const hits = all.filter(f => !f.endsWith('sim-behavior.js') && readFileSync(f, 'utf8').includes('sim-behavior'));
  T('T5b sim-behavior 引用者清零（已刪態恆常釘）', hits.length === 0, hits.join(','));
  const sr = existsSync(join(REPO, '_dev/notes/scope-requests.md')) && readFileSync(join(REPO, '_dev/notes/scope-requests.md'), 'utf8').includes('E16-SR1');
  T('T5c E16-SR1 scope-request 已落盤', sr);
}

// ── T6 消費端零波及釘 ──
console.log('\nT6 消費端零波及釘');
{
  const libSvg = readFileSync(join(REPO, 'src/lib/svg.js'), 'utf8');
  for (const sym of ['icons', 'icon', 'splitFieldsHtml', 'fmtExample']) {
    T(`T6 lib/svg.js 活本體導出 ${sym}`, new RegExp(`export\\s+(const|function)\\s+${sym}\\b`).test(libSvg));
  }
  // SVG 符號 lib 版沒有（R1#2）→ 釘全庫零導入者
  const impSvg = walk(join(REPO, 'src'), []).filter(f => !f.includes('/teno-5.1.0/') && !f.endsWith('src/pages/svg.js'))
    .filter(f => /import\s*(?:\{[^}]*\bSVG\b|\*\s+as)/.test(readFileSync(f, 'utf8')) && /\bSVG\b/.test(readFileSync(f, 'utf8')));
  const impSvgStrict = walk(join(REPO, 'src'), []).filter(f => !f.includes('/teno-5.1.0/') && !f.endsWith('src/pages/svg.js'))
    .filter(f => { const s = readFileSync(f, 'utf8'); const m = s.match(/import\s*\{([^}]*)\}/g) || []; return m.some(x => /\bSVG\b/.test(x)); });
  T('T6b SVG 符號全庫零導入者（分裝層独有符號真空檢查 R1#2）', impSvgStrict.length === 0, impSvgStrict.join(','));
}

// ── T7 負控制：還原死檔到 NC 樹 → post 斷言精準翻紅 ──
console.log('\nT7 負控制（死檔還原 NC 樹復生重現）');
if (mode === 'post') {
  const NC = join('/tmp', `e16nc-${process.pid}`);
  try {
    const need = ['src/lib/themes.js', 'src/lib/deprecated/sim-engine.js', 'src/lib/deprecated/sim-behavior.js',
      'src/pages/svg.js', 'src/lib/svg.js', 'src/lib/rng.js', 'src/core/fsrs.js'];
    for (const rel of need) {
      const last = execSync(`git -C ${REPO} log --format=%H -n1 -- ${rel}`, { encoding: 'utf8' }).trim();
      // 刪除 commit 的父提交仍含檔；未刪檔（sim-behavior 等）該 commit 即含檔
      let content;
      try { content = execSync(`git -C ${REPO} show ${last}:${rel}`, { encoding: 'utf8' }); }
      catch { content = execSync(`git -C ${REPO} show ${last}^:${rel}`, { encoding: 'utf8' }); }
      mkdirSync(join(NC, dirname(rel)), { recursive: true });
      writeFileSync(join(NC, rel), content);
    }
    for (const t of TARGETS) {
      T(`T7 ${t.p} NC 樹復生（existsSync=true → T2 殲滅釘於此態必紅）`, existsSync(join(NC, t.p)));
      try {
        await import(pathToFileURL(join(NC, t.p)).href);
        T(`T7 ${t.p} NC import 非「本檔 MISSING」態`, true);
      } catch (e) {
        const ourMissing = (e.code === 'ERR_MODULE_NOT_FOUND') && String(e.message).includes(t.p);
        T(`T7 ${t.p} NC import 非本檔缺失態（死路徑判別子反換驗證）`, !ourMissing, `${e.code}: ${String(e.message).slice(0, 90)}`);
      }
    }
  } finally { rmSync(NC, { recursive: true, force: true }); }
} else {
  console.log('SKIP  T7（負控制僅刪後態有意義：pre 模式檔尚在＝天然負控制態，T3(前) 已證判別子方向性）');
}

console.log(`\n═══ verify-e16 (${mode}): ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : '— HAS FAILURE'} ═══`);
process.exit(fail === 0 ? 0 : 1);
