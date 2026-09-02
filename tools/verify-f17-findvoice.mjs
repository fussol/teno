#!/usr/bin/env node
// verify-f17-findvoice.mjs v4 — F17 結構驗證：findVoice 不得在呼叫執行緒讀 tts.voices（ANR）
// 用法: node tools/verify-f17-findvoice.mjs [path/to/TtsPlugin.kt]
// v4（R3#2 三補釘）：done×3/error×3 全釘 reason、stopRequested 重置釘行首直指派＋禁遮蔽、.start() 銜接窗 200。
//
// v3（R2 結構重做，憲法⑩）：
//  - 統一單趟狀態機剝離器：行註解/區塊註解/raw string（\"\"\"）→ 等長空白化；普通字串與字元字面值
//    保留（T7 呼叫形態錨點需要字串內容），但字串內容不參與註解判定（消 A5c/C1/T8-grep 共同根因）。
//  - voices 掃描升 token 級：\bvoices\b 詞邊界 ∪ getVoices 任意引用（含 ::getVoices 方法參照）。
//  - 白名單 lambda 必須是 (?<![\w$])Thread\s*{ 且閉合括號「緊接」.start()（鏈式綁定，消 B6/A2b）。
//  - T3 釋放錨收紧：finally 體只准 set(false)；catch 首句必須是 set(false)（消 A4）。
//  - T8 負控制：精準 matchStart..end 拼接＋三函式仍在斷言（同 v2）。
//
// ⚠ 威脅模型（定文，憲法⑦）：本閘防禦目標＝無意回歸與偷工假修法（漏 start、放錯執行緒、
//   忘單飛、改壞事件契約、留死碼雙軌）。不抵禦「蓄意對抗性偽裝」——把引擎讀取經方法參照、
//   委派自建工具函式、或任何刻意混淆搬移的代碼，文字掃描在圖靈完備語言上不可能全抓。
//   此邊界為審查裁決一部分，非腳本缺陷。合法安全寫法刻意採窄白名單：僅認 `Thread { }.start()`
//   模式（同 listVoices 既有先例）；Runnable/kotlinx thread/Executors 會紅——是防線不是誤殺。
import { readFileSync } from 'node:fs';

const PATH = process.argv[2] ?? 'src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt';
const src = readFileSync(PATH, 'utf8');

