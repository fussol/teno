// ═══════════════════════════════════════════════════════════════
// 韋氏官方 JSON 解析器（LOG-MW D段，純函式層，node-safe）
//
// 參考（出处記名）：
//   1. Merriam-Webster 官方 JSON 文件（dictionaryapi.com/products/json，
//      403KB 全文實錘）：hwi.hw（音節點 ·/*）／prs[].mw＋sound.audio／fl／
//      def.sseq（dt.text＋vis[].t）／et／date／dros（drp＋def）／syns／
//      shortdef；Thesaurus 側 meta.syns/ants＋syn_list/ant_list/
//      phrase_list/rel_list。
//   2. fluencer/dictionary-cli-app merriam.py：shortdef 取義、fl 取詞性、
//      def[].sseq 挖 vis[].t 例句、meta.id 對詞。
//   3. HannoZ/MerriamWebster.NET AudioLinkCreator.cs＋Configuration.cs：
//      音檔规则（本檔只存編號，不組 URL；播放后續直接套用）。
//
// 本檔只做「官方 JSON → Teno 欄位」純轉換；網路走 api.js lookupMerriam。
// ═══════════════════════════════════════════════════════════════

/**
 * 去 MW 內聯標記（官方文件 §2.29 token 表）。
 * 規則：{tag}自閉合→刪／{tag}X{/tag}→X／{tag|A|B}→最後一段顯示文本／殘留{}→全刪。
 */
export function stripMwTokens(s) {
  let t = String(s ?? '');
  // directional cross-ref 整段（內容為他詞參見，例句外此處丟棄）
  t = t.replace(/\{dx\}[\s\S]*?\{\/dx\}/g, '');
  t = t.replace(/\{dx_def\}[\s\S]*?\{\/dx_def\}/g, '');
  t = t.replace(/\{dx_ety\}[\s\S]*?\{\/dx_ety\}/g, '');
  t = t.replace(/\{ma\}([\s\S]*?)\{\/ma\}/g, '$1');
  // word-marking（parahw/phrase/qword/wi 在 gloss 前，只標不顯示）
  t = t.replace(/\{(parahw|phrase|qword|wi)\}/g, '');
  // 下標／上標／small caps／粗體→取內容
  t = t.replace(/\{inf\}([\s\S]*?)\{\/inf\}/g, '$1');
  t = t.replace(/\{sup\}/g, '');
  t = t.replace(/\{sc\}([\s\S]*?)\{\/sc\}/g, '$1');
  t = t.replace(/\{b\}([\s\S]*?)\{\/b\}/g, '$1');
  t = t.replace(/\{it\}([\s\S]*?)\{\/it\}/g, '$1');
  // 管道型 cross-ref→顯示文本（最後一段）
  t = t.replace(/\{(a_link|d_link|i_link|et_link|mat|dxt|sx|sxn|sxr)\|([^}]*)\}/g, (_, __, args) => {
    const parts = String(args).split('|').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  });
  // 標點／空白 token
  t = t.replace(/\{ldquo\}/g, '"').replace(/\{rdquo\}/g, '"');
  t = t.replace(/\{p_br\}/g, '\n').replace(/\{bc\}/g, '');
  t = t.replace(/\{gloss\}/g, '').replace(/\{(ds|slb|dro|pseq)\}/g, '');
  // 兜底：任何殘留 {…} 全刪
  t = t.replace(/\{[^}]*\}/g, '');
  return t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** hw 音節點（·/*）→ 顯示用 · 分格。例 agonise→ag*o*nise→ag·o·nise */
export function hwToSyllables(hw) {
  const t = String(hw ?? '').replace(/\*/g, '·').replace(/·+/g, '·').replace(/^·|·$/g, '');
  return t;
}

