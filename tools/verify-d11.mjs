#!/usr/bin/env node
// verify-d11.mjs — D11: drive_download 零內容驗證 → 空檔/垃圾檔毀本機 DB
// 雙態自適應；負控制=T4 直通版守門復現毀庫路徑＋T5 pin 基線 9e3116b（F9 教訓）。
// 嚴禁連 Google API：純靜態/倉內單元/rustc 微編譯斷言。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = '/home/jupiter/teno';
const DS = path.join(REPO, 'src-tauri/src/drive_sync.rs');
const LIB = path.join(REPO, 'src-tauri/src/lib.rs');
const BASELINE = '9e3116b';
const ENV = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

let pass = 0, fail = 0; const fails = [];
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}${detail ? '  ← ' + detail : ''}`); }
}
function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-c', cmd], { encoding: 'utf8', cwd: REPO, env: ENV, timeout: 300000, ...opts });
}

const ds = fs.readFileSync(DS, 'utf8');
const lib = fs.readFileSync(LIB, 'utf8');
const state = ds.includes('fn validate_drive_download') ? 'POST' : 'PRE';
// drive_download 段切取（簽名→首個行首 \n}\n）
function dlBody(src) {
  const i = src.indexOf('pub async fn drive_download');
  if (i < 0) return null;
  const j = src.indexOf('\n}\n', i);
  return j < 0 ? null : src.slice(i, j + 2);
}
console.log(`D11 verify — 狀態偵測: ${state}\n`);

// ── T1 源碼釘 ───────────────────────────────────────────────────
console.log('T1 源碼釘:');
const dl = dlBody(ds);
ok(dl !== null, 'T1a drive_download 函式體可切取');
if (state === 'POST') {
  ok(dl.includes('validate_drive_download(&buf)'), 'T1b 委派在場（守門吃原始 buf）');
  const iv = dl.indexOf('validate_drive_download');
  const iw = dl.indexOf('fs::write(&tmp');
  const iwsl = dl.indexOf('remove_file(db.with_extension("db-wal")');
  ok(iv >= 0 && iw > iv && iwsl > iw, 'T1c 順序釘：守門 < 寫tmp < 拆WAL（拒絕=零副作用）', `iv=${iv} iw=${iw} iwsl=${iwsl}`);
  ok(dl.includes('fs::write(&tmp, &db_bytes)') && !dl.includes('fs::write(&tmp, &buf)'), 'T1d 寫盤改用解包後 db_bytes（舊 &buf 零殘留）');
  const vf = ds.slice(ds.indexOf('fn validate_drive_download'));
  ok(vf.includes('SQLite format 3\\0') && vf.includes('unpack_db_container') && /len\(\)\s*<\s*100/.test(vf), 'T1e 守門本體＝unpack＋100B+magic 雙判（D19 同判別子）');
} else {
  ok(dl.includes('fs::write(&tmp, &buf)'), 'T1p-a bug 在場：raw buf 直寫暫存');
  ok(!dl.includes('unpack_db_container') && !dl.includes('validate') && !dl.includes('SQLite format 3'), 'T1p-b bug 在場：函式體零驗證呼叫');
  ok(ds.indexOf('remove_file(db.with_extension("db-wal")') > iw0(dl), 'T1p-c bug 在場：WAL 拆除先於任何把關（無把關可言）');
}
function iw0(body) { return body.indexOf('remove_file'); }

// ── T2 倉內單元測試 ─────────────────────────────────────────────
console.log('T2 cargo test drive_sync:');
const t2 = sh('cd src-tauri && cargo test --offline drive_sync 2>&1');
const t2out = t2.stdout + t2.stderr;
const t2green = /test result: ok\./.test(t2out) && t2.status === 0;
const hasD11Test = t2out.includes('d11_validates_drive_download_forms');
if (state === 'POST') {
  ok(t2green, 'T2a cargo test drive_sync 全綠');
  ok(hasD11Test, 'T2b d11 單元測試存在且執行');
} else {
  ok(t2green, 'T2p-a 基線 cargo test 綠');
  ok(!hasD11Test, 'T2p-b d11 測試未搶跑');
}

// ── T3/T4 行為級微編譯（提取真碼 rustc 單檔）──────────────────────
console.log('T3 微編譯七腿 / T4 NC:');
function extract() {
  // lib.rs: CONTAINER_MAGIC 行 + unpack_db_container fn
  const ci = lib.indexOf('const CONTAINER_MAGIC');
  const cl = lib.slice(ci, lib.indexOf('\n', lib.indexOf('= b"TENOC";', ci)) + 1);
  const ui = lib.indexOf('fn unpack_db_container');
  const uj = lib.indexOf('\n}\n', ui);
  if (ci < 0 || ui < 0 || uj < 0) return null;
  const unpack = lib.slice(ui, uj + 3);
  // drive_sync.rs: validate_drive_download
  const vi = ds.indexOf('fn validate_drive_download');
  if (vi < 0) return null;
  const vj = ds.indexOf('\n}\n', vi);
  const validate = ds.slice(vi, vj + 3).replace('crate::unpack_db_container', 'unpack_db_container');
  return cl + '\n' + unpack + '\n' + validate;
}
const HEAD16 = Buffer.from('SQLite format 3\0');
const harness = (implFn) => `
${implFn}
fn main() {
    let sqlite: Vec<u8> = {
        let mut v = b"SQLite format 3\\0".to_vec();
        v.resize(516, 7);
        v
    };
    let garbage: Vec<u8> = b"this is not a database at all, just html junk ".as_slice().repeat(6);
    let mut container: Vec<u8> = b"TENOC".to_vec();
    container.push(1u8);
    container.extend_from_slice(&(sqlite.len() as u32).to_le_bytes());
    container.extend_from_slice(&sqlite);
    container.extend_from_slice(&0u32.to_le_bytes());
    let mut badinner: Vec<u8> = b"TENOC".to_vec();
    badinner.push(1u8);
    badinner.extend_from_slice(&(garbage.len() as u32).to_le_bytes());
    badinner.extend_from_slice(&garbage);
    badinner.extend_from_slice(&0u32.to_le_bytes());
    let mut trunc: Vec<u8> = b"TENOC".to_vec();
    trunc.push(1u8);
    trunc.extend_from_slice(&999999u32.to_le_bytes());
    trunc.extend_from_slice(b"short");
    let mut tiny: Vec<u8> = b"SQLite format 3\\0".to_vec();
    tiny.resize(99, 9);
    let empty: Vec<u8> = Vec::new();
    // 七腿
    assert!(validate_drive_download(&empty).is_err(), "LEG-empty must REJECT");
    assert!(validate_drive_download(&garbage).is_err(), "LEG-garbage must REJECT");
    let r = validate_drive_download(&sqlite).expect("LEG-bare must pass");
    assert_eq!(r, sqlite, "LEG-bare identity");
    let r2 = validate_drive_download(&container).expect("LEG-tenoc must pass");
    assert_eq!(r2, sqlite, "LEG-tenoc unwrapped identity");
    assert!(validate_drive_download(&trunc).is_err(), "LEG-trunc must REJECT");
    assert!(validate_drive_download(&badinner).is_err(), "LEG-badinner must REJECT (unpack hole)");
    assert!(validate_drive_download(&tiny).is_err(), "LEG-99B must REJECT");
    println!("MICRO_OK");
}
`;
const implFixed = state === 'POST' ? extract() : null;
if (state === 'POST') {
  ok(implFixed !== null, 'T3a 真碼提取成功（unpack+validate 雙檔段）');
  if (implFixed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-micro-'));
    const rs = path.join(dir, 'm.rs');
    fs.writeFileSync(rs, harness(implFixed));
    const c = sh(`rustc --edition 2021 -o ${dir}/m ${rs} 2>&1`);
    ok(c.status === 0, 'T3b 真碼微編譯成功', c.stdout.slice(0, 400));
    const r = sh(`${dir}/m 2>&1`);
    ok(r.status === 0 && r.stdout.includes('MICRO_OK'), 'T3c 七腿全斃惡放行善（含 TENOC 垃圾內段殘洞釘）', r.stdout.slice(0, 300));
    // T4 NC：守門換直通版（F11 修復前語意）→ 惡腿必通過＝毀庫復現
    const ncImpl = implFixed.replace(/fn validate_drive_download[^{]*\{[\s\S]*?\n\}\n/, 'fn validate_drive_download(buf: &[u8]) -> Result<Vec<u8>, String> {\n    Ok(buf.to_vec())\n}\n');
    ok(ncImpl !== implFixed, 'T4a NC 直通版組裝成功（反換真實性釘）');
    const rsNc = path.join(dir, 'nc.rs');
    fs.writeFileSync(rsNc, harness(ncImpl));
    const cn = sh(`rustc --edition 2021 -o ${dir}/nc ${rsNc} 2>&1`);
    ok(cn.status === 0, 'T4b NC 微編譯成功', cn.stdout.slice(0, 300));
    const rn = sh(`${dir}/nc 2>&1`);
    ok(rn.status !== 0 && /LEG-empty must REJECT/.test(rn.stdout + rn.stderr), 'T4c NC 空檔直入（毀庫路徑精準復現，測試有牙）', (rn.stdout + rn.stderr).slice(0, 200));
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  ok(implFixed === null, 'T3p validate_drive_download 未落地（提取器落空=修法未在場）');
}

// ── T5 基線負控制（pin）─────────────────────────────────────────
console.log('T5 基線釘（pin ' + BASELINE + '）:');
const base = sh(`git show ${BASELINE}:src-tauri/src/drive_sync.rs`).stdout;
const bdl = dlBody(base);
ok(bdl !== null, 'T5a 基線 drive_download 可切取');
ok(bdl.includes('fs::write(&tmp, &buf)'), 'T5b 基線紅：raw buf 直寫在場');
ok(!bdl.includes('unpack_db_container') && !bdl.includes('validate_drive_download') && !bdl.includes('SQLite format 3'), 'T5c 基線紅：零驗證呼叫（bug 實錘於基線）');

console.log(`\n== ${state} 態結果: ${pass}/${pass + fail} PASS ${fail === 0 ? '— ALL PASS' : '— FAILS: ' + fails.join(' | ')}`);
process.exit(fail === 0 ? 0 : 1);
