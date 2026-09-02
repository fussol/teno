#!/usr/bin/env node
// verify-f5-icon-cleanup.mjs — F5 靜態釘＋規格決策表（真機不可行：Kotlin 以 code 事實＋編譯為準）
// 威脅模型：防無意回歸＋偷工；不抵禦蓄意偽裝對抗。
// PRE 正宗基線釘 ace9306（F4 commit＝F5 動工前態；本檔 b4cc444 引入後 F4 已改結構，
// 故不可釘 b4cc444）。T0 綠＝bug 事實；動工後 T1-T5 自證 POST。
// 決策表 harness＝**規格測試**（編碼 spec 本身），Kotlin↔spec 連接由靜態釘+編譯閘+委員推演保證，
// 非轉寫執行測試（誠實標註，防「驗證自己」質疑）。
// 編譯閘：cd src-tauri/gen/android && JAVA_HOME=~/jdk21 ANDROID_HOME=~/Android/Sdk \
//   ./gradlew :app:compileArmDebugKotlin --offline --rerun-tasks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const PIN = process.env.TENO_PIN || 'HEAD';
const KT_REL = 'src-tauri/gen/android/app/src/main/java/com/teno/app/IconPlugin.kt';
const kt = process.env.SRC
  ? execFileSync('cat', [process.env.SRC], { encoding: 'utf8' })
  : execFileSync('git', ['show', `${PIN}:${KT_REL}`], { encoding: 'utf8' });

