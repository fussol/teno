#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// WIDGET1 防回歸 — Android 桌面 Widget 與通知
//
// 用法:
//   node tools/verify-widget.mjs
//
// 涵蓋：
//   1) Manifest：6 權限、兩顆 widget receiver（狀態／抽字）＋RefreshReceiver/BOOT、FGS specialUse
//   2) Kotlin：@TauriPlugin 命令齊、TenoWidget 口徑鏡像標記（buried/suspended/settings keys）、主題色鏡像
//   3) res：layout ×2、info ×2、drawable 背景／進度條／換字 icon／通知 icon
//   4) Rust：widget_android 註冊（mod/.plugin/generate_handler 四命令）
//   5) JS：api 四包裝、settings 區塊拆分（Widget／通知兩區，僅 Android）、main.js 開 App／可見推播
//   6) 口徑對拍：JS 鏡像（Kotlin readCounts 的移植）vs core/scheduler.getDueCards
// ═══════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDueCards, nextDayAtMs as schedNextDayAtMs } from '../src/core/scheduler.js';
import { settingsSrc } from './lib/page-src.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log(`  ok  ${msg}`); }
  else { fail++; console.error(`FAIL  ${msg}`); }
};

// ── 1) Manifest ──
console.log('── 1) Manifest ──');
const mf = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
for (const p of [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.FOREGROUND_SERVICE"',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
]) ok(mf.includes(p), `manifest 權限 ${p}`);
ok(/<receiver[^>]*"\.TenoStatusWidgetProvider"/s.test(mf), 'manifest receiver TenoStatusWidgetProvider');
ok(/<receiver[^>]*"\.TenoWordWidgetProvider"/s.test(mf), 'manifest receiver TenoWordWidgetProvider');
ok(/<receiver[^>]*"\.TenoWeeklyWidgetProvider"/s.test(mf), 'manifest receiver TenoWeeklyWidgetProvider');
ok(/<receiver[^>]*"\.TenoCaptureWidgetProvider"/s.test(mf), 'manifest receiver TenoCaptureWidgetProvider');
ok(mf.includes('@xml/teno_widget_info_weekly'), 'manifest weekly provider meta');
ok(mf.includes('@xml/teno_widget_info_capture'), 'manifest capture provider meta');
ok(mf.includes('android.appwidget.action.APPWIDGET_UPDATE'), 'manifest APPWIDGET_UPDATE filter');
ok(mf.includes('@xml/teno_widget_info_status'), 'manifest status provider meta');
ok(mf.includes('@xml/teno_widget_info_word'), 'manifest word provider meta');
ok(!mf.includes('TenoWidgetProvider') && !mf.includes('@xml/teno_widget_info"'), '舊單一 receiver/info 已移除');
ok(/<receiver[^>]*"\.TenoRefreshReceiver"/s.test(mf), 'manifest receiver TenoRefreshReceiver');
ok(mf.includes('android.intent.action.BOOT_COMPLETED'), 'manifest BOOT_COMPLETED filter');
ok(/<service[^>]*"\.TenoResidentService"/s.test(mf), 'manifest service TenoResidentService');
ok(mf.includes('foregroundServiceType="specialUse"'), 'manifest FGS specialUse 型別');
ok(mf.includes('PROPERTY_SPECIAL_USE_FGS_SUBTYPE'), 'manifest FGS 特殊用途說明');

// ── 2) Kotlin ──
console.log('── 2) Kotlin ──');
const KDIR = 'src-tauri/gen/android/app/src/main/java/com/teno/app';
for (const f of ['TenoWidget.kt', 'WidgetPlugin.kt', 'TenoWidgetReceiver.kt', 'TenoResidentService.kt'])
  ok(exists(`${KDIR}/${f}`), `Kotlin ${f} 存在`);

