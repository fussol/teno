#!/usr/bin/env node
// verify-f16-csv-data.mjs — F16 死命令 export_csv_data 殲滅驗證
// 雙態：動工前 T1 紅（徵狀在位）；動工後全綠。T2 負控制 pin 1695638（F15 後態）。
// 環境同 F15：PATH 前置 ~/.cargo/bin＋NDK 四件套（假紅先復測再歸因）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

process.env.PATH = `${join(homedir(), '.cargo/bin')}:${process.env.PATH}`;
const NDK = `${homedir()}/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin`;
Object.assign(process.env, {
  CC_aarch64_linux_android: `${NDK}/aarch64-linux-android21-clang`,
  CXX_aarch64_linux_android: `${NDK}/aarch64-linux-android21-clang++`,
  AR_aarch64_linux_android: `${NDK}/llvm-ar`,
  CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: `${NDK}/aarch64-linux-android21-clang`,
});

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const LIB = join(ROOT, 'src-tauri/src/lib.rs');
const OLD_PIN = '1695638'; // F15 commit＝動工前正宗態（export_csv_data 在位）

let pass = 0, fail = 0;
const T = (name, cond, note = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${note}»`); }
};

// 掃描器（T1/T2 共用同牙）：\b 邊界防近似名 export_csv_dialog 誤入/誤放
function scan(src) {
  const m = src.match(/generate_handler!\[([^\]]+)\]/);
  const cmds = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  return {
    hits: (src.match(/\bexport_csv_data\b/g) || []).length,
    dialogHits: (src.match(/\bexport_csv_dialog\b/g) || []).length,
    cmds,
  };
}

// 動工後正解清單（42 - export_csv_data = 41）
const EXPECTED_CMDS = [
  'log_msg','run_cli','get_app_paths','speak_text','fetch_llm','fetch_get',
  'lookup_cambridge','list_piper_voices','scrape_quizlet','write_db_bytes',
  'import_db_dialog','export_db_dialog','export_csv_dialog',
  'export_db_data','export_backup_data','backup_db','prune_backups','get_db_mtime',
  'list_backups','restore_backup','delete_backup','export_backup_dialog',
  'import_piper_model_dialog','install_piper_model','delete_piper_model',
  'tts_android::speak_android','tts_android::finish_app','optimize_fsrs',
  'simulate_fsrs','tts_android::stop_android','tts_android::list_voices_android',
  'tts_android::save_export_file','icon_android::set_launcher_icon',
  'icon_android::get_launcher_icon','icon_android::reset_app_log',
  'drive_sync::drive_save_creds','drive_sync::drive_oauth','drive_sync::drive_upload',
  'drive_sync::drive_download','drive_sync::drive_status','drive_sync::drive_logout',
];

console.log('== T1: 現行 lib.rs 殲滅釘（動工前=RED 是預期徵狀）==');
const cur = readFileSync(LIB, 'utf8');
const s1 = scan(cur);
T('T1a \\bexport_csv_data\\b 全檔零（含註解；詞邊界天然放行近似名 dialog）', s1.hits === 0, `hits=${s1.hits}`);
T('T1b 近似名活命令 export_csv_dialog 未誤傷（註冊＋fn ≥2 在位）', s1.dialogHits >= 2, `dialog=${s1.dialogHits}`);
T('T1c generate_handler 無 export_csv_data', !s1.cmds.includes('export_csv_data'));
T('T1d 命令計數 41（42-1）', s1.cmds.length === 41, `got=${s1.cmds.length}`);
const missing = EXPECTED_CMDS.filter(c => !s1.cmds.includes(c));
const extra = s1.cmds.filter(c => !EXPECTED_CMDS.includes(c));
T('T1e 其餘 41 命令逐一在位', missing.length === 0, `missing=${missing.join(',')}`);
T('T1f 幽靈命令零', extra.length === 0, `extra=${extra.join(',')}`);

console.log('== T2: 負控制——F15 後舊 blob 同掃描器徵狀全響 ==');
let old = '';
try {
  old = execFileSync('git', ['show', `${OLD_PIN}:src-tauri/src/lib.rs`], { maxBuffer: 32 * 1024 * 1024 }).toString();
} catch (e) { T('T2 舊 blob 可取', false, e.message.slice(0, 80)); }
if (old) {
  const s2 = scan(old);
  T('T2a 舊態 export_csv_data 在位（fn+註冊=2 hits）', s2.hits === 2, `hits=${s2.hits}`);
  T('T2b 舊態 handler 含之且計數 42', s2.cmds.includes('export_csv_data') && s2.cmds.length === 42, `n=${s2.cmds.length}`);
  T('T2c 判別性：同掃描器新態歸零＋計數嚴格少於舊態', s1.hits === 0 && s2.hits === 2 && s1.cmds.length < s2.cmds.length);
}

console.log('== T3: JS 側呼叫恆常釘（死 wrapper 永不可被接上）==');
T('T3-0 src/ 存在', existsSync(join(ROOT, 'src')));
// 呼叫形態 exportCsvData( ：api.js:107 定義端 "exportCsvData = (" 因空格+等號天然不匹配；
// import 端無括號——只有真呼叫會匹配
const jsDir = join(ROOT, 'src');
let calls = '';
try { calls = execFileSync('grep', ['-rn', '-E', 'exportCsvData\\(', jsDir], { encoding: 'utf8' }); } catch (e) { /* 無命中=正解 */ }
T('T3a src/ exportCsvData( 呼叫計數 0', calls.trim() === '', calls.trim().split('\n').filter(Boolean).join(' | '));
// wrapper 已撤（F16-SR1 落地）：死 wrapper exportCsvData 已從 api.js 刪除——本釘翻轉為「必須已撤」
const apiJs = readFileSync(join(jsDir, 'lib/api.js'), 'utf8');
T('T3b wrapper 已撤（F16-SR1：exportCsvData 不復存在）', !/export const exportCsvData = /.test(apiJs));

console.log('== T4: 產品矩陣編譯閘 + 測試計數 ==');
function cargo(args, ms = 300000) {
  try { return execFileSync('cargo', args, { cwd: join(ROOT, 'src-tauri'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { return `__ERR__${(e.stderr || e.stdout || e.message).toString().slice(0, 400)}`; }
}
const c1 = cargo(['check', '--quiet']);
T('T4a cargo check host 綠', !c1.includes('__ERR__'), (c1.match(/error\[??.*/) || [''])[0]);
const c2 = cargo(['check', '--quiet', '--target', 'aarch64-linux-android']);
T('T4b aarch64-linux-android 綠', !c2.includes('__ERR__'), (c2.match(/error\[??.*/) || c2.slice(0, 120)));
let out = '';
try { out = execFileSync('cargo', ['test', '--lib'], { cwd: join(ROOT, 'src-tauri'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 420000, maxBuffer: 32 * 1024 * 1024 }); }
catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
const mRes = out.match(/(\d+) passed; (\d+) failed;.*?(\d+) filtered out/);
const total = mRes ? (+mRes[1] + +mRes[2] + +mRes[3]) : -1;
T('T4c cargo test --lib 總數≥42（計數下限釘）', total >= 42, `total=${total}`);
T('T4d passed≥39 且 f≤3（預存 sim fixture 紅容忍上限）', mRes && +mRes[1] >= 39 && +mRes[2] <= 3, mRes ? `p=${mRes[1]} f=${mRes[2]}` : 'no result line');

console.log(`\n== F16 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
