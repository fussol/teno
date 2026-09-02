#!/usr/bin/env node
// verify-f11.mjs — F11: OAuth client secret 硬編碼 + tokens/creds 明文 0644
// 雙態自適應：pre=未修法（bug 在場釘全綠）、post=修法後（全綠集）。
// 負控制 T5 恆常：pin 基線 9e3116b（F9 教訓：禁 HEAD 基準）跑同一掃描器斷言精準紅集。
// 嚴禁真連 Google API——全部離線靜態/編譯/微編譯斷言。
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = '/home/jupiter/teno';
const SRC = path.join(REPO, 'src-tauri/src/drive_sync.rs');
const BASELINE = '9e3116b'; // 本波基線（drive_sync.rs 含硬編碼之最後快照），hash 永不漂移
const FAKE_ID = 'F11FAKEID123';
const FAKE_SECRET = 'F11FAKESECR3T';
const ENV = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}${detail ? '  ← ' + detail : ''}`); }
}
function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-c', cmd], { encoding: 'utf8', cwd: REPO, env: ENV, timeout: 300000, ...opts });
}

// ── 掃描器（T1 與 T5 共用同一份——負控制有意義的前提）────────────────
function scanDriveSync(src) {
  // 函式體切段：頂層 fn 簽名 → 首個行首 }（Rust 頂層函式閉合大括號必貼行首）
  const bodyOf = (name) => {
    const i = src.indexOf(`fn ${name}(`);
    if (i < 0) return null;
    const j = src.indexOf('\n}\n', i);
    return j < 0 ? null : src.slice(i, j + 2);
  };
  const credsBody = bodyOf('save_creds');
  const tokensBody = bodyOf('save_tokens');
  return {
    hardcodedSecret: src.includes('GOCSPX-'),
    hardcodedId: src.includes('880245257428-'),
    envId: src.includes('option_env!("TENO_DRIVE_CLIENT_ID")'),
    envSecret: src.includes('option_env!("TENO_DRIVE_CLIENT_SECRET")'),
    writePrivateFn: /fn write_private\s*\(/.test(src),
    saveRawWrite: [credsBody, tokensBody].map(b => (b || '').includes('fs::write')).filter(Boolean).length,
    // R1#3-S2：正向釘——save 兩體必須實際呼叫 write_private(（堵 File::create/OpenOptions 繞道）
    saveCallsPrivate: [credsBody, tokensBody].map(b => (b || '').includes('write_private(')).filter(Boolean).length,
    _bodiesPresent: credsBody !== null && tokensBody !== null,
  };
}

const src = fs.readFileSync(SRC, 'utf8');
const w = scanDriveSync(src);
const state = w.hardcodedSecret ? 'PRE' : 'POST';
console.log(`F11 verify — 狀態偵測: ${state}（工作區 GOCSPX- ${w.hardcodedSecret ? '在場' : '缺席'}）\n`);

// ── T1 源碼靜態釘 ───────────────────────────────────────────────
console.log('T1 源碼靜態釘:');
if (state === 'POST') {
  ok(!w.hardcodedSecret, 'T1a 零 GOCSPX- 洩漏字串');
  ok(!w.hardcodedId, 'T1b 零 client_id 硬編碼字面值');
  ok(w.envId, 'T1c option_env!(CLIENT_ID) 在場');
  ok(w.envSecret, 'T1d option_env!(CLIENT_SECRET) 在場');
  ok(w.writePrivateFn, 'T1e fn write_private 在場');
  ok(w._bodiesPresent && w.saveRawWrite === 0, 'T1f save_creds/save_tokens 零 fs::write 直寫', `saveRawWrite=${w.saveRawWrite}`);
  ok(w._bodiesPresent && w.saveCallsPrivate === 2, 'T1g save 兩體皆實呼 write_private(（反繞道釘）', `saveCallsPrivate=${w.saveCallsPrivate}`);
} else {
  // pre 態：bug 在場釘（全綠＝bug 確認，非修法正確）
  ok(w.hardcodedSecret === true, 'T1p-a bug 在場: GOCSPX- 硬編碼secret');
  ok(w.hardcodedId === true, 'T1p-b bug 在場: client_id 硬編碼');
  ok(w.envId === false && w.envSecret === false, 'T1p-c bug 在場: 無 env 注入鏈');
  ok(w.writePrivateFn === false, 'T1p-d bug 在場: 無 write_private');
  ok(w._bodiesPresent && w.saveRawWrite === 2, 'T1p-e bug 在場: 兩 save 皆裸 fs::write', `saveRawWrite=${w.saveRawWrite}`);
  ok(w.saveCallsPrivate === 0, 'T1p-f bug 在場: save 零 write_private 呼叫', `=${w.saveCallsPrivate}`);
}

// ── T2 cargo 單元測試牙 ─────────────────────────────────────────
console.log('T2 cargo test drive_sync:');
const t2 = sh('cd src-tauri && cargo test --offline drive_sync 2>&1');
const t2out = t2.stdout + t2.stderr;
const t2green = /test result: ok\./.test(t2out) && t2.status === 0;
const hasNewTests = t2out.includes('f11_no_hardcoded_oauth_secret') && t2out.includes('f11_write_private_0600');
if (state === 'POST') {
  ok(t2green, 'T2a cargo test drive_sync 全綠');
  ok(hasNewTests, 'T2b 新單元測試 f11_* 存在且執行', t2green ? '' : '測試未跑出');
} else {
  ok(t2green, 'T2p-a 基線 cargo test 綠（既有 4 測試）');
  ok(!hasNewTests, 'T2p-b 新測試未搶跑（源碼釘與測試同步落地）');
}

// ── T3 零憑證可編譯（務實可 build 直接證據）───────────────────────
console.log('T3 零 env cargo check:');
const t3 = sh('cd src-tauri && env -u TENO_DRIVE_CLIENT_ID -u TENO_DRIVE_CLIENT_SECRET cargo check --offline 2>&1');
ok(t3.status === 0, 'T3 無任何 TENO_DRIVE_* env 照常編譯', (t3.stdout + t3.stderr).split('\n').filter(l => l.startsWith('error')).slice(0, 3).join(' | '));

// ── T4 注入真嵌入（僅 POST；pre 態無 option_env! 鏈，注入無義）────
console.log('T4 注入真嵌入:');
if (state === 'POST') {
  const t0 = Date.now() - 2000; // mtime 容忍 2s 時鐘粒度
  sh('touch src-tauri/src/drive_sync.rs');
  const t4 = sh(`cd src-tauri && TENO_DRIVE_CLIENT_ID=${FAKE_ID} TENO_DRIVE_CLIENT_SECRET=${FAKE_SECRET} cargo check --offline 2>&1`);
  ok(t4.status === 0, 'T4a 注入假憑證可編譯');
  const depsDir = path.join(REPO, 'src-tauri/target/debug/deps');
  // R1#3-B4：真實產物全為 libteno-* 前綴（原 /^teno/ 命中 0＝T4b 假紅＋T4c 空集假綠）
  const listFresh = () => fs.readdirSync(depsDir)
    .filter(f => /^(lib)?teno.*\.(rmeta|rlib)$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(depsDir, f)).mtimeMs }))
    .filter(x => x.m >= t0);
  const fresh = listFresh();
  const hit = fresh.some(x => fs.readFileSync(path.join(depsDir, x.f)).includes(Buffer.from(FAKE_ID)));
  ok(hit && fresh.length > 0, 'T4b 假憑證真嵌入編譯產物（option_env! 生效）', `fresh=${fresh.map(x => x.f).join(',')}`);
  // 污染清除＝R4 臨時解示範：touch 重編（無 env）後假值必須消失
  sh('touch src-tauri/src/drive_sync.rs');
  const t4r = sh('cd src-tauri && env -u TENO_DRIVE_CLIENT_ID -u TENO_DRIVE_CLIENT_SECRET cargo check --offline 2>&1');
  const fresh2 = listFresh();
  const still = fresh2.some(x => fs.readFileSync(path.join(depsDir, x.f)).includes(Buffer.from(FAKE_ID)));
  ok(t4r.status === 0 && fresh2.length > 0 && !still, 'T4c touch 重編後假值殲滅（非空守衛＋產物不髒）', `fresh2=${fresh2.length}`);
} else {
  console.log('  SKIP  T4（pre 態無注入鏈，skip）');
}

// ── T5 負控制（恆常，pin 基線）──────────────────────────────────
console.log('T5 負控制（pin ' + BASELINE + '）:');
const base = sh(`git show ${BASELINE}:src-tauri/src/drive_sync.rs`).stdout;
ok(base.includes('GOCSPX-'), 'T5a 基線檔取回且含硬編碼 secret');
const b = scanDriveSync(base);
ok(b.hardcodedSecret === true, 'T5b 掃描器於基線紅: secret 在場');
ok(b.hardcodedId === true, 'T5c 掃描器於基線紅: client_id 在場');
ok(b.envId === false && b.envSecret === false, 'T5d 掃描器於基線紅: env 鏈缺席');
ok(b.writePrivateFn === false, 'T5e 掃描器於基線紅: write_private 定義缺席');
ok(b._bodiesPresent && b.saveRawWrite === 2, 'T5f 掃描器於基線紅: save 裸寫×2', `saveRawWrite=${b.saveRawWrite}`);
ok(b.saveCallsPrivate === 0, 'T5g 掃描器於基線紅: save 零 write_private 呼叫（正向釘紅集只增不腐）');

// ── T6 write_private 行為級微編譯（純 std，rustc 單檔）────────────
console.log('T6 write_private 微編譯:');
const harness = (implSrc) => `
use std::io::Write;
use std::path::Path;
use std::os::unix::fs::{PermissionsExt, MetadataExt}; // R1#3-B3: metadata().mode() 需 MetadataExt，缺則 E0599
${implSrc}
fn main() {
    let dir = std::env::temp_dir().join(format!("f11-micro-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // 腿1: 既有 0644 舊檔被覆寫後必須收緊成 0600（.mode() 僅建立時生效，顯式 set_permissions 是牙）
    let old = dir.join("old.json");
    std::fs::write(&old, "x").unwrap();
    std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
    write_private(&old, "new").unwrap();
    let m = std::fs::metadata(&old).unwrap().mode() & 0o777;
    assert_eq!(m, 0o600, "overwrite path mode={:o}", m);
    assert_eq!(std::fs::read_to_string(&old).unwrap(), "new");
    // 腿2: 全新建立路徑直接 0600
    let fresh = dir.join("fresh.json");
    write_private(&fresh, "y").unwrap();
    let m2 = std::fs::metadata(&fresh).unwrap().mode() & 0o777;
    assert_eq!(m2, 0o600, "fresh path mode={:o}", m2);
    std::fs::remove_dir_all(&dir).ok();
    println!("MICRO_OK");
}
`;
// 提取真碼：#[cfg(unix)] fn write_private ... 至 #[cfg(not(unix))] 前
const extract = () => {
  const i = src.search(/#\[cfg\(unix\)\]\s*\n\s*fn write_private/);
  if (i < 0) return null;
  const rest = src.slice(i);
  const j = rest.indexOf('#[cfg(not(unix))]');
  if (j < 0) return null;
  return rest.slice(0, j);
};
const implFixed = state === 'POST' ? extract() : null;
if (state === 'POST') {
  ok(implFixed !== null, 'T6a write_private 源碼段提取成功');
  if (implFixed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-micro-'));
    const rs = path.join(dir, 'm.rs');
    fs.writeFileSync(rs, harness(implFixed));
    const c = sh(`rustc --edition 2021 -o ${dir}/m ${rs} 2>&1`);
    ok(c.status === 0, 'T6b 真碼微編譯成功', c.stdout.slice(0, 300));
    const r = sh(`${dir}/m 2>&1`);
    ok(r.status === 0 && r.stdout.includes('MICRO_OK'), 'T6c 真碼行為: 舊檔收緊0600＋新建0600', r.stdout.slice(0, 300));
    // NC: 同 harness 換回裸 fs::write → 0644 精準復現（assert 必 panic）
    const ncImpl = 'fn write_private(path: &Path, s: &str) -> std::io::Result<()> {\n    std::fs::write(path, s)\n}';
    const rsNc = path.join(dir, 'nc.rs');
    fs.writeFileSync(rsNc, harness(ncImpl));
    const cn = sh(`rustc --edition 2021 -o ${dir}/nc ${rsNc} 2>&1`);
    ok(cn.status === 0, 'T6d NC 微編譯成功');
    const rn = sh(`${dir}/nc 2>&1`);
    ok(rn.status !== 0 && /0o644|644/.test(rn.stdout + rn.stderr), 'T6e NC 裸寫復現 0644（測試有牙）', (rn.stdout + rn.stderr).slice(0, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  ok(implFixed === null && !w.writePrivateFn, 'T6p write_private 未落地（提取器落空=修法未在場）');
}

// ── T7 空值語意回歸釘（防預設值回魂/引導鏈斷裂）───────────────────
console.log('T7 空值語意釘:');
if (state === 'POST') {
  // R1#3-B1/#2-N2：match 形（const fn unwrap_or 未 stable=E0658），釘兩常量段各自含 env 鏈＋空降級，行錨定防誤傷
  const constSeg = (name) => {
    const i = src.indexOf(`const ${name}`);
    if (i < 0) return '';
    const j = src.indexOf('};', i);
    return j < 0 ? src.slice(i, i + 200) : src.slice(i, j + 2);
  };
  const segId = constSeg('DEFAULT_CLIENT_ID');
  const segSec = constSeg('DEFAULT_CLIENT_SECRET');
  ok(/option_env!\("TENO_DRIVE_CLIENT_ID"\)/.test(segId) && /None\s*=>\s*""/.test(segId), 'T7a DEFAULT_CLIENT_ID 段＝env→空降級形態');
  ok(/option_env!\("TENO_DRIVE_CLIENT_SECRET"\)/.test(segSec) && /None\s*=>\s*""/.test(segSec), 'T7b DEFAULT_CLIENT_SECRET 段＝env→空降級形態');
  const cv = (() => { const i = src.indexOf('fn creds_valid'); const j = src.indexOf('\n}\n', i); return src.slice(i, j); })();
  ok(cv.includes('client_id.is_empty()') && cv.includes('client_secret.is_empty()'), 'T7c creds_valid 空值守衛在場');
  ok(src.includes('"未設定"') , 'T7d drive_status 未設定引導在場');
} else {
  console.log('  SKIP  T7（pre 態跳過）');
}

// ── T8/T9 (F11-SR1): build.rs rerun-if-env-changed 防禦性加固 ──────────
// 審查證偽：option_env! env 敏感性由 rustc dep-info env-dep 自動追蹤(MSRV 1.77.2
// 即具備)，cargo 讀 .d 自動標 Dirty 重編——F11-SR1「bug」前提實為非 bug。本節
// 以「冗餘顯式宣告(defense-in-depth)」處理：加兩行 rerun 為 cargo 官方建議，
// T8 掃描在場；T9 行為探針釘住 env-dep 自動追蹤不被工具鏈/設定回歸侵蝕。
console.log('T8 build.rs rerun-if-env-changed(防禦性):');
const BUILD_RS = path.join(REPO, 'src-tauri/build.rs');
const buildSrc = fs.readFileSync(BUILD_RS, 'utf8');
ok(buildSrc.includes('cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_ID'), 'T8a rerun-if-env-changed=CLIENT_ID 在場');
ok(buildSrc.includes('cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_SECRET'), 'T8b rerun-if-env-changed=CLIENT_SECRET 在場');
{
  // NC 真 pin 基線法（比照 T5，禁 HEAD 基準——F9 教訓；F11-SR1 修法前最後 HEAD）
  const BR_BASELINE = '11d218f';
  const baseBR = sh(`git show ${BR_BASELINE}:src-tauri/build.rs`).stdout;
  ok(!baseBR.includes('cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_ID'), 'T8-NCa 負控制: 修法前 build.rs 無 ID rerun(掃描器有牙)');
  ok(!baseBR.includes('cargo:rerun-if-env-changed=TENO_DRIVE_CLIENT_SECRET'), 'T8-NCb 負控制: 修法前 build.rs 無 SECRET rerun');
}
console.log('T9 no-touch env 變更行為探針(dep-info env-dep 追蹤):');
if (state === 'POST') {
  const FAKE2 = 'F11SR1FAKE2';
  const t0 = Date.now() - 3000;
  const t9 = sh(`cd src-tauri && TENO_DRIVE_CLIENT_ID=${FAKE2} cargo check --offline 2>&1`);
  ok(t9.status === 0, 'T9a 改 env(無 touch) cargo check 成功', (t9.stdout + t9.stderr).split('\n').filter(l => l.startsWith('error')).slice(0, 2).join(' | '));
  const depsDir = path.join(REPO, 'src-tauri/target/debug/deps');
  const fresh9 = fs.readdirSync(depsDir)
    .filter(f => /^(lib)?teno.*\.(rmeta|rlib)$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(depsDir, f)).mtimeMs }))
    .filter(x => x.m >= t0);
  const hit9 = fresh9.some(x => fs.readFileSync(path.join(depsDir, x.f)).includes(Buffer.from(FAKE2)));
  ok(fresh9.length > 0 && hit9, 'T9b no-touch env 變更→重編產物內嵌新值(env-dep 自動追蹤實錘)', `fresh=${fresh9.map(x => x.f).join(',')}`);
} else {
  console.log('  SKIP  T9（pre 態）');
}

console.log(`\n== ${state} 態結果: ${pass}/${pass + fail} PASS ${fail === 0 ? '— ALL PASS' : '— FAILS: ' + fails.join(' | ')}`);
process.exit(fail === 0 ? 0 : 1);