const kw = read(`${KDIR}/TenoWidget.kt`);
ok(kw.includes('object TenoWidget'), 'TenoWidget 為 object');
ok(kw.includes('nextDayAtMs') && kw.includes('86_400_000L'), 'nextDayAtMs 鏡像（日界線常數）');
ok(kw.includes("card_state = 0 AND mode = 'flip'"), 'ratedNewToday 口徑（card_state=0 AND mode=flip）');
ok(kw.includes("SELECT w.id, c.state, c.due FROM words w LEFT JOIN cards c"), '新卡＝無卡 LEFT JOIN');
ok(kw.includes('if (id in buried || id in suspended) continue'), 'buried/suspended 來自 settings 陣列');
ok(kw.includes('if (state == 2) review++ else learn++'), 'state 分流（2=復，1/3=學）');
ok(kw.includes('dueMs >= boundary'), 'due < 十日界線 邊界判斷');
ok(kw.includes('cardsPerDay') && kw.includes('ratedNew'), '新卡額度扣 ratedNewToday');
ok(kw.includes('simParams') && kw.includes('maxReviewsPerDay'), '復卡 simMax 上限');
ok(kw.includes('dayCutoff') && kw.includes('timezoneOffset'), '日界線設定讀 dayCutoff/timezoneOffset');
ok(kw.includes('File(ctx.dataDir, "teno.db")') || kw.includes('dbFile'), 'DB 路徑 = dataDir/teno.db（app_config_dir 同源）');
ok(kw.includes('setExactAndAllowWhileIdle'), '精確鬧鐘 setExactAndAllowWhileIdle');
ok(kw.includes('ACTION_ROTATE') && kw.includes('ACTION_DAY') && kw.includes('ACTION_NOTIFY'), '三種鬧鐘 action');
ok(kw.includes('startForegroundService'), '常駐走前台服務');
// 主題色鏡像（theme.js 同口徑）
ok((kw.match(/"[a-zA-Z]+" to "#[0-9A-F]{6}"/g) || []).length === 40, 'ACCENTS 色表 40 條（與 theme.js 同值）');
ok(kw.includes('hexToHsl') && kw.includes('hslToColor'), 'hexToHSL／hslToRgb 鏡像');
ok(kw.includes('themeAccentIntensity') && kw.includes('(intensity - 0.5f) * 40f'), 'intensity 公式鏡像');
ok(kw.includes('aL - 24f'), '淺色底用 accent-deep（aL-24）');
// 四顆 widget 獨立渲染
ok(kw.includes('TenoStatusWidgetProvider') && kw.includes('TenoWordWidgetProvider'), '兩 provider 分開渲染');
ok(kw.includes('TenoWeeklyWidgetProvider') && kw.includes('TenoCaptureWidgetProvider'), '本週／收詞 provider 渲染');
// 點擊路由（MainActivity extras → window.__widgetRoute）
ok(kw.includes('teno_route') && kw.includes('teno_arg'), 'launchPending 路由 extras teno_route/teno_arg');
ok(kw.includes('route != null') && kw.includes('removeExtra'), 'route 空 → removeExtra（無路由開 app 原樣）');
ok(kw.includes('launchPending(ctx, "review", null, 10)'), '狀態 widget 點擊 → review（study 複習頁）');
ok(kw.includes('launchPending(ctx, "word", w?.id') && kw.includes(', 20)'), '抽字 widget 點擊 → word（帶字 id）');
ok(kw.includes('launchPending(ctx, "add", null, 40)'), '收詞 widget 點擊 → add');
ok(kw.includes('PickedWord(w, d, pron, pos, ex, wid, extra)'), 'pickWord 帶 words.id 給字卡路由（＋額外欄位）');
ok(kw.includes('rowid, id'), 'pickWord cols 含 id');
// 抽字 widget 額外顯示欄位（設定頁勾選；白名單防 SQL 欄名注入）
ok(kw.includes('WORD_FIELD_LABEL') && kw.includes('"syllables" to "音節"'), 'Kotlin WORD_FIELD_LABEL 白名單');
ok(kw.includes('c.getColumnIndex(f)'), 'pickWord 只撈勾選欄位（動態 cols）');
ok(kw.includes('want.joinToString("") { ", $it" }'), 'pickWord 依勾選拼 SELECT 欄位');
ok(kw.includes('wordFieldText') && kw.includes("startsWith(\"[\")"), 'JSON 陣列欄位轉逗號列');
ok(kw.includes('rv.setTextViewText(R.id.wwExtra'), 'wordViews 寫 wwExtra');
ok(kw.includes('R.id.wwExtra, View.GONE'), '全欄無值 → wwExtra GONE（維持原樣）');
// 本週複習（review_log 近7日）
ok(kw.includes('fun readWeekly'), 'readWeekly 讀 review_log 近 7 日');
ok(kw.includes('6 - off') && kw.includes('IntArray(7)'), '週桶 [0]=6天前…[6]=今天');
ok(kw.includes('fun weeklyChart'), 'weeklyChart 畫柱狀 bitmap');
ok(kw.includes('drawRoundRect') && kw.includes('ARGB_8888'), '柱狀圓角＋ARGB bitmap');
ok(kw.includes('Bitmap.createBitmap(bw, bh') || kw.includes('Bitmap.createBitmap'), 'chart 固定畫布（封包 <1MB）');
ok(kw.includes('本週 ${sum} 次'), '週總計 caption');
ok(!kw.includes('c.mode') && !kw.includes('mode == "word"'), 'widgetMode 判定已移除');
ok(kw.includes('goal_streak') && kw.includes('daily_goal'), '今日進度讀 goal_streak');
// 間隔通知（1..1440 分）＋內容池隨機抽取
ok(kw.includes('notifyNextAt') && kw.includes('notifyIntervalMs'), 'notifyNextAt 排程（重入不重排計時）');
ok(kw.includes('coerceIn(1, 1440)'), '間隔 clamp 1..1440 分鐘');
ok(kw.includes('notifyPool') && kw.includes('Random.nextInt'), '內容池隨機抽一則');
ok(!kw.includes('notifyHour') && !kw.includes('nextNotifyAt'), '固定時刻（20:00）路徑已移除');

