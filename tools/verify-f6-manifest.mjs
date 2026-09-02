#!/usr/bin/env node
// verify-f6-manifest.mjs — F6 靜態釘（manifest/gradle 純配置層：XML 合法性權威=AAPT2 processManifest）
// 威脅模型：防無意回歸＋偷工；不抵禦蓄意偽裝對抗。
// PRE 正宗基線釘 ee93ffa（F5 commit＝F6 動工前態）。T0 綠＝bug 事實；POST 以計畫預後樣本先行實跑。
// 編譯閘：cd src-tauri/gen/android && JAVA_HOME=~/jdk21 ANDROID_HOME=~/Android/Sdk \
//   ./gradlew :app:processArmDebugMainManifest :app:compileArmDebugKotlin --offline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PIN = process.env.TENO_PIN || 'HEAD';
const MF_REL = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml';
const GR_REL = 'src-tauri/gen/android/app/build.gradle.kts';
const DER_REL = 'src-tauri/gen/android/app/src/main/res/xml/data_extraction_rules.xml';
const read = (envVar, rel) => process.env[envVar]
  ? readFileSync(process.env[envVar], 'utf8')
  : execFileSync('git', ['show', `${PIN}:${rel}`], { encoding: 'utf8' });

// 去 XML 註解（防註解內字串冒充釘目標——F5 鑑識教訓的 XML 版）
const stripXmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const MF = stripXmlComments(read('SRC_MF', MF_REL));
const GR = read('SRC_GR', GR_REL);
// F6-SR1: data_extraction_rules.xml 源（PRE 模式 git PIN 樹；POST 樣本注入無檔時 catch 由 T0SR1/T6 handle）
const DER_RAW = (() => { try { return read('SRC_DER', DER_REL); } catch { return ''; } })();
const DER = stripXmlComments(DER_RAW);

// 偵測面常量化（T 釘與 NC 共用，防複製品漂移——F5 v1.2 判例）
const MANAGE_RE = /<uses-permission[^>]*MANAGE_EXTERNAL_STORAGE[^>]*\/>/;
// R1#3-D1：錨定 <application 開啟標籤內（allowBackup 錯置 activity/alias＝屬性有效但無效，
// 靜態釘+AAPT2 雙盲；negated class 跨換行但不可跨標籤終止符）
const ALLOW_BACKUP_RE = /<application\b[^>]*android:allowBackup="false"/g;
// F6-SR1：dataExtractionRules 屬性同樣錨定 <application 開標籤內（錯置 provider/activity＝無效）
const DER_ATTR_RE = /<application\b[^>]*android:dataExtractionRules="@xml\/data_extraction_rules"/;
// F6-SR1：官方 schema 9 domain 全列（含 device-protected storage 之 device_* 四域；
// mapping-agnostic 保證 database/token 位置皆堵）。集合相等判(防重複湊數/錯字)
const DER_DOMAINS = ['database', 'device_database', 'device_file', 'device_root',
  'device_sharedpref', 'external', 'file', 'root', 'sharedpref'];
// 解析 XML section 內所有 domain 值（排序後與 DER_DOMAINS 全等比對）
const sectionDomains = (xml, secTag) => {
  const open = xml.indexOf(`<${secTag}`);
  if (open < 0) return null;
  const close = xml.indexOf(`</${secTag}>`, open);
  if (close < 0) return null;
  const sec = xml.slice(open, close);
  const domains = [...sec.matchAll(/<exclude[^>]*domain="([^"]+)"[^>]*path="\."\s*\/>/g)].map(m => m[1]);
  return [...domains].sort();
};

// 全倉消費者守門（git grep 於 HEAD 樹；exit 1=零命中）
// R1#3-S1：needle 拆串＋pathspec 排除本腳本自身——腳本含字面符號會自 hit，
// F6 合併同 commit 起 T1 恒紅（回歸閘與修復同步死亡）。雙保險兩層都做。
const CONSUMER_SYMBOL = 'isExternalStorage' + 'Manager';
const repoGrepEmpty = (needle) => {
  try {
    execFileSync('git', ['grep', '-l', needle, 'HEAD', '--',
      'src-tauri', 'src', 'tools', 'package.json',
      ':(exclude)tools/verify-f6-manifest.mjs'], { encoding: 'utf8' });
    return false; // 有命中
  } catch (e) {
    return e.status === 1; // 1 = grep 無命中
  }
};

console.log(`[verify-f6] manifest 源 ${process.env.SRC_MF ? '樣本:' + process.env.SRC_MF : PIN} · gradle 源 ${process.env.SRC_GR ? '樣本:' + process.env.SRC_GR : PIN} · rules 源 ${process.env.SRC_DER ? '樣本:' + process.env.SRC_DER : PIN}`);