const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
function blockOf(src, anchor, len = 6000) {
  const i = src.indexOf(anchor);
  assert.ok(i > 0, `錨點漂移：${anchor}`);
  return src.slice(i, i + len);
}
// 函數域＝起錨點至下一函數錨點（防 6000 窗口跨函數誤染，F5 鑑識 T0 教訓）
function fnBlock(src, startAnchor, endAnchor, maxLen = 6000) {
  const i = src.indexOf(startAnchor);
  assert.ok(i > 0, `錨點漂移：${startAnchor}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `錨點漂移：${endAnchor}`);
  assert.ok(j - i <= maxLen, `函數域異常長（${j - i}）——結構漂移？`);
  return src.slice(i, j);
}
// R2 建議3：T2 與 NC1 共用否定式閘偵測正則（複製品漂移防範）
const NEG_GATE_RE = /if \(\s*!\s*resolved(?:IsAlias|Active)\s*\)/;
const KT = strip(kt);
const LOAD = fnBlock(KT, 'override fun load(', '    @Command\n    fun getCurrentIcon');
const GCI = fnBlock(KT, 'fun getCurrentIcon(', '    @Command\n    fun resetAppLog');

console.log(`[verify-f5] 源 ${process.env.SRC ? '工作區:' + process.env.SRC : PIN + ':' + KT_REL}`);

test('T0 PRE 正宗釘（ace9306）：清理死鎖閘＋DEFAULT 一刀切＋fallback 瞎猜', () => {
  const base = strip(execFileSync('git', ['show', `ace9306:${KT_REL}`], { encoding: 'utf8' }));
  const L = fnBlock(base, 'override fun load(', '    @Command\n    fun getCurrentIcon');
  const G = fnBlock(base, 'fun getCurrentIcon(', '    @Command\n    fun resetAppLog');
  assert.match(L, /if \(resolvedIsAlias\) \{/, '基線應有清理短路閘（死鎖環核心）');
  assert.match(L, /state != PackageManager\.COMPONENT_ENABLED_STATE_DISABLED\)\s*enabledList\.add/,
    '基線應有 DEFAULT 一刀切 enabledList');
  assert.doesNotMatch(G, /activity\.intent/, '基線 getCurrentIcon 應無 runningComp 引用');
});

test('T1 單一事實源：isComponentActive（ENABLED ∨ DEFAULT∧Icon1）＋DEFAULT_ALIAS 常量', () => {
  assert.match(KT, /private (val|const val) DEFAULT_ALIAS\s*=\s*"com\.teno\.app\.MainActivityIcon1"/,
    '缺 DEFAULT_ALIAS 常量（唯一 manifest enabled=true 者）');
  assert.match(KT, /private fun isComponentActive\(/, '缺 isComponentActive helper');
  const h = blockOf(KT, 'private fun isComponentActive(', 700);
  assert.match(h, /COMPONENT_ENABLED_STATE_ENABLED/, 'helper 須認 ENABLED');
  assert.match(h, /COMPONENT_ENABLED_STATE_DEFAULT[\s\S]{0,120}DEFAULT_ALIAS/,
    'helper 須 DEFAULT∧DEFAULT_ALIAS 特殊化（Icon2..20 manifest=false→DEFAULT 即 inactive）');
});

test('T2 清理死鎖治癒：keep 掃描三要素——無閘（含否定式變體）＋running 分支在位', () => {
  assert.doesNotMatch(LOAD, /if \(resolvedIsAlias\) \{/, '清理段仍被 resolvedIsAlias 閘包裹——雙 enabled 死鎖復活');
  // R1#2-d：否定式/early-return 變體同堵（字面正則≠語義閘）
  assert.doesNotMatch(LOAD, NEG_GATE_RE, '否定式閘變體復活（early-return 繞過掃描）');
  assert.doesNotMatch(LOAD, /resolved(?:IsAlias|Active)\s*\.not\(\)/, '.not() 變體閘');
  // R1#2-c：runningComp 定義→清理迴圈之間不得有 return（跳過掃描）
  const iRun = LOAD.indexOf('val runningComp');
  const iLoop = LOAD.indexOf('for ((_, name) in aliases)', LOAD.indexOf('val keep'));
  assert.ok(iRun > 0 && iLoop > iRun, '結構漂移：runningComp 定義/清理迴圈順序');
  assert.doesNotMatch(LOAD.slice(iRun, iLoop), /\breturn\b/, 'keep 掃描前有 return——清理可被跳過');
  assert.ok(/for \(\(_, name\) in aliases\)/.test(LOAD), 'load 清理迴圈缺失');
  // R1#2-c：load keep 必須消費 runningIsAliasActive（T4 只管 getCurrentIcon，此為 load 側純缺口）
  assert.match(LOAD, /runningIsAliasActive\s*->\s*runningComp/,
    'load keep 缺 running 分支——ResolverActivity 時退化瞎猜（F5③b 在 load 側復活）');
  assert.match(LOAD, /runningIsAliasActive = runningComp != null[\s\S]{0,250}isComponentActive\(runningComp/,
    'runningIsAliasActive 定義須三元（∈aliases ∧ isComponentActive），退化即語意漂移');
  // R2-e 針：keep-else 分支定義形釘（偷翻 != DISABLED → keep 落 DEFAULT-inactive → 誤殺 runtime ENABLED）
  assert.match(LOAD, /firstOrNull \{ \(_, n\) ->\s*pm\.getComponentEnabledSetting\(component\(n\)\)\s*==\s*PackageManager\.COMPONENT_ENABLED_STATE_ENABLED\b/,
    'keep-else 分支非「首個 runtime ENABLED」定義——!= DISABLED 變體會把 keep 落在 DEFAULT-inactive alias');
});

test('T3 清理只動 runtime ENABLED：DEFAULT（含 Icon1 系統入口）絕不被 disable', () => {
  // R1#2-b：窗口 500→200（真 guard `st == ...ENABLED` 距 disable 呼叫實測 ~137；
  // 500 會吞進 keep-else 分支的 ENABLED 比造出假 guard → st!=DISABLED 回潮假綠）
  const disableCalls = LOAD.match(/setComponentEnabledSetting\([\s\S]{0,200}?COMPONENT_ENABLED_STATE_DISABLED/g) || [];
  assert.ok(disableCalls.length >= 1, '清理段無 disable 呼叫');
  for (const d of disableCalls) {
    const at = LOAD.indexOf(d);
    const guard = LOAD.slice(Math.max(0, at - 200), at);
    assert.match(guard, /st\s*==\s*PackageManager\.COMPONENT_ENABLED_STATE_ENABLED/,
      'disable 前置非 st==runtime ENABLED 判定——會誤殺 DEFAULT（窗口 200 內必含真 guard）');
    assert.doesNotMatch(guard, /==\s*PackageManager\.COMPONENT_ENABLED_STATE_DEFAULT\s*(\|\||&&\s*!|->)|COMPONENT_ENABLED_STATE_DEFAULT\s*(\|\||\?)/,
      'DEFAULT 進入 disable 條件——Icon1 系統入口可能被殺');
  }
});

test('T4 getCurrentIcon 優先序：runningComp 先於 firstOrNull(ENABLED)', () => {
  const iRunning = GCI.search(/activity\.intent\?\.component\?\.className/);
  const iFirst = GCI.search(/firstOrNull[\s\S]{0,250}COMPONENT_ENABLED_STATE_ENABLED/);
  assert.ok(iRunning >= 0, 'getCurrentIcon 未引用 runningComp');
  assert.ok(iFirst >= 0, 'ENABLED fallback 缺失');
  assert.ok(iRunning < iFirst, 'runningComp 須先於 firstOrNull(ENABLED)（ResolverActivity 時取實際在跑的，非 aliases 序首個）');
  // R2-g 針：runningComp 支路 active 查形釘（v1.1 建議3 採納項防無聲拆除；原或式釘因 "original" 常駐近恆真）
  assert.match(GCI, /name == runningComp &&[\s\S]{0,120}isComponentActive\(/,
    'getCurrentIcon runningComp 支路缺 isComponentActive 查——可被無聲簡化（與 load 對齊的 active 語意流失）');
  assert.match(GCI, /isComponentActive|"original"/, '末段兜底仍在');
});

test('T5 dump/enabledList 如實化：isComponentActive 消費＋一刀切標籤絕跡', () => {
  assert.match(LOAD, /enabledList[\s\S]{0,200}isComponentActive|isComponentActive[\s\S]{0,200}enabledList/,
    'enabledList 未改用 isComponentActive');
  // 一刀切＝ DEFAULT 態直接映射 active 字樣（無條件分支）；條件化後必有 inactive 變體
  assert.match(LOAD, /default\(=inactive\)/, 'DEFAULT 條件化標籤缺失（Icon2..20 DEFAULT=inactive）');
  assert.doesNotMatch(KT, /COMPONENT_ENABLED_STATE_DEFAULT\s*->\s*"default\(=active\)"/,
    '「default(=active)」一刀切分支殘留');
});

// —— 規格決策表（spec 即本表；Kotlin 連接由 T1-T5＋編譯＋委員推演保證）——
const E = 'ENABLED', D = 'DISABLED', F = 'DEFAULT';
// 場景：name→state × resolved × running → {keep, shouldDisable}
const SPEC = [
  { 名: '雙 ENABLED 殘留(setIcon 中途死)', st: { Icon1: D, Icon2: E, Icon4: E }, resolved: 'ResolverActivity', running: 'Icon4',
    keep: 'Icon4', disable: ['Icon2'] },
  { 名: '備份恢復全 DEFAULT', st: { Icon1: F, Icon2: F }, resolved: 'Icon1', running: null,
    keep: 'Icon1', disable: [] },
  // R1#2-a 修表：自癒段先改系統態（Icon1→ENABLED），keep-else 分支 live-read → keep=Icon1。
  // 舊表釘 keep=null 係 snapshot 模型與碼（live 模型）矛盾——表與碼只能有一個真相。
  { 名: 'Icon1 被殺自癒', st: { Icon1: D, Icon2: D }, resolved: null, running: null,
    keep: 'Icon1', disable: [] },
  { 名: '正常單 active', st: { Icon1: D, Icon4: E }, resolved: 'Icon4', running: 'Icon4',
    keep: 'Icon4', disable: [] },
];
test('T6 規格決策表（keep/disable 語意四場景自洽——規範自身無矛盾）', () => {
  // 獨立最小實作＝spec 的可執行陳述（非 Kotlin 轉寫宣稱）；live 模型：自癒 mutate 先於 keep
  function decide(st0, resolved, running) {
    const st = { ...st0 };
    const active = (n) => st[n] === E || (n === 'Icon1' && st[n] === F);
    if (!Object.keys(st).some(active)) st.Icon1 = E; // 自癒段（ mutate 系統態）
    let keep = null;
    if (running && active(running)) keep = running;
    else if (resolved && resolved !== 'ResolverActivity' && st[resolved] !== undefined && active(resolved)) keep = resolved;
    else keep = Object.keys(st).find(n => st[n] === E) || null;
    const disable = Object.keys(st).filter(n => n !== keep && st[n] === E);
    return { keep, disable };
  }
  for (const c of SPEC) {
    const got = decide(c.st, c.resolved, c.running);
    assert.deepEqual(got.disable, c.disable, `${c.name} disable 集`);
    assert.equal(got.keep, c.keep, `${c.name} keep`);
  }
});

// —— 負控制（真突變式，F4 範式：對 POST 源注入回歸突變，斷言釘陣必須命中）——
test('NC1 負控制：注入否定式閘 early-return（d 攻擊原樣）→ T2 釘必命中突變體', () => {
  const at = LOAD.indexOf('val runningComp');
  if (at < 0) { assert.fail('POST 缺 runningComp 錨（T2 已紅前提）'); return; }
  const mutant = LOAD.slice(0, at) +
    'if (!resolvedIsAlias) { super.load(webView); return }\n' + LOAD.slice(at);
  // 突變體須被 T2 三釘任一抓住：否定式閘 / return-in-window
  const iLoop = mutant.indexOf('for ((_, name) in aliases)', mutant.indexOf('val keep'));
  const caught = NEG_GATE_RE.test(mutant) ||
    (iLoop > at && /\breturn\b/.test(mutant.slice(at, iLoop)));
  assert.ok(caught, 'NC1 失能：d 攻擊變體可繞過 T2（偵測面又有洞）');
});

test('NC2 負控制：刪除 keep-running 分支（c 攻擊原樣）→ T2/T4 釘必命中突變體', () => {
  const mutant = kt
    .replace(/runningIsAliasActive -> runningComp\n\s*/, '')
    .replace(/key = aliases\.firstOrNull \{ \(_, name\) ->\s*\n\s*name == runningComp[\s\S]{0,160}isComponentActive\(name[^}]*\}\n\s*\)\}\?\.first/, 'key = null?.first');
  const M = strip(mutant);
  const caughtLoad = !/runningIsAliasActive\s*->\s*runningComp/.test(M) ||
    !/runningIsAliasActive = runningComp != null[\s\S]{0,250}isComponentActive\(runningComp/.test(M);
  const mGci = M.slice(M.indexOf('fun getCurrentIcon('));
  const caughtGci = !/activity\.intent\?\.component\?\.className[\s\S]{0,400}firstOrNull/.test(mGci) ||
    /key = null\?\.first/.test(mGci);
  assert.ok(caughtLoad || caughtGci, 'NC2 失能：keep-running 刪除可繞過釘陣');
  // 驗證突變體本身仍編譯級合理（非亂碼）：僅刪分支未破壞其餘結構锚點
  assert.ok(/for \(\(_, name\) in aliases\)/.test(M), 'NC2 突變不應破壞清理迴圈本體');
});