const kp = read(`${KDIR}/WidgetPlugin.kt`);
ok(kp.includes('@TauriPlugin'), 'WidgetPlugin @TauriPlugin');
for (const cmd of ['getStatus', 'saveConfig', 'refreshNow', 'requestPerms'])
  ok(kp.includes(`fun ${cmd}(`), `命令 ${cmd}`);
ok(kp.includes('parseArgs(SaveCfgArgs'), 'saveConfig 解析 SaveCfgArgs');
// 抽字額外欄位 transport（JS → SaveCfgArgs 字串 → Cfg List → prefs）
ok(kp.includes('var wordFields: String = ""'), 'SaveCfgArgs.wordFields（逗號字串 transport）');
ok(kp.includes('js.put("wordFields"'), 'statusJs 回傳 wordFields（設定頁回填）');
ok(kp.includes('args.wordFields.split(",")'), 'saveConfig 拆逗號 → List');
ok(kw.includes('putString("wordFields"'), 'saveCfg 寫入 wordFields prefs');

const kr = read(`${KDIR}/TenoWidgetReceiver.kt`);
ok(kr.includes('class TenoWidgetProviderBase : AppWidgetProvider()'), 'TenoWidgetProviderBase 繼承 AppWidgetProvider');
ok(kr.includes('class TenoStatusWidgetProvider : TenoWidgetProviderBase()'), 'TenoStatusWidgetProvider 為獨立 receiver');
ok(kr.includes('class TenoWordWidgetProvider : TenoWidgetProviderBase()'), 'TenoWordWidgetProvider 為獨立 receiver');
ok(kr.includes('class TenoWeeklyWidgetProvider : TenoWidgetProviderBase()'), 'TenoWeeklyWidgetProvider 為獨立 receiver');
ok(kr.includes('class TenoCaptureWidgetProvider : TenoWidgetProviderBase()'), 'TenoCaptureWidgetProvider 為獨立 receiver');
ok(kr.includes('TenoWeeklyWidgetProvider::class.java)') && kr.includes('cancelAlarms'), 'onDeleted 納入本週（鬧鐘存廢判定）');
ok(kr.includes('class TenoRefreshReceiver : BroadcastReceiver()'), 'TenoRefreshReceiver 繼承 BroadcastReceiver');
ok(kr.includes('ACTION_BOOT_COMPLETED'), 'BOOT 重武裝');
ok(kr.includes('goAsync()'), 'receiver 背景緒執行');

