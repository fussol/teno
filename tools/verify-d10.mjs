#!/usr/bin/env node
// verify-d10.mjs — D10: find_db_file 同名多檔 random first()（無排序無時間比較）
// 雙態自適應：PRE=未修法（bug 在場釘）、POST=修法後全綠集（偵測 pick_latest_file 在場與否）。
// 負控制：T3 真碼提取 /tmp 獨立 crate（serde_json 走 registry cache，--offline）＋
//         T4 first() 直通 NC 腿必紅＋ T5 基線釘 pin 792264e 同掃描器精準紅集。
// 嚴禁真連 Google API——全程離線靜態/編譯/微編譯斷言，零網路呼叫。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = '/home/jupiter/teno';
const SRC = path.join(REPO, 'src-tauri/src/drive_sync.rs');
const BASELINE = '792264e'; // D11 commit：drive_sync.rs 現行最後快照（F9 教訓：pin hash 不 pin HEAD）
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

// R1#3 強化（攻5/攻6）：掃描/提取前剝 block comment——註解內 decoy 字樣與
// 假函式一律殲滅；URL 斷言限定 find_db_file 體內（死碼+註解藏字樣騙不了）。
const stripBlock = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

// ── 掃描器（T1 與 T5 共用同一份——負控制有意義的前提）────────────────
function scanDriveSync(rawSrc) {
  const src = stripBlock(rawSrc);
  const bodyOf = (name) => {
    const i = src.indexOf(`fn ${name}(`);
    if (i < 0) return null;
    const j = src.indexOf('\n}\n', i);
    return j < 0 ? null : src.slice(i, j + 3);
  };
  const findBody = bodyOf('find_db_file');
  return {
    // R1#3-1：URL 三釘全部縮圈 find_db_file 體內（防 evil_A 全檔散佈魔法字串）
    orderBy: findBody !== null && findBody.includes('orderBy='),
    orderByEnc: findBody !== null && findBody.includes('urlencode("modifiedTime desc")'),
    fieldsFull: findBody !== null && findBody.includes('fields=files(id,modifiedTime)'),
    fieldsBare: findBody !== null && findBody.includes('fields=files(id)"'),
    pickFn: /fn pick_latest_file\s*\(/.test(src),
    pickFnUnique: (src.match(/fn pick_latest_file\s*\(/g) || []).length === 1, // R1#3-3 防 decoy 並存
    findDelegates: findBody !== null && findBody.includes('pick_latest_file('),
    findRawFirst: findBody !== null && findBody.includes('.first()'),
    _findBodyPresent: findBody !== null,
  };
}

const srcRaw = fs.readFileSync(SRC, 'utf8');
const src = stripBlock(srcRaw);
const w = scanDriveSync(srcRaw);
const state = w.pickFn ? 'POST' : 'PRE';
console.log(`D10 verify — 狀態偵測: ${state}（pick_latest_file ${w.pickFn ? '在場' : '缺席'}）\n`);

// ── T1 源碼靜態釘 ───────────────────────────────────────────────
console.log('T1 源碼靜態釘:');
if (state === 'POST') {
  ok(w.orderBy, 'T1a orderBy 參數在場');
  ok(w.orderByEnc, 'T1b urlencode("modifiedTime desc") 在場');
  ok(w.fieldsFull, 'T1c fields=files(id,modifiedTime) 在場');
  ok(!w.fieldsBare, 'T1d 裸 fields=files(id)" 殲滅');
  ok(w.pickFn, 'T1e fn pick_latest_file 在場');
  ok(w._findBodyPresent && w.findDelegates, 'T1f find_db_file 委派 pick_latest_file');
  ok(w._findBodyPresent && !w.findRawFirst, 'T1g find_db_file 體 .first() 盲取殲滅');
  ok(w.pickFnUnique, 'T1h pick_latest_file 唯一定義（R1#3 防註解 decoy 並存）');
} else {
  ok(w.orderBy === false, 'T1p-a bug 在場: 無 orderBy');
  ok(w.fieldsBare === true && w.fieldsFull === false, 'T1p-b bug 在場: fields 只取 id');
  ok(w.pickFn === false, 'T1p-c bug 在場: 無 pick_latest_file');
  ok(w._findBodyPresent && w.findRawFirst === true, 'T1p-d bug 在場: find_db_file .first() 盲取');
}

// ── T2 倉內單元測試牙 ───────────────────────────────────────────
console.log('T2 cargo test drive_sync:');
const t2 = sh('cd src-tauri && cargo test --offline drive_sync 2>&1');
const t2out = t2.stdout + t2.stderr;
const t2green = /test result: ok\./.test(t2out) && t2.status === 0;
const hasD10Test = t2out.includes('d10_pick_latest_file_forms');
if (state === 'POST') {
  ok(t2green, 'T2a cargo test drive_sync 全綠', t2out.split('\n').filter(l => l.includes('error') || l.includes('failed')).slice(0, 3).join(' | '));
  ok(hasD10Test, 'T2b d10_pick_latest_file_forms 在場且執行');
} else {
  ok(!hasD10Test, 'T2p d10 測試缺席（修法未落，符合 PRE 態）');
}

// ── 真碼提取（T3/T4 共用）───────────────────────────────────────
function extractPickLatest(s) {
  const i = s.indexOf('fn pick_latest_file');
  if (i < 0) return null;
  const j = s.indexOf('\n}\n', i);
  return j < 0 ? null : s.slice(i, j + 3);
}
// NC 版：first() 直通（語意=bug 本體：盲取陣列第一顆有 id 的）
const NC_IMPL = `fn pick_latest_file(files: &serde_json::Value) -> Option<String> {
    let arr = files.as_array()?;
    arr.iter().find_map(|f| f["id"].as_str().map(String::from))
}
`;

const HARNESS = `
fn main() {
    let mut fail = 0usize;
    let mut leg = |name: &str, got: Option<String>, want: Option<String>| {
        if got == want { println!("LEG {}: PASS", name); }
        else { println!("LEG {}: FAIL got={:?} want={:?}", name, got, want); fail += 1; }
    };
    // L1 舊→新排列（first 直取必錯）
    let l1 = serde_json::json!([
        {"id":"OLD","modifiedTime":"2026-01-01T00:00:00.000Z"},
        {"id":"MID","modifiedTime":"2026-03-05T08:00:00.000Z"},
        {"id":"NEW","modifiedTime":"2026-06-15T12:30:00.500Z"}]);
    leg("old-to-new", pick_latest_file(&l1), Some("NEW".into()));
    // L2 新→舊反序（正確实现與 bug 皆 NEW——判別性由 L1 承擔，本腿防反向誤殺）
    let l2 = serde_json::json!([
        {"id":"NEW","modifiedTime":"2026-06-15T12:30:00.500Z"},
        {"id":"MID","modifiedTime":"2026-03-05T08:00:00.000Z"},
        {"id":"OLD","modifiedTime":"2026-01-01T00:00:00.000Z"}]);
    leg("new-to-old", pick_latest_file(&l2), Some("NEW".into()));
    // L3 全缺 modifiedTime → 退回首顆有 id（不退化於現況）
    let l3 = serde_json::json!([{"id":"A"},{"id":"B"}]);
    leg("no-mtime-fallback-first", pick_latest_file(&l3), Some("A".into()));
    // L4 空陣列 → None
    leg("empty-none", pick_latest_file(&serde_json::json!([])), None);
    // L5 非陣列 → None
    leg("nonarray-none", pick_latest_file(&serde_json::json!({"id":"X"})), None);
    // L6 單檔
    let l6 = serde_json::json!([{"id":"SOLO","modifiedTime":"2026-02-02T02:02:02.000Z"}]);
    leg("single", pick_latest_file(&l6), Some("SOLO".into()));
    // L7 跨年月真實 RFC3339 邊界
    let l7 = serde_json::json!([
        {"id":"DECEMBER","modifiedTime":"2025-12-31T23:59:59.999Z"},
        {"id":"JANUARY","modifiedTime":"2026-01-01T00:00:00.000Z"}]);
    leg("year-boundary", pick_latest_file(&l7), Some("JANUARY".into()));
    // L8 最新條目缺 id → 跳過取次新
    let l8 = serde_json::json!([
        {"modifiedTime":"2026-09-09T00:00:00.000Z"},
        {"id":"Z","modifiedTime":"2026-01-01T00:00:00.000Z"}]);
    leg("skip-idless", pick_latest_file(&l8), Some("Z".into()));
    // L9 mixed：部分缺 mtime → 只在有 mtime 者中取最新
    let l9 = serde_json::json!([
        {"id":"NOMTIME"},
        {"id":"OLD2","modifiedTime":"2024-01-01T00:00:00.000Z"},
        {"id":"NEW2","modifiedTime":"2027-01-01T00:00:00.000Z"}]);
    leg("mixed-mtime", pick_latest_file(&l9), Some("NEW2".into()));
    // L10 平手 mtime → 留首見（R1#1：對齊 orderBy desc 首顆最新）
    let l10 = serde_json::json!([
        {"id":"TIE_FIRST","modifiedTime":"2026-05-05T05:05:05.555Z"},
        {"id":"TIE_LAST","modifiedTime":"2026-05-05T05:05:05.555Z"}]);
    leg("tie-keeps-first", pick_latest_file(&l10), Some("TIE_FIRST".into()));
    if fail > 0 { println!("HARNESS FAIL count={}", fail); std::process::exit(1); }
    println!("HARNESS OK");
}
`;

function buildAndRun(tag, implCode) {
  const dir = path.join(os.tmpdir(), `teno-d10-verify-${tag}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cargo.toml'),
    `[package]\nname = "d10verify${tag}"\nversion = "0.0.0"\nedition = "2021"\n[dependencies]\nserde_json = "1"\n`);
  fs.writeFileSync(path.join(dir, 'src/main.rs'), implCode + HARNESS);
  const r = spawnSync('bash', ['-c',
    `cd '${dir}' && cargo run --offline --quiet 2>&1`],
    { encoding: 'utf8', env: ENV, timeout: 300000 });
  return r.stdout + r.stderr;
}

// ── T3 真碼提取行為級（POST 態才有真碼可提）─────────────────────
console.log('T3 真碼微編譯行為級:');
if (state === 'POST') {
  const implFixed = extractPickLatest(src);
  ok(implFixed !== null, 'T3a pick_latest_file 真碼提取成功');
  if (implFixed) {
    const out3 = buildAndRun('fixed', implFixed);
    ok(out3.includes('HARNESS OK'), 'T3b 真碼 10 向量全過', out3.split('\n').filter(l => l.includes('FAIL')).slice(0, 3).join(' | '));
    // ── T4 負控制：first() 直通 NC → L1/L7/L9 必紅 ────────────
    console.log('T4 負控制 NC:');
    ok(NC_IMPL.trim() !== implFixed.trim(), 'T4a NC≠真碼（反換釘，防 someone 把 NC 換成正确码騙過）');
    const out4 = buildAndRun('nc', NC_IMPL);
    ok(out4.includes('LEG old-to-new: FAIL'), 'T4b NC 於 old-to-new 腿精準復現 bug（紅）');
    ok(out4.includes('LEG year-boundary: FAIL'), 'T4c NC 於 year-boundary 腿復現');
    ok(/HARNESS FAIL/.test(out4), 'T4d NC harness 整體判紅（測試有牙非永綠）');
  }
} else {
  // PRE 態：NC 腿仍跑（NC=bug 語意的編譯級呈現，PRE 態斷言其「與工作區源碼同錯」）
  const out4 = buildAndRun('nc', NC_IMPL);
  ok(out4.includes('LEG old-to-new: FAIL'), 'T4p NC(old-to-new 紅)＝bug 語意獨立復現，與 PRE 源碼行為同構');
}

// ── T5 基線釘 pin（恆常，防 POST 腐化 + 證掃描器有牙）────────────
console.log('T5 基線釘 pin ' + BASELINE + ':');
const t5 = sh(`git show ${BASELINE}:src-tauri/src/drive_sync.rs`);
if (t5.status === 0) {
  const b = scanDriveSync(t5.stdout);
  ok(b.orderBy === false && b.orderByEnc === false, 'T5a 基線無 orderBy（紅集1）');
  ok(b.fieldsBare === true && b.fieldsFull === false, 'T5b 基線 fields 只取 id（紅集2）');
  ok(b.findRawFirst === true, 'T5c 基線 .first() 盲取在場（紅集3）');
  ok(b.pickFn === false, 'T5d 基線無 pick_latest_file（紅集4）');
} else {
  ok(false, 'T5 基線 git show 失敗', t5.stderr.slice(0, 200));
}

// ── T-CLI v3：CLI 雙鏡像 find_db_file 鏡像同步（D10-SR1/SR2）────────────
// 段提取防範（v2 委員0 縫2）：①先剝 block comment 才定錨（防 V4 block 內埋假錨）；
// ②錨點 `// find_db_file` 需獨立一行且行首（防字串/註解內同字樣劫持）；
// ③結束 marker `if (sub === 'upload')` 亦行首（防 V3 把 marker 埋字串提前截斷）。
function cliFindBody(rawSrc) {
  const noBlock = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = noBlock.match(/^[ \t]*\/\/ find_db_file[ \t]*$/m);
  if (!m) return null;
  const s = noBlock.slice(m.index).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const mm = s.match(/^[ \t]*if \(sub === 'upload'\)/m);
  return mm ? s.slice(0, mm.index) : s.slice(0, 1400);
}
function scanCli(body) {
  if (!body) return null;
  // URL 判言縮到 fetch 行並採結構化（真 query-param 格式），防誘餌字樣埋 URL
  // 路徑段/headers 物件值（V2）。
  const fetchLine = (body.match(/listResp\s*=\s*await\s*fetch\(([^\n]*)/) || [])[1] || '';
  return {
    orderBy: /[?&]orderBy=\$\{encodeURIComponent\("modifiedTime desc"\)\}/.test(fetchLine),
    fieldsFull: /[?&]fields=files\(id,modifiedTime\)/.test(fetchLine),
    fieldsBare: /[?&]fields=files\(id\)/.test(fetchLine),          // 負向釘（對拍 T1d）
    blindFirst: /files(\?\.)?\s*\[\s*0\s*\]/.test(body)             // .files[0]/[?] 家族
      || /\[\s*\w+\s*\]\s*=\s*[\w.]*files\b/.test(body),            // 解構盲取 `[f0] = list.files`
    pickCall: /\bpickLatestDriveFile\s*\(/.test(body),              // v4: 委派呼叫在場（迴圈已入純函式，行為級 TH 治本）
  };
}
console.log('T-CLI CLI 雙鏡像 find_db_file 鏡像同步:');
const CLI_PATHS = ['tools/cli.mjs', '_dev/cli/cli.mjs'];
for (const p of CLI_PATHS) {
  const raw = fs.readFileSync(path.join(REPO, p), 'utf8');
  const body = cliFindBody(raw);
  ok(body !== null, `TCLI-${p} find_db_file 段提取`);
  if (body) {
    const c = scanCli(body);
    ok(c.orderBy, `TCLI-${p} orderBy=modifiedTime desc 在場`);
    ok(c.fieldsFull, `TCLI-${p} fields=files(id,modifiedTime) 在場`);
    ok(!c.fieldsBare, `TCLI-${p} 裸 fields=files(id) 殲滅`);
    ok(!c.blindFirst, `TCLI-${p} .files[0]/解構盲取殲滅`);
    ok(c.pickCall, `TCLI-${p} pickLatestDriveFile 呼叫在場`);
  }
}
// NC 樣本牙：注入 bug 版 find_db_file 段 → 必抓盲取（非永綠）
{
  const NC_CLI = [
    '  // find_db_file',
    '  const listResp = await fetch(`...fields=files(id)`, {});',
    '  const list = await listResp.json();',
    '  let fileId = list.files?.[0]?.id || null;',
    '',
  ].join('\n');
  const n = scanCli(cliFindBody(NC_CLI));
  ok(n !== null, 'TCLI-NC 段提取');
  ok(n !== null && n.blindFirst === true, 'TCLI-NC 負控制: bug 版盲取被抓（掃描器有牙）');
  ok(n !== null && !(n.orderBy && n.fieldsFull), 'TCLI-NC 負控制: bug 版無 orderBy/無全 fields');
  ok(n !== null && n.pickCall === false, 'TCLI-NC 負控制: bug 版無 pickLatestDriveFile 呼叫');
}
// 行註解 decoy 牙：誘餌字樣埋 `//` 行註解（攻6）→ 四斷言不可全綠，盲取字面仍被抓。
{
  const DECOY = [
    '  // find_db_file',
    '  // aligned with Rust: orderBy=modifiedTime desc, fields=files(id,modifiedTime), bestMtime/firstWithId',
    '  const listResp = await fetch(`...fields=files(id)`, {});',
    '  const list = await listResp.json();',
    '  let fileId = list.files?.[0]?.id || null;',
    '',
  ].join('\n');
  const d = scanCli(cliFindBody(DECOY));
  ok(d !== null, 'TCLI-DECOY 段提取');
  ok(d !== null && !(d.orderBy && d.fieldsFull && d.pickCall), 'TCLI-DECOY: 行註解 decoy 不可全綠突破');
  ok(d !== null && d.blindFirst === true, 'TCLI-DECOY: decoy 盲取字面仍被抓');
}
// 解構盲取牙：`[f0] = list.files` 無點字樣（idimomatic JS 退化縫）→ 解構釘必抓。
{
  const DESTRUCT = [
    '  // find_db_file',
    '  const listResp = await fetch(`[...&orderBy=${encodeURIComponent("modifiedTime desc")}&fields=files(id,modifiedTime)]`, {});',
    '  const list = await listResp.json();',
    '  const [f0] = list.files || [];',
    '  let fileId = f0?.id || null;',
    '',
  ].join('\n');
  const d2 = scanCli(cliFindBody(DESTRUCT));
  ok(d2 !== null, 'TCLI-DESTRUCT 段提取');
  ok(d2 !== null && d2.blindFirst === true, 'TCLI-DESTRUCT: 解構盲取被抓（退化縫封死）');
}

// ── T-HARNESS：CLI 鏡像 pickLatestDriveFile 行為級（v4 替代結構，治本）────
// 純靜態字樣掃描本質防不了「字樣全真、行為假」語意假修法（v3 委員0 A2/A8/A12、
// 委員1/2 一致背書「治本在行為級」）。本 section 提取真碼 arrow 函式，以
// new Function 對 12 向量執行對拍（對齊 Rust T3 真碼微編譯精神）——語意假修法
// 即使字樣全真，跑 old-to-new 必選錯而判紅。靜態 T-CLI 僅作快速輔助層。
function extractPickDrive(src) {
  const tag = 'const pickLatestDriveFile = (files) => {';
  const start = src.indexOf(tag);
  if (start < 0) return null;
  let depth = 0, started = false, i = start, j = start;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) { i = j + 1; break; } }
  }
  return src.slice(start, i);
}
const PICK_VEC = [
  ['old-to-new',
    [{ id: 'OLD', modifiedTime: '2026-01-01T00:00:00.000Z' },
     { id: 'MID', modifiedTime: '2026-03-05T08:00:00.000Z' },
     { id: 'NEW', modifiedTime: '2026-06-15T12:30:00.500Z' }], 'NEW'],
  ['new-to-old',
    [{ id: 'NEW', modifiedTime: '2026-06-15T12:30:00.500Z' },
     { id: 'MID', modifiedTime: '2026-03-05T08:00:00.000Z' },
     { id: 'OLD', modifiedTime: '2026-01-01T00:00:00.000Z' }], 'NEW'],
  ['no-mtime-fallback', [{ id: 'A' }, { id: 'B' }], 'A'],
  ['empty', [], null],
  ['nonarray', { id: 'X' }, null],
  ['single', [{ id: 'SOLO', modifiedTime: '2026-02-02T02:02:02.000Z' }], 'SOLO'],
  ['year-boundary',
    [{ id: 'D', modifiedTime: '2025-12-31T23:59:59.999Z' },
     { id: 'J', modifiedTime: '2026-01-01T00:00:00.000Z' }], 'J'],
  ['skip-idless',
    [{ modifiedTime: '2026-09-09T00:00:00.000Z' },
     { id: 'Z', modifiedTime: '2026-01-01T00:00:00.000Z' }], 'Z'],
  ['mixed-mtime',
    [{ id: 'NOMTIME' }, { id: 'O', modifiedTime: '2024-01-01T00:00:00.000Z' },
     { id: 'N', modifiedTime: '2027-01-01T00:00:00.000Z' }], 'N'],
  ['tie-keeps-first',
    [{ id: 'TF', modifiedTime: '2026-05-05T05:05:05.555Z' },
     { id: 'TL', modifiedTime: '2026-05-05T05:05:05.555Z' }], 'TF'],
  ['null-entry', [null, { id: 'A', modifiedTime: '2026-01-01T00:00:00.000Z' }], 'A'],
  ['nonstring-id',
    [{ id: 123, modifiedTime: '2026-09-09T00:00:00.000Z' },
     { id: 'S', modifiedTime: '2026-01-01T00:00:00.000Z' }], 'S'],
];
// NC 腿：first() 直通（bug 語意）——行為級也非永綠。
const NC_PICK = 'const pickLatestDriveFile = (files) => { const a = Array.isArray(files) ? files : []; const f = a.find(x => x && x.id); return f ? f.id : null; };';
console.log('T-HARNESS CLI pickLatestDriveFile 行為級:');
{
  // v4 修正（委員1/2）：行為級覆蓋「兩鏡像」非僅 tools；附兩鏡像提取碼逐字
  // 一致斷言（跨鏡像同 hunk 治理）；NC 補 L7 腿（§4 文字 L1/L7 對齊）。
  const codes = {};
  let firstCode = null, synced = true, anyDef = false, anyOrphan = false;
  for (const p of CLI_PATHS) {
    const src = fs.readFileSync(path.join(REPO, p), 'utf8');
    const code = extractPickDrive(src);
    codes[p] = code;
    const findBody = cliFindBody(src);
    const call = findBody !== null && /\bpickLatestDriveFile\s*\(/.test(findBody);
    if (code !== null && !call) anyOrphan = true;
    if (call && code === null) anyOrphan = true;
    if (code !== null) anyDef = true;
    if (code !== null && firstCode === null) firstCode = code;
    else if (code !== null && code !== firstCode) synced = false;
  }
  if (anyDef && !anyOrphan) {
    ok(synced, 'TH-sync: 兩鏡像 pickLatestDriveFile 提取碼逐字一致');
    for (const p of CLI_PATHS) {
      const code = codes[p];
      if (code === null) continue;
      let allOk = true, thrown = 0;
      for (const [name, input, want] of PICK_VEC) {
        let got;
        try { got = new Function('files', code + ';\nreturn pickLatestDriveFile(files);')(input); }
        catch (e) { got = 'THROW: ' + e.message; thrown++; }
        ok(got === want, `TH-${p}-${name}`, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
        if (got !== want) allOk = false;
      }
      ok(allOk, `TH-${p}: 12 向量全過`);
      ok(thrown === 0, `TH-${p}: 無 throw（null/nonstring 不 crash）`);
    }
    const nc0 = new Function('files', NC_PICK + ';\nreturn pickLatestDriveFile(files);')
      ([{ id: 'OLD', modifiedTime: '2026-01-01T00:00:00.000Z' },
        { id: 'NEW', modifiedTime: '2026-06-15T12:30:00.500Z' }]);
    ok(nc0 === 'OLD', 'TH-NC: first() 版 old-to-new 選錯');
    const nc1 = new Function('files', NC_PICK + ';\nreturn pickLatestDriveFile(files);')
      ([{ id: 'D', modifiedTime: '2025-12-31T23:59:59.999Z' },
        { id: 'J', modifiedTime: '2026-01-01T00:00:00.000Z' }]);
    ok(nc1 === 'D', 'TH-NC-year: first() 版 year-boundary 選錯');
  } else if (!anyDef) {
    ok(true, 'TH-PRE: 兩鏡像定義皆缺席＝bug 在場（行為腿待 POST 啟用）');
  } else {
    ok(false, 'TH-orphan: 有定義無呼叫或反之（鏡像不同步）');
  }
}

console.log(`\n=== ${state} 結果: ${pass} PASS / ${fail} FAIL ===`);
if (fail > 0) { console.log('FAILS: ' + fails.join('; ')); process.exit(1); }
console.log('ALL PASS');
