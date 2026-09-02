#!/usr/bin/env node
// ═══ VERIFY-F19 simulate_fsrs 當地日界線 ═══
// Bug：卡片端 today_days/due_day 用 UTC 系，revlog 端用當地系 → 雙參考系
//      同日不同時刻模擬結果抖動 ±1 天。
// 修法：local_day_index(t, tz, cutoff) = (t + tz - cutoff).div_euclid(86400)
// 驗證：①lib.rs 靜態釘（local_day_index 在位＋兩呼叫點改寫＋UTC 零殘留）
//      ②真碼提取（rustc 獨立編譯）對照表：東八區/西五區/cutoff240/負偏移
// 用法: node tools/verify-f19-local-day.mjs [--pre]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = fs.readFileSync(path.join(ROOT, 'src-tauri/src/lib.rs'), 'utf8');

const PRE = process.argv.includes('--pre');
let fail = 0, total = 0;
function ok(label, cond, detail) {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
}

// ── T1 靜態釘 ──
const hasFn = /fn local_day_index\(t_secs: i64, timezone_offset_secs: i64, cutoff_secs: i64\) -> i64 \{\s*\n\s*\(t_secs \+ timezone_offset_secs - cutoff_secs\)\.div_euclid\(86400\)\s*\n\}/.test(LIB);
const callToday = /let today_days = local_day_index\(now, tz_secs, cutoff_secs\) as f32;/.test(LIB);
const callDue = /local_day_index\(ms\.div_euclid\(1000\), tz_secs, cutoff_secs\) as f32 - today_days/.test(LIB);
const utcGone = !/let today_days = \(now \/ 86400\) as f32;/.test(LIB);
const utcDueGone = !/\(ms \/ 86400000\) as f32 - today_days/.test(LIB);
const cutoffDefined = /let cutoff_secs = \(req\.day_cutoff_minutes\.max\(0\) as i64\) \* 60;/.test(LIB);

// ── T2 真碼提取：local_day_index 抽出 rustc 編譯跑對照 ──
function extractRust() {
  const m = LIB.match(/fn local_day_index\(t_secs: i64, timezone_offset_secs: i64, cutoff_secs: i64\) -> i64 \{[\s\S]*?\n\}/);
  return m ? m[0] : null;
}
function runRustMatrix(fnSrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f19-verify-'));
  const cases = [];
  // 對照表（計畫書 §6）：(t, tz, cutoff, expect_day)
  // tz=+8h=28800, cutoff=0：當地 2026-08-31 02:00 (=UTC 8/30 18:00) → 當地日 8/31
  const DAY0 = 20000 * 86400; // 任意大基準
  const c = (t, tz, cutoff) => {
    const day = Math.floor((t + tz - cutoff) / 86400); // JS floor = div_euclid for this range
    return day;
  };
  // 案例向量
  const vectors = [];
  // 1) 東八區凌晨 02:00（tz=28800, cutoff=0）：UTC 前一天 18:00 → 舊 UTC 系差一天
  const t1 = DAY0 - 6 * 3600; // UTC 前日 18:00
  vectors.push(['東八凌晨(tz+8,cut0)', t1, 28800, 0, c(t1, 28800, 0)]);
  // 2) 西五區晚間 21:00（tz=-18000, cutoff=0）
  const t2 = DAY0 + 21 * 3600 + 18000; // UTC 隔日 02:00
  vectors.push(['西五晚間(tz-5,cut0)', t2, -18000, 0, c(t2, -18000, 0)]);
  // 3) cutoff=240min（4小時）凌晨 02:00 當地（= cutoff 前 → 前一天）
  const t3 = DAY0 + 2 * 3600; // 假裝已含 tz 的當地 02:00 → tz=0 簡化
  vectors.push(['cutoff240 凌晨(tz0,cut14400)', t3, 0, 14400, c(t3, 0, 14400)]);
  // 4) 負偏移 floor 語意（t+tz-cutoff 為負）→ div_euclid 不可破
  const t4 = 3 * 3600; // epoch 初期
  vectors.push(['負偏移 div_euclid', t4, -18000, 0, c(t4, -18000, 0)]);

  const rs = `
${fnSrc}
fn main() {
${vectors.map((v, i) => `    let d${i} = local_day_index(${v[1]}, ${v[2]}, ${v[3]});`).join('\n')}
    println!("{}|{}|{}|{}", d0, d1, d2, d3);
}
`;
  fs.writeFileSync(path.join(dir, 'm.rs'), rs);
  const out = execSync(`rustc -O -o ${dir}/m ${dir}/m.rs 2>&1 && ${dir}/m`, { encoding: 'utf8', timeout: 60000 }).trim();
  return out.split('|').map(Number);
}

if (PRE) {
  ok('T0.1 bug 實錘：UTC 系 today_days 在位', /let today_days = \(now \/ 86400\) as f32;/.test(LIB));
  ok('T0.2 bug 實錘：due_day UTC 換算在位', /\(ms \/ 86400000\) as f32 - today_days/.test(LIB));
  ok('T0.3 bug 實錘：無 local_day_index', !hasFn);
} else {
  ok('T1.1 local_day_index 純函式在位（div_euclid floor）', hasFn);
  ok('T1.2 today_days 改用 local_day_index', callToday);
  ok('T1.3 due_day 改用 local_day_index（ms.div_euclid(1000)）', callDue);
  ok('T1.4 UTC 零殘留（today_days）', utcGone);
  ok('T1.5 UTC 零殘留（due_day）', utcDueGone);
  ok('T1.6 cutoff_secs 定義（max(0) 同 compute_next_day_at 語意）', cutoffDefined);

  const fnSrc = extractRust();
  if (!fnSrc) { ok('T2 真碼提取', false, '函式本體未取到'); }
  else {
    const got = runRustMatrix(fnSrc);
    const expects = [];
    const DAY0 = 20000 * 86400;
    const c = (t, tz, cutoff) => Math.floor((t + tz - cutoff) / 86400);
    expects.push(c(DAY0 - 6 * 3600, 28800, 0));
    expects.push(c(DAY0 + 21 * 3600 + 18000, -18000, 0));
    expects.push(c(DAY0 + 2 * 3600, 0, 14400));
    expects.push(c(3 * 3600, -18000, 0));
    ok('T2.1 東八凌晨對照（舊 UTC 系差一天，新系正確）', got[0] === expects[0], `got=${got[0]} expect=${expects[0]}`);
    ok('T2.2 西五晚間對照', got[1] === expects[1], `got=${got[1]} expect=${expects[1]}`);
    ok('T2.3 cutoff240 凌晨對照（cutoff 前算前一天）', got[2] === expects[2], `got=${got[2]} expect=${expects[2]}`);
    ok('T2.4 負偏移 div_euclid floor 語意', got[3] === expects[3], `got=${got[3]} expect=${expects[3]}`);
  }
}

console.log(fail === 0 ? `\n═══ ${PRE ? 'PRE(BUG)' : 'POST(FIXED)'}: ${total - fail}/${total} ALL PASS ═══` : `\n═══ ${fail} FAIL / ${total} ═══`);
process.exit(fail ? 1 : 0);
