#!/usr/bin/env node
// verify-f12-curl-to-ureq.mjs — F12 curl 殲滅（Android 無 curl）＋ 404 中毒鏈根治
//
// 證據鏈（負控制無 git ref 面——F9 教訓：負控制基準禁浮動 ref）：
//   T0 cargo unit：piper 全集 21（F9 13 + F12 新向量 7：query 尾×2/大寫網域×2/
//      前綴邊界等價×2 + R1 返修 panic 釘 multibyte×1；F10 測不在 piper 篩選集）
//   T1 真網整合：TENO_NET_TEST=1 cargo test --test f12_download
//      （HF resolve 302→cdn-lfs 實鏈 200 ＋ 404→Err+零落盤根治釘 ＋ 垃圾 URL）
//   T2 結構釘 ×8：lib.rs Command::new("curl") 殲滅；scrape ureq+UA+https-only
//      保留；check_fetch_get_url F8 政策函數原樣（零碰）；parse 去尾+大小寫鏈
//      在位；下載閉包委派＋json best-effort 語意；ureq agent 時限對齊註解
//   T3 負控制（純徵狀面，零 git ref）：裸 curl 舊碼同款旗標（-sL 無 -f）打
//      404 → exit 0 ＋ 垃圾「Entry not found」落盤 ＝ 中毒鏈 bug 精準重現；
//      與 T1 404 腿（ureq Err+零落盤）形成新舊對照
//   T4 編譯釘：host ＋ aarch64-linux-android 交叉（NDK env）
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as rd } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/home/jupiter/teno';
const LIB = ROOT + '/src-tauri/src/lib.rs';
const NDK = process.env.HOME + '/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin';
const src = readFileSync(LIB, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  «' + extra.slice(0, 300) + '»' : ''}`); }
};
const sh = (cmd, opts = {}) => {
  try { return { out: execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ANDROID_ENV = `export CC_aarch64_linux_android=${q(NDK + '/aarch64-linux-android21-clang')} AR_aarch64_linux_android=${q(NDK + '/llvm-ar')} CXX_aarch64_linux_android=${q(NDK + '/aarch64-linux-android21-clang++')} CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=${q(NDK + '/aarch64-linux-android21-clang')} && `;

// ── T0: cargo unit（piper 全集 21） ───────────────────────────────────
console.log('== T0: cargo unit tests ==');
{
  const r = sh('cd src-tauri && cargo test --lib piper 2>&1', { timeout: 600000 });
  ok('cargo test piper 全綠＋計數下限 20（R1#1 nit 採納：防子孫刪測試 vacuous 綠，同 F9 泛化教訓）',
    r.code === 0 && /test result: ok\.\s+(2[0-9]|[3-9][0-9]) passed; 0 failed/.test(r.out), r.out);
  ok('R1 返修釘 multibyte_prefix_no_panic 在冊', /multibyte_prefix_no_panic \.\.\. ok/.test(r.out));
  ok('F12 向量 download_button_query_tail_stripped 在冊', /download_button_query_tail_stripped \.\.\. ok/.test(r.out));
  ok('F12 向量 uppercase_host_accepted 在冊', /uppercase_host_accepted \.\.\. ok/.test(r.out));
  ok('F12 向量 owner_named_hfco_equivalence 在冊', /owner_named_hfco_equivalence_with_old_chain \.\.\. ok/.test(r.out));
}

// ── T1: 真網整合（HF 實鏈 + 404 零落盤） ─────────────────────────────
console.log('== T1: TENO_NET_TEST=1 cargo test --test f12_download ==');
let t1out = '';
{
  const r = sh('cd src-tauri && TENO_NET_TEST=1 cargo test --test f12_download 2>&1', { timeout: 600000 });
  t1out = r.out;
  ok('整合 4/4 綠（真 HF 302 鏈＋404 零落盤＋中斷半成品＋垃圾 URL）', r.code === 0 && /4 passed/.test(r.out), r.out);
}

// ── T2: 結構釘 ────────────────────────────────────────────────────────
console.log('== T2: 結構釘 ==');
{
  ok('lib.rs Command::new("curl") 全殲滅', !src.includes('Command::new("curl")'));
  ok('scrape_quizlet ureq 化（get+UA+call）', /fn scrape_quizlet[\s\S]{0,1600}?agent\.get\(&url\)[\s\S]*?User-Agent[\s\S]*?\.call\(\)/.test(src));
  ok('scrape_quizlet https-only 前置保留', /fn scrape_quizlet[\s\S]{0,400}?starts_with\("https:\/\/"\)/.test(src));
  // R1#1 次要#1（EVIL4 封死）：scrape 錯誤必傳播——.call() 結果須 .map_err，
  // 殲滅『.call().ok()?／吞狀態碼』假修法（該變體可騙過其餘 T2 腿的半開通道）
  ok('scrape_quizlet 錯誤傳播釘（.call()→map_err，EVIL4 通道封死）',
    /fn scrape_quizlet[\s\S]*?\.call\(\)\s*\.map_err\(/.test(src));
  ok('F8 政策函數 check_fetch_get_url 原樣（localhost 三路徑釘）', src.includes('Some(url::Host::Ipv6(ip)) if ip == std::net::Ipv6Addr::LOCALHOST'));
  ok('parse_piper_url 去 query/fragment 尾在位', src.includes("split(['?', '#'])"));
  ok('parse_piper_url 大小寫不敏感前綴鏈在位', src.includes('eq_ignore_ascii_case(pref)'));
  ok('download_url_to_file 先 call 後建檔（中毒鏈次序釘）', /let resp = agent\.get\(url\)[\s\S]{0,200}?\.call\(\)[\s\S]{0,300}?File::create\(dest\)/.test(src));
  ok('下載中斷刪半成品', /io::copy\(&mut reader, &mut f\)[\s\S]{0,160}?remove_file\(dest\)/.test(src));
  const closure = src.slice(src.indexOf('fn install_piper_model'), src.indexOf('fn install_piper_model') + 2500);
  ok('install 閉包委派 onnx(120s)+json(30s)', /download_url_to_file\(&onnx_url, &dest, 120\)/.test(closure) && /download_url_to_file\(&json_url, &dest_json, 30\)/.test(closure));
  ok('json sidecar best-effort 語意保留（失敗僅刪檔）', /if download_url_to_file\(&json_url, &dest_json, 30\)\.is_err\(\)/.test(closure));
}

// ── T3: 負控制 — 舊 curl 旗標中毒鏈徵狀重現（純徵狀面，零 git ref） ──
console.log('== T3: 負控制（裸 curl 舊旗標 vs 徵狀） ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'f12-neg-'));
  try {
    const ghost = join(dir, 'ghost.onnx');
    // 舊 install_piper_model 同款旗標：-sL 無 -f
    const r = sh(`curl -sL --max-time 30 --connect-timeout 10 -o ${q(ghost)} -- ${q('https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ghost-voice-xyz/low/en_US-ghost-voice-xyz-low.onnx')}`);
    ok('舊旗標 404 → exit 0（中毒鏈第一徵狀：狀態語意丢失）', r.code === 0);
    ok('舊旗標 404 → 垃圾落盤（中毒鏈第二徵狀：錯誤頁存成 .onnx）',
      existsSync(ghost) && rd(ghost, 'utf8').includes('Entry not found'),
      existsSync(ghost) ? rd(ghost, 'utf8').slice(0, 80) : 'file absent');
    // 對照面：同 URL ureq 路徑 → Err+零落盤（本腳本 T1 整合腿實跑）
    ok('對照腿：T1 http_404_errs_and_never_creates_file 已實跑綠（ureq 同 URL Err+零落盤）',
      /http_404_errs_and_never_creates_file \.\.\. ok/.test(t1out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── T4: 雙目標編譯 ────────────────────────────────────────────────────
console.log('== T4: cargo check host + android ==');
{
  const h = sh('cd src-tauri && cargo check --quiet 2>&1', { timeout: 600000 });
  ok('host cargo check 綠', h.code === 0, h.out);
  const a = sh(ANDROID_ENV + 'cd src-tauri && cargo check --quiet --target aarch64-linux-android 2>&1', { timeout: 600000 });
  ok('aarch64-linux-android cargo check 綠', a.code === 0, a.out);
}

console.log(`\n== F12 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
