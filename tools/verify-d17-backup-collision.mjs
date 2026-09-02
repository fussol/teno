#!/usr/bin/env node
// verify-d17-backup-collision.mjs — D17 同秒備份檔名碰撞覆寫
// 徵狀（舊碼）：backup_db 用 unix 秒命名 teno-<ts>.db，同秒第二次備份 fs::copy
// 靜默截斷覆寫同一檔＝「按兩次備份按鈕，列表只有一條」快照幽靈消失。
// 修法：nanos 命名（list/prune 既有 >1e11 換算启发式原生支援）＋ O_EXCL
// create_new 獨佔建立，真撞名 forward 1µs 換名，永不覆寫。
//
// 證據鏈：
//   T0 cargo backup_naming（新釘 d17_same_ts_never_overwrites）＋計數下限釘
//   T1 真碼提取 unique_backup_dest（純 std 零 AppHandle）→ rustc 向量機：
//      同 ts 連呼 N 次名稱互異＋既有手刻檔零碰＋跳名步進 1µs 精確
//   T2 解析契約釘（R1 必修面）：本腳本「鏡像」list_backups/prune_backups 的
//      名稱解析＋nanos→secs 換算碼（讀 lib.rs 源碼提取判別子存在性＝防兩端
//      靜默漂移），真實 nanos 名稱餵鏡像解析器得正確秒
//   T3 負控制（pin 靜態 hash＝D16 commit 0096e88，backup_db 舊碼最後快照，
//      禁浮動 HEAD）：舊命名段（as_secs＋同檔名 fs::copy 語意）rustc 重構
//      →同秒兩次＝同檔名＋首檔內容被截斷覆寫徵狀精準重現；判別性：新碼同
//      ts 兩次＝兩檔首檔留存
//   T4 結構釘×4＋cargo check host
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/home/jupiter/teno';
const LIB = join(ROOT, 'src-tauri/src/lib.rs');
const OLD_REF = '0096e88'; // D16 commit＝backup_db 舊命名最後快照（靜態 pin，F9 教訓）
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

