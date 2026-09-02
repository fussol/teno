#!/usr/bin/env node
// verify-o3-api29.mjs — O3 TtsPlugin.saveExportFile API29 斷裂（版本分支）
//
// 病灶：saveExportFile 全程用 MediaStore.Downloads（API29+ 巢狀靜態欄位類），minSdk=24 裝置
// （Android 7.0-9.0）匯出時解析 EXTERNAL_CONTENT_URI 等靜態欄位 → NoClassDefFoundError 崩潰。
// 修法：SDK_INT>=29 保留現行 MediaStore 路徑；<29（Android 7-9）走 legacy 舊路徑
// （getExternalStoragePublicDirectory + FileOutputStream）。<29 裝置永不執行 MediaStore.Downloads
// 引用 → Art 懶解析 → 類不載入 → NCDFE 消除。
//
//   T0 PRE：git 基準 73e3a7f 的函式無 SDK_INT 分支、直接引用 MediaStore.Downloads（bug 事實）
//   T1 結構：函式含 Build.VERSION.SDK_INT>=29 分支，>=29 段保留 MediaStore.Downloads 現行邏輯
//   T2 legacy：else 段用 getExternalStoragePublicDirectory + FileOutputStream，零 MediaStore 引用
//   T3 負控制：換回無條件 MediaStore（剝除分支）→ T1 偵測面必紅
//   T4 前提：compileSdk>=29（MediaStore.Downloads 需 API29+ 編譯支援）
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const ROOT = '/home/jupiter/teno';
const KT_REL = 'src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt';
const GR_REL = 'src-tauri/gen/android/app/build.gradle.kts';
const PIN = process.env.TENO_PIN || 'HEAD';
const read = (rel, envVar) => process.env[envVar]
  ? readFileSync(process.env[envVar], 'utf8')
  : execSync(`git show ${PIN}:${rel}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });

const KT = read(KT_REL, 'SRC_KT');
const GR = read(GR_REL, 'SRC_GR');

const grabFn = (s, name) => {
  const m = s.indexOf('fun ' + name);
  if (m < 0) throw new Error(`fun ${name} not found`);
  const open = s.indexOf('{', m);
  let depth = 0, i = open;
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) break; }
  }
  return s.slice(m, i + 1);
};

test('T0 PRE：基準 73e3a7f 函式無 SDK_INT 分支＋直接引用 MediaStore.Downloads', () => {
  const base = grabFn(execSync(`git show 73e3a7f:${KT_REL}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }), 'saveExportFile');
  assert.ok(!base.includes('SDK_INT'), '基準應無 SDK_INT 分支');
  assert.ok(base.includes('MediaStore.Downloads.EXTERNAL_CONTENT_URI'), '基準應直接用 MediaStore.Downloads（bug 面）');
});

test('T1 結構：saveExportFile 含 SDK_INT>=29 分支，>=29 段保留現行 MediaStore', () => {
  const fn = grabFn(KT, 'saveExportFile');
  assert.ok(fn.includes('Build.VERSION.SDK_INT >= 29'), '缺 SDK_INT>=29 版本分支');
  // >=29 段：MediaStore.Downloads 現行保留（在 >=29 分支內）
  const hiPart = fn.slice(0, fn.indexOf('else'));
  assert.ok(hiPart.includes('MediaStore.Downloads.EXTERNAL_CONTENT_URI'), '>=29 段應保留 MediaStore.Downloads 現行邏輯');
  assert.ok(hiPart.includes('RELATIVE_PATH'), '>=29 段應保留 RELATIVE_PATH');
});

test('T2 legacy：else 段用舊路徑且零 MediaStore 引用', () => {
  const fn = grabFn(KT, 'saveExportFile');
  const loPart = fn.slice(fn.indexOf('else'));
  assert.ok(loPart.includes('getExternalStoragePublicDirectory'), 'else 段應走 getExternalStoragePublicDirectory 舊路徑');
  assert.ok(loPart.includes('FileOutputStream'), 'else 段應用 FileOutputStream 寫入');
  assert.ok(!loPart.includes('MediaStore'), 'else 段零 MediaStore 引用（<29 永不觸發 API29+ 類載入）');
});

test('T3 負控制：真實舊碼（73e3a7f）對 T1 偵測面必紅', () => {
  const baseFn = grabFn(execSync(`git show 73e3a7f:${KT_REL}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }), 'saveExportFile');
  // 真舊碼（bug 面）：無 SDK_INT 分支、直接用 MediaStore.Downloads
  assert.ok(!baseFn.includes('SDK_INT'), '真實舊碼應無 SDK_INT（bug 面）');
  assert.ok(baseFn.includes('MediaStore.Downloads'), '真實舊碼直接用 MediaStore.Downloads');
  // T1 偵測面對 baseFn 必紅：T1 斷言「含 SDK_INT>=29 分支」對舊碼 FAIL
  assert.ok(!baseFn.includes('Build.VERSION.SDK_INT >= 29'), 'T1 首斷言（SDK_INT>=29）對真實舊碼必 FAIL——bug 面重現');
});

test('T4 前提：compileSdk>=29（MediaStore.Downloads 需 API29+ 編譯支援）', () => {
  const m2 = GR.match(/compileSdk\s*=\s*(\d+)/);
  assert.ok(m2 && +m2[1] >= 29, `compileSdk 需 ≥29，實值 ${m2 ? m2[1] : '未解析'}`);
});

console.log('[verify-o3] KT 源 ' + (process.env.SRC_KT ? '樣本:' + process.env.SRC_KT : PIN) + ' · GR 源 ' + (process.env.SRC_GR ? '樣本:' + process.env.SRC_GR : PIN));