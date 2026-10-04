#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// harness 全量回歸 runner — 把隱性協定變一指令（P2 整理）
//
// 協定（Phase2 前是人肉記憶，這裡是唯一定義）：
//   每顆 verify-*.mjs 必須帶 --experimental-test-module-mocks 跑
//   （30 顆用 node:test 的 mock.module；不帶旗標＝誤報紅）
//   紅的定義：exit≠0 →「FAIL tools/<檔>」＋stdout 的「FAIL ...」內容行
//   與 tools/harness-baseline.txt（# 開頭=註解）比對：出線=新紅
//
// 用法（repo 根目錄執行）：
//   node tools/run-all.mjs            全量；有基線外新紅 → exit 1
//   node tools/run-all.mjs --update   把目前狀態寫回基線（審過 diff 再 commit）
// ══════════════════════════════════════════════════════════════
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAG = '--experimental-test-module-mocks';
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(toolsDir, 'harness-baseline.txt');
const update = process.argv.includes('--update');

const files = readdirSync(toolsDir).filter(f => /^verify-.*\.mjs$/.test(f)).sort();
const now = [];
let red = 0;

for (const f of files) {
  const r = spawnSync('node', [FLAG, path.join(toolsDir, f)], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024,
  });
  const isRed = r.status !== 0;
  if (isRed) { red++; now.push(`FAIL tools/${f}`); }
  for (const line of String(r.stdout || '').split('\n')) {
    if (line.startsWith('FAIL')) now.push(line);
  }
  process.stdout.write(isRed ? '✗' : '·');
}
const current = [...new Set(now)].sort();

if (update) {
  // 保留既有 # 檔頭（分類註解/協定），只重寫 FAIL 本體
  const hdr = readFileSync(baselinePath, 'utf8').split('\n').filter(l => l.startsWith('#'));
  writeFileSync(baselinePath, hdr.join('\n') + '\n' + current.join('\n') + '\n');
  console.log(`\n基線已更新: ${current.length} 行（# 檔頭 ${hdr.length} 行保留；記得 git diff 審過再 commit）`);
  process.exit(0);
}

const base = readFileSync(baselinePath, 'utf8')
  .split('\n').filter(l => l.trim() && !l.startsWith('#')).sort();
// 嚴格比對 = 檔名行（紅的身分，穩定）；內容行可能浮動（掃描檔數、外網回應碼）→ 只提示
const isFile = l => l.startsWith('FAIL tools/');
const strictNow = current.filter(isFile), strictBase = base.filter(isFile);
const infoNow = current.filter(l => !isFile(l)), infoBase = base.filter(l => !isFile(l));
const sNow = new Set(strictNow), sBase = new Set(strictBase);
const neu = strictNow.filter(l => !sBase.has(l));
const gone = strictBase.filter(l => !sNow.has(l));
const iNow = new Set(infoNow);
const infoNew = infoBase.filter(l => !iNow.has(l)).length;
const infoGone = infoNow.filter(l => !new Set(infoBase).has(l)).length;

console.log(`\n${files.length} 顆 | 紅 ${red} | 檔名行 ${strictNow.length} vs 基線 ${strictBase.length} | 內容行 ${infoNow.length} vs ${infoBase.length}`);
if (neu.length) {
  console.log(`\n❌ 基線外新紅檔（${neu.length}）:`);
  neu.forEach(l => console.log('  ' + l));
}
if (gone.length) {
  console.log(`\n🟢 基線內已轉綠（${gone.length}）— 可 --update 收斂:`);
  gone.forEach(l => console.log('  ' + l));
}
if (infoNew || infoGone) console.log(`ℹ 內容行漂移 ${infoNew} 出/${infoGone} 沒（浮動訊號，不計紅；--update 可收斂）`);
if (!neu.length && !gone.length) console.log('✅ 紅檔名集合與基線完全一致');
process.exit(neu.length ? 1 : 0);