const dir = mkdtempSync(join(tmpdir(), 'd17v-'));
try {
// ── T0: cargo backup_naming ───────────────────────────────────────
console.log('== T0: cargo test --lib backup_naming ==');
{
  const r = sh('cd src-tauri && cargo test --lib backup_naming 2>&1', { timeout: 900000 });
  ok('T0 cargo backup_naming 全綠＋計數下限 1（防子孫刪測試）',
    r.code === 0 && /test result: ok\.\s+([1-9]|[1-9][0-9]) passed; 0 failed/.test(r.out), r.out);
  ok('T0a 新釘 d17_same_ts_never_overwrites 在冊', /d17_same_ts_never_overwrites \.\.\. ok/.test(r.out));
  const rc = sh('cd src-tauri && cargo test --lib container 2>&1', { timeout: 900000 });
  ok('T0b container 域零回歸（同檔鄰域釘）', rc.code === 0 && /3 passed; 0 failed/.test(rc.out), rc.out);
}

// ── T1: 真碼提取 unique_backup_dest → rustc 向量機 ────────────────
console.log('== T1: 真碼提取向量機 ==');
function extractDest(text) {
  const start = text.indexOf('fn unique_backup_dest');
  if (start < 0) throw new Error('找不到 unique_backup_dest');
  const end = text.indexOf('\n}\n', start);
  if (end < 0) throw new Error('unique_backup_dest 終止找不到');
  return text.slice(start, end + 3);
}
let newDest;
{
  newDest = extractDest(src);
  ok('T1a 提取含 O_EXCL create_new', newDest.includes('create_new(true)'));
  ok('T1b 提取含碰撞換名 saturating_add(1_000)', newDest.includes('saturating_add(1_000)'));
  const harness = newDest + `
fn main() {
  let dir = std::env::args().nth(1).unwrap();
  let cmd = std::env::args().nth(2).unwrap();
  let ts: u64 = args3();
  fn args3() -> u64 { std::env::args().nth(3).unwrap().parse().unwrap() }
  if cmd == "seq" {
    // 同 ts 連呼 5 次：輸出 5 行最終名＋每檔寫入 marker，最後輸出首檔內容與檔數
    let dirp = std::path::Path::new(&dir);
    let mut names = vec![];
    for i in 0..5u8 {
      let (mut f, p) = unique_backup_dest(dirp, ts).unwrap();
      std::io::Write::write_all(&mut f, format!("S{}", i).as_bytes()).unwrap();
      names.push(p.file_name().unwrap().to_string_lossy().to_string());
    }
    for n in &names { println!("{}", n); }
    let uniq: std::collections::HashSet<&String> = names.iter().collect();
    println!("UNIQ:{}", uniq.len());
    println!("FIRST_CONTENT:{}", String::from_utf8(std::fs::read(dirp.join(&names[0])).unwrap()).unwrap());
    let cnt = std::fs::read_dir(dirp).unwrap().count();
    println!("FILE_COUNT:{}", cnt);
  } else if cmd == "pre" {
    // 預置手刻檔後呼一次：名稱跳開＋手刻檔內容零碰
    let dirp = std::path::Path::new(&dir);
    let planted = dirp.join(format!("teno-{}.db", ts));
    std::fs::write(&planted, b"PRECIOUS").unwrap();
    let (_, p) = unique_backup_dest(dirp, ts).unwrap();
    println!("NEW_NAME:{}", p.file_name().unwrap().to_string_lossy());
    println!("PLANTED_INTACT:{}", std::fs::read(&planted).unwrap() == b"PRECIOUS");
    println!("STEP:{}", p.file_name().unwrap().to_string_lossy()
      .replace("teno-", "").replace(".db", "").parse::<u64>().unwrap() - ts);
  } else if cmd == "sat" {
    // R1#3-F-1 終止性探針：ts=u64::MAX（saturating 恆同檔名）＋預植同名檔
    // → 有上限版必响亮 Err（毫秒級）；無上限 loop 變體＝本探針 timeout 紅
    let dirp = std::path::Path::new(&dir);
    let mx: u64 = u64::MAX;
    std::fs::write(dirp.join(format!("teno-{}.db", mx)), b"KEEP").unwrap();
    let t0 = std::time::Instant::now();
    match unique_backup_dest(dirp, mx) {
      Ok((_, p)) => println!("UNEXPECTED_OK:{}", p.display()),
      Err(e) => println!("ERR:{}:{}", t0.elapsed().as_millis(), e),
    }
    println!("KEEP_INTACT:{}", std::fs::read(dirp.join(format!("teno-{}.db", mx))).unwrap() == b"KEEP");
  }
}
`;
  const rs = join(dir, 'd17new.rs');
  writeFileSync(rs, harness);
  const c = sh(`rustc -O ${rs} -o ${join(dir, 'd17new')} 2>&1`, { timeout: 120000 });
  if (c.code !== 0) throw new Error('rustc 失敗: ' + c.out.slice(0, 400));
  // seq：同 ts 五連呼
  const seqDir = join(dir, 'seq'); sh(`mkdir -p ${seqDir}`);
  const so = sh(`${join(dir, 'd17new')} ${seqDir} seq 1786230000123456789`).out.trim().split('\n');
  // R1#3-F-3 韌性：harness panic 時紅得有意義而非 SyntaxError 崩腳本（保 T2-T4 情報）
  const names = so.slice(0, 5);
  const badLine = so.find(l => !/^teno-\d+\.db$/.test(l) && !/^(UNIQ|FIRST_CONTENT|FILE_COUNT):/.test(l));
  ok('T1-z harness 輸出乾淨（無 panic 混入，R1#3-F-3）', !badLine, badLine || '');
  ok('T1-0 五連呼名稱兩兩相異', new Set(names).size === 5 && /UNIQ:5/.test(so.join('\n')), so.join(' | '));
  ok('T1-1 首檔內容零覆寫（S0 留存）', /FIRST_CONTENT:S0/.test(so.join('\n')), so.join(' | '));
  ok('T1-2 檔數＝5（無共用路徑坍縮）', /FILE_COUNT:5/.test(so.join('\n')));
  ok('T1-3 步進精確 1µs（名稱等差 1000ns）', (() => {
    const ts = names.map(n => BigInt(n.replace('teno-', '').replace('.db', '')));
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] !== 1000n) return false;
    return true;
  })(), names.join(' '));
  // pre：手刻同名檔
  const preDir = join(dir, 'pre'); sh(`mkdir -p ${preDir}`);
  const po = sh(`${join(dir, 'd17new')} ${preDir} pre 1786230000000000000`).out;
  ok('T1-4 手刻同名檔零碰（PRECIOUS 留存）', /PLANTED_INTACT:true/.test(po), po);
  ok('T1-5 換名步進恰 1000ns', /STEP:1000/.test(po), po);
  // R1#3-F-1：終止性探針（飽和連撞必响亮 Err，非死迴圈；timeout=變體牙）
  const satDir = join(dir, 'sat'); sh(`mkdir -p ${satDir}`);
  const sto = sh(`${join(dir, 'd17new')} ${satDir} sat 0`, { timeout: 30000 });
  ok('T1-6 飽和連撞响亮終止（10000 上限生效，毫秒級 Err）', /ERR:\d+:/.test(sto.out), sto.out || '(timeout/死迴圈=無上限變體)');
  ok('T1-7 飽和场景預植檔零碰', /KEEP_INTACT:true/.test(sto.out), sto.out);
}

