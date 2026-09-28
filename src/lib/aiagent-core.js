// Teno AI 助手核心：權限 gate 的工具迴圈（純模組——io/llm/parseJson 由呼叫端注入，不碰 tauri/vite）。
// 流程：buildToolList(僅暴露已開的) → runTurn 組 prompt → LLM 回 {"tool","args"} 則 execTool（再過 guard）→ 回灌 → 最多 maxRounds。
import { mergeBank, validateQuestion, nextQid } from './bank.js';
import { normPerms, can, guard, AI_PERMS_KEY } from './aiperms.js';

// 工具目錄：need = [類別, 動作]；未開的類別連名字都不會出現在 prompt（物理不可見）
export const TOOLS = {
  'bank.list':     { need: ['bank', 'r'], desc: '列出題庫全部題目，每行 id|type|pattern|題幹摘要' },
  'bank.add':      { need: ['bank', 'w'], desc: '新增/更新題目。args:{questions:[題目],ids?:[指定id,同順序]}，無 id 用 nextQid 自動配' },
  'bank.remove':   { need: ['bank', 'd'], desc: '刪除題目（含覆蓋層覆寫的）。args:{ids:[...]}' },
  'settings.get':  { need: ['settings', 'r'], desc: '讀單一設定值。args:{key}' },
  'settings.set':  { need: ['settings', 'w'], desc: '寫設定值。args:{key,value}（key=ai_perms 拒寫）' },
  'settings.clear':{ need: ['settings', 'd'], desc: '清設定回預設。args:{keys:[...]}' },
  'words.search':  { need: ['words', 'r'], desc: '搜單字庫。args:{q?,limit?}，回總數與前 N 筆' },
  'words.save':    { need: ['words', 'w'], desc: '存單字（upsert，缺 id 自動給）。args:{words:[{word,definition,...}]}' },
  'words.remove':  { need: ['words', 'd'], desc: '刪單字（含圖片）。args:{ids:[...]}' },
  // OCR 不設 need：讀的是「使用者自己 📎 交給聊天的圖」，不碰 App 資料，不受矩陣管；
  // 但僅在聊天中有圖片時才暴露（requiresImg），沒圖連名字都看不到。
  'ocr.last_image': { need: null, requiresImg: true, desc: 'OCR 聊天中最近 📎 附加的圖片回文字。args:{psm?:3(全頁)|6(單行)}' },
};

export function buildToolList(perms, ctx = {}) {
  return Object.fromEntries(
    Object.entries(TOOLS).filter(([name, t]) =>
      (!t.need || can(perms, t.need[0], t.need[1])) && (!t.requiresImg || ctx.hasImage))
  );
}

