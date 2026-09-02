#!/usr/bin/env node
// verify-f10-piper-import.mjs — F10 import_piper_model_dialog Android 分支 + Kotlin DISPLAY_NAME
//
// 病灶（宿主不可直跑 android 運行時，證據鏈四段閉合）：
//   T0 cargo unit test：FilePath::Url（SAF content:// 載體）as_path() 恆 None
//      ＋ content:// into_path() 亦 Err（tauri-plugin-fs 真 crate，非 replica）
//   T1 lib.rs 結構釘：新函式含 cfg(android) match＋copy_uri_to_cache委派＋.onnx 檔名守門
//      ＋into_path() 桌面分支，旧 .ok_or("無效路徑") 抽取殲滅
//   T2 負控制：舊函式直接從 git 基準 12e9978 提取（真舊碼非編造，基準寫死防浮動）——
//      含 as_path().ok_or 抽取＋零 target_os 分支；疊 T0 釘＝Android 必然 Err 鏈完整；
//      反換（还原旧函数到工作檔）T1 即紅
//   T3 鏡像釘：同檔 import_db_dialog 既有正确模式（cfg+copy_uri_to_cache）存在且未被破坏
//   T4 編譯釘：host cargo check ＋ aarch64-linux-android 交叉 cargo check（NDK env）
//      —— android 分支只可編譯級驗證，運行時需用戶真機（計畫書 §4 誠實範圍）
//   T5 Kotlin 結構釘：copyUriToCache 以 ContentResolver.query(DISPLAY_NAME) 取真實檔名落地
//      ＋sanitize＋ //.///.. 兜底 import.db；.db 匯入鏈 DISPLAY_NAME 照樣 .db（任務書①要求）
//   T6 Kotlin 負控制：舊碼（git 12e9978 TtsPlugin.kt）硬編碼 File(cacheDir,"import.db")
//      ——固定名令 piper 匯入仍 100% 敗（collect_piper_voices 以檔名建語音目錄）；反換已實作（T5 即紅）
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = '/home/jupiter/teno';
const LIB = ROOT + '/src-tauri/src/lib.rs';
const KT = ROOT + '/src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt';
const NDK = process.env.HOME + '/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin';
const BASE = '12e9978'; // 基準 HEAD（寫死防浮動 ref，勿改浮動 ref）
const src = readFileSync(LIB, 'utf8');
const kt = readFileSync(KT, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  «' + extra + '»' : ''}`); }
};
const grabFn = (s, name) => {
  // 支援 Rust `fn / async fn` 與 Kotlin `fun`
  const prefix = s.includes('fun ' + name) && !s.includes('fn ' + name) ? 'fun ' : 'fn ';
  const m = s.indexOf(prefix + name);
  if (m < 0) throw new Error(`fn/fun ${name} not found`);
  const start = s.slice(m - 6, m) === 'async ' ? m - 6 : m;
  const open = s.indexOf('{', m);
  let depth = 0, i = open;
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) break; }
  }
  return s.slice(start, i + 1);
};
const CARGO_BIN = process.env.HOME + '/.cargo/bin';
const PATH_PREFIX = `export PATH=${CARGO_BIN}:$PATH && `;
const sh = (cmd, opts = {}) => {
  try { return { out: execSync(PATH_PREFIX + cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};
const ANDROID_ENV = `export CC_aarch64_linux_android=${NDK}/aarch64-linux-android21-clang AR_aarch64_linux_android=${NDK}/llvm-ar CXX_aarch64_linux_android=${NDK}/aarch64-linux-android21-clang++ CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=${NDK}/aarch64-linux-android21-clang && `;

// ── T0: cargo unit tests（真 crate 機制釘 + piper 回歸） ──────────────
console.log('== T0: cargo unit tests (piper 全集) ==');
{
  const r = sh('cd src-tauri && cargo test --lib piper 2>&1', { timeout: 600000 });
  ok('cargo test piper 全綠', r.code === 0 && /test result: ok\./.test(r.out));
  ok('T0-釘1 url_variant_as_path_is_always_none PASS', /test import_piper_path_tests::url_variant_as_path_is_always_none \.\.\. ok/.test(r.out));
  ok('T0-釘2 content_uri_into_path_also_fails PASS', /test import_piper_path_tests::content_uri_into_path_also_fails \.\.\. ok/.test(r.out));
  ok('T0-釘3 path_variant_exposes_path PASS', /test import_piper_path_tests::path_variant_exposes_path \.\.\. ok/.test(r.out));
  ok('piper_url_tests 13 條回歸在册', (r.out.match(/piper_url_tests::/g) || []).length >= 13);
}

// ── T1: 新函式結構釘 ──────────────────────────────────────────────────
console.log('== T1: import_piper_model_dialog 結構 ==');
let newFn = '';
try {
  newFn = grabFn(src, 'import_piper_model_dialog');
  ok('非同步化（oneshot+pick_file 鏡同檔 import_db_dialog）', /^async fn import_piper_model_dialog/.test(newFn) && newFn.includes('oneshot::channel') && newFn.includes('.pick_file('));
  ok('Android 分支存在 cfg(target_os = "android")', newFn.includes('#[cfg(target_os = "android")]'));
  ok('FilePath::Path/Url 雙分支 match', newFn.includes('FilePath::Path(p)') && newFn.includes('FilePath::Url(u)'));
  ok('Url 委派 copy_uri_to_cache（現成 content:// 鏈）', newFn.includes('copy_uri_to_cache(app_handle.clone(), u.to_string())'));
  ok('桌面对应 file://：cfg(not(android)) 走 into_path()', newFn.includes('#[cfg(not(target_os = "android"))]') && newFn.includes('.into_path()'));
  ok('bug 面 as_path() 抽取殲滅（FilePath::as_path 零殘留）', !newFn.includes('.as_path()'));
  ok('.onnx 檔名守門', newFn.includes('ends_with(".onnx")'));
  ok('落地錯有上下文（複製模型失敗 帶 e）', newFn.includes('複製模型失敗'));
  ok('回呼只 send 一次（oneshot 雙發=panic 防範）', (newFn.match(/tx\.send\(/g) || []).length === 1);
  ok('add_filter onnx 保留', newFn.includes('add_filter("Piper 語音模型", &["onnx"])'));
} catch (e) { ok('import_piper_model_dialog 可提取', false, e.message); }

// ── T2: 負控制 — 真舊碼提取（基準寫死）+ 反換 ─────────────────────
console.log(`== T2: 負控制（git ${BASE} 舊碼面） ==`);
try {
  const oldSrc = execSync(`git show ${BASE}:src-tauri/src/lib.rs`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const oldFn = grabFn(oldSrc, 'import_piper_model_dialog');
  ok('舊碼用 as_path().ok_or 抽取（Android 恆 None→Err，疊 T0-釘1）', oldFn.includes('as_path()') && oldFn.includes('ok_or("無效路徑")'));
  ok('舊碼零 cfg(target_os) 分支（Android 必走死路）', !oldFn.includes('target_os'));
  ok('舊碼零 copy_uri_to_cache 委派', !oldFn.includes('copy_uri_to_cache'));
  // 反換：舊函式塞回工作檔 → T1 斷言必紅（bug 面精準重現：死抽取回位；回呼避免 $&/$' 替換模式地雷）
  const swapped = src.replace(newFn, () => oldFn);
  const swFn = grabFn(swapped, 'import_piper_model_dialog');
  ok('反換後死抽取回位（T1 殲滅釘將紅＝本腳本报 FAIL）', swFn.includes('ok_or("無效路徑")') && !swFn.includes('target_os'));
} catch (e) { ok('舊碼提取', false, String(e).slice(0, 120)); }

// ── T3: 鏡像慣例釘 — import_db_dialog 正確模式未被破坏 ────────────────
console.log('== T3: import_db_dialog 鏡像慣例 ==');
try {
  const dbFn = grabFn(src, 'import_db_dialog');
  ok('import_db_dialog 仍含 cfg(android)＋copy_uri_to_cache', dbFn.includes('#[cfg(target_os = "android")]') && dbFn.includes('copy_uri_to_cache(app_handle.clone(), u.to_string())'));
  ok('兩函式 android 抽取語意逐字同構（Path/Url match）', (dbFn.includes('FilePath::Path(p) => p,') && newFn.includes('FilePath::Path(p) => p,')));
} catch (e) { ok('import_db_dialog 提取', false, e.message); }

// ── T4: 雙目標編譯釘 ──────────────────────────────────────────────────
console.log('== T4: cargo check host + android 交叉 ==');
{
  const h = sh('cd src-tauri && cargo check --quiet 2>&1', { timeout: 600000 });
  ok('host cargo check 綠', h.code === 0, h.out.slice(-200));
  const a = sh(ANDROID_ENV + 'cd src-tauri && cargo check --quiet --target aarch64-linux-android 2>&1', { timeout: 600000 });
  ok('aarch64-linux-android cargo check 綠（android 分支編譯級驗證）', a.code === 0, a.out.slice(-200));
}

// ── T5: Kotlin 結構釘 — copyUriToCache DISPLAY_NAME ───────────────────
console.log('== T5: TtsPlugin.kt copyUriToCache DISPLAY_NAME ==');
let ck = '';
try {
  ck = grabFn(kt, 'copyUriToCache');
  ok('ContentResolver.query 抓 DISPLAY_NAME', ck.includes('OpenableColumns.DISPLAY_NAME') && ck.includes('resolver.query('));
  ok('非硬編碼 import.db 落地（真實檔名變數化）', ck.includes('java.io.File(activity.cacheDir, name)') && !ck.includes('File(activity.cacheDir, "import.db")'));
  ok('sanitize 路徑穿越守門（/ \\ 換 _）', ck.includes('[/\\\\\\\\]') && ck.includes('.filter { it.code in 32..126 }'));
  ok('//.///.. 兜底 import.db', ck.includes('name == "."') && ck.includes('name == ".."'));
  ok('db 鏈相容：import.db 仍為兜底預設', ck.includes('var name = "import.db"'));
} catch (e) { ok('copyUriToCache 可提取', false, e.message); }

// ── T6: Kotlin 負控制 — 舊碼固定名（基準寫死）────────────────────────
console.log(`== T6: Kotlin 負控制（git ${BASE} 固定 import.db） ==`);
try {
  const oldKt = execSync(`git show ${BASE}:src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  const oldCk = grabFn(oldKt, 'copyUriToCache');
  ok('舊碼硬編碼 File(cacheDir,"import.db")（piper 固定檔名籤）', oldCk.includes('File(activity.cacheDir, "import.db")') && !oldCk.includes('DISPLAY_NAME'));
  // 反換：舊函式塞回工作檔（回呼避免 $&/$' 替換模式地雷）→ T5 斷言必紅
  const swKt = kt.replace(ck, () => oldCk);
  const swCk = grabFn(swKt, 'copyUriToCache');
  ok('反換後固定名回位＋零 DISPLAY_NAME（T5 硬編碼殲滅釘將紅＝本腳本报 FAIL）',
    swCk.includes('File(activity.cacheDir, "import.db")') && !swCk.includes('DISPLAY_NAME'));
} catch (e) { ok('舊碼提取', false, String(e).slice(0, 120)); }

console.log(`\n== F10 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);