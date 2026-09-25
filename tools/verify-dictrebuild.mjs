// DICTREBUILD harness — Cambridge 死亡後的詞典來源重建
// 原則：能執行真實程式碼就執行（buildLlmEndpoint 直接從原始碼取出），
//       其餘做源碼結構斷言。Rust 側另有 5 條單元測試（cargo test --lib dictrebuild）。
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
};
const src = (p) => readFileSync(p, 'utf8');

console.log('== [A] buildLlmEndpoint（取出真實函式執行） ==');
const api = src('src/lib/api.js');
{
  const m = api.match(/export const buildLlmEndpoint = \(base, format\) => \{[\s\S]*?\n\};/);
  chk('函式存在於 api.js', !!m);
  const body = m[0]
    .replace(/^export const buildLlmEndpoint = \(base, format\) => \{/, '')
    .replace(/\n\};$/, '');
  const fn = new Function('base', 'format', body);
  chk('ollama：基底 → 補 /api/generate',
    fn('http://h:11434', 'ollama') === 'http://h:11434/api/generate');
  chk('openai：基底 → 補 /chat/completions',
    fn('https://api.openai.com/v1', 'openai') === 'https://api.openai.com/v1/chat/completions');
  chk('已是 ollama 端點 → 不重複補',
    fn('http://h:11434/api/generate', 'ollama') === 'http://h:11434/api/generate');
  chk('已是 openai 端點 → 不重複補',
    fn('https://x/v1/chat/completions', 'openai') === 'https://x/v1/chat/completions');
  chk('尾斜線 → 先吃掉再補',
    fn('http://h:11434/', 'ollama') === 'http://h:11434/api/generate');
  chk('空字串 → 回空（呼叫端走 fallback）', fn('', 'ollama') === '');
  // 反向：ollama 端點被當 openai 用時要轉換（使用者換格式不用重填）
  chk('ollama 端點 + openai 格式 → 轉成 chat/completions',
    fn('http://h:11434/api/generate', 'openai') === 'http://h:11434/chat/completions');
}

console.log('\n== [B] 唯一解析點：改設定即可切換本地／公開 ==');
chk('fetchLLM 在 api.js 解析設定', /getSetting\('llmApiUrl'\)/.test(api) && /getSetting\('llmApiFormat'\)/.test(api));
chk('傳遞 apiKey 給 Rust', /apiKey: cfg\.key/.test(api));
chk('設定留空 → 完全沿用呼叫端值（不改舊行為）',
  /if \(!override\) return invoke\('fetch_llm', \{ url, model, prompt, apiFormat \}\)/.test(api));

console.log('\n== [C] Rust：來源換掉、形狀不變 ==');
const rs = src('src-tauri/src/lib.rs');
chk('lookup_cambridge 不再爬 Cambridge',
  !/scrape_cambridge_html\(&html\)/.test(rs) && !/build_english_url/.test(rs));
chk('改用韋氏 collegiate', /mw_url\("collegiate"/.test(rs));
chk('回傳形狀維持舊 EnglishLookup（uk/us/senses）',
  /"uk_ipa": serde_json::Value::Null/.test(rs) && /"senses": senses/.test(rs));
chk('ZH 路徑：英英釋義 → llm_generate', /zh_translate_prompt\(&w, &defs\.join/.test(rs));
chk('llm_generate 支援 openai 格式', /is_openai/.test(rs) && /chat\/completions/.test(rs));
chk('llm_generate 帶 Bearer', /Authorization/.test(rs));
chk('fetch_llm 收 api_key', /async fn fetch_llm\([^)]*api_key: Option<String>/.test(rs));
chk('讀設定：新鍵優先、舊 ollama* fallback',
  /pick\("llmApiUrl", "ollamaUrl"\)/.test(rs) && /pick\("llmModel", "ollamaModel"\)/.test(rs));
chk('音檔 URL 慣例實作', /media\.merriam-webster\.com\/audio\/prons/.test(rs));
chk('例句走標記對陣列（["vis", [...]]）', /a\[0\]\.as_str\(\) == Some\("vis"\)/.test(rs));
chk('韋氏標記去除器存在', /fn strip_mw_markup/.test(rs));

console.log('\n== [D] prompt：涵蓋語意（保險）但禁同義詞堆疊 ==');
const promptMatch = rs.match(/fn zh_translate_prompt[\s\S]*?\n\}/);
chk('prompt 要求涵蓋所有語意', !!promptMatch && promptMatch[0].includes('涵蓋'));
chk('prompt 禁止同義詞堆疊', !!promptMatch && promptMatch[0].includes('同義詞堆疊'));
chk('prompt 要求短（每個詞 2~4 字）', !!promptMatch && promptMatch[0].includes('2~4'));
chk('prompt 示範 key 的多義（鑰匙/關鍵/按鍵）', !!promptMatch && promptMatch[0].includes('鑰匙'));
{
  const eng = src('src/lib/autofill-engine.js');
  chk('trans 分支餵入英英釋義', /const enData = await camEn\(\)/.test(eng) && /senses \|\| \[\]/.test(eng));
  chk('trans 有退化路徑（英英取不到仍可翻）', /走退化路徑/.test(eng));
  chk('trans 輸出後處理去掉頭尾分隔符', eng.includes('.replace(/^[；;，,、：:]+/'));
}

console.log('\n== [E] 設定持久化（原本從未持久化 → 手機無法指向 PC） ==');
const store = src('src/lib/store.js');
for (const k of ['llmApiUrl', 'llmModel', 'llmApiFormat', 'llmApiKey']) {
  const reads = (store.match(new RegExp(`getSetting\\('${k}'\\)`, 'g')) || []).length;
  const hydrates = (store.match(new RegExp(`state\\.${k} =`, 'g')) || []).length;
  chk(`${k} 有讀取與 hydrate`, reads >= 1 && hydrates >= 1, `read=${reads} hydrate=${hydrates}`);
}
const settings = src('src/pages/settings.js');
chk('設定頁有 API 欄位（標籤就叫 API）', /id="llmApiUrlInput"/.test(settings));
chk('設定頁有格式選擇（ollama/openai）', /id="llmApiFormatInput"/.test(settings) && settings.includes("value=\"openai\""));
chk('設定頁有金鑰欄位', /id="llmApiKeyInput"/.test(settings));
chk('儲存時寫入四個鍵',
  ['llmApiUrl', 'llmModel', 'llmApiFormat', 'llmApiKey'].every(k => settings.includes(`setSetting('${k}'`)));

console.log('\n== [F] 舊 UI 已移除（不再有第二個真相來源） ==');
const tools = src('src/pages/tools.js');
chk('tools 頁無 llmUrlRow', !tools.includes('llmUrlRow'));
chk('tools 頁無 hideLlmRow', !tools.includes('hideLlmRow'));
chk('detectModel 改讀 state', /s\.state\.llmApiUrl/.test(tools) && /s\.state\.llmModel/.test(tools));
chk('英中模式不留空白資訊列', /if \(s\.definition\) html \+=/.test(tools));

console.log(`\nDICTREBUILD: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
