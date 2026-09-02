#!/usr/bin/env node
// verify-f4-icon-restart.mjs — F4 靜態釘＋語義閘（真機不可行：Kotlin 以 code 事實＋編譯為準）
// 釘契約（R1#2 釐清）：PI「構造」必須經統一 helper（T4）；cancel「迴圈」必須內聯於
// setIcon 本體（T1 域）——構造 helper 化不違反內聯契約，两者不矛盾。
// 威脅模型：防無意回歸＋偷工（GOV 慣例定文）；不抵禦蓄意偽裝對抗。
// F4 本檔自 b4cc444 引入且零漂移（diff b4cc444..HEAD 空）→ PRE 正宗釘直接釘 HEAD 現態。
// T0 綠＝bug 基線事實（動工前）；動工後 T0 自動翻紅屬預期，POST 以 T1-T7 自證。
// 編譯閘另跑：JAVA_HOME=~/jdk21 ./gradlew :app:compileArmDebugKotlin --offline（見計畫 §4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const REPO = process.env.TENO_REPO || execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const PIN = process.env.TENO_PIN || 'HEAD';
const KT_REL = 'src-tauri/gen/android/app/src/main/java/com/teno/app/IconPlugin.kt';
// SRC env＝直接讀該檔（工作區 POST 態驗證用）；否則 git show PIN:檔
const kt = process.env.SRC
  ? execFileSync('cat', [process.env.SRC], { encoding: 'utf8' })
  : execFileSync('git', ['show', `${PIN}:${KT_REL}`], { encoding: 'utf8' });

const siStart = kt.indexOf('    fun setIcon(');
assert.ok(siStart > 0, '錨點漂移：fun setIcon( 找不到');
const si = kt.slice(siStart);

const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
function blockAfter(src, marker) {
  const m = src.indexOf(marker);
  if (m < 0) return null;
  const open = src.indexOf('{', src.indexOf(')', m));
  let d = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(open, i + 1);
}

function analyze(src) {
  const KT = strip(src);
  const s0 = KT.indexOf('    fun setIcon(');
  assert.ok(s0 > 0, '錨點漂移（去註解後）');
  const SI = KT.slice(s0);
  const innerCatch = blockAfter(SI, 'catch (e: Exception) {\n                    Log.e(TAG, "scheduled restart');
  return { KT, SI, innerCatch };
}

console.log(`[verify-f4] 源 ${process.env.SRC ? '工作區:' + process.env.SRC : PIN + ':' + KT_REL}`);

