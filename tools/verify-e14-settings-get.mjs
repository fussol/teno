#!/usr/bin/env node
// verify-e14-settings-get.mjs — E14: theme/tts/day 九站點 `.get().value` 無可選鏈 →
// 全新 DB（settings 表在、key 未寫）讀不存在列 get() 回 undefined → TypeError
// 被 runCli 頂層 catch 吞成「命令 X 失敗」exit 0；cmdDay 還把 cur 吞進運算（NaN:NaN）。
// 修法＝readSettingRaw helper（?..value ?? null）九站點＋顯示層 `?? '未設定'`＋
// cmdDay null 分支誠實標（0:00 註記出處=app 降級守門，非 CLI 自創預設）。
// 全部 tmp DB，嚴禁碰 ~/.config/com.teno.app/teno.db。
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'tools', 'cli.mjs');
let pass = 0, fail = 0;
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' | ' + extra : ''}`); }
};
const dir = mkdtempSync(join(tmpdir(), 'e14-verify-'));

const E14_MARK = '// E14: settings 讀回顯統一';
const HELPER_DEF = "const readSettingRaw = (key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;";
const HELPER_BUGGY = "const readSettingRaw = (key) => db.prepare('SELECT value FROM settings WHERE key=?').get(key).value ?? null;";
const UNSET = '未設定';
// 九站點：命令 argv → 期望回顯前綴（pure-get）
const SITES = [
  [['theme', 'mode'], 'themeMode = '],
  [['theme', 'accent'], 'themeAccent = '],
  [['theme', 'intensity'], 'themeAccentIntensity = '],
  [['theme', 'palette'], 'colorPalette = '],
  [['tts', 'speed'], 'ttsSpeed = '],
  [['tts', 'voice'], 'ttsVoice = '],
  [['tts', 'pitch'], 'ttsPitch = '],
  [['tts', 'engine'], 'ttsEngine = '],
  [['day'], 'dayCutoff = '],
];

function mkDb(p) {
  const d = new DatabaseSync(p);
  // 全新 DB 語境：settings 表存在、零列（E14 佇列場景原文）
  d.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  d.close();
  return p;
}
function run(cliPath, argv, db) {
  return spawnSync('node', [cliPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, TENO_DB: db, TENO_NO_BACKUP: '1', TENO_LOG: join(dir, 'cli.log') },
    timeout: 60000,
  });
}
function mkTarget(tag) { const d2 = join(dir, tag); mkdirSync(d2); return mkDb(join(d2, 'teno.db')); }

try {
  const src = readFileSync(CLI, 'utf8');
  const fixed = src.includes(E14_MARK);
  console.log(`[mode] ${fixed ? '修法版' : '原版(HEAD)'} — 雙態皆可跑：修法版全綠；原版由 T5 負控制重現\n`);

  console.log('T1 九站點 pure-get（全新 DB）→ exit 0＋『未設定』＋零崩潰回聲');
  for (const [argv, prefix] of SITES) {
    const tgt = mkTarget('t1_' + argv.join('_'));
    const r = run(CLI, argv, tgt);
    const out = r.stdout + r.stderr;
    T(`T1 ${argv.join(' ')} → ${prefix.trim()}${UNSET}`,
      r.status === 0 && r.stdout.includes(prefix + UNSET) || (argv[0] === 'day' && r.stdout.includes('dayCutoff = ' + UNSET)),
      `status=${r.status} out=${r.stdout.trim().slice(0, 80)}`);
    T(`T1x ${argv.join(' ')} 零 TypeError/失敗回聲`, !/TypeError|失敗|undefined/.test(out), out.split('\n').find(l => /TypeError|失敗|undefined/) || '');
  }

  console.log('T2 cmdDay 垃圾行殲滅');
  {
    const tgt = mkTarget('t2');
    const r = run(CLI, ['day'], tgt);
    T('T2a 零 NaN:NaN／零『undefined 分鐘』', !r.stdout.includes('NaN:NaN') && !r.stdout.includes('undefined 分鐘'), r.stdout.trim());
    T('T2b 含 0:00 日界線出處註記', r.stdout.includes('0:00 為日界線'), r.stdout.trim());
  }

  console.log('T3 寫後讀回歸全九站覆蓋（R1-M1 義務：既有行為零變化釘）');
  {
    const wr = [
      [['theme', 'mode', 'dark'], 'themeMode = dark'],
      [['theme', 'accent', 'skyBlue'], 'themeAccent = skyBlue'],
      [['theme', 'intensity', '0.5'], 'themeAccentIntensity = 0.5'],
      [['theme', 'palette', '#fff', '#000'], 'colorPalette = ["#fff","#000"]'],
      [['tts', 'speed', '1.5'], 'ttsSpeed = 1.5'],
      [['tts', 'voice', 'zh_TW-abc'], 'ttsVoice = zh_TW-abc'],
      [['tts', 'pitch', '70'], 'ttsPitch = 70'],
      [['tts', 'engine', 'piper'], 'ttsEngine = piper'],
      [['day', '300'], 'dayCutoff = 300 分鐘 (5:00 為日界線)'],
    ];
    for (const [argv, expect] of wr) {
      const tgt = mkTarget('t3_' + argv.join('_'));
      const r = run(CLI, argv, tgt);
      T(`T3 ${argv.join(' ')} → ${expect}`, r.status === 0 && r.stdout.includes(expect), `status=${r.status} out=${r.stdout.trim().slice(0, 100)}`);
    }
    // day 邊界（clamp 語意回歸：寫入路徑守門原樣）
    for (const [v, expect] of [['0', 'dayCutoff = 0 分鐘 (0:00'], ['1439', 'dayCutoff = 1439 分鐘 (23:59'], ['-5', 'dayCutoff = 0 分鐘 (0:00'], ['1500', 'dayCutoff = 1439 分鐘 (23:59']]) {
      const tgt = mkTarget('t3d_' + v);
      const r = run(CLI, ['day', v], tgt);
      T(`T3d day ${v} → ${expect}`, r.stdout.includes(expect), r.stdout.trim().slice(0, 90));
    }
  }

  console.log('T4 log(READ) 行同步（tmp TENO_LOG）');
  {
    const tgt = mkTarget('t4');
    const lg = join(dir, 'cli.log');
    try { rmSync(lg, { force: true }); } catch {}
    run(CLI, ['theme', 'mode'], tgt);
    let logTxt = '';
    try { logTxt = readFileSync(lg, 'utf8'); } catch {}
    T('T4 log 含『theme mode = 未設定』', logTxt.includes('theme mode = 未設定'), logTxt.slice(-120));
  }

  console.log('T5 負控制（R1-M2：僅反換 helper 本體一行 → 九站點崩潰重現；雙態自適應）');
  {
    const subDir = join(dir, 'sub');
    mkdirSync(join(subDir, 'tools'), { recursive: true });
    if (!existsSync(join(subDir, 'src'))) symlinkSync(join(REPO, 'src'), join(subDir, 'src'), 'dir');
    const clone = join(subDir, 'tools', 'cli-sub.mjs');
    let swapped;
    if (fixed) {
      if (!src.includes(HELPER_DEF)) throw new Error('HELPER_DEF 與工作區逐字不符（helper 被改寫？先同步腳本）');
      swapped = src.replace(HELPER_DEF, HELPER_BUGGY); // .value ?? null：undefined ?? null 救不了 .value 崩潰＝原版語義
    } else {
      // 原版模式：正換重建修法版（呼叫點已是原版 .get().value 的不可能態不出現——改為直接驗證原版站點崩潰，見下）
      swapped = null;
    }
    if (swapped !== null && swapped === src) throw new Error('負控制替換未生效');
    if (swapped !== null) writeFileSync(clone, swapped);
    const crashSeen = [];
    const probeSites = fixed ? SITES : SITES;
    for (const [argv] of probeSites) {
      const tgt = mkTarget('t5_' + argv.join('_'));
      const r = run(fixed ? clone : CLI, argv, tgt);
      if (/Cannot read properties of undefined \(reading 'value'\)/.test(r.stdout + r.stderr)) crashSeen.push(argv.join(' '));
    }
    if (fixed) {
      T('T5a helper 反換 → 九站點崩潰全重現', crashSeen.length === 9, `重現 ${crashSeen.length}/9: ${crashSeen.join(' | ')}`);
    } else {
      T('T5a 原版九站點崩潰重現（mode=原版 直接測）', crashSeen.length === 9, `重現 ${crashSeen.length}/9`);
    }
    // 反空洞：反換版 ≠ 工作區版
    if (fixed) T('T5b 反換真實性（swap≠src）', swapped !== src);
  }

  console.log('T6 結構釘（源碼層）');
  {
    // 零殘留：`.get().value` 直串模式（註解已避 token，整檔掃；R1-M2 呼叫點零殘留）
    const residue = src.match(/\.get\(\)\.value|\.get\([^\)]*\)\.value(?!\s*\?\?)/g) || [];
    T('T6a 全檔 .get(...).value 無守門直串 零殘留', residue.length === 0, residue.join(' | '));
    const helperCnt = (src.match(/const readSettingRaw/g) || []).length;
    T('T6b helper 定義恰 1', helperCnt === 1, `cnt=${helperCnt}`);
    const callCnt = (src.match(/readSettingRaw\('/g) || []).length;
    T('T6c 呼叫點恰 9', callCnt === 9, `cnt=${callCnt}`);
    T('T6d cmdDay null 分支存在（誠實標＋原格式雙軌）', /cur === null/.test(src) && src.includes('0:00 為日界線'));
    T('T6e 未設定顯示源恰 9 站點＋day 獨立標（?? 未設定 出現 8 次於回顯 + READ）', (src.match(/\?\? '未設定'/g) || []).length === 16, `cnt=${(src.match(/\?\? '未設定'/g) || []).length}（期望 8 站×回顯+READ 兩處=16，day 另走分支）`);
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(`\n結果: ${pass} PASS / ${fail} FAIL ${fail === 0 ? '— ALL PASS' : ''}`);
process.exit(fail === 0 ? 0 : 1);
