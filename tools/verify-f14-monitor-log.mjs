#!/usr/bin/env node
// verify-f14-monitor-log.mjs — log_msg /tmp symlink 追擊殲滅（F14）
// 真碼提取向量機＋負控制（pin 靜態 hash 舊碼追擊重現）
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/home/jupiter/teno';
const LIB_RS = join(ROOT, 'src-tauri/src/lib.rs');
const OLD_HASH = '776cb5c'; // F14 前最後 commit（靜態 pin，F9 教訓）
const sh = (c, opt = {}) => {
  try { return { out: execSync(c, { encoding: 'utf8', cwd: ROOT, ...opt }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? -1 }; }
};
let pass = 0, fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${x ? ' :: ' + x.slice(0, 300) : ''}`); }
};

const src = readFileSync(LIB_RS, 'utf8');
// ============================================================
// v1.3（R3#2 處方1，掃描層結構重做——憲法⑩：v1.2「刪除式」stripper
// 輸出與原文偏移脫鉤，extract/scanWriters 的括號計數只能跑原文，字符串
// 內 `"}"` 毒彈令體邊界提前斷氣（M2 逃逸＝產品有漏洞而全綠，runtime 實錘）。
// 結構性替代＝「抹除式」位置保持遮罩：註解與字符串/char 內容原位抹為空格、
// 換行保留、輸出與輸入逐byte等長。所有結構掃描（fn 體邊界、括號配平、
// offset 區間歸屬）一律跑遮罩文，needle 內容層不變：
//   maskAll(s)  ＝註解＋字符串＋char＋raw string 全消（identifier 級）
//   maskLits(s) ＝只剝註解留字符串內容（字面值級）
// 威脅模型（F17 先例成文）：防無意回歸與已知對抗偽裝（`}"` 毒彈、decoy
// 搶首顆、shadow 常數）；不抵禦惡意 proc-macro 注入級攻擊（列 advisory）。
// ============================================================
function maskEngine(s, blankStrings) {
  let out = '', i = 0, st = 'code', depth = 0;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (st === 'code') {
      if (c === '/' && n === '/') { out += '  '; st = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { out += '  '; st = 'block'; depth = 1; i += 2; continue; }
      // raw string r#*"…"*#（回引用精確閉合，多行安全；b'r"…"' 同支）
      if (c === 'r' || (c === 'b' && n === 'r')) {
        let j = c === 'b' ? i + 2 : i + 1, h = 0;
        while (s[j + h] === '#') h++;
        if (s[j + h] === '"') {
          const close = '"' + '#'.repeat(h);
          const end = s.indexOf(close, j + h + 1);
          const segEnd = end < 0 ? s.length : end + close.length;
          // R4#2-A1：raw string 無轉義，maskLits 必逐字保留（與普通字符串
          // 同約——v1.3 首版無視 blankStrings 整段抹除，raw string 內 /tmp
          // 後门對一切字面值層針失明）；maskAll 照樣消音
          out += blankStrings ? s.slice(i, segEnd).replace(/[^\n]/g, ' ') : s.slice(i, segEnd);
          i = segEnd; continue;
        }
      }
      if (c === '"') { out += '"'; st = 'str'; i++; continue; }
      // char / byte-char 字面量（lifetime 'a 無閉合引號不誤傷）
      const cm = /^b?'(?:\\(?:.|x[0-9a-fA-F]{2,8}|u\{[0-9a-fA-F]{4}\})|[^'\\'])'/.exec(s.slice(i));
      if (cm && (c === "'" || (c === 'b' && n === "'"))) { out += cm[0].replace(/[^\n]/g, ' '); i += cm[0].length; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c; } else out += ' '; i++; continue; }
    if (st === 'block') { // 巢狀深度計數（Rust block comment 可巢狀）
      if (c === '/' && n === '*') { out += '  '; depth++; i += 2; continue; }
      if (c === '*' && n === '/') { out += '  '; depth--; i += 2; if (depth === 0) st = 'code'; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // str 態：blankStrings=true 內容抹除；false 逐字保留
    if (c === '\\') { out += blankStrings ? '  ' : c + (n === undefined ? ' ' : n); i += 2; continue; }
    if (c === '"') { out += '"'; st = 'code'; i++; continue; }
    out += blankStrings ? (c === '\n' ? '\n' : ' ') : c; i++; continue;
  }
  return out;
}
const maskAll = (s) => maskEngine(s, true);
const maskLits = (s) => maskEngine(s, false);
// 位置契約：遮罩輸出必與輸入等長（違約＝全部 offset 釘與區間歸屬失真）
{
  const a = maskAll(src), b = maskLits(src);
  if (a.length !== src.length || b.length !== src.length) { console.error('mask 長度漂移——位置契約破裂，abort'); process.exit(2); }
}
// 自簽釘（R2#2-修法1＋R3#2 擴充）：字符串/char/巢狀註解/raw string 中的
// 假針必須被消音；字面值層必須保留字符串內容；等長契約對變異體同樣成立
{
  const probe = 'let _ = "open_monitor_log(&dir) x();"; /* 巢狀 /* 深 */ open_monitor_log(&dir); */ let _r = r#"open_monitor_log(&dir)"#; let _q = \'\\\\\"\'; // open_monitor_log(&dir)\n';
  const m = maskAll(probe);
  if (m.includes('open_monitor_log(&dir)')) { console.error('maskAll 自簽失敗——T3 全段不可信'); process.exit(2); }
  if (!maskLits(probe).includes('open_monitor_log(&dir) x();')) { console.error('maskLits 自簽失敗——字面值層失準'); process.exit(2); }
  if (m.length !== probe.length || maskLits(probe).length !== probe.length) { console.error('mask 自簽等長契約失敗'); process.exit(2); }
  // `}"` 毒彈專probe（M2 封堵自證）：fn 體收束 `}` 之外的三顆 `}` 全部
  // 藏在字符串/raw string/char/註解內，遮罩後必只剩合法的一顆
  const poison = 'fn p() { let _g = "}"; let _h = \'{\'; let _r = r#"}"#; /* } */ let _k = "{\\"}"; }';
  const pm = maskAll(poison);
  if ((pm.match(/}/g) || []).length !== 1 || (pm.match(/\{/g) || []).length !== 1 || !pm.includes('fn p() {')) { console.error('maskAll 毒彈自簽失敗——`}"`/`{"` 消音失效（M2 復活）'); process.exit(2); }
  if (pm.length !== poison.length) { console.error('毒彈等長契約失敗'); process.exit(2); }
  // R4#2-A1 契約釘：raw string 內容在 maskLits 必存活、maskAll 必消音
  if (!maskLits('let _=r#"/tmp/z"#;').includes('/tmp') || maskAll('let _=r#"/tmp/z"#;').includes('/tmp')) { console.error('raw string 分層契約自簽失敗——A1 復活'); process.exit(2); }
}
const srcMask = maskAll(src);
const srcLits = maskLits(src);
const cargoEnv = { ...process.env, PATH: process.env.HOME + '/.cargo/bin:' + process.env.PATH };

// ---------- T0: cargo ----------
console.log('== T0: cargo 釘 ==');
const t0 = sh('cargo test --lib f14_monitor_log_symlink_guard 2>&1', { cwd: join(ROOT, 'src-tauri'), env: cargoEnv });
ok('T0a f14 unit test 1 passed / 0 failed', /1 passed; 0 failed/.test(t0.out) && /f14_monitor_log_symlink_guard \.\.\. ok/.test(t0.out), t0.out.slice(-300));

// ---------- 提取工具（v1.3：括號配平跑位置保持遮罩文，切片回原文；
// `"}"` 毒彈消音後體邊界不可撼動；MISS/多顆 decoy 即 abort） ----------
const extract = (name, s = src, sMask = srcMask) => {
  const cnt = (sMask.match(new RegExp(`fn ${name}\\(`, 'g')) || []).length;
  if (cnt !== 1) { console.error(`extract(${name}): 同名定義 ${cnt} 顆（decoy 嫌疑）——abort（G4）`); process.exit(2); }
  const i = sMask.indexOf(`fn ${name}(`);
  if (i < 0) throw new Error(`extract miss: ${name}`);
  let d = 0, k = sMask.indexOf('{', i);
  for (; k < sMask.length; k++) { if (sMask[k] === '{') d++; else if (sMask[k] === '}') { d--; if (d === 0) break; } }
  return s.slice(i, k + 1);
};

// ---------- T1: 真碼提取向量機 ----------
console.log('== T1: 真碼提取向量機 ==');
const fn = extract('open_monitor_log');
const dir = mkdtempSync(join(tmpdir(), 'f14-'));
writeFileSync(join(dir, 'h.rs'), `${fn}
fn main() {
    let dir = std::env::args().nth(1).unwrap();
    let dir = std::path::Path::new(&dir);
    let cmd = std::env::args().nth(2).unwrap();
    if cmd == "append" {
        let msg = std::env::args().nth(3).unwrap();
        match open_monitor_log(dir) { Some(mut f) => { use std::io::Write; let _ = writeln!(f, "{}", msg); println!("WROTE"); }, None => println!("NONE") }
    } else if cmd == "missingdir" {
        println!("{}", open_monitor_log(&dir.join("nope")).is_none());
    }
}
`);
const rb = sh(`rustc -o ${join(dir, 'h')} ${join(dir, 'h.rs')} 2>&1`);
ok('T1-r 真碼 harness 編譯綠（零改動可獨立組譯）', rb.code === 0, rb.out);
const wd = join(dir, 'w'); sh(`mkdir -p ${wd}`);
sh(`${join(dir, 'h')} ${wd} append L1`);
sh(`${join(dir, 'h')} ${wd} append L2`);
const logTxt = existsSync(join(wd, 'teno-monitor.log')) ? readFileSync(join(wd, 'teno-monitor.log'), 'utf8') : '';
ok('T1-1 正常雙附加順序保留（L1\\\\nL2）', logTxt === 'L1\nL2\n', JSON.stringify(logTxt));
const mode = sh(`stat -c %a ${join(wd, 'teno-monitor.log')}`).out.trim();
ok('T1-2 0600 私檔權限（F11 同課）', mode === '600', mode);
// symlink 預植攻擊
const ad = join(dir, 'attack'); sh(`mkdir -p ${ad}`);
writeFileSync(join(ad, 'victim.txt'), 'PRISTINE');
sh(`ln -s ${join(ad, 'victim.txt')} ${join(ad, 'teno-monitor.log')}`);
const ar = sh(`${join(dir, 'h')} ${ad} append PAYLOAD`).out.trim();
ok('T1-3 symlink 預植→回 None 拒寫（ELOOP 原子守門）', ar === 'NONE', ar);
ok('T1-4 受害者檔零增寫', readFileSync(join(ad, 'victim.txt'), 'utf8') === 'PRISTINE');
ok('T1-5 目錄不存在→None 不 panic', sh(`${join(dir, 'h')} ${wd} missingdir`).out.trim() === 'true');
// O_NOFOLLOW 常數真性（源碼硬編碼須與系統定義一致）
ok('T1-6 O_NOFOLLOW 0x20000 == 系統 os.O_NOFOLLOW', sh(`python3 -c "import os; print(hex(os.O_NOFOLLOW))"`).out.trim() === '0x20000');

// ---------- T2: 負控制（pin 靜態 hash，舊碼追擊重現） ----------
console.log('== T2: 負控制 ==');
const oldSrc = sh(`git show ${OLD_HASH}:src-tauri/src/lib.rs`).out;
ok('T2a 基準 pin 為靜態 hash（禁浮動 HEAD，F9 教訓）', /^[0-9a-f]{7}$/.test(OLD_HASH));
const oldLine = (oldSrc.match(/if let Ok\(mut f\) = std::fs::OpenOptions::new\(\)[^\n]*/g) || []);
ok('T2b 舊碼徵狀源碼真性（/tmp 固定路徑＋create+append 零防護）', oldLine.length >= 1 && oldLine[0].includes('"/tmp/teno-monitor.log"') && !oldLine[0].includes('custom_flags'), JSON.stringify(oldLine[0] || ''));
// 提取舊開啟語意，僅把 "/tmp/teno-monitor.log" 換 tempdir（命中恰 1 斷言）
const oldExprRaw = 'std::fs::OpenOptions::new().create(true).append(true).open("/tmp/teno-monitor.log")';
const oldExpr = oldExprRaw.replace('"/tmp/teno-monitor.log"', 'dir.join("teno-monitor.log")');
ok('T2c 單點替換恰命中 1 次（D17 變異學，防無效變體假綠）', (oldExprRaw.match(/\/tmp\/teno-monitor\.log/g) || []).length === 1);
writeFileSync(join(dir, 'o.rs'), `fn main() {
    let a = std::env::args().nth(1).unwrap();
    let dir = std::path::Path::new(&a);
    use std::io::Write;
    if let Ok(mut f) = ${oldExpr} { let _ = writeln!(f, "PAYLOAD"); println!("WROTE"); } else { println!("FAILED"); }
}
`);
const ob = sh(`rustc -o ${join(dir, 'o')} ${join(dir, 'o.rs')} 2>&1`);
ok('T2-r 舊碼 harness 編譯綠', ob.code === 0, ob.out);
const od = join(dir, 'oldattack'); sh(`mkdir -p ${od}`);
writeFileSync(join(od, 'victim.txt'), 'PRISTINE');
sh(`ln -s ${join(od, 'victim.txt')} ${join(od, 'teno-monitor.log')}`);
const oo = sh(`${join(dir, 'o')} ${od}`).out.trim();
ok('T2d 徵狀重現：舊碼 symlink 照追（WROTE）', oo === 'WROTE', oo);
ok('T2e 受害者檔被附加 PAYLOAD（arbitrary-append 原語實錘）', readFileSync(join(od, 'victim.txt'), 'utf8') === 'PRISTINEPAYLOAD\n', readFileSync(join(od, 'victim.txt'), 'utf8'));
ok('T2f 判別性釘：同攻擊場景新碼拒舊碼從（一紅一綠非兩邊空轉）', ar === 'NONE' && oo === 'WROTE');

// ---------- T3: 結構釘（R2 處方 v1.2＋R3#2 v1.3 位置保持遮罩） ----------
console.log('== T3: 結構釘 ==');
const fnCode = maskAll(fn);              // identifier 級：註解＋字符串全消
const fnLit = maskLits(fn);              // 字面值級：只剝註解留字符串
const lmFull = extract('log_msg');
const lm = maskAll(lmFull);
const lmLit = maskLits(lmFull);
// T3a（R2#2-修法4）：範圍釘＝兩函式體（留字面值）零 /tmp 子串——V10 拆字、
// V10B 變數綁定一併堵死；棄全檔鄰接 regex。
ok('T3a open_monitor_log＋log_msg 體零 /tmp 子串（scope 釘，N3/V10/V10B 堵）', !fnLit.includes('/tmp') && !lmLit.includes('/tmp'));
ok('T3b log_msg 經守門 fn（消音後正向釘）', lm.includes('open_monitor_log(&dir)') && lm.includes('app_log_dir()'));
// T3b2（R2#2-修法3）：log_msg 體零一切自建寫路徑（File::options 繞道面）
ok('T3b2 log_msg 零繞道（消音後禁 OpenOptions/File::options/File::create/File::open/fs::write/.open(）（N1/N3 堵）',
  !lm.includes('OpenOptions') && !lm.includes('File::options') && !lm.includes('File::create') && !lm.includes('File::open') && !lm.includes('fs::write') && !lm.includes('.open('));
ok('T3c 守門在位（代碼層 custom_flags(O_NOFOLLOW)＋mode(0o600)＋字面值層 gate 含 android）（V3/N2 堵）', fnCode.includes('custom_flags(O_NOFOLLOW)') && fnCode.includes('mode(0o600)') && fnLit.includes('target_os = "android"'));
ok('T3c2 per-arch 常數表在位（數值 0x8000/0x20000 代碼層＋target_arch 字面值層，R1#3-F-1）', fnCode.includes('0x8000') && fnCode.includes('0x20000') && fnLit.includes('target_arch = "aarch64"') && fnLit.includes('target_arch = "arm"'));
ok('T3d 前端 invoke 簽名零變動（main.js 仍 { msg }）', readFileSync(join(ROOT, 'src/main.js'), 'utf8').includes("invoke('log_msg', { msg:"));
ok('T3e F14-SR1 已登記 scope-requests（R5 標籤誠實化：待裁示≠已落盤）', readFileSync(join(ROOT, '_dev/notes/scope-requests.md'), 'utf8').includes('F14-SR1'));
ok('T3c3 負控制保真補釘：oldExprRaw 於 pin 原文逐字命中（#1 nit）', oldSrc.includes(oldExprRaw));
// T3g（R3#2-處方3＋v1.3 遮罩化）：呼叫面閉包——log_msg 可達同檔 fn 全數納入，
// 寫入原語僅准落唯一守門 fn（B2「搬進 sneaky helper 再呼叫」復活了必紅）。
// fn 前綴正規式跑遮罩文（R5#2-P1＋R6#2-RA：pub(...)/const/extern "C"/async/
// unsafe/default 全收；名字類必大小寫通收——大寫首字母寫源曾雙盲登記冊＋閉包 BFS）
const FN_DEF_RE = /^\s*(?:pub(?:\([^)]*\))?\s+|const\s+|extern\s+(?:"[^"]*"\s+)?|async\s+|unsafe\s+|default\s+)*fn\s+([A-Za-z0-9_]+)\s*[<(]/gm;
// v1.3（R3#2 處方2）：寫源登記冊掃描器——模式集與 T3g2 對齊（M1「新模式不在
// 冊」堵）；掃描跑位置保持遮罩文（M2「`"}"` 提前斷氣」堵）；體邊界外＝
// 模組作用域落點獨立上報（函式 span 之外藏寫源堵）；#[cfg(test)] 測試模組豁免。
const WRITE_PATTERNS = [
  ['OpenOptions', /OpenOptions/g], ['File::options', /File::options/g],
  ['File::create', /File::create/g], ['File::open', /File::open/g],
  ['fs::write', /fs::write/g], ['fs::copy', /fs::copy/g], ['fs::rename', /fs::rename/g],
  ['\\.open\\s*(', /\.open\s*\(/g],
];
function braceSpan(masked, from) {
  let d = 0;
  for (let i = from; i < masked.length; i++) { const ch = masked[i]; if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) return i; } }
  return -1;
}
function scanWriters(text, masked = maskAll(text)) {
  const spans = [];
  for (const m of masked.matchAll(FN_DEF_RE)) {
    const openIdx = masked.indexOf('{', m.index);
    if (openIdx < 0) continue;
    const end = braceSpan(masked, openIdx);
    if (end > 0) spans.push({ name: m[1], start: m.index, end });
  }
  const testSpans = [];
  for (const m of masked.matchAll(/#\[cfg\(test\)\]/g)) {
    const openIdx = masked.indexOf('{', m.index);
    if (openIdx < 0) continue;
    const end = braceSpan(masked, openIdx);
    if (end > 0) testSpans.push([m.index, end]);
  }
  const inTest = (off) => testSpans.some(([a, b]) => off >= a && off <= b);
  const byFn = new Map();
  const orphans = [];
  for (const [label, re] of WRITE_PATTERNS) {
    for (const m of masked.matchAll(new RegExp(re.source, 'g'))) {
      if (inTest(m.index)) continue;
      const f = spans.find((s2) => m.index >= s2.start && m.index <= s2.end);
      if (!f) { orphans.push({ label, line: text.slice(0, m.index).split('\n').length }); continue; }
      if (!byFn.has(f.name)) byFn.set(f.name, new Set());
      byFn.get(f.name).add(label);
    }
  }
  return { byFn, orphans, spans };
}
// 自簽釘（R5#2-處方1＋R3#2 擴充）：前綴隱形、`"}"` 毒彈隱形、大小寫名字
// 三種復活路徑都必須被探針逮到，否則整段登記冊不可信 exit(2)
{
  const wprobe = 'pub(crate) fn sneaky_a() { let _o = std::fs::OpenOptions::new(); }\nconst fn sneaky_b() -> u8 { let _o = std::fs::File::options(); 0 }\npub fn SneakyWriter() { let _o = std::fs::OpenOptions::new(); }\nfn sneaky_c() { let _g = "}"; let _o = std::fs::OpenOptions::new(); }\nfn sneaky_d() { std::fs::write("/tmp/x", b"m"); }\nfn clean() { let _ = 1; }\n';
  const { byFn: wgot, orphans: word } = scanWriters(wprobe);
  const names = [...wgot.keys()];
  if (!(names.includes('sneaky_a') && names.includes('sneaky_b') && names.includes('SneakyWriter') && names.includes('sneaky_c') && names.includes('sneaky_d') && names.length === 5 && word.length === 0)) { console.error(`寫源掃描自簽失敗（前綴/毒彈/名字類隱形）：${names.join(',')}`); process.exit(2); }
  if (!wgot.get('sneaky_d').has('fs::write')) { console.error('寫源掃描自簽失敗（fs::write 模式缺席）'); process.exit(2); }
}
const fnDefs = new Set([...srcMask.matchAll(FN_DEF_RE)].map(m => m[1]));
const closure2 = new Set(['log_msg']);
const queue = ['log_msg'];
while (queue.length) {
  const name = queue.shift();
  const body = maskAll(extract(name));
  for (const c of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (fnDefs.has(c[1]) && !closure2.has(c[1])) { closure2.add(c[1]); queue.push(c[1]); }
  }
}
ok('T3g 呼叫面閉包收斂（log_msg→open_monitor_log，含 log_msg≥2 員）', closure2.size >= 2 && closure2.has('open_monitor_log'), [...closure2].join(','));
{
  const viol = [];
  for (const f2 of closure2) {
    if (f2 === 'open_monitor_log') continue; // 唯一准寫者
    const b = maskAll(extract(f2)), bl = maskLits(extract(f2));
    for (const [label, re] of WRITE_PATTERNS) if (new RegExp(re.source).test(b)) viol.push(`${f2}:${label}`);
    if (bl.includes('/tmp')) viol.push(`${f2}:/tmp`);
  }
  ok('T3g2 閉包內寫入原語限唯一守門 fn＋零 /tmp（B2 helper 搬遷堵）', viol.length === 0, viol.join(','));
}
// T3h（R6#2-RB 修）：token 計數針綁死「dir」一字即全盲——棄枚舉/計數，改
// **體整形釘**：消音（留字面值）後 log_msg 體逐字等於唯一准模板（空白折疊）。
// 任何附加行/改名陰影/旁呼叫/參數竄改自然斃命；合法演化須同步腳本＝(f) 治理耦台。
{
  const CANON_LM = 'fn log_msg(msg: String, app_handle: tauri::AppHandle) { use std::io::Write; log::info!("[js] {msg}"); if let Ok(dir) = app_handle.path().app_log_dir() { if let Some(mut f) = open_monitor_log(&dir) { let _ = writeln!(f, "{}", msg); } } }';
  const lmNorm = maskLits(lmFull).replace(/\s+/g, ' ').trim();
  ok('T3h log_msg 體整形釘（逐字准模板，RB 改名陰影全形滅）', lmNorm === CANON_LM, lmNorm.slice(0, 220));
}
// T3i v1.3（R3#2 處方2）：全庫寫源登記冊＝逐函式誠實白名單（M1 堵：模式集
// 對齊＋函式級落點歸屬，新寫源函式必上冊現形）。白名單＝HEAD 現況盤點：
// 10 員逐一登記（備份/匯出/匯入/下載/還原等合法寫路徑），OpenOptions 類
// 仍限 {open_monitor_log, unique_backup_dest} 二元老釘。
{
  const { byFn, orphans } = scanWriters(src, srcMask);
  const names = [...byFn.keys()].sort();
  const WL = ['backup_db', 'download_url_to_file', 'export_backup_dialog', 'export_csv_dialog', 'export_db_dialog', 'import_piper_model_dialog', 'open_monitor_log', 'restore_backup', 'unique_backup_dest', 'write_db_container'].sort();
  ok('T3i 寫源登記冊＝逐函式白名單×10（R3#2 模式集對齊＋函式級登記，M1 堵）', JSON.stringify(names) === JSON.stringify(WL), names.join(','));
  ok('T3i-b 模組作用域寫原語零落點（函式 span 外＋非 test 模組盲區堵）', orphans.length === 0, JSON.stringify(orphans).slice(0, 200));
  const oo = names.filter((n) => { const p = byFn.get(n); return p.has('OpenOptions') || p.has('File::options'); });
  ok('T3i-c OpenOptions 類登記冊＝{open_monitor_log, unique_backup_dest}（G3B/Drop/P1 老釘）', oo.length === 2 && oo.includes('open_monitor_log') && oo.includes('unique_backup_dest'), oo.join(','));
  const tmpViol = [];
  for (const n of WL) { const bl = maskLits(extract(n)); if (bl.includes('/tmp')) tmpViol.push(n); }
  ok('T3i-d 白名單寫源 fn 逐一體零 /tmp（字面值層，鏡像/備份路徑搬家釘）', tmpViol.length === 0, tmpViol.join(','));
}
// T3j（R3#2-advisory4）：#[tauri::command]↔fn log_msg 原文相鄰性（屬性行
// 區間＝注入面：中間只准空白；插入任何第二屬性＝紅）
{
  const i = srcMask.indexOf('fn log_msg(');
  ok('T3j #[tauri::command] 與 fn log_msg 緊鄰（中間僅空白，A5 屬性注入面封堵）', i > 0 && /#\[[^\]]*tauri::command[^\]]*\]\s*$/.test(srcMask.slice(0, i)), srcMask.slice(Math.max(0, i - 90), i + 12));
}
const ck = sh('cargo check 2>&1', { cwd: join(ROOT, 'src-tauri'), env: cargoEnv });
ok('T3f host cargo check 綠', ck.code === 0, ck.out.slice(-300));

// ---------- T4: 跨平台真牙（R3#2 處方2/3：gate 錨定 custom_flags 區塊＋
// 鏡像綁定使用點——decoy 搶首顆/shadow 常數全斃；掃描跑遮罩文） ----------
console.log('== T4: 跨平台釘 ==');
// 抽取跑在字面值級遮罩（註解假 gate 已消音、字符串不再毒彈括號計數）；
// 候選 cfg block 須括號配平後含 custom_flags，唯一性釘（0 或多顆 → exit 2）。
function findGuardGates(lit) {
  const hits = [];
  const re = /#\[cfg\(([^\n]*?)\)\]\s*\n\s*\{/g;
  let m;
  while ((m = re.exec(lit))) {
    const bodyStart = m.index + m[0].length;
    const end = braceSpan(lit, bodyStart - 1);
    if (end > 0 && lit.slice(bodyStart, end).includes('custom_flags')) hits.push({ pred: m[1], bodyStart, end });
  }
  return hits;
}
const gates = findGuardGates(fnLit);
if (gates.length !== 1) { console.error(`T4 gate 抽取非唯一（${gates.length} 顆）——abort`); process.exit(2); }
const GATE = gates[0].pred;
// R3#2 處方3：鏡像綁定使用點——①fn 內 `const O_NOFOLLOW:` 宣告恰 1 顆
// ②宣告偏移必落在守門 cfg block 區間內 ③`custom_flags(O_NOFOLLOW)` 呼叫恰
// 1 處 ④除該 const 外零其他 O_NOFOLLOW 綁定（let/static 遮蔽斃）。
// decoy（block 外先放正確值）斃於②；shadow（內層再宣告）斃於①④。
{
  const decls = [...fnLit.matchAll(/const\s+O_NOFOLLOW\s*:/g)];
  if (decls.length !== 1) { console.error(`T4 const O_NOFOLLOW 宣告非唯一（${decls.length} 顆＝decoy/shadow 嫌疑）——abort`); process.exit(2); }
  if (decls[0].index < gates[0].bodyStart || decls[0].index > gates[0].end) { console.error('T4 const O_NOFOLLOW 不在守門 block 內——鏡像≠守門引用常數，abort'); process.exit(2); }
  const cf = (fnCode.match(/custom_flags\s*\(\s*O_NOFOLLOW\s*\)/g) || []).length;
  if (cf !== 1) { console.error(`T4 custom_flags(O_NOFOLLOW) 呼叫點 ${cf} 處≠1——abort`); process.exit(2); }
  const binds = (fnCode.match(/\b(?:let|const|static|mut)\s+O_NOFOLLOW\b/g) || []).length;
  if (binds !== 1) { console.error(`T4 O_NOFOLLOW 綁定 ${binds} 處≠1（遮蔽嫌疑）——abort`); process.exit(2); }
}
// O_NOFOLLOW 常數表原文提取（鏡像真碼非手抄；字面值級遮罩防註解 decoy 搶首顆）
const nofM = fnLit.match(/const O_NOFOLLOW: i32 = (if[\s\S]*?;\n)/);
if (!nofM) { console.error('T4 常數表抽取 MISS'); process.exit(2); }
const acrate = join(dir, 'android-crate');
sh(`mkdir -p ${acrate}/src`);
writeFileSync(join(acrate, 'Cargo.toml'), '[package]\nname="a"\nversion="0.0.0"\nedition="2021"\n[lib]\npath="src/lib.rs"\n');
// EXPECTED：libc-0.2.189＋bionic 頭雙源釘（R2#3 獨立復證值）
const EXPECTED = {
  'aarch64-linux-android': 0x8000, 'armv7-linux-androideabi': 0x8000,
  'x86_64-linux-android': 0x20000, 'i686-linux-android': 0x20000,
  'x86_64-unknown-linux-gnu': 0x20000, 'aarch64-unknown-linux-gnu': 0x8000,
};
for (const [tgt, expV] of Object.entries(EXPECTED)) {
  writeFileSync(join(acrate, 'src/lib.rs'), `${fn}

const O_NOFOLLOW_AT: i32 = ${nofM[1].replace(/;\n$/, '')};
// 牙1：鏡像 block gate 原文——gate 若縮回 linux-only，android target 必爆
#[cfg(target_os = "android")]
const _: () = { assert!(cfg!(${GATE}), "GUARD-DEAD-ON-ANDROID"); };
#[cfg(target_os = "linux")]
const _: () = { assert!(cfg!(${GATE}), "GUARD-DEAD-ON-LINUX"); };
// 牙2：本 target 選值釘（鏡像真碼常數表，值互換必爆）
const _: () = { assert!(O_NOFOLLOW_AT == ${expV}, "O_NOFOLLOW 選值錯配"); };
`);
  const r = sh(`cargo check -q --target ${tgt} 2>&1`, { cwd: acrate, env: cargoEnv });
  ok(`T4 ${tgt}：gate 雙 os 探針＋選值釘 ${expV.toString(16)} 全綠`, r.code === 0, r.out.slice(-300));
}

// ---------- T-CLI（F14-SR1）：兩鏡像 cmdDoublefire 預設路徑 ----------
function cliDoublefireBody(src) {
  const cnt = (src.match(/function cmdDoublefire\(\)/g) || []).length;
  if (cnt !== 1) { console.error(`T-CLI: cmdDoublefire 定義 ${cnt} 顆（decoy 嫌疑）——abort`); process.exit(2); }
  const i = src.indexOf('function cmdDoublefire()');
  if (i < 0) return null;
  let d = 0, st = i, j = i;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') { d++; } else if (c === '}') { d--; if (d === 0) { st = j + 1; break; } } }
  return src.slice(i, st);
}
const APP_LOG_MARKER = '.local/share/com.teno.app/logs/teno-monitor.log';
console.log('== T-CLI (F14-SR1) CLI 鏡像 cmdDoublefire 預設路徑 ==');
for (const p of ['tools/cli.mjs', '_dev/cli/cli.mjs']) {
  const src = readFileSync(join(ROOT, p), 'utf8');
  const body = cliDoublefireBody(src);
  ok(`F14CLI-${p} cmdDoublefire 段提取`, body !== null);
  if (body) {
    ok(`F14CLI-${p} args[0]|| 預設指向 app_log_dir(teno-monitor.log)`, body.includes(APP_LOG_MARKER));
    ok(`F14CLI-${p} /tmp/teno-monitor.log 殘留殲滅`, !body.includes('/tmp/teno-monitor.log'));
    ok(`F14CLI-${p} \${HOME}/.local/share 展開在場`, /\$\{HOME\}\/\.local\/share\//.test(body));
  }
}
{
  const NC_DF = "function cmdDoublefire() {\n  const path = args[0] || '/tmp/teno-monitor.log';\n}\n";
  const nb = cliDoublefireBody(NC_DF);
  ok('F14CLI-NC 段提取', nb !== null);
  ok('F14CLI-NC 負控制: bug 版 /tmp 被抓（掃描器有牙）', nb !== null && nb.includes('/tmp/teno-monitor.log'));
  ok('F14CLI-NC 負控制: bug 版無 app_log_dir', nb !== null && !nb.includes(APP_LOG_MARKER));
}

console.log(`\n== F14 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