const ma = read(`${KDIR}/MainActivity.kt`);
ok(ma.includes('onNewIntent'), 'MainActivity.onNewIntent 接暖路徑');
ok(ma.includes('readRoute'), 'MainActivity.readRoute 消費 extras');
ok(ma.includes('pendingRoute') && ma.includes('flushTick'), 'pendingRoute＋flushTick 重試');
ok(ma.includes('window.__widgetRoute'), '推送 window.__widgetRoute');
ok(ma.includes("== \"1\"") || ma.includes("== \"1\""), 'JS 回 1 才清 pending');
ok(ma.includes('removeExtra'), '送達後 removeExtra（重建不重放）');

const ks = read(`${KDIR}/TenoResidentService.kt`);
ok(ks.includes('startForeground('), '常駐服務 startForeground');
ok(ks.includes('periodMs'), '常駐刷新間隔 = 抽字間隔');

// ── 3) res ──
console.log('── 3) res ──');
const RES = 'src-tauri/gen/android/app/src/main/res';
for (const f of ['layout/widget_status.xml', 'layout/widget_word.xml',
  'layout/widget_weekly.xml', 'layout/widget_capture.xml',
  'xml/teno_widget_info_status.xml', 'xml/teno_widget_info_word.xml',
  'xml/teno_widget_info_weekly.xml', 'xml/teno_widget_info_capture.xml',
  'drawable/widget_bg.xml', 'drawable/widget_bar.xml', 'drawable/ic_refresh.xml',
  'drawable/ic_stat_teno.xml'])
  ok(exists(`${RES}/${f}`), `res ${f} 存在`);
ok(!exists(`${RES}/xml/teno_widget_info.xml`), '舊 xml/teno_widget_info.xml 已移除');
const ws = read(`${RES}/layout/widget_status.xml`);
for (const id of ['wsBg', 'wsTitle', 'wsGoal', 'wsNewNum', 'wsLearnNum', 'wsReviewNum', 'wsBar', 'wsTrack', 'wsFill'])
  ok(ws.includes(`@+id/${id}`), `狀態 layout 有 ${id}`);
const ww = read(`${RES}/layout/widget_word.xml`);
for (const id of ['wgBg', 'wwWord', 'wwRefresh', 'wwMeta', 'wwDef', 'wwEx', 'wwExtra'])
  ok(ww.includes(`@+id/${id}`), `抽字 layout 有 ${id}`);
const wk = read(`${RES}/layout/widget_weekly.xml`);
for (const id of ['widgetRoot', 'wkBg', 'wkTitle', 'wkChart', 'wkCaption'])
  ok(wk.includes(`@+id/${id}`), `本週 layout 有 ${id}`);
const wc = read(`${RES}/layout/widget_capture.xml`);
for (const id of ['widgetRoot', 'wcBg', 'wcPlus', 'wcLabel'])
  ok(wc.includes(`@+id/${id}`), `收詞 layout 有 ${id}`);
const infoK = read(`${RES}/xml/teno_widget_info_weekly.xml`);
ok(infoK.includes('android:updatePeriodMillis="0"'), 'weekly provider 自管刷新（updatePeriod=0）');
ok(infoK.includes('android:initialLayout="@layout/widget_weekly"'), 'weekly provider initialLayout');
const infoC = read(`${RES}/xml/teno_widget_info_capture.xml`);
ok(infoC.includes('android:updatePeriodMillis="0"'), 'capture provider 自管刷新（updatePeriod=0）');
ok(infoC.includes('android:initialLayout="@layout/widget_capture"'), 'capture provider initialLayout');
const str = read(`${RES}/values/strings.xml`);
ok(str.includes('widget_label_weekly') && str.includes('widget_label_capture'), 'strings 新 widget 標籤');
ok(str.includes('widget_desc_weekly') && str.includes('widget_desc_capture'), 'strings 新 widget 描述');

