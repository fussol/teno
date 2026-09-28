#!/usr/bin/env node
// ═ VERIFY-AIPERM：AI 助手權限矩陣（AIPERM1） ═
// 設計：逐類別 bank/settings/words × 讀寫刪，預設全關 fail-closed；
//       未開＝工具不暴露（buildToolList）＋寫入硬擋（execTool guard 二道防線）＋ai_perms 拒寫防自我授權。
// 用法: node tools/verify-aiperm.mjs
import { normPerms, defaultPerms, can, guard, AI_CATS, AI_PERMS_KEY } from '../src/lib/aiperms.js';
import { buildToolList, execTool, runTurn, TOOLS } from '../src/lib/aiagent-core.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/pages/tools.js'), 'utf8');

let fail = 0, total = 0;
const ok = (label, cond, detail) => {
  total++;
  if (!cond) { fail++; console.log(`FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
  else console.log(`PASS ${label}`);
};
const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e?.message || String(e); } };

const P = (o) => normPerms(o);
const ALL = P({ bank: { r: true, w: true, d: true }, settings: { r: true, w: true, d: true }, words: { r: true, w: true, d: true } });
const KEY = AI_PERMS_KEY;

function mkIo() {
  const overlay = { up: {}, rm: [] };
  const base = [
    { id: 'g-1-1-mc-1', type: 'mc', pattern: '1-1', stem: 'I ___ go.', options: ['a', 'b', 'c', 'd'], answer: 0, explain: 'x', difficulty: 1 },
    { id: 'g-1-1-tr-1', type: 'translate', pattern: '1-1', translation: '我喜歡', reference: 'I like', comment: 'c' },
  ];
  const settings = { llmModel: 'qwen' };
  const calls = { saveOverlay: 0, saveWords: 0, removeWords: 0, bankAll: 0 };
  return {
    calls, overlay, settings,
    bankAll: async () => {
      calls.bankAll++;
      return [...base.filter(q => !overlay.rm.includes(q.id) && !(q.id in overlay.up)), ...Object.values(overlay.up)];
    },
    getOverlay: async () => ({ up: { ...overlay.up }, rm: [...overlay.rm] }),
    saveOverlay: async (nv) => { calls.saveOverlay++; overlay.up = { ...nv.up }; overlay.rm = [...nv.rm]; },
    getSetting: async (k) => (k in settings ? settings[k] : null),
    setSetting: async (k, v) => { settings[k] = v; },
    searchWords: async (q, limit) => ({ total: 2, rows: [{ id: 'w_1', word: 'hello', definition: '你好' }].slice(0, limit) }),
    saveWords: async (ws) => { calls.saveWords += ws.length; return ws.length; },
    removeWords: async (ids) => { calls.removeWords += ids.length; return ids.length; },
    ocrLastImage: async () => 'OCR文字 HELLO',
  };
}
const GOOD_MC = { type: 'mc', pattern: '1-1', stem: 'She ___ tall.', options: ['is', 'are', 'am', 'be'], answer: 0, explain: '三單', difficulty: 1 };
const parseJson = (t) => {
  const cands = [];
  const b = String(t).match(/```json\s*([\s\S]*?)\s*```/);
  if (b) cands.push(b[1]);
  const s = String(t).indexOf('{"tool"');
  if (s !== -1) cands.push(String(t).slice(s).replace(/\s*`+\s*$/, ''));
  for (const c of cands) { try { return JSON.parse(c.trim()); } catch {} }
  return null;
};

// ── 預設與 fail-closed ──
ok('預設全關：3 類 × 9 格全 false', AI_CATS.every(c => ['r', 'w', 'd'].every(a => defaultPerms()[c][a] === false)));
ok('normPerms(null)/垃圾 → 全關', [null, undefined, 42, 'x', [], { bank: 'x' }].every(v => {
  const p = normPerms(v); return AI_CATS.every(c => ['r', 'w', 'd'].every(a => p[c][a] === false));
}));
ok('normPerms 部分開啟保留、多餘欄位剔除', (() => {
  const p = normPerms({ bank: { r: true, w: 2 }, evil: { r: true }, settings: { d: true } });
  return p.bank.r === true && p.bank.w === false && p.settings.d === true && !('evil' in p) && p.words.r === false;
})());
ok('can/guard：未開即 throw ai-perm-denied', (() => {
  const p = defaultPerms();
  if (can(p, 'bank', 'r')) return false;
  const m = (() => { try { guard(p, 'bank', 'r'); return ''; } catch (e) { return e.message; } })();
  return m === 'ai-perm-denied:bank.r';
})());

// ── 工具暴露 gate ──
ok('buildToolList：預設 0 工具（物理不暴露）', Object.keys(buildToolList(defaultPerms())).length === 0);
ok('buildToolList：只開 bank.r → 只有 bank.list', (() => {
  const t = Object.keys(buildToolList(P({ bank: { r: true } })));
  return t.length === 1 && t[0] === 'bank.list';
})());
ok('buildToolList：全開＋有圖 → 10 工具、全在 TOOLS', Object.keys(buildToolList(ALL, { hasImage: true })).length === Object.keys(TOOLS).length);

