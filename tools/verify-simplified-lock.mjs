// SIMPLIFIED-LOCK harness — 翻譯強制繁體（兩把鎖）
//  鎖① prompt 明令（Rust zh_translate_prompt + JS autofill-engine）
//  鎖② 輸出後程式轉換（Rust to_traditional / zh_clean / zh_traditional 命令）
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const chk = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${d ? '  → ' + d : ''}`); }
};

const RUST = readFileSync('/home/jupiter/teno 修檢版/src-tauri/src/lib.rs', 'utf8');
const JS   = readFileSync('/home/jupiter/teno 修檢版/src/lib/autofill-engine.js', 'utf8');
const TSV  = '/home/jupiter/teno 修檢版/src-tauri/src/zh_s2t.tsv';

console.log('\n== [A] 字表本體 ==');
chk('zh_s2t.tsv 存在', existsSync(TSV));
const rows = readFileSync(TSV, 'utf8').trim().split('\n').map(l => l.split('\t'));
chk(`字表條數合理（${rows.length}）`, rows.length > 3000);
chk('每行都是「一字→一字」', rows.every(r => r.length === 2 && [...r[0]].length === 1 && [...r[1]].length === 1));
chk('無「自己→自己」的空轉條目', rows.every(r => r[0] !== r[1]));

console.log('\n== [B] 安全性質：共享字絕不進表（純字表轉換能用的唯一理由）==');
{
  const map = new Map(rows);
  const shared = '台后里系只志万丑丰了于云仆仇价仿伙余佛俊修借僵';
  const leaked = [...shared].filter(c => map.has(c));
  chk('167 個共享字（取樣）都不在表內', leaked.length === 0, leaked.join(''));
  // 關鍵：正確繁體片語不可被改
  const conv = s => [...s].map(c => map.get(c) ?? c).join('');
  for (const s of ['皇后', '台灣', '系統', '只是', '裡面', '後面', '頭髮', '鑰匙,關鍵,鎖定', '經濟'])
    chk(`「${s}」零改動`, conv(s) === s, conv(s));
}

console.log('\n== [C] 鎖② Rust：轉換函式與套用點 ==');
chk('ZH_S2T 由 include_str! 內嵌', /include_str!\("zh_s2t\.tsv"\)/.test(RUST));
chk('to_traditional 存在且 pub', /pub fn to_traditional\(/.test(RUST));
chk('zh_clean 有套用鎖②', /while out\.ends_with\(','\) \{ out\.pop\(\); \}\n    to_traditional\(&out\)/.test(RUST));
chk('zh_traditional 命令存在', /#\[tauri::command\]\s*\nfn zh_traditional\(/.test(RUST));
chk('命令已註冊進 invoke_handler', /sql_tx, zh_traditional\]\)/.test(RUST));

console.log('\n== [D] 鎖① prompt：Rust 與 JS 都有明令 ==');
chk('Rust prompt 有「絕對不可出現任何簡體字」', RUST.includes('絕對不可出現任何簡體字'));
chk('Rust prompt 標明「台灣正體」', RUST.includes('台灣正體'));
chk('Rust prompt 有易錯字示範', RUST.includes('发→發'));
chk('JS prompt 有「絕對不可出現任何簡體字」', JS.includes('絕對不可出現任何簡體字'));
chk('JS prompt 標明「台灣正體」', JS.includes('台灣正體'));
chk('JS prompt 有易錯字示範', JS.includes('发→發'));
chk('兩邊 prompt 規則一致（都有「只取最常用」）',
  RUST.includes('只取最常用、最核心的 1~3 個語意') && JS.includes('只取最常用、最核心的 1~3 個語意'));

console.log('\n== [E] 鎖② JS：node-safe 陷阱（這條會擋住未來的退化）==');
// 本檔標頭聲明 node-safe（CLI/harness 要在 Node 跑）→ 靜態 import 會炸
chk('未靜態 import @tauri-apps/api/core',
  !/^\s*import\s*\{[^}]*invoke[^}]*\}\s*from\s*['"]@tauri-apps\/api\/core['"]/m.test(JS));
chk('改用動態 import（在 try 內）', /await import\('@tauri-apps\/api\/core'\)/.test(JS));
chk('動態 import 在 try/catch 內（無後端時不影響結果）',
  /try \{\s*\n\s*const \{ invoke \} = await import\('@tauri-apps\/api\/core'\);/.test(JS));
chk('呼叫的是 zh_traditional 命令', JS.includes("invoke('zh_traditional'"));
chk('轉換結果有寫回（let t 而非 const t）', /\n\s*let t = String\(text/.test(JS));

console.log('\n== [F] 對外契約不變（不能弄壞既有讀取端）==');
chk('分隔符仍是半角逗號', JS.includes("replace(/[；;、，｜|／/。]+/g, ',')"));
chk('回傳形狀仍是 patch.definition', JS.includes('patch.definition = t'));

console.log(`\nSIMPLIFIED-LOCK: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail)`);
process.exit(fail ? 1 : 0);
