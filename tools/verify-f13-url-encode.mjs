#!/usr/bin/env node
// verify-f13-url-encode.mjs — D17-style 真碼提取＋負控制 for F13
// (cambridge build_*_url 零編碼 → 片語/保留字元查詢失敗)
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '/home/jupiter/teno';
const URL_RS = join(ROOT, 'src-tauri/cambridge_scraper/src/url.rs');
const OLD_HASH = '258458d'; // 靜態 pin（F9 教訓：禁浮動 HEAD）
const sh = (c, opt = {}) => {
  try {
    return { out: execSync(c, { encoding: 'utf8', cwd: ROOT, ...opt }), code: 0 };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? -1 };
  }
};
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' :: ' + extra.slice(0, 300) : ''}`); }
};

const src = readFileSync(URL_RS, 'utf8');

// ---------- T0: cargo 計數釘 ----------
console.log('== T0: cargo test url:: 計數釘 ==');
const t0 = sh('cargo test -p cambridge_scraper url:: 2>&1', { cwd: join(ROOT, 'src-tauri'), env: { ...process.env, PATH: process.env.HOME + '/.cargo/bin:' + process.env.PATH } });
const m0 = t0.out.match(/(\d+) passed;.*?(\d+) failed/);
ok('T0a url:: 測試 6 passed / 0 failed', m0 && m0[1] === '6' && m0[2] === '0', t0.out);

// ---------- T1: 真碼提取向量機（純 std，rustc 直編） ----------
console.log('== T1: 真碼提取向量機 ==');
const extract = (name) => {
  const i = src.indexOf(`fn ${name}(`);
  if (i < 0) throw new Error(`extract miss: ${name}`);
  let d = 0, j = src.indexOf('{', i);
  const start = src.slice(i, j + 1).length + i; let k = j;
  for (; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(i, k + 1);
};
const harness = ['push_pct', 'encode_slug', 'build_english_url', 'build_chinese_url'].map(n => extract(n)).join('\n\n');
const dir = mkdtempSync(join(tmpdir(), 'f13-'));
writeFileSync(join(dir, 'h.rs'), `${harness}
fn main() {
    let words = ["get rid of", "  A  B ", " -x- ", "c#", "100%", "a?b", "x/y", "a&b=c", "中文", "hello", "get-rid-of", ""];
    for w in words { println!("V:{} => {}", w, encode_slug(w)); }
    println!("E:{}", build_english_url("get rid of"));
    println!("C:{}", build_chinese_url("中文"));
}
`);
const rb = sh(`rustc -o ${join(dir, 'h')} ${join(dir, 'h.rs')} 2>&1`);
ok('T1-r harness 編譯綠（真碼可獨立組譯）', rb.code === 0, rb.out);
const vo = sh(`${join(dir, 'h')}`).out;
const V = (w) => (vo.match(new RegExp(`^V:${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} => (.*)$`, 'm')) || [])[1];
ok('T1-1 片語→hyphen slug（get rid of→get-rid-of）', V('get rid of') === 'get-rid-of', V('get rid of'));
ok('T1-2 多空白摺疊＋trim（"  A  B "→A-B）', V('  A  B ') === 'A-B', V('  A  B '));
ok('T1-3 首尾連字號剔除（" -x- "→x）', V(' -x- ') === 'x', V(' -x- '));
ok('T1-4 #→%23（c# 不再 fragment 截斷）', V('c#') === 'c%23', V('c#'));
ok('T1-5 %→%25（100% 不再非法百分序列）', V('100%') === '100%25', V('100%'));
ok('T1-6 ?→%3F', V('a?b') === 'a%3Fb', V('a?b'));
ok('T1-7 /→%2F（路徑穿越面封死）', V('x/y') === 'x%2Fy', V('x/y'));
ok('T1-8 & = 編碼', V('a&b=c') === 'a%26b%3Dc', V('a&b=c'));
ok('T1-9 CJK→UTF-8 pct', V('中文') === '%E4%B8%AD%E6%96%87', V('中文'));
ok('T1-10 單字回歸零變化（hello）', V('hello') === 'hello', V('hello'));
ok('T1-11 已 hyphen 輸入原樣（get-rid-of）', V('get-rid-of') === 'get-rid-of', V('get-rid-of'));
ok('T1-12 空字串→空段不炸', V('') === '', JSON.stringify(V('')));
ok('T1-13 english 全形 URL', (vo.match(/^E:(.*)$/m) || [])[1] === 'https://dictionary.cambridge.org/dictionary/english/get-rid-of', vo);
ok('T1-14 chinese 全形 URL', (vo.match(/^C:(.*)$/m) || [])[1] === 'https://dictionary.cambridge.org/dictionary/english-chinese-traditional/%E4%B8%AD%E6%96%87', vo);

// ---------- T2: 線上前題釘（hyphen vs %20，網路容錯 SKIP） ----------
console.log('== T2: 線上前題釘 ==');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const probe = (slug) => sh(`curl -s -o /dev/null -w "%{http_code} %{url_effective}" -L -A "${UA}" --max-time 20 "https://dictionary.cambridge.org/dictionary/english/${slug}"`).out.trim();
const p1 = probe('get-rid-of');
const p2 = probe('get%20rid%20of');
if (p1.startsWith('000') || p1 === '' ) { console.log('  SKIP  T2 網路不可達（不假綠）: ' + p1); }
else {
  ok('T2-1 hyphen slug 命中條目頁（final URL 無 ?q=）', /200/.test(p1) && !p1.includes('?q='), p1);
  ok('T2-2 %20 slug 墜 ?q= fallback（徵狀前提實錘）', /\?q=/.test(p2), p2);
  // T2-3 端到端釘（R1#F-7②）：hyphen 頁必須是真條目頁（非 fallback）。
  // F13 職責範圍＝URL 層直達；模板漂移（新模板零 .entry-body→scraper
  // WordNotFound）屬 F13-SR2 另案（scraper 域），warn 明示禁假安心。
  const body = sh(`curl -s -L -A "${UA}" --compressed --max-time 25 "https://dictionary.cambridge.org/dictionary/english/get-rid-of"`).out;
  const entryPage = body.includes('entry-body') || body.includes('def-block') || body.includes('superhero-entry') || /class="[^"]*definition/.test(body);
  ok('T2-3 端到端：hyphen 頁為真條目頁非 ?q= fallback（URL 層閉環）', entryPage && !body.includes('Sorry. No matches'), body.slice(0, 200));
  if (!body.includes('entry-body') && entryPage) console.log('  WARN  T2 模板漂移偵測：條目頁零 .entry-body（新 tw-/superentry 模板）→ scraper 層 WordNotFound 屬 F13-SR2 另案，非 URL 層缺陷');
}

// ---------- T3: 負控制（pin 靜態 hash，舊碼徵狀重現） ----------
console.log('== T3: 負控制 ==');
const old = sh(`git show ${OLD_HASH}:src-tauri/cambridge_scraper/src/url.rs`).out;
ok('T3a 基準 pin 為靜態 hash（禁浮動 HEAD，F9 教訓）', /^[0-9a-f]{7}$/.test(OLD_HASH));
ok('T3b 舊碼 raw 直插源碼真性（{word} 插值在位＋零 encode）', old.includes('{word}') && !old.includes('encode_slug'));
// english→cfg 區段天然含兩支舊函式（旧檔順序：english、chinese、cfg），整段取一次即可
const oldHarness = `${old.slice(old.indexOf('pub fn build_english_url'), old.indexOf('#[cfg(test)]')).trim()}
fn main() { println!("OE:{}", build_english_url("get rid")); println!("OC:{}", build_english_url("c#")); }
`;
writeFileSync(join(dir, 'o.rs'), oldHarness);
const ob = sh(`rustc -o ${join(dir, 'o')} ${join(dir, 'o.rs')} 2>&1`);
ok('T3-r 舊碼 harness 編譯綠', ob.code === 0, ob.out);
const oo = sh(`${join(dir, 'o')}`).out;
ok('T3c 徵狀1 重現：舊碼輸出含 raw space（curl 000／ureq→%20→fallback）', /^OE:.*\/get rid$/m.test(oo), oo);
ok('T3d 徵狀2 重現：舊碼 # 原樣進 path（fragment 截斷面）', /OC:.*c#/.test(oo), oo);
ok('T3e 判別性釘：新舊提取體不同（非兩邊空轉）', harness !== oldHarness && src.includes('encode_slug') && !src.includes('{word}'));

// ---------- T4: 結構釘 ----------
console.log('== T4: 結構釘 ==');
ok('T4a 兩支 build 函式均經 encode_slug', (src.match(/encode_slug\(word\)/g) || []).length === 2);
ok('T4b raw {word} 直插殲滅', !src.includes('{word}'));
ok('T4c 折疊源在位（split_ascii_whitespace＋trim_matches）', src.includes('split_ascii_whitespace') && src.includes("trim_matches('-')"));
const dirty = sh('git status --porcelain src-tauri/cambridge_scraper/').out;
// T4d（F13-SR2 演化 2026-08-30）：原釘「髒檔僅 url.rs」為 SR1 時代白名單；SR2 計畫書
// 明定 english.rs 為合法動工檔（新模板 fallback 路由），故釘改為「url.rs 或 english.rs」，
// 其餘 crate 檔案仍禁髒（fmt 越界防護維持）。
ok('T4d crate 髒檔僅 url.rs/english.rs（SR2 白名單，fmt 越界零殘留）', dirty.trim().split('\n').every(l => l.includes('url.rs') || l.includes('english.rs')), dirty);
const ct = sh('git status --porcelain src-tauri/cambridge_scraper/Cargo.toml src-tauri/Cargo.toml').out.trim();
ok('T4e 零 Cargo.toml 改動（白名單鐵律）', ct === '', ct);
const ck = sh('cargo check -p cambridge_scraper 2>&1', { cwd: join(ROOT, 'src-tauri'), env: { ...process.env, PATH: process.env.HOME + '/.cargo/bin:' + process.env.PATH } });
ok('T4f cargo check -p cambridge_scraper 綠', ck.code === 0, ck.out.slice(-400));

console.log(`\n== F13 結果: ${pass} PASS / ${fail} FAIL ==`);
process.exit(fail ? 1 : 0);