// ── 寫入點硬擋（二道防線） ──
ok('execTool：w 未開 bank.add 直接拒', (await throws(() => execTool('bank.add', { questions: [GOOD_MC] }, defaultPerms(), mkIo())))?.startsWith('ai-perm-denied:bank.w') === true);
ok('execTool：r 未開 bank.list 直接拒', (await throws(() => execTool('bank.list', {}, defaultPerms(), mkIo())))?.startsWith('ai-perm-denied:bank.r') === true);
ok('execTool：settings.w 全開仍拒寫 ai_perms（防自我授權）', (await throws(() => execTool('settings.set', { key: KEY, value: { bank: { r: true, w: true, d: true } } }, ALL, mkIo())))?.includes('ai-perm-denied') === true);
ok('execTool：settings.d 全開仍拒清 ai_perms', (await throws(() => execTool('settings.clear', { keys: [KEY] }, ALL, mkIo())))?.includes('ai-perm-denied') === true);
ok('execTool：未知工具拒', (await throws(() => execTool('rm_rf', {}, ALL, mkIo())))?.includes('ai-tool-unknown') === true);

// ── bank 寫入行為 ──
{
  const io = mkIo();
  const msg = await execTool('bank.add', { questions: [GOOD_MC] }, ALL, io);
  ok('bank.add：nextQid 自動配 id（g-1-1-mc-2）', 'g-1-1-mc-2' in io.overlay.up && msg.includes('g-1-1-mc-2'));
  ok('bank.add：指定既有 id＝更新覆蓋', (await execTool('bank.add', { questions: [{ ...GOOD_MC, stem: 'updated' }], ids: ['g-1-1-mc-1'] }, ALL, io), io.overlay.up['g-1-1-mc-1']?.stem === 'updated'));
  ok('bank.add：不合格題丟棄並回報', (await throws(() => execTool('bank.add', { questions: [{ type: 'mc', pattern: '1-1', stem: 'x' }] }, ALL, io)))?.includes('不合格') === true);
  const io2 = mkIo();
  const rmMsg = await execTool('bank.remove', { ids: ['g-1-1-mc-1', 'nope'] }, ALL, io2);
  ok('bank.remove：主本 id 進 rm、未知 id 跳過', io2.overlay.rm.length === 1 && io2.overlay.rm[0] === 'g-1-1-mc-1' && rmMsg.includes('已刪 1 題'));
  const io3 = mkIo();
  const noneMsg = await execTool('bank.remove', { ids: ['nope'] }, ALL, io3);
  ok('bank.remove：全不中 → 不落庫', noneMsg === '沒有符合的 id' && io3.calls.saveOverlay === 0);
}
// ── settings / words ──
{
  const io = mkIo();
  await execTool('settings.set', { key: 'llmModel', value: 'qwen2.5:32b' }, ALL, io);
  ok('settings.set：一般 key 可寫', io.settings.llmModel === 'qwen2.5:32b');
  const getMsg = await execTool('settings.get', { key: 'llmModel' }, ALL, io);
  ok('settings.get：讀回值', getMsg.includes('qwen2.5:32b'));
  await execTool('settings.clear', { keys: ['llmModel'] }, ALL, io);
  ok('settings.clear：回預設（null）', io.settings.llmModel === null);
  ok('words.save：缺 word 整批拒', (await throws(() => execTool('words.save', { words: [{ word: 'cat' }, { noWord: 1 }] }, ALL, io)))?.includes('word') === true && io.calls.saveWords === 0);
  await execTool('words.save', { words: [{ word: 'cat' }, { word: 'dog' }] }, ALL, io);
  ok('words.save：合法批次計數', io.calls.saveWords === 2);
  const sMsg = await execTool('words.search', { q: 'hello' }, ALL, io);
  ok('words.search：回總數與列', sMsg.includes('共 2 詞') && sMsg.includes('hello'));
  await execTool('words.remove', { ids: ['w_1'] }, ALL, io);
  ok('words.remove：計數回傳', io.calls.removeWords === 1);
}