test('T0 PRE 正宗釘：MANAGE 在位＋allowBackup 屬性缺失（bug 事實）', () => {
  const base = stripXmlComments(execFileSync('git', ['show', `ee93ffa:${MF_REL}`], { encoding: 'utf8' }));
  assert.match(base, MANAGE_RE, '基線應有 MANAGE_EXTERNAL_STORAGE 聲明');
  assert.doesNotMatch(base, /android:allowBackup\s*=/, '基線應無 allowBackup 屬性（默認 true＝雲端備份黑洞）');
});

test('T1 MANAGE 絕跡＋零消費者守門釘（防順手加權）', () => {
  assert.doesNotMatch(MF, MANAGE_RE, 'MANAGE_EXTERNAL_STORAGE 仍在位——零消費者的全檔案存取權＝上架違規面');
  assert.ok(!/MANAGE_EXTERNAL_STORAGE/.test(MF), 'MANAGE 字樣以任何形態殘留');
  // 守門釘：全倉必須真無 isExternalStorageManager 消費者（若未來有人真用，此釘逼你回到計畫書）
  assert.ok(repoGrepEmpty(CONSUMER_SYMBOL),
    '倉內出現 isExternalStorageManager 消費者——T1 刪權前提失效，先升版計畫書再動 manifest');
});

test('T2 WRITE_EXTERNAL(maxSdk=28) 保留＋MediaStore 代碼在位釘（防一刀切雙刪）', () => {
  // R1#1-E1 論據改寫：MediaStore$Downloads 為 API29+ 類（SDK api-versions.xml since="29"），
  // API24-28 上本消費者先 NoClassDefFoundError（匯出斷裂=TTS 域真缺陷 O3 另單），「24-28 需 WRITE」
  // 對現行碼不實。保留 maxSdk=28 改採「零風險保守＋MediaStore 路徑若修復（O3）即回真消費者」論據。
  assert.match(MF, /<uses-permission[^>]*WRITE_EXTERNAL_STORAGE[^>]*maxSdkVersion="28"[^>]*\/>/,
    'WRITE_EXTERNAL_STORAGE maxSdk=28 缺失——O3 修復後 API24-28 MediaStore 寫入即缺權（一刀切雙刪攻擊面）');
  const tts = process.env.SRC_TTS_KT
    ? readFileSync(process.env.SRC_TTS_KT, 'utf8')
    : execFileSync('git', ['show', `${PIN}:src-tauri/gen/android/app/src/main/java/com/teno/app/TtsPlugin.kt`], { encoding: 'utf8' });
  assert.match(tts, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/,
    '代碼在位釘：TtsPlugin MediaStore 寫入點不在——要嘛路徑被刪（保留理由失效，升版計畫書），要嘛釘漂移');
});

test('T3 allowBackup="false" 顯式且恰一處', () => {
  const hits = MF.match(ALLOW_BACKUP_RE) || [];
  assert.equal(hits.length, 1, `allowBackup="false" 應恰 1 處，實際 ${hits.length}（官方建議顯式聲明；多處=標籤重複歧義）`);
});

test('T4 cleartext 政策登記釘：release placeholder=false＋debug=true 保留', () => {
  // 實錘背景：LLM 鏈走 ureq(Rust socket)，不適用 Android cleartext 政策——「擋 LLM」不實。
  // 本釘防未來拿「release 沒 LLM」當理由開全域 true（那會全開 WebView 明文；正解=NC localhost 例外）。
  const off = GR.match(/manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"false"/g) || [];
  const on = GR.match(/manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"true"/g) || [];
  assert.equal(off.length, 1, 'defaultConfig cleartext=false 缺失或被改（T4 登記釘：release 全域明文必須保持關閉）');
  assert.equal(on.length, 1, 'debug cleartext=true 缺失（devUrl http://localhost:5173 依賴它）');
  assert.doesNotMatch(GR, /getByName\("release"\)[\s\S]{0,600}usesCleartextTraffic"\]\s*=\s*"true"/,
    'release buildType 出現 cleartext=true——全域明文開閘（正解見 verify 頭註/計畫 §3）');
});

test('T5 gradle↔manifest 佔位注入鏈完整', () => {
  assert.match(MF, /android:usesCleartextTraffic="\$\{usesCleartextTraffic\}"/,
    'manifest 佔位符被寫死——gradle placeholder 注入鏈斷（debug 開發即壞）');
});