// ── T2: 解析契約釘——nanos 名稱餵 list/prune 鏡像解析 ─────────────
console.log('== T2: list/prune 解析契約 ==');
{
  // 鏡像 lib.rs list_backups 解析（strip teno-/.db → u64 → >1e11 則 /1e9）
  const parseMirror = (name) => {
    const m = name.match(/^teno-(\d+)\.db$/);
    if (!m) return null;
    const ts = BigInt(m[1]);
    return ts > 100_000_000_000n ? Number(ts / 1_000_000_000n) : Number(ts);
  };
  const realNow = Math.floor(Date.now() / 1); // ms
  const nanosNow = BigInt(Date.now()) * 1_000_000n; // 粗 nanos（毫秒尾零無妨解析路徑）
  const name = `teno-${nanosNow}.db`;
  const secs = parseMirror(name);
  const nowSecs = Math.floor(Date.now() / 1000);
  ok('T2a 真實 nanos 名稱鏡像解析＝合理秒（±60s）', Math.abs(secs - nowSecs) <= 60, `${name} → ${secs} vs ${nowSecs}`);
  const oldName = `teno-${nowSecs}.db`;
  ok('T2b 既有秒名稱解析不劣化（新舊混存排序基準）', parseMirror(oldName) === nowSecs);
  // 混存排序鏡像：舊秒檔與新 nanos 檔同基準可比
  ok('T2c 混存同基準可比（秒值域重疊）', parseMirror(oldName) >= nowSecs - 1 && secs >= nowSecs);
  // 源碼契約釘：list/prune 換算碼未被本修法移除（防「順手重構解析端」）
  ok('T2d list_backups 換算启发式仍在位', src.includes('ts > 100_000_000_000 { ts / 1_000_000_000 }'));
  ok('T2e prune_backups 換算启发式仍在位', (src.match(/100_000_000_000/g) || []).length >= 2);
}