const infoS = read(`${RES}/xml/teno_widget_info_status.xml`);
ok(infoS.includes('android:updatePeriodMillis="0"'), 'status provider 自管刷新（updatePeriod=0）');
ok(infoS.includes('android:initialLayout="@layout/widget_status"'), 'status provider initialLayout');
const infoW = read(`${RES}/xml/teno_widget_info_word.xml`);
ok(infoW.includes('android:updatePeriodMillis="0"'), 'word provider 自管刷新（updatePeriod=0）');
ok(infoW.includes('android:initialLayout="@layout/widget_word"'), 'word provider initialLayout');
// 選擇畫面預覽：缺 previewImage/previewLayout → OEM 只畫白底＋app icon（白底紅十字 bug）。
for (const [nm, ly] of [['status', 'widget_status'], ['word', 'widget_word'],
  ['weekly', 'widget_weekly'], ['capture', 'widget_capture']]) {
  const inf = read(`${RES}/xml/teno_widget_info_${nm}.xml`);
  ok(inf.includes(`android:previewLayout="@layout/${ly}"`), `${nm} provider previewLayout`);
  ok(inf.includes(`android:previewImage="@drawable/widget_preview_${nm}"`), `${nm} provider previewImage`);
  ok(exists(`${RES}/drawable/widget_preview_${nm}.xml`), `res drawable/widget_preview_${nm}.xml 存在`);
}
ok(read(`${RES}/values/strings.xml`).includes('widget_desc'), 'widget 描述字串');

// ── 4) Rust ──
console.log('── 4) Rust ──');
const rs = read('src-tauri/src/widget_android.rs');
ok(rs.includes('register_android_plugin(PLUGIN_IDENTIFIER, "WidgetPlugin")'), '註冊 WidgetPlugin');
for (const c of ['widget_get_status', 'widget_save_config', 'widget_refresh', 'widget_request_perms'])
  ok(rs.includes(`pub async fn ${c}`), `Rust 命令 ${c}`);
const lib = read('src-tauri/src/lib.rs');
ok(lib.includes('mod widget_android;'), 'lib.rs mod widget_android');
ok(lib.includes('.plugin(widget_android::init())'), 'lib.rs .plugin(widget_android::init())');
for (const c of ['widget_get_status', 'widget_save_config', 'widget_refresh', 'widget_request_perms'])
  ok(lib.includes(`widget_android::${c}`), `generate_handler ${c}`);

// ── 5) JS ──
console.log('── 5) JS ──');
const api = read('src/lib/api.js');
for (const c of ['widgetGetStatus', 'widgetSaveConfig', 'widgetRefresh', 'widgetRequestPerms'])
  ok(api.includes(`export const ${c} `) || api.includes(`export const ${c}=`), `api.js ${c}`);
const st = settingsSrc();
ok(st.includes('桌面 Widget</div>') || st.includes('} 桌面 Widget'), 'settings Widget 區塊標題');
ok(st.includes('提醒通知'), 'settings 通知區塊標題（與 Widget 分家）');
for (const id of ['widgetRotate', 'widgetNotifyOn', 'widgetNotifyInterval',
  'notifyContentDue', 'notifyContentWord', 'notifyContentGoal',
  'widgetResident', 'widgetRefreshBtn', 'widgetPermBtn', 'widgetPermStatus',
  'notifPermBtn', 'notifPermStatus'])
  ok(st.includes(`id="${id}"`), `settings #${id}`);
// 抽字額外欄位開關（JS ↔ Kotlin WORD_FIELD_LABEL 白名單同 key）
for (const f of ['syllables', 'deck', 'related', 'forms', 'synonym', 'antonym'])
  ok(st.includes(`widgetField${f[0].toUpperCase()}${f.slice(1)}`), `settings #widgetField${f[0].toUpperCase()}${f.slice(1)}`);