// ---------- 單趟狀態機剝離器（等長：輸出與輸入逐字元同長，索引恒等） ----------
function stripAll(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {                 // 行註解 → 空白
      while (i < n && s[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {                 // 區塊註解 → 空白（保留換行；Kotlin 可嵌套，極少見不處理）
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === '"' && s.startsWith('"""', i)) {           // raw string → 空白（保留換行）
      out += '   '; i += 3;
      while (i < n && !s.startsWith('"""', i)) { out += s[i] === '\n' ? '\n' : ' '; i++; }
      out += '   '; i += 3;
      continue;
    }
    if (c === '"' || c === '\'') {                       // 普通字串/字元字面值 → 原樣保留（跳脫正確前進）
      out += c; i++;
      while (i < n) {
        const q = s[i];
        if (q === '\\') { out += q + (s[i + 1] ?? ''); i += 2; continue; }
        out += q; i++;
        if (q === c || q === '\n') break;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function bodyRange(source, sigRe) {
  const m = sigRe.exec(source);
  if (!m) return null;
  let i = source.indexOf('{', m.index);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return { start: i, end: j + 1, body: source.slice(i, j + 1), matchStart: m.index }; }
  }
  return null;
}

// 白名單 lambda：主體內 (?<![\w$])Thread\s*{ ... } 且閉合 } 緊接 .start()（鏈式綁定）
function startedThreadLambdas(cleanSrc, fn) {
  if (!fn) return [];
  const ranges = [];
  const re = /(?<![\w$])Thread\s*\{/g;
  let m;
  while ((m = re.exec(fn.body))) {
    const openAbs = fn.start + m.index + m[0].length - 1;
    let depth = 0;
    for (let j = openAbs; j < fn.end; j++) {
      const c = cleanSrc[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          // v4（N1c）：銜接窗放寬至 200 字元——剝離後註解＝純空白，^\s*\. 錨定仍不容許跨任何真實 token
          const after = cleanSrc.slice(j + 1, j + 200);
          if (/^\s*\.\s*start\s*\(\s*\)/.test(after)) ranges.push({ start: openAbs, end: j + 1 });
          break;
        }
      }
    }
  }
  return ranges;
}

// token 級 voices 掃描：詞邊界 voices ∪ 任何 getVoices 引用（.voices / ::getVoices / getVoices()）
const VOICE_TOKEN_RE=/\bvoices\b|\bgetVoices\b/g;

// ---------- detectors（對任意 source 可重用，負控制要用） ----------
function runDetectors(source) {
  const clean = stripAll(source);
  const findVoice = bodyRange(clean, /private fun findVoice\b/);
  const refresh = bodyRange(clean, /private fun startVoiceIndexRefresh\b/);
  const listVoices = bodyRange(clean, /fun listVoices\b/);
  const speakFn = bodyRange(clean, /fun speak\(invoke: Invoke\)/);
  const stopFn = bodyRange(clean, /fun stop\(invoke: Invoke\)/);
  const pauseFn = bodyRange(clean, /private fun pauseTts\(\)/);
  const onDoneFn = bodyRange(clean, /override fun onDone\(/);
  const results = {};

  const hits = [...clean.matchAll(VOICE_TOKEN_RE)].map((m) => m.index);
  const inRange = (idx, r) => idx >= r.start && idx < r.end;
  const refreshLambdas = startedThreadLambdas(clean, refresh);
  const listLambdas = startedThreadLambdas(clean, listVoices);

  // T1：findVoice 主體零 tts 引用、零 voices/getVoices token
  results.T1_findVoice_no_direct_voices =
    !!findVoice &&
    !/\bvoices\b|\bgetVoices\b/.test(findVoice.body) &&
    !/(^|[^A-Za-z0-9_])tts([^A-Za-z0-9_]|$)/.test(findVoice.body);

  // T2：全檔 voices token 只准落在「Thread{...}.start() 鏈式綁定」的 lambda 內；refresh/listVoices 各至少一條
  results.T2_voices_only_in_started_threads =
    !!refresh && !!listVoices &&
    refreshLambdas.length >= 1 && listLambdas.length >= 1 &&
    hits.every((idx) => refreshLambdas.some((r) => inRange(idx, r)) || listLambdas.some((r) => inRange(idx, r)));

  // T3：單飛守衛結構式 — CAS 失敗 return、CAS 後至 try 無 return 逃逸、
  //     finally 體唯 set(false)、catch 首句 set(false)、雙軌計數 ≥2
  const casRe = /if\s*\(\s*!\s*voiceRefreshInFlight\.compareAndSet\(false,\s*true\)\s*\)\s*return/;
  let t3 = /AtomicBoolean\(false\)/.test(clean) && !!refresh && casRe.test(refresh.body);
  if (t3) {
    const cm = casRe.exec(refresh.body);
    const seg = refresh.body.slice(cm.index + cm[0].length);
    const tryIdx = seg.search(/\btry\b/);
    t3 = tryIdx >= 0 && !/\breturn\b/.test(seg.slice(0, tryIdx));
  }
  if (t3) {
    const releases = (refresh.body.match(/voiceRefreshInFlight\.set\(false\)/g) || []).length;
    const finallyRelease = /finally\s*\{\s*voiceRefreshInFlight\.set\(false\)\s*\}/.test(refresh.body);
    const catchRelease = /catch\s*\([^)]*\)\s*\{\s*voiceRefreshInFlight\.set\(false\)/.test(refresh.body);
    t3 = releases >= 2 && finallyRelease && catchRelease;
  }
  results.T3_single_flight_guard = t3;

  // T4：findVoice 快照語意 — 觸發刷新＋snapshot[name] 回傳，主體零 Thread 零 tts
  results.T4_findVoice_snapshot_semantics =
    !!findVoice &&
    /startVoiceIndexRefresh\(\)/.test(findVoice.body) &&
    /snapshot\[name\]/.test(findVoice.body) &&
    !/Thread\s*\{/.test(findVoice.body);

  const initCb = bodyRange(clean, /if \(status == TextToSpeech\.SUCCESS\)/);
  results.T5_init_warmup = !!initCb && /startVoiceIndexRefresh\(\)/.test(initCb.body);

  results.T6_no_legacy_cache =
    !/voiceCache/.test(clean) && !/CachedVoice/.test(clean) && !/VOICE_CACHE_TTL/.test(clean);

  // T7 F2/F3 回歸閘（剝離後源＋呼叫形態錨定＋寫入點釘死；raw string decoy 已被空白化）
  // v4（R3#2 N4/N5/N5c）：speak 的 stopRequested 重置釘行首直指派＋禁局部遮蔽；
  //   done×3 全部釘 reason "finish"、error×3 全部釘 reason "error"（原只釘 onDone 一條）
  const count = (re) => (clean.match(re) || []).length;
  results.T7_event_contract_untouched =
    count(/emitSpeechEvent\(\s*"tts:\/\/speech:start"/g) === 1 &&
    count(/emitSpeechEvent\(\s*"tts:\/\/speech:done"/g) === 3 &&
    count(/emitSpeechEvent\(\s*"tts:\/\/speech:error"/g) === 3 &&
    count(/emitSpeechEvent\(\s*"tts:\/\/speech:stopped"/g) === 2 &&
    count(/emitSpeechEvent\(\s*"tts:\/\/speech:done",\s*\w+,\s*"finish"/g) === 3 &&
    count(/emitSpeechEvent\(\s*"tts:\/\/speech:error",\s*\w+,\s*"error"/g) === 3 &&
    count(/if \(stopRequested\)/g) === 3 &&
    count(/if \(utteranceId != currentUtteranceId\) return/g) === 4 &&
    count(/focusNeedsRestore/g) === 4 &&
    !!speakFn && /(^|\n)[ \t]*stopRequested[ \t]*=[ \t]*false\b/.test(speakFn.body) &&
    !/\b(val|var)[ \t]+stopRequested\b/.test(speakFn.body) &&
    !!stopFn && /emitSpeechEvent\(\s*"tts:\/\/speech:stopped", id, "user"/.test(stopFn.body) &&
    !!pauseFn && /emitSpeechEvent\(\s*"tts:\/\/speech:stopped", id, "pause"/.test(pauseFn.body) &&
    /focusNeedsRestore = true/.test(pauseFn.body) &&
    !!onDoneFn && /emitSpeechEvent\(\s*"tts:\/\/speech:done", utteranceId, "finish"/.test(onDoneFn.body);

  return { results, findVoice, clean };
}

// ---------- 主流程 ----------
const { results, findVoice } = runDetectors(src);
const fixPresent = !!(results.T1_findVoice_no_direct_voices && results.T4_findVoice_snapshot_semantics);

// T8 負控制：只替換 findVoice 本體 matchStart..end → T1/T2/T4 必須紅；三函式仍在（防拼接吞函式）
let t8;
if (fixPresent) {
  const cleanSrc = stripAll(src);
  const fv = bodyRange(cleanSrc, /private fun findVoice\b/);
  const oldImpl = `private fun findVoice(name: String): Voice? {
        val now = System.currentTimeMillis()
        voiceCache.entries.removeAll { (now - it.value.cachedAt) > VOICE_CACHE_TTL }
        voiceCache[name]?.let { return it.voice }
        val voice = tts?.voices?.find { it.name == name }
        if (voice != null) voiceCache[name] = CachedVoice(voice, now)
        return voice
    }`;
  const reverted = cleanSrc.slice(0, fv.matchStart) + oldImpl + cleanSrc.slice(fv.end);
  const swallowed = !/private fun startVoiceIndexRefresh\b/.test(reverted) ||
    !/fun listVoices\b/.test(reverted) || !/private fun setupListener\b/.test(reverted);
  const neg = runDetectors(reverted).results;
  const flag = (ok) => ok ? 'GREEN(bad)' : 'red(ok)';
  t8 = {
    pass: !swallowed && !neg.T1_findVoice_no_direct_voices && !neg.T2_voices_only_in_started_threads && !neg.T4_findVoice_snapshot_semantics,
    note: swallowed ? '拼接吞函式！' : `revert 後 T1=${flag(neg.T1_findVoice_no_direct_voices)} T2=${flag(neg.T2_voices_only_in_started_threads)} T4=${flag(neg.T4_findVoice_snapshot_semantics)}`,
  };
} else {
  t8 = { pass: null, note: 'SKIP — 來源為 bug 態（T1/T2/T4 紅本身即負控制證據）' };
}

// ---------- 輸出 ----------
const names = {
  T1_findVoice_no_direct_voices: 'findVoice 主體零 tts/voices/getVoices token',
  T2_voices_only_in_started_threads: 'voices token 僅在 Thread{}.start() 鏈式綁定 lambda 內',
  T3_single_flight_guard: '單飛守衛 CAS＋無逃逸＋finally唯釋放/catch首句釋放',
  T4_findVoice_snapshot_semantics: 'findVoice 快照語意（觸發刷新不阻塞）',
  T5_init_warmup: 'TTS init 成功即暖機',
  T6_no_legacy_cache: '舊 voiceCache/CachedVoice/VOICE_CACHE_TTL 已移除',
  T7_event_contract_untouched: 'F2/F3 事件契約（剝離後計數＋呼叫形態＋寫入點釘死）',
};
let pass = 0, fail = 0;
console.log(`verify-f17-findvoice v4: ${PATH}`);
for (const [k, label] of Object.entries(names)) {
  const ok = results[k];
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${k} — ${label}`);
  ok ? pass++ : fail++;
}
if (t8.pass === true) { console.log(`  PASS  T8_negative_control — 剝回舊 findVoice 後 T1/T2/T4 精準紅 (${t8.note})`); pass++; }
else if (t8.pass === false) { console.log(`  FAIL  T8_negative_control — 剝除修法後 detector 未紅！(${t8.note})`); fail++; }
else console.log(`  --    T8_negative_control — ${t8.note}`);

console.log(`\n${pass}/${pass + fail} ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}`);
process.exit(fail === 0 ? 0 : 1);