// ── runTurn 迴圈 ──
{
  const io = mkIo();
  const prompts = [];
  let step = 0;
  const llm = async (p) => { prompts.push(p); return ++step === 1 ? '```json\n{"tool":"bank.list","args":{}}\n```' : '題庫目前 2 題。'; };
  const h = [{ role: 'user', content: '分析題庫' }];
  await runTurn(h, { perms: P({ bank: { r: true } }), io, llm, parseJson });
  ok('runTurn：工具輪 → 執行 → 回灌 → 最終中文回覆', h.length === 3 && h[0].role === 'user' && h[1].role === 'tool' && h[1].content.includes('g-1-1-mc-1') && h[2].role === 'assistant' && h[2].content.includes('2 題'));
  ok('runTurn：工具結果有進下一次 prompt', prompts.length === 2 && prompts[1].includes('g-1-1-mc-1'));
}
{
  const io = mkIo();
  const prompts = [];
  const h = [{ role: 'user', content: '幫我分析題庫' }];
  await runTurn(h, { perms: defaultPerms(), io, llm: async (p) => { prompts.push(p); return '好的'; }, parseJson });
  ok('runTurn：權限全關 → prompt 不暴露任何工具名（物理不可見）', prompts.length === 1 && !Object.keys(TOOLS).some(n => prompts[0].includes(n)) && prompts[0].includes('沒有任何可用工具'));
  ok('runTurn：全關也把資料藏起來（bankAll 沒被叫）', io.calls.bankAll === 0 && h[1].role === 'assistant');
}
{
  const io = mkIo();
  const prompts = [];
  await runTurn([], { perms: P({ bank: { r: true } }), io, llm: async (p) => { prompts.push(p); return 'hi'; }, parseJson });
  const p = prompts[0];
  ok('runTurn：只開 bank.r → 只見 bank.list', p.includes('bank.list:') && !p.includes('settings.get:') && !p.includes('bank.remove:') && !p.includes('words.search:'));
}
{
  const io = mkIo();
  let n = 0;
  const h = [];
  await runTurn(h, { perms: ALL, io, llm: async () => { n++; return '{"tool":"bank.list","args":{}}'; }, parseJson });
  ok('runTurn：永吐工具 → 有輪次上限（≤4 次 LLM＋停訊息）', n === 4 && h.at(-1).role === 'assistant' && h.at(-1).content.includes('輪次上限'));
}
{
  const io = mkIo();
  const h = [];
  await runTurn([{ role: 'user', content: '刪 g-1-1-mc-1' }], { perms: P({ bank: { d: true } }), io, llm: async () => '{"tool":"bank.remove","args":{"ids":["g-1-1-mc-1"]}}', parseJson });
  ok('runTurn：r 未開但 d 開 → 可刪（d 獨立授予）', io.overlay.rm.includes('g-1-1-mc-1'));
  const h2 = [];
  const t2 = await runTurn([{ role: 'user', content: '刪' }], { perms: P({ bank: { r: true } }), io, llm: async () => '{"tool":"bank.remove","args":{"ids":["g-1-1-tr-1"]}}', parseJson });
  ok('runTurn：d 未開 → 工具回「執行失敗」不落庫', h2.length === 0 && t2[1].content.includes('ai-perm-denied') && !io.overlay.rm.includes('g-1-1-tr-1'));
}

// ── OCR 工具（OCR1）：僅附圖暴露、免權限（讀使用者自己給的圖，不碰 App 資料）──
ok('OCR 工具：未附圖不暴露（連名字都看不到）', !('ocr.last_image' in buildToolList(defaultPerms(), {})) && !('ocr.last_image' in buildToolList(ALL)));
ok('OCR 工具：附圖即暴露且免任何權限', Object.keys(buildToolList(defaultPerms(), { hasImage: true })).join() === 'ocr.last_image');
ok('OCR 工具：有圖 → 回文字（免權限）', (await execTool('ocr.last_image', {}, defaultPerms(), mkIo())) === 'OCR文字 HELLO');
ok('OCR 工具：io 未附圖 → 明確錯誤', (await throws(() => execTool('ocr.last_image', {}, defaultPerms(), { ocrLastImage: async () => { throw new Error('沒有可 OCR 的圖片'); } })))?.includes('沒有可 OCR') === true);

// ── 附件上傳（ATT1）：全格式 → 文字直讀／圖給 OCR／其他「無法讀取」 ──
ok('附件：file input 全格式（無 accept 白名單）', /<input type="file" id="aiChatFile" style="display:none">/.test(toolsSrc) && !/id="aiChatFile"[^>]*\saccept=/.test(toolsSrc));
ok('附件：圖片 magic bytes 分流 → aiLastImage 存檔', toolsSrc.includes('aiLastImage = f') && toolsSrc.includes('0x89') && toolsSrc.includes('0x57'));
ok('附件：非文字檔擋下並顯示「無法讀取」', toolsSrc.includes('無法讀取（此格式不支援') && toolsSrc.includes('fromCharCode(0)'));
ok('附件：2 萬字截斷防爆 context', toolsSrc.includes('> 20000') && toolsSrc.includes('已截斷'));
ok('附件：attach 鈕→file.click＋change 讀 arrayBuffer', toolsSrc.includes('aiChatAttach') && toolsSrc.includes('await f.arrayBuffer()'));
ok('OCR 接線：tools.js 動態 import engine＋ctx.hasImage 傳入 runTurn', toolsSrc.includes("import('../lib/ocr/engine.js')") && toolsSrc.includes('hasImage: !!aiLastImage'));

console.log(`\n${total - fail}/${total} PASS`);
process.exit(fail ? 1 : 0);
