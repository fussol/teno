#!/usr/bin/env node
// verify-f9-piper-url.mjs — F9 install_piper_model URL 解析驗證
// legs:
//  T0 cargo test --lib piper_url_tests（真碼 unit tests）
//  T1 從 src-tauri/src/lib.rs 抽 parse_piper_url → rustc 獨立編譯 → 12 向量
//  T2 實網腿：新碼生成 URL range GET 全 200
//  T3 負控制：HEAD 舊解析段（byte-identity 釘）機械抽出同向量 → bug 精準重現
//  T4 結構釘：呼叫點委派＋瞎拼殘留零＋curl 本體未動（F12 域界線）
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const LIB = join(ROOT, 'src-tauri/src/lib.rs');
const src = readFileSync(LIB, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};
const sh = (cmd, opts = {}) => {
  try { return { out: execSync(cmd, { encoding: 'utf8', ...opts }), code: 0 }; }
  catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? 1 }; }
};

// ───── 向量表（新碼預期）─────
const RYAN = ['en/en_US/ryan/high', 'en_US-ryan-high'];
const ZH = ['zh/zh_CN/huayan/medium', 'zh_CN-huayan-medium'];
const V = {
  A: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high',
  B: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high/',
  C: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ryan',
  C2: 'https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US',
  D: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx',
  E: 'https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/ryan/high/en_US-ryan-high.onnx',
  F: 'hf.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high',
  G: 'https://hf.co/rhasspy/piper-voices/tree/main/en/en_US/ryan/high',
  H: 'https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium',
  I: 'https://huggingface.co/rhasspy/piper-voices/tree/main',
  K: 'https://huggingface.co//rhasspy//piper-voices/tree//main/en//en_US/ryan/high',
  L: '',
};
// 新碼期望: key -> [rel, name] 或 'ERR'
const NEW_EXP = { A: RYAN, B: RYAN, K: RYAN, F: RYAN, G: RYAN, D: RYAN, E: RYAN, H: ZH, C: 'ERR', C2: 'ERR', I: 'ERR', L: 'ERR' };
// 舊碼期望（負控制精準重現目標）
const DL_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const dl = (rel, name) => `${DL_BASE}${rel}/${name}.onnx`;

// ───── 提取工具 ─────
function extractFn(source, sig) {
  const start = source.indexOf(sig);
  if (start < 0) return null;
  let i = source.indexOf('{', start), depth = 0, end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return end < 0 ? null : source.slice(start, end);
}
const q = (s) => JSON.stringify(s);
const harness = (fnDefs, body) => `
#![allow(dead_code, unused)]
${fnDefs}
fn main() { ${body} }
`;
const RUNNER = `
let mut bad = 0usize;
for v in VECTORS.iter() {
  let (tag, url, exp) = *v;
  let got = parse(url);
  let gtxt = match &got { Ok((r,n)) => format!("OK {}|{}", r, n), Err(_) => "ERR".to_string() };
  let etxt = match exp { Some((r,n)) => format!("OK {}|{}", r, n), None => "ERR".to_string() };
  if gtxt != etxt { bad += 1; println!("VECTOR-FAIL {} {} exp={} got={}", tag, url, etxt, gtxt); }
}
println!("VECTORBAD {}", bad);
`;
function compileRun(dir, tag, rustSrc) {
  const rs = join(dir, `${tag}.rs`); const bin = join(dir, tag);
  writeFileSync(rs, rustSrc);
  const c = sh(`rustc --edition 2021 -o ${q(bin)} ${q(rs)} 2>&1`);
  if (c.code !== 0) return { err: 'COMPILE: ' + c.out.slice(0, 500) };
  const r = sh(bin);
  if (r.code !== 0) return { err: 'RUN: ' + r.out.slice(0, 500) };
  return { out: r.out };
}
function vectorsRust(map) {
  const rows = Object.entries(map).map(([k, exp]) => {
    const e = exp === 'ERR' ? 'None' : `Some((${q(exp[0])}, ${q(exp[1])}))`;
    return `    ("${k}", ${q(V[k])}, ${e}),`;
  }).join('\n');
  return `const VECTORS: [(&str, &str, Option<(&str, &str)>); ${Object.keys(map).length}] = [\n${rows}\n];\n${RUNNER}`;
}