// ── T3: 負控制（pin 0096e88 舊命名＋截斷覆寫徵狀）─────────────────
console.log('== T3: 負控制（git show 0096e88 舊 backup_db 命名語意）==');
{
  const old = sh(`git show ${OLD_REF}:src-tauri/src/lib.rs`).out;
  ok('T3a 基準 pin 為靜態 hash（禁浮動 HEAD，F9 教訓）', /^[0-9a-f]{7}$/.test(OLD_REF) && old.length > 10000, `len=${old.length}`);
  // 舊碼命名段源碼真性：as_secs＋單檔名 fs::copy（無 create_new）
  const oldBackupFn = old.slice(old.indexOf('fn backup_db'), old.indexOf('fn prune_backups'));
  ok('T3b 舊碼命名段源碼真性（as_secs 在位＋零 create_new）',
    oldBackupFn.includes('as_secs()') && !oldBackupFn.includes('create_new'), oldBackupFn.slice(0, 200));
  ok('T3c 新舊提取體不同（判別性前提）', !src.includes('as_secs()\n    let dest = backups_dir.join'));
  // 舊語意 rustc 重構：同 ts 兩次 → 同檔名 → File::create 截斷 → 首快照消失
  const oldHarn = `
fn main() {
  let dir = std::env::args().nth(1).unwrap();
  let dirp = std::path::Path::new(&dir);
  let ts: u64 = 1786230000; // 同秒
  let mut results = vec![];
  for i in 0..2u8 {
    let dest = dirp.join(format!("teno-{}.db", ts));       // 舊：秒粒度同檔名
    let mut f = std::fs::File::create(&dest).unwrap();      // 舊 fs::copy 語意＝create 即截斷
    std::io::Write::write_all(&mut f, format!("S{}", i).as_bytes()).unwrap();
    results.push(dest);
  }
  println!("SAME_PATH:{}", results[0] == results[1]);
  println!("FIRST_CONTENT:{}", String::from_utf8(std::fs::read(dirp.join("teno-1786230000.db")).unwrap()).unwrap());
  println!("FILE_COUNT:{}", std::fs::read_dir(dirp).unwrap().count());
}
`;
  const ors = join(dir, 'd17old.rs');
  writeFileSync(ors, oldHarn);
  const oc = sh(`rustc -O ${ors} -o ${join(dir, 'd17old')} 2>&1`, { timeout: 120000 });
  if (oc.code !== 0) throw new Error('負控制 rustc 失敗: ' + oc.out.slice(0, 300));
  const od = join(dir, 'old'); sh(`mkdir -p ${od}`);
  const oo = sh(`${join(dir, 'd17old')} ${od}`).out;
  ok('T3d 徵狀1 重現：同秒兩次＝同一目的地路徑', /SAME_PATH:true/.test(oo), oo);
  ok('T3e 徵狀2 重現：首快照被截斷覆寫（S0→S1）', /FIRST_CONTENT:S1/.test(oo) && /FILE_COUNT:1/.test(oo), oo);
  // 判別性：新碼同 ts 兩次（取 T1 seq 前兩呼等效）＝兩檔首檔 S0 留存
  const nd = join(dir, 'newdisc'); sh(`mkdir -p ${nd}`);
  const no = sh(`${join(dir, 'd17new')} ${nd} seq 1786230000000000000`).out;
  ok('T3f 判別性釘：新碼同 ts＝兩檔＋首檔 S0 留存（新舊對跑非兩邊空轉）',
    /FIRST_CONTENT:S0/.test(no) && /FILE_COUNT:5/.test(no), no);
}

// ── T4: 結構釘 + cargo check ──────────────────────────────────────
console.log('== T4: 結構釘 + cargo check ==');
{
  const fn = src.slice(src.indexOf('fn backup_db'), src.indexOf('fn prune_backups'));
  ok('T4a backup_db 委派 unique_backup_dest（非內聯）', fn.includes('unique_backup_dest(&backups_dir'));
  ok('T4b as_secs 命名殲滅（nanos 在位）', !fn.includes('as_secs()') && fn.includes('as_nanos()'));
  ok('T4c fs::copy 直寫目标殲滅（io::copy 到已獨佔建立檔柄）', !fn.includes('std::fs::copy') && fn.includes('std::io::copy'));
  ok('T4d 複製失敗清半成品（零 0B 幽靈備份）', fn.includes('remove_file(&dest)'));
  ok('T4e nanos 溢出鉗位在位（R1#1-M-1：.min(u64::MAX as u128)）', fn.includes('.min(u64::MAX as u128)'));
  const dest = src.slice(src.indexOf('fn unique_backup_dest'), src.indexOf('fn backup_db'));
  ok('T4f 0600 權限釘在位（R1#1-M-2：mode(0o600)+OpenOptionsExt import）', dest.includes('.create_new(true).mode(0o600)') && dest.includes('OpenOptionsExt')); // R1#3-F-2：鏈式調用緊釘，防註解 token 騙過
  const h = sh('cd src-tauri && cargo check --quiet 2>&1', { timeout: 600000 });
  ok('T4g host cargo check 綠', h.code === 0, h.out);
}
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n== D17 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