/** sseq 遞迴收集：所有 dt.text（定義段）＋vis[].t（例句）。 */
function collectDtVis(sseq, defs, examples) {
  if (!Array.isArray(sseq)) return;
  for (const group of sseq) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const [kind, body] = item;
      if (kind === 'sense' && body && typeof body === 'object') {
        if (Array.isArray(body.dt)) {
          for (const [dk, dv] of body.dt) {
            if (dk === 'text' && typeof dv === 'string') {
              const c = stripMwTokens(dv);
              if (c) defs.push(c);
            } else if (dk === 'vis' && Array.isArray(dv)) {
              for (const v of dv) {
                if (v && typeof v.t === 'string') {
                  const c = stripMwTokens(v.t);
                  if (c) examples.push(c);
                }
              }
            }
          }
        }
        // 子 sense（sen/bs/pseq 下可能嵌 sseq 或 dt）
        if (Array.isArray(body.sseq)) collectDtVis(body.sseq, defs, examples);
        if (body.sdsense && typeof body.sdsense === 'object') {
          const sd = body.sdsense;
          if (Array.isArray(sd.dt)) {
            // 與 sense 同形，借道遞迴：包成 sseq 形狀
            collectDtVis([[[ 'sense', sd ]]], defs, examples);
          }
        }
      } else if ((kind === 'sen' || kind === 'bs') && body && typeof body === 'object') {
        // sub-sense：內有 sn/sls/dt 或再嵌 sseq
        if (Array.isArray(body.sseq)) collectDtVis(body.sseq, defs, examples);
        if (Array.isArray(body.dt)) {
          collectDtVis([[[ 'sense', body ]]], defs, examples);
        }
      } else if (kind === 'pseq' && Array.isArray(body)) {
        collectDtVis(body, defs, examples);
      }
    }
  }
}

/**
 * Dictionary 側解析（collegiate entries 陣列；查無字時 API 回 suggest
 * 字串陣列——呼叫端以首元素有無 meta 判別，此處照實回 suggest）。
 * @returns {{entries, suggest}} entries: 解析後條目；suggest: 建議字陣列
 */
export function parseDictionaryEntries(arr) {
  if (!Array.isArray(arr) || !arr.length) return { entries: [], suggest: [] };
  if (typeof arr[0] === 'string') return { entries: [], suggest: arr };
  const entries = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object' || !e.meta) continue;
    const hw = e.hwi?.hw || '';
    const prs0 = Array.isArray(e.hwi?.prs) ? e.hwi.prs[0] : null;
    const defs = [], examples = [];
    if (Array.isArray(e.def)) {
      for (const d of e.def) {
        if (d && Array.isArray(d.sseq)) collectDtVis(d.sseq, defs, examples);
      }
    }
    const et = Array.isArray(e.et)
      ? e.et.map(x => (Array.isArray(x) && x[0] === 'text' ? stripMwTokens(x[1]) : '')).filter(Boolean).join('\n')
      : '';
    const phrases = [];
    if (Array.isArray(e.dros)) {
      for (const dro of e.dros) {
        if (!dro || typeof dro.drp !== 'string') continue;
        const pdefs = [], pex = [];
        if (dro.def && Array.isArray(dro.def)) {
          for (const d of dro.def) {
            if (d && Array.isArray(d.sseq)) collectDtVis(d.sseq, pdefs, pex);
          }
        }
        phrases.push({ phrase: stripMwTokens(dro.drp), def: pdefs[0] || '' });
      }
    }
    entries.push({
      id: e.meta?.id || '',
      hw,
      syllables: hwToSyllables(hw),
      fl: e.fl || '',
      pron: prs0?.mw ? stripMwTokens(prs0.mw) : '',
      pronAudio: prs0?.sound?.audio || '',
      shortdef: Array.isArray(e.shortdef) ? e.shortdef.map(s => stripMwTokens(s)) : [],
      defs: [...new Set(defs)],
      examples: [...new Set(examples)],
      et,
      date: typeof e.date === 'string' ? e.date.replace(/\{[^}]*\}/g, '') : '',
      phrases,
      // MWFORMS1: 韋氏 inflected forms（e.ins[].if = 詞形變化字串）——變化欄位唯一來源
      forms: Array.isArray(e.ins) ? [...new Set(e.ins.map(x => (x && typeof x.if === 'string') ? stripMwTokens(x.if) : '').filter(Boolean))] : [],
    });
  }
  return { entries, suggest: [] };
}

