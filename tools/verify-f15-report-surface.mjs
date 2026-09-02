#!/usr/bin/env node
// verify-f15-report-surface.mjs — F15 open_report 死面殲滅驗證
// 雙態：動工前跑＝T1 徵狀全響（RED）；動工後跑＝全綠。T2 負控制以 HEAD~ 舊 blob
// 餵同一掃描器自證有牙。T4 產品矩陣雙 target 編譯閘。
// 環境：PATH 前置 ~/.cargo/bin（android target 只在那裡，系統 cargo 假紅——F14 判例）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

process.env.PATH = `${join(homedir(), '.cargo/bin')}:${process.env.PATH}`;
// NDK 交叉工具鏈（F12 同款 env 四件套，缺則 ring build script 假紅）
const NDK = `${homedir()}/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin`;
Object.assign(process.env, {
  CC_aarch64_linux_android: `${NDK}/aarch64-linux-android21-clang`,
  CXX_aarch64_linux_android: `${NDK}/aarch64-linux-android21-clang++`,
  AR_aarch64_linux_android: `${NDK}/llvm-ar`,
  CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: `${NDK}/aarch64-linux-android21-clang`,
});

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim();
const LIB = join(ROOT, 'src-tauri/src/lib.rs');
const OLD_PIN = '19edaf9'; // F14 commit＝動工前正宗態（open_report 在位）

