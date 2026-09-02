#!/usr/bin/env node
// verify-d16-container-strict.mjs — D16 TENOC 容器三守門（version 必斷/log 欄必在/trailing 必拒）
//
// 證據鏈設計（F9/F12 教訓遵行）：
//   T0 cargo container 全家（既有釘零改全過＝零誤殺主證＋新 d16 釘在册）
//   T1 真碼提取：unpack_db_container（純 &[u8] 函數）從 lib.rs 切出→rustc 獨立
//      編譯成向量機（stdin hex 行→stdout OK/ERR），新碼行為矩陣全斷言
//   T2 雙端契約釘：真 CLI `export-db`（TENO_DB=tmp 沙箱，真生產者路徑）產出容器
//      → Rust 新碼必 Ok（CLI↔Rust 格式互通零誤殺）
//   T3 負控制（pin 靜態 hash 81125ff＝F12 commit，unpack 現狀最後快照，禁浮動
//      HEAD——F9 教訓）：git show 提取舊 unpack_db_container→rustc 編譯→
//      version=255/trailing/log 欄缺位三向量舊碼全 Ok＝bug 徵狀精準重現；
//      辨證釘：舊接受 ∧ 新拒絕 同向量（判別性，非兩邊各自空轉）
//   T4 結構釘×4＋cargo check host
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/home/jupiter/teno';
const LIB = join(ROOT, 'src-tauri/src/lib.rs');
const OLD_REF = '81125ff'; // F12 commit＝unpack_db_container 修法前最後快照（靜態 pin）
const src = readFileSync(LIB, 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  «' + String(extra).slice(0, 300) + '»' : ''}`); }
};
const sh = (cmd, opts = {}) => {
  try { return { out: execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};

// ── 真碼提取器（新舊共用）：fn unpack_db_container 至首個行首 "}\n" ＋ 常數頭
function extractUnpack(text, tag) {
  const start = text.indexOf('fn unpack_db_container');
  if (start < 0) throw new Error(`${tag}: 找不到 unpack_db_container`);
  const end = text.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${tag}: 函數終止找不到`);
  const body = text.slice(start, end + 3);
  return `const CONTAINER_MAGIC: &[u8] = b"TENOC";\n${body}\nfn main() {\n  for line in std::io::stdin().lines() {\n    let hex = line.unwrap();\n    let data: Vec<u8> = (0..hex.len()/2).map(|i| u8::from_str_radix(&hex[i*2..i*2+2],16).unwrap()).collect();\n    match unpack_db_container(&data) { Ok((t,l)) => println!("OK:{}:{}", t.len(), l.len()), Err(e) => println!("ERR:{}", e) };\n  }\n}\n`;
}
function buildHarness(rs, name, dir) {
  const p = join(dir, `${name}.rs`);
  writeFileSync(p, rs);
  const c = sh(`rustc -O ${p} -o ${join(dir, name)} 2>&1`, { timeout: 120000 });
  if (c.code !== 0) throw new Error(`${name} rustc 失敗: ${c.out.slice(0, 400)}`);
  return join(dir, name);
}
function runHarness(bin, hexVecs, dir) {
  const name = bin.slice(bin.lastIndexOf('/') + 1);
  const inp = join(dir, `${name}-in.txt`);
  writeFileSync(inp, hexVecs.join('\n') + '\n');
  const r = sh(`${bin} < ${inp}`);
  if (r.code !== 0) throw new Error(`harness 崩: ${r.out.slice(0, 300)}`);
  return r.out.trim().split('\n');
}
const hx = (arr) => Buffer.from(arr).toString('hex');
const GOOD = [0x54,0x45,0x4e,0x4f,0x43,1, 4,0,0,0, 0x44,0x42,0x41,0x41, 0,0,0,0]; // magic v1 [4]DBAA [0]

const dir = mkdtempSync(join(tmpdir(), 'd16v-'));
try {
// ── T0: cargo container ───────────────────────────────────────────
console.log('== T0: cargo test --lib container ==');
{
  const r = sh('cd src-tauri && cargo test --lib container 2>&1', { timeout: 900000 });
  ok('T0 cargo container 全綠＋計數下限 3（防子孫刪測試）',
    r.code === 0 && /test result: ok\.\s+([3-9]|[1-9][0-9]) passed; 0 failed/.test(r.out), r.out);
  ok('T0a 新釘 d16_container_strict_gates 在冊', /d16_container_strict_gates \.\.\. ok/.test(r.out));
  ok('T0b 既有 round-trip 釘零改全過（零誤殺主證）', /container_roundtrip \.\.\. ok/.test(r.out));
}

// ── T1: 真碼提取 → rustc 向量機（新碼）────────────────────────────
console.log('== T1: 真碼提取向量機（工作區新碼）==');
let newBin;
{
  const rs = extractUnpack(src, 'new');
  ok('T1a 提取含 version 守門 token', rs.includes('data[5] != 1'));
  ok('T1b 提取含 trailing 守門 token', rs.includes('pos != data.len()'));
  newBin = buildHarness(rs, 'd16new', dir);
  const vecs = [
    hx(GOOD),                                                       // 0 基準 Ok
    hx([...GOOD.slice(0,5), 0, ...GOOD.slice(6)]),                  // 1 v0 Err
    hx([...GOOD.slice(0,5), 2, ...GOOD.slice(6)]),                  // 2 v2 Err
    hx([...GOOD.slice(0,5), 0xff, ...GOOD.slice(6)]),               // 3 v255 Err
    hx([...GOOD, ...Array.from(Buffer.from('EXTRA'))]),             // 4 trailing Err
    hx(GOOD.slice(0, 14)),                                          // 5 log 欄缺位 Err
    hx(GOOD.slice(0, 16)),                                          // 6 log len 欄截半 Err
    hx([...GOOD.slice(0,14), 3,0,0,0, 0x4c,0x47]),                  // 7 log 段截斷 Err
    hx([...GOOD.slice(0,14), 2,0,0,0, 0x4c,0x47]),                  // 8 完整含 log Ok
    hx(Array.from(Buffer.from('SQLite format 3\0whatever-tail'))),  // 9 raw fallback Ok
    hx(Array.from(Buffer.from('GARBAGE_NOT_DB'))),                  // 10 垃圾 Err
    hx([0x54,0x45,0x4e,0x4f]),                                      // 11 magic 不足 Err
    hx(GOOD.slice(0, 6)),                                           // 12 僅 header Err
  ];
  const out = runHarness(join(dir, 'd16new'), vecs, dir);
  ok('T1-0 基準容器 Ok:4:0', out[0] === 'OK:4:0', out[0]);
  ok('T1-1/2/3 version 0/2/255 全拒（版本不支援）', [1,2,3].every(i => out[i].startsWith('ERR:') && out[i].includes('版本不支援')), [1,2,3].map(i=>out[i]).join(' | '));
  ok('T1-4 trailing garbage 拒（尾部多餘資料）', out[4].startsWith('ERR:') && out[4].includes('尾部'), out[4]);
  ok('T1-5 log 欄缺位拒（缺少 app-log 長度欄位）', out[5].startsWith('ERR:') && out[5].includes('app-log'), out[5]);
  ok('T1-6 log len 欄截半拒', out[6].startsWith('ERR:'), out[6]);
  ok('T1-7 log 段截斷拒', out[7].startsWith('ERR:') && out[7].includes('截斷'), out[7]);
  ok('T1-8 完整含 log Ok:4:2（零誤殺）', out[8] === 'OK:4:2', out[8]);
  ok('T1-9 raw SQLite fallback 仍 Ok（向後相容釘）', out[9] === 'OK:29:0', out[9]);
  ok('T1-10 非 SQLite 垃圾拒', out[10].startsWith('ERR:'), out[10]);
  ok('T1-11/12 截短 header 拒', out[11].startsWith('ERR:') && out[12].startsWith('ERR:'), `${out[11]} | ${out[12]}`);
}

// ── T2: 雙端契約釘——真 CLI export-db（真生產者）→ Rust 新碼必 Ok ──
console.log('== T2: CLI export-db 真容器 → Rust 零誤殺 ==');
{
  const sbx = join(dir, 'sbxDB');
  sh(`node -e "
    const {DatabaseSync}=require('node:sqlite');
    const d=new DatabaseSync('${sbx}');
    d.exec('CREATE TABLE words(id INTEGER PRIMARY KEY, word TEXT)');
    d.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)');
    d.exec(\\"INSERT INTO words(word) VALUES('contract')\\");
    d.close();
  "`);
  const bin = join(dir, 'cli-backup.bin');
  const r = sh(`TENO_DB=${sbx} TENO_NO_BACKUP=1 node tools/cli.mjs export-db --out ${bin} 2>&1`, { timeout: 120000 });
  ok('T2a CLI export-db 真跑成功', r.code === 0, r.out);
  const buf = readFileSync(bin);
  ok('T2b 產物為 TENOC 容器（非 raw）', buf.subarray(0, 5).toString('latin1') === 'TENOC', buf.subarray(0, 8).toString('hex'));
  const out = runHarness(join(dir, 'd16new'), [buf.toString('hex')], dir);
  ok('T2c Rust 新碼吃 CLI 容器 Ok（雙端格式契約，log 段 len=0 或真 log）', out[0].startsWith('OK:'), out[0]);
}

// ── T3: 負控制——pin 81125ff 舊碼三徵狀精準重現＋判別性 ──────────
console.log('== T3: 負控制（git show 81125ff 舊 unpack）==');
{
  const old = sh(`git show ${OLD_REF}:src-tauri/src/lib.rs`).out;
  ok('T3a 基準 pin 為靜態 hash（禁浮動 HEAD，F9 教訓）', /^[0-9a-f]{7}$/.test(OLD_REF) && old.length > 10000, `len=${old.length}`);
  const oldRs = extractUnpack(old, 'old');
  ok('T3b 舊碼提取零守門 token（提取真實性：無 version/trailing 判別子）',
    !oldRs.includes('data[5] != 1') && !oldRs.includes('pos != data.len()'));
  ok('T3b2 舊碼內容級釘：if-let 靜默降級在位（pin 若漂移至修法後碼即紅，R1#3-次要2）',
    oldRs.includes('if let Some(log_len)'));
  ok('T3c 新舊提取體不同（判別性前提：非同一份碼自我循環）', oldRs.length !== extractUnpack(src, 'new2').length);
  buildHarness(oldRs, 'd16old', dir);
  const vecs = [
    hx([...GOOD.slice(0,5), 0xff, ...GOOD.slice(6)]),               // 0 v255
    hx([...GOOD.slice(0,5), 0x00, ...GOOD.slice(6)]),               // 1 v0（R1#3-次要1：v0 誤收類雙臂覆盖）
    hx([...GOOD, ...Array.from(Buffer.from('EXTRA'))]),             // 2 trailing
    hx(GOOD.slice(0, 14)),                                          // 3 log 欄缺位
  ];
  const oout = runHarness(join(dir, 'd16old'), vecs, dir);
  const nout = runHarness(join(dir, 'd16new'), vecs, dir);
  ok('T3d 徵狀1 重現：舊碼吃 version=255 回 Ok（讀而不斷）', oout[0].startsWith('OK:'), oout[0]);
  ok('T3d2 徵狀1b 重現：舊碼吃 version=0 回 Ok（v0 誤收類判別性雙臂）', oout[1].startsWith('OK:'), oout[1]);
  ok('T3e 徵狀2 重現：舊碼吃 trailing 回 Ok（靜默丟棄）', oout[2].startsWith('OK:4:0'), oout[2]);
  ok('T3f 徵狀3 重現：舊碼吃 log 欄缺位回 Ok（靜默降級無 log）', oout[3].startsWith('OK:4:0'), oout[3]);
  ok('T3g 判別性釘：同四向量新碼全 ERR（新舊對跑，非兩邊空轉）', nout.every(l => l.startsWith('ERR:')), nout.join(' | '));
}

// ── T4: 結構釘＋編譯 ──────────────────────────────────────────────
console.log('== T4: 結構釘 + cargo check ==');
{
  const fn = src.slice(src.indexOf('fn unpack_db_container'), src.indexOf('fn write_db_container'));
  ok('T4a version 守門＋錯誤訊息含升級教學', /data\[5\] != 1[\s\S]{0,200}升級/.test(fn));
  ok('T4b log 欄 if-let 靜默降級殲滅（if let Some(log_len) 零殘留）', !fn.includes('if let Some(log_len)'));
  ok('T4c trailing 守門在位且在 Ok((teno, log)) 前', fn.indexOf('pos != data.len()') > fn.indexOf('let log =') && fn.indexOf('pos != data.len()') < fn.indexOf('Ok((teno, log))'));
  ok('T4d raw fallback 分支未動（SQLite magic 釘在位）', fn.includes('b"SQLite format 3\\0"'));
  const h = sh('cd src-tauri && cargo check --quiet 2>&1', { timeout: 600000 });
  ok('T4e host cargo check 綠', h.code === 0, h.out);
}
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n== D16 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