test('T0 bug 基線正宗釘：b4cc444（＝本檔唯一歷史態）三缺陷俱在', () => {
  const base = execFileSync('git', ['show', 'b4cc444:' + KT_REL], { encoding: 'utf8' });
  const { SI, innerCatch } = analyze(base);
  assert.match(SI, /getActivity\(\s*activity,\s*0,/, '基線應有 requestCode 0 內聯 PI');
  assert.doesNotMatch(analyze(base).KT, /FLAG_NO_CREATE/, '基線應全檔無 cancel 機制');
  assert.match(SI, /setAndAllowWhileIdle\(AlarmManager\.RTC,\s*System\.currentTimeMillis\(\) \+ 1200/, '基線應有牆鐘排程');
  assert.ok(innerCatch && !/setComponentEnabledSetting/.test(innerCatch), '基線 catch 應無回滾');
  // （audit 行號可信性：PM 動工前實測 `git diff b4cc444..HEAD -- 本檔` 為空＝零漂移，
  //  屬剎那事實不釘入腳本——本 commit 後 HEAD 必異於 base，釘了反而永紅。）
});

// —— 以下 POST 斷言（動工前應紅；動工後全綠）——
const { KT, SI, innerCatch } = analyze(kt);

test('T1 掃蕩 cancel：排程前以 FLAG_NO_CREATE 探測全部 alias 舊 PI 並 am.cancel', () => {
  assert.match(SI, /FLAG_NO_CREATE/, '無 FLAG_NO_CREATE 探測＝舊 alarm 無法取得句柄取消');
  // 必須迴圈掃全部 alias 且探測引數＝迴圈變數（R1#2-e2：探錯 target.second＝掃蕩壞死、
  // 原 bug 復活卻過釘——backreference 綁定變數名封死）
  assert.match(SI, /for \(\(_, (\w+)\) in aliases\)[\s\S]{0,500}?restartPending\(\s*\1\s*[,)][\s\S]{0,400}?\.cancel\(/,
    'cancel 必須在 aliases 迴圈內且探測引數綁定迴圈變數（掃蕩完備性）');
  const cancelIdx = SI.search(/\.cancel\(/);
  const schedIdx = SI.search(/setAndAllowWhileIdle/);
  assert.ok(cancelIdx >= 0 && schedIdx >= 0 && cancelIdx < schedIdx, 'cancel 必須先於排程');
});

test('T2 單調時鐘：ELAPSED_REALTIME_WAKEUP＋elapsedRealtime 釘進同一呼叫實參，牆鐘絕跡', () => {
  // R1#2-c2：正向必須把時鐘型別與時間運算釘進 setAndAllowWhileIdle 的實參位址——
  // 「死變數＋log 字樣」過不了实參釘
  assert.match(SI, /setAndAllowWhileIdle\(\s*AlarmManager\.ELAPSED_REALTIME_WAKEUP\s*,\s*SystemClock\.elapsedRealtime\(\)\s*\+/,
    'alarm 時鐘型別/運算必須是排程呼叫的實參（非旁證字樣）');
  assert.doesNotMatch(SI, /AlarmManager\.RTC\b/, '殘留 RTC 族（含 RTC_WAKEUP）牆鐘排程——改系統時間即失控');
  assert.doesNotMatch(SI, /System\.currentTimeMillis\(\)\s*\+\s*\d+/, '殘留 currentTimeMillis 偏移排程');
  assert.match(KT, /import android\.os\.SystemClock/, '缺 SystemClock import');
});

test('T3 失敗回滾：內層 catch 必把已 enable 的 target DISABLED 回滾（防雙 enabled 歧義）', () => {
  assert.ok(innerCatch, '找不到內層 catch 塊（結構漂移？）');
  assert.match(innerCatch, /setComponentEnabledSetting/, 'catch 未回滾 target enable');
  assert.match(innerCatch, /COMPONENT_ENABLED_STATE_DISABLED/);
  assert.match(innerCatch, /component\(\s*target\.second\s*\)/, '回滾目標應為 target.second');
});

test('T4 統一 PI 構造器：getActivity 全檔僅 helper 一處且 component 參數化', () => {
  const calls = KT.match(/PendingIntent\.getActivity\(/g) || [];
  assert.equal(calls.length, 1, `getActivity 應全檔僅 helper 一處，實際 ${calls.length}`);
  assert.doesNotMatch(SI, /getActivity\(\s*activity/, 'setIcon 內不得內聯構造——必須經統一構造器');
  const hIdx = KT.indexOf('private fun restartPending');
  assert.ok(hIdx > 0, '缺 restartPending 統一構造器');
  const helper = KT.slice(hIdx, hIdx + 900);
  // 不變量＝單一構造點＋name 參數化；接受 component(name) 或 ComponentName(pkg, name) 兩形（R1#2-e1）
  assert.match(helper, /setComponent\((?:component\(\s*\w+\s*\)|ComponentName\(\s*[\w.]+\s*,\s*\w+\s*\))\)/,
    'helper component 未參數化');
});

test('T5 payload 誠實化：resolve 兩出口明示 restart 布林', () => {
  const trues = (SI.match(/put\("restart",\s*true\)/g) || []).length;
  const falses = (SI.match(/put\("restart",\s*false\)/g) || []).length;
  assert.ok(trues >= 1 && falses >= 1, `重啟/免重啟兩出口都應明示 restart 值，實際 true=${trues} false=${falses}`);
  assert.ok((SI.match(/invoke\.resolve/g) || []).length >= 2, '兩出口各一 resolve');
});

test('T6 關鍵順序釘：enable→cancel→schedule→disable running→finish', () => {
  const idx = (re) => { const i = SI.search(re); assert.ok(i >= 0, `順序釘缺元素 ${re}`); return i; };
  const iEnable = idx(/setComponentEnabledSetting\(\s*component\(target\.second\),\s*PackageManager\.COMPONENT_ENABLED_STATE_ENABLED/);
  const iCancel = idx(/\.cancel\(/);
  const iSched = idx(/setAndAllowWhileIdle/);
  const iDisableRunning = idx(/component\(runningComp!!\)[\s\S]{0,80}COMPONENT_ENABLED_STATE_DISABLED/);
  const iFinish = SI.indexOf('activity.finish()');
  assert.ok(iEnable < iSched, 'enable target 必先於排程');
  assert.ok(iCancel < iSched, 'cancel 必先於排程');
  assert.ok(iSched < iDisableRunning, '排程必先於 disable running（否則被系統殺程來不及排 restart→永久退出）');
  assert.ok(iDisableRunning < iFinish, 'disable running 先於 finish');
});

test('T7 finish 仍在 try 內（audit「try 外」宣稱不實——防「順手修不實的」反向弄壞）', () => {
  // R1#2-f2：用 strip 域 KT（未 strip 時 doc 註解提及 finish 字樣即假紅）
  const fi = KT.indexOf('activity.finish()');
  assert.ok(fi > 0);
  const after = KT.slice(fi, fi + 200);
  assert.match(after, /\}\s*catch \(e: Exception\)/, 'finish 不再是 try 塊語句？');
});

test('T8 回滾出口誠實化：排程失敗走 reject（防 ok:true 對 JS 說謊）', () => {
  assert.match(SI, /invoke\.reject\(\s*"restart scheduling failed/,
    '回滾出口必須 reject——settings.js:827 resolve 即 toast「重新啟動中…」，ok:true 會說謊');
});

// —— 負控制（POST 達成後生效；對當前 POST 態做精準剝除）——
test('NC1 負控制：只換回牆鐘 → T2 紅、其餘不受染', () => {
  // R1#2-④：guard 讀 KT（strip 域，防字串注入騙過）；刪恆真死斷言
  if (!/ELAPSED_REALTIME_WAKEUP/.test(KT)) { console.log('  (POST 未達成，跳過 NC)'); return; }
  const variant = kt
    .replace('AlarmManager.ELAPSED_REALTIME_WAKEUP,', 'AlarmManager.RTC_WAKEUP,')
    .replace('SystemClock.elapsedRealtime() + 1200', 'System.currentTimeMillis() + 1200');
  assert.notEqual(variant, kt, 'NC1 替換未命中');
  const { SI: V } = analyze(variant);
  // T2 必須紅（RTC_WAKEUP 亦抓＋实參釘失守）
  assert.ok(/AlarmManager\.RTC\b/.test(V) ||
    !/setAndAllowWhileIdle\(\s*AlarmManager\.ELAPSED_REALTIME_WAKEUP\s*,\s*SystemClock\.elapsedRealtime\(\)\s*\+/.test(V),
    'NC1 失能：牆鐘未注回 T2 語義');
  // 其餘釘不受染：cancel 完備性＋回滾＋reject 仍在（未連動破壞）
  assert.match(V, /FLAG_NO_CREATE/);
  assert.match(V, /invoke\.reject\(\s*"restart scheduling failed/);
});

test('NC2 負控制：只拿掉 catch 回滾 → T3 紅、其餘不受染', () => {
  if (!innerCatch || !/setComponentEnabledSetting/.test(innerCatch)) { console.log('  (POST 未達成，跳過 NC)'); return; }
  // 在 strip 域操作（KT/innerCatch 均已去註解，域一致才可 replace）
  const noRollback = KT.replace(innerCatch,
    innerCatch.replace(/try \{[\s\S]*?setComponentEnabledSetting[\s\S]*?\} catch \(e2: Exception\) \{[\s\S]*?\n\s*\}/,
      'Log.e(TAG, "rollback skipped")'));
  assert.notEqual(noRollback, KT, 'NC2 剝除未命中（結構與預期不符）');
  const s0 = noRollback.indexOf('    fun setIcon(');
  const ic2 = blockAfter(noRollback.slice(s0), 'catch (e: Exception) {\n                    Log.e(TAG, "scheduled restart');
  assert.ok(ic2 && !/setComponentEnabledSetting/.test(ic2), 'NC2 失能：回滾未剝除');
  assert.ok(ic2.includes('rollback skipped'), 'NC2 剝除應精準（只換掉回滾段）');
});