/**
 * Thesaurus 側解析。
 * @returns {{synonyms:string[], antonyms:string[], phrases:string[], related:string[]}}
 */
export function parseThesaurusEntries(arr) {
  const synonyms = new Set(), antonyms = new Set(), phrases = new Set(), related = new Set();
  if (!Array.isArray(arr)) return { synonyms: [], antonyms: [], phrases: [], related: [] };
  for (const e of arr) {
    if (!e || typeof e !== 'object' || !e.meta) continue;
    for (const g of e.meta?.syns || []) for (const w of g || []) synonyms.add(String(w));
    for (const g of e.meta?.ants || []) for (const w of g || []) antonyms.add(String(w));
    for (const sl of e.syn_list || []) {
      for (const w of sl.syn || []) synonyms.add(String(w));
      if (sl.wd) related.add(String(sl.wd));
    }
    for (const al of e.ant_list || []) {
      for (const w of al.ant || []) antonyms.add(String(w));
      if (al.wd) related.add(String(al.wd));
    }
    for (const pl of e.phrase_list || []) {
      if (pl.phrase) phrases.add(stripMwTokens(pl.phrase));
    }
    for (const rl of e.rel_list || []) {
      for (const w of rl.rel || []) related.add(String(w));
    }
    for (const sl of e.sim_list || []) {
      for (const w of sl.sim || []) synonyms.add(String(w));
    }
    for (const nl of e.near_list || []) {
      for (const w of nl.near || []) antonyms.add(String(w));
    }
  }
  const clean = (set) => [...set].map(s => stripMwTokens(s)).filter(Boolean);
  return { synonyms: clean(synonyms), antonyms: clean(antonyms), phrases: clean(phrases), related: clean(related) };
}

/**
 * 合併 lookup_merriam 回傳（{word, dictionary, thesaurus}）→ Teno 欄位。
 * 同反義寫單數 synonym/antonym（逗號分隔，沿用既有編輯器膠囊格式）；
 * 音節/字源/片語寫新三欄；audio 只存編號（播放后續）。
 */
export function merriamToFields(payload, word) {
  const out = {
    pos: '', definition: '', pron: '', pronAudio: '', example: '',
    etymology: '', syllables: '', phrases: '', synonym: '', antonym: '',
    forms: '',
    suggest: [],
  };
  const dict = payload?.dictionary;
  const thes = payload?.thesaurus;
  const { entries, suggest } = parseDictionaryEntries(dict);
  if (suggest.length) out.suggest = suggest;
  // 取與查詢詞最貼合的條目（meta.id 去冒號後相等者優先，否則首條）
  const norm = String(word || '').toLowerCase();
  const pick = entries.find(x => String(x.id).split(':')[0].toLowerCase() === norm) || entries[0];
  if (pick) {
    out.pos = pick.fl || '';
    out.definition = (pick.shortdef.length ? pick.shortdef : pick.defs.slice(0, 3)).join('\n');
    out.pron = pick.pron || '';
    out.pronAudio = pick.pronAudio || '';
    out.example = pick.examples.slice(0, 3).join('\n');
    out.etymology = [pick.et, pick.date ? `首次使用：${pick.date}` : ''].filter(Boolean).join('\n');
    out.syllables = pick.syllables || '';
    out.phrases = pick.phrases.map(p => (p.def ? `${p.phrase} — ${p.def}` : p.phrase)).join('\n');
    out.forms = (pick.forms || []).join(', ');
  }
  const t = parseThesaurusEntries(thes);
  out.synonym = t.synonyms.join(', ');
  out.antonym = t.antonyms.join(', ');
  // Thesaurus 片語併入（去重）
  if (t.phrases.length) {
    const cur = new Set(out.phrases.split('\n').filter(Boolean));
    for (const p of t.phrases) if (!cur.has(p)) cur.add(p);
    out.phrases = [...cur].join('\n');
  }
  // related 交給既有 related 欄（呼叫端決定；此處回傳供參考）
  out.related = t.related;
  return out;
}