ok(st.includes('wordFields') && st.includes("st.wordFields"), 'settings wordFields 存／回填');
ok(!st.includes('id="widgetNotifyTime"') && !st.includes('id="widgetMode"'), '固定時刻／模式切換 UI 已移除');
ok(st.includes('widgetSaveConfig(collect())'), 'settings 變更即存');
ok(st.includes('isAndroid && isTauri') && /isAndroid && isTauri \? `[\s\S]*?桌面 Widget/.test(st), '區塊僅 Android App 顯示（瀏覽器版/桌機隱藏）');
ok(st.includes('widgetRequestPerms()'), 'settings 授權鈕');
const main = read('src/main.js');
ok((main.match(/invoke\('widget_refresh'\)/g) || []).length >= 2, 'main.js 開 App＋可見性推播');
ok(main.includes('window.__widgetRoute'), 'main.js 定義 __widgetRoute');
ok(main.includes("route === 'review'") && main.includes("navigate('study')"), 'review → study 複習頁');
ok(main.includes("{ type: 'add' }") && main.includes("{ type: 'word', id: arg }"), 'add／word → _pendingWidget');
ok(main.includes('_forceRender = true'), '字庫 self-nav 強制重渲染');
const brw = read('src/pages/browser.js');
ok(brw.includes('_pendingWidget'), 'browser 消費 _pendingWidget');
ok(brw.includes('openAddModal(s)') && brw.includes('openCardPreview(s, wAct.id)'), 'add → 新增 modal／word → 字卡預覽');

// ── 6) 口徑對拍：JS 鏡像 vs scheduler.getDueCards ──
console.log('── 6) 口徑對拍（鏡像 vs getDueCards）──');

// Kotlin nextDayAtMs 的 JS 移植（獨立實作，對拍 scheduler）
const mirrorNextDayAtMs = (dayCutoff, tz, now) => {
  const cutoff = dayCutoff > 0 ? dayCutoff : 0;
  const d = new Date(now + tz * 60000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const todayRoll = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    Math.floor(cutoff / 60), cutoff % 60);
  const next = mins < cutoff ? todayRoll : todayRoll + 86400000;
  return next - tz * 60000;
};

// nextDayAtMs 對拍（多時間點 × cutoff × tz）
{
  let all = true;
  for (const tz of [0, 480, -300, 330]) {
    for (const cutoff of [0, 480, 120, 600]) {
      for (const now of [Date.UTC(2026, 8, 30, 0, 0), Date.UTC(2026, 8, 30, 7, 59),
        Date.UTC(2026, 8, 30, 8, 0), Date.UTC(2026, 8, 30, 23, 30),
        Date.UTC(2026, 11, 31, 15, 0)]) {
        if (mirrorNextDayAtMs(cutoff, tz, now) !== schedNextDayAtMs(cutoff, tz, now)) all = false;
      }
    }
  }
  ok(all, 'nextDayAtMs 鏡像 = scheduler.nextDayAtMs（4 tz × 4 cutoff × 5 時點）');
}

// Kotlin readCounts 的 JS 移植
function mirrorCounts({ words, cards, buried, suspended, dayCutoff, tz, cardsPerDay, simMax, ratedRows, now }) {
  const boundary = mirrorNextDayAtMs(dayCutoff, tz, now);
  const dayStartIso = new Date(boundary - 86400000).toISOString();
  const ratedNew = ratedRows.filter(r => r.card_state === 0 && r.mode === 'flip'
    && r.reviewed_at >= dayStartIso).length;
  const bSet = new Set(buried), sSet = new Set(suspended);
  let newQ = 0, learn = 0, review = 0;
  for (const w of words) {
    if (bSet.has(w.id) || sSet.has(w.id)) continue;
    const card = cards.get(w.id);
    if (!card || card.state === 0) { newQ++; continue; }
    if (!card.due) continue;
    const dueMs = Date.parse(card.due);
    if (Number.isNaN(dueMs) || dueMs >= boundary) continue;
    if (card.state === 2) review++; else learn++;
  }
  if (simMax > 0 && simMax < review) review = simMax;
  let nt = ratedNew > 0 ? ratedNew : 0, added = 0;
  while (added < newQ && nt < cardsPerDay) { nt++; added++; }
  return { newQ, learn, review, ratedNew, newToday: added, boundary };
}

const NOW = Date.UTC(2026, 8, 30, 12, 0);      // 2026-09-30 12:00 UTC
const TZ = 480;                                 // UTC+8
const CUTOFF = 480;                             // teno 日界線 08:00
const B = mirrorNextDayAtMs(CUTOFF, TZ, NOW);   // 下一個日界線
const iso = (ms) => new Date(ms).toISOString();

// 夾具：新2 / 學2 / 復2（simMax=1 → 截1）／buried、suspended 排除／未來 due 排除
const words = [
  { id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }, { id: 'w5' },
  { id: 'w6' }, { id: 'w7' }, { id: 'w8' }, { id: 'w9' }, { id: 'w10' }, { id: 'w11' },
];
const cards = new Map([
  ['w2', { state: 0, due: iso(NOW - 1000), reps: 0 }],
  ['w3', { state: 1, due: iso(B - 3600000), reps: 0 }],     // 學：界線前 1h
  ['w4', { state: 1, due: iso(B), reps: 0 }],                // 學但 due=界線 → 不算今天
  ['w5', { state: 2, due: iso(NOW - 3 * 86400000), reps: 0 }], // 復：逾期
  ['w6', { state: 2, due: iso(NOW + 2 * 86400000), reps: 0 }], // 復：未到
  ['w7', { state: 3, due: iso(NOW - 60000), reps: 0 }],      // 學（relearning）
  ['w8', { state: 1, due: iso(NOW - 60000), reps: 0 }],      // buried → 排除
  ['w9', { state: 2, due: iso(NOW - 60000), reps: 0 }],      // suspended → 排除
  ['w10', { state: 2, due: iso(NOW - 86400000), reps: 0 }],  // 復（第二張，受 simMax 截）
  ['w11', { state: 0, due: iso(NOW), reps: 0 }],             // 新＋buried → 排除
]);
const buried = ['w8', 'w11'], suspended = ['w9'];
const ratedRows = [{ card_state: 0, mode: 'flip', reviewed_at: iso(B - 86400000 + 60000) }];

const base = {
  words, cards, buried, suspended, dayCutoff: CUTOFF, tz: TZ,
  cardsPerDay: 5, simMax: 1, ratedRows, now: NOW,
};
const m = mirrorCounts(base);

// 對拍 countsOnly 路徑（getDueCards 同參）
const due = getDueCards(words, cards, new Set(buried), new Set(suspended),
  5, CUTOFF, TZ, m.ratedNew, NOW, 1, true);

ok(m.newQ === 2, `新佇列=2（實際 ${m.newQ}）`);
ok(m.learn === 2, `學=2：w3+w7、w4 界線上不算（實際 ${m.learn}）`);
ok(m.review === 1, `復=1：w5+w10 受 simMax=1 截（實際 ${m.review}）`);
ok(m.newToday === 2, `新今日=2（實際 ${m.newToday}）`);
ok(due.count === m.learn + m.review + m.newToday,
  `countsOnly.count ${due.count} = 鏡像 學+復+新 ${m.learn + m.review + m.newToday}`);
ok(due.newCount === m.newToday, `getDueCards newCount ${due.newCount} = 鏡像 newToday ${m.newToday}`);

// 額度扣減：rated=3、額度5、新4 → 2；rated=7>5 → 0
{
  const r3 = mirrorCounts({ ...base, ratedRows: [{ card_state: 0, mode: 'flip', reviewed_at: iso(B - 1000) }] , cardsPerDay: 5 });
  ok(r3.ratedNew === 1, `rated（界線後 1 筆）=1（實際 ${r3.ratedNew}）`);
  const over = mirrorCounts({ ...base, cardsPerDay: 5, ratedRows: [
    ...Array.from({ length: 7 }, () => ({ card_state: 0, mode: 'flip', reviewed_at: iso(B - 1000) })),
  ]});
  ok(over.newToday === 0, `rated=7 > 額度5 → 新=0（實際 ${over.newToday}）`);
  const d = getDueCards(words, cards, new Set(buried), new Set(suspended),
    5, CUTOFF, TZ, over.ratedNew, NOW, 1, true);
  ok(d.newCount === over.newToday, `getDueCards 滿額 newCount ${d.newCount} = 鏡像 ${over.newToday}`);
}

// DB 缺失／invalid due（JS NaN 同口徑不計）
{
  const bad = mirrorCounts({ ...base, cards: new Map([['w5', { state: 2, due: 'garbage', reps: 0 }]]) });
  ok(bad.review === 0 && bad.learn === 0, 'invalid due 不計入（JS NaN 同口徑）');
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
