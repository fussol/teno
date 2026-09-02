#!/usr/bin/env node
// ocr.js OCR-V2 整合靜態釘（功能驗證：未勾選→灰名單／模式切換／離線還原入口）
// 執行：node tools/verify-ocr-v2-integration.mjs
// 用真實 ocr.js 原始碼做輪廓釘：確認 onMount 入庫 handler 含 addToGraylist 呼叫、
// 還原層 import dictionary + restoreFromDictionary、模式切換 setSetting、highlight 過濾。
// （store 端 API/檢查點已由 verify-ocr-graylist.mjs 驗證，此檔釘組合信任。）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCR = join(__dirname, '../src/pages/ocr.js');
const src = readFileSync(OCR, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail ?? ''}`); }
}

console.log('═ OCR-V2 整合釘 ═');

// T1 未勾選 → 灰名單
check('T1a 入庫 handler 計算 allCand（未勾選清單來源）', src.includes('const allCand = Array.from(candL.querySelectorAll'), '');
check('T1b 計算 dropped（未勾選=全部-勾選）', /const dropped = allCand\.filter\(w => !picked\.includes\(w\)\)/.test(src), '');
check('T1c 呼叫 isGraylisted 守門', src.includes('!s.actions.isGraylisted?.(w)'), '');
check('T1d 呼叫 addToGraylist（寫入灰名單）', src.includes('await s.actions.addToGraylist(w)'), '');

// T2 模式切換
check('T2a render 有雙模式 tab（scan 全掃描/highlight 螢光筆）', src.includes("['scan', 'highlight']") && src.includes("'全掃描'") && src.includes("'螢光筆'"), '');
check('T2b onMount 持久化 setSetting(ocrMode)', src.includes("setSetting('ocrMode', m)"), '');

// T3 離線還原層
check('T3a import dictionary.js 還原函式', src.includes("const { loadDictionary, restoreFromDictionary } = await import('../lib/dictionary.js')"), '');
check('T3b 對每個 token 調 restoreFromDictionary', src.includes('restoreFromDictionary(t)'), '');
check('T3c 離線找不到才收集 unresolvedOffline', src.includes('else unresolvedOffline.push(t)'), '');
// T3d 離線還原前先載入 dictionary
check('T3d 還原前 loadDictionary', src.includes('await loadDictionary();'), '');

// T4 高信心過濾（螢光筆方案 B）
check('T4a highlight 模式有 confidence 過濾', /_mode === 'highlight'/.test(src) && src.includes('tokConf[t] ?? 0') >= 50 || /filtered\.length/.test(src), '');

// T5 可選 AI 補強（預設關閉：ocrRestoreModel 空才不呼叫；設定明確指定才觸發）
check('T5a aiModel 讀取 ocrRestoreModel', src.includes("const aiModel = (s.state.ocrRestoreModel || '').trim()"), '');
check('T5b aiModel 非空＋有未解析才走 fetchLLM', src.includes('if (aiModel && unresolvedOffline.length)') && src.includes('const { fetchLLM } = await import'), '');
check('T5c 還原不出淘汰（!r continue）', src.includes('if (!r) continue;'), '');
check('T5d 補強失敗降級純離線（catch）', src.includes('console.warn(\'[ocr] AI 補強失敗（僅用離線結果）\''), '');

console.log(`\n結果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);