// io 契約：bankAll/getOverlay/saveOverlay/getSetting/setSetting/searchWords/saveWords/removeWords
export async function execTool(name, args = {}, perms, io) {
  const t = TOOLS[name];
  if (!t) throw new Error('ai-tool-unknown:' + name);
  if (t.need) guard(perms, t.need[0], t.need[1]); // 二道防線：buildToolList 漏了這裡也擋

  switch (name) {
    case 'bank.list': {
      const all = await io.bankAll();
      if (!all.length) return '(題庫空)';
      return all.map(q => `${q.id}|${q.type}|${q.pattern}|${String(q.stem || q.translation || '').slice(0, 40)}`).join('\n');
    }
    case 'bank.add': {
      const qs = Array.isArray(args.questions) ? args.questions : [];
      const ids = Array.isArray(args.ids) ? args.ids : [];
      if (!qs.length) throw new Error('缺 questions');
      const ok = [], bad = [];
      qs.forEach((it, i) => {
        if (!it || typeof it !== 'object') { bad.push(`#${i}:不是物件`); return; }
        const qpat = it.pattern || '1-1';
        const q = { ...it, type: it.type === 'translate' ? 'translate' : (it.type === 'mc' ? 'mc' : 'mc'),
          pattern: qpat, chapter: Number(qpat.split('-')[0]) || 1 };
        const err = validateQuestion(q);
        if (err) bad.push(`#${i}:${err}`); else ok.push({ q, id: ids[i] });
      });
      if (!ok.length) throw new Error('全部不合格：' + bad.join('；'));
      const all = await io.bankAll();
      const overlay = await io.getOverlay();
      let list = all;
      const written = [];
      for (const { q, id } of ok) {
        let finalId = id && all.some(x => x.id === id) ? id : nextQid(list, q.pattern, q.type === 'mc' ? 'mc' : 'tr');
        overlay.up[finalId] = { ...q, id: finalId };
        written.push(finalId);
        list = [...list, overlay.up[finalId]];
      }
      await io.saveOverlay(overlay);
      return `已寫入 ${written.length} 題：${written.join('、')}${bad.length ? `（不合格 ${bad.length}：${bad.join('；')}）` : ''}`;
    }
    case 'bank.remove': {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      if (!ids.length) throw new Error('缺 ids');
      const all = await io.bankAll();
      const have = new Set(all.map(q => q.id));
      const overlay = await io.getOverlay();
      const done = [];
      for (const id of ids) {
        if (!have.has(id)) continue;
        if (id in overlay.up) delete overlay.up[id];
        if (!overlay.rm.includes(id)) overlay.rm.push(id);
        done.push(id);
      }
      if (!done.length) return '沒有符合的 id';
      await io.saveOverlay(overlay);
      return `已刪 ${done.length} 題：${done.join('、')}`;
    }
    case 'settings.get': {
      if (!args.key) throw new Error('缺 key');
      const v = await io.getSetting(args.key);
      return `${args.key} = ${JSON.stringify(v)}`;
    }
    case 'settings.set': {
      if (!args.key) throw new Error('缺 key');
      if (args.key === AI_PERMS_KEY) throw new Error('ai-perm-denied:ai_perms 不可由 AI 寫（防自我授權）');
      await io.setSetting(args.key, args.value === undefined ? null : args.value);
      return `已設 ${args.key}`;
    }
    case 'settings.clear': {
      const keys = Array.isArray(args.keys) ? args.keys : (args.key ? [args.key] : []);
      if (!keys.length) throw new Error('缺 keys');
      for (const k of keys) {
        if (k === AI_PERMS_KEY) throw new Error('ai-perm-denied:ai_perms 不可由 AI 寫（防自我授權）');
        await io.setSetting(k, null);
      }
      return '已清（回預設）：' + keys.join('、');
    }
    case 'words.search': {
      const { total, rows } = await io.searchWords(String(args.q || ''), Math.min(Number(args.limit) || 20, 50));
      const head = `共 ${total} 詞，符合 ${rows.length} 筆`;
      if (!rows.length) return head;
      return head + '：\n' + rows.map(w => `${w.id}|${w.word}|${String(w.definition || '').slice(0, 30)}`).join('\n');
    }
    case 'words.save': {
      const ws = Array.isArray(args.words) ? args.words : [];
      if (!ws.length) throw new Error('缺 words');
      if (ws.some(w => !w || !w.word)) throw new Error('每筆需 word 欄位');
      const n = await io.saveWords(ws);
      return `已存 ${n} 詞（重開頁面生效）`;
    }
    case 'words.remove': {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      if (!ids.length) throw new Error('缺 ids');
      const n = await io.removeWords(ids);
      return `已刪 ${n} 詞`;
    }
    case 'ocr.last_image': {
      const text = String(await io.ocrLastImage(args || {}));
      return text.trim() || '(OCR 無文字)';
    }
    default:
      throw new Error('ai-tool-unknown:' + name);
  }
}

// 一輪對話（可多工具）。deps: { perms, io, llm(prompt)->text, parseJson(text,key), maxRounds? }
// history 會被就地追加（user/tool/assistant 軌跡），呼叫端保留全量、prompt 只帶最近 slice。
export async function runTurn(history, deps) {
  const { perms, io, llm, parseJson, maxRounds = 4, ctx = {} } = deps;
  const tools = buildToolList(normPerms(perms), ctx);
  const names = Object.keys(tools);
  const sys = [
    '你是 Teno App 的操作助理。使用者的資料（題庫/設定/單字庫）只能透過工具取得，不要憑空捏造其內容。',
    names.length
      ? '可用工具（要執行就只回一段 JSON：{"tool":"工具名","args":{...}}，一次一個）：\n' +
        names.map(n => `- ${n}: ${tools[n].desc}`).join('\n')
      : '目前沒有任何可用工具（使用者把 AI 權限全關了）。不要假裝能讀寫資料，直接用中文回覆。',
    '不需工具就直接回覆中文；需工具就只回 JSON（可包 ```json 區塊），執行結果會餵回來讓你繼續。',
  ].join('\n');
  const recent = history.slice(-12);
  let transcript = recent.map(m => `${m.role === 'user' ? '使用者' : '助理'}：${m.content}`).join('\n');

  for (let round = 0; round < maxRounds; round++) {
    const text = String(await llm(`${sys}\n\n${transcript}\n\n助理：`)).trim();
    const raw = names.length ? parseJson(text, 'tool') : null;
    if (raw && raw.tool) {
      let result;
      try { result = await execTool(String(raw.tool), raw.args || {}, perms, io); }
      catch (e) { result = '執行失敗：' + (e?.message || e); }
      history.push({ role: 'tool', content: `${raw.tool} → ${result}` });
      transcript += `\n助理：${JSON.stringify({ tool: raw.tool, args: raw.args })}\n工具結果：${result}`;
      continue;
    }
    history.push({ role: 'assistant', content: text || '（空回應）' });
    return history;
  }
  history.push({ role: 'assistant', content: '（已達工具輪次上限，先停）' });
  return history;
}