// —— 負控制（真突變式：對 POST 源注入回歸，斷言偵測面必命中）——
test('NC1 負控制：還原 MANAGE 行 → T1 偵測面必命中', () => {
  if (!process.env.SRC_MF) { assert.ok(true, 'PRE 模式跳過（無 POST 樣本可突變）'); return; }
  const mutant = MF.replace(/<uses-permission android:name="android\.permission\.WRITE_EXTERNAL_STORAGE[^>]*\/>/,
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />\n    <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />');
  assert.notEqual(mutant, MF, 'NC1 突變未生效（錨點漂移）');
  assert.ok(MANAGE_RE.test(mutant), 'NC1 失能：MANAGE 行可復活而 T1 無感');
});

test('NC2 負控制：刪除 allowBackup 屬性 → T3 偵測面歸零', () => {
  if (!process.env.SRC_MF) { assert.ok(true, 'PRE 模式跳過'); return; }
  const mutant = MF.replace(/android:allowBackup="false"\s*/, '');
  assert.notEqual(mutant, MF, 'NC2 突變未生效（allowBackup 形態漂移）');
  const hits = mutant.match(ALLOW_BACKUP_RE) || [];
  assert.equal(hits.length, 0, 'NC2 失能：刪屬性後仍有命中（偵測面虛胖）');
});

// ── F6-SR1 追加：dataExtractionRules 堵 D2D ────────────────────────────────
// 基準 504049e = F6-SR1 動工前 HEAD（F16-SR1 後）。註解 line 13 含 "dataExtractionRules" 字樣
// 故 T0SR1 一律 strip 註解＋錨定 android:…= 屬性形態（雙保險防誤判）。

test('T0SR1 PRE 正宗釘：RULES 屬性/新檔在動工前不存在（bug 事實）', () => {
  const base = stripXmlComments(execFileSync('git', ['show', `504049e:${MF_REL}`], { encoding: 'utf8' }));
  assert.match(base, /android:allowBackup="false"/, '基準應已有 allowBackup=false（F6 主修成果）');
  assert.doesNotMatch(base, /android:dataExtractionRules\s*=/, '基準應無 dataExtractionRules 屬性（D2D 未堵）');
  let missing = false;
  try { execFileSync('git', ['show', `504049e:${DER_REL}`], { encoding: 'utf8' }); } catch { missing = true; }
  assert.ok(missing, '基準應無 data_extraction_rules.xml 檔');
});

test('T6 屬性錨 application 開標籤＋檔存在＋兩 section 各 9-domain 集等', () => {
  assert.match(MF, DER_ATTR_RE, 'dataExtractionRules 屬性錯置/缺失——須於 <application 開標籤內且值=@xml/data_extraction_rules');
  assert.ok(DER.length > 0, 'data_extraction_rules.xml 缺失或空（讀取失敗——AAPT link 即崩）');
  for (const sec of ['cloud-backup', 'device-transfer']) {
    const got = sectionDomains(DER, sec);
    assert.deepEqual(got, DER_DOMAINS, `section ${sec} 5-domain 集不等（缺/重複/錯字）：${got}`);
  }
});

test('T7 compileSdk≥31 前置釘（dataExtractionRules 屬性 API31+ 才編得過）', () => {
  const m2 = GR.match(/compileSdk\s*=\s*(\d+)/);
  assert.ok(m2 && +m2[1] >= 31, `compileSdk 需 ≥31（dataExtractionRules 屬性 API31 加），實值 ${m2 ? m2[1] : '未解析'}`);
});

test('NC3 負控制：刪除 <device-transfer> section → T6 device 集必紅', () => {
  if (!DER) { assert.ok(true, 'PRE 模式跳過（無 rules 可突變）'); return; }
  const mutant = DER.replace(/<device-transfer>[\s\S]*?<\/device-transfer>/, '');
  assert.notEqual(mutant, DER, 'NC3 突變未生效（device-transfer 形態漂移）');
  assert.equal(sectionDomains(mutant, 'device-transfer'), null,
    'NC3 失能：刪 section 後 device 集仍解析得出（＝空規則被認可，違 §2 權威確認3）');
});

test('NC4 負控制：清空 <device-transfer>（空 section）→ T6 device 集判空→紅', () => {
  if (!DER) { assert.ok(true, 'PRE 模式跳過'); return; }
  const mutant = DER.replace(/<device-transfer>[\s\S]*?<\/device-transfer>/, '<device-transfer></device-transfer>');
  assert.notEqual(mutant, DER, 'NC4 突變未生效（空 section 未產生）');
  const got = sectionDomains(mutant, 'device-transfer');
  assert.notDeepEqual(got, DER_DOMAINS, 'NC4 失能：空 section 竟得 5-domain 集（＝空規則被誤判已堵）');
});
