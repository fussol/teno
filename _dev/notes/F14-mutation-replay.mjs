#!/usr/bin/env node
// F14 變異重放器（審查除錯資產封存，比照 F10-pending 慣例）
// 用途：對 tools/verify-f14-monitor-log.mjs 重放四個已知逃逸變異
//   M1 fs::write 新寫源 command ／ M2 `"}"` 毒彈＋裸 OpenOptions ／
//   M3 decoy＋shadow 常數 ／ A1 raw-string /tmp 後门
// 期望：四變異全 RED＋正宗基線 GREEN（全紅腳本＝假封鎖，基線綠必查）
// 用法：export PATH=$HOME/.cargo/bin:$PATH && node _dev/notes/F14-mutation-replay.mjs
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = '/home/jupiter/teno';
const WORK = '/tmp/f14-mut-replay';
execSync(`rm -rf ${WORK} && mkdir -p ${WORK}`, { stdio: 'ignore' });
const lib = readFileSync(`${ROOT}/src-tauri/src/lib.rs`, 'utf8');
const script = readFileSync(`${ROOT}/tools/verify-f14-monitor-log.mjs`, 'utf8');
function run(mutated, name) {
  writeFileSync(`${WORK}/lib-${name}.rs`, mutated);
  const s2 = script.replace("const LIB_RS = join(ROOT, 'src-tauri/src/lib.rs');", `const LIB_RS = '${WORK}/lib-${name}.rs';`);
  writeFileSync(`${WORK}/verify-${name}.mjs`, s2);
  try { const out = execSync(`node ${WORK}/verify-${name}.mjs 2>&1`, { encoding: 'utf8', timeout: 550000, env: { ...process.env, PATH: process.env.HOME + '/.cargo/bin:' + process.env.PATH } }); return { red: false, out }; }
  catch (e) { return { red: true, out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}
function report(name, r) {
  const fails = [...new Set(r.out.match(/FAIL  \S+/g) || [])];
  const abort = r.out.match(/(abort|自簽失敗)[^\n]*/g) || [];
  console.log(`${name}: ${r.red ? 'RED ✓封鎖' : 'GREEN ✗逃逸'}`);
  if (r.red) console.log('   ' + [...fails, ...abort].slice(0, 4).join('\n   '));
  else console.log(r.out.slice(-300));
}
const LM_ANCHOR = 'fn log_msg(msg: String, app_handle: tauri::AppHandle) {';
const OM_ANCHOR = '    let mut opts = std::fs::OpenOptions::new();\n    opts.create(true).append(true);';
const muts = [
  ['M1', (l) => l.replace(LM_ANCHOR, `fn diag_writer(app_handle: tauri::AppHandle) {\n    let _ = std::fs::write("/tmp/teno-monitor.log", b"diag");\n}\n${LM_ANCHOR}`)],
  ['M2', (l) => l.replace(LM_ANCHOR, `fn sneaky_diag() {\n    let _guard = "}";\n    let _o = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/teno-monitor.log");\n}\n${LM_ANCHOR}`)],
  ['M3', (l) => {
    let m = l.replace(OM_ANCHOR, `    const O_NOFOLLOW: i32 = if cfg!(any(target_arch = "aarch64", target_arch = "arm")) { 0x8000 } else { 0x20000 };\n${OM_ANCHOR}`);
    return m.replace('        const O_NOFOLLOW: i32 = if cfg!(any(target_arch = "aarch64", target_arch = "arm")) {', '        const O_NOFOLLOW: i32 = if cfg!(any(target_arch = "NEVER_MATCH_XX", target_arch = "arm_yy")) {');
  }],
  ['A1', (l) => l.replace(OM_ANCHOR, `    {\n        use std::io::Write;\n        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(r#"/tmp/f14-a1-leak.log"#) { let _ = writeln!(f, "LEAK"); }\n    }\n${OM_ANCHOR}`)],
];
let bad = 0;
for (const [name, f] of muts) {
  const m = f(lib);
  if (m === lib) { console.log(`${name}: inject MISS（錨點漂移——更新本重放器）`); bad++; continue; }
  const r = run(m, name);
  if (!r.red) bad++;
  report(name, r);
}
const base = run(lib, 'baseline');
if (base.red) { bad++; report('基線正宗碼', base); } else console.log('基線正宗碼: GREEN ✓');
console.log(bad === 0 ? '== 全部符合預期（變異紅、基線綠） ==' : `== ${bad} 項異常 ==`);
process.exit(bad ? 1 : 0);