const dir = mkdtempSync(join(tmpdir(), 'verify-f9-'));
try {
  // ═══ T0 cargo unit tests（真碼）═══
  console.log('── T0 cargo test --lib piper_url_tests ──');
  const ct = sh(`cargo test --lib piper_url_tests 2>&1`, { cwd: join(ROOT, 'src-tauri'), timeout: 900000 });
  ok(ct.code === 0 && /test result: ok\. (1[3-9]|[2-9][0-9]) passed; 0 failed/.test(ct.out), 'T0 cargo piper_url_tests ≥13 全綠（計數釘禁釘死值防子孫腐化，F12 R1#2/#3 教訓）', ct.out.split('\n').filter(l => /test result|error/.test(l)).slice(0, 3).join(' | '));

  // ═══ T1 源碼提取 parse_piper_url → 12 向量 ═══
  console.log('── T1 真碼提取向量 ──');
  const fnNew = extractFn(src, 'fn parse_piper_url');
  ok(fnNew !== null, 'T1a parse_piper_url 存在可提取');
  if (!fnNew) throw new Error('aborted: parse_piper_url not found');
  const t1 = compileRun(dir, 'f9new', harness(fnNew + '\nfn parse(u: &str) -> Result<(String, String), String> { parse_piper_url(u) }\n', vectorsRust(NEW_EXP)));
  ok(!t1.err && /VECTORBAD 0/.test(t1.out), 'T1b 新碼 12 向量全中', (t1.err || t1.out).slice(0, 600));

  // ═══ T2 實網腿：新碼生成 URL 全 200 ═══
  console.log('── T2 實網 range GET ──');
  for (const k of ['A', 'D', 'E', 'F', 'G', 'H']) {
    const url = dl(NEW_EXP[k][0], NEW_EXP[k][1]);
    const r = sh(`curl -sL --max-time 20 -r 0-0 -o /dev/null -w "%{http_code}" ${q(url)}`);
    ok(['200', '206'].includes(r.out.trim()), `T2 ${k} 下載 URL 200/206`, `${url} -> ${r.out.trim()}`);
  }
  // 同一性：B/K/F/G 與 A 同解已由 T1 釘（生成 URL 相同 ⇒ 實網等價）

  // ═══ T3 負控制：HEAD 舊解析段反換 ═══
  console.log('── T3 負控制（HEAD 舊碼精准重現）──');
  const ORIG_BLOCK = `    let path = url
        .trim_start_matches("https://huggingface.co/")
        .trim_start_matches("http://huggingface.co/")
        .trim_start_matches("hf.co/");
    let segments: Vec<&str> = path.split('/').collect();
    // path = {owner}/{repo}/{ref_type}/{ref}/{dirs...}/{file?}
    // The repo-relative path starts at index 4
    if segments.len() < 5 { return Err("網址格式不正確，預期 huggingface.co/rhasspy/piper-voices/...".to_string()); }
    let last = segments.last().unwrap_or(&"");
    let rel_path = if last.ends_with(".onnx") {
        segments[4..segments.len()-1].join("/")
    } else {
        segments[4..].join("/")
    };`;
  const ORIG_TAIL = `    if last.ends_with(".onnx") {
        let model_name = last.strip_suffix(".onnx").unwrap_or(last);
        download(model_name)
    } else {
        // Directory URL: construct model name from locale-voice-quality
        let dir_parts: Vec<&str> = rel_path.split('/').collect();
        let qual = dir_parts.get(3).copied().unwrap_or("high");
        let voice = dir_parts.get(2).copied().unwrap_or("default");
        let locale = dir_parts.get(1).copied().unwrap_or("en_US");
        let model_name = format!("{}-{}-{}", locale, voice, qual);
        download(&model_name)
    }?;`;
  // 負控制基準釘死 6cd51c9^（F9 commit 父＝最後含舊解析段之 commit）。
  // 教訓：`git show HEAD:` 作負控制在自身 fix 落地後即腐（2026-08-28 F9 自食實錘），
  // 負控制基準必須 pin 固定 hash，永不可引用浮動 ref。
  const head = sh(`git -C ${q(ROOT)} show 6cd51c9^:src-tauri/src/lib.rs`).out;
  ok(head.includes(ORIG_BLOCK) && head.includes(ORIG_TAIL), 'T3a 負控制區塊與 6cd51c9^ 逐字節相同');
  const legacyFn = `fn parse(url: &str) -> Result<(String, String), String> {
${ORIG_BLOCK}
    let old_download = |model_name: &str| -> Result<String, String> { Ok(model_name.to_string()) };
    let download = old_download;
${ORIG_TAIL.replace('download(model_name)', 'let _ = download(model_name);\n        Ok((rel_path.clone(), model_name.to_string()))').replace('download(&model_name)', 'let _ = download(&model_name);\n        Ok((rel_path.clone(), model_name.clone()))').replace('    }?;', '    }')}
}`;
  // 舊碼「正確面」向量（證明負控制非全紅：正規 4 層/檔案 URL 舊碼本已可用——審計永遠404之勘誤）
  const LEG_EXP = {
    A: RYAN, D: RYAN, E: RYAN, F: RYAN, H: ZH,           // 舊碼本來就对（勘誤面）
    B: ['en/en_US/ryan/high/', 'en_US-ryan-high'],        // RC1 尾斜杠髒 rel（必404源）
    C: ['en/en_US/ryan', 'en_US-ryan-high'],              // RC2 瞎拼：缺品質段照拼 high
    C2: ['en/en_US', 'en_US-default-high'],               // RC2 瞎拼：default 垃圾名
    G: ['piper-voices/tree/main/en/en_US/ryan/high', 'tree-main-en'], // RC3 https: 垃圾段位移：名稱整体錯拼成 tree-main-en
  };
  const t3 = compileRun(dir, 'f9old', harness(legacyFn, vectorsRust(LEG_EXP)));
  ok(!t3.err && /VECTORBAD 0/.test(t3.out), 'T3b 舊碼行為向量全重現（B髒rel/C瞎拼high/C2瞎拼default/G位移）', (t3.err || t3.out).slice(0, 600));
  // B 舊 URL 實網 404（徵狀目視腿）
  const r404 = sh(`curl -sL --max-time 20 -r 0-0 -o /dev/null -w "%{http_code}" ${q(dl(LEG_EXP.B[0], LEG_EXP.B[1]))}`);
  ok(r404.out.trim() === '404', 'T3c 舊碼尾斜杠生成 URL 實網 404（bug 徵狀目視）', r404.out.trim());
  const r404c = sh(`curl -sL --max-time 20 -r 0-0 -o /dev/null -w "%{http_code}" ${q(dl(LEG_EXP.C[0], LEG_EXP.C[1]))}`);
  ok(r404c.out.trim() === '404', 'T3d 舊碼 voice 層瞎拼 URL 實網 404', r404c.out.trim());

  // ═══ T4 結構釘 ═══
  console.log('── T4 結構釘 ──');
  const iStart = src.indexOf('fn install_piper_model');
  const iEnd = src.indexOf('// ─── 匯出容器格式', iStart);
  ok(iStart > 0 && iEnd > iStart, 'T4a install_piper_model 區段定位');
  const region = src.slice(iStart, iEnd);
  ok(region.includes('parse_piper_url(&url)?'), 'T4b 呼叫點委派 parse_piper_url');
  ok(!region.includes('unwrap_or("high")') && !region.includes('unwrap_or("default")') && !region.includes('unwrap_or("en_US")'),
    'T4c 瞎拼字面量區段內零殘留');
  // T4d 演化釘：本釘原為「F12 未動工」哨兵（curl 在位＋-sL×2）。F12 已合法殲滅
  // curl（F12-fix-plan v1.1，R1 三委員），哨兵完成使命升級為反向斷言：
  // curl 零殘留＋委派 download_url_to_file×2（onnx/json）。
  ok(!region.includes('Command::new("curl")') && (region.match(/download_url_to_file\(/g) || []).length === 2,
    'T4d curl 殲滅＋委派 download_url_to_file ×2（F12 落地後演化釘）');
  // source 內原 parse 內聯碼消失（全檔面，防雙實作）
  ok(!src.includes('The repo-relative path starts at index 4'), 'T4e 舊內聯解析本體全檔零殘留');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
