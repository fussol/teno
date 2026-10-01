#!/usr/bin/env node
// ═ VERIFY-PLUGIN-SEAM：題目頁插件入口接縫 ═
// 規則：入口宣告只在 src/lib/plugins.js 一處；main.js 的 PAGE_NAMES／SUBPAGE_PARENT
// 與 topics.js 的入口卡片都必須從它展開（不許再三處硬編碼）。
// 用法: node tools/verify-plugin-seam.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

let fail = 0, total = 0;
const ok = (label, cond, detail) => {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
};

const plug = read('src/lib/plugins.js');
const main = read('src/main.js');
const study = read('src/pages/study.js');
const topics = read('src/pages/topics.js');

const ids = [...plug.matchAll(/id:\s*'([a-z0-9-]+)'/g)].map(m => m[1]);
ok('plugins.js 匯出 PLUGINS', /export const PLUGINS\s*=/.test(plug));
ok('至少一個插件入口', ids.length > 0, `ids=${ids}`);
ok('SUBPAGE_PARENT 從 PLUGIN_PARENT 展開', /\.\.\.PLUGIN_PARENT/.test(main));
ok('PAGE_NAMES 從 PLUGINS 展開', /\.\.\.Object\.fromEntries\(PLUGINS\.map/.test(main));
ok('topics.js 卡片從 PLUGINS 展開', /PLUGINS\.map\(p => \(\{/.test(topics) && /pluginModes\.map/.test(topics));
ok('study.js 不再放插件卡片（入口只在題目頁）', !/PLUGINS/.test(study) && !/pluginModes/.test(study));
ok('main.js import plugins', /from '.\/lib\/plugins\.js'/.test(main));

for (const id of ids) {
  const f = `src/pages/${id}.js`;
  let src = '';
  try { src = read(f); } catch { ok(`頁面 ${f} 存在`, false); continue; }
  ok(`頁面 ${f} 存在`, true);
  ok(`${id}: export function render`, /export function render\(/.test(src));
  ok(`${id}: export function onMount`, /export function onMount\(/.test(src));
}

// ── 插件周邊：紀錄入 DB、雷達圖、錯題優先 ──
const dbSrc = read('src/lib/db.js');
const chartSrc = read('src/lib/chart.js');
ok('db.js 建 practice_log 表', /CREATE TABLE IF NOT EXISTS practice_log/.test(dbSrc));
ok('db.js 匯出 insertPractice/selectPractice', /export async function insertPractice/.test(dbSrc) && /export async function selectPractice/.test(dbSrc));
ok('chart.js 匯出 radarChart', /export function radarChart/.test(chartSrc));
ok('chart.js 雷達標籤夾回畫布（四字側軸標籤曾被 viewBox 裁掉）', /size - 2 - w/.test(chartSrc) && /2 \+ w/.test(chartSrc));
for (const id of ids) {
  if (id === 'gsat') continue;   // gsat 無五軸，僅需入紀錄
  const src = read(`src/pages/${id}.js`);
  ok(`${id}: 用 practice-log（入 DB）`, /practicelog\.js|practice-log\.js/.test(src.replace(/\s/g, '')) || /practice-log\.js/.test(src));
}
const g = read('src/pages/grammar.js');
const gs = read('src/pages/gsat.js');
const svgJs = read('src/lib/svg.js');
const css = read('src/styles/base.css');
ok('gsat: 5 大題正規化', /catOf\(/.test(gs) && /閱讀測驗/.test(gs));
ok('gsat: 錯題本＋單題重做', /wrongStats/.test(gs) && /data-retry/.test(gs));
ok('gsat: 統計 view（雷達/折線/復原率/配分）', /radarChart/.test(gs) && /復原率/.test(gs) && /YEAR_TOTAL/.test(gs));
ok('gsat: 存檔只進不出（清檔僅 clearProgress/放棄）', /if \(!paperActive \|\| !queue\.length\) return;/.test(gs) && !/function saveProgress[\s\S]{0,400}removeItem/.test(gs));
ok('gsat: 換新卷覆蓋存檔需 confirm（existingSave：未完成/報告都算）', /existingSave\(\)/.test(gs) && /開始新卷會覆蓋它/.test(gs));
ok('gsat: 題組一頁不分大題（文選/綜合/閱讀子題一起答一起批）', /if \(g && g\.n > 1\) return groupFillView\(q, g\)/.test(gs) && !/queue\[idx\]\?\.cat === '文意選填' && g/.test(gs));
ok('gsat: 整卷模考入口＋no 數值排序', /data-full/.test(gs) && /Number\(a\.no\) - Number\(b\.no\)/.test(gs));
ok('gsat: 選項庫 chips（文意選填 10 單字）', /length >= 10/.test(gs) && /flex-wrap:wrap/.test(gs));
ok('gsat: 中途退出進度存/還原/放棄', /saveProgress/.test(gs) && /restoreProgress/.test(gs) && /data-abandon/.test(gs));
ok('gsat: 進度入 DB settings（關 app 記得住）', /setSetting\(SET_KEY/.test(gs) && /getSetting\(SET_KEY/.test(gs));
ok('gsat: 題組一頁作答（groupFillView＋交卷＋整組跳題）', /groupFillView/.test(gs) && /data-gsubmit/.test(gs) && /idx \+= g && g\.n > 1 \? g\.n : 1/.test(gs));
ok('gsat v3: 同卷自動續作（無 data-resume 按鈕、同份不問 confirm）', /if \(await restoreProgress\(\)\)/.test(gs) && !/data-resume/.test(gs));
ok('gsat v3: 全答完才交卷（gradePaper＋data-submit＋無即時對答案）', /function gradePaper\(\)/.test(gs) && /data-submit/.test(gs) && /全部作答完成/.test(gs) && /先存答案，gsubmit\/交卷才判/.test(gs));
ok('gsat v3: 計時器（計/停/存進度/結果頁顯示）', /function timerMs\(\)/.test(gs) && /timerPause\(\)/.test(gs) && /id="paperTimer"/.test(gs) && /用時 \$\{fmtTimer/.test(gs) && /t: timerMs\(\)/.test(gs));
ok('gsat v3: 上/下一題自由導航（data-prev＋結果頁進度走 g:1）', /data-prev/.test(gs) && /g: graded/.test(gs));
ok('gsat v4: 下拉＝自訂浮層（無原生 select）', !/\<select/.test(gs) && /\.gsat-dd/.test(gs) && /data-v=/.test(gs));
ok('gsat v4: 累積式 passage 只顯示本段（不黏篇）', /function passageShown/.test(gs) && /passageShown\(start\)/.test(gs));
ok('gsat v4: 題號空位統一空格槽（1990s/4,000 不誤傷）', /function stemHtml/.test(gs) && /gsat-fill/.test(gs) && /\?<!\[/.test(gs));
ok('gsat v4: 快捷鍵（數字/字母/←→/Enter/Esc＋實例守門）', /function onKey/.test(gs) && /isMine\(\)/.test(gs) && /ArrowLeft/.test(gs) && /Escape/.test(gs));
ok('gsat v4: 碼錶 SVG（icon clock＋不重疊 inline-flex）', /icon\('clock'/.test(gs) && /gsat-timer/.test(gs) && !/⏱/.test(gs));
ok('gsat v5: 題組字母直填（開著浮層→選值；否則第一個未填空）', /否則填第一個未填空/.test(gs) && /data-v="\$\{letter\}"/.test(gs));
ok('gsat v5: 中譯英自動 focus＋Ctrl/Cmd+Enter 送出', /中譯英頁進場自動 focus/.test(gs) && /trTi\.focus\(\)/.test(gs) && /ctrlKey \|\| e\.metaKey/.test(gs) && /\$\{keyHintTr\}/.test(gs));
ok('svg: icon(px) 屬性自帶尺寸（CSS 缺失時防 300×150 壓字）', /html\.replace\('<svg '/.test(svgJs) && /width="\$\{px\}"/.test(svgJs));
ok('gsat v6: tr 草稿 per-qid（換題回頭不丟，無單值 trText）', /const drafts = \{\}/.test(gs) && /drafts\[ti\.dataset\.qid\]/.test(gs) && !/\btrText\b/.test(gs));
ok('gsat v6: 報告 pending/error 分流＋error 不計配分', /trErr/.test(gs) && /批改失敗（見下方批改卡/.test(gs) && /\(trPending\(q\) \|\| trErr\(q\)\)/.test(gs));
ok('gsat v6: document listener 模組只綁一次（不隨 onMount 累積）', /let docBound = false/.test(gs) && /if \(docBound\) return/.test(gs));
ok('gsat v6: 浮層右錨（手機不右溢出視窗）', /\.gsat-dd-menu\{[^}]*right:0;left:auto/.test(css) && /max-width:min\(300px,calc\(100vw - 48px\)\)/.test(css));
ok('gsat: 填空類題幹必有底線記號（102 年 import 曾整批丟空格）', (() => {
  const bad = read('public/packs/gsat/gsat.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(q => q.type === 'mc' && /詞彙|成語|填充|單字/.test(q.section || '') && !q.stem.includes('_'));
  return bad.length === 0;
})());
ok('gsat: 錯題本弱點分析（密度/弱文章/釘子）', /weaknessBlock/.test(gs) && /錯題密度/.test(gs) && /釘子/.test(gs));
for (const id of ids) {
  const src = read(`src/pages/${id}.js`);
  ok(`${id}: 窄容器置中（桌機不留半邊空）`, /margin-left:auto;margin-right:auto/.test(src));
}
ok('grammar: 無限題流（自動補題＋隱藏題號）', /extendQueue/.test(g) && !/\$\{idx \+ 1\}\/\$\{queue.length\}/.test(g));
ok('grammar: 背景批改＋結果視圖', /trGrades/.test(g) && /data-results/.test(g) && /grade-queue/.test(g));
ok('grammar: 出題主題顯示（SHAREPACK2：核心進 DB、topicOf 照舊）', /grammar_bank_core/.test(g) && /topicOf/.test(g));
const gsatTrPrompt = read('src/assets/gsat/gsat_tr_grading.md');
const gramTrPrompt = read('src/assets/grammar/translation_grading.md');
ok('批改輸出：訂正/修改建議/緣由（prompt 兩頁齊）', /corrected/.test(gsatTrPrompt) && /suggestions/.test(gsatTrPrompt) && /suggestions/.test(gramTrPrompt));
ok('批改卡：渲染訂正/建議/緣由（兩頁齊）', /訂正/.test(gs) && /suggestions/.test(gs) && /訂正/.test(g) && /suggestions/.test(g));
ok('grammar: 練習/錯題分開＋未出現優先（亂序）', /orderedPool/.test(g) && /data-src/.test(g) && /錯題練習/.test(g) && !/錯題優先：同模式的錯題先抽/.test(g));
ok('作答/批改記憶（兩頁 localStorage 持久化）', /saveTr/.test(g) && /trStore/.test(g) && /saveTr/.test(gs) && /trStore/.test(gs));
ok('輸入框防洗（重畫前先收值＋qid 守門）', /ti\.dataset\.qid/.test(g) && /ti\.dataset\.qid/.test(gs) && /data-qid/.test(g) && /data-qid/.test(gs));
ok('gsat 頁標記（背景批改不跨頁覆蓋）', /data-page="gsat"/.test(gs));
ok('診斷行已刪（messages 實證完畢）', !/\[fetchLLM\] msgs/.test(read('src/lib/api.js')));
ok('批改 JSON：共享 parser 補括號（三頁齊）', /parseLLMJson/.test(gs) && /parseLLMJson/.test(g) && /parseLLMJson/.test(read('src/pages/essay.js')) && /stack\.push/.test(read('src/lib/api.js')));
ok('gsat: 中譯英進題庫＋背景批改（SHAREPACK2：tr 由 setGsatBank 合入）', /bank\.tr \|\| \[\]/.test(gs) && /ggrade/.test(gs) && /TR_OFFICIAL/.test(gs));
ok('gsat: 作答函式齊（防區塊誤刪）', /function startPaper/.test(gs) && /function startSingle/.test(gs) && /function groupInfo/.test(gs) && /function gradePanel/.test(gs) && /let setSeq/.test(gs) && /const trGrades/.test(gs) && /role: 'user'/.test(gs));
ok('topics.js 三頁入口齊（plugins.js 展開）', ids.length >= 3, `ids=${ids}`);

// 題庫完整性：id 唯一、欄位齊、pattern 有標題（1-9 分裂句併入）
const qs = read('public/packs/grammar/questions.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
const titles = JSON.parse(read('public/packs/grammar/pattern_titles.json'));
const qids = new Set(qs.map(q => q.id));
ok('grammar 題庫：id 唯一且欄位齊', qids.size === qs.length && qs.every(q =>
  q.type === 'mc'
    ? (q.stem && q.options?.length === 4 && q.answer >= 0 && q.answer < 4 && q.explain)
    : (q.translation && q.reference && q.comment)) &&
  qs.every(q => titles[q.pattern]), `n=${qs.length}`);
ok('grammar 題庫：1-9 分裂句併入（含標題）', titles['1-9'] && qs.some(q => q.pattern === '1-9'));

// 題庫管理（工具頁出題/刪題 ↔ 文法頁合併）——覆蓋層雙端同一把鑰匙
const toolsJs = read('src/pages/tools.js');
ok('工具頁：文法題庫管理（AI 出題＋刪題）', /文法題庫管理/.test(toolsJs) && /bankGen/.test(toolsJs) && /bank-del/.test(toolsJs));
ok('工具頁：檢索列表可手動新增/修改（bankNew/bank-edit/bankSaveEdit）', /bankNew/.test(toolsJs) && /bank-edit/.test(toolsJs) && /bankSaveEdit/.test(toolsJs) && /bankEditOpen/.test(toolsJs));
ok('覆蓋層雙端：工具頁寫、文法頁讀（grammar_bank_overlay＋mergeBank）', /grammar_bank_overlay/.test(toolsJs) && /grammar_bank_overlay/.test(g) && /mergeBank/.test(g));
ok('出題入庫守門：validateQuestion＋nextQid（LLM 產物必過）', /validateQuestion\(/.test(toolsJs) && /nextQid\(/.test(toolsJs));
ok('bank.js 可執行（merge/validate/nextQid 自檢）', (() => {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert';
      import { mergeBank, validateQuestion, nextQid } from './src/lib/bank.js';
      const m = mergeBank([{id:'a'},{id:'b'}], { up: { b: {id:'b',x:1}, c: {id:'c'} }, rm: ['a'] });
      assert.deepEqual(m.map(q => q.id).sort(), ['b','c']);
      assert.equal(validateQuestion({type:'mc',stem:'s',options:[1,2,3,4],answer:1,explain:'e'}), null);
      assert.ok(validateQuestion({type:'mc',stem:'s',options:[1,2],answer:1,explain:'e'}));
      assert.ok(validateQuestion({type:'translate',translation:'中',reference:''}));
      assert.equal(nextQid([{id:'g-1-1-mc-4'},{id:'g-1-1-mc-9'}], '1-1', 'mc'), 'g-1-1-mc-10');
    `], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch { return false; }
})());

// gsat 結果頁要有放棄出口（還原到已完成卷時不能被卡住）
ok('gsat 進度：結果頁有放棄出口（resultView 內含 resumeBarHtml）', /function resultView\(\)[\s\S]*?resumeBarHtml\(\)/.test(gs));
// restore 內不可有 const results：遮蔽模組變數 → line "results=" 變常數賦值 TypeError → 還原永遠 false
ok('gsat 進度：restoreProgress 不遮蔽 results（曾致還原必敗）', !/const results/.test(gs));

console.log(`\n${total - fail}/${total} PASS`);
if (fail) process.exit(1);