let pass = 0, fail = 0;
const T = (name, cond, note = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  «${note}»`); }
};

// 掃描器：對「任意 lib.rs 內容」抽取 F15 徵狀面（T1 現行態與 T2 舊 blob 共用＝同牙）
function scan(src) {
  const m = src.match(/generate_handler!\[([^\]]+)\]/);
  const cmds = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  return {
    openReportHits: (src.match(/open_report/g) || []).length,
    builderHits: (src.match(/WebviewWindowBuilder/g) || []).length,
    urlHits: (src.match(/WebviewUrl/g) || []).length,
    fileProtoHits: (src.match(/file:\/\//g) || []).length,
    cmds,
  };
}

// 動工後正解清單（43 - open_report = 42，逐一釘死防順手誤刪）
// F16 演化（S-2 同步釘）：42→41，export_csv_data 死命令已由 F16 殲滅。
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
T('T1a open_report token 全檔零（含註解/字串——留屍即紅）', s1.openReportHits === 0, `hits=${s1.openReportHits}`);
T('T1b WebviewWindowBuilder 零（lib.rs 唯一構造者已殲）', s1.builderHits === 0, `hits=${s1.builderHits}`);
T('T1c WebviewUrl 零', s1.urlHits === 0, `hits=${s1.urlHits}`);
T('T1d file:// 零', s1.fileProtoHits === 0, `hits=${s1.fileProtoHits}`);
T('T1e generate_handler 無 open_report', !s1.cmds.includes('open_report'));
T('T1f 命令計數 41（F15 42-1=F16 export_csv_data 同殲）', s1.cmds.length === 41, `got=${s1.cmds.length}`);
const missing = EXPECTED_CMDS.filter(c => !s1.cmds.includes(c));
const extra = s1.cmds.filter(c => !EXPECTED_CMDS.includes(c));
T('T1g 其餘 41 命令逐一在位（防順手誤刪）', missing.length === 0, `missing=${missing.join(',')}`);
T('T1h 幽靈命令零（清單無 Expected 之外的 token）', extra.length === 0, `extra=${extra.join(',')}`);

console.log('== T2: 負控制——舊 blob 餵同一掃描器，徵狀必須全響（腳本有牙）==');
let old = '';
try {
  old = execFileSync('git', ['show', `${OLD_PIN}:src-tauri/src/lib.rs`], { maxBuffer: 32 * 1024 * 1024 }).toString();
} catch (e) { T('T2 舊 blob 可取', false, e.message.slice(0, 80)); }
if (old) {
  const s2 = scan(old);
  T('T2a 舊態 open_report 在位（定義+註冊 ≥2 hits）', s2.openReportHits >= 2, `hits=${s2.openReportHits}`);
  T('T2b 舊態 builder/External 在位', s2.builderHits >= 1 && s2.urlHits >= 1 && s2.fileProtoHits >= 1);
  T('T2c 舊態 handler 含 open_report 且計數 43', s2.cmds.includes('open_report') && s2.cmds.length === 43, `n=${s2.cmds.length}`);
  T('T2d 判別性：新態歸零＋計數嚴格少於舊態（同掃描器非两套牙）', s1.openReportHits < s2.openReportHits && s1.cmds.length < s2.cmds.length, `new=${s1.openReportHits}/${s1.cmds.length} old=${s2.openReportHits}/${s2.cmds.length}`);
}

console.log('== T3: 消費者恆常釘（src/ 對 open_report 的 invoke 必須永遠=0）==');
// R1#2 建議①吸收：目錄缺失與無命中同 exit1 不可分辨＝空轉假綠，先釘存在性
T('T3-0 src/ 目錄存在（防重構改名後掃描空轉假綠）', existsSync(join(ROOT, 'src')));
let consumers = '';
try {
  consumers = execFileSync('grep', ['-rn', '--include=*.js', 'open_report', join(ROOT, 'src')], { encoding: 'utf8' });
} catch (e) { /* grep 無命中 exit 1 = 正解 */ }
T('T3 src/**/*.js invoke open_report 計數 0', consumers.trim() === '', consumers.split('\n').length + ' 行命中');

console.log('== T4: 產品矩陣編譯閘 + 測試計數 ==');
function cargo(args, ms = 240000) {
  try { return execFileSync('cargo', args, { cwd: join(ROOT, 'src-tauri'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { return `__ERR__${(e.stderr || e.stdout || e.message).toString().slice(0, 400)}`; }
}
const c1 = cargo(['check', '--quiet']);
T('T4a cargo check host 綠', !c1.includes('__ERR__'), (c1.match(/error\[??.*/) || [''])[0]);
const c2 = cargo(['check', '--quiet', '--target', 'aarch64-linux-android']);
T('T4b cargo check aarch64-linux-android 綠', !c2.includes('__ERR__'), (c2.match(/error\[??.*/) || c2.slice(0, 120)));
let out = '';
try {
  out = execFileSync('cargo', ['test', '--lib', '--', '--format', 'terse'], { cwd: join(ROOT, 'src-tauri'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 420000, maxBuffer: 32 * 1024 * 1024 });
} catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
// terse 行: "test result: ok. 39 passed; 0 failed; ... 42 filtered out" 或 agent 格式；穩健起見跑普通格式重取
if (!/test result/.test(out)) {
  try { out = execFileSync('cargo', ['test', '--lib'], { cwd: join(ROOT, 'src-tauri'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 420000, maxBuffer: 32 * 1024 * 1024 }); }
  catch (e) { out += (e.stdout || '') + (e.stderr || ''); }
}
const mRes = out.match(/(\d+) passed; (\d+) failed;.*?(\d+) filtered out/);
const total = mRes ? (+mRes[1] + +mRes[2] + +mRes[3]) : -1;
// 計數下限釘：總測試數 42（F15 純刪除不加測），pass≥39（sim_tests 3 紅=外部 fixture 預存，F14 log R1#3 認定非本帳）
T('T4c cargo test --lib 總數≥42（計數下限釘防子孫刪測 vacuous）', total >= 42, `total=${total}`);
T('T4d passed≥39（預存 sim fixture 3 紅容忍上限）', mRes && +mRes[1] >= 39 && +mRes[2] <= 3, mRes ? `p=${mRes[1]} f=${mRes[2]}` : 'no result line');

// ════════════════════════════════════════════════════════════════
// T5: F15-SR1 — report/compare CDN SRI + 內嵌 script CSP hash（4 實例）
// 真碼提取 finalizeReportHtml 跑單元測；負控制以 HEAD 舊 blob（裸 CDN）驗牙。
// ════════════════════════════════════════════════════════════════
console.log('\n== T5: F15-SR1 CDN SRI + CSP hash（兩鏡像 4 實例）==');
const CLI_FILES = ['tools/cli.mjs', '_dev/cli/cli.mjs'];
const CDN_OLD = 'https://cdn.jsdelivr.net/npm/chart.js';           // 病徵：裸/未釘

// 掃描器：對「任意 cli 內容」抽取 F15-SR1 徵狀面（新舊共用同牙）
function scanCli(src) {
  return {
    bareCdn: (src.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js"><\/script>/g) || []).length,
    pinsCdN: (src.match(/Chart\.js\/4\.4\.1\/chart\.umd\.min\.js/g) || []).length,
    intHit: (src.match(/integrity="sha512-CQBWl4fJHW/g) || []).length,
    hasHelper: /function finalizeReportHtml/.test(src),
    hasCspHash: /createHash\('sha256'\)/.test(src) && /digest\('base64'\)/.test(src) && /'sha256-/.test(src),
    hasEsc: /\\u003c|\\\\u003c/.test(src),
  };
}
let t5Ok = true;
for (const f of CLI_FILES) {
  const abs = join(ROOT, f);
  const cur = readFileSync(abs, 'utf8');
  const s = scanCli(cur);
  const base = f.split('/').pop();
  T(`T5A[${base}] 裸 CDN 四例清零（兩鏡像各 2 處 = 4 全滅）`, s.bareCdn === 0, `bare=${s.bareCdn}`);
  T(`T5B[${base}] CDN 釘版 4.4.1 cdnjs`, s.pinsCdN >= 2, `pin=${s.pinsCdN}`);
  T(`T5C[${base}] SRI integrity=sha512- 在位`, s.intHit >= 2, `int=${s.intHit}`);
  T(`T5D[${base}] finalizeReportHtml helper 在位`, s.hasHelper);
  T(`T5E[${base}] 生成期 sha256 CSP hash 邏輯 在位`, s.hasCspHash);
  T(`T5F[${base}] \\u003c 轉義在位`, s.hasEsc);
  T(`T5K[${base}] 模板尾 </script></body></html> 釘（防未來漏 </body> 走 fail-open 靜默降級）`, (cur.match(/<\/script><\/body><\/html>/g) || []).length >= 2, `tail=${(cur.match(/<\/script><\/body><\/html>/g) || []).length}`);
  if (s.bareCdn !== 0 || !s.hasHelper || s.pinsCdN < 2) t5Ok = false;
}

// T5 負控制：固定 pin 本顆動工前 HEAD（commit 後 HEAD 前進會使 HEAD: 指向修復版而自毀）
const F15SR1_OLD_PIN = 'a53a13c';
const oldCli = execFileSync('git', ['show', `${F15SR1_OLD_PIN}:tools/cli.mjs`], { maxBuffer: 32 * 1024 * 1024 }).toString();
const sOld = scanCli(oldCli);
T('T5-G 負控制：固定 pin 舊blob 裸 CDN 在位（≥2）+ 零 helper（同牙判別）', sOld.bareCdn >= 2 && !sOld.hasHelper, `bare=${sOld.bareCdn} helper=${sOld.hasHelper}`);
T('T5-H 判別性：修後 cdnjs pin 出現、裸 CDN 歸零（非兩邊空轉）', scanCli(readFileSync(join(ROOT, 'tools/cli.mjs'), 'utf8')).pinsCdN > sOld.pinsCdN && scanCli(readFileSync(join(ROOT, 'tools/cli.mjs'), 'utf8')).bareCdn === 0);

// T5-I 真碼提取單元測：抽出 tools/cli.mjs 的 finalizeReportHtml，餵注入樣本瞧輸出
try {
  const realSrc = readFileSync(join(ROOT, 'tools/cli.mjs'), 'utf8');
  const fnStart = realSrc.indexOf('function finalizeReportHtml');
  if (fnStart >= 0) {
    // 抓整顆函式（到大括號平衡）
    let d = 0, j = realSrc.indexOf('{', fnStart); let k = j;
    for (; k < realSrc.length; k++) { if (realSrc[k] === '{') d++; else if (realSrc[k] === '}') { d--; if (d === 0) break; } }
    const fnSrc = realSrc.slice(fnStart, k + 1);
    const tagSrc = (realSrc.match(/const CHART_CDN_TAG = '[^']*';/) || [''])[0];
    // 動態執行：提供 createHash 環境＋CHART_CDN_TAG（helper 引用之 module 常數）
    const { createHash } = await import('node:crypto');
    const mkReport = new Function('createHash', `${tagSrc}\n${fnSrc}\nreturn finalizeReportHtml;`)(createHash);
    const sample = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>\n<script src="${CDN_OLD}"></script></head><body><script>\nconst a=["</script><img onerror=alert(1)>"];\nconst b=["x</script></body><img onerror=alert(2)>"];\nnew Chart(document.getElementById('c1'),{data:${JSON.stringify(['x</script><img onerror=alert(1)>', 'y</script></body><img onerror=alert(2)>'])}});\n</script></body></html>`;
    const out = mkReport(sample);
    T('T5-I1 helper 輸出得 CDN 釘版 cdnjs', out.includes('Chart.js/4.4.1') && !out.includes(CDN_OLD));
    T('T5-I2 helper 輸出含 SRI integrity', out.includes('integrity="sha512-CQBWl4fJHW'));
    // 內嵌 script 內 `<` 已轉義（無裸 </script>）
    const inl = out.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/g);
    T('T5-I3 meta CSP 寫入', !!inl && inl.length >= 1 && inl[0].includes('script-src'));
    const cspVal = inl ? (inl[0].match(/content="([^"]*)"/) || [])[1] : '';
    T('T5-I4 CSP 含 sha256- base64', /script-src[^"]*'sha256-[A-Za-z0-9+/=]{20,}'/.test(cspVal), cspVal.slice(0, 80));
    // 結構性注入斷言：攻擊樣本含直接相連＋偽造邊界（</script></body><img…) 兩變體；
    // 斷無逃逸序列＋無裸 <img onerror= node＋尾端 </script></body> 完整（m[2] 補回防尾端壞死）
    T('T5-I5 完整轉義（direct＋偽邊界兩變體無 /</script></body><img/ 逃逸＋尾端 </body>==1）',
      !out.includes('</script></body><img') && !out.includes('</script><img') && !/<img[^>]*onerror/.test(out)
      && (out.match(/<\/body>/g) || []).length === 1
      && /<\/script>\s*<\/body><\/html>/.test(out),
      `tail=/<\/body>×${(out.match(/<\/body>/g) || []).length}`);
  } else {
    T('T5-I 真碼提取 anchor 在位', false, 'finalizeReportHtml 缺失');
    t5Ok = false;
  }
} catch (e) { T('T5-I 真碼提取單元測可跑', false, e.message.slice(0, 120)); t5Ok = false; }

// T5-J node --check：cli.mjs 為合法 ESM（new Function 不接受 import，故用子行程）
try {
  const c1 = execFileSync('node', ['--check', join(ROOT, 'tools/cli.mjs')], { encoding: 'utf8' });
  const c2 = execFileSync('node', ['--check', join(ROOT, '_dev/cli/cli.mjs')], { encoding: 'utf8' });
  T('T5-J 兩鏡像 node --check 綠', true);
} catch (e) { T('T5-J node --check 綠', false, (e.stderr || e.message).slice(0, 120)); }

console.log(`\n== F15 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
