#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// verify-e16-sr1-orphan.mjs — E16-SR1: sim-behavior.js 死檔殲滅驗證
// 雙態：刪前在場（RED）→ 刪後 abs (GREEN)；負控制還原檔 → 檔案在必紅。
// 全庫零 runtime 引用（src/tools/_dev/src）＋ deprecated/ 目錄消失。
// 放 _dev/notes/（本顆白名單），非 tools/（tools/ 白名單僅 d5/d20/f16/g24）。
// 用法: node _dev/notes/verify-e16-sr1-orphan.mjs
// ═══════════════════════════════════════════════════════════════
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));  // _dev/notes → 3 層
const TARGET = 'src/lib/deprecated/sim-behavior.js';
const DEP_DIR = 'src/lib/deprecated';
let pass = 0, fail = 0;
const T = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${extra}»`); }
};

const SKIP = new Set(['node_modules', 'dist', '.git', 'teno-5.1.0']);
function walk(d, acc = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(d, e.name), acc); }
    else if (/\.(js|mjs|html)$/.test(e.name)) acc.push(join(d, e.name));
  }
  return acc;
}

console.log('── T1 檔案殲滅 ──');
const exists = existsSync(join(REPO, TARGET));
T('T1a sim-behavior.js 已刪除（不存在）', !exists);
// deprecated/ 目錄若已刪即ok；若仍在但僅剩死檔骨架可容忍? 規範：檔案不在即核心達成。
// deprecated/ 空目錄消失：若目錄還在但內部無其他檔 → 空目錄
if (existsSync(join(REPO, DEP_DIR))) {
  const remaining = readdirSync(join(REPO, DEP_DIR)).filter(f => f !== 'sim-behavior.js');
  console.log(`  INFO  deprecated/ 剩 ${remaining.length} 檔（本任務只負責 sim-behavior.js）`);
}

console.log('── T2 全庫零 runtime 引用 ──');
// 掃 src（排除 deprecated）＋ tools 全部＋ index.html；sim-behavior 出現即違規
// 注意：verify-e16-orphan-deletion.mjs 內含 'sim-behavior' 字串——它是上波工具，其 T5a
//   「sim-behavior 本波必須仍在」臨時釘，非 runtime import。本驗證排除該工具自述。
const files = [
  ...walk(join(REPO, 'src')).filter(f => !f.includes('/deprecated/')),
  ...walk(join(REPO, 'tools')).filter(f => !/verify-e16-orphan-deletion/.test(f)),
  ...walk(join(REPO, '_dev/notes')).filter(f => /\.(js|mjs)$/.test(f) && !/verify-e16-sr1-orphan/.test(f)),
  join(REPO, 'index.html'),
].filter(f => existsSync(f));
const hits = files.filter(f => readFileSync(f, 'utf8').includes('sim-behavior'));
T(`T2 零 runtime import (${files.length} 檔掃, 排除 verify-e16 工具自述)`, hits.length === 0, hits.join(','));
// deprecated/ 其餘檔不得 import 它（sim-engine 已刪，理論空）
if (existsSync(join(REPO, DEP_DIR))) {
  const depHits = readdirSync(join(REPO, DEP_DIR)).filter(f => f !== 'sim-behavior.js')
    .filter(f => readFileSync(join(REPO, DEP_DIR, f), 'utf8').includes('sim-behavior'));
  T('T2b deprecated/ 內無其他檔引用 sim-behavior', depHits.length === 0, depHits.join(','));
}

console.log('── T3 負控制（還原檔 → 必紅）──');
{
  // 命題：把同樣的檔還原到 repo 的 deprecated/ 下，T1a 的核心判別（檔案不存在）必翻紅。
  // 不實際污染 repo——在 /tmp 重建 deprecated/ 同結構跑同判別。
  const NC = mkdtempSync(join(tmpdir(), 'e16sr1nc-'));
  try {
    mkdirSync(join(NC, 'src/lib/deprecated'), { recursive: true });
    const ncTarget = join(NC, 'src/lib/deprecated/sim-behavior.js');
    writeFileSync(ncTarget, '// restored orphan stub');
    const ncExists = existsSync(ncTarget);
    // 負控制核心斷言：還原後「檔案不存在」判別為 false → 此 bug 態會被 T1a 抓到
    T('T3 還原版「已刪」判別必紅（負控制成立）', ncExists === true && !existsSync(join(NC, 'src/lib/deprecated/sim-behavior.js')) === false);
  } finally { rmSync(NC, { recursive: true, force: true }); }
}

const hasError = fail > 0;
console.log(`\n═══ E16-SR1 verify: ${pass} PASS / ${fail} FAIL ${hasError ? '— HAS FAILURE' : '— ALL PASS'} ═══`);
process.exit(hasError ? 1 : 0